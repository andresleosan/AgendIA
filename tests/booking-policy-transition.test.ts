import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { completeChat } from '@/lib/sarin/engine';
import { reserveResponseQuota } from '@/lib/server/response-quota';
import { markResponseQuotaDispatch } from '@/lib/server/response-quota-store';
import { bookingDataPolicyKey } from '@/lib/server/booking-data-policy';
import { bookingDispatchHeadKey } from '@/lib/server/booking-admission';
import { memoryFirestore } from './memoryFirestore';
import { quotaProtocolEntries } from './response-quota-fixtures';
import { privateBusinessDraft } from '@/lib/server/businesses';
import { admissionPolicy } from './booking-admission-storage-contract';
import { prepareBookingDispatchRegistration, withBookingDispatch } from '@/lib/server/booking-policy-transition';

beforeEach(() => {
  vi.stubEnv('SARIN_CHAT_PROVIDER', 'deepseek'); vi.stubEnv('DEEPSEEK_API_KEY', 'synthetic'); vi.stubEnv('PILOT_AI_BUDGET_ENFORCED', 'false');
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ choices: [{ message: { content: 'Synthetic' } }] })));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('a denied transport wrapper prevents both the quota hook and provider fetch', async () => {
  const beforeDispatch = vi.fn();
  const dispatch = async () => { throw new Error('demo barrier closed'); };
  await expect(completeChat([{ role: 'user', content: 'Synthetic' }], undefined, { beforeDispatch, dispatch } as Parameters<typeof completeChat>[2])).rejects.toThrow('demo barrier closed');
  expect(beforeDispatch).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
});

it('quota authorization and durable head registration are atomic and refuse a withdrawn policy', async () => {
  const business = { ...privateBusinessDraft({ uid: 'demo-owner' }, Date.now()), id: admissionPolicy.businessId, subscription: { status: 'active', trialEndsAt: 0, currentPeriodEndsAt: Date.now() + 86400000 } };
  const { db } = memoryFirestore({ ...quotaProtocolEntries, [`businesses/${business.id}`]: business, [`serverSettings/${bookingDataPolicyKey(business.id)}`]: admissionPolicy });
  const input = { businessId: business.id, actorUid: 'demo-owner', mode: 'sarin_onboarding' as const, channel: 'web' as const, requestId: 'demo-mark-head', fingerprint: 'a'.repeat(64) };
  const quota = await reserveResponseQuota(input, db, undefined, { deadlineAt: Date.now() + 300000 });
  await db.collection('serverSettings').doc(bookingDataPolicyKey(business.id)).set({ ...admissionPolicy, status: 'withdrawn' });
  await expect(markResponseQuotaDispatch(quota.reservation, input.fingerprint, { providerCallId: null }, db)).rejects.toMatchObject({ code: 'BOOKING_DECLARATION_WITHDRAWN' });
  expect((await db.collection('responseQuotaTurns').doc(quota.reservation.reservationId).get()).data()?.execution.mayHaveDispatched).toBe(false);
  await db.collection('serverSettings').doc(bookingDataPolicyKey(business.id)).set(admissionPolicy);
  await markResponseQuotaDispatch(quota.reservation, input.fingerprint, { providerCallId: null }, db);
  expect((await db.collection('serverSettings').doc(bookingDispatchHeadKey(business.id)).get()).data()).toMatchObject({ refs: [{ kind: 'quota', id: quota.reservation.reservationId, policyRevision: 2 }] });
});

it.each([401, 429, 200])('a definite provider response (%s) resolves its head even if application parsing rejects it', async status => {
  const business = { ...privateBusinessDraft({ uid: 'demo-owner' }, Date.now()), id: admissionPolicy.businessId, subscription: { status: 'active', trialEndsAt: 0, currentPeriodEndsAt: Date.now() + 86400000 } };
  const { db } = memoryFirestore({ ...quotaProtocolEntries, [`businesses/${business.id}`]: business, [`serverSettings/${bookingDataPolicyKey(business.id)}`]: admissionPolicy });
  const input = { businessId: business.id, actorUid: 'demo-owner', mode: 'sarin_onboarding' as const, channel: 'web' as const, requestId: 'demo-rejected', fingerprint: 'a'.repeat(64) };
  const quota = await reserveResponseQuota(input, db, undefined, { deadlineAt: Date.now() + 300000 });
  vi.mocked(fetch).mockResolvedValueOnce(new Response('invalid synthetic JSON', { status }));
  await expect(completeChat([{ role: 'user', content: 'Synthetic' }], undefined, { beforeDispatch: async context => { await markResponseQuotaDispatch(quota.reservation, input.fingerprint, context, db); }, dispatch: (_context, send) => withBookingDispatch({ businessId: business.id, operation: 'inference', identity: { kind: 'quota', id: quota.reservation.reservationId }, db }, send) })).rejects.toThrow();
  expect((await db.collection('serverSettings').doc(bookingDispatchHeadKey(business.id)).get()).data()?.refs).toEqual([]);
  expect(fetch).toHaveBeenCalledTimes(1);
});
it('a callback that did not claim or resolve a transport cannot erase another uncertain head', async () => {
  const business = { ...privateBusinessDraft({ uid: 'demo-owner' }, Date.now()), id: admissionPolicy.businessId };
  const { db } = memoryFirestore({ [`businesses/${business.id}`]: business, [`serverSettings/${bookingDataPolicyKey(business.id)}`]: admissionPolicy });
  const identity = { kind: 'whatsapp' as const, id: 'demo-unknown' };
  await db.runTransaction(async tx => { const register = await prepareBookingDispatchRegistration(tx, db, business.id, identity); register(); });
  await withBookingDispatch({ businessId: business.id, operation: 'channel_reply', identity, db }, async () => false);
  expect((await db.collection('serverSettings').doc(bookingDispatchHeadKey(business.id)).get()).data()?.refs).toMatchObject([identity]);
});
it('an abort after its own durable mark resolves the head without replaying or refunding marked quota', async () => {
  const business = { ...privateBusinessDraft({ uid: 'demo-owner' }, Date.now()), id: admissionPolicy.businessId, subscription: { status: 'active', trialEndsAt: 0, currentPeriodEndsAt: Date.now() + 86400000 } };
  const { db } = memoryFirestore({ ...quotaProtocolEntries, [`businesses/${business.id}`]: business, [`serverSettings/${bookingDataPolicyKey(business.id)}`]: admissionPolicy });
  const input = { businessId: business.id, actorUid: 'demo-owner', mode: 'sarin_onboarding' as const, channel: 'web' as const, requestId: 'demo-aborted', fingerprint: 'a'.repeat(64) };
  const quota = await reserveResponseQuota(input, db, undefined, { deadlineAt: Date.now() + 300000 });
  const controller = new AbortController();
  await expect(completeChat([{ role: 'user', content: 'Synthetic' }], undefined, { signal: controller.signal, beforeDispatch: async context => { await markResponseQuotaDispatch(quota.reservation, input.fingerprint, context, db); controller.abort(); }, dispatch: (_context, send) => withBookingDispatch({ businessId: business.id, operation: 'inference', identity: { kind: 'quota', id: quota.reservation.reservationId }, db }, send) })).rejects.toMatchObject({ name: 'AbortError' });
  expect((await db.collection('serverSettings').doc(bookingDispatchHeadKey(business.id)).get()).data()?.refs).toEqual([]);
  expect((await db.collection('responseQuotaTurns').doc(quota.reservation.reservationId).get()).data()?.execution.mayHaveDispatched).toBe(true);
  expect(fetch).not.toHaveBeenCalled();
});
