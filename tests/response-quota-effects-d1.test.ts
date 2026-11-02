import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createDataTestRuntime } from '../cloudflare/tests/data-runtime.mjs';
import { createCloudflareDatabase, StorageError } from '@/lib/storage/database';
import type { DataCommand, DataReadResult, DataCommitResult } from '../shared/data-protocol';
import { ownerRescheduleBusiness as business, ownerRescheduleNow as now, seedOwnerRescheduleScenario } from './owner-rescheduling-contract';
import { seedQuotaProtocol } from './response-quota-fixtures';
import { reserveResponseQuota, responseQuotaIdentity, getResponseQuota } from '@/lib/server/response-quota';
import { markResponseQuotaDispatch, finishResponseQuota, quotaEffectHooks } from '@/lib/server/response-quota-store';
import { createBookingProposal } from '@/lib/server/booking-proposals';
import { saveChatState } from '@/lib/server/chat-state';
let runtime: Awaited<ReturnType<typeof createDataTestRuntime>>;
const input = { businessId: business.id, actorUid: 'demo-client', mode: 'sarin_client' as const, channel: 'web' as const, requestId: 'demo-effects', fingerprint: 'a'.repeat(64) };
function connect(before?: (command: DataCommand) => Promise<void>) { return createCloudflareDatabase(async command => {
  await before?.(command); const response = await runtime.fetch(command), data = await response.json() as DataReadResult | DataCommitResult;
  if (!response.ok) throw new StorageError(response.status, (data as unknown as { code: string }).code); return data;
}); }
beforeEach(async () => { vi.spyOn(Date, 'now').mockReturnValue(now); runtime = await createDataTestRuntime(); }, 30000);
afterEach(async () => { await runtime?.dispose(); vi.restoreAllMocks(); });
async function scenario() {
  const db = connect(); await seedOwnerRescheduleScenario(db); await seedQuotaProtocol(db);
  const quota = await reserveResponseQuota(input, db, undefined, { deadlineAt: now + 300000 });
  await markResponseQuotaDispatch(quota.reservation, input.fingerprint, { providerCallId: null }, db);
  return { db, quota, identity: { ...responseQuotaIdentity(input), reservation: quota.reservation } };
}
const selection = { serviceId: 'demo-cut', resourceId: 'demo-chair', dateKey: '2030-01-07', startTimeStr: '10:00' };
it('closeWinsAgainstLateEffects after their reads but before the real D1 commit', async () => {
  const { db, quota, identity } = await scenario(); let closed = false;
  const late = connect(async command => {
    if (!closed && command.action === 'commit' && command.writes.some(w => w.path.startsWith('bookingProposals/'))) { closed = true; await finishResponseQuota(quota.reservation, true, db); }
  });
  await expect(createBookingProposal({ uid: input.actorUid }, business.id, selection, input.requestId, late, undefined, undefined, quotaEffectHooks(identity, late))).rejects.toMatchObject({ code: 'AI_RESPONSE_INTERRUPTED' });
  expect((await db.collection('bookingProposals').get()).size).toBe(0);
  expect((await db.collection('chatStates').get()).size).toBe(0);
  expect((await getResponseQuota(business.id, db)).currentPeriod).toMatchObject({ usedResponses: 1, reservedResponses: 0 });
}, 60000);
it('effectWinsRetainsProof and terminal settlement cannot admit a later state mutation', async () => {
  const { db, quota, identity } = await scenario(), other = connect();
  const proof = await createBookingProposal({ uid: input.actorUid }, business.id, selection, input.requestId, db, undefined, undefined, quotaEffectHooks(identity, db));
  await finishResponseQuota(quota.reservation, true, other);
  const turn = (await db.collection('responseQuotaTurns').doc(quota.reservation.reservationId).get()).data()!;
  expect(turn.execution).toMatchObject({ phase: 'result_recorded', result: { kind: 'proposal', id: proof.id } });
  await expect(saveChatState({ actorUid: input.actorUid, businessId: business.id, mode: input.mode, channel: input.channel }, 0, {}, db, now, quotaEffectHooks(identity, db))).rejects.toMatchObject({ code: 'AI_RESPONSE_INTERRUPTED' });
  expect((await db.collection('chatStates').get()).size).toBe(0);
  expect((await db.collection('responseQuotaReceipts').get()).size).toBe(1);
}, 60000);
