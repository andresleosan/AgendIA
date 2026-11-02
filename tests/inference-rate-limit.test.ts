import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { consentedFirestore } from './consent-fixtures';
import { quotaProtocolEntries } from './response-quota-fixtures';
const memoryFirestore = (initial: Parameters<typeof consentedFirestore>[0] = {}) => consentedFirestore({ ...quotaProtocolEntries, ...initial }, ['owner', 'synthetic-client']);
import type { Database } from '../src/lib/storage/types';
import { enforceClientInferenceRateLimit, enforceInferenceAdmission } from '../src/lib/server/inference-rate-limit';
import { createCloudflareDatabase, StorageError } from '../src/lib/storage/database';
import { createDataTestRuntime } from '../cloudflare/tests/data-runtime.mjs';
import type { DataCommand, DataCommitResult, DataReadResult } from '../shared/data-protocol';

const state = vi.hoisted(() => ({ db: undefined as unknown, complete: vi.fn() }));
vi.mock('../src/lib/firebase/admin', () => ({ getAdminDb: () => state.db }));
vi.mock('../src/lib/sarin/engine', async importOriginal => ({ ...await importOriginal<typeof import('../src/lib/sarin/engine')>(), completeChat: async (...args: Parameters<typeof import('../src/lib/sarin/engine')['completeChat']>) => { await args[2]?.beforeDispatch?.({ provider: 'ollama', providerCallId: null }); return state.complete(...args); } }));
import { runSarinChat } from '../src/lib/server/chat';

const now = Date.UTC(2030, 0, 7, 12);
const minute = 60_000, hour = 60 * minute, day = 24 * hour;
const hash = (...parts: unknown[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
const input = (index: number, changes: Record<string, unknown> = {}) => ({ actorUid: 'synthetic-client', businessId: 'synthetic-business', channel: 'web' as const, requestId: `synthetic-request-${index}`, fingerprint: hash(index), ...changes });
const adapter = (initial: Record<string, Record<string, unknown>> = {}) => {
  const memory = memoryFirestore(initial);
  return { ...memory, database: memory.db as unknown as Database };
};
const ratePath = `serverSettings/client_rate_${createHash('sha256').update('synthetic-client').digest('hex')}`;
const turnPath = (value: ReturnType<typeof input>) => `responseQuotaTurns/${hash(value.businessId, value.actorUid, 'sarin_client', value.channel, value.requestId)}`;
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); state.complete.mockReset(); });

