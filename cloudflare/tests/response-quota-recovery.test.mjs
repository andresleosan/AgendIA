import test from 'node:test';
import assert from 'node:assert/strict';
import { createDataTestRuntime } from './data-runtime.mjs';
const reservation = { reservationId: 'a'.repeat(64), scopeId: 'business_demo-worker', periodId: 'initial', attemptId: '00000000-0000-4000-8000-000000000001' };
const turn = { ...reservation, fingerprint: 'b'.repeat(64), status: 'reserved', startedAt: 1, mode: 'sarin_client', channel: 'web', nextAttemptAt: 1000, execution: { protocol: 2, origin: 'v2', phase: 'may_have_dispatched', mayHaveDispatched: true, fenceRevision: 0, deadlineAt: 1000, providerCallId: null, result: null } };
test('Worker settles one dispatched quota without Node, provider or channel credentials and replay is inert', async () => {
  const runtime = await createDataTestRuntime({ quotaRecovery: true });
  try {
    const seed = await runtime.fetch({ action: 'commit', expectedRevision: 0, requestId: crypto.randomUUID(), writes: [
      { op: 'create', path: 'serverSettings/responseQuotaProtocol', data: { version: 2, minimumWriterProtocol: 2, sourceSha: 'a'.repeat(40), oldWriterStoppedAt: 1, reviewArtifactSha256: 'b'.repeat(64) } },
      { op: 'create', path: `responseQuotaTurns/${reservation.reservationId}`, data: turn },
      { op: 'create', path: `responseQuotaScopes/${reservation.scopeId}/periods/initial`, data: { id: 'initial', source: 'trial', planId: null, startsAt: 1, endsAt: 999999, includedResponses: 700, extraResponses: 0, usedResponses: 0, reservedResponses: 1 } },
    ] }); assert.equal(seed.status, 200);
    const first = await runtime.recoverQuota(2000); assert.equal(first.status, 200); assert.equal((await first.json()).settled, 1);
    const repeat = await runtime.recoverQuota(2000); assert.equal(repeat.status, 200); assert.equal((await repeat.json()).settled, 0);
    const period = await runtime.fetch({ action: 'read', read: { kind: 'document', path: `responseQuotaScopes/${reservation.scopeId}/periods/initial` } });
    const saved = (await period.json()).documents[0].data; assert.equal(saved.usedResponses, 1); assert.equal(saved.reservedResponses, 0);
  } finally { await runtime.dispose(); }
});
