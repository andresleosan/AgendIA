import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBookingProposal, confirmBookingProposal } from '@/lib/server/booking-proposals';
import { cancelAppointment } from '@/lib/server/bookings';
import { updateClientPolicy } from '@/lib/server/client-policy';
import { bookingDataPolicyKey } from '@/lib/server/booking-data-policy';
import { readConsent, updateConsent } from '@/lib/server/consent';
import type { Database, DocumentReference, Query, Transaction } from '@/lib/storage/types';
import type { Appointment, Business } from '@/types/firestore';
import { consentedFirestore } from './consent-fixtures';
import { rescheduleActor, rescheduleBusiness, rescheduleContact, rescheduleNow, rescheduleSelection, rescheduleSource, rescheduleSourcePath } from './appointment-reschedule-contract';

function scenario(business: Business = rescheduleBusiness, source: Appointment = rescheduleSource) {
  return consentedFirestore({ [`businesses/${business.id}`]: business as unknown as Record<string, unknown>, [rescheduleSourcePath]: source as unknown as Record<string, unknown> }, [rescheduleActor.uid, 'demo-other-client', 'demo-reschedule-owner']);
}
const confirmation = rescheduleContact;

function advanceAfterRead(db: Database, shouldAdvance: (target: DocumentReference | Query) => boolean, at: number): Database {
  return { ...db, runTransaction: (handler, options) => db.runTransaction(tx => {
    const guarded = new Proxy(tx, { get(target, key) {
      if (key !== 'get') return Reflect.get(target, key);
      return async (reference: DocumentReference | Query) => {
        const result = await (target.get as (input: DocumentReference | Query) => Promise<unknown>).call(target, reference);
        if (shouldAdvance(reference)) vi.setSystemTime(at);
        return result;
      };
    } }) as Transaction;
    return handler(guarded);
  }, options) };
}

