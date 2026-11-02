import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { memoryFirestore } from './memoryFirestore';
import { quotaProtocolEntries } from './response-quota-fixtures';
import { privateBusinessDraft } from '@/lib/server/businesses';
import { reserveResponseQuota, getResponseQuota } from '@/lib/server/response-quota';
import { markResponseQuotaDispatch } from '@/lib/server/response-quota-store';
import { reconcileResponseQuota } from '@/lib/server/response-quota-admin';
beforeEach(() => vi.stubEnv('SUPERADMIN_UID', 'demo-admin'));
afterEach(() => vi.unstubAllEnvs());
async function setup() {
  const now = Date.now(), business = { ...privateBusinessDraft({ uid: 'demo-owner' }, now), id: 'demo-admin-quota', slug: 'demo-admin-quota', subscription: { status: 'active', trialEndsAt: 0, currentPeriodEndsAt: now + 86400000 }, sarinConfig: { onboardingCompleted: true, tone: '', customRules: '', intakeFields: [] } };
  const { db } = memoryFirestore({ ...quotaProtocolEntries, [`businesses/${business.id}`]: business });
  const request = { businessId: business.id, actorUid: 'demo-client', mode: 'sarin_client' as const, channel: 'web' as const, requestId: 'demo-admin', fingerprint: 'a'.repeat(64) };
  const quota = await reserveResponseQuota(request, db, undefined, { deadlineAt: now + 300000 });
  const input = { requestId: 'demo-review', reservation: quota.reservation, expectedFingerprint: request.fingerprint, resolution: 'consume' as const, reason: 'Synthetic review', evidenceSha256: 'b'.repeat(64) };
  return { db, quota, request, input };
}
it('adminCannotInventNoDispatchAfterMarker', async () => {
  const { db, quota, request, input } = await setup();
  await markResponseQuotaDispatch(quota.reservation, request.fingerprint, { providerCallId: null }, db);
  await expect(reconcileResponseQuota({ uid: 'demo-admin' }, { ...input, resolution: 'release_undispatched' }, db)).rejects.toMatchObject({ status: 409 });
  expect((await getResponseQuota(request.businessId, db)).currentPeriod).toMatchObject({ usedResponses: 0, reservedResponses: 1 });
});
it('adminReplayAndConflictingBody', async () => {
  const { db, quota, request, input } = await setup();
  await markResponseQuotaDispatch(quota.reservation, request.fingerprint, { providerCallId: null }, db);
  await reconcileResponseQuota({ uid: 'demo-admin' }, input, db);
  await reconcileResponseQuota({ uid: 'demo-admin' }, input, db);
  await expect(reconcileResponseQuota({ uid: 'demo-admin' }, { ...input, reason: 'different' }, db)).rejects.toMatchObject({ status: 409 });
  expect((await db.collection('responseQuotaTurns').doc(quota.reservation.reservationId).collection('reviews').get()).size).toBe(1);
  expect((await getResponseQuota(request.businessId, db)).currentPeriod?.usedResponses).toBe(1);
});
it.each(['demo-client', 'demo-owner', 'demo-staff'])('nonadminCannotReconcile: %s', async uid => {
  const { db, input } = await setup(); await expect(reconcileResponseQuota({ uid }, input, db)).rejects.toMatchObject({ status: 403 });
});
