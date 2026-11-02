import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { memoryFirestore } from './memoryFirestore';
import { quotaProtocolEntries } from './response-quota-fixtures';
import { privateBusinessDraft } from '@/lib/server/businesses';
import { reserveResponseQuota, getResponseQuota, responseQuotaIdentity, releaseResponseQuota, commitResponseQuota } from '@/lib/server/response-quota';
import { markResponseQuotaDispatch, readQuotaIdentity, prepareResponseQuotaSettlement, applyResponseQuotaStage, prepareQuotaResult } from '@/lib/server/response-quota-store';

const now = Date.parse('2030-01-01T12:00:00Z');
const business = { ...privateBusinessDraft({ uid: 'demo-owner' }, now), id: 'demo-quota', slug: 'demo-quota', subscription: { status: 'active', trialEndsAt: 0, currentPeriodEndsAt: now + 86400000 }, sarinConfig: { onboardingCompleted: true, tone: '', customRules: '', intakeFields: [] } };
const input = { businessId: business.id, actorUid: 'demo-client', mode: 'sarin_client' as const, channel: 'web' as const, requestId: 'demo-request', fingerprint: 'a'.repeat(64) };
export function quotaScenario() { return memoryFirestore({ ...quotaProtocolEntries, [`businesses/${business.id}`]: business }); }
const reserve = (db: ReturnType<typeof quotaScenario>['db'], extra = {}) => reserveResponseQuota({ ...input, ...extra }, db, undefined, { deadlineAt: now + 300000 });
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(now); });
afterEach(() => vi.useRealTimers());