describe('persistent client inference rate limits', () => {
  it('admits ten new turns in a sliding minute and opens exactly when the oldest expires', async () => {
    const { database, rows } = adapter();
    for (let index = 0; index < 10; index++) await enforceClientInferenceRateLimit(input(index), database, now + index);
    await expect(enforceClientInferenceRateLimit(input(10), database, now + minute - 1)).rejects.toMatchObject({ status: 429, code: 'CLIENT_RATE_LIMITED' });
    await enforceClientInferenceRateLimit(input(10), database, now + minute);
    expect(rows.get(ratePath)?.data.events).toHaveLength(11);
  });

  it('bounds an hour independently of the minute and expires its oldest marks', async () => {
    const { database } = adapter();
    for (let index = 0; index < 60; index++) await enforceClientInferenceRateLimit(input(index), database, now + Math.floor(index / 10) * (minute + 1));
    await expect(enforceClientInferenceRateLimit(input(60), database, now + 6 * (minute + 1))).rejects.toMatchObject({ status: 429, code: 'CLIENT_RATE_LIMITED' });
    await enforceClientInferenceRateLimit(input(60), database, now + hour);
  });

  it('bounds a day to 120 marks and prunes expired marks instead of growing state', async () => {
    const { database, rows } = adapter();
    for (let index = 0; index < 120; index++) await enforceClientInferenceRateLimit(input(index), database, now + Math.floor(index / 60) * hour + Math.floor(index % 60 / 10) * (minute + 1));
    await expect(enforceClientInferenceRateLimit(input(120), database, now + 2 * hour)).rejects.toMatchObject({ status: 429, code: 'CLIENT_RATE_LIMITED' });
    expect(rows.get(ratePath)?.data.events).toHaveLength(120);
    await enforceClientInferenceRateLimit(input(120), database, now + day);
    expect(rows.get(ratePath)?.data.events).toHaveLength(111);
    await enforceClientInferenceRateLimit(input(121), database, now + 2 * day);
    expect(rows.get(ratePath)?.data.events).toHaveLength(1);
    expect(JSON.stringify(rows.get(ratePath)?.data)).not.toMatch(/synthetic-client|synthetic-request|messages|content|ipAddress/);
  });

  it('readmits a turn without durable completion while rejecting altered payloads under its identifier', async () => {
    const { database, rows } = adapter();
    await enforceClientInferenceRateLimit(input(1), database, now);
    await enforceClientInferenceRateLimit(input(1), database, now + 1);
    expect(rows.get(ratePath)?.data.events).toHaveLength(2);
    await expect(enforceClientInferenceRateLimit(input(1, { fingerprint: hash('altered') }), database, now + 2)).rejects.toMatchObject({ status: 409, code: 'AI_REQUEST_CONFLICT' });
    expect(rows.get(ratePath)?.data.events).toHaveLength(2);
  });

  it('applies globally across businesses for one UID while keeping different UIDs independent', async () => {
    const { database } = adapter();
    for (let index = 0; index < 10; index++) await enforceClientInferenceRateLimit(input(index), database, now);
    await expect(enforceClientInferenceRateLimit(input(10, { businessId: 'another-business' }), database, now)).rejects.toMatchObject({ status: 429 });
    await enforceClientInferenceRateLimit(input(10, { actorUid: 'another-client' }), database, now);
  });

  it('rejects reuse of one request identifier across another business or channel', async () => {
    const { database } = adapter();
    await enforceClientInferenceRateLimit(input(1), database, now);
    await expect(enforceClientInferenceRateLimit(input(1, { businessId: 'another-business' }), database, now)).rejects.toMatchObject({ status: 409 });
    await expect(enforceClientInferenceRateLimit(input(1, { channel: 'whatsapp' }), database, now)).rejects.toMatchObject({ status: 409 });
  });

  it('atomically admits only one concurrent claimant for the final minute slot', async () => {
    const { database, rows } = adapter();
    for (let index = 0; index < 9; index++) await enforceClientInferenceRateLimit(input(index), database, now);
    const results = await Promise.allSettled([10, 11].map(index => enforceClientInferenceRateLimit(input(index), database, now)));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { status: 429, code: 'CLIENT_RATE_LIMITED' } });
    expect(rows.get(ratePath)?.data.events).toHaveLength(10);
  });

  it.each(['completed', 'reserved'])('does not count recovery of a durable %s turn predating the limiter', async status => {
    const value = input(1);
    const { database, rows } = adapter({ [turnPath(value)]: { status, fingerprint: value.fingerprint } });
    await enforceClientInferenceRateLimit(value, database, now);
    expect(rows.has(ratePath)).toBe(false);
    await expect(enforceClientInferenceRateLimit({ ...value, fingerprint: hash('altered') }, database, now)).rejects.toMatchObject({ status: 409, code: 'AI_REQUEST_CONFLICT' });
  });

  it('counts a released durable turn as a fresh admission when it can infer again', async () => {
    const value = input(1);
    const { database, rows } = adapter({ [turnPath(value)]: { status: 'released', fingerprint: value.fingerprint } });
    await enforceClientInferenceRateLimit(value, database, now);
    expect(rows.get(ratePath)?.data.events).toHaveLength(1);
  });

  it('limits repeated failed attempts under the same released request identifier', async () => {
    const value = input(1);
    const { database, rows } = adapter();
    await enforceClientInferenceRateLimit(value, database, now);
    await database.collection('responseQuotaTurns').doc(turnPath(value).split('/')[1]).set({ status: 'released', fingerprint: value.fingerprint });
    for (let index = 1; index < 10; index++) await enforceClientInferenceRateLimit(value, database, now + index);
    await expect(enforceClientInferenceRateLimit(value, database, now + 10)).rejects.toMatchObject({ status: 429, code: 'CLIENT_RATE_LIMITED' });
    expect(rows.get(ratePath)?.data.events).toHaveLength(10);
  });

  it('fails closed on corrupt persistent rate state instead of resetting limits', async () => {
    const { database } = adapter({ [ratePath]: { version: 1, events: [{ at: now, request: 'not-a-hash', fingerprint: hash(1) }] } });
    await expect(enforceClientInferenceRateLimit(input(1), database, now)).rejects.toMatchObject({ status: 503 });
  });
});

