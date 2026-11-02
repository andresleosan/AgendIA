import { expect, it, vi } from 'vitest';
import type { Database } from '@/lib/storage/types';
import { privateBusinessDraft } from '@/lib/server/businesses';
import { reserveResponseQuota, getResponseQuota } from '@/lib/server/response-quota';
import { markResponseQuotaDispatch, prepareQuotaResult, prepareResponseQuotaSettlement, applyResponseQuotaStage, finishResponseQuota } from '@/lib/server/response-quota-store';
import { recoverResponseQuotaBatch } from '@/lib/server/response-quota-recovery';
import { seedQuotaProtocol } from './response-quota-fixtures';
import { reconcileResponseQuota } from '@/lib/server/response-quota-admin';
import { assertConsent, readConsent, updateConsent } from '@/lib/server/consent';
import { acceptSyntheticConsent } from './consent-fixtures';

export const quotaStorageNow = Date.now();
export const quotaStorageInput = { businessId: 'demo-quota-storage', actorUid: 'demo-client', mode: 'sarin_client' as const, channel: 'web' as const, requestId: 'demo-request', fingerprint: 'a'.repeat(64) };
export async function quotaStorageSetup(db: Database) {
  await seedQuotaProtocol(db);
  await db.collection('businesses').doc(quotaStorageInput.businessId).set({ ...privateBusinessDraft({ uid: 'demo-owner' }, quotaStorageNow), id: quotaStorageInput.businessId, slug: quotaStorageInput.businessId, subscription: { status: 'active', trialEndsAt: 0, currentPeriodEndsAt: quotaStorageNow + 86400000 }, sarinConfig: { onboardingCompleted: true, tone: '', customRules: '', intakeFields: [] } });
  return reserveResponseQuota(quotaStorageInput, db, undefined, { deadlineAt: quotaStorageNow + 300000 });
}
export function registerQuotaStorageCases(handles: () => { db: Database; second: Database }) {
  it('lost dispatch acknowledgement never permits the retrying caller to fetch', async () => {
    const { db, second } = handles(), q = await quotaStorageSetup(db), provider = vi.fn();
    const lossy = { collection: db.collection.bind(db), runTransaction: async (handler: Parameters<Database['runTransaction']>[0]) => {
      const result = await db.runTransaction(handler); if (result === 'dispatch_allowed') throw Error('Synthetic lost dispatch acknowledgement'); return result;
    } } as Database;
    const call = async (store: Database) => { if (await markResponseQuotaDispatch(q.reservation, quotaStorageInput.fingerprint, { providerCallId: null }, store) === 'dispatch_allowed') provider(); };
    await expect(call(lossy)).rejects.toThrow('Synthetic lost dispatch acknowledgement'); await call(second);
    expect(provider).not.toHaveBeenCalled();
    await recoverResponseQuotaBatch(second, quotaStorageNow + 600000);
    expect((await getResponseQuota(quotaStorageInput.businessId, second)).currentPeriod?.usedResponses).toBe(1);
  }, 30000);
  it('safe released retry gets a new attempt and the old handle remains fenced', async () => {
    const { db, second } = handles(), q = await quotaStorageSetup(db);
    await finishResponseQuota(q.reservation, false, db);
    const next = await reserveResponseQuota(quotaStorageInput, second, undefined, { deadlineAt: quotaStorageNow + 300000 });
    expect(next.reservation.attemptId).not.toBe(q.reservation.attemptId);
    await expect(markResponseQuotaDispatch(q.reservation, quotaStorageInput.fingerprint, { providerCallId: null }, db)).rejects.toMatchObject({ code: 'AI_REQUEST_CONFLICT' });
    expect((await getResponseQuota(quotaStorageInput.businessId, second)).currentPeriod).toMatchObject({ usedResponses: 0, reservedResponses: 1 });
  }, 30000);
  it('settlement preserves concurrent extra capacity in the exact original period', async () => {
    const { db, second } = handles(), q = await quotaStorageSetup(db);
    await markResponseQuotaDispatch(q.reservation, quotaStorageInput.fingerprint, { providerCallId: null }, db);
    const ref = second.collection('responseQuotaScopes').doc(q.reservation.scopeId).collection('periods').doc(q.reservation.periodId);
    await second.runTransaction(async tx => { const period = (await tx.get(ref)).data()!; tx.set(ref, { ...period, extraResponses: 25 }); });
    await finishResponseQuota(q.reservation, true, db);
    expect((await ref.get()).data()).toMatchObject({ id: q.reservation.periodId, usedResponses: 1, reservedResponses: 0, extraResponses: 25 });
  }, 30000);
  it('legacy unknown stays held by age and audited admin consumption is idempotent', async () => {
    const { db, second } = handles(), q = await quotaStorageSetup(db);
    const ref = db.collection('responseQuotaTurns').doc(q.reservation.reservationId), turn = (await ref.get()).data()!;
    // Represents the conservative form produced by legacy import/discovery.
    await ref.set({ ...turn, execution: { ...turn.execution, origin: 'legacy_unknown', phase: 'interrupted', mayHaveDispatched: true } });
    await recoverResponseQuotaBatch(second, quotaStorageNow + 600000);
    expect((await getResponseQuota(quotaStorageInput.businessId, second)).currentPeriod).toMatchObject({ usedResponses: 0, reservedResponses: 1 });
    vi.stubEnv('SUPERADMIN_UID', 'demo-admin');
    try {
      const input = { requestId: 'demo-review', reservation: q.reservation, expectedFingerprint: quotaStorageInput.fingerprint, resolution: 'consume' as const, reason: 'Synthetic imported attempt', evidenceSha256: 'b'.repeat(64) };
      await reconcileResponseQuota({ uid: 'demo-admin' }, input, db); await reconcileResponseQuota({ uid: 'demo-admin' }, input, second);
      expect((await ref.collection('reviews').get()).size).toBe(1);
      expect((await getResponseQuota(quotaStorageInput.businessId, second)).currentPeriod).toMatchObject({ usedResponses: 1, reservedResponses: 0 });
    } finally { vi.unstubAllEnvs(); }
  }, 30000);
  it('client owner staff and fabricated evidence cannot authorize an unsafe refund', async () => {
    const { db } = handles(), q = await quotaStorageSetup(db);
    await markResponseQuotaDispatch(q.reservation, quotaStorageInput.fingerprint, { providerCallId: null }, db);
    vi.stubEnv('SUPERADMIN_UID', 'demo-admin');
    try {
      const input = { requestId: 'demo-denied-review', reservation: q.reservation, expectedFingerprint: quotaStorageInput.fingerprint, resolution: 'release_undispatched' as const, reason: 'Synthetic asserted no dispatch', evidenceSha256: 'c'.repeat(64) };
      for (const uid of ['demo-client', 'demo-owner', 'demo-staff']) await expect(reconcileResponseQuota({ uid }, input, db)).rejects.toMatchObject({ status: 403 });
      await expect(reconcileResponseQuota({ uid: 'demo-admin' }, input, db)).rejects.toMatchObject({ status: 409 });
      expect((await db.collection('responseQuotaReceipts').get()).size).toBe(0);
    } finally { vi.unstubAllEnvs(); }
  }, 30000);
  it('revoked consent blocks a composed consumer effect while technical settlement remains possible', async () => {
    const { db, second } = handles(), q = await quotaStorageSetup(db);
    await acceptSyntheticConsent(db, quotaStorageInput.actorUid);
    await markResponseQuotaDispatch(q.reservation, quotaStorageInput.fingerprint, { providerCallId: null }, db);
    const consent = await readConsent(quotaStorageInput.actorUid, 'account', undefined, second);
    await updateConsent({ uid: quotaStorageInput.actorUid }, { scope: 'account', action: 'revoke', requestId: 'demo-revoke', expectedRevision: consent.revision }, second);
    await expect(db.runTransaction(async tx => {
      await assertConsent(quotaStorageInput.actorUid, 'account', undefined, db, tx);
      const stage = await prepareQuotaResult(tx, db, { quotaTurnId: q.reservation.reservationId, expectedFingerprint: quotaStorageInput.fingerprint, expectedScopeId: q.reservation.scopeId, reservation: q.reservation }, { kind: 'inbox_operation', id: 'demo-revoked-effect' }, quotaStorageNow);
      tx.create(db.collection('serverSettings').doc('demo-revoked-effect'), { state: 'applied' }); applyResponseQuotaStage(tx, db, stage);
    })).rejects.toMatchObject({ code: 'CONSENT_REQUIRED' });
    await finishResponseQuota(q.reservation, true, second);
    expect((await db.collection('serverSettings').doc('demo-revoked-effect').get()).exists).toBe(false);
    expect((await getResponseQuota(quotaStorageInput.businessId, second)).currentPeriod).toMatchObject({ usedResponses: 1, reservedResponses: 0 });
  }, 30000);
  it('two handles grant one dispatch and replay one settlement without a second unit', async () => {
    const { db, second } = handles(), q = await quotaStorageSetup(db);
    const grants = await Promise.all([db, second].map(store => markResponseQuotaDispatch(q.reservation, quotaStorageInput.fingerprint, { providerCallId: null }, store)));
    expect(grants.filter(value => value === 'dispatch_allowed')).toHaveLength(1);
    await Promise.all([db, second].map(store => finishResponseQuota(q.reservation, true, store)));
    expect((await getResponseQuota(quotaStorageInput.businessId, second)).currentPeriod).toMatchObject({ usedResponses: 1, reservedResponses: 0 });
    expect((await second.collection('responseQuotaReceipts').get()).size).toBe(1);
  }, 30000);
  it('expired prepared closes before dispatch and an old worker cannot publish an effect', async () => {
    const { db, second } = handles(), q = await quotaStorageSetup(db);
    expect((await recoverResponseQuotaBatch(second, quotaStorageNow + 600000)).settled).toBe(1);
    await expect(markResponseQuotaDispatch(q.reservation, quotaStorageInput.fingerprint, { providerCallId: null }, db)).rejects.toMatchObject({ code: 'AI_RESPONSE_INTERRUPTED' });
    const identity = { quotaTurnId: q.reservation.reservationId, expectedFingerprint: quotaStorageInput.fingerprint, expectedScopeId: q.reservation.scopeId, reservation: q.reservation };
    await expect(db.runTransaction(tx => prepareQuotaResult(tx, db, identity, { kind: 'chat_state', id: 'demo-late-state' }, quotaStorageNow))).rejects.toMatchObject({ code: 'AI_RESPONSE_INTERRUPTED' });
    expect((await getResponseQuota(quotaStorageInput.businessId, second)).currentPeriod).toMatchObject({ usedResponses: 0, reservedResponses: 0 });
  }, 30000);
  it('a durable result survives maintenance and composes settlement with an external operation atomically', async () => {
    const { db, second } = handles(), q = await quotaStorageSetup(db);
    await markResponseQuotaDispatch(q.reservation, quotaStorageInput.fingerprint, { providerCallId: null }, db);
    const identity = { quotaTurnId: q.reservation.reservationId, expectedFingerprint: quotaStorageInput.fingerprint, expectedScopeId: q.reservation.scopeId, reservation: q.reservation };
    await db.runTransaction(async tx => {
      const stage = await prepareQuotaResult(tx, db, identity, { kind: 'inbox_operation', id: 'demo-operation' }, quotaStorageNow);
      tx.create(db.collection('serverSettings').doc('demo-operation'), { state: 'applied' }); applyResponseQuotaStage(tx, db, stage);
    });
    await recoverResponseQuotaBatch(second, quotaStorageNow + 600000);
    await db.runTransaction(async tx => {
      const stage = await prepareResponseQuotaSettlement(tx, db, identity, true, { kind: 'application_proof', result: { kind: 'inbox_operation', id: 'demo-operation' } }, quotaStorageNow + 3000);
      expect(stage).toMatchObject({ state: 'committed', writes: [] });
      tx.set(db.collection('serverSettings').doc('demo-operation'), { state: 'replayed' }); applyResponseQuotaStage(tx, db, stage);
    });
    expect((await getResponseQuota(quotaStorageInput.businessId, second)).currentPeriod).toMatchObject({ usedResponses: 1, reservedResponses: 0 });
    expect((await second.collection('responseQuotaReceipts').get()).docs[0].data()).toMatchObject({ execution: { result: { kind: 'inbox_operation', id: 'demo-operation' } } });
  }, 30000);
  it('absence is pending, nullable identity adopts the saved attempt, and corrupt counters never refund', async () => {
    const { db } = handles(), q = await quotaStorageSetup(db);
    const identity = { quotaTurnId: q.reservation.reservationId, expectedFingerprint: quotaStorageInput.fingerprint, expectedScopeId: q.reservation.scopeId, reservation: null };
    await db.runTransaction(async tx => {
      const absent = await prepareResponseQuotaSettlement(tx, db, { ...identity, quotaTurnId: 'f'.repeat(64) }, false, { kind: 'prepared_fenced', expectedFenceRevision: 0 }, quotaStorageNow);
      expect(absent).toEqual({ state: 'pending', writes: [] });
      const found = await prepareResponseQuotaSettlement(tx, db, identity, false, { kind: 'prepared_fenced', expectedFenceRevision: 0 }, quotaStorageNow);
      expect(found.state).toBe('released'); expect(found.writes).toHaveLength(3);
    });
    const ref = db.collection('responseQuotaScopes').doc(q.reservation.scopeId).collection('periods').doc(q.reservation.periodId);
    await ref.set({ ...(await ref.get()).data(), reservedResponses: -1 });
    await expect(recoverResponseQuotaBatch(db, quotaStorageNow + 600000)).rejects.toMatchObject({ code: 'AI_QUOTA_INVALID' });
    expect((await ref.get()).data()?.reservedResponses).toBe(-1);
    expect((await db.collection('responseQuotaReceipts').get()).size).toBe(0);
  }, 30000);
}
