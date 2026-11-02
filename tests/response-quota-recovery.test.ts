import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { memoryFirestore } from './memoryFirestore';
import { quotaProtocolEntries } from './response-quota-fixtures';
import { privateBusinessDraft } from '@/lib/server/businesses';
import { reserveResponseQuota, getResponseQuota } from '@/lib/server/response-quota';
import { markResponseQuotaDispatch } from '@/lib/server/response-quota-store';
import { recoverResponseQuotaBatch } from '@/lib/server/response-quota-recovery';
const now = Date.parse('2030-01-01T12:00:00Z');
const business = { ...privateBusinessDraft({ uid: 'demo-owner' }, now), id: 'demo-recovery', slug: 'demo-recovery', subscription: { status: 'active', trialEndsAt: 0, currentPeriodEndsAt: now + 86400000 }, sarinConfig: { onboardingCompleted: true, tone: '', customRules: '', intakeFields: [] } };
export const recoveryInput = { businessId: business.id, actorUid: 'demo-client', mode: 'sarin_client' as const, channel: 'web' as const, requestId: 'demo-recovery', fingerprint: 'a'.repeat(64) };
function setup() { return memoryFirestore({ ...quotaProtocolEntries, [`businesses/${business.id}`]: business }); }
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(now); vi.stubGlobal('fetch', vi.fn(() => { throw Error('No provider from recovery'); })); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
it('preparedClosedBeforeDispatchFencesOldWorker', async () => {
  const { db } = setup(), quota = await reserveResponseQuota(recoveryInput, db, undefined, { deadlineAt: now + 1000 });
  vi.setSystemTime(now + 2000);
  expect((await recoverResponseQuotaBatch(db)).settled).toBe(1);
  expect((await getResponseQuota(business.id, db)).currentPeriod).toMatchObject({ usedResponses: 0, reservedResponses: 0 });
  await expect(markResponseQuotaDispatch(quota.reservation, recoveryInput.fingerprint, { providerCallId: null }, db)).rejects.toMatchObject({ code: 'AI_RESPONSE_INTERRUPTED' });
  expect(fetch).not.toHaveBeenCalled();
});
it('dispatchedInterruptedConsumesWithoutPublishing', async () => {
  const { db } = setup(), quota = await reserveResponseQuota(recoveryInput, db, undefined, { deadlineAt: now + 1000 });
  await markResponseQuotaDispatch(quota.reservation, recoveryInput.fingerprint, { providerCallId: null }, db);
  vi.setSystemTime(now + 2000); await recoverResponseQuotaBatch(db); await recoverResponseQuotaBatch(db);
  expect((await getResponseQuota(business.id, db)).currentPeriod).toMatchObject({ usedResponses: 1, reservedResponses: 0 });
  expect((await db.collection('responseQuotaReceipts').get()).size).toBe(1);
  expect((await db.collection('whatsappOutbox').get()).size).toBe(0);
});
it('legacyUnknownNeedsHumanReviewAndNeverRefundsByAge', async () => {
  const { db } = setup(), quota = await reserveResponseQuota(recoveryInput, db, undefined, { deadlineAt: now + 1000 });
  const ref = db.collection('responseQuotaTurns').doc(quota.reservation.reservationId), saved = (await ref.get()).data()!;
  const { execution: _execution, nextAttemptAt: _next, ...legacy } = saved; await ref.set(legacy);
  vi.setSystemTime(now + 86400000); await recoverResponseQuotaBatch(db);
  expect((await ref.get()).data()).toMatchObject({ status: 'reserved', execution: { origin: 'legacy_unknown' } });
  expect((await db.collection('responseQuotaScopes').doc(quota.reservation.scopeId).collection('periods').doc(quota.reservation.periodId).get()).data()).toMatchObject({ usedResponses: 0, reservedResponses: 1 });
});
it('recoveryScans1001WithTiesAndRestartWithin50Visits', async () => {
  const { db } = setup(), quota = await reserveResponseQuota(recoveryInput, db, undefined, { deadlineAt: now + 1000 });
  await markResponseQuotaDispatch(quota.reservation, recoveryInput.fingerprint, { providerCallId: null }, db);
  const root = db.collection('responseQuotaTurns'), template = (await root.doc(quota.reservation.reservationId).get()).data()!;
  await root.doc(quota.reservation.reservationId).delete();
  for (let i = 0; i < 1001; i++) { const id = i.toString(16).padStart(64, '0'); await root.doc(id).set({ ...template, reservationId: id }); }
  const periodRef = db.collection('responseQuotaScopes').doc(quota.reservation.scopeId).collection('periods').doc(quota.reservation.periodId);
  await periodRef.set({ ...(await periodRef.get()).data(), reservedResponses: 1001 });
  vi.setSystemTime(now + 2000);
  let more = true, runs = 0;
  while (more && runs++ < 100) { const batch = await recoverResponseQuotaBatch(db); expect(batch.visited).toBeLessThanOrEqual(50); more = batch.morePending; }
  expect(more).toBe(false); expect(runs).toBeLessThan(100);
  expect((await periodRef.get()).data()).toMatchObject({ usedResponses: 1001, reservedResponses: 0 });
  expect((await db.collection('responseQuotaReceipts').get()).size).toBe(1001);
}, 30000);