// Tests-after characterization of the actual storage boundary, not a simulated D1 implementation.
describe('client frequency on real local Workerd D1', () => {
  it('persists admission across DB handles and serializes the final slot', async () => {
    const runtime = await createDataTestRuntime();
    const transport = async (command: DataCommand): Promise<DataReadResult | DataCommitResult> => {
      const response = await runtime.fetch(command);
      const value = await response.json() as DataReadResult | DataCommitResult | { code: string };
      if (!response.ok) throw new StorageError(response.status, (value as { code: string }).code);
      return value as DataReadResult | DataCommitResult;
    };
    try {
      const first = createCloudflareDatabase(transport);
      const reopened = createCloudflareDatabase(transport);
      for (let index = 0; index < 9; index++) await enforceClientInferenceRateLimit(input(index), first, now);
      const results = await Promise.allSettled([enforceClientInferenceRateLimit(input(10), first, now), enforceClientInferenceRateLimit(input(11), reopened, now)]);
      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { status: 429, code: 'CLIENT_RATE_LIMITED' } });
      const snapshot = await reopened.collection('serverSettings').doc(ratePath.split('/')[1]).get();
      expect(snapshot.data()?.events).toHaveLength(10);
      await reopened.collection('responseQuotaTurns').doc(turnPath(input(0)).split('/')[1]).set({ status: 'completed', fingerprint: input(0).fingerprint });
      await enforceClientInferenceRateLimit(input(0), reopened, now);
      await expect(enforceClientInferenceRateLimit(input(12), reopened, now)).rejects.toMatchObject({ status: 429 });
    } finally { await runtime.dispose(); }
  }, 30_000);
});

describe('rate limits before commercial response reservation', () => {
  const business = { id: 'synthetic-business', slug: 'synthetic-business', ownerUid: 'owner', ownerEmail: '', name: 'Synthetic business', category: 'QA', phoneWhatsApp: '573001234567', timezone: 'America/Bogota', subscription: { status: 'active', trialEndsAt: 0, currentPeriodEndsAt: now + day }, sarinConfig: { onboardingCompleted: true, tone: '', customRules: '', intakeFields: [] }, resources: [], services: [], weeklySchedule: {}, createdAt: now };
  const body = (index: number) => ({ mode: 'sarin_client' as const, tenantId: business.id, requestId: `chat-test-${index}`, messages: [{ role: 'user' as const, content: `Consulta sintética ${index}` }] });

  it('returns 429 without retaining quota or calling the provider for the eleventh new turn', async () => {
    vi.useFakeTimers(); vi.setSystemTime(now); vi.stubEnv('SARIN_CHAT_PROVIDER', 'ollama');
    const { database, rows } = adapter({ [`businesses/${business.id}`]: business }); state.db = database;
    state.complete.mockResolvedValue({ role: 'assistant', content: 'Respuesta sintética' });
    for (let index = 0; index < 10; index++) await runSarinChat({ user: { uid: 'synthetic-client' }, body: body(index) });
    const before = structuredClone([...rows.entries()]);
    await expect(runSarinChat({ user: { uid: 'synthetic-client' }, body: body(10) })).rejects.toMatchObject({ status: 429, code: 'CLIENT_RATE_LIMITED' });
    expect(state.complete).toHaveBeenCalledTimes(10);
    expect([...rows.entries()]).toEqual(before);
    const periods = [...rows].filter(([path]) => path.startsWith('responseQuotaScopes/') && path.includes('/periods/'));
    expect(periods[0][1].data).toMatchObject({ usedResponses: 10, reservedResponses: 0 });
    await runSarinChat({ user: { uid: 'synthetic-client' }, body: body(0) });
    expect(state.complete).toHaveBeenCalledTimes(10);
  });

  it('consumes an initiated provider failure once and prevents another inference for its request ID', async () => {
    vi.useFakeTimers(); vi.setSystemTime(now); vi.stubEnv('SARIN_CHAT_PROVIDER', 'ollama');
    const { database, rows } = adapter({ [`businesses/${business.id}`]: business }); state.db = database;
    state.complete.mockRejectedValue(new Error('synthetic provider unavailable'));
    await expect(runSarinChat({ user: { uid: 'synthetic-client' }, body: body(0) })).rejects.toThrow('synthetic provider unavailable');
    for (let index = 0; index < 10; index++) await expect(runSarinChat({ user: { uid: 'synthetic-client' }, body: body(0) })).rejects.toMatchObject({ code: 'REQUEST_ALREADY_COMPLETED' });
    expect(state.complete).toHaveBeenCalledTimes(1);
    const periods = [...rows].filter(([path]) => path.startsWith('responseQuotaScopes/') && path.includes('/periods/'));
    expect(periods[0][1].data).toMatchObject({ usedResponses: 1, reservedResponses: 0 });
    expect(rows.get(ratePath)?.data.events).toHaveLength(1);
  });

  it.each(['sarin_onboarding', 'sarin_owner_copilot'] as const)('admits %s before queueing and keeps exact retry delay', async mode => {
    vi.useFakeTimers(); vi.setSystemTime(now); vi.stubEnv('SARIN_CHAT_PROVIDER', 'ollama');
    const { businessIdForOwner } = await import('../src/lib/server/businesses');
    const ownerId = businessIdForOwner('owner');
    const { database, rows } = adapter({ [`businesses/${ownerId}`]: { ...business, id: ownerId } }); state.db = database;
    state.complete.mockResolvedValue({ role: 'assistant', content: 'Respuesta sintética' });
    for (let index = 0; index < 10; index++) await runSarinChat({ user: { uid: 'owner' }, body: { ...body(index), tenantId: ownerId, mode } });
    const inference = await import('../src/lib/server/inference');
    const queued = vi.spyOn(inference, 'runUserInference');
    await expect(runSarinChat({ user: { uid: 'owner' }, body: { ...body(10), tenantId: ownerId, mode } })).rejects.toMatchObject({ status: 429, retryAfterSeconds: 60 });
    expect(queued).not.toHaveBeenCalled(); queued.mockRestore();
    expect(state.complete).toHaveBeenCalledTimes(10);
    expect([...rows.keys()].some(path => path.startsWith('serverSettings/client_rate_'))).toBe(true);
  });
});

