import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createDataTestRuntime } from '../cloudflare/tests/data-runtime.mjs';
import { createCloudflareDatabase, StorageError } from '@/lib/storage/database';
import type { DataReadResult, DataCommitResult, DataCommand } from '../shared/data-protocol';
import { privateBusinessDraft } from '@/lib/server/businesses';
import { reserveResponseQuota, responseQuotaIdentity, getResponseQuota, commitResponseQuota } from '@/lib/server/response-quota';
import { markResponseQuotaDispatch } from '@/lib/server/response-quota-store';
import { seedQuotaProtocol } from './response-quota-fixtures';
let runtime: Awaited<ReturnType<typeof createDataTestRuntime>>;
const now = Date.parse('2030-01-01T12:00:00Z');
const input = { businessId: 'demo-d1-quota', actorUid: 'demo-client', mode: 'sarin_client' as const, channel: 'web' as const, requestId: 'demo-request', fingerprint: 'a'.repeat(64) };
function connect(after?: (command: DataCommand) => void) { return createCloudflareDatabase(async command => {
  const response = await runtime.fetch(command), data = await response.json() as DataReadResult | DataCommitResult;
  if (!response.ok) throw new StorageError(response.status, (data as unknown as { code: string }).code);
  after?.(command); return data;
}); }
beforeEach(async () => { vi.spyOn(Date, 'now').mockReturnValue(now); runtime = await createDataTestRuntime({ captureSql: true }); }, 30000);
afterEach(async () => { await runtime?.dispose(); vi.restoreAllMocks(); });
async function setup() { const db = connect(); await seedQuotaProtocol(db); await db.collection('businesses').doc(input.businessId).set({ ...privateBusinessDraft({ uid: 'demo-owner' }, now), id: input.businessId, slug: input.businessId, subscription: { status: 'active', trialEndsAt: 0, currentPeriodEndsAt: now + 86400000 }, sarinConfig: { onboardingCompleted: true, tone: '', customRules: '', intakeFields: [] } }); return db; }
it('D1 two handles preserve the one dispatch and terminal receipt after lost settlement response', async () => {
  const db = await setup(), other = connect(), first = await reserveResponseQuota(input, db, undefined, { deadlineAt: now + 300000 });
  const grants = await Promise.all([markResponseQuotaDispatch(first.reservation, input.fingerprint, { providerCallId: null }, db), markResponseQuotaDispatch(first.reservation, input.fingerprint, { providerCallId: null }, other)]);
  expect(grants.filter(value => value === 'dispatch_allowed')).toHaveLength(1);
  let dropped = false;
  const lossy = connect(command => { if (!dropped && command.action === 'commit' && command.writes.some(w => w.path.startsWith('responseQuotaReceipts/'))) { dropped = true; throw new StorageError(503, 'DATA_UNAVAILABLE'); } });
  await commitResponseQuota(first.reservation, undefined, lossy);
  await commitResponseQuota(first.reservation, undefined, other);
  expect((await getResponseQuota(input.businessId, other)).currentPeriod).toMatchObject({ usedResponses: 1, reservedResponses: 0 });
  expect((await other.collection('responseQuotaReceipts').get()).size).toBe(1);
  expect((await other.collection('responseQuotaTurns').doc(responseQuotaIdentity(input).quotaTurnId).get()).data()?.status).toBe('completed');
}, 60000);
it('Worker rejects old writes and receipt mutations without partial settlement', async () => {
  const db = await setup(), first = await reserveResponseQuota(input, db, undefined, { deadlineAt: now + 300000 });
  const ref = db.collection('responseQuotaTurns').doc(first.reservation.reservationId), saved = (await ref.get()).data()!;
  const { execution: _exec, nextAttemptAt: _next, ...legacy } = saved;
  await expect(ref.set(legacy)).rejects.toMatchObject({ code: 'DATA_INVALID' });
  await expect(db.collection('serverSettings').doc('responseQuotaProtocol').delete()).rejects.toMatchObject({ code: 'DATA_INVALID' });
  await markResponseQuotaDispatch(first.reservation, input.fingerprint, { providerCallId: null }, db);
  await commitResponseQuota(first.reservation, undefined, db);
  const receipt = (await db.collection('responseQuotaReceipts').get()).docs[0];
  await expect(db.runTransaction(async tx => { tx.create(db.collection('responseQuotaReceipts').doc('f'.repeat(64)), receipt.data()); })).rejects.toMatchObject({ code: 'DATA_INVALID' });
  await expect(db.collection('responseQuotaReceipts').doc(receipt.id).set(receipt.data())).rejects.toMatchObject({ code: 'DATA_INVALID' });
  await expect(db.collection('responseQuotaReceipts').doc(receipt.id).delete()).rejects.toMatchObject({ code: 'DATA_INVALID' });
}, 60000);
it('D1 pending and discovery query plans use bounded indexes', async () => {
  await setup();
  const due = await runtime.explain!({ kind: 'query', path: 'responseQuotaTurns', filters: [{ field: 'status', op: '==', value: 'reserved' }, { field: 'nextAttemptAt', op: '<=', value: now }], order: [{ field: 'nextAttemptAt', direction: 'asc' }, { field: '__name__', direction: 'asc' }], limit: 50 });
  expect(JSON.stringify(due.plan)).toContain('app_response_quota_pending');
  const discovery = await runtime.explain!({ kind: 'query', path: 'responseQuotaTurns', filters: [{ field: 'status', op: '==', value: 'reserved' }], order: [{ field: '__name__', direction: 'asc' }], limit: 50 });
  expect(JSON.stringify(discovery.plan)).toContain('app_response_quota_discovery');
}, 60000);
