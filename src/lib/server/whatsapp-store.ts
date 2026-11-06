import 'server-only';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Database as Firestore } from '@/lib/storage/types';
import { getAdminDb } from '@/lib/firebase/admin';
import type { ChatResponse } from '@/types/chat';
import type { WhatsAppUsage, WhatsAppUsageCounters } from '@/types/whatsapp';
import type { ResponseQuotaReservation } from './response-quota';
import { bindingReady, metaIdSchema, parseWhatsAppBinding, readWhatsAppConfig } from './whatsapp-config';
import { decryptWhatsApp, encryptWhatsApp, type WhatsAppCiphertext } from './whatsapp-security';
import { HttpError } from './http';
import { prepareQuotaResult, applyResponseQuotaStage, readQuotaPublication, type QuotaIdentity, type QuotaStage } from './response-quota-store';
import { appendConversationControl, cancelSupersededWhatsAppOperations, conversationContactSchema, conversationPermitsReply, parseConversationMetadata } from './whatsapp-conversations';
import { assertBookingAdmission } from './booking-admission';
import { finishBookingDispatch, prepareBookingDispatchRegistration } from './booking-policy-transition';
export { getWhatsAppConversations, setWhatsAppConversationMode, whatsAppConversationControlSchema } from './whatsapp-conversations';

