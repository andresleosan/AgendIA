import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Business } from '@/types/firestore';
import { reserveResponseQuota as reserveQuota, commitResponseQuota as completeQuota, releaseResponseQuota, getResponseQuota } from '@/lib/server/response-quota';
import { markResponseQuotaDispatch } from '@/lib/server/response-quota-store';
import { quotaProtocolEntries } from './response-quota-fixtures';
import { memoryFirestore } from './memoryFirestore';

const now = Date.parse('2030-01-01T12:00:00Z');
const day = 86400000;
const business: Business = { id: 'business', ownerUid: 'owner', ownerEmail: 'owner@example.test', name: 'Fixture', category: 'Services', phoneWhatsApp: '573001234567', timezone: 'America/Bogota', slug: 'fixture', subscription: { status: 'trial', trialEndsAt: 0, currentPeriodEndsAt: 0, paidTrial: { paymentId: 'approved', activatedAt: now, appointmentLimit: 10, appointmentsUsed: 0 } }, sarinConfig: { onboardingCompleted: true, tone: '', customRules: '', intakeFields: [] }, resources: [], services: [], weeklySchedule: {}, createdAt: now };
const input = { businessId: 'business', actorUid: 'client', mode: 'sarin_client' as const, channel: 'web' as const, requestId: 'request-one', fingerprint: 'a'.repeat(64) };
const memory = () => memoryFirestore({ ...quotaProtocolEntries, 'businesses/business': business as unknown as Record<string, unknown> });
const reserveResponseQuota: typeof reserveQuota = (input, db, authorize) => reserveQuota(input, db, authorize, { deadlineAt: Date.now() + 300000 });
const commitResponseQuota: typeof completeQuota = async (reservation, response, db) => {
  const saved = (await db!.collection('responseQuotaTurns').doc(reservation.reservationId).get()).data()!;
  if (saved.status === 'reserved' && !saved.execution?.mayHaveDispatched) await markResponseQuotaDispatch(reservation, saved.fingerprint, { providerCallId: null }, db);
  return completeQuota(reservation, response, db);
};
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); });
afterEach(() => { vi.useRealTimers(); });

