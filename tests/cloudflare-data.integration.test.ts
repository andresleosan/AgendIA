import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDataTestRuntime } from '../cloudflare/tests/data-runtime.mjs';
import { createCloudflareDatabase, StorageError } from '../src/lib/storage/database';
import type { DataCommand, DataCommitResult, DataReadResult } from '../shared/data-protocol';
import type { Database } from '../src/lib/storage/types';
import type { Business } from '../src/types/firestore';
import type { DecodedIdToken } from 'firebase-admin/auth';
import { cancelAppointment, createAppointment, readAppointments } from '../src/lib/server/bookings';
import { businessIdForOwner, createBusiness, publicBusiness } from '../src/lib/server/businesses';
import { readReceiptImage, readReceipts, reviewPayment, submitReceipt } from '../src/lib/server/billing';
import { commitResponseQuota, getResponseQuota, releaseResponseQuota, reserveResponseQuota as reserveQuota } from '../src/lib/server/response-quota';
import { markResponseQuotaDispatch } from '@/lib/server/response-quota-store';
import { seedQuotaProtocol } from './response-quota-fixtures';
const reserveResponseQuota: typeof reserveQuota = async (input, db, authorize) => { await seedQuotaProtocol(db!); return reserveQuota(input, db, authorize, { deadlineAt: Date.now() + 300000 }); };
import { businessConfigSchema } from '../src/lib/server/schemas';
import { verifyInvitationLifecycle } from './invitation-contract';
import { listInvitations } from '@/lib/server/invitations';
import { normalizeBusinessLogo, readPublicBusinessLogo, saveBusinessLogo } from '@/lib/server/business-logos';
import sharp from 'sharp';
import { updateClientPolicy } from '@/lib/server/client-policy';
import { readChatState, saveChatState } from '@/lib/server/chat-state';
import { DEFAULT_AI_BUDGET_LIMITS, saveAiBudgetSettings, reservePaidCallBudget, settlePaidCallBudget } from '@/lib/server/ai-budget';
import { quotePaidCall } from '@/lib/server/ai-pricing';
import { randomUUID } from 'node:crypto';
import { acceptSyntheticConsent } from './consent-fixtures';

const now = Date.now();
const dateKey = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now + 3 * 86400000);
const config = { name: 'Negocio sintético', category: 'Servicios', phoneWhatsApp: '573001234567', intakeFields: [], resources: [{ id: 'one', name: 'Uno', active: true }, { id: 'two', name: 'Dos', active: true }], services: [{ id: 'cut', name: 'Corte', durationMinutes: 30, bufferMinutes: 15, price: 20000, resourceIds: ['one', 'two'] }], weeklySchedule: Object.fromEntries(Array.from({ length: 7 }, (_, day) => [String(day), { isOpen: true, intervals: [{ start: '09:00', end: '17:00' }] }])) };
const input = { dateKey, startTimeStr: '10:00', serviceId: 'cut', resourceId: 'one', clientPhone: '573001234567', intakeAnswers: {} };
function business(id: string, used?: number): Business {
  return { ...config, id, slug: id, ownerUid: `owner-${id}`, ownerEmail: 'owner@example.test', timezone: 'America/Bogota', sarinConfig: { onboardingCompleted: true, tone: '', customRules: '', intakeFields: [] }, subscription: used === undefined ? { status: 'active', trialEndsAt: 0, currentPeriodEndsAt: now + 30 * 86400000 } : { status: 'trial', trialEndsAt: 0, currentPeriodEndsAt: 0, paidTrial: { paymentId: 'synthetic-paid', activatedAt: now, appointmentLimit: 10, appointmentsUsed: used } }, createdAt: now };
}