describe('shared mode and tenant admission', () => {
  it('does not corrupt tenant state when two UIDs use the same request identifier', async () => {
    const { database } = adapter();
    await enforceInferenceAdmission({ ...input(1), mode: 'sarin_client' }, database, now);
    await enforceInferenceAdmission({ ...input(1), actorUid: 'another-uid', fingerprint: hash('other-body'), mode: 'sarin_client' }, database, now);
    await enforceInferenceAdmission({ ...input(2), actorUid: 'third-uid', mode: 'sarin_client' }, database, now);
  });
  it('limits one tenant across thirty UIDs and keeps another tenant independent', async () => {
    const { database } = adapter();
    for (let index = 0; index < 30; index++) await enforceInferenceAdmission({ ...input(index), actorUid: `actor-${index}`, mode: index % 2 ? 'sarin_client' : 'sarin_onboarding' }, database, now);
    await expect(enforceInferenceAdmission({ ...input(30), mode: 'sarin_owner_copilot', actorUid: 'actor-30' }, database, now)).rejects.toMatchObject({ status: 429, retryAfterSeconds: 60 });
    await enforceInferenceAdmission({ ...input(31), businessId: 'other-business', mode: 'sarin_client', actorUid: 'actor-30' }, database, now);
  });
  it('does not let a UID evade limits by changing mode or tenant; onboarding replay keeps legacy null identity', async () => {
    const { database, rows } = adapter();
    for (let index = 0; index < 10; index++) await enforceInferenceAdmission({ ...input(index), mode: index % 2 ? 'sarin_client' : 'sarin_onboarding' }, database, now);
    await expect(enforceInferenceAdmission({ ...input(11), mode: 'sarin_owner_copilot', businessId: 'other-business' }, database, now)).rejects.toMatchObject({ status: 429 });
    const legacy = input(12);
    await database.collection('responseQuotaTurns').doc(hash(null, legacy.actorUid, 'sarin_onboarding', legacy.channel, legacy.requestId)).set({ status: 'completed', fingerprint: legacy.fingerprint });
    const before = structuredClone([...rows]);
    await enforceInferenceAdmission({ ...legacy, mode: 'sarin_onboarding' }, database, now);
    expect([...rows]).toEqual(before);
  });
});
