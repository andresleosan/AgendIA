import { expect, it, vi } from 'vitest';
import type { Database } from '@/lib/storage/types';
import { privateBusinessDraft } from '@/lib/server/businesses';
import { readBookingDataPolicy, bookingDataPolicyKey, saveBookingDataPolicy } from '@/lib/server/booking-data-policy';
import { readBookingAdmission, assertBookingAdmission, ensureBookingAdmissionProtocol } from '@/lib/server/booking-admission';
import { bookingDispatchHeadKey } from '@/lib/server/booking-admission';
import { beginBookingPolicyTransition, resumeBookingPolicyTransition, withBookingDispatch, prepareBookingDispatchRegistration, finishBookingDispatch } from '@/lib/server/booking-policy-transition';

export const admissionBusinessId = 'demo-admission';
export const admissionPolicy = { version: 2, businessId: admissionBusinessId, revision: 2, dataMode: 'general', representedMinorsEnabled: false, status: 'active', origin: 'owner', updatedBy: 'demo-owner', updatedAt: 1, reason: 'PRIVATE_REASON', declaration: { ownerUid: 'demo-owner', textVersion: 'demo-text-v1', receiptId: 'demo-receipt' } } as const;
export function registerBookingTransitionCases(handles: () => { db: Database; second: Database }) {
  const setup = async () => {
    const { db, second } = handles();
    await db.collection('businesses').doc(admissionBusinessId).set({ ...privateBusinessDraft({ uid: 'demo-owner' }, 1), id: admissionBusinessId });
    await ensureBookingAdmissionProtocol(db, 'a'.repeat(40), 'enforce');
    await db.collection('serverSettings').doc(bookingDataPolicyKey(admissionBusinessId)).set(admissionPolicy);
    const { businessId: _id, revision: _revision, updatedAt: _time, updatedBy: _by, version: _v, ...target } = admissionPolicy;
    const command = { businessId: admissionBusinessId, requestId: 'demo-withdraw', expectedRevision: 2, action: 'withdraw' as const, target: { ...target, status: 'withdrawn' as const } };
    return { db, second, command };
  };
  it('closes queued and new dispatches while an already registered transport resolves', async () => {
    const { db, command } = await setup();
    let registered!: () => void, complete!: () => void;
    const ready = new Promise<void>(resolve => { registered = resolve; }), transport = new Promise<void>(resolve => { complete = resolve; });
    const identity = { kind: 'quota' as const, id: 'demo-in-flight' };
    let sends = 0;
    const active = withBookingDispatch({ businessId: admissionBusinessId, operation: 'inference', identity, db, release: 'enforce' }, async (startTransport, resolveTransport) => {
      await db.runTransaction(async tx => { const write = await prepareBookingDispatchRegistration(tx, db, admissionBusinessId, identity, 'enforce'); write(); });
      startTransport(); sends++; registered(); await transport; resolveTransport(); return 'synthetic result';
    });
    await ready;
    const queued = withBookingDispatch({ businessId: admissionBusinessId, operation: 'inference', identity: { kind: 'quota', id: 'demo-queued' }, db, release: 'enforce' }, async () => { sends++; });
    const denied = expect(queued).rejects.toMatchObject({ code: 'BOOKING_POLICY_TRANSITIONING' });
    expect(await beginBookingPolicyTransition({ uid: 'demo-owner' }, command, db, 'enforce')).toMatchObject({ outcome: 'pending' });
    expect((await db.collection('serverSettings').doc(bookingDataPolicyKey(admissionBusinessId)).get()).data()).toMatchObject({ revision: 3, status: 'transitioning', transition: { dispatchRefs: [identity] } });
    complete(); expect(await active).toBe('synthetic result'); await denied;
    expect(sends).toBe(1);
    expect(await resumeBookingPolicyTransition({ uid: 'demo-owner' }, admissionBusinessId, command.requestId, db, 'enforce')).toMatchObject({ outcome: 'applied', capability: { admission: 'withdrawn', revision: 3 } });
    expect(await beginBookingPolicyTransition({ uid: 'demo-owner' }, command, db, 'enforce')).toMatchObject({ outcome: 'applied', capability: { admission: 'withdrawn', revision: 3 } });
    await expect(beginBookingPolicyTransition({ uid: 'demo-owner' }, { ...command, expectedRevision: 3 }, db, 'enforce')).rejects.toMatchObject({ code: 'BOOKING_POLICY_CONFLICT' });
  });
  it('the cut cannot enter durable transition between registration and the exact fetch invocation', async () => {
    const { db, command } = await setup();
    let registered!: () => void, allowFetch!: () => void, finish!: () => void;
    const ready = new Promise<void>(resolve => { registered = resolve; }), prefetch = new Promise<void>(resolve => { allowFetch = resolve; }), response = new Promise<void>(resolve => { finish = resolve; });
    let sends = 0;
    const identity = { kind: 'quota' as const, id: 'demo-exact-fetch' };
    const active = withBookingDispatch({ businessId: admissionBusinessId, operation: 'inference', identity, db, release: 'enforce' }, async (startTransport, resolveTransport) => {
      await db.runTransaction(async tx => { const write = await prepareBookingDispatchRegistration(tx, db, admissionBusinessId, identity, 'enforce'); write(); });
      registered(); await prefetch; startTransport(); sends++; await response; resolveTransport();
    });
    await ready;
    const commandDb: Database = { collection: name => db.collection(name), runTransaction: (handler, options) => {
      expect(sends, 'transition must wait for the pre-fetch critical section, without waiting for response').toBe(1);
      return db.runTransaction(handler, options);
    } };
    const change = beginBookingPolicyTransition({ uid: 'demo-owner' }, command, commandDb, 'enforce');
    // Observe a rejection immediately as well, so the RED run has no unhandled promise.
    const outcome = change.then(value => ({ value }), error => ({ error }));
    allowFetch();
    try { expect(await outcome).toMatchObject({ value: { outcome: 'pending' } }); }
    finally { finish(); await active; }
    expect(await resumeBookingPolicyTransition({ uid: 'demo-owner' }, admissionBusinessId, command.requestId, db, 'enforce')).toMatchObject({ outcome: 'applied' });
  });
  it('restart discovers uncertain heads even with completed quota and never infers resolution from TTL', async () => {
    const { db, second, command } = await setup();
    const identity = { kind: 'quota' as const, id: 'f'.repeat(64) };
    await expect(withBookingDispatch({ businessId: admissionBusinessId, operation: 'inference', identity, db, release: 'enforce' }, async () => {
      await db.runTransaction(async tx => { const write = await prepareBookingDispatchRegistration(tx, db, admissionBusinessId, identity, 'enforce'); write(); });
      throw new Error('synthetic lost response');
    })).rejects.toThrow('synthetic lost response');
    await db.collection('responseQuotaTurns').doc(identity.id).set({ reservationId: identity.id, scopeId: `business_${admissionBusinessId}`, periodId: 'demo-period', attemptId: '11111111-1111-4111-8111-111111111111', fingerprint: 'a'.repeat(64), status: 'completed', startedAt: 0, finishedAt: 1, mode: 'sarin_client', channel: 'web', execution: { protocol: 2, origin: 'v2', phase: 'interrupted', mayHaveDispatched: true, fenceRevision: 1, deadlineAt: 0, providerCallId: null, result: null } });
    vi.resetModules(); const reopened = await import('@/lib/server/booking-policy-transition');
    expect(await reopened.beginBookingPolicyTransition({ uid: 'demo-owner' }, command, second, 'enforce')).toMatchObject({ outcome: 'pending' });
    expect(await reopened.resumeBookingPolicyTransition({ uid: 'demo-owner' }, admissionBusinessId, command.requestId, second, 'enforce')).toMatchObject({ outcome: 'pending' });
    const head = await second.collection('serverSettings').doc(bookingDispatchHeadKey(admissionBusinessId)).get();
    expect(head.data()?.refs).toMatchObject([identity]);
    await db.collection('serverSettings').doc(bookingDispatchHeadKey(admissionBusinessId)).delete();
    await expect(reopened.resumeBookingPolicyTransition({ uid: 'demo-owner' }, admissionBusinessId, command.requestId, second, 'enforce')).rejects.toMatchObject({ code: 'BOOKING_POLICY_UNAVAILABLE' });
  });
  it('prepare, unauthorized actors and stale revisions never create transitions', async () => {
    const { db, second, command } = await setup();
    await expect(beginBookingPolicyTransition({ uid: 'demo-owner' }, command, db)).rejects.toMatchObject({ code: 'BOOKING_POLICY_UNAVAILABLE' });
    await expect(beginBookingPolicyTransition({ uid: 'demo-other' }, command, db, 'enforce')).rejects.toMatchObject({ status: 403 });
    await expect(beginBookingPolicyTransition({ uid: 'demo-owner' }, { ...command, expectedRevision: 1 }, db, 'enforce')).rejects.toMatchObject({ code: 'BOOKING_POLICY_CONFLICT' });
    expect((await second.collection('serverSettings').doc(bookingDataPolicyKey(admissionBusinessId)).get()).data()).toEqual(admissionPolicy);
    expect((await db.collection('serverSettings').get()).docs.filter(d => d.id.startsWith('booking_policy_operation_'))).toHaveLength(0);
  });
  it('a full head refuses the next dispatch before its dependent marker is written', async () => {
    const { db } = await setup();
    await db.collection('serverSettings').doc(bookingDispatchHeadKey(admissionBusinessId)).set({ version: 1, businessId: admissionBusinessId, revision: 64, refs: Array.from({ length: 64 }, (_, i) => ({ kind: 'quota', id: `demo-pending-${i}`, policyRevision: 2, startedAt: 0 })) });
    await expect(db.runTransaction(async tx => {
      const register = await prepareBookingDispatchRegistration(tx, db, admissionBusinessId, { kind: 'quota', id: 'demo-overflow' }, 'enforce');
      tx.set(db.collection('serverSettings').doc('demo-dependent-marker'), { dispatched: true }); register();
    })).rejects.toMatchObject({ code: 'BOOKING_DISPATCH_FULL' });
    expect((await db.collection('serverSettings').doc('demo-dependent-marker').get()).exists).toBe(false);
    expect((await db.collection('serverSettings').doc(bookingDispatchHeadKey(admissionBusinessId)).get()).data()?.refs).toHaveLength(64);
  });
  it('an old finalizer cannot overwrite a later administrative suspension or new owner', async () => {
    const { db, second, command } = await setup();
    await db.runTransaction(async tx => { const write = await prepareBookingDispatchRegistration(tx, db, admissionBusinessId, { kind: 'whatsapp', id: 'demo-outbound' }, 'enforce'); write(); });
    expect(await beginBookingPolicyTransition({ uid: 'demo-owner' }, command, db, 'enforce')).toMatchObject({ outcome: 'pending' });
    const suspended = { ...admissionPolicy, origin: 'admin', status: 'suspended', revision: 4 };
    await second.collection('serverSettings').doc(bookingDataPolicyKey(admissionBusinessId)).set(suspended);
    await expect(resumeBookingPolicyTransition({ uid: 'demo-owner' }, admissionBusinessId, command.requestId, db, 'enforce')).rejects.toMatchObject({ code: 'BOOKING_POLICY_CONFLICT' });
    expect((await second.collection('serverSettings').doc(bookingDataPolicyKey(admissionBusinessId)).get()).data()).toEqual(suspended);
    await second.collection('businesses').doc(admissionBusinessId).set({ ...privateBusinessDraft({ uid: 'demo-new-owner' }, 1), id: admissionBusinessId });
    await expect(resumeBookingPolicyTransition({ uid: 'demo-owner' }, admissionBusinessId, command.requestId, db, 'enforce')).rejects.toMatchObject({ status: 403 });
  });
  it('administrative suspension supersedes an in-flight withdrawal through the same barrier', async () => {
    const { db, second, command } = await setup(); vi.stubEnv('SUPERADMIN_UID', 'demo-admin');
    try {
      const identity = { kind: 'whatsapp' as const, id: 'demo-outbound' };
      await db.runTransaction(async tx => { const write = await prepareBookingDispatchRegistration(tx, db, admissionBusinessId, identity, 'enforce'); write(); });
      expect(await beginBookingPolicyTransition({ uid: 'demo-owner' }, command, db, 'enforce')).toMatchObject({ outcome: 'pending' });
      expect(await beginBookingPolicyTransition({ uid: 'demo-admin' }, { ...command, action: 'suspend', requestId: 'demo-admin-suspend', expectedRevision: 3, target: { ...command.target, origin: 'admin', status: 'suspended' } }, second, 'enforce')).toMatchObject({ outcome: 'pending' });
      await second.runTransaction(tx => finishBookingDispatch(tx, second, admissionBusinessId, identity, 'transport_resolved'));
      await expect(resumeBookingPolicyTransition({ uid: 'demo-owner' }, admissionBusinessId, command.requestId, db, 'enforce')).rejects.toMatchObject({ code: 'BOOKING_POLICY_CONFLICT' });
      expect(await resumeBookingPolicyTransition({ uid: 'demo-admin' }, admissionBusinessId, 'demo-admin-suspend', second, 'enforce')).toMatchObject({ outcome: 'applied', capability: { admission: 'administrative_review', revision: 4 } });
    } finally { vi.unstubAllEnvs(); }
  });
}
export function registerBookingAdmissionCases(handles: () => { db: Database; second: Database }) {
  const setup = async () => {
    const { db, second } = handles(); const business = { ...privateBusinessDraft({ uid: 'demo-owner' }, 1), id: admissionBusinessId };
    await db.collection('businesses').doc(business.id).set(business);
    return { db, second, business, policy: db.collection('serverSettings').doc(bookingDataPolicyKey(business.id)) };
  };
  it('prepare preserves absence; enforce requires its durable protocol', async () => {
    const { db, business } = await setup();
    expect(await readBookingAdmission(business.id, db)).toMatchObject({ admission: 'active', configured: false });
    await expect(readBookingAdmission(business.id, db, undefined, 'enforce')).rejects.toMatchObject({ status: 503 });
    await ensureBookingAdmissionProtocol(db, 'a'.repeat(40), 'enforce');
    expect(await readBookingAdmission(business.id, db, undefined, 'enforce')).toMatchObject({ admission: 'classification_required', canStartBooking: false });
    await expect(db.runTransaction(tx => assertBookingAdmission(tx, { ...business, ownerUid: 'forged' }, 'appointment', db, 'enforce'))).rejects.toMatchObject({ code: 'BOOKING_CLASSIFICATION_REQUIRED' });
    await expect(readBookingAdmission(business.id, db)).rejects.toMatchObject({ status: 503 });
  });
  it('normalizes legacy without rewriting and observes owner changes through a reopened handle', async () => {
    const { db, second, business, policy } = await setup();
    const legacy = { version: 1, businessId: business.id, revision: 1, dataMode: 'general', representedMinorsEnabled: false, updatedAt: 1, updatedBy: 'demo-admin', reason: 'PRIVATE' };
    await policy.set(legacy);
    expect(await readBookingAdmission(business.id, second)).toMatchObject({ admission: 'active', revision: 1 });
    expect((await policy.get()).data()).toEqual(legacy);
    await policy.set(admissionPolicy);
    expect(await db.runTransaction(tx => assertBookingAdmission(tx, { ...business, ownerUid: 'forged' }, 'inference', db))).toMatchObject({ canUseInference: true });
    await second.collection('businesses').doc(business.id).set({ ...business, ownerUid: 'demo-new-owner' });
    await expect(db.runTransaction(tx => assertBookingAdmission(tx, business, 'appointment', db))).rejects.toMatchObject({ code: 'BOOKING_CLASSIFICATION_REQUIRED' });
    expect((await policy.get()).data()).toEqual(admissionPolicy);
  });
  it('the preparatory admin writer cannot overwrite or reopen a v2 restriction', async () => {
    const { db, business, policy } = await setup();
    vi.stubEnv('SUPERADMIN_UID', 'demo-admin');
    try {
      const suspended = { ...admissionPolicy, status: 'suspended', origin: 'admin' };
      await policy.set(suspended);
      await expect(saveBookingDataPolicy({ uid: 'demo-admin' }, { businessId: business.id, expectedRevision: 2, dataMode: 'general', representedMinorsEnabled: false, reason: 'Demo' }, db)).rejects.toMatchObject({ code: 'BOOKING_POLICY_UNAVAILABLE' });
      expect((await policy.get()).data()).toEqual(suspended);
    } finally { vi.unstubAllEnvs(); }
  });
  it('restricted and corrupt policies never fall back; private projection has no notes', async () => {
    const { db, second, business, policy } = await setup();
    for (const [status, code] of [['withdrawn', 'BOOKING_DECLARATION_WITHDRAWN'], ['suspended', 'BOOKING_ADMIN_REVIEW_REQUIRED']] as const) {
      await policy.set({ ...admissionPolicy, status, ...(status === 'suspended' ? { origin: 'admin' } : {}) });
      await expect(db.runTransaction(tx => assertBookingAdmission(tx, business, 'appointment', db))).rejects.toMatchObject({ code });
      const view = await readBookingDataPolicy(business.id, second);
      expect(JSON.stringify(view.capability)).not.toMatch(/PRIVATE|demo-owner|receipt|textVersion/);
    }
    await policy.set({ ...admissionPolicy, status: 'transitioning', transition: { requestId: 'demo-request', targetRevision: 2, target: { status: 'withdrawn', origin: 'owner', dataMode: 'general', representedMinorsEnabled: false, declaration: admissionPolicy.declaration, reason: 'PRIVATE' }, startedAt: 1, dispatchRefs: [] } });
    await expect(db.runTransaction(tx => assertBookingAdmission(tx, business, 'appointment', db))).rejects.toMatchObject({ code: 'BOOKING_POLICY_TRANSITIONING' });
    for (const data of [{ ...admissionPolicy, version: 9 }, { ...admissionPolicy, businessId: 'demo-other' }, { broken: true }]) {
      await policy.set(data);
      await expect(readBookingAdmission(business.id, second)).rejects.toMatchObject({ status: 503, code: 'BOOKING_POLICY_UNAVAILABLE' });
    }
  });
  it('health supports structured bookings and rejects inference without writes', async () => {
    const { db, business, policy } = await setup();
    await policy.set({ ...admissionPolicy, origin: 'admin', declaration: null, dataMode: 'health' });
    expect(await db.runTransaction(tx => assertBookingAdmission(tx, business, 'appointment', db))).toMatchObject({ canStartBooking: true, canUseInference: false });
    await expect(db.runTransaction(tx => assertBookingAdmission(tx, business, 'inference', db))).rejects.toMatchObject({ code: 'STRUCTURED_BOOKING_REQUIRED' });
    expect((await db.collection('responseQuotaTurns').get()).size).toBe(0);
  });
  it('protocol creation is enforce-only, idempotent and never replaces an existing marker', async () => {
    const { db, second } = await setup();
    await expect(ensureBookingAdmissionProtocol(db, 'a'.repeat(40))).rejects.toMatchObject({ status: 503 });
    await Promise.all([ensureBookingAdmissionProtocol(db, 'a'.repeat(40), 'enforce'), ensureBookingAdmissionProtocol(second, 'b'.repeat(40), 'enforce')]);
    const ref = db.collection('serverSettings').doc('bookingAdmissionProtocol'), before = (await ref.get()).data();
    expect(before).toMatchObject({ minimumReader: 2 });
    await ensureBookingAdmissionProtocol(second, 'c'.repeat(40), 'enforce');
    expect((await ref.get()).data()).toEqual(before);
    await expect(ensureBookingAdmissionProtocol(db, 'invalid', 'enforce')).rejects.toThrow();
  });
}