export const WHATSAPP_DAY = 86_400_000;
export const WHATSAPP_TERMINAL = Number.MAX_SAFE_INTEGER;
export const whatsappHash = (...parts: string[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
const timestamp = z.string().regex(/^\d{1,13}$/).transform(value => Number(value) * 1000).refine(Number.isSafeInteger);
const wamid = z.string().min(1).max(512);
const echoPhone = z.string().regex(/^\+?[1-9]\d{7,14}$/).transform(value => value.replace(/^\+/, ''));
const echoValueSchema = z.object({ messaging_product: z.literal('whatsapp'), metadata: z.object({ phone_number_id: metaIdSchema }),
  message_echoes: z.array(z.object({ id: wamid, from: echoPhone, to: echoPhone, timestamp, type: z.string().min(1).max(64), text: z.object({ body: z.string().max(4096) }).optional() })).max(100),
});
const pricingSchema = z.object({ type: z.enum(['regular', 'free_customer_service', 'free_entry_point']), category: z.string().max(64) });
const valueSchema = z.object({ messaging_product: z.literal('whatsapp'), metadata: z.object({ phone_number_id: metaIdSchema }),
  contacts: z.array(z.object({ wa_id: z.string(), profile: z.object({ name: z.string().max(256) }).optional() })).max(100).optional(),
  messages: z.array(z.object({ id: wamid, from: z.string().regex(/^[1-9]\d{7,14}$/), timestamp, type: z.string().max(64), text: z.object({ body: z.string().min(1).max(4096) }).optional() })).max(100).optional(),
  statuses: z.array(z.object({ id: wamid, status: z.enum(['sent', 'delivered', 'read', 'failed', 'played']), timestamp, biz_opaque_callback_data: z.string().max(512).optional(), pricing: z.unknown().optional(), errors: z.array(z.object({ code: z.number().int() })).max(10).optional() })).max(100).optional(),
});
const payloadSchema = z.object({ object: z.literal('whatsapp_business_account'), entry: z.array(z.object({ id: metaIdSchema, changes: z.array(z.object({ field: z.string(), value: z.unknown() })).max(100) })).max(100) });

export interface WhatsAppInbox {
  businessId: string; phoneNumberId: string; wabaId: string; conversationId: string;
  conversationRevision?: number;
  state: 'pending' | 'processing' | 'completed' | 'review' | 'expired';
  receivedAt: number; windowEndsAt: number; bodyExpiresAt: number; expiresAt: number; nextAttemptAt: number;
  content: WhatsAppCiphertext | null; leaseId?: string;
}
export interface WhatsAppOutbox {
  businessId: string; phoneNumberId: string; wabaId: string; conversationId: string;
  conversationRevision?: number;
  state: 'ready' | 'sending' | 'accepted' | 'delivered' | 'unknown' | 'failed' | 'expired' | 'cancelled';
  createdAt: number; windowEndsAt: number; bodyExpiresAt: number; expiresAt: number; nextAttemptAt: number;
  content: WhatsAppCiphertext | null; reservation: ResponseQuotaReservation;
  sent: boolean; delivered: boolean; read: boolean; failed: boolean; attempts: number;
  pricing?: z.infer<typeof pricingSchema>; metaMessageId?: string; errorCode?: number;
}
export const inboundContentSchema = z.object({ from: z.string().regex(/^[1-9]\d{7,14}$/), text: z.string().min(1).max(4096), messageId: wamid, name: z.string().max(256).optional() }).strict();
export const outboundContentSchema = z.object({ to: z.string().regex(/^[1-9]\d{7,14}$/), reply: z.string().min(1).max(4096), messageId: wamid }).strict();
const historySchema = z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().min(1).max(4096) }).strict()).max(20);
export function usageMonth(now = Date.now()): string { return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota', year: 'numeric', month: '2-digit' }).format(now); }
const counters = (): WhatsAppUsageCounters => ({ sent: 0, delivered: 0, read: 0, failed: 0, unknown: 0, serviceDelivered: 0, utilityDelivered: 0, marketingDelivered: 0, otherDelivered: 0, freeDelivered: 0, regularDelivered: 0, unknownPricingDelivered: 0 });
function contribution(row: WhatsAppOutbox): WhatsAppUsageCounters {
  const result = counters();
  result.sent = Number(row.sent); result.delivered = Number(row.delivered); result.read = Number(row.read); result.failed = Number(row.failed); result.unknown = Number(row.state === 'unknown');
  if (row.delivered) {
    const category = row.pricing?.category;
    result[category === 'service' ? 'serviceDelivered' : category === 'utility' ? 'utilityDelivered' : category === 'marketing' || category === 'marketing_lite' ? 'marketingDelivered' : 'otherDelivered'] = 1;
    result[row.pricing?.type === 'regular' ? 'regularDelivered' : row.pricing?.type.startsWith('free_') ? 'freeDelivered' : 'unknownPricingDelivered'] = 1;
  }
  return result;
}
export async function updateWhatsAppOutbox(id: string, update: (previous: WhatsAppOutbox) => Partial<WhatsAppOutbox> | null, db: Firestore, transportResolved = false): Promise<void> {
  const reference = db.collection('whatsappOutbox').doc(id);
  await db.runTransaction(async transaction => {
    const snapshot = await transaction.get(reference);
    if (!snapshot.exists) return;
    const previous = snapshot.data() as WhatsAppOutbox;
    const patch = update(previous);
    if (!patch) return;
    const next = { ...previous, ...patch };
    const month = usageMonth(previous.createdAt);
    const aggregate = db.collection('whatsappUsage').doc(month);
    const business = aggregate.collection('businesses').doc(previous.businessId);
    const [total, byBusiness] = await Promise.all([transaction.get(aggregate), transaction.get(business)]);
    const before = contribution(previous), after = contribution(next);
    const add = (saved: Record<string, unknown> | undefined) => Object.fromEntries(Object.keys(before).map(key => {
      const name = key as keyof WhatsAppUsageCounters;
      const value = saved?.[name] ?? 0;
      if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error('Invalid WhatsApp aggregate');
      return [name, (value as number) + after[name] - before[name]];
    }));
    if (transportResolved) await finishBookingDispatch(transaction, db, previous.businessId, { kind: 'whatsapp', id }, 'transport_resolved');
    transaction.set(reference, next);
    transaction.set(aggregate, add(total.data()));
    transaction.set(business, add(byBusiness.data()));
  });
}

export async function ingestWhatsAppWebhook(payload: unknown, db: Firestore = getAdminDb(), now = Date.now()): Promise<void> {
  const config = readWhatsAppConfig();
  if (!config.enabled || !config.configured) throw new HttpError(503, 'WhatsApp no está configurado.');
  const parsed = payloadSchema.safeParse(payload);
  if (!parsed.success) throw new HttpError(400, 'Webhook no válido.');
  let eventCount = 0;
  // Parse and bound the whole batch before writing any part of it.
  const events: { wabaId: string; value: z.infer<typeof valueSchema> }[] = [];
  const echoes: { wabaId: string; value: z.infer<typeof echoValueSchema> }[] = [];
  for (const entry of parsed.data.entry) for (const change of entry.changes) {
    if (change.field === 'smb_message_echoes') {
      const value = echoValueSchema.safeParse(change.value);
      if (!value.success) throw new HttpError(400, 'Webhook no válido.');
      eventCount += value.data.message_echoes.length;
      if (eventCount > 100) throw new HttpError(413, 'Demasiados eventos.');
      echoes.push({ wabaId: entry.id, value: value.data });
      continue;
    }
    if (change.field !== 'messages') continue;
    const value = valueSchema.safeParse(change.value);
    if (!value.success) throw new HttpError(400, 'Webhook no válido.');
    eventCount += (value.data.messages?.length ?? 0) + (value.data.statuses?.length ?? 0);
    if (eventCount > 100) throw new HttpError(413, 'Demasiados eventos.');
    events.push({ wabaId: entry.id, value: value.data });
  }
  // Apply app-originated interventions before any inbound turn in the same batch.
  for (const { wabaId, value } of echoes) {
    const phoneNumberId = value.metadata.phone_number_id;
    const numberRef = db.collection('whatsappNumbers').doc(phoneNumberId);
    for (const message of value.message_echoes) {
      if (message.timestamp > now + 300_000 || message.timestamp <= now - WHATSAPP_DAY) continue;
      const echoRef = db.collection('whatsappMessageIds').doc(whatsappHash('echo', phoneNumberId, message.id));
      const intervention = await db.runTransaction(async transaction => {
        const [number, existing] = await Promise.all([transaction.get(numberRef), transaction.get(echoRef)]);
        if (existing.exists || !number.exists) return;
        const binding = parseWhatsAppBinding(number.data());
        if (binding.wabaId !== wabaId) return;
        const conversationId = whatsappHash(binding.businessId, phoneNumberId, message.to);
        const reference = db.collection('whatsappConversations').doc(conversationId);
        const snapshot = await transaction.get(reference);
        const previous = snapshot.data();
        const metadata = parseConversationMetadata(previous);
        if (metadata && (metadata.businessId !== binding.businessId || metadata.phoneNumberId !== phoneNumberId || metadata.wabaId !== wabaId)) throw new HttpError(503, 'Conversación no válida.');
        transaction.create(echoRef, { expiresAt: now + 30 * WHATSAPP_DAY });
        const occurredAt = Math.min(now, message.timestamp);
        // A delayed echo cannot undo an explicit, newer administrative resumption.
        if (metadata && metadata.mode === 'bot' && occurredAt < Math.floor(metadata.controlChangedAt / 1000) * 1000) return;
        if (metadata?.lastHumanAt && occurredAt < metadata.lastHumanAt) return;
        const priorContact = previous?.contactContent && Number(previous.bodyExpiresAt) > now
          ? conversationContactSchema.parse(decryptWhatsApp(previous.contactContent, `${reference.path}/contact`)) : null;
        const bodyExpiresAt = priorContact ? Math.min(Number(previous!.bodyExpiresAt), occurredAt + WHATSAPP_DAY) : occurredAt + WHATSAPP_DAY;
        const base = { ...previous, businessId: binding.businessId, phoneNumberId, wabaId,
          mode: metadata?.mode ?? 'bot', revision: metadata?.revision ?? 0, updatedAt: occurredAt,
          controlChangedAt: metadata?.controlChangedAt ?? 0, lastInboundAt: metadata?.lastInboundAt ?? null,
          lastHumanAt: occurredAt, bodyExpiresAt, expiresAt: now + 30 * WHATSAPP_DAY,
          content: null,
          contactContent: bodyExpiresAt > now ? encryptWhatsApp({ phone: message.to, name: priorContact?.name ?? null,
            lastMessage: message.type === 'text' ? message.text?.body ?? null : null }, `${reference.path}/contact`) : null };
        transaction.set(reference, { ...base, ...appendConversationControl(base, 'human', null, 'business_app', now) });
        return { conversationId, revision: base.revision + 1 };
      });
      if (intervention) cancelSupersededWhatsAppOperations(intervention.conversationId, intervention.revision, db);
    }
  }
  for (const { wabaId, value } of events) {
    const phoneNumberId = value.metadata.phone_number_id;
    const numberRef = db.collection('whatsappNumbers').doc(phoneNumberId);
    const snapshot = await numberRef.get();
    if (!snapshot.exists) continue;
    const binding = parseWhatsAppBinding(snapshot.data());
    if (binding.wabaId !== wabaId) continue;
    for (const message of value.messages ?? []) {
      if (!bindingReady(binding, config) || message.type !== 'text' || !message.text || message.timestamp > now + 300_000) continue;
      const id = whatsappHash(phoneNumberId, message.id);
      const reference = db.collection('whatsappInbox').doc(id);
      const receivedAt = Math.min(now, message.timestamp);
      const windowEndsAt = receivedAt + WHATSAPP_DAY;
      const conversationId = whatsappHash(binding.businessId, phoneNumberId, message.from);
      const conversationRef = db.collection('whatsappConversations').doc(conversationId);
      const name = value.contacts?.find(contact => contact.wa_id === message.from)?.profile?.name;
      const content = windowEndsAt <= now ? null : encryptWhatsApp({ from: message.from, text: message.text.body, messageId: message.id,
        ...(value.contacts?.find(contact => contact.wa_id === message.from)?.profile?.name ? { name: value.contacts.find(contact => contact.wa_id === message.from)!.profile!.name } : {}),
      }, reference.path);
      await db.runTransaction(async transaction => {
        const [existing, latestNumber, conversation] = await Promise.all([transaction.get(reference), transaction.get(numberRef), transaction.get(conversationRef)]);
        if (existing.exists || !latestNumber.exists) return;
        const latest = parseWhatsAppBinding(latestNumber.data());
        if (!bindingReady(latest, config) || latest.businessId !== binding.businessId || latest.wabaId !== wabaId) return;
        const previous = conversation.data();
        const metadata = parseConversationMetadata(previous);
        if (metadata && (metadata.businessId !== binding.businessId || metadata.phoneNumberId !== phoneNumberId || metadata.wabaId !== wabaId)) throw new HttpError(503, 'Conversación no válida.');
        const revision = metadata?.revision ?? 0;
        const canReply = (metadata?.mode ?? 'bot') === 'bot' && Math.floor((metadata?.controlChangedAt ?? 0) / 1000) * 1000 <= receivedAt;
        const record: WhatsAppInbox = { businessId: binding.businessId, phoneNumberId, wabaId, conversationId, conversationRevision: revision,
          state: !content ? 'expired' : canReply ? 'pending' : 'review', receivedAt, windowEndsAt, bodyExpiresAt: windowEndsAt, expiresAt: now + 30 * WHATSAPP_DAY, nextAttemptAt: content && canReply ? now : WHATSAPP_TERMINAL, content };
        const contactActive = previous?.contactContent && Number(previous.bodyExpiresAt) > now;
        const contact = contactActive ? conversationContactSchema.parse(decryptWhatsApp(previous!.contactContent, `${conversationRef.path}/contact`)) : null;
        const bodyExpiresAt = (previous?.content || contactActive) && Number(previous!.bodyExpiresAt) > now ? Math.min(Number(previous!.bodyExpiresAt), windowEndsAt) : windowEndsAt;
        const newest = receivedAt >= Math.max(metadata?.lastInboundAt ?? 0, metadata?.lastHumanAt ?? 0);
        transaction.set(conversationRef, { ...previous, businessId: binding.businessId, phoneNumberId, wabaId,
          mode: metadata?.mode ?? 'bot', revision, controlChangedAt: metadata?.controlChangedAt ?? 0,
          updatedAt: Math.max(metadata?.updatedAt ?? 0, receivedAt), lastInboundAt: Math.max(metadata?.lastInboundAt ?? 0, receivedAt), lastHumanAt: metadata?.lastHumanAt ?? null,
          bodyExpiresAt, expiresAt: now + 30 * WHATSAPP_DAY,
          content: previous?.content && Number(previous.bodyExpiresAt) > now ? previous.content : null,
          contactContent: newest ? content ? encryptWhatsApp({ phone: message.from, name: name ?? contact?.name ?? null, lastMessage: message.text!.body }, `${conversationRef.path}/contact`) : null : previous?.contactContent ?? null });
        transaction.create(reference, record);
        transaction.set(numberRef, { ...latest, lastInboundAt: Math.max(latest.lastInboundAt ?? 0, receivedAt) });
      });
    }
    for (const status of value.statuses ?? []) {
      let id = /^[a-f0-9]{64}$/.test(status.biz_opaque_callback_data ?? '') ? status.biz_opaque_callback_data! : null;
      if (!id) {
        const index = await db.collection('whatsappMessageIds').doc(whatsappHash(phoneNumberId, status.id)).get();
        if (typeof index.data()?.outboxId === 'string') id = index.data()!.outboxId;
      }
      if (!id || !/^[a-f0-9]{64}$/.test(id)) continue;
      const price = pricingSchema.safeParse(status.pricing);
      await updateWhatsAppOutbox(id, previous => {
        if (previous.phoneNumberId !== phoneNumberId || previous.wabaId !== wabaId || (previous.metaMessageId && previous.metaMessageId !== status.id)) return null;
        const delivered = previous.delivered || status.status === 'delivered' || status.status === 'read';
        return { metaMessageId: status.id, sent: previous.sent || ['sent', 'delivered', 'read'].includes(status.status), delivered,
          read: previous.read || status.status === 'read', failed: !delivered && (previous.failed || status.status === 'failed'),
          state: delivered ? 'delivered' : status.status === 'failed' ? 'failed' : status.status === 'sent' ? 'accepted' : previous.state,
          nextAttemptAt: WHATSAPP_TERMINAL, ...(price.success ? { pricing: price.data } : {}),
          ...(status.errors?.[0] ? { errorCode: status.errors[0].code } : {}) };
      }, db, ['sent', 'delivered', 'read', 'failed'].includes(status.status));
      if (status.status === 'delivered' || status.status === 'read') {
        await db.runTransaction(async transaction => {
          const latest = await transaction.get(numberRef);
          if (latest.exists) transaction.set(numberRef, { ...latest.data(), lastDeliveredAt: Math.max(Number(latest.data()?.lastDeliveredAt ?? 0), Math.min(now, status.timestamp)) });
        });
      }
    }
  }
}

export async function readWhatsAppHistory(conversationId: string, db: Firestore, now = Date.now()): Promise<{ role: 'user' | 'assistant'; content: string }[]> {
  const reference = db.collection('whatsappConversations').doc(conversationId);
  const snapshot = await reference.get();
  if (!snapshot.exists || Number(snapshot.data()?.bodyExpiresAt) <= now || !snapshot.data()?.content) return [];
  return historySchema.parse(decryptWhatsApp(snapshot.data()!.content, reference.path));
}
export async function claimWhatsAppOutbox(id: string, db: Firestore): Promise<boolean> {
  const reference = db.collection('whatsappOutbox').doc(id);
  return db.runTransaction(async transaction => {
    const snapshot = await transaction.get(reference);
    if (!snapshot.exists) return false;
    const row = snapshot.data() as WhatsAppOutbox;
    if (row.state !== 'ready' || row.nextAttemptAt > Date.now() || row.windowEndsAt <= Date.now() || row.attempts >= 3) return false;
    const conversation = await transaction.get(db.collection('whatsappConversations').doc(row.conversationId));
    if (!conversationPermitsReply(conversation.data(), row)) {
      transaction.set(reference, { ...row, state: 'cancelled', nextAttemptAt: WHATSAPP_TERMINAL });
      return false;
    }
    const register = await prepareBookingDispatchRegistration(transaction, db, row.businessId, { kind: 'whatsapp', id });
    transaction.set(reference, { ...row, state: 'sending', attempts: row.attempts + 1, nextAttemptAt: Date.now() + 60_000 });
    register();
    return true;
  });
}

export async function persistWhatsAppReply(id: string, leaseId: string, response: ChatResponse, reservation: ResponseQuotaReservation, db: Firestore, identity?: QuotaIdentity): Promise<void> {
  const reference = db.collection('whatsappInbox').doc(id), outbox = db.collection('whatsappOutbox').doc(id);
  if (!response.reply.trim() || response.reply.length > 4096) throw new HttpError(503, 'La respuesta supera el límite de WhatsApp.');
  await db.runTransaction(async transaction => {
    const [inboxSnapshot, existing] = await Promise.all([transaction.get(reference), transaction.get(outbox)]);
    if (existing.exists) return;
    if (!inboxSnapshot.exists) throw new Error('Missing inbox');
    const inbox = inboxSnapshot.data() as WhatsAppInbox;
    if (inbox.state !== 'processing' || inbox.leaseId !== leaseId || !inbox.content || inbox.bodyExpiresAt <= Date.now()) throw new Error('Lost inbox lease');
    const source = inboundContentSchema.parse(decryptWhatsApp(inbox.content, reference.path));
    const historyRef = db.collection('whatsappConversations').doc(inbox.conversationId);
    const historyDoc = await transaction.get(historyRef);
    if (!conversationPermitsReply(historyDoc.data(), inbox)) throw new HttpError(409, 'La atención de la conversación cambió.', 'WHATSAPP_CONTROL_CHANGED');
    await assertBookingAdmission(transaction, { id: inbox.businessId }, 'channel_reply', db);
    const activeHistory = historyDoc.exists && Number(historyDoc.data()?.bodyExpiresAt) > Date.now() && historyDoc.data()?.content;
    const history = activeHistory ? historySchema.parse(decryptWhatsApp(historyDoc.data()!.content, historyRef.path)) : [];
    let quotaStage: QuotaStage | undefined;
    if (identity) {
      if (identity.expectedScopeId !== `business_${inbox.businessId}`) throw new HttpError(403, 'El intento pertenece a otro negocio.');
      const savedTurn = await transaction.get(db.collection('responseQuotaTurns').doc(reservation.reservationId));
      if (savedTurn.data()?.status === 'completed') await readQuotaPublication(transaction, db, identity, 'replay');
      else quotaStage = await prepareQuotaResult(transaction, db, identity, { kind: 'whatsapp_outbox', id }, Date.now());
    } else {
      const protocol = await transaction.get(db.collection('serverSettings').doc('responseQuotaProtocol'));
      if (protocol.exists) throw new HttpError(409, 'Falta comprobar el intento de IA.', 'AI_RESPONSE_INTERRUPTED');
    }
    history.push({ role: 'user', content: source.text }, { role: 'assistant', content: response.reply });
    while (history.length > 20 || history.reduce((total, message) => total + message.content.length, 0) > 55_000) history.shift();
    // Contact identity survives a handoff even though the old bot history is
    // discarded. Do not extend that identity's TTL (or resurrect expired data)
    // when a later reply creates fresh history in the same document.
    const retainedContent = historyDoc.exists && (historyDoc.data()?.content || historyDoc.data()?.contactContent);
    const bodyExpiresAt = retainedContent ? Math.min(Number(historyDoc.data()!.bodyExpiresAt), inbox.bodyExpiresAt) : inbox.bodyExpiresAt;
    const record: WhatsAppOutbox = { businessId: inbox.businessId, phoneNumberId: inbox.phoneNumberId, wabaId: inbox.wabaId, conversationId: inbox.conversationId,
      ...(inbox.conversationRevision !== undefined ? { conversationRevision: inbox.conversationRevision } : {}),
      state: 'ready', createdAt: Date.now(), windowEndsAt: inbox.windowEndsAt, bodyExpiresAt: inbox.bodyExpiresAt, expiresAt: inbox.expiresAt, nextAttemptAt: Date.now(),
      content: encryptWhatsApp({ to: source.from, reply: response.reply, messageId: source.messageId }, outbox.path), reservation,
      sent: false, delivered: false, read: false, failed: false, attempts: 0 };
    transaction.create(outbox, record);
    transaction.set(reference, { ...inbox, state: 'completed', nextAttemptAt: WHATSAPP_TERMINAL });
    transaction.set(historyRef, { ...historyDoc.data(), content: encryptWhatsApp(history, historyRef.path), bodyExpiresAt, expiresAt: inbox.expiresAt });
    if (quotaStage) applyResponseQuotaStage(transaction, db, quotaStage);
  });
}

export async function cleanupWhatsAppRetention(db: Firestore = getAdminDb(), now = Date.now()): Promise<{ morePending: boolean }> {
  let morePending = false;
  for (const collection of ['whatsappInbox', 'whatsappOutbox', 'whatsappConversations']) {
    const expiredBodies = await db.collection(collection).where('bodyExpiresAt', '<=', now).limit(100).get();
    morePending ||= expiredBodies.size === 100;
    for (const document of expiredBodies.docs) await db.runTransaction(async transaction => {
      const reference = db.collection(collection).doc(document.id), fresh = await transaction.get(reference);
      if (fresh.exists && Number(fresh.data()?.bodyExpiresAt) <= now) transaction.set(reference, { ...fresh.data(), content: null, ...(collection === 'whatsappConversations' ? { contactContent: null } : {}), bodyExpiresAt: WHATSAPP_TERMINAL });
    });
  }
  for (const collection of ['whatsappInbox', 'whatsappOutbox', 'whatsappConversations', 'whatsappMessageIds']) {
    const expired = await db.collection(collection).where('expiresAt', '<=', now).limit(100).get();
    morePending ||= expired.size === 100;
    for (const document of expired.docs) await db.runTransaction(async transaction => {
      const reference = db.collection(collection).doc(document.id), fresh = await transaction.get(reference);
      if (fresh.exists && Number(fresh.data()?.expiresAt) <= now) transaction.delete(reference);
    });
  }
  return { morePending };
}
export async function getWhatsAppUsage(db: Firestore = getAdminDb(), now = Date.now()): Promise<WhatsAppUsage> {
  const month = usageMonth(now), reference = db.collection('whatsappUsage').doc(month);
  const [total, businesses] = await Promise.all([reference.get(), reference.collection('businesses').limit(101).get()]);
  const safeCounters = (data: Record<string, unknown> | undefined) => Object.fromEntries(Object.keys(counters()).map(key => {
    const value = data?.[key] ?? 0;
    if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error('Invalid WhatsApp aggregate');
    return [key, value];
  })) as unknown as WhatsAppUsageCounters;
  return { month, timeZone: 'America/Bogota', source: 'meta_webhooks', cohort: 'generated_month', invoice: false, estimatedCostCOP: null, totals: safeCounters(total.data()), businesses: businesses.docs.slice(0, 100).map(document => ({ businessId: document.id, ...safeCounters(document.data()) })), truncated: businesses.size > 100 };
}
