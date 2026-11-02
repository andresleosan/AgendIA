import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryFirestore } from './memoryFirestore';
import { seedQuotaProtocol } from './response-quota-fixtures';
const state = vi.hoisted(() => ({ db: undefined as unknown, complete: vi.fn(), queue: vi.fn() }));
vi.mock('@/lib/firebase/admin', () => ({ getAdminDb: () => state.db }));
vi.mock('@/lib/sarin/engine', async original => ({ ...await original<typeof import('@/lib/sarin/engine')>(), completeChat: async (...args: Parameters<typeof import('@/lib/sarin/engine')['completeChat']>) => { await args[2]?.beforeDispatch?.({ provider: 'ollama', providerCallId: null }); return state.complete(...args); } }));
vi.mock('@/lib/sarin/queue', () => ({ runInSarinQueue: state.queue }));
import { runSarinChat } from '@/lib/server/chat';
import { createAppointment, cancelAppointment, createManualBlock } from '@/lib/server/bookings';
import { createBookingProposal, confirmBookingProposal } from '@/lib/server/booking-proposals';
import { createBusiness, businessIdForOwner, privateBusinessDraft } from '@/lib/server/businesses';
import { redeemInvitation } from '@/lib/server/invitations';
import { preauthorizeAccount, readConsent, updateConsent } from '@/lib/server/consent';
import { consentStateKey } from '@/lib/server/consent';
import type { Database } from '@/lib/storage/types';
import { submitReceipt } from '@/lib/server/billing';
import { saveBusinessLogo } from '@/lib/server/business-logos';
import { updateClientPolicy } from '@/lib/server/client-policy';
import type { Business } from '@/types/firestore';
import type { ConsentScope } from '@/lib/legal';
const now = Date.parse('2030-01-01T12:00:00Z'), owner = { uid: 'owner' }, client = { uid: 'client' };
const business: Business = { ...privateBusinessDraft(owner, now), id: businessIdForOwner('owner'), name: 'Prueba', phoneWhatsApp: '573001234567', slug: 'prueba', subscription: { status: 'active', trialEndsAt: 0, currentPeriodEndsAt: now + 864000000 }, sarinConfig: { onboardingCompleted: true, tone: '', customRules: '', intakeFields: [] }, resources: [{ id: 'one', name: 'Uno', active: true }], services: [{ id: 'cut', name: 'Corte', durationMinutes: 30, bufferMinutes: 0, price: 20000, resourceIds: ['one'] }], weeklySchedule: { 1: { isOpen: true, intervals: [{ start: '09:00', end: '17:00' }] } } };
const selection = { serviceId: 'cut', resourceId: 'one', dateKey: '2030-01-07', startTimeStr: '09:00' }, contact = { clientPhone: '573001234567', intakeAnswers: {} };
type Db = ReturnType<typeof memoryFirestore>['db'];
async function allow(db: Db, user = client, customer = true) {
  const account = await readConsent(user.uid, 'account', undefined, db);
  await updateConsent(user, { scope: 'account', action: 'accept', requestId: 'allow-account', expectedRevision: 0, fingerprint: account.documents.fingerprint, termsAccepted: true, dataAuthorized: true, preauthorization: preauthorizeAccount({ fingerprint: account.documents.fingerprint, termsAccepted: true, dataAuthorized: true }).token }, db);
  if (customer) { const current = await readConsent(user.uid, 'business_client', business, db); await updateConsent(user, { scope: 'business_client', businessId: business.id, action: 'accept', requestId: 'allow-business', expectedRevision: 0, fingerprint: current.documents.fingerprint, termsAccepted: true, dataAuthorized: true }, db); }
}
describe('consent before new processing', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); vi.stubEnv('SARIN_CHAT_PROVIDER', 'ollama'); state.complete.mockReset(); state.queue.mockReset().mockImplementation(async job => job()); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
  it('does not let platform support acceptance authorize commercial inference, quota or booking mutations', async () => {
    const { db, rows } = memoryFirestore({ [`businesses/${business.id}`]: { ...business } }); state.db = db; await allow(db, client, false);
    const scope = 'platform_support' as ConsentScope;
    const current = await readConsent(client.uid, scope, undefined, db);
    await updateConsent(client, { scope, action: 'accept', requestId: 'allow-support-only', expectedRevision: 0, fingerprint: current.documents.fingerprint, termsAccepted: true, dataAuthorized: true }, db);
    const before = structuredClone([...rows]);
    await expect(runSarinChat({ user: client, body: { mode: 'sarin_client', tenantId: business.id, requestId: 'support-not-chat', messages: [{ role: 'user', content: 'Servicios' }] } })).rejects.toMatchObject({ code: 'CONSENT_REQUIRED' });
    await expect(createBookingProposal(client, business.id, selection, 'support-not-proposal', db)).rejects.toMatchObject({ code: 'CONSENT_REQUIRED' });
    await expect(createAppointment(client, business.id, { ...selection, ...contact }, 'support-not-booking', db)).rejects.toMatchObject({ code: 'CONSENT_REQUIRED' });
    expect(state.complete).not.toHaveBeenCalled(); expect([...rows]).toEqual(before);
  });
  it('blocks direct chat before inference, admission or quota writes', async () => {
    const { db, rows } = memoryFirestore({ [`businesses/${business.id}`]: { ...business } }); state.db = db;
    await expect(runSarinChat({ user: client, body: { mode: 'sarin_client', tenantId: business.id, requestId: 'no-consent', messages: [{ role: 'user', content: 'Servicios' }] } })).rejects.toMatchObject({ code: 'CONSENT_REQUIRED' });
    expect(state.complete).not.toHaveBeenCalled(); expect([...rows.keys()]).toEqual([`businesses/${business.id}`]);
  });
  it('requires account plus the concrete business for proposal and direct booking creation', async () => {
    const { db, rows } = memoryFirestore({ [`businesses/${business.id}`]: { ...business } });
    await expect(createBookingProposal(client, business.id, selection, 'no-proposal', db)).rejects.toMatchObject({ code: 'CONSENT_REQUIRED' });
    await allow(db, client, false);
    await expect(createAppointment(client, business.id, { ...selection, ...contact }, 'no-booking', db)).rejects.toMatchObject({ code: 'CONSENT_REQUIRED' });
    expect([...rows.keys()].some(path => path.startsWith('bookingProposals/') || path.includes('/appointments/'))).toBe(false);
  });
  it('preserves confirmation recovery and cancellation after revocation, while denying a new reservation', async () => {
    const { db } = memoryFirestore({ [`businesses/${business.id}`]: { ...business } }); await allow(db);
    const first = await createBookingProposal(client, business.id, selection, 'first-proposal', db);
    const second = await createBookingProposal(client, business.id, { ...selection, startTimeStr: '10:00' }, 'second-proposal', db);
    const appointment = await confirmBookingProposal(client, business.id, first.id, contact, db);
    await updateConsent(client, { scope: 'business_client', businessId: business.id, action: 'revoke', requestId: 'withdraw-now', expectedRevision: 1 }, db);
    await expect(confirmBookingProposal(client, business.id, second.id, contact, db)).rejects.toMatchObject({ code: 'CONSENT_REQUIRED' });
    await cancelAppointment(client, business.id, appointment.id, db);
    expect(await confirmBookingProposal(client, business.id, first.id, {} as never, db)).toMatchObject({ id: appointment.id, status: 'cancelled_by_client' });
  });
  it('blocks new owner configuration, manual blocks and invitation lookup without an account receipt', async () => {
    const { db, rows } = memoryFirestore({ [`businesses/${business.id}`]: { ...business } });
    await expect(createBusiness(owner, { ...business, tone: '', customRules: '', intakeFields: [] } as never, db)).rejects.toMatchObject({ code: 'CONSENT_REQUIRED' });
    await expect(createManualBlock(owner, business.id, { dateKey: selection.dateKey, startTimeStr: '09:00', endTimeStr: '10:00', resourceId: 'one', requestId: 'manual-block' }, db)).rejects.toMatchObject({ code: 'CONSENT_REQUIRED' });
    await expect(redeemInvitation({ uid: 'new-owner', email: 'new@example.test', email_verified: true, firebase: { sign_in_provider: 'google.com' } } as never, { code: '123456', requestId: 'new-invitation' }, db)).rejects.toMatchObject({ code: 'CONSENT_REQUIRED' });
    expect([...rows.keys()]).toEqual([`businesses/${business.id}`]);
  });

  it('blocks new payment, logo normalization and client-policy changes before their writes', async () => {
    const { db, rows } = memoryFirestore({ [`businesses/${business.id}`]: { ...business } });
    const before = structuredClone([...rows]);
    await expect(submitReceipt(owner as never, { kind: 'paid_trial', bankSelected: 'bank', requestId: 'receipt-test', receiptDataUrl: `data:image/webp;base64,${Buffer.from('RIFFxxxxWEBPfixture').toString('base64')}` }, db)).rejects.toMatchObject({ code: 'CONSENT_REQUIRED' });
    await expect(saveBusinessLogo(owner, { logoDataUrl: null, expectedSha256: null }, db)).rejects.toMatchObject({ code: 'CONSENT_REQUIRED' });
    await expect(updateClientPolicy(owner, business.id, { clientUid: client.uid, blocked: true, reason: 'Test' }, db)).rejects.toMatchObject({ code: 'CONSENT_REQUIRED' });
    expect([...rows]).toEqual(before);
  });

  it('serializes revocation with the final booking transaction and does not consume its quota', async () => {
    const { db, rows } = memoryFirestore({ [`businesses/${business.id}`]: { ...business } }); await allow(db);
    let resume!: () => void, reached!: () => void, paused = false;
    const wait = new Promise<void>(resolve => { resume = resolve; }), ready = new Promise<void>(resolve => { reached = resolve; });
    const guarded = { collection: db.collection.bind(db), runTransaction: (handler: Parameters<Database['runTransaction']>[0]) => db.runTransaction(tx => handler({ ...tx, get: async (target: { path?: string }) => {
      const result = await tx.get(target as never);
      if (!paused && target.path === `serverSettings/${consentStateKey(client.uid, 'business_client', business.id)}`) { paused = true; reached(); await wait; }
      return result;
    } } as never)) } as Database;
    const booking = createAppointment(client, business.id, { ...selection, ...contact }, 'racing-booking', guarded);
    await ready;
    await updateConsent(client, { scope: 'business_client', businessId: business.id, action: 'revoke', requestId: 'racing-revoke', expectedRevision: 1 }, db);
    resume();
    await expect(booking).rejects.toMatchObject({ code: 'CONSENT_REQUIRED' });
    expect([...rows.keys()].some(path => path.includes('/appointments/'))).toBe(false);
  });

  it('rechecks consent when queued work starts and preserves exact cached reads after revocation', async () => {
    const { db, rows } = memoryFirestore({ [`businesses/${business.id}`]: { ...business } }); state.db = db; await allow(db);
    await seedQuotaProtocol(db);
    const body = { mode: 'sarin_client' as const, tenantId: business.id, requestId: 'queued-turn', messages: [{ role: 'user' as const, content: 'Servicios' }] };
    state.queue.mockImplementationOnce(async job => { await updateConsent(client, { scope: 'business_client', businessId: business.id, action: 'revoke', requestId: 'queued-revoke', expectedRevision: 1 }, db); return job(); });
    await expect(runSarinChat({ user: client, body })).rejects.toMatchObject({ code: 'CONSENT_REQUIRED' });
    expect(state.complete).not.toHaveBeenCalled(); expect([...rows.keys()].some(path => path.startsWith('responseQuotaTurns/'))).toBe(false);
    const current = await readConsent(client.uid, 'business_client', business, db);
    await updateConsent(client, { scope: 'business_client', businessId: business.id, action: 'accept', requestId: 'queued-renew', expectedRevision: 2, fingerprint: current.documents.fingerprint, termsAccepted: true, dataAuthorized: true }, db);
    state.complete.mockResolvedValue({ role: 'assistant', content: '', tool_calls: [{ id: 'call', type: 'function', function: { name: 'interpretar_solicitud', arguments: JSON.stringify({ intent: 'services', selection: {} }) } }] });
    const first = await runSarinChat({ user: client, body: { ...body, requestId: 'cached-turn' } });
    await updateConsent(client, { scope: 'business_client', businessId: business.id, action: 'revoke', requestId: 'cached-revoke', expectedRevision: 3 }, db);
    expect(await runSarinChat({ user: client, body: { ...body, requestId: 'cached-turn' } })).toEqual(first);
    await expect(runSarinChat({ user: client, body: { ...body, requestId: 'new-turn' } })).rejects.toMatchObject({ code: 'CONSENT_REQUIRED' });
    expect(state.complete).toHaveBeenCalledTimes(1);
  });
});
