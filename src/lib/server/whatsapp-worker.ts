import 'server-only';
import { randomUUID } from 'node:crypto';
import type { Database as Firestore } from '@/lib/storage/types';
import { getAdminDb } from '@/lib/firebase/admin';
import { runSarinChat } from './chat';
import { commitResponseQuota } from './response-quota';
import { bindingReady, parseWhatsAppBinding, readWhatsAppConfig } from './whatsapp-config';
import { decryptWhatsApp, readBoundedBytes } from './whatsapp-security';
import { claimWhatsAppOutbox, cleanupWhatsAppRetention, inboundContentSchema, outboundContentSchema, persistWhatsAppReply, readWhatsAppHistory, updateWhatsAppOutbox, whatsappHash, WHATSAPP_TERMINAL, type WhatsAppInbox, type WhatsAppOutbox } from './whatsapp-store';
import { conversationAllowsReply, conversationPermitsReply, markConversationForReview, registerWhatsAppOperation } from './whatsapp-conversations';

const processing = new WeakSet<Firestore>();
const LEASE_MS = 5 * 60_000;
async function activeNumber(row: { phoneNumberId: string; businessId: string; wabaId: string }, db: Firestore) {
  const document = await db.collection('whatsappNumbers').doc(row.phoneNumberId).get();
  if (!document.exists) return false;
  const binding = parseWhatsAppBinding(document.data());
  return binding.businessId === row.businessId && binding.wabaId === row.wabaId && bindingReady(binding);
}
async function generateOne(db: Firestore) {
  const candidates = await db.collection('whatsappInbox').where('nextAttemptAt', '<=', Date.now()).orderBy('nextAttemptAt').limit(10).get();
  for (const candidate of candidates.docs) {
    const reference = db.collection('whatsappInbox').doc(candidate.id);
    const candidateRow = candidate.data() as WhatsAppInbox;
    if (candidateRow.state === 'pending' && !await activeNumber(candidateRow, db)) {
      await db.runTransaction(async transaction => {
        const fresh = await transaction.get(reference);
        if (fresh.exists && fresh.data()?.state === 'pending') transaction.set(reference, { ...fresh.data(), nextAttemptAt: Date.now() + 60_000 });
      });
      continue;
    }
    const leaseId = randomUUID();
    const inbox = await db.runTransaction(async transaction => {
      const current = await transaction.get(reference);
      if (!current.exists) return null;
      const row = current.data() as WhatsAppInbox;
      if (row.nextAttemptAt > Date.now()) return null;
      if (row.state === 'processing') {
        // A restart cannot know whether inference or a booking already happened.
        await markConversationForReview(row, db, transaction);
        transaction.set(reference, { ...row, state: 'review', nextAttemptAt: WHATSAPP_TERMINAL });
        return null;
      }
      if (row.state !== 'pending') return null;
      const conversation = await transaction.get(db.collection('whatsappConversations').doc(row.conversationId));
      if (!conversationPermitsReply(conversation.data(), row)) {
        transaction.set(reference, { ...row, state: 'review', nextAttemptAt: WHATSAPP_TERMINAL }); return null;
      }
      if (!row.content || row.windowEndsAt <= Date.now() || row.bodyExpiresAt <= Date.now()) {
        transaction.set(reference, { ...row, state: 'expired', nextAttemptAt: WHATSAPP_TERMINAL }); return null;
      }
      transaction.set(reference, { ...row, state: 'processing', leaseId, nextAttemptAt: Date.now() + LEASE_MS });
      return row;
    });
    if (!inbox) continue;
    const operation = registerWhatsAppOperation(inbox, db, 180_000);
    const executionDeadlineAt = Date.now() + 180000;
    try {
      if (!await activeNumber(inbox, db) || !await conversationAllowsReply(inbox, db)) throw new Error('Conversation paused');
      const source = inboundContentSchema.parse(decryptWhatsApp(inbox.content, reference.path));
      const history = await readWhatsAppHistory(inbox.conversationId, db);
      const messages = [...history, { role: 'user' as const, content: source.text }];
      while (messages.length > 20 || messages.reduce((sum, item) => sum + item.content.length, 0) > 60_000) messages.shift();
      await runSarinChat({ user: { uid: `wa_${whatsappHash(inbox.businessId, source.from)}`, phone: `+${source.from}`, ...(source.name ? { name: source.name } : {}) },
        body: { mode: 'sarin_client', tenantId: inbox.businessId, requestId: candidate.id, messages }, channel: 'whatsapp', signal: operation.signal, executionDeadlineAt,
        onResponse: (response, reservation, identity) => persistWhatsAppReply(candidate.id, leaseId, response, reservation, db, identity),
      });
    } catch {
      // Never log customer text, credentials or upstream errors. An outbox written
      // by onResponse survives this failure and is independently reconciled below.
      await db.runTransaction(async transaction => {
        const current = await transaction.get(reference);
        if (current.exists && current.data()?.state === 'processing' && current.data()?.leaseId === leaseId) {
          await markConversationForReview(current.data() as WhatsAppInbox, db, transaction);
          transaction.set(reference, { ...current.data(), state: 'review', nextAttemptAt: WHATSAPP_TERMINAL });
        }
      });
    } finally { operation.dispose(); }
    return; // One inference at a time and per poll; outbound recovery stays bounded.
  }
}

