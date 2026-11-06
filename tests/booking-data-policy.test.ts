import { afterEach, describe, expect, it, vi } from 'vitest';
import { readBookingDataPolicy, saveBookingDataPolicy, bookingDataPolicyKey } from '@/lib/server/booking-data-policy';
import { businessIdForOwner, createBusiness, privateBusinessDraft, publicBusiness } from '@/lib/server/businesses';
import { consentedFirestore } from './consent-fixtures';
const business = { ...privateBusinessDraft({ uid: 'demo-owner' }, 0), name: 'Demo', subscription: { status: 'active' as const, trialEndsAt: 0, currentPeriodEndsAt: 9999999999999 } };
const id = business.id;
const input = { businessId: id, expectedRevision: 0, dataMode: 'health' as const, representedMinorsEnabled: true, reason: 'Piloto sintético' };
const setup = (intakeFields: typeof business.sarinConfig.intakeFields = []) => consentedFirestore({ [`businesses/${id}`]: { ...business, sarinConfig: { ...business.sarinConfig, intakeFields } } }, ['demo-owner']);
afterEach(() => vi.unstubAllEnvs());
describe('private booking data classification', () => {
  it('inherits unreviewed legacy general capability without writing or public policy', async () => {
    const { db, rows } = setup();
    expect(await readBookingDataPolicy(id, db)).toEqual({ policy: null, capability: { configured: false, revision: 0, dataMode: 'general', representedMinorsEnabled: false, admission: 'active', canStartBooking: true, canUseInference: true } });
    expect(rows.has(`serverSettings/${bookingDataPolicyKey(id)}`)).toBe(false);
    expect(publicBusiness(business)).not.toHaveProperty('bookingDataPolicy');
  });
  it('rejects owner and stale policy revision including concurrent edits', async () => {
    vi.stubEnv('SUPERADMIN_UID', 'demo-admin'); const { db } = setup();
    await expect(saveBookingDataPolicy({ uid: 'demo-owner' }, input, db)).rejects.toMatchObject({ status: 403 });
    const results = await Promise.allSettled([saveBookingDataPolicy({ uid: 'demo-admin' }, input, db), saveBookingDataPolicy({ uid: 'demo-admin' }, input, db)]);
    expect(results.filter(item => item.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(item => item.status === 'rejected')).toMatchObject({ reason: { status: 409 } });
    const saved = await readBookingDataPolicy(id, db);
    expect(saved.policy).toMatchObject({ revision: 1, updatedBy: 'demo-admin', reason: input.reason });
    expect(saved.capability).not.toHaveProperty('updatedBy'); expect(saved.capability).not.toHaveProperty('reason');
    await expect(saveBookingDataPolicy({ uid: 'demo-admin' }, { ...input, businessId: 'missing' }, db)).rejects.toMatchObject({ status: 404 });
  });
  it('rejects restricted activation with free intake and subsequent reintroduction', async () => {
    vi.stubEnv('SUPERADMIN_UID', 'demo-admin');
    const intake = [{ key: 'note', label: 'Preferencia', required: false }];
    const first = setup(intake);
    await expect(saveBookingDataPolicy({ uid: 'demo-admin' }, input, first.db)).rejects.toMatchObject({ status: 409 });
    await expect(saveBookingDataPolicy({ uid: 'demo-admin' }, { ...input, dataMode: 'general', representedMinorsEnabled: false }, first.db)).resolves.toMatchObject({ revision: 1 });
    const { db } = setup(); await saveBookingDataPolicy({ uid: 'demo-admin' }, input, db);
    const closed = { isOpen: false, intervals: [] };
    const config = { slug: 'demo-business', name: 'Demo', category: 'Demo', phoneWhatsApp: '573001234567', tone: '', customRules: '', intakeFields: intake, services: [], resources: [], weeklySchedule: { '0': closed, '1': closed, '2': closed, '3': closed, '4': closed, '5': closed, '6': closed } };
    expect(businessIdForOwner('demo-owner')).toBe(id);
    await expect(createBusiness({ uid: 'demo-owner' }, config, db)).rejects.toMatchObject({ status: 409 });
  });
  it('fails closed on malformed policy or a copied tenant policy', async () => {
    const { db } = setup(); const ref = db.collection('serverSettings').doc(bookingDataPolicyKey(id));
    await ref.set({ dataMode: 'health' });
    await expect(readBookingDataPolicy(id, db)).rejects.toMatchObject({ status: 503 });
  });
});
