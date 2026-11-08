import { expect, it, vi } from 'vitest';
import type { Database } from '@/lib/storage/types';
import { executeAdminBookingPolicy, executeOwnerBookingDeclaration, readOwnerBookingDeclaration } from '@/lib/server/booking-policy-commands';
import { BOOKING_DECLARATION_TEXT_VERSION } from '@/lib/booking-declaration';
import { ensureBookingAdmissionProtocol, bookingPolicyOperationKey } from '@/lib/server/booking-admission';
import { bookingDataPolicyKey } from '@/lib/server/booking-data-policy';
import { privateBusinessDraft } from '@/lib/server/businesses';

const id = 'demo-command-business', owner = { uid: 'demo-owner' };
const declare = { action: 'declare', requestId: 'demo-declaration', expectedRevision: 0, textVersion: BOOKING_DECLARATION_TEXT_VERSION } as const;
const admin = { businessId: id, action: 'suspend' as const, requestId: 'demo-suspension', expectedRevision: 1, dataMode: 'general' as const, representedMinorsEnabled: false, reason: 'PRIVATE_ADMIN_REASON' };

export function registerBookingPolicyCommandCases(handles: () => { db: Database; second: Database }) {
  const setup = async () => {
    const { db, second } = handles();
    await db.collection('businesses').doc(id).set({ ...privateBusinessDraft(owner, 1), id });
    await ensureBookingAdmissionProtocol(db, 'a'.repeat(40), 'enforce');
    return { db, second, policy: db.collection('serverSettings').doc(bookingDataPolicyKey(id)) };
  };
  it('owner_can_declare_general_adults with a single revision and atomic private receipt', async () => {
    const { db, policy } = await setup();
    expect(await executeOwnerBookingDeclaration(owner, id, declare, db, 'enforce')).toMatchObject({ outcome: 'applied', origin: 'owner', capability: { admission: 'active', revision: 1 }, declaration: { textVersion: BOOKING_DECLARATION_TEXT_VERSION }, operation: { phase: 'applied', requestId: declare.requestId } });
    expect((await policy.get()).data()).toMatchObject({ version: 2, revision: 1, status: 'active', updatedBy: owner.uid, declaration: { ownerUid: owner.uid } });
    expect((await db.collection('serverSettings').doc(bookingPolicyOperationKey(id, owner.uid, declare.requestId)).get()).data()).toMatchObject({ phase: 'applied', previousRevision: 0, targetRevision: 1 });
    const view = await readOwnerBookingDeclaration(owner, id, db, 'enforce');
    expect(JSON.stringify(view)).not.toMatch(/ownerUid|updatedBy|operationHash|actorUid|reason/);
  });
  it('no_session_employee_foreign_owner_denied including a superadmin who is not owner', async () => {
    const { db, policy } = await setup(); vi.stubEnv('SUPERADMIN_UID', 'demo-admin');
    try {
      for (const uid of ['', 'demo-employee', 'demo-foreign', 'demo-admin']) {
        await expect(executeOwnerBookingDeclaration({ uid }, id, declare, db, 'enforce')).rejects.toMatchObject({ status: 403 });
        await expect(readOwnerBookingDeclaration({ uid }, id, db, 'enforce')).rejects.toMatchObject({ status: 403 });
        await expect(executeAdminBookingPolicy({ uid: 'demo-owner' }, admin, db, 'enforce')).rejects.toMatchObject({ status: 403 });
      }
      expect((await policy.get()).exists).toBe(false);
    } finally { vi.unstubAllEnvs(); }
  });
  it('same_request_after_withdraw_does_not_reopen and different body conflicts', async () => {
    const { db, policy } = await setup();
    await executeOwnerBookingDeclaration(owner, id, declare, db, 'enforce');
    const withdraw = { action: 'withdraw' as const, requestId: 'demo-withdraw', expectedRevision: 1 };
    await executeOwnerBookingDeclaration(owner, id, withdraw, db, 'enforce');
    expect(await executeOwnerBookingDeclaration(owner, id, declare, db, 'enforce')).toMatchObject({ outcome: 'applied', capability: { admission: 'withdrawn', revision: 2 }, operation: { targetRevision: 1 } });
    await expect(executeOwnerBookingDeclaration(owner, id, { ...declare, expectedRevision: 2 }, db, 'enforce')).rejects.toMatchObject({ code: 'BOOKING_POLICY_CONFLICT' });
    await executeOwnerBookingDeclaration(owner, id, { ...declare, requestId: 'demo-declare-again', expectedRevision: 2 }, db, 'enforce');
    expect(await executeOwnerBookingDeclaration(owner, id, withdraw, db, 'enforce')).toMatchObject({ capability: { admission: 'active', revision: 3 }, operation: { targetRevision: 2 } });
    expect((await policy.get()).data()?.revision).toBe(3);
  });
  it('withdraw_with_incompatible_intake closes admission and preserves business data', async () => {
    const { db, policy } = await setup();
    await executeOwnerBookingDeclaration(owner, id, declare, db, 'enforce');
    const ref = db.collection('businesses').doc(id), business = (await ref.get()).data()!;
    await ref.set({ ...business, sarinConfig: { ...business.sarinConfig, intakeFields: [{ id: 'demo-field', label: 'Synthetic' }] } });
    expect(await executeOwnerBookingDeclaration(owner, id, { action: 'withdraw', requestId: 'demo-withdraw', expectedRevision: 1 }, db, 'enforce')).toMatchObject({ outcome: 'applied', capability: { admission: 'withdrawn' } });
    expect((await policy.get()).data()?.revision).toBe(2);
    expect((await ref.get()).data()?.sarinConfig.intakeFields).toHaveLength(1);
  });
  it('only admin resume lifts suspension; owner replay returns the current restriction', async () => {
    const { db, policy } = await setup(); vi.stubEnv('SUPERADMIN_UID', 'demo-admin');
    try {
      await executeOwnerBookingDeclaration(owner, id, declare, db, 'enforce');
      await executeAdminBookingPolicy({ uid: 'demo-admin' }, admin, db, 'enforce');
      expect(await executeOwnerBookingDeclaration(owner, id, declare, db, 'enforce')).toMatchObject({ capability: { admission: 'administrative_review', revision: 2 } });
      for (const input of [{ ...declare, requestId: 'demo-bypass', expectedRevision: 2 }, { action: 'withdraw' as const, requestId: 'demo-bypass', expectedRevision: 2 }]) await expect(executeOwnerBookingDeclaration(owner, id, input, db, 'enforce')).rejects.toMatchObject({ status: 403 });
      await expect(executeAdminBookingPolicy({ uid: 'demo-admin' }, { ...admin, action: 'classify', requestId: 'demo-classify', expectedRevision: 2 }, db, 'enforce')).rejects.toMatchObject({ code: 'BOOKING_ADMIN_REVIEW_REQUIRED' });
      expect((await policy.get()).data()).toMatchObject({ status: 'suspended', revision: 2 });
      expect(JSON.stringify(await readOwnerBookingDeclaration(owner, id, db, 'enforce'))).not.toContain('PRIVATE_ADMIN_REASON');
      expect(await executeAdminBookingPolicy({ uid: 'demo-admin' }, { ...admin, action: 'resume', requestId: 'demo-resume', expectedRevision: 2 }, db, 'enforce')).toMatchObject({ outcome: 'applied', capability: { admission: 'active', revision: 3 }, policy: { origin: 'admin', reason: 'PRIVATE_ADMIN_REASON' } });
    } finally { vi.unstubAllEnvs(); }
  });
  it('ownership_changed_before_commit never leaves a declaration or receipt', async () => {
    const { db, second, policy } = await setup(); let calls = 0;
    const wrapped: Database = { collection: name => db.collection(name), runTransaction: async (handler, options) => {
      if (++calls === 2) {
        const business = (await second.collection('businesses').doc(id).get()).data()!;
        await second.collection('businesses').doc(id).set({ ...business, ownerUid: 'demo-new-owner' });
      }
      return db.runTransaction(handler, options);
    } };
    await expect(executeOwnerBookingDeclaration(owner, id, declare, wrapped, 'enforce')).rejects.toMatchObject({ status: 403 });
    expect((await policy.get()).exists).toBe(false);
    expect((await db.collection('serverSettings').doc(bookingPolicyOperationKey(id, owner.uid, declare.requestId)).get()).exists).toBe(false);
  });
  it('two concurrent declarations use CAS; only one revision/receipt wins', async () => {
    const { db, second, policy } = await setup();
    const results = await Promise.allSettled([executeOwnerBookingDeclaration(owner, id, declare, db, 'enforce'), executeOwnerBookingDeclaration(owner, id, { ...declare, requestId: 'demo-other-declaration' }, second, 'enforce')]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(r => r.status === 'rejected')).toMatchObject({ reason: { code: 'BOOKING_POLICY_CONFLICT' } });
    expect((await policy.get()).data()?.revision).toBe(1);
  });
  it('declare_races_admin_suspend rejects the stale declaration and preserves the suspension', async () => {
    const { db, second, policy } = await setup(); vi.stubEnv('SUPERADMIN_UID', 'demo-admin');
    try {
      await executeOwnerBookingDeclaration(owner, id, declare, db, 'enforce');
      await executeOwnerBookingDeclaration(owner, id, { action: 'withdraw', requestId: 'demo-withdraw', expectedRevision: 1 }, db, 'enforce');
      let calls = 0;
      const wrapped: Database = { collection: name => db.collection(name), runTransaction: async (handler, options) => {
        if (++calls === 2) await executeAdminBookingPolicy({ uid: 'demo-admin' }, { ...admin, expectedRevision: 2 }, second, 'enforce');
        return db.runTransaction(handler, options);
      } };
      await expect(executeOwnerBookingDeclaration(owner, id, { ...declare, requestId: 'demo-redeclare', expectedRevision: 2 }, wrapped, 'enforce')).rejects.toMatchObject({ code: 'BOOKING_POLICY_CONFLICT' });
      expect((await policy.get()).data()).toMatchObject({ status: 'suspended', revision: 3 });
      expect((await db.collection('serverSettings').doc(bookingPolicyOperationKey(id, owner.uid, 'demo-redeclare')).get()).exists).toBe(false);
    } finally { vi.unstubAllEnvs(); }
  });
  it('replay rechecks ownership and new owners never receive the previous private declaration', async () => {
    const { db, second } = await setup();
    await executeOwnerBookingDeclaration(owner, id, declare, db, 'enforce');
    const ref = second.collection('businesses').doc(id), business = (await ref.get()).data()!;
    await ref.set({ ...business, ownerUid: 'demo-new-owner' });
    await expect(executeOwnerBookingDeclaration(owner, id, declare, db, 'enforce')).rejects.toMatchObject({ status: 403 });
    expect(await readOwnerBookingDeclaration({ uid: 'demo-new-owner' }, id, db, 'enforce')).toMatchObject({ capability: { admission: 'classification_required' }, declaration: null });
    expect(await executeOwnerBookingDeclaration({ uid: 'demo-new-owner' }, id, { ...declare, requestId: 'demo-new-owner-declare', expectedRevision: 1 }, db, 'enforce')).toMatchObject({ capability: { admission: 'active', revision: 2 } });
  });
  it('the owner endpoint cannot use superadmin privileges to bypass suspension, health or minors', async () => {
    const { db, policy } = await setup(); vi.stubEnv('SUPERADMIN_UID', owner.uid);
    try {
      await executeOwnerBookingDeclaration(owner, id, declare, db, 'enforce');
      const base = (await policy.get()).data()!;
      for (const restriction of [{ status: 'suspended', dataMode: 'general', representedMinorsEnabled: false }, { status: 'active', dataMode: 'health', representedMinorsEnabled: false }, { status: 'active', dataMode: 'general', representedMinorsEnabled: true }]) {
        const restricted = { ...base, ...restriction, origin: 'admin' };
        await policy.set(restricted);
        for (const input of [{ ...declare, requestId: 'demo-privilege-bypass', expectedRevision: 1 }, { action: 'withdraw' as const, requestId: 'demo-privilege-bypass', expectedRevision: 1 }]) {
          await expect(executeOwnerBookingDeclaration(owner, id, input, db, 'enforce')).rejects.toMatchObject({ status: 403 });
          expect((await policy.get()).data()).toEqual(restricted);
        }
      }
    } finally { vi.unstubAllEnvs(); }
  });
  it('uncertain_commit_recovers_current by receipt without issuing a new revision', async () => {
    const { db, policy } = await setup(); let lost = false;
    const wrapped: Database = { collection: name => db.collection(name), runTransaction: async (handler, options) => {
      const result = await db.runTransaction(handler, options);
      if (!lost && (await policy.get()).exists) { lost = true; throw Error('Synthetic lost commit ACK'); }
      return result;
    } };
    expect(await executeOwnerBookingDeclaration(owner, id, declare, wrapped, 'enforce')).toMatchObject({ outcome: 'applied', capability: { revision: 1 } });
    expect(lost).toBe(true); expect((await policy.get()).data()?.revision).toBe(1);
    expect(await executeOwnerBookingDeclaration(owner, id, declare, db, 'enforce')).toMatchObject({ capability: { revision: 1 } });
  });
}