// Existing business rules exercised through the new adapter AND actual local
// Workerd/D1/R2. This is integration characterization, not a Firestore mock.
describe('commercial invariants on Cloudflare data', () => {
  let runtime: Awaited<ReturnType<typeof createDataTestRuntime>>;
  let db: Database;
  beforeAll(async () => {
    runtime = await createDataTestRuntime();
    db = createCloudflareDatabase(async (command: DataCommand): Promise<DataReadResult | DataCommitResult> => {
      const response = await runtime.fetch(command);
      const body = await response.json() as DataReadResult | DataCommitResult | { code: string };
      if (!response.ok) throw new StorageError(response.status, (body as { code: string }).code);
      return body as DataReadResult | DataCommitResult;
    });
  }, 30_000);
  afterAll(async () => { await runtime?.dispose(); });
  it('reserves the final cloud budget atomically across D1 handles and retains unknown usage', async () => {
    const { vi } = await import('vitest'); vi.stubEnv('SUPERADMIN_UID', 'budget-admin');
    try {
      const quote = quotePaidCall({ provider: 'deepseek', model: 'deepseek-flash', requestBytes: 4000, maxOutputTokens: 4096 });
      await saveAiBudgetSettings({ uid: 'budget-admin' }, { expectedVersion: 0, paused: false, reason: 'Synthetic last slot', limits: { ...DEFAULT_AI_BUDGET_LIMITS, businessDayUsd: quote.maxCostNanoUsd / 1e9 } }, db);
      const second = createCloudflareDatabase(async command => {
        const response = await runtime.fetch(command), body = await response.json() as DataReadResult | DataCommitResult;
        if (!response.ok) throw new StorageError(response.status, (body as unknown as { code: string }).code); return body;
      });
      const input = () => ({ ...quote, callId: randomUUID(), provider: 'deepseek' as const, model: 'deepseek-flash', businessId: 'budget-business', actorUid: 'budget-client', mode: 'sarin_client' as const, requestId: 'synthetic-budget' });
      const results = await Promise.allSettled([reservePaidCallBudget(input(), db), reservePaidCallBudget(input(), second)]);
      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { code: 'AI_BUDGET_EXHAUSTED' } });
      const winner = results.find(result => result.status === 'fulfilled')!;
      if (winner.status !== 'fulfilled') throw new Error('Expected winner');
      const reservation = winner.value;
      await settlePaidCallBudget(reservation, { callId: reservation.callId, provider: 'deepseek', model: 'deepseek-flash', startedAt: Date.now(), finishedAt: Date.now(), success: false, usage: null }, second);
      await expect(reservePaidCallBudget(input(), db)).rejects.toMatchObject({ code: 'AI_BUDGET_EXHAUSTED' });
      expect((await second.collection('aiBudgetCalls').doc(reservation.callId).get()).data()?.status).toBe('uncertain');
    } finally { vi.unstubAllEnvs(); }
  });
  it('persists only scoped structured selections across D1 handles', async () => {
    const scope = { actorUid: 'state-client', businessId: 'state-business', mode: 'sarin_client' as const, channel: 'web' as const };
    await saveChatState(scope, 0, { serviceId: 'cut', dateKey }, db);
    expect(await readChatState(scope, db)).toMatchObject({ version: 1, selection: { serviceId: 'cut', dateKey } });
    await expect(saveChatState(scope, 0, {}, db)).rejects.toMatchObject({ code: 'CHAT_STATE_CONFLICT' });
    expect((await readChatState({ ...scope, actorUid: 'other' }, db)).selection).toEqual({});
  });
  it('serializes client limits across independent D1 handles and keeps policies private', async () => {
    const value = business('client-policy');
    await db.collection('businesses').doc(value.id).set(value);
    await db.collection('publicBusinesses').doc(value.slug).set(publicBusiness(value));
    await acceptSyntheticConsent(db, value.ownerUid);
    await acceptSyntheticConsent(db, 'limited-client', value);
    const secondDb = createCloudflareDatabase(async (command: DataCommand) => {
      const response = await runtime.fetch(command), body = await response.json() as DataReadResult | DataCommitResult;
      if (!response.ok) throw new StorageError(response.status, (body as unknown as { code: string }).code);
      return body;
    });
    await updateClientPolicy({ uid: value.ownerUid }, value.id, { futureAppointmentLimit: 1, reason: 'Capacidad sintética' }, db);
    const results = await Promise.allSettled([createAppointment({ uid: 'limited-client' }, value.id, input, 'policy-one', db), createAppointment({ uid: 'limited-client' }, value.id, { ...input, resourceId: 'two' }, 'policy-two', secondDb)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { code: 'CLIENT_BOOKING_LIMIT' } });
    expect(JSON.stringify((await db.collection('publicBusinesses').doc(value.slug).get()).data())).not.toContain('Capacidad sintética');
    await updateClientPolicy({ uid: value.ownerUid }, value.id, { clientUid: 'limited-client', blocked: true, reason: 'Revisión sintética' }, db);
    await expect(createAppointment({ uid: 'limited-client' }, value.id, input, 'policy-blocked', secondDb)).rejects.toMatchObject({ code: 'CLIENT_BLOCKED' });
  });
  it('normalizes a business logo through D1/R2 and binds public reads to its current digest', async () => {
    const owner = { uid: 'logo-owner' }, id = businessIdForOwner(owner.uid);
    const value = { ...business(id), slug: 'logo-synthetic', ownerUid: owner.uid };
    await db.collection('businesses').doc(id).set(value);
    await acceptSyntheticConsent(db, owner.uid);
    const png = await sharp({ create: { width: 120, height: 60, channels: 4, background: '#315ff3' } }).png().toBuffer();
    const input = `data:image/png;base64,${png.toString('base64')}`;
    const saved = await saveBusinessLogo(owner, { logoDataUrl: input, expectedSha256: null }, db);
    const stored = await runtime.db.prepare('SELECT data,blob FROM app_documents WHERE path=?').bind(`businessLogos/${id}_${saved.logo!.sha256}`).first();
    expect(stored!.data).not.toContain('base64');
    expect(JSON.parse(stored!.blob as string).key).toBe(`business-logos/${saved.logo!.sha256}`);
    expect(Buffer.from(await readPublicBusinessLogo(value.slug, saved.logo!.sha256, db)).toString('base64')).toBe((await normalizeBusinessLogo(input)).dataUrl.split(',')[1]);
    await saveBusinessLogo(owner, { logoDataUrl: null, expectedSha256: saved.logo!.sha256 }, db);
    await expect(readPublicBusinessLogo(value.slug, saved.logo!.sha256, db)).rejects.toMatchObject({ status: 404 });
  });

  it('preserves invitation access, quota, suspension and concurrent payment invariants on actual D1', async () => {
    await db.collection('platformSettings').doc('main').set({ bankAccounts: [{ id: 'bank', bankName: 'Test', accountType: 'Ahorros', accountNumber: '000', holderName: 'Test' }] });
    await verifyInvitationLifecycle(db, businessConfigSchema.parse({ ...config, slug: 'synthetic-invitation' }), dateKey);
  }, 75000);

  it('paginates 51 equal-date invitations without duplicates using a string cursor on D1', async () => {
    const { vi } = await import('vitest');
    vi.stubEnv('SUPERADMIN_UID', 'pagination-admin');
    try {
      for (const document of (await db.collection('invitations').get()).docs) await db.collection('invitations').doc(document.id).delete();
      for (let index = 0; index < 51; index++) {
        const id = index.toString(16).padStart(24, '0');
        await db.collection('invitations').doc(id).set({ id, recipientEmail: 'synthetic@example.test', createdAt: now, expiresAt: now + 86400000, state: 'issued', version: 0, codeHash: 'a'.repeat(64), createFingerprint: 'b'.repeat(64), maskedCode: 'SARIN-…test', createdBy: 'pagination-admin', expiresInDays: 1 });
      }
      const admin = { uid: 'pagination-admin' } as DecodedIdToken;
      const first = await listInvitations(admin, undefined, db), second = await listInvitations(admin, first.nextCursor!, db);
      expect(first.invitations).toHaveLength(50); expect(second.invitations).toHaveLength(1);
      expect(second.nextCursor).toBeNull();
      expect(new Set([...first.invitations, ...second.invitations].map(item => item.id)).size).toBe(51);
    } finally { vi.unstubAllEnvs(); }
  }, 75000);

  it('confirms only one overlapping booking and scopes client reads/cancellation', async () => {
    const value = business('conflict');
    await db.collection('businesses').doc(value.id).set(value);
    const actors = [{ uid: 'alice', email: 'alice@example.test' }, { uid: 'bob', email: 'bob@example.test' }];
    for (const actor of actors) await acceptSyntheticConsent(db, actor.uid, value);
    const results = await Promise.allSettled(actors.map((actor, index) => createAppointment(actor, value.id, input, `parallel-${index}`, db)));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { status: 409 } });
    const winner = results.find(result => result.status === 'fulfilled')!;
    if (winner.status !== 'fulfilled') throw new Error('Expected winner');
    const owner = { uid: value.ownerUid };
    const appointment = winner.value;
    const loser = actors.find(actor => actor.uid !== appointment.client!.uid)!;
    expect(await readAppointments(value.id, dateKey, loser, db)).toEqual([]);
    await expect(cancelAppointment(loser, value.id, appointment.id, db)).rejects.toMatchObject({ status: 403 });
    expect(await readAppointments(value.id, dateKey, owner, db)).toHaveLength(1);
    expect(await cancelAppointment({ uid: appointment.client!.uid }, value.id, appointment.id, db)).toMatchObject({ status: 'cancelled_by_client' });
    expect(await readAppointments(value.id, dateKey, { uid: appointment.client!.uid }, db)).toHaveLength(1);
  });

  it('consumes the tenth trial unit once across different resources and preserves idempotent retries', async () => {
    const value = business('last-unit', 9);
    await db.collection('businesses').doc(value.id).set(value);
    await acceptSyntheticConsent(db, 'first', value);
    await acceptSyntheticConsent(db, 'second', value);
    const results = await Promise.allSettled([
      createAppointment({ uid: 'first' }, value.id, input, 'last-one', db),
      createAppointment({ uid: 'second' }, value.id, { ...input, resourceId: 'two' }, 'last-two', db),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { status: 402 } });
    expect((await db.collection('businesses').doc(value.id).get()).data()?.subscription.paidTrial.appointmentsUsed).toBe(10);
    const publicRow = (await db.collection('publicBusinesses').doc(value.slug).get()).data();
    expect(publicRow?.subscription.paidTrial.appointmentsUsed).toBe(10);
    expect(JSON.stringify(publicRow)).not.toContain('synthetic-paid');
    const winner = results.find(result => result.status === 'fulfilled')!;
    if (winner.status !== 'fulfilled') throw new Error('Expected winner');
    const saved = winner.value;
    const uid = saved.client!.uid;
    expect((await createAppointment({ uid }, value.id, { ...input, resourceId: saved.resourceId }, uid === 'first' ? 'last-one' : 'last-two', db)).id).toBe(saved.id);
  });

  it('stores receipt bytes in private R2 and atomically approves the paid trial once', async () => {
    const owner = { uid: 'paying-owner', email: 'owner@example.test' } as DecodedIdToken;
    await acceptSyntheticConsent(db, owner.uid);
    await db.collection('platformSettings').doc('main').set({ bankAccounts: [{ id: 'bank', bankName: 'Banco sintético', accountType: 'Ahorros', accountNumber: 'TEST-ONLY', holderName: 'Pruebas' }] });
    const image = `data:image/webp;base64,${Buffer.from('RIFFxxxxWEBPfixture').toString('base64')}`;
    const request = { kind: 'paid_trial' as const, bankSelected: 'bank', requestId: 'synthetic-paid-upload', receiptDataUrl: image };
    const [one, repeated] = await Promise.all([submitReceipt(owner, request, db), submitReceipt(owner, request, db)]);
    expect(one.receipt.id).toBe(repeated.receipt.id);
    const stored = await runtime.db.prepare('SELECT data,blob FROM app_documents WHERE path=?').bind(`paymentImages/${one.receipt.id}`).first();
    expect(stored!.data).not.toContain('base64');
    expect(JSON.parse(stored!.blob as string).key).toMatch(/^payment-images\/[a-f0-9]{64}$/);
    expect(await readReceiptImage(owner, one.receipt.id, db)).toBe(image);
    await expect(readReceiptImage({ uid: 'outsider' } as DecodedIdToken, one.receipt.id, db)).rejects.toMatchObject({ status: 403 });
    expect(JSON.stringify(await readReceipts(owner.uid, db))).not.toContain('base64');
    await Promise.all([reviewPayment(one.receipt.id, 'approve', undefined, db), reviewPayment(one.receipt.id, 'approve', undefined, db)]);
    expect((await db.collection('businesses').doc(businessIdForOwner(owner.uid)).get()).data()?.subscription.paidTrial.appointmentsUsed).toBe(0);
    await createBusiness(owner, businessConfigSchema.parse({ ...config, slug: 'cloudflare-paid-trial', tone: '', customRules: '' }), db);
    expect((await db.collection('businessSlugs').doc('cloudflare-paid-trial').get()).data()?.ownerUid).toBe(owner.uid);
  });

  it('reserves the final AI response once and settles/releases counters without duplication', async () => {
    const value = business('quota');
    await db.collection('businesses').doc(value.id).set(value);
    await db.collection('responseQuotaScopes').doc(`business_${value.id}`).set({ initializedAt: now });
    await db.collection('responseQuotaScopes').doc(`business_${value.id}`).collection('periods').doc('initial').set({ id: 'initial', source: 'subscription', planId: 'monthly', startsAt: now - 1, endsAt: now + 86400000, includedResponses: 1, extraResponses: 0, usedResponses: 0, reservedResponses: 0 });
    const request = { businessId: value.id, actorUid: 'alice', mode: 'sarin_client' as const, requestId: 'quota-one', fingerprint: 'a'.repeat(64), channel: 'web' as const };
    const results = await Promise.allSettled([reserveResponseQuota(request, db), reserveResponseQuota({ ...request, actorUid: 'bob', requestId: 'quota-two' }, db)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const winner = results.find(result => result.status === 'fulfilled')!;
    if (winner.status !== 'fulfilled') throw new Error('Expected winner');
    const reservation = winner.value.reservation;
    await releaseResponseQuota(reservation, db);
    await releaseResponseQuota(reservation, db);
    expect((await getResponseQuota(value.id, db)).currentPeriod?.remainingResponses).toBe(1);
    const reserved = await reserveResponseQuota({ ...request, requestId: 'quota-three' }, db);
    await markResponseQuotaDispatch(reserved.reservation, request.fingerprint, { providerCallId: null }, db);
    await commitResponseQuota(reserved.reservation, undefined, db);
    await commitResponseQuota(reserved.reservation, undefined, db);
    expect((await getResponseQuota(value.id, db)).currentPeriod).toMatchObject({ remainingResponses: 0, usedResponses: 1, reservedResponses: 0 });
  });
});
