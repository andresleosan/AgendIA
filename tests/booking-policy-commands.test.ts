import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { executeAdminBookingPolicy, executeOwnerBookingDeclaration, readOwnerBookingDeclaration } from '@/lib/server/booking-policy-commands';
import { BOOKING_DECLARATION_TEXT_VERSION } from '@/lib/booking-declaration';
import { bookingDataPolicyKey } from '@/lib/server/booking-data-policy';
import { registerBookingPolicyCommandCases } from './booking-policy-commands-contract';
import { admissionBusinessId, admissionPolicy } from './booking-admission-storage-contract';
import { memoryFirestore } from './memoryFirestore';
import { privateBusinessDraft } from '@/lib/server/businesses';

afterEach(() => vi.unstubAllEnvs());
describe('booking policy commands', () => {
  let store: ReturnType<typeof memoryFirestore>;
  beforeEach(() => { store = memoryFirestore(); });
  registerBookingPolicyCommandCases(() => ({ db: store.db, second: store.db }));
});

it('prepare closes new commands and owner receipts without changing any policy', async () => {
  vi.stubEnv('SUPERADMIN_UID', 'demo-admin');
  const { db, rows } = memoryFirestore({ [`businesses/${admissionBusinessId}`]: { ...privateBusinessDraft({ uid: 'demo-owner' }, 1), id: admissionBusinessId } });
  const input = { action: 'declare', requestId: 'demo-declare', expectedRevision: 0, textVersion: BOOKING_DECLARATION_TEXT_VERSION } as const;
  await expect(executeOwnerBookingDeclaration({ uid: 'demo-owner' }, admissionBusinessId, input, db)).rejects.toMatchObject({ code: 'BOOKING_POLICY_UNAVAILABLE' });
  await expect(readOwnerBookingDeclaration({ uid: 'demo-owner' }, admissionBusinessId, db)).rejects.toMatchObject({ code: 'BOOKING_POLICY_UNAVAILABLE' });
  await expect(executeAdminBookingPolicy({ uid: 'demo-admin' }, { action: 'classify', businessId: admissionBusinessId, requestId: 'demo-admin-classify', expectedRevision: 0, dataMode: 'general', representedMinorsEnabled: false, reason: 'Private' }, db)).rejects.toMatchObject({ code: 'BOOKING_POLICY_UNAVAILABLE' });
  expect([...rows.keys()]).toEqual([`businesses/${admissionBusinessId}`]);
});

it('rejects unknown text versions and injected authority before writing', async () => {
  const { db, rows } = memoryFirestore({ [`businesses/${admissionBusinessId}`]: { ...privateBusinessDraft({ uid: 'demo-owner' }, 1), id: admissionBusinessId } });
  const { ensureBookingAdmissionProtocol } = await import('@/lib/server/booking-admission');
  await ensureBookingAdmissionProtocol(db, 'a'.repeat(40), 'enforce');
  const input = { action: 'declare', requestId: 'demo-declare', expectedRevision: 0, textVersion: BOOKING_DECLARATION_TEXT_VERSION } as const;
  for (const extra of [{ ownerUid: 'demo-other' }, { dataMode: 'health' }, { representedMinorsEnabled: true }, { textVersion: 'old-text' }, { origin: 'admin' }, { action: 'suspend' }]) {
    await expect(executeOwnerBookingDeclaration({ uid: 'demo-owner' }, admissionBusinessId, { ...input, ...extra } as typeof input, db, 'enforce')).rejects.toThrow();
  }
  expect([...rows.keys()]).toHaveLength(2);
});

it('does not replace legacy administrative or corrupt classifications with a declaration', async () => {
  const { db } = memoryFirestore({ [`businesses/${admissionBusinessId}`]: { ...privateBusinessDraft({ uid: 'demo-owner' }, 1), id: admissionBusinessId } });
  const { ensureBookingAdmissionProtocol } = await import('@/lib/server/booking-admission');
  await ensureBookingAdmissionProtocol(db, 'a'.repeat(40), 'enforce');
  const ref = db.collection('serverSettings').doc(bookingDataPolicyKey(admissionBusinessId));
  const legacy = { version: 1, businessId: admissionBusinessId, revision: 1, dataMode: 'general', representedMinorsEnabled: false, updatedAt: 1, updatedBy: 'demo-admin', reason: 'PRIVATE' };
  for (const [policy, error] of [[legacy, { status: 403 }], [{ ...admissionPolicy, origin: 'admin', dataMode: 'health' }, { status: 403 }], [{ broken: true }, { code: 'BOOKING_POLICY_UNAVAILABLE' }]] as const) {
    await ref.set(policy);
    await expect(executeOwnerBookingDeclaration({ uid: 'demo-owner' }, admissionBusinessId, { action: 'declare', requestId: 'demo-replace', expectedRevision: 'revision' in policy ? policy.revision : 1, textVersion: BOOKING_DECLARATION_TEXT_VERSION }, db, 'enforce')).rejects.toMatchObject(error);
    expect((await ref.get()).data()).toEqual(policy);
  }
  await ref.set(legacy);
  expect(await readOwnerBookingDeclaration({ uid: 'demo-owner' }, admissionBusinessId, db, 'enforce')).toMatchObject({ origin: 'admin', capability: { admission: 'active' }, declaration: null });
});
