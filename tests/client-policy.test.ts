import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readClientPolicy, updateClientPolicy } from '@/lib/server/client-policy';
import { createAppointment, cancelAppointment } from '@/lib/server/bookings';
import { privateBusinessDraft } from '@/lib/server/businesses';
import { consentedFirestore } from './consent-fixtures';
const memoryFirestore = (initial: Parameters<typeof consentedFirestore>[0] = {}) => consentedFirestore(initial, ['client', 'owner', 'stranger']);
const now = Date.parse('2030-01-01T12:00:00Z');
const value = { ...privateBusinessDraft({ uid: 'owner' }, now), id: 'policy', slug: 'policy', subscription: { status: 'active' as const, trialEndsAt: 0, currentPeriodEndsAt: now + 30 * 86400000 }, sarinConfig: { onboardingCompleted: true, tone: '', customRules: '', intakeFields: [] }, resources: [{ id: 'one', name: 'Uno', active: true }, { id: 'two', name: 'Dos', active: true }], services: [{ id: 'cut', name: 'Corte', price: 10000, durationMinutes: 30, bufferMinutes: 0, resourceIds: ['one', 'two'] }], weeklySchedule: { 1: { isOpen: true, intervals: [{ start: '09:00', end: '17:00' }] } } };
const input = { dateKey: '2030-01-07', startTimeStr: '09:00', serviceId: 'cut', resourceId: 'one', clientPhone: '573001234567', intakeAnswers: {} };
function setup() { return memoryFirestore({ 'businesses/policy': value }); }
describe('private client policy and booking admission', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); });
  afterEach(() => vi.useRealTimers());
  it('serializes the third future appointment across different days and resources and preserves replay', async () => {
    const { db, rows } = setup();
    for (let i = 0; i < 2; i++) await createAppointment({ uid: 'client' }, value.id, { ...input, startTimeStr: `1${i}:00` }, `existing-${i}`, db);
    const results = await Promise.allSettled([
      createAppointment({ uid: 'client' }, value.id, input, 'third', db),
      createAppointment({ uid: 'client' }, value.id, { ...input, dateKey: '2030-01-14', resourceId: 'two' }, 'fourth', db),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { code: 'CLIENT_BOOKING_LIMIT', status: 409 } });
    expect([...rows.keys()].filter(path => path.includes('/appointments/'))).toHaveLength(3);
    expect(await createAppointment({ uid: 'client' }, value.id, { ...input, startTimeStr: '10:00' }, 'existing-0', db)).toMatchObject({ startTimeStr: '10:00' });
  });
  it('allows a reasoned exception, inherits defaults again, and never deletes older appointments', async () => {
    const { db, rows } = setup();
    await updateClientPolicy({ uid: 'owner' }, value.id, { clientUid: 'client', futureAppointmentLimit: 5, reason: 'Cinco visitas acordadas' }, db);
    for (let i = 0; i < 5; i++) await createAppointment({ uid: 'client' }, value.id, { ...input, startTimeStr: `${10 + i}:00` }, `old-${i}`, db);
    expect(await updateClientPolicy({ uid: 'owner' }, value.id, { clientUid: 'client', futureAppointmentLimit: null, reason: 'Volver al límite general' }, db)).toMatchObject({ futureAppointmentLimit: 3 });
    await expect(createAppointment({ uid: 'client' }, value.id, input, 'new', db)).rejects.toMatchObject({ code: 'CLIENT_BOOKING_LIMIT' });
    expect([...rows.keys()].filter(path => path.includes('/appointments/'))).toHaveLength(5);
  });
  it('counts only future confirmed appointments; blocked clients retain cancellation and history', async () => {
    const { db, rows } = setup();
    const first = await createAppointment({ uid: 'client' }, value.id, input, 'first', db);
    for (const [id, changes] of Object.entries({ past: { startAt: now - 1 }, ongoing: { startAt: now }, cancelled: { status: 'cancelled_by_owner' }, manual: { type: 'manual_block' } })) {
      await db.collection('businesses').doc(value.id).collection('appointments').doc(id).set({ ...first, id, ...changes });
    }
    await updateClientPolicy({ uid: 'owner' }, value.id, { futureAppointmentLimit: 2, reason: 'Capacidad reducida' }, db);
    await createAppointment({ uid: 'client' }, value.id, { ...input, dateKey: '2030-01-14' }, 'second', db);
    await updateClientPolicy({ uid: 'owner' }, value.id, { clientUid: 'client', blocked: true, reason: 'Revisión de uso' }, db);
    await expect(createAppointment({ uid: 'client' }, value.id, { ...input, resourceId: 'two' }, 'blocked', db)).rejects.toMatchObject({ code: 'CLIENT_BLOCKED', status: 403 });
    expect(await cancelAppointment({ uid: 'client' }, value.id, first.id, db)).toMatchObject({ status: 'cancelled_by_client' });
    expect(rows.has(`businesses/policy/appointments/${first.id}`)).toBe(true);
  });
  it('authorizes owners, forbids self blocking, validates limits and fails closed on corruption', async () => {
    const { db } = setup();
    await expect(updateClientPolicy({ uid: 'stranger' }, value.id, { reason: 'No' }, db)).rejects.toMatchObject({ status: 403 });
    await expect(updateClientPolicy({ uid: 'owner' }, value.id, { clientUid: 'owner', blocked: true, reason: 'No' }, db)).rejects.toMatchObject({ status: 400 });
    for (const limit of [0, 21, 1.5]) await expect(updateClientPolicy({ uid: 'owner' }, value.id, { futureAppointmentLimit: limit, reason: 'No' }, db)).rejects.toBeDefined();
    await db.collection('businesses').doc(value.id).collection('clientPolicies').doc('defaults').set({ futureAppointmentLimit: 'unlimited' });
    await expect(readClientPolicy(value.id, 'client', db)).rejects.toMatchObject({ status: 503 });
    await expect(createAppointment({ uid: 'client' }, value.id, input, 'corrupt', db)).rejects.toMatchObject({ status: 503 });
  });
  it('unblocks new bookings without clearing the client limit or restoring cancelled appointments', async () => {
    const { db, rows } = setup();
    const first = await createAppointment({ uid: 'client' }, value.id, input, 'first', db);
    await updateClientPolicy({ uid: 'owner' }, value.id, { clientUid: 'client', blocked: true, futureAppointmentLimit: 1, reason: 'Revisión de uso' }, db);
    await cancelAppointment({ uid: 'client' }, value.id, first.id, db);
    await expect(createAppointment({ uid: 'client' }, value.id, input, 'after-block', db)).rejects.toMatchObject({ code: 'CLIENT_BLOCKED', status: 403 });
    expect(await updateClientPolicy({ uid: 'owner' }, value.id, { clientUid: 'client', blocked: false, reason: 'Revisión completada' }, db)).toMatchObject({ blocked: false, futureAppointmentLimit: 1, inheritsLimit: false });
    const restored = await createAppointment({ uid: 'client' }, value.id, input, 'after-block', db);
    expect(restored).toMatchObject({ status: 'confirmed', client: { uid: 'client' } });
    await expect(createAppointment({ uid: 'client' }, value.id, { ...input, resourceId: 'two' }, 'over-limit', db)).rejects.toMatchObject({ code: 'CLIENT_BOOKING_LIMIT', status: 409 });
    expect(rows.get(`businesses/policy/appointments/${first.id}`)?.data.status).toBe('cancelled_by_client');
    expect([...rows.keys()].filter(path => path.includes('/appointments/'))).toHaveLength(2);
  });
});
