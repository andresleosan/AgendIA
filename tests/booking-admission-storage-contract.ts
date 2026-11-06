import { expect, it, vi } from 'vitest';
import type { Database } from '@/lib/storage/types';
import { privateBusinessDraft } from '@/lib/server/businesses';
import { readBookingDataPolicy, bookingDataPolicyKey, saveBookingDataPolicy } from '@/lib/server/booking-data-policy';
import { readBookingAdmission, assertBookingAdmission, ensureBookingAdmissionProtocol } from '@/lib/server/booking-admission';

export const admissionBusinessId = 'demo-admission';
export const admissionPolicy = { version: 2, businessId: admissionBusinessId, revision: 2, dataMode: 'general', representedMinorsEnabled: false, status: 'active', origin: 'owner', updatedBy: 'demo-owner', updatedAt: 1, reason: 'PRIVATE_REASON', declaration: { ownerUid: 'demo-owner', textVersion: 'demo-text-v1', receiptId: 'demo-receipt' } } as const;
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
