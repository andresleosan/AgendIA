import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ db: undefined as unknown, engine: vi.fn(), queue: vi.fn(), provider: vi.fn() }));
vi.mock('@/lib/firebase/admin', () => ({ getAdminDb: () => state.db }));
vi.mock('@/lib/sarin/engine', async original => ({ ...await original<typeof import('@/lib/sarin/engine')>(), completeChat: state.engine }));
vi.mock('@/lib/sarin/queue', () => ({ runInSarinQueue: state.queue }));
vi.mock('@/lib/server/provider-settings', () => ({ getAiProviderSelection: state.provider }));
import { memoryFirestore } from './memoryFirestore';
import { seedQuotaProtocol } from './response-quota-fixtures';
import { subjectFixture, subjectAdmin, verifyStructuredCases } from './represented-booking-contract';
import { acceptSyntheticConsent } from './consent-fixtures';
import { businessIdForOwner } from '@/lib/server/businesses';
import { saveBookingDataPolicy } from '@/lib/server/booking-data-policy';
import { runSarinChat } from '@/lib/server/chat';
beforeEach(() => { vi.stubEnv('SUPERADMIN_UID', subjectAdmin.uid); vi.stubEnv('SARIN_CHAT_PROVIDER', 'deepseek'); state.engine.mockReset().mockResolvedValue({ role: 'assistant', content: '' }); state.queue.mockReset().mockImplementation(async job => job()); state.provider.mockReset().mockResolvedValue({ provider: 'deepseek' }); });
afterEach(() => vi.unstubAllEnvs());
it('health client owner copilot onboarding and WhatsApp cannot dispatch private input or create admission quota or budget', async () => {
  const { db, rows } = memoryFirestore(); state.db = db; const f = await subjectFixture(db);
  await acceptSyntheticConsent(db, f.owner.uid); const owned = { ...f.business, id: businessIdForOwner(f.owner.uid), subscription: { status: 'active' as const, trialEndsAt: 0, currentPeriodEndsAt: Date.now() + 86400000 } };
  await db.collection('businesses').doc(owned.id).set(owned); await acceptSyntheticConsent(db, f.actor.uid, owned); await saveBookingDataPolicy(subjectAdmin, { businessId: owned.id, expectedRevision: 0, dataMode: 'health', representedMinorsEnabled: true, reason: 'Demo' }, db);
  const before = structuredClone([...rows]);
  for (const mode of ['sarin_client', 'sarin_owner_copilot', 'sarin_onboarding'] as const) {
    await expect(runSarinChat({ user: mode === 'sarin_client' ? f.actor : f.owner, body: { mode, tenantId: owned.id, requestId: `demo-${mode}`, messages: [{ role: 'user', content: 'SYNTHETIC_PRIVATE_SUBJECT' }] } })).rejects.toMatchObject({ status: 409, code: 'STRUCTURED_BOOKING_REQUIRED' });
  }
  await expect(runSarinChat({ user: { ...f.actor, phone: '573001234567' }, channel: 'whatsapp', onResponse: async () => {}, body: { mode: 'sarin_client', tenantId: f.business.id, requestId: 'demo-health-whatsapp', messages: [{ role: 'user', content: 'SYNTHETIC_PRIVATE_SUBJECT' }] } })).rejects.toMatchObject({ code: 'STRUCTURED_BOOKING_REQUIRED' });
  expect(state.engine).not.toHaveBeenCalled(); expect(state.queue).not.toHaveBeenCalled(); expect([...rows]).toEqual(before);
});
it('health policy stops queued inference before paid fetch and quota', async () => {
  const { db, rows } = memoryFirestore(); state.db = db; const f = await subjectFixture(db, 'general', false);
  state.queue.mockImplementationOnce(async job => { await saveBookingDataPolicy(subjectAdmin, { businessId: f.business.id, expectedRevision: 1, dataMode: 'health', representedMinorsEnabled: false, reason: 'Demo policy during queue' }, db); return job(); });
  await expect(runSarinChat({ user: f.actor, body: { mode: 'sarin_client', tenantId: f.business.id, requestId: 'demo-queued-health', messages: [{ role: 'user', content: 'SYNTHETIC_PRIVATE_SUBJECT' }] } })).rejects.toMatchObject({ code: 'STRUCTURED_BOOKING_REQUIRED' });
  expect(state.engine).not.toHaveBeenCalled(); expect([...rows.keys()].filter(path => /responseQuotaTurns|aiBudgetCalls|aiBudgetPeriods/.test(path))).toHaveLength(0);
});
it('adult haircut represented haircut and pediatrics finish without any inference', async () => {
  const { db } = memoryFirestore(); state.db = db; await verifyStructuredCases(db); expect(state.engine).not.toHaveBeenCalled(); expect(state.queue).not.toHaveBeenCalled();
});
it('rechecks policy after provider selection immediately before dispatch', async () => {
  const { db } = memoryFirestore(); state.db = db; const f = await subjectFixture(db, 'general', false);
  await seedQuotaProtocol(db);
  state.provider.mockImplementationOnce(async () => { await saveBookingDataPolicy(subjectAdmin, { businessId: f.business.id, expectedRevision: 1, dataMode: 'health', representedMinorsEnabled: false, reason: 'Demo dispatch race' }, db); return { provider: 'deepseek' }; });
  await expect(runSarinChat({ user: f.actor, body: { mode: 'sarin_client', tenantId: f.business.id, requestId: 'demo-before-dispatch', messages: [{ role: 'user', content: 'SYNTHETIC_PRIVATE_SUBJECT' }] } })).rejects.toMatchObject({ code: 'STRUCTURED_BOOKING_REQUIRED' });
  expect(state.engine).not.toHaveBeenCalled();
});