describe('appointment reschedule domain', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(rescheduleNow); });
  afterEach(() => vi.useRealTimers());

  it('moves the same appointment and preserves original client data and historical metadata', async () => {
    const { db, rows } = scenario();
    const proposal = await createBookingProposal(rescheduleActor, rescheduleBusiness.id, rescheduleSelection, 'demo-reschedule-request', db, undefined, { appointmentId: rescheduleSource.id, sourceRevision: 0 });
    expect(rows.get(rescheduleSourcePath)?.data).toEqual(rescheduleSource);

    const appointment = await confirmBookingProposal(rescheduleActor, rescheduleBusiness.id, proposal.id, confirmation, db);

    expect(appointment.id).toBe('demo-original-appointment');
    expect(appointment.client).toEqual({ uid: 'demo-reschedule-client', name: 'Nombre original', email: 'original@example.test', phone: '573001234567', intakeAnswers: { retired_question: 'Respuesta histórica' }, hasNoShowHistory: true });
    expect(appointment).toMatchObject({ createdBy: 'sarin_client', createdAt: rescheduleNow - 86400000, historicalMetadata: { imported: true }, serviceId: 'demo-cut', serviceName: 'Corte actual', price: 25000, dateKey: '2030-01-07', startTimeStr: '10:00', endTimeStr: '10:30', startAt: Date.parse('2030-01-07T15:00:00Z'), endAt: Date.parse('2030-01-07T15:30:00Z'), reservedUntilAt: Date.parse('2030-01-07T15:45:00Z'), rescheduleRevision: 1, lastRescheduleProposalId: proposal.id, rescheduledAt: rescheduleNow });
    expect(appointment).not.toHaveProperty('beneficiary');
    expect(rows.get(rescheduleSourcePath)?.data).toEqual(appointment);
    expect([...rows.keys()].filter(path => path.includes('/appointments/'))).toEqual([rescheduleSourcePath]);
  });

  it.each([
    ['another client', { client: { ...rescheduleSource.client!, uid: 'demo-other-client' } }],
    ['another tenant', { tenantId: 'demo-other-business' }],
    ['manual block', { type: 'manual_block' }],
    ['past source', { startAt: rescheduleNow - 1 }],
    ['source starting now', { startAt: rescheduleNow }],
    ['cancelled source', { status: 'cancelled_by_client' }],
    ['owner cancelled source', { status: 'cancelled_by_owner' }],
    ['completed source', { status: 'completed' }],
    ['no-show source', { status: 'no_show' }],
    ['malformed revision', { rescheduleRevision: -1 }],
    ['fractional revision', { rescheduleRevision: 0.5 }],
    ['null revision', { rescheduleRevision: null }],
    ['null beneficiary', { beneficiary: null }],
  ])('rejects a proposal for %s without touching the source', async (_label, patch) => {
    const source = { ...rescheduleSource, ...patch } as Appointment;
    const { db, rows } = scenario(rescheduleBusiness, source);
    await expect(createBookingProposal(rescheduleActor, rescheduleBusiness.id, rescheduleSelection, 'demo-rejected-source', db, undefined, { appointmentId: source.id, sourceRevision: 0 })).rejects.toBeDefined();
    expect(rows.get(rescheduleSourcePath)?.data).toEqual(source);
    expect([...rows.keys()].filter(path => path.startsWith('bookingProposals/'))).toHaveLength(0);
  });

  it('rejects another client even when that client owns the business', async () => {
    const { db, rows } = scenario();
    await expect(createBookingProposal({ uid: 'demo-reschedule-owner' }, rescheduleBusiness.id, rescheduleSelection, 'demo-owner-source', db, undefined, { appointmentId: rescheduleSource.id, sourceRevision: 0 })).rejects.toMatchObject({ status: 403 });
    expect(rows.get(rescheduleSourcePath)?.data).toEqual(rescheduleSource);
  });

  it('rejects an absent source and a stale source revision', async () => {
    const { db, rows } = scenario();
    await expect(createBookingProposal(rescheduleActor, rescheduleBusiness.id, rescheduleSelection, 'demo-absent-source', db, undefined, { appointmentId: 'demo-missing-appointment', sourceRevision: 0 })).rejects.toMatchObject({ status: 404 });
    await expect(createBookingProposal(rescheduleActor, rescheduleBusiness.id, rescheduleSelection, 'demo-stale-source', db, undefined, { appointmentId: rescheduleSource.id, sourceRevision: 1 })).rejects.toMatchObject({ status: 409 });
    expect(rows.get(rescheduleSourcePath)?.data).toEqual(rescheduleSource);
  });

  it('allows overlap with only its own occupied interval and rejects a no-op', async () => {
    const { db, rows } = scenario();
    const proposal = await createBookingProposal(rescheduleActor, rescheduleBusiness.id, { ...rescheduleSelection, startTimeStr: '09:15' }, 'demo-overlapping-source', db, undefined, { appointmentId: rescheduleSource.id, sourceRevision: 0 });
    expect(proposal.startTimeStr).toBe('09:15');
    expect(rows.get(rescheduleSourcePath)?.data).toEqual(rescheduleSource);
    await expect(createBookingProposal(rescheduleActor, rescheduleBusiness.id, { ...rescheduleSelection, startTimeStr: '09:00' }, 'demo-no-op-source', db, undefined, { appointmentId: rescheduleSource.id, sourceRevision: 0 })).rejects.toBeDefined();
  });

  it('binds request intent to the source, revision and selection', async () => {
    const { db } = scenario();
    const requestId = 'demo-fixed-request';
    await createBookingProposal(rescheduleActor, rescheduleBusiness.id, rescheduleSelection, requestId, db, undefined, { appointmentId: rescheduleSource.id, sourceRevision: 0 });
    await expect(createBookingProposal(rescheduleActor, rescheduleBusiness.id, rescheduleSelection, requestId, db)).rejects.toMatchObject({ status: 409 });
    await expect(createBookingProposal(rescheduleActor, rescheduleBusiness.id, rescheduleSelection, requestId, db, undefined, { appointmentId: 'demo-other-source', sourceRevision: 0 })).rejects.toMatchObject({ status: 409 });
    await expect(createBookingProposal(rescheduleActor, rescheduleBusiness.id, rescheduleSelection, requestId, db, undefined, { appointmentId: rescheduleSource.id, sourceRevision: 1 })).rejects.toMatchObject({ status: 409 });
    await expect(createBookingProposal(rescheduleActor, rescheduleBusiness.id, { ...rescheduleSelection, startTimeStr: '11:00' }, requestId, db, undefined, { appointmentId: rescheduleSource.id, sourceRevision: 0 })).rejects.toMatchObject({ status: 409 });
  });

  it('does not reinterpret an existing new-booking request as a reschedule', async () => {
    const { db } = scenario();
    await createBookingProposal(rescheduleActor, rescheduleBusiness.id, rescheduleSelection, 'demo-new-booking-request', db);
    await expect(createBookingProposal(rescheduleActor, rescheduleBusiness.id, rescheduleSelection, 'demo-new-booking-request', db, undefined, { appointmentId: rescheduleSource.id, sourceRevision: 0 })).rejects.toMatchObject({ status: 409 });
  });

  it('replaces without consuming an exhausted paid trial or adding a client-limit unit', async () => {
    const business: Business = { ...rescheduleBusiness, subscription: { status: 'trial', trialEndsAt: 0, currentPeriodEndsAt: 0, paidTrial: { paymentId: 'demo-paid-trial', activatedAt: rescheduleNow, appointmentLimit: 10, appointmentsUsed: 10 } } };
    const { db, rows } = scenario(business);
    await updateClientPolicy({ uid: 'demo-reschedule-owner' }, business.id, { clientUid: rescheduleActor.uid, futureAppointmentLimit: 1, reason: 'Demo one future appointment' }, db);
    const before = structuredClone(rows.get(`businesses/${business.id}`)?.data);
    const proposal = await createBookingProposal(rescheduleActor, business.id, rescheduleSelection, 'demo-exhausted-trial', db, undefined, { appointmentId: rescheduleSource.id, sourceRevision: 0 });
    const moved = await confirmBookingProposal(rescheduleActor, business.id, proposal.id, confirmation, db);
    expect(moved.id).toBe(rescheduleSource.id);
    expect(rows.get(`businesses/${business.id}`)?.data).toEqual(before);
    expect([...rows.keys()].filter(path => path.includes('/appointments/'))).toHaveLength(1);
    await expect(createBookingProposal(rescheduleActor, business.id, { ...rescheduleSelection, startTimeStr: '11:00' }, 'demo-new-after-exhaustion', db)).rejects.toMatchObject({ status: 402 });
  });

  it('allows only one of two proposals for the same source revision to move it', async () => {
    const { db, rows } = scenario();
    const first = await createBookingProposal(rescheduleActor, rescheduleBusiness.id, rescheduleSelection, 'demo-competing-first', db, undefined, { appointmentId: rescheduleSource.id, sourceRevision: 0 });
    const second = await createBookingProposal(rescheduleActor, rescheduleBusiness.id, { ...rescheduleSelection, startTimeStr: '11:00' }, 'demo-competing-second', db, undefined, { appointmentId: rescheduleSource.id, sourceRevision: 0 });
    const results = await Promise.allSettled([confirmBookingProposal(rescheduleActor, rescheduleBusiness.id, first.id, confirmation, db), confirmBookingProposal(rescheduleActor, rescheduleBusiness.id, second.id, confirmation, db)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { status: 409 } });
    expect(rows.get(rescheduleSourcePath)?.data).toMatchObject({ id: rescheduleSource.id, rescheduleRevision: 1 });
    expect([...rows.keys()].filter(path => path.includes('/appointments/'))).toHaveLength(1);
  });

  it('does not move a source that was cancelled after its proposal', async () => {
    const { db, rows } = scenario();
    const proposal = await createBookingProposal(rescheduleActor, rescheduleBusiness.id, rescheduleSelection, 'demo-cancel-before-confirm', db, undefined, { appointmentId: rescheduleSource.id, sourceRevision: 0 });
    await cancelAppointment(rescheduleActor, rescheduleBusiness.id, rescheduleSource.id, db);
    await expect(confirmBookingProposal(rescheduleActor, rescheduleBusiness.id, proposal.id, confirmation, db)).rejects.toMatchObject({ status: 409 });
    expect(rows.get(rescheduleSourcePath)?.data).toMatchObject({ status: 'cancelled_by_client', startTimeStr: '09:00' });
    expect([...rows.keys()].filter(path => path.includes('/appointments/'))).toHaveLength(1);
  });

  it.each([
    ['client phone', { client: { ...rescheduleSource.client!, phone: '573001111111' } }],
    ['historical answers', { client: { ...rescheduleSource.client!, intakeAnswers: { retired_question: 'Changed answer' } } }],
    ['service identity', { serviceId: 'demo-other-service' }],
    ['source interval', { reservedUntilAt: rescheduleSource.reservedUntilAt + 60000 }],
    ['representation review', { representationReview: { revision: 1, status: 'needs_contact', reviewedBy: 'demo-reschedule-owner', reviewedAt: rescheduleNow } }],
    ['source revision', { rescheduleRevision: 1 }],
  ])('rejects confirmation after %s changes without overwriting that change', async (_label, patch) => {
    const { db, rows } = scenario();
    const proposal = await createBookingProposal(rescheduleActor, rescheduleBusiness.id, rescheduleSelection, 'demo-source-changed', db, undefined, { appointmentId: rescheduleSource.id, sourceRevision: 0 });
    const source = { ...rescheduleSource, ...patch };
    await db.collection('businesses').doc(rescheduleBusiness.id).collection('appointments').doc(rescheduleSource.id).set(source);
    await expect(confirmBookingProposal(rescheduleActor, rescheduleBusiness.id, proposal.id, confirmation, db)).rejects.toMatchObject({ status: 409 });
    expect(rows.get(rescheduleSourcePath)?.data).toEqual(source);
    expect([...rows.keys()].filter(path => path.includes('/appointments/'))).toHaveLength(1);
  });

  // Existing proposal catalogue guards are regression coverage; source-preservation is new.
  it.each([
    ['price', { services: [{ ...rescheduleBusiness.services[0], price: 30000 }] }],
    ['buffer', { services: [{ ...rescheduleBusiness.services[0], bufferMinutes: 30 }] }],
    ['duration', { services: [{ ...rescheduleBusiness.services[0], durationMinutes: 45 }] }],
    ['removed service', { services: [] }],
    ['inactive professional', { resources: [{ ...rescheduleBusiness.resources[0], active: false }] }],
    ['intake catalogue', { sarinConfig: { ...rescheduleBusiness.sarinConfig, intakeFields: [{ key: 'new_question', label: 'Nueva pregunta', required: true }] } }],
  ])('preserves the source when the pending %s snapshot changes', async (_label, patch) => {
    const { db, rows } = scenario();
    const proposal = await createBookingProposal(rescheduleActor, rescheduleBusiness.id, rescheduleSelection, 'demo-catalogue-changed', db, undefined, { appointmentId: rescheduleSource.id, sourceRevision: 0 });
    await db.collection('businesses').doc(rescheduleBusiness.id).set({ ...rescheduleBusiness, ...patch });
    await expect(confirmBookingProposal(rescheduleActor, rescheduleBusiness.id, proposal.id, confirmation, db)).rejects.toMatchObject({ status: 409 });
    expect(rows.get(rescheduleSourcePath)?.data).toEqual(rescheduleSource);
    expect([...rows.keys()].filter(path => path.includes('/appointments/'))).toHaveLength(1);
  });

  it('revalidates a client block and allows the same reschedule after unblocking', async () => {
    const { db, rows } = scenario();
    const proposal = await createBookingProposal(rescheduleActor, rescheduleBusiness.id, rescheduleSelection, 'demo-block-before-confirm', db, undefined, { appointmentId: rescheduleSource.id, sourceRevision: 0 });
    await updateClientPolicy({ uid: 'demo-reschedule-owner' }, rescheduleBusiness.id, { clientUid: rescheduleActor.uid, blocked: true, reason: 'Demo client block' }, db);
    await expect(confirmBookingProposal(rescheduleActor, rescheduleBusiness.id, proposal.id, confirmation, db)).rejects.toMatchObject({ code: 'CLIENT_BLOCKED' });
    expect(rows.get(rescheduleSourcePath)?.data).toEqual(rescheduleSource);
    await updateClientPolicy({ uid: 'demo-reschedule-owner' }, rescheduleBusiness.id, { clientUid: rescheduleActor.uid, blocked: false, reason: 'Demo client release' }, db);
    const moved = await confirmBookingProposal(rescheduleActor, rescheduleBusiness.id, proposal.id, confirmation, db);
    expect(moved).toMatchObject({ id: rescheduleSource.id, startTimeStr: rescheduleSelection.startTimeStr, rescheduleRevision: 1 });
    expect(await confirmBookingProposal(rescheduleActor, rescheduleBusiness.id, proposal.id, confirmation, db)).toEqual(moved);
    expect([...rows.keys()].filter(path => path.includes('/appointments/'))).toHaveLength(1);
  });

  it.each(['suspended', 'pending_payment', 'expired'] as const)('revalidates %s subscription at confirmation without moving the source', async status => {
    const { db, rows } = scenario();
    const proposal = await createBookingProposal(rescheduleActor, rescheduleBusiness.id, rescheduleSelection, 'demo-subscription-changed', db, undefined, { appointmentId: rescheduleSource.id, sourceRevision: 0 });
    await db.collection('businesses').doc(rescheduleBusiness.id).set({ ...rescheduleBusiness, subscription: { ...rescheduleBusiness.subscription, status: status === 'expired' ? 'active' : status, currentPeriodEndsAt: status === 'expired' ? rescheduleNow : rescheduleBusiness.subscription.currentPeriodEndsAt } });
    await expect(confirmBookingProposal(rescheduleActor, rescheduleBusiness.id, proposal.id, confirmation, db)).rejects.toMatchObject({ status: 402 });
    expect(rows.get(rescheduleSourcePath)?.data).toEqual(rescheduleSource);
  });

  it.each(['account', 'business_client'] as const)('revalidates withdrawn %s consent before moving', async scope => {
    const { db, rows } = scenario();
    const proposal = await createBookingProposal(rescheduleActor, rescheduleBusiness.id, rescheduleSelection, 'demo-consent-changed', db, undefined, { appointmentId: rescheduleSource.id, sourceRevision: 0 });
    const state = await readConsent(rescheduleActor.uid, scope, scope === 'business_client' ? rescheduleBusiness : undefined, db);
    await updateConsent(rescheduleActor, { scope, ...(scope === 'business_client' ? { businessId: rescheduleBusiness.id } : {}), action: 'revoke', requestId: 'demo-revoke-consent', expectedRevision: state.revision }, db);
    await expect(confirmBookingProposal(rescheduleActor, rescheduleBusiness.id, proposal.id, confirmation, db)).rejects.toMatchObject({ status: 428 });
    expect(rows.get(rescheduleSourcePath)?.data).toEqual(rescheduleSource);
  });

  it.each([
    ['health', 'health', false],
    ['enabled minors', 'general', true],
  ] as const)('requires contact for an undeclared legacy source after policy becomes %s', async (_label, dataMode, representedMinorsEnabled) => {
    const { db, rows } = scenario();
    const proposal = await createBookingProposal(rescheduleActor, rescheduleBusiness.id, rescheduleSelection, 'demo-policy-changed', db, undefined, { appointmentId: rescheduleSource.id, sourceRevision: 0 });
    await db.collection('serverSettings').doc(bookingDataPolicyKey(rescheduleBusiness.id)).set({ version: 1, businessId: rescheduleBusiness.id, revision: 1, dataMode, representedMinorsEnabled, reason: 'Demo policy change', updatedAt: rescheduleNow, updatedBy: 'demo-admin' });
    await expect(confirmBookingProposal(rescheduleActor, rescheduleBusiness.id, proposal.id, confirmation, db)).rejects.toMatchObject({ status: 409 });
    expect(rows.get(rescheduleSourcePath)?.data).toEqual(rescheduleSource);
    expect([...rows.keys()].filter(path => /responseQuota|aiBudget|aiUsage|chatStates/.test(path))).toHaveLength(0);
  });

  it('rechecks proposal expiration after slow transaction reads', async () => {
    const { db, rows } = scenario();
    const proposal = await createBookingProposal(rescheduleActor, rescheduleBusiness.id, rescheduleSelection, 'demo-slow-expiration', db, undefined, { appointmentId: rescheduleSource.id, sourceRevision: 0 });
    const slowDb = advanceAfterRead(db, target => 'path' in target && target.path === `businesses/${rescheduleBusiness.id}/appointments`, proposal.expiresAt);
    await expect(confirmBookingProposal(rescheduleActor, rescheduleBusiness.id, proposal.id, confirmation, slowDb)).rejects.toMatchObject({ status: 409 });
    expect(rows.get(rescheduleSourcePath)?.data).toEqual(rescheduleSource);
  });

  it('rechecks the source start after slow confirmation reads', async () => {
    const { db, rows } = scenario();
    vi.setSystemTime(rescheduleSource.startAt - 1000);
    const proposal = await createBookingProposal(rescheduleActor, rescheduleBusiness.id, rescheduleSelection, 'demo-slow-source-start', db, undefined, { appointmentId: rescheduleSource.id, sourceRevision: 0 });
    const slowDb = advanceAfterRead(db, target => 'path' in target && target.path === `businesses/${rescheduleBusiness.id}/appointments`, rescheduleSource.startAt);
    await expect(confirmBookingProposal(rescheduleActor, rescheduleBusiness.id, proposal.id, confirmation, slowDb)).rejects.toMatchObject({ status: 409 });
    expect(rows.get(rescheduleSourcePath)?.data).toEqual(rescheduleSource);
  });

  it('rechecks the source start after slow proposal reads', async () => {
    const { db, rows } = scenario();
    vi.setSystemTime(rescheduleSource.startAt - 1000);
    const slowDb = advanceAfterRead(db, target => 'path' in target && target.path === `businesses/${rescheduleBusiness.id}/appointments`, rescheduleSource.startAt);
    await expect(createBookingProposal(rescheduleActor, rescheduleBusiness.id, rescheduleSelection, 'demo-slow-proposal-source', slowDb, undefined, { appointmentId: rescheduleSource.id, sourceRevision: 0 })).rejects.toMatchObject({ status: 409 });
    expect(rows.get(rescheduleSourcePath)?.data).toEqual(rescheduleSource);
  });

  it.each([rescheduleNow - 1, rescheduleNow])('rejects client cancellation after the source starts at %s', async startAt => {
    const source = { ...rescheduleSource, startAt };
    const { db, rows } = scenario(rescheduleBusiness, source);
    await expect(cancelAppointment(rescheduleActor, rescheduleBusiness.id, source.id, db)).rejects.toMatchObject({ status: 409 });
    expect(rows.get(rescheduleSourcePath)?.data).toEqual(source);
  });

  it('rechecks client cancellation start after reading both locks', async () => {
    const { db, rows } = scenario();
    vi.setSystemTime(rescheduleSource.startAt - 1000);
    const slowDb = advanceAfterRead(db, target => 'path' in target && typeof target.path === 'string' && target.path.includes('/bookingLocks/client_'), rescheduleSource.startAt);
    await expect(cancelAppointment(rescheduleActor, rescheduleBusiness.id, rescheduleSource.id, slowDb)).rejects.toMatchObject({ status: 409 });
    expect(rows.get(rescheduleSourcePath)?.data).toEqual(rescheduleSource);
  });

  it('preserves cancelled replay and owner retrospective cancellation', async () => {
    const source = { ...rescheduleSource, startAt: rescheduleNow - 1, status: 'cancelled_by_client' as const };
    const { db, rows } = scenario(rescheduleBusiness, source);
    await expect(cancelAppointment(rescheduleActor, rescheduleBusiness.id, source.id, db)).resolves.toMatchObject({ status: 'cancelled_by_client' });
    await db.collection('businesses').doc(rescheduleBusiness.id).collection('appointments').doc(source.id).set({ ...source, status: 'confirmed' });
    await expect(cancelAppointment({ uid: 'demo-reschedule-owner' }, rescheduleBusiness.id, source.id, db)).resolves.toMatchObject({ status: 'cancelled_by_owner' });
    expect(rows.get(rescheduleSourcePath)?.data).toMatchObject({ status: 'cancelled_by_owner' });
  });
});