describe('response quota reservations', () => {
  it('reserves one response for a full turn and commits it once without storing conversation content', async () => {
    const { db, rows } = memory();
    const first = await reserveResponseQuota(input, db);
    expect(first.kind).toBe('reserved');
    expect((await getResponseQuota('business', db)).currentPeriod).toMatchObject({ includedResponses: 700, usedResponses: 0, reservedResponses: 1, remainingResponses: 699 });
    await commitResponseQuota(first.reservation, { reply: 'Private reply must not persist', toolResults: [] }, db);
    await commitResponseQuota(first.reservation, undefined, db);
    expect((await getResponseQuota('business', db)).currentPeriod).toMatchObject({ usedResponses: 1, reservedResponses: 0, remainingResponses: 699 });
    expect(await reserveResponseQuota(input, db)).toMatchObject({ kind: 'replay', response: null });
    expect(JSON.stringify([...rows.entries()])).not.toContain('Private reply');
  });
  it('rejects simultaneous duplicate execution and changed request bodies, then permits a released failure to retry', async () => {
    const { db } = memory();
    const attempts = await Promise.allSettled([reserveResponseQuota(input, db), reserveResponseQuota(input, db)]);
    expect(attempts.filter(value => value.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.find(value => value.status === 'rejected')).toMatchObject({ reason: { status: 409, code: 'AI_RESPONSE_PENDING' } });
    await expect(reserveResponseQuota({ ...input, fingerprint: 'b'.repeat(64) }, db)).rejects.toMatchObject({ status: 409, code: 'AI_REQUEST_CONFLICT' });
    const first = attempts.find(value => value.status === 'fulfilled');
    if (first?.status !== 'fulfilled') throw new Error('Expected one reservation');
    await releaseResponseQuota(first.value.reservation, db);
    const retry = await reserveResponseQuota(input, db);
    expect(retry.kind).toBe('reserved');
    await commitResponseQuota(retry.reservation, undefined, db);
    expect((await getResponseQuota('business', db)).currentPeriod).toMatchObject({ usedResponses: 1, reservedResponses: 0 });
  });
  it('allows only one concurrent caller to reserve the final introductory response', async () => {
    const { db } = memory();
    const first = await reserveResponseQuota(input, db);
    await releaseResponseQuota(first.reservation, db);
    await db.collection('responseQuotaScopes').doc(first.reservation.scopeId).collection('periods').doc(first.reservation.periodId).set({ ...(await db.collection('responseQuotaScopes').doc(first.reservation.scopeId).collection('periods').doc(first.reservation.periodId).get()).data(), usedResponses: 699 });
    const attempts = await Promise.allSettled([
      reserveResponseQuota({ ...input, requestId: 'last-client' }, db),
      reserveResponseQuota({ ...input, actorUid: 'another-client', requestId: 'last-other' }, db),
    ]);
    expect(attempts.filter(value => value.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.find(value => value.status === 'rejected')).toMatchObject({ reason: { status: 402, code: 'AI_QUOTA_EXHAUSTED' } });
    expect((await getResponseQuota('business', db)).state).toBe('exhausted');
  });
  it('rejects onboarding before a paid business exists without allocating a free response scope', async () => {
    const { db, rows } = memoryFirestore();
    await expect(reserveResponseQuota({ ...input, businessId: null, actorUid: 'new-owner', mode: 'sarin_onboarding' }, db)).rejects.toMatchObject({ status: 402 });
    expect(rows.size).toBe(0);
    await expect(reserveResponseQuota({ ...input, businessId: null }, db)).rejects.toMatchObject({ status: 403 });
  });
  it('denies owner copilot and WhatsApp to the introductory offer', async () => {
    const { db } = memoryFirestore();
    await db.collection('businesses').doc('business').set(business as unknown as Record<string, unknown>);
    await expect(reserveResponseQuota({ ...input, actorUid: 'owner', mode: 'sarin_owner_copilot' }, db)).rejects.toMatchObject({ status: 402, code: 'OWNER_AI_REQUIRES_SUBSCRIPTION' });
    await expect(reserveResponseQuota({ ...input, channel: 'whatsapp' }, db)).rejects.toMatchObject({ status: 402, code: 'WHATSAPP_UNAVAILABLE' });
  });
  it('does not reset a trial through reads, grace, or an owner configuration change', async () => {
    const { db, rows } = memory();
    expect((await getResponseQuota('business', db)).currentPeriod?.includedResponses).toBe(700);
    expect(rows.size).toBe(2);
    const first = await reserveResponseQuota(input, db);
    await commitResponseQuota(first.reservation, undefined, db);
    vi.setSystemTime(now + 8 * day);
    await db.collection('businesses').doc('business').set({ ...business, name: 'Changed', subscription: { ...business.subscription, graceEndsAt: now + 9 * day } });
    expect((await getResponseQuota('business', db)).currentPeriod).toMatchObject({ includedResponses: 700, usedResponses: 1 });
    const next = await reserveResponseQuota({ ...input, requestId: 'grace-request' }, db);
    await commitResponseQuota(next.reservation, undefined, db);
    expect((await getResponseQuota('business', db)).currentPeriod?.usedResponses).toBe(2);
  });
  it('replays a paid onboarding turn against its original business allowance', async () => {
    const { db } = memory();
    const setup = { ...input, actorUid: 'owner', mode: 'sarin_onboarding' as const };
    const first = await reserveResponseQuota(setup, db);
    await commitResponseQuota(first.reservation, { reply: 'Guardado.' }, db);
    expect(await reserveResponseQuota({ ...setup, businessId: 'business' }, db)).toMatchObject({ kind: 'replay', reservation: first.reservation, response: null });
    expect((await getResponseQuota('business', db)).currentPeriod?.usedResponses).toBe(1);
  });
  it('warns at eighty percent and never frees a pending response just because time passed', async () => {
    const { db } = memory();
    const first = await reserveResponseQuota(input, db);
    await releaseResponseQuota(first.reservation, db);
    const reference = db.collection('responseQuotaScopes').doc(first.reservation.scopeId).collection('periods').doc(first.reservation.periodId);
    await reference.set({ ...(await reference.get()).data(), usedResponses: 559 });
    expect((await getResponseQuota('business', db)).state).toBe('active');
    const next = await reserveResponseQuota({ ...input, requestId: 'warning-response' }, db);
    await commitResponseQuota(next.reservation, undefined, db);
    expect((await getResponseQuota('business', db)).state).toBe('warning');
    await reserveResponseQuota({ ...input, requestId: 'pending-response' }, db);
    vi.setSystemTime(now + 86400000);
    await expect(reserveResponseQuota({ ...input, requestId: 'pending-response' }, db)).rejects.toMatchObject({ code: 'AI_RESPONSE_PENDING' });
    expect((await getResponseQuota('business', db)).currentPeriod?.reservedResponses).toBe(1);
  });
  it('does not let an old handle release a newer attempt or another actor reuse a completed turn', async () => {
    const { db } = memory();
    const first = await reserveResponseQuota(input, db);
    await releaseResponseQuota(first.reservation, db);
    const second = await reserveResponseQuota(input, db);
    await expect(releaseResponseQuota(first.reservation, db)).rejects.toMatchObject({ code: 'AI_REQUEST_CONFLICT' });
    await commitResponseQuota(second.reservation, undefined, db);
    const another = await reserveResponseQuota({ ...input, actorUid: 'another-client' }, db);
    expect(another.kind).toBe('reserved');
    expect((await getResponseQuota('business', db)).currentPeriod).toMatchObject({ usedResponses: 1, reservedResponses: 1 });
    await expect(reserveResponseQuota({ ...input, actorUid: 'stranger', mode: 'sarin_owner_copilot' }, db)).rejects.toMatchObject({ status: 403 });
  });
  it('cannot commit a released reservation but can settle an in-flight turn after appointment exhaustion', async () => {
    const { db } = memory();
    const released = await reserveResponseQuota(input, db);
    await releaseResponseQuota(released.reservation, db);
    await expect(commitResponseQuota(released.reservation, undefined, db)).rejects.toMatchObject({ status: 409 });
    const inFlight = await reserveResponseQuota({ ...input, requestId: 'long-response' }, db);
    await markResponseQuotaDispatch(inFlight.reservation, input.fingerprint, { providerCallId: null }, db);
    vi.setSystemTime(now + 8 * day);
    await db.collection('businesses').doc('business').set({ ...business, subscription: { ...business.subscription, paidTrial: { ...business.subscription.paidTrial!, appointmentsUsed: 10 } } });
    await commitResponseQuota(inFlight.reservation, undefined, db);
    expect(await getResponseQuota('business', db)).toMatchObject({ state: 'expired', currentPeriod: { usedResponses: 1, reservedResponses: 0 } });
  });
  it('recognizes a legacy paid subscription even when its end equals the old trial end', async () => {
    const legacyEnd = now + 7 * day;
    const { db } = memoryFirestore({ 'businesses/business': { ...business, subscription: { status: 'active', currentPeriodEndsAt: legacyEnd, trialEndsAt: legacyEnd } } });
    expect((await getResponseQuota('business', db)).currentPeriod).toMatchObject({ source: 'legacy', includedResponses: 3000, endsAt: legacyEnd });
  });
});