it('twoHandlesDispatchOnlyOneWinner', async () => {
  const { db } = quotaScenario(), first = await reserve(db);
  const result = await Promise.all([markResponseQuotaDispatch(first.reservation, input.fingerprint, { providerCallId: null }, db), markResponseQuotaDispatch(first.reservation, input.fingerprint, { providerCallId: null }, db)]);
  expect(result.filter(value => value === 'dispatch_allowed')).toHaveLength(1);
  await expect(releaseResponseQuota(first.reservation, db)).rejects.toMatchObject({ status: 409 });
  await commitResponseQuota(first.reservation, undefined, db);
  await commitResponseQuota(first.reservation, undefined, db);
  expect((await getResponseQuota(business.id, db)).currentPeriod).toMatchObject({ usedResponses: 1, reservedResponses: 0 });
});
it('lostReserveAckAdoptsExactAttempt', async () => {
  const { db } = quotaScenario(), first = await reserve(db), identity = { ...responseQuotaIdentity(input), reservation: null };
  const recovered = await db.runTransaction(tx => readQuotaIdentity(tx, db, identity));
  expect(recovered?.reservation).toEqual(first.reservation);
  await expect(db.runTransaction(tx => readQuotaIdentity(tx, db, { ...identity, expectedFingerprint: 'b'.repeat(64) }))).rejects.toMatchObject({ status: 409 });
});
it('releasedSafeRetryRejectsOldHandle', async () => {
  const { db } = quotaScenario(), first = await reserve(db);
  await releaseResponseQuota(first.reservation, db);
  const second = await reserve(db);
  expect(second.reservation.attemptId).not.toBe(first.reservation.attemptId);
  await expect(markResponseQuotaDispatch(first.reservation, input.fingerprint, { providerCallId: null }, db)).rejects.toMatchObject({ status: 409 });
});
it.each([true, false])('terminal reserve validates its durable receipt before replay or retry (%s)', async completion => {
  const { db } = quotaScenario(), first = await reserve(db);
  if (completion) { await markResponseQuotaDispatch(first.reservation, input.fingerprint, { providerCallId: null }, db); await commitResponseQuota(first.reservation, undefined, db); }
  else await releaseResponseQuota(first.reservation, db);
  const receipts = (await db.collection('responseQuotaReceipts').get()).docs;
  if (completion) await db.collection('responseQuotaReceipts').doc(receipts[0].id).delete();
  else await db.collection('responseQuotaReceipts').doc(receipts[0].id).set({ ...receipts[0].data(), attemptId: crypto.randomUUID() });
  await expect(reserve(db)).rejects.toBeDefined();
  expect((await getResponseQuota(business.id, db)).currentPeriod).toMatchObject({ usedResponses: Number(completion), reservedResponses: 0 });
});
it('legacyReleasedIsFrozenWithoutRetrocharge', async () => {
  const { db, rows } = quotaScenario(), first = await reserve(db);
  await releaseResponseQuota(first.reservation, db);
  const ref = db.collection('responseQuotaTurns').doc(first.reservation.reservationId), saved = (await ref.get()).data()!;
  const { execution: _execution, nextAttemptAt: _next, outcome: _outcome, ...legacy } = saved;
  await ref.set(legacy);
  const snapshot = structuredClone(rows);
  await expect(reserve(db)).rejects.toMatchObject({ code: 'AI_RESPONSE_INTERRUPTED' });
  expect(rows).toEqual(snapshot);
});
it('periodChangeSettlesOriginalPeriod', async () => {
  const { db } = quotaScenario(), first = await reserve(db);
  await markResponseQuotaDispatch(first.reservation, input.fingerprint, { providerCallId: null }, db);
  const root = db.collection('responseQuotaScopes').doc(first.reservation.scopeId);
  await root.collection('periods').doc('new').set({ id: 'new', source: 'subscription', planId: 'monthly', startsAt: now + 1, endsAt: now + 86400000, includedResponses: 3000, extraResponses: 0, usedResponses: 0, reservedResponses: 0 });
  vi.setSystemTime(now + 1000);
  await commitResponseQuota(first.reservation, undefined, db);
  expect((await root.collection('periods').doc('initial').get()).data()).toMatchObject({ usedResponses: 1, reservedResponses: 0 });
  expect((await root.collection('periods').doc('new').get()).data()).toMatchObject({ usedResponses: 0, reservedResponses: 0 });
});
it('missingPeriodFailsWithoutNewAllowance', async () => {
  const { db } = quotaScenario(), first = await reserve(db);
  await db.collection('responseQuotaScopes').doc(first.reservation.scopeId).collection('periods').doc(first.reservation.periodId).delete();
  await expect(releaseResponseQuota(first.reservation, db)).rejects.toMatchObject({ status: 503 });
});
it('markerIsRequiredForNewAttemptsButNotQuotaReads', async () => {
  const { db } = memoryFirestore({ [`businesses/${business.id}`]: business });
  expect((await getResponseQuota(business.id, db)).currentPeriod?.remainingResponses).toBe(3000);
  await expect(reserve(db)).rejects.toMatchObject({ code: 'AI_QUOTA_PROTOCOL_NOT_READY' });
});
it('resultAndSettlementStagesWriteOnlyWhenApplied', async () => {
  const { db, rows } = quotaScenario(), first = await reserve(db), identity = { ...responseQuotaIdentity(input), reservation: first.reservation };
  await markResponseQuotaDispatch(first.reservation, input.fingerprint, { providerCallId: null }, db);
  const before = structuredClone(rows);
  await db.runTransaction(async tx => { await prepareQuotaResult(tx, db, identity, { kind: 'proposal', id: 'demo-proof' }, now); });
  expect(rows).toEqual(before);
  await db.runTransaction(async tx => { const stage = await prepareQuotaResult(tx, db, identity, { kind: 'proposal', id: 'demo-proof' }, now); applyResponseQuotaStage(tx, db, stage); });
  await db.runTransaction(async tx => { const stage = await prepareResponseQuotaSettlement(tx, db, identity, true, { kind: 'application_proof', result: { kind: 'proposal', id: 'demo-proof' } }, now); applyResponseQuotaStage(tx, db, stage); });
  expect((await getResponseQuota(business.id, db)).currentPeriod?.usedResponses).toBe(1);
});
it('absentReadAloneIsNotSettlementNone', async () => {
  const { db } = quotaScenario();
  const stage = await db.runTransaction(tx => prepareResponseQuotaSettlement(tx, db, { ...responseQuotaIdentity(input), reservation: null }, true, { kind: 'dispatch_possible' }, now));
  expect(stage).toEqual({ state: 'pending', writes: [] });
});
