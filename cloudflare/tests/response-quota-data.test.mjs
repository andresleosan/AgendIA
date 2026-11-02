import test from 'node:test';
import assert from 'node:assert/strict';
import { createDataTestRuntime } from './data-runtime.mjs';
test('quota receipt roots and reviews are private, strict and create-only', async () => {
  const runtime = await createDataTestRuntime();
  try {
    const result = await runtime.fetch({ action: 'commit', expectedRevision: 0, requestId: crypto.randomUUID(), writes: [{ op: 'create', path: `responseQuotaReceipts/${'a'.repeat(64)}`, data: { reply: 'must not persist' } }] });
    assert.equal(result.status, 400);
    const mutation = await runtime.fetch({ action: 'commit', expectedRevision: 0, requestId: crypto.randomUUID(), writes: [{ op: 'delete', path: `responseQuotaReceipts/${'a'.repeat(64)}` }] });
    assert.equal(mutation.status, 400);
  } finally { await runtime.dispose(); }
});
