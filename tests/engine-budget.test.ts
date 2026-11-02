import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { consentedFirestore } from './consent-fixtures';
import { quotaProtocolEntries } from './response-quota-fixtures';
const memoryFirestore = (initial: Parameters<typeof consentedFirestore>[0] = {}) => consentedFirestore({ ...quotaProtocolEntries, ...initial }, ['admin', 'client', 'owner']);
const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/firebase/admin', () => ({ getAdminDb: () => state.db }));
import { completeChat } from '@/lib/sarin/engine';
import { DEFAULT_AI_BUDGET_LIMITS, saveAiBudgetSettings } from '@/lib/server/ai-budget';
import { privateBusinessDraft } from '@/lib/server/businesses';
import { runSarinChat } from '@/lib/server/chat';
import { getResponseQuota } from '@/lib/server/response-quota';
import { saveBookingDataPolicy, assertBusinessAllowsInference } from '@/lib/server/booking-data-policy';
const context = { businessId: 'business', actorUid: 'client', mode: 'sarin_client' as const, requestId: 'synthetic-request' };
const messages = [{ role: 'user' as const, content: 'Synthetic service question' }];
const reply = () => Response.json({ model: 'deepseek-flash', choices: [{ message: { content: 'Synthetic interpretation' } }], usage: { prompt_tokens: 12, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 12, completion_tokens: 8, total_tokens: 20 } });
describe('mandatory cloud budget before network', () => {
  beforeEach(() => { state.db = memoryFirestore().db; vi.stubEnv('SUPERADMIN_UID', 'admin'); vi.stubEnv('SARIN_CHAT_PROVIDER', 'deepseek'); vi.stubEnv('DEEPSEEK_API_KEY', 'synthetic-key'); vi.stubEnv('PILOT_AI_BUDGET_ENFORCED', 'true'); vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => reply())); });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
  it('rejects missing context or missing config before fetching', async () => {
    await expect(completeChat(messages)).rejects.toMatchObject({ status: 503, code: 'AI_BUDGET_UNAVAILABLE' });
    await expect(completeChat(messages, undefined, { billingContext: context })).rejects.toMatchObject({ status: 503, code: 'AI_BUDGET_UNAVAILABLE' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('never fetches or reserves money for health chat even with an available paid budget', async () => {
    const business = { ...privateBusinessDraft({ uid: 'owner' }, Date.now()), id: 'business', slug: 'business', subscription: { status: 'active' as const, trialEndsAt: 0, currentPeriodEndsAt: Date.now() + 86400000 }, sarinConfig: { onboardingCompleted: true, tone: '', customRules: '', intakeFields: [] } };
    const { db, rows } = memoryFirestore({ 'businesses/business': business }); state.db = db;
    await saveAiBudgetSettings({ uid: 'admin' }, { expectedVersion: 0, paused: false, limits: DEFAULT_AI_BUDGET_LIMITS, reason: 'Demo' }, db);
    await saveBookingDataPolicy({ uid: 'admin' }, { businessId: 'business', expectedRevision: 0, dataMode: 'health', representedMinorsEnabled: false, reason: 'Demo' }, db);
    await expect(runSarinChat({ user: { uid: 'client' }, body: { mode: 'sarin_client', tenantId: 'business', requestId: 'demo-health-budget', messages } })).rejects.toMatchObject({ code: 'STRUCTURED_BOOKING_REQUIRED' });
    expect(fetch).not.toHaveBeenCalled(); expect([...rows.keys()].filter(path => /aiBudgetCalls|aiBudgetPeriods|responseQuotaTurns/.test(path))).toHaveLength(0);
  });
  it('settles without optional telemetry and does not repeat a result if telemetry fails', async () => {
    const { db, rows } = memoryFirestore(); state.db = db;
    await saveAiBudgetSettings({ uid: 'admin' }, { expectedVersion: 0, paused: false, limits: DEFAULT_AI_BUDGET_LIMITS, reason: 'Synthetic test' }, db);
    await completeChat(messages, undefined, { billingContext: context });
    await completeChat(messages, undefined, { billingContext: context, onUsage: async () => { throw new Error('telemetry outage'); } });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect([...rows].filter(([path]) => path.startsWith('aiBudgetCalls/')).every(([, row]) => row.data.status === 'settled')).toBe(true);
  });
  it('checks policy after the paid reservation and releases a call that was never dispatched', async () => {
    const business = { ...privateBusinessDraft({ uid: 'owner' }, Date.now()), id: 'business', slug: 'business', subscription: { status: 'active' as const, trialEndsAt: 0, currentPeriodEndsAt: Date.now() + 86400000 }, sarinConfig: { onboardingCompleted: true, tone: '', customRules: '', intakeFields: [] } };
    const { db, rows } = memoryFirestore({ 'businesses/business': business }); state.db = db;
    await saveAiBudgetSettings({ uid: 'admin' }, { expectedVersion: 0, paused: false, limits: DEFAULT_AI_BUDGET_LIMITS, reason: 'Demo' }, db);
    const transact = db.runTransaction.bind(db); let switched = false;
    vi.spyOn(db, 'runTransaction').mockImplementation(async handler => {
      const result = await transact(handler);
      if (!switched && [...rows.keys()].some(path => path.startsWith('aiBudgetCalls/'))) {
        switched = true;
        await saveBookingDataPolicy({ uid: 'admin' }, { businessId: business.id, expectedRevision: 0, dataMode: 'health', representedMinorsEnabled: false, reason: 'Demo reclassification' }, db);
      }
      return result;
    });
    const onUsage = vi.fn();
    await expect(runSarinChat({ user: { uid: 'client' }, body: { mode: 'sarin_client', tenantId: business.id, requestId: 'demo-budget-policy-race', messages } })).rejects.toMatchObject({ code: 'STRUCTURED_BOOKING_REQUIRED' });
    expect(fetch).not.toHaveBeenCalled();
    expect([...rows].filter(([path]) => path.startsWith('aiBudgetCalls/')).map(([, row]) => row.data)).toMatchObject([{ status: 'released', actualTokens: 0, actualCostNanoUsd: 0 }]);
    expect([...rows].filter(([path]) => path.startsWith('aiBudgetPeriods/')).every(([, row]) => row.data.reservedTokens === 0 && row.data.reservedCostNanoUsd === 0)).toBe(true);
    await expect(completeChat(messages, undefined, { billingContext: context, beforeDispatch: () => assertBusinessAllowsInference(business.id, db), onUsage } as Parameters<typeof completeChat>[2])).rejects.toMatchObject({ code: 'STRUCTURED_BOOKING_REQUIRED' });
    expect(onUsage).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
  it('retains the maximum on timeout and on a settlement outage, with no automatic fetch retry', async () => {
    const { db, rows } = memoryFirestore(); state.db = db;
    await saveAiBudgetSettings({ uid: 'admin' }, { expectedVersion: 0, paused: false, limits: DEFAULT_AI_BUDGET_LIMITS, reason: 'Synthetic test' }, db);
    vi.mocked(fetch).mockRejectedValueOnce(new Error('timeout'));
    await expect(completeChat(messages, undefined, { billingContext: context })).rejects.toMatchObject({ status: 503 });
    expect([...rows].filter(([path]) => path.startsWith('aiBudgetPeriods/')).every(([, row]) => Number(row.data.reservedTokens) > 0)).toBe(true);
    expect(rows.get('serverSettings/pilotAiBudget')!.data.paused).toBe(false);
    let outage: ReturnType<typeof vi.spyOn> | undefined;
    vi.mocked(fetch).mockImplementationOnce(async () => { outage = vi.spyOn(db, 'runTransaction').mockRejectedValue(new Error('settlement unavailable')); return reply(); });
    expect((await completeChat(messages, undefined, { billingContext: context })).content).toBe('Synthetic interpretation');
    outage?.mockRestore(); expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('reports operator budget exhaustion separately and releases the undelivered commercial response', async () => {
    const business = { ...privateBusinessDraft({ uid: 'owner' }, Date.now()), id: 'business', slug: 'business', subscription: { status: 'active' as const, trialEndsAt: 0, currentPeriodEndsAt: Date.now() + 86400000 }, sarinConfig: { onboardingCompleted: true, tone: '', customRules: '', intakeFields: [] } };
    const { db } = memoryFirestore({ 'businesses/business': business }); state.db = db;
    await saveAiBudgetSettings({ uid: 'admin' }, { expectedVersion: 0, paused: false, limits: { ...DEFAULT_AI_BUDGET_LIMITS, businessDayUsd: 0.000001 }, reason: 'Synthetic exhausted budget' }, db);
    await expect(runSarinChat({ user: { uid: 'client' }, body: { mode: 'sarin_client', tenantId: 'business', requestId: 'budget-exhausted', messages } })).rejects.toMatchObject({ status: 503, code: 'AI_BUDGET_EXHAUSTED' });
    expect(fetch).not.toHaveBeenCalled();
    expect((await getResponseQuota('business')).currentPeriod).toMatchObject({ usedResponses: 0, reservedResponses: 0 });
  });
});
