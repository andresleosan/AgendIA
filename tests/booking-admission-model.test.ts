import { describe, expect, it } from 'vitest';
import { bookingPolicySchema, bookingDispatchHeadSchema, bookingPolicyOperationSchema, normalizeBookingAdmission } from '@/lib/booking-admission';
import { bookingAdmissionProtocolSchema } from '@/lib/booking-admission-release';
import { readBookingAdmission } from '@/lib/server/booking-admission';
import type { Database } from '@/lib/storage/types';
import { createCloudflareDatabase } from '@/lib/storage/database';

export const demoPolicy = { version: 2, businessId: 'demo-admission', revision: 2, dataMode: 'general', representedMinorsEnabled: false, status: 'active', origin: 'owner', updatedBy: 'demo-owner', updatedAt: 1, reason: 'PRIVATE_REASON', declaration: { ownerUid: 'demo-owner', textVersion: 'demo-text-v1', receiptId: 'demo-receipt' } } as const;
describe('booking admission model', () => {
  it('retries a mixed D1 read snapshot instead of turning a conflict into policy corruption', async () => {
    let reads = 0;
    const db = createCloudflareDatabase(async () => ({ revision: ++reads === 1 ? 0 : 1, documents: [] }));
    await expect(readBookingAdmission('demo-admission', db)).resolves.toMatchObject({ configured: false, admission: 'active' });
  });
  it('storage failure is unavailable rather than a missing policy', async () => {
    const db = { runTransaction: async () => { throw Error('PRIVATE_STORAGE_ERROR'); } } as unknown as Database;
    await expect(readBookingAdmission('demo-admission', db)).rejects.toMatchObject({ status: 503, code: 'BOOKING_POLICY_UNAVAILABLE' });
    await expect(readBookingAdmission('demo-admission', db)).rejects.not.toThrow('PRIVATE_STORAGE_ERROR');
  });
  it('missing_is_required_only_after_cutover', () => {
    expect(normalizeBookingAdmission(null, 'demo-owner', 'prepare')).toMatchObject({ configured: false, admission: 'active', canStartBooking: true });
    expect(normalizeBookingAdmission(null, 'demo-owner', 'enforce')).toMatchObject({ configured: false, admission: 'classification_required', canStartBooking: false, canUseInference: false });
  });
  it('legacy_admin_remains_active without rewriting the record', () => {
    const legacy = { version: 1, businessId: 'demo-admission', revision: 1, dataMode: 'health', representedMinorsEnabled: true, updatedBy: 'demo-admin', updatedAt: 1, reason: 'PRIVATE_REASON' };
    const parsed = bookingPolicySchema.parse(legacy);
    expect(parsed).toEqual(legacy);
    expect(normalizeBookingAdmission(parsed, 'demo-other-owner', 'enforce')).toMatchObject({ admission: 'active', canStartBooking: true, canUseInference: false });
  });
  it('withdrawn_suspended_unknown_never_open and owner_binding_changes', () => {
    for (const [status, admission] of [['withdrawn', 'withdrawn'], ['suspended', 'administrative_review']] as const) {
      const policy = bookingPolicySchema.parse({ ...demoPolicy, status, ...(status === 'suspended' ? { origin: 'admin' } : {}) });
      expect(normalizeBookingAdmission(policy, 'demo-other', 'prepare')).toMatchObject({ admission, canStartBooking: false, canUseInference: false });
    }
    expect(normalizeBookingAdmission(demoPolicy, 'demo-other', 'prepare')).toMatchObject({ admission: 'classification_required', canStartBooking: false });
    for (const change of [{ version: 3 }, { status: 'unknown' }, { origin: 'owner', dataMode: 'health' }, { declaration: null }, { revision: 0 }, { unexpected: true }]) expect(bookingPolicySchema.safeParse({ ...demoPolicy, ...change }).success).toBe(false);
  });
  it('private_fields_never_project', () => {
    const capability = normalizeBookingAdmission(demoPolicy, 'demo-owner', 'enforce');
    expect(capability).toEqual({ configured: true, revision: 2, dataMode: 'general', representedMinorsEnabled: false, admission: 'active', canStartBooking: true, canUseInference: true });
    expect(JSON.stringify(capability)).not.toMatch(/PRIVATE|demo-owner|demo-receipt|demo-text/);
  });
  it('strictly bounds dispatch heads and rejects inconsistent transitions and receipts', () => {
    const ref = { kind: 'quota', id: 'demo-turn', policyRevision: 1, startedAt: 1 };
    expect(bookingDispatchHeadSchema.safeParse({ version: 1, businessId: 'demo-admission', revision: 1, refs: [ref] }).success).toBe(true);
    for (const refs of [Array(65).fill(ref), [ref, ref], [{ ...ref, kind: 'unknown' }]]) expect(bookingDispatchHeadSchema.safeParse({ version: 1, businessId: 'demo-admission', revision: 1, refs }).success).toBe(false);
    const transition = { requestId: 'demo-request', targetRevision: 2, target: { status: 'withdrawn', origin: 'owner', dataMode: 'general', representedMinorsEnabled: false, declaration: demoPolicy.declaration, reason: 'PRIVATE' }, startedAt: 1, dispatchRefs: [ref] };
    expect(bookingPolicySchema.safeParse({ ...demoPolicy, status: 'transitioning', transition }).success).toBe(true);
    for (const change of [{ status: 'transitioning' }, { transition }, { status: 'transitioning', transition: { ...transition, targetRevision: 3 } }]) expect(bookingPolicySchema.safeParse({ ...demoPolicy, ...change }).success).toBe(false);
    const operation = { version: 1, businessId: 'demo-admission', actorUid: 'demo-owner', requestId: 'demo-request', action: 'declare', operationHash: 'a'.repeat(64), occurredAt: 1, previousRevision: 1, targetRevision: 2, phase: 'applied', textVersion: 'demo-text-v1' };
    expect(bookingPolicyOperationSchema.safeParse(operation).success).toBe(true);
    for (const change of [{ targetRevision: 1 }, { action: 'unknown' }, { privateBody: 'PRIVATE' }, { textVersion: undefined }]) expect(bookingPolicyOperationSchema.safeParse({ ...operation, ...change }).success).toBe(false);
    expect(bookingAdmissionProtocolSchema.safeParse({ version: 1, minimumReader: 2, introducedBySha: 'a'.repeat(40) }).success).toBe(true);
    expect(bookingAdmissionProtocolSchema.safeParse({ version: 1, minimumReader: 1, introducedBySha: 'a'.repeat(40) }).success).toBe(false);
  });
});
