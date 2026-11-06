import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryFirestore } from './memoryFirestore';
import { inbound, syntheticWhatsAppEnv, whatsappRows, phoneId, sender } from './whatsapp-fixtures';
const state = vi.hoisted(() => ({ db: undefined as unknown, chat: vi.fn(), commit: vi.fn() }));
vi.mock('@/lib/firebase/admin', () => ({ getAdminDb: () => state.db }));
vi.mock('@/lib/server/chat', () => ({ runSarinChat: state.chat }));
vi.mock('@/lib/server/response-quota', () => ({ commitResponseQuota: state.commit }));
import { ingestWhatsAppWebhook, cleanupWhatsAppRetention, getWhatsAppUsage } from '@/lib/server/whatsapp-store';
import { processWhatsAppQueue } from '@/lib/server/whatsapp-worker';
import { decryptWhatsApp } from '@/lib/server/whatsapp-security';
import { admissionPolicy } from './booking-admission-storage-contract';
import { bookingDataPolicyKey } from '@/lib/server/booking-data-policy';
const reservation = { reservationId: 'r'.repeat(64), scopeId: 'business_a', periodId: 'period-a', attemptId: 'attempt-a' };
const documents = (rows: ReturnType<typeof memoryFirestore>['rows'], collection: string) => [...rows].filter(([path]) => path.startsWith(`${collection}/`));
beforeEach(() => {
  syntheticWhatsAppEnv();
  state.commit.mockReset().mockResolvedValue(undefined);
  state.chat.mockReset().mockImplementation(async input => {
    const response = { reply: 'Respuesta sintética segura.' };
    await input.onResponse(response, reservation);
    return response;
  });
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ messaging_product: 'whatsapp', messages: [{ id: 'wamid.outgoing' }] })));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('durable encrypted WhatsApp inbox/outbox', () => {
  it('refuses to persist a newly generated outbox after policy withdrawal', async () => {
    const { db, rows } = memoryFirestore({ ...whatsappRows(), [`serverSettings/${bookingDataPolicyKey('business_a')}`]: { ...admissionPolicy, businessId: 'business_a', status: 'withdrawn' } }); state.db = db;
    await ingestWhatsAppWebhook(inbound(), db); await processWhatsAppQueue(db);
    expect(documents(rows, 'whatsappOutbox')).toHaveLength(0); expect(fetch).not.toHaveBeenCalled();
  });
  it('refuses an already durable ready outbox when policy is withdrawn just before send', async () => {
    const { db, rows } = memoryFirestore(whatsappRows()); state.db = db;
    state.chat.mockImplementationOnce(async input => {
      await input.onResponse({ reply: 'Synthetic pending' }, reservation);
      await db.collection('serverSettings').doc(bookingDataPolicyKey('business_a')).set({ ...admissionPolicy, businessId: 'business_a', status: 'withdrawn' });
    });
    await ingestWhatsAppWebhook(inbound(), db); await processWhatsAppQueue(db);
    expect(documents(rows, 'whatsappOutbox')[0][1].data.state).toBe('cancelled'); expect(fetch).not.toHaveBeenCalled();
  });
  const humanEcho = () => ({ object: 'whatsapp_business_account', entry: [{ id: '200001', changes: [{ field: 'smb_message_echoes', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: phoneId }, message_echoes: [{ id: 'wamid.synthetic-human', from: '573009998877', to: sender, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'Synthetic human reply' } }] } }] }] });
  it('applies an app echo before an inbound turn and keeps human control without inference or send', async () => {
    const { db, rows } = memoryFirestore(whatsappRows()); state.db = db;
    const batch = inbound();
    await ingestWhatsAppWebhook({ ...batch, entry: [...batch.entry, ...humanEcho().entry] }, db);
    await processWhatsAppQueue(db);
    expect(documents(rows, 'whatsappInbox')[0][1].data.state).toBe('review');
    expect(documents(rows, 'whatsappConversations')[0][1].data).toMatchObject({ mode: 'human', revision: 1 });
    expect(state.chat).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
    expect(JSON.stringify([...rows])).not.toMatch(/Synthetic human reply|573001112233/);
  });
  it('aborts in-flight generation on a human echo and refuses its stale persisted reply', async () => {
    const { db, rows } = memoryFirestore(whatsappRows()); state.db = db;
    state.chat.mockImplementationOnce(async input => {
      await ingestWhatsAppWebhook(humanEcho(), db);
      expect(input.signal.aborted).toBe(true);
      await expect(input.onResponse({ reply: 'Stale synthetic reply' }, reservation)).rejects.toMatchObject({ code: 'WHATSAPP_CONTROL_CHANGED' });
      throw input.signal.reason;
    });
    await ingestWhatsAppWebhook(inbound(), db); await processWhatsAppQueue(db);
    expect(documents(rows, 'whatsappOutbox')).toHaveLength(0);
    expect(documents(rows, 'whatsappInbox')[0][1].data.state).toBe('review');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('cancels an already persisted reply if the business app takes control before send', async () => {
    const { db, rows } = memoryFirestore(whatsappRows()); state.db = db;
    state.chat.mockImplementationOnce(async input => {
      await input.onResponse({ reply: 'Synthetic pending reply' }, reservation);
      await ingestWhatsAppWebhook(humanEcho(), db);
    });
    await ingestWhatsAppWebhook(inbound(), db); await processWhatsAppQueue(db);
    expect(documents(rows, 'whatsappOutbox')[0][1].data.state).toBe('cancelled');
    expect(fetch).not.toHaveBeenCalled();
    const conversation = documents(rows, 'whatsappConversations')[0][1].data;
    await cleanupWhatsAppRetention(db, Number(conversation.bodyExpiresAt) + 1);
    expect(documents(rows, 'whatsappConversations')[0][1].data).toMatchObject({ content: null, contactContent: null });
  });
  it('deduplicates concurrent deliveries before inference and stores no plaintext content or phone', async () => {
    const { db, rows } = memoryFirestore(whatsappRows()); state.db = db;
    await Promise.all([ingestWhatsAppWebhook(inbound(), db), ingestWhatsAppWebhook(inbound(), db)]);
    expect(documents(rows, 'whatsappInbox')).toHaveLength(1);
    expect(JSON.stringify([...rows])).not.toMatch(/Reserva|573001112233|Synthetic Customer/);
    expect(state.chat).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
    await processWhatsAppQueue(db);
    expect(state.chat).toHaveBeenCalledTimes(1);
    const request = state.chat.mock.calls[0][0];
    expect(request).toMatchObject({ channel: 'whatsapp', user: { phone: `+${sender}`, uid: expect.stringMatching(/^wa_[a-f0-9]{64}$/) }, body: { mode: 'sarin_client', tenantId: 'business_a', requestId: expect.stringMatching(/^[a-f0-9]{64}$/), messages: [{ role: 'user', content: 'Reserva sintética' }] } });
    expect(documents(rows, 'whatsappOutbox')).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, options] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe('https://graph.facebook.com/v25.0/100001/messages');
    expect(options).toMatchObject({ method: 'POST', redirect: 'error' });
    expect(JSON.parse(String(options?.body))).toMatchObject({ messaging_product: 'whatsapp', recipient_type: 'individual', to: `+${sender}`, type: 'text', text: { body: 'Respuesta sintética segura.' }, biz_opaque_callback_data: expect.stringMatching(/^[a-f0-9]{64}$/) });
    await ingestWhatsAppWebhook(inbound(), db); await processWhatsAppQueue(db);
    expect(state.chat).toHaveBeenCalledTimes(1); expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.stringify([...rows])).not.toMatch(/Respuesta|573001112233|Reserva/);
  });
  it('ignores unbound numbers, mismatching WABA and expired inbound messages without AI or sends', async () => {
    const { db, rows } = memoryFirestore(whatsappRows()); state.db = db;
    const unknown = inbound(); unknown.entry[0].changes[0].value.metadata.phone_number_id = '999999';
    await ingestWhatsAppWebhook(unknown, db);
    const cross = inbound(); cross.entry[0].id = '999999'; await ingestWhatsAppWebhook(cross, db);
    await ingestWhatsAppWebhook(inbound('wamid.old', Date.now() - 86_401_000), db);
    await processWhatsAppQueue(db);
    expect(state.chat).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
    expect(documents(rows, 'whatsappInbox').every(([, row]) => row.data.state === 'expired')).toBe(true);
  });
  it('recovers committed outbox after chat failure without rerunning inference or charging twice', async () => {
    const { db, rows } = memoryFirestore(whatsappRows()); state.db = db;
    state.chat.mockImplementation(async input => { await input.onResponse({ reply: 'Respuesta durable' }, reservation); throw new Error('process lost after durable output'); });
    state.commit.mockRejectedValueOnce(new Error('storage transient'));
    await ingestWhatsAppWebhook(inbound(), db); await processWhatsAppQueue(db);
    expect(fetch).not.toHaveBeenCalled();
    const outbox = documents(rows, 'whatsappOutbox')[0];
    outbox[1].data.nextAttemptAt = 0;
    await processWhatsAppQueue(db);
    expect(state.chat).toHaveBeenCalledTimes(1); expect(fetch).toHaveBeenCalledTimes(1);
    expect(documents(rows, 'whatsappOutbox')[0][1].data.state).toBe('accepted');
  });
  it('does not resend an ambiguous POST, and correlates a later read status without delivered', async () => {
    const { db, rows } = memoryFirestore(whatsappRows()); state.db = db;
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('request may have been accepted'); }));
    await ingestWhatsAppWebhook(inbound(), db); await processWhatsAppQueue(db);
    const [path, row] = documents(rows, 'whatsappOutbox')[0];
    expect(row.data.state).toBe('unknown');
    await processWhatsAppQueue(db); expect(fetch).toHaveBeenCalledTimes(1);
    const status = { object: 'whatsapp_business_account', entry: [{ id: '200001', changes: [{ field: 'messages', value: {
      messaging_product: 'whatsapp', metadata: { phone_number_id: phoneId }, statuses: [{ id: 'wamid.outgoing', status: 'read', timestamp: String(Math.floor(Date.now() / 1000)), biz_opaque_callback_data: path.split('/')[1], pricing: { pricing_model: 'PMP', type: 'regular', category: 'service' } }],
    } }] }] };
    await ingestWhatsAppWebhook(status, db); await ingestWhatsAppWebhook(status, db);
    expect(rows.get(path)?.data).toMatchObject({ state: 'delivered', delivered: true, read: true, pricing: { type: 'regular', category: 'service' } });
    const usage = await getWhatsAppUsage(db);
    expect(usage).toMatchObject({ totals: { sent: 1, delivered: 1, read: 1, failed: 0, unknown: 0, serviceDelivered: 1 }, estimatedCostCOP: null, source: 'meta_webhooks', invoice: false });
  });
  it('quarantines expired processing/sending leases rather than repeating ambiguous effects', async () => {
    const { db, rows } = memoryFirestore(whatsappRows()); state.db = db;
    await ingestWhatsAppWebhook(inbound(), db);
    const inbox = documents(rows, 'whatsappInbox')[0][1].data;
    inbox.state = 'processing'; inbox.nextAttemptAt = 0;
    await processWhatsAppQueue(db);
    expect(inbox.state === 'review' || documents(rows, 'whatsappInbox')[0][1].data.state === 'review').toBe(true);
    expect(state.chat).not.toHaveBeenCalled();
  });
  it('will not deliver after the 24h window even when the response was already generated', async () => {
    const { db, rows } = memoryFirestore(whatsappRows()); state.db = db;
    state.commit.mockRejectedValueOnce(new Error('storage transient'));
    await ingestWhatsAppWebhook(inbound(), db); await processWhatsAppQueue(db);
    const row = documents(rows, 'whatsappOutbox')[0][1].data;
    row.windowEndsAt = Date.now() - 1; row.nextAttemptAt = 0;
    await processWhatsAppQueue(db);
    expect(documents(rows, 'whatsappOutbox')[0][1].data.state).toBe('expired'); expect(fetch).not.toHaveBeenCalled();
  });
  it('erases encrypted bodies after 24h, retains dedupe metadata until 30 days, then deletes metadata', async () => {
    const { db, rows } = memoryFirestore(whatsappRows()); state.db = db;
    const now = Date.now(); await ingestWhatsAppWebhook(inbound(), db, now);
    const [path, row] = documents(rows, 'whatsappInbox')[0];
    expect(decryptWhatsApp(row.data.content, path)).toMatchObject({ from: sender, text: 'Reserva sintética' });
    await cleanupWhatsAppRetention(db, now + 86_400_001);
    expect(rows.get(path)?.data.content).toBeNull();
    expect(rows.has(path)).toBe(true);
    await cleanupWhatsAppRetention(db, now + 30 * 86_400_000 + 1);
    expect(rows.has(path)).toBe(false);
  });
  it('keeps paused messages recoverable without monopolizing the next polling batch', async () => {
    const { db, rows } = memoryFirestore(whatsappRows()); state.db = db;
    await ingestWhatsAppWebhook(inbound(), db);
    rows.get(`whatsappNumbers/${phoneId}`)!.data.enabled = false;
    await processWhatsAppQueue(db);
    expect(documents(rows, 'whatsappInbox')[0][1].data).toMatchObject({ state: 'pending', nextAttemptAt: expect.any(Number) });
    expect(state.chat).not.toHaveBeenCalled();
    rows.get(`whatsappNumbers/${phoneId}`)!.data.enabled = true;
    documents(rows, 'whatsappInbox')[0][1].data.nextAttemptAt = 0;
    await processWhatsAppQueue(db);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('retries an explicit rejected429 at most3 times and never repeats inference', async () => {
    const { db, rows } = memoryFirestore(whatsappRows()); state.db = db;
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: { code: 130429, message: 'private detail' } }, { status: 429 })));
    await ingestWhatsAppWebhook(inbound(), db); await processWhatsAppQueue(db);
    for (let attempt = 0; attempt < 4; attempt++) {
      const outbox = documents(rows, 'whatsappOutbox')[0][1].data;
      if (outbox.state === 'ready') outbox.nextAttemptAt = 0;
      await processWhatsAppQueue(db);
    }
    expect(fetch).toHaveBeenCalledTimes(3); expect(state.chat).toHaveBeenCalledTimes(1);
    expect(documents(rows, 'whatsappOutbox')[0][1].data).toMatchObject({ state: 'failed', errorCode: 130429 });
    expect(JSON.stringify([...rows])).not.toContain('private detail');
  });
  it('bounds concurrent workers and quarantines a lost sending lease', async () => {
    const { db, rows } = memoryFirestore(whatsappRows()); state.db = db;
    await ingestWhatsAppWebhook(inbound(), db);
    await Promise.all([processWhatsAppQueue(db), processWhatsAppQueue(db)]);
    expect(state.chat).toHaveBeenCalledTimes(1); expect(fetch).toHaveBeenCalledTimes(1);
    const outbox = documents(rows, 'whatsappOutbox')[0][1].data;
    outbox.state = 'sending'; outbox.sent = false; outbox.nextAttemptAt = 0;
    await processWhatsAppQueue(db);
    expect(documents(rows, 'whatsappOutbox')[0][1].data.state).toBe('unknown'); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('acknowledges unsupported media without an automated response and bounds batch size', async () => {
    const { db, rows } = memoryFirestore(whatsappRows()); state.db = db;
    const media = inbound(); media.entry[0].changes[0].value.messages[0].type = 'image';
    await ingestWhatsAppWebhook(media, db);
    expect(documents(rows, 'whatsappInbox')).toHaveLength(0);
    const oversized = inbound(); oversized.entry[0].changes[0].value.messages = Array.from({ length: 101 }, (_, index) => ({ ...oversized.entry[0].changes[0].value.messages[0], id: `wamid.${index}` }));
    await expect(ingestWhatsAppWebhook(oversized, db)).rejects.toMatchObject({ status: 400 });
    expect(documents(rows, 'whatsappInbox')).toHaveLength(0);
  });
  it('lets an active business progress after a polling page of five paused outboxes', async () => {
    const { db, rows } = memoryFirestore(whatsappRows()); state.db = db;
    state.commit.mockRejectedValueOnce(new Error('prepare ready output'));
    await ingestWhatsAppWebhook(inbound(), db); await processWhatsAppQueue(db);
    const [, original] = documents(rows, 'whatsappOutbox')[0];
    const ready = structuredClone(original.data);
    const originalPath = documents(rows, 'whatsappOutbox')[0][0];
    rows.delete(originalPath);
    rows.set('whatsappNumbers/100002', { version: 1, data: { businessId: 'paused_business', phoneNumberId: '100002', wabaId: '200001', enabled: false, verifiedAt: 1, updatedAt: 1 } });
    for (let index = 0; index < 5; index++) rows.set(`whatsappOutbox/paused${index}`, { version: 1, data: { ...ready, businessId: 'paused_business', phoneNumberId: '100002', nextAttemptAt: 0 } });
    rows.set(originalPath, { version: 1, data: { ...ready, nextAttemptAt: 1 } });
    await processWhatsAppQueue(db);
    expect(fetch).not.toHaveBeenCalled();
    await processWhatsAppQueue(db);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('labels status totals by generation cohort when delivery crosses the Bogota month boundary', async () => {
    const generatedAt = Date.parse('2026-11-01T04:59:00Z');
    const now = vi.spyOn(Date, 'now').mockReturnValue(generatedAt);
    const { db, rows } = memoryFirestore(whatsappRows()); state.db = db;
    await ingestWhatsAppWebhook(inbound(), db); await processWhatsAppQueue(db);
    const id = documents(rows, 'whatsappOutbox')[0][0].split('/')[1];
    now.mockReturnValue(Date.parse('2026-11-01T05:01:00Z'));
    await ingestWhatsAppWebhook({ object: 'whatsapp_business_account', entry: [{ id: '200001', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: phoneId }, statuses: [{ id: 'wamid.outgoing', status: 'delivered', timestamp: String(Math.floor(Date.now() / 1000)), biz_opaque_callback_data: id }] } }] }] }, db);
    expect(await getWhatsAppUsage(db, generatedAt)).toMatchObject({ month: '2026-10', cohort: 'generated_month', totals: { delivered: 1 } });
    expect(await getWhatsAppUsage(db)).toMatchObject({ month: '2026-11', cohort: 'generated_month', totals: { delivered: 0 } });
  });
});
