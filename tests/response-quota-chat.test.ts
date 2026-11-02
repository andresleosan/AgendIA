import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { consentedFirestore } from './consent-fixtures';
import { quotaProtocolEntries } from './response-quota-fixtures';
import { ownerRescheduleBusiness as business, ownerRescheduleNow as now } from './owner-rescheduling-contract';
const state = vi.hoisted(() => ({ db: null as unknown, reply: vi.fn() }));
vi.mock('@/lib/firebase/admin', () => ({ getAdminDb: () => state.db }));
vi.mock('@/lib/sarin/engine', async original => ({ ...await original<typeof import('@/lib/sarin/engine')>(), completeChat: async (_messages: unknown, _tools: unknown, options: { beforeDispatch?: (context: { provider: 'ollama'; providerCallId: null }) => Promise<void> }) => { await options.beforeDispatch?.({ provider: 'ollama', providerCallId: null }); return state.reply(); } }));
import { runSarinChat } from '@/lib/server/chat';
import { getResponseQuota } from '@/lib/server/response-quota';
import { finishResponseQuota } from '@/lib/server/response-quota-store';
import { updateConsent, readConsent } from '@/lib/server/consent';
import { confirmBookingProposal } from '@/lib/server/booking-proposals';
const user = { uid: 'demo-client' };
const body = (requestId: string) => ({ mode: 'sarin_client' as const, tenantId: business.id, requestId, messages: [{ role: 'user' as const, content: 'Synthetic question' }] });
const interpretation = (intent = 'services') => ({ role: 'assistant', content: null, tool_calls: [{ id: 'demo-call', type: 'function', function: { name: 'interpretar_solicitud', arguments: JSON.stringify({ intent, selection: intent === 'booking' ? { serviceId: 'demo-cut', resourceId: 'demo-chair', dateKey: '2030-01-07', startTimeStr: '10:00' } : {} }) } }] });
function setup() { const f = consentedFirestore({ ...quotaProtocolEntries, [`businesses/${business.id}`]: business }, [user.uid, business.ownerUid]); state.db = f.db; return f; }
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(now); vi.stubEnv('SARIN_CHAT_PROVIDER', 'ollama'); state.reply.mockReset(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
it('invalidOrUnpublishedResultStillConsumesOne', async () => {
  const f = setup(); state.reply.mockRejectedValue(new Error('provider failed after dispatch'));
  await expect(runSarinChat({ user, body: body('demo-failure') })).rejects.toThrow();
  expect((await getResponseQuota(business.id, f.db)).currentPeriod).toMatchObject({ usedResponses: 1, reservedResponses: 0 });
  expect((await f.db.collection('responseQuotaReceipts').get()).size).toBe(1);
});
it('closeWinsAgainstLateEffects', async () => {
  const f = setup(); state.reply.mockImplementation(async () => {
    const turn = (await f.db.collection('responseQuotaTurns').get()).docs[0].data();
    await finishResponseQuota({ reservationId: turn.reservationId, scopeId: turn.scopeId, periodId: turn.periodId, attemptId: turn.attemptId }, true, f.db);
    return interpretation('booking');
  });
  await expect(runSarinChat({ user, body: body('demo-late') })).rejects.toMatchObject({ code: 'AI_RESPONSE_INTERRUPTED' });
  expect((await f.db.collection('bookingProposals').get()).size).toBe(0);
  expect((await f.db.collection('chatStates').get()).size).toBe(0);
  expect((await f.db.collection('whatsappOutbox').get()).size).toBe(0);
});
it('plainResponseLostReturnsReceiptWithoutInference', async () => {
  const f = setup(); state.reply.mockResolvedValue(interpretation());
  await runSarinChat({ user, body: body('demo-plain') });
  vi.setSystemTime(now + 16 * 60000);
  await expect(runSarinChat({ user, body: body('demo-plain') })).rejects.toMatchObject({ code: 'REQUEST_ALREADY_COMPLETED' });
  expect(state.reply).toHaveBeenCalledTimes(1);
  expect((await getResponseQuota(business.id, f.db)).currentPeriod?.usedResponses).toBe(1);
});
it('confirmed proposal replay settles the original proof after lost settlement and cache restart', async () => {
  const f = setup(); state.reply.mockResolvedValue(interpretation('booking'));
  const transact = f.db.runTransaction.bind(f.db);
  const loss = vi.spyOn(f.db, 'runTransaction').mockImplementation((handler, options) => transact(tx => handler({ ...tx, create: (ref, data) => {
    if (ref.path.startsWith('responseQuotaReceipts/')) throw new Error('Synthetic settlement outage');
    return tx.create(ref, data);
  } } as typeof tx), options));
  const request = body('demo-confirmed-replay'), first = await runSarinChat({ user, body: request });
  loss.mockRestore();
  const appointment = await confirmBookingProposal(user, business.id, first.proposal!.id, { clientPhone: '573001234567', intakeAnswers: {} }, f.db);
  state.db = { collection: f.db.collection.bind(f.db), runTransaction: f.db.runTransaction.bind(f.db) };
  const replay = await runSarinChat({ user, body: request });
  expect(replay.toolResults?.[0].result.appointment).toMatchObject({ id: appointment.id });
  expect(state.reply).toHaveBeenCalledTimes(1);
  const receipt = (await f.db.collection('responseQuotaReceipts').get()).docs[0].data();
  expect(receipt.execution.result).toEqual({ kind: 'proposal', id: first.proposal!.id });
  expect((await getResponseQuota(business.id, f.db)).currentPeriod).toMatchObject({ usedResponses: 1, reservedResponses: 0 });
});
it('revocationAfterDispatchBlocksEffectsButCanSettleQuota', async () => {
  const f = setup(); state.reply.mockImplementation(async () => {
    const current = await readConsent(user.uid, 'account', undefined, f.db);
    await updateConsent(user, { scope: 'account', action: 'revoke', requestId: 'demo-revoke-quota', expectedRevision: current.revision }, f.db);
    return interpretation('booking');
  });
  await expect(runSarinChat({ user, body: body('demo-revoked') })).rejects.toMatchObject({ code: 'CONSENT_REQUIRED' });
  expect((await getResponseQuota(business.id, f.db)).currentPeriod).toMatchObject({ usedResponses: 1, reservedResponses: 0 });
  expect((await f.db.collection('bookingProposals').get()).size).toBe(0);
});
it('revocationAfterStateCommitCannotPublishTheReply', async () => {
  const f = setup(); state.reply.mockResolvedValue(interpretation());
  const transact = f.db.runTransaction.bind(f.db); let revoked = false;
  vi.spyOn(f.db, 'runTransaction').mockImplementation(async (handler, options) => {
    const result = await transact(handler, options);
    if (!revoked && [...f.rows.keys()].some(path => path.startsWith('chatStates/'))) {
      revoked = true;
      const current = await readConsent(user.uid, 'account', undefined, f.db);
      await updateConsent(user, { scope: 'account', action: 'revoke', requestId: 'demo-late-revoke', expectedRevision: current.revision }, f.db);
    }
    return result;
  });
  await expect(runSarinChat({ user, body: body('demo-final-guard') })).rejects.toMatchObject({ code: 'CONSENT_REQUIRED' });
  expect((await getResponseQuota(business.id, f.db)).currentPeriod).toMatchObject({ usedResponses: 1, reservedResponses: 0 });
});