async function sendPending(db: Firestore) {
  const candidates = await db.collection('whatsappOutbox').where('nextAttemptAt', '<=', Date.now()).orderBy('nextAttemptAt').limit(5).get();
  for (const candidate of candidates.docs) {
    const snapshot = await db.collection('whatsappOutbox').doc(candidate.id).get();
    if (!snapshot.exists) continue;
    const initial = snapshot.data() as WhatsAppOutbox;
    if (initial.nextAttemptAt > Date.now()) continue;
    if (initial.state === 'sending') {
      await updateWhatsAppOutbox(candidate.id, row => row.state === 'sending' ? { state: 'unknown', nextAttemptAt: WHATSAPP_TERMINAL } : null, db); continue;
    }
    if (initial.state !== 'ready') continue;
    if (!await conversationAllowsReply(initial, db)) {
      await updateWhatsAppOutbox(candidate.id, row => row.state === 'ready' ? { state: 'cancelled', nextAttemptAt: WHATSAPP_TERMINAL } : null, db); continue;
    }
    if (!initial.content || initial.windowEndsAt <= Date.now() || initial.bodyExpiresAt <= Date.now()) {
      await updateWhatsAppOutbox(candidate.id, () => ({ state: 'expired', nextAttemptAt: WHATSAPP_TERMINAL }), db); continue;
    }
    if (!await activeNumber(initial, db)) {
      await updateWhatsAppOutbox(candidate.id, row => row.state === 'ready' ? { nextAttemptAt: Date.now() + 60_000 } : null, db); continue;
    }
    try { await commitResponseQuota(initial.reservation, undefined, db); }
    catch {
      await updateWhatsAppOutbox(candidate.id, row => row.state === 'ready' ? { nextAttemptAt: Date.now() + 30_000 } : null, db); continue;
    }
    let content: ReturnType<typeof outboundContentSchema.parse>;
    try { content = outboundContentSchema.parse(decryptWhatsApp(initial.content, `whatsappOutbox/${candidate.id}`)); }
    catch { await updateWhatsAppOutbox(candidate.id, () => ({ state: 'failed', failed: true, nextAttemptAt: WHATSAPP_TERMINAL }), db); continue; }
    const operation = registerWhatsAppOperation(initial, db, 15_000);
    try {
      const claimed = await claimWhatsAppOutbox(candidate.id, db);
      if (!claimed) continue;
      if (!await conversationAllowsReply(initial, db) || operation.signal.aborted) {
        await updateWhatsAppOutbox(candidate.id, row => row.state === 'sending' && !row.sent ? { state: 'cancelled', nextAttemptAt: WHATSAPP_TERMINAL } : null, db); continue;
      }
      const config = readWhatsAppConfig();
      const response = await fetch(`https://graph.facebook.com/${config.graphApiVersion}/${initial.phoneNumberId}/messages`, {
        method: 'POST', headers: { Authorization: `Bearer ${config.credentials[initial.phoneNumberId].accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to: `+${content.to}`, type: 'text', text: { preview_url: false, body: content.reply },
          context: { message_id: content.messageId }, biz_opaque_callback_data: candidate.id }),
        redirect: 'error', cache: 'no-store', signal: operation.signal,
      });
      const result = JSON.parse((await readBoundedBytes(response.body, 16_384)).toString('utf8'));
      const id = result?.messages?.[0]?.id;
      if (response.ok && typeof id === 'string' && id.length > 0 && id.length <= 512) {
        await updateWhatsAppOutbox(candidate.id, row => ({ state: row.delivered ? 'delivered' : 'accepted', sent: true, metaMessageId: id, nextAttemptAt: WHATSAPP_TERMINAL }), db);
        await db.collection('whatsappMessageIds').doc(whatsappHash(initial.phoneNumberId, id)).set({ outboxId: candidate.id, expiresAt: initial.expiresAt });
      } else if (response.status === 429 && Number.isSafeInteger(result?.error?.code)) {
        // Only an explicit rejected 429 can be retried. Timeouts/5xx are ambiguous.
        await updateWhatsAppOutbox(candidate.id, row => row.sent ? null : { state: row.attempts < 3 ? 'ready' : 'failed', failed: row.attempts >= 3, errorCode: result.error.code,
          nextAttemptAt: row.attempts < 3 ? Date.now() + 30_000 * 2 ** row.attempts : WHATSAPP_TERMINAL }, db);
      } else if (response.status >= 400 && response.status < 500 && Number.isSafeInteger(result?.error?.code)) {
        await updateWhatsAppOutbox(candidate.id, row => row.sent ? null : { state: 'failed', failed: true, errorCode: result.error.code, nextAttemptAt: WHATSAPP_TERMINAL }, db);
      } else throw new Error('Ambiguous send result');
    } catch {
      await updateWhatsAppOutbox(candidate.id, row => row.sent ? null : { state: 'unknown', nextAttemptAt: WHATSAPP_TERMINAL }, db);
    } finally { operation.dispose(); }
  }
}

export async function processWhatsAppQueue(db: Firestore = getAdminDb()): Promise<void> {
  const config = readWhatsAppConfig();
  if (!config.enabled || !config.configured || processing.has(db)) return;
  processing.add(db);
  try {
    await generateOne(db);
    await sendPending(db);
  } finally { processing.delete(db); }
}

const globalWorker = globalThis as typeof globalThis & { __sarinWhatsAppTimer?: ReturnType<typeof setInterval>; __sarinWhatsAppRetentionTimer?: ReturnType<typeof setTimeout> };
export function kickWhatsAppWorker(): void {
  const config = readWhatsAppConfig();
  if (!config.enabled || !config.configured) return;
  void processWhatsAppQueue().catch(() => { /* Durable records are retried or quarantined next poll. No payload logs. */ });
}
export function startWhatsAppWorker(): void {
  const config = readWhatsAppConfig();
  if (process.env.WHATSAPP_RETENTION_ENABLED === 'true' && !globalWorker.__sarinWhatsAppRetentionTimer) {
    const maintain = async () => {
      if (process.env.WHATSAPP_RETENTION_ENABLED !== 'true') { delete globalWorker.__sarinWhatsAppRetentionTimer; return; }
      let morePending = false;
      try { morePending = (await cleanupWhatsAppRetention()).morePending; } catch { /* Manual authenticated cleanup remains available. */ }
      // Empty queues cost seven bounded queries per hour. Full batches drain
      // again in a minute; a fixed hourly cap must not accumulate old bodies.
      globalWorker.__sarinWhatsAppRetentionTimer = setTimeout(maintain, morePending ? 60_000 : 3_600_000);
      globalWorker.__sarinWhatsAppRetentionTimer.unref();
    };
    globalWorker.__sarinWhatsAppRetentionTimer = setTimeout(maintain, 0);
    globalWorker.__sarinWhatsAppRetentionTimer.unref();
  }
  if (config.enabled && config.configured && !globalWorker.__sarinWhatsAppTimer) {
    globalWorker.__sarinWhatsAppTimer = setInterval(kickWhatsAppWorker, 30_000);
    globalWorker.__sarinWhatsAppTimer.unref();
    kickWhatsAppWorker();
  }
}
