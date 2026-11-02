import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { completeChat, type EngineDispatchContext } from '@/lib/sarin/engine';
import { reserveResponseQuota } from '@/lib/server/response-quota';
import { markResponseQuotaDispatch } from '@/lib/server/response-quota-store';
import { memoryFirestore } from './memoryFirestore';
import { quotaProtocolEntries } from './response-quota-fixtures';
import { privateBusinessDraft } from '@/lib/server/businesses';

const now = Date.now(), business = { ...privateBusinessDraft({ uid: 'demo-owner' }, now), id: 'demo-dispatch', slug: 'demo-dispatch', subscription: { status: 'active', trialEndsAt: 0, currentPeriodEndsAt: now + 86400000 }, sarinConfig: { onboardingCompleted: true, tone: '', customRules: '', intakeFields: [] } };
const input = { businessId: business.id, actorUid: 'demo-client', mode: 'sarin_client' as const, channel: 'web' as const, requestId: 'demo-dispatch', fingerprint: 'a'.repeat(64) };
beforeEach(() => {
  vi.stubEnv('SARIN_CHAT_PROVIDER', 'deepseek'); vi.stubEnv('DEEPSEEK_API_KEY', 'synthetic'); vi.stubEnv('PILOT_AI_BUDGET_ENFORCED', 'false');
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ model: 'deepseek-flash', choices: [{ message: { role: 'assistant', content: 'Synthetic' } }] })));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
it('cloudWithoutBudgetFlagStillHasAnInternalCallId', async () => {
  let seen: EngineDispatchContext | undefined;
  await completeChat([{ role: 'user', content: 'Synthetic' }], undefined, { beforeDispatch: async context => { seen = context; } });
  expect(seen).toMatchObject({ provider: 'deepseek', providerCallId: expect.stringMatching(/^[a-f0-9-]{36}$/) });
  expect(fetch).toHaveBeenCalledTimes(1);
});
it('markerAckLostNeverDispatches', async () => {
  const { db } = memoryFirestore({ ...quotaProtocolEntries, [`businesses/${business.id}`]: business });
  const first = await reserveResponseQuota(input, db, undefined, { deadlineAt: Date.now() + 300000 });
  await expect(completeChat([{ role: 'user', content: 'Synthetic' }], undefined, { beforeDispatch: async context => {
    await markResponseQuotaDispatch(first.reservation, input.fingerprint, context, db);
    throw new Error('lost final marker acknowledgement');
  } })).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
  const saved = (await db.collection('responseQuotaTurns').doc(first.reservation.reservationId).get()).data()!;
  expect(saved.execution.mayHaveDispatched).toBe(true);
  const status = await markResponseQuotaDispatch(first.reservation, input.fingerprint, { providerCallId: null }, db);
  expect(status).toBe('already_marked');
});
it('providerCallIdMatchesItsUsageObservation', async () => {
  let context: EngineDispatchContext | undefined, callId: string | undefined;
  await completeChat([{ role: 'user', content: 'Synthetic' }], undefined, { beforeDispatch: async value => { context = value; }, onUsage: value => { callId = value.callId; } });
  expect(callId).toBe(context?.providerCallId);
});
