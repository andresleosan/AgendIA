import { afterEach, beforeEach, describe } from 'vitest';
import { createDataTestRuntime } from '../cloudflare/tests/data-runtime.mjs';
import { createCloudflareDatabase, StorageError } from '@/lib/storage/database';
import { registerBookingTransitionCases } from './booking-admission-storage-contract';
import type { DataReadResult, DataCommitResult } from '../shared/data-protocol';
describe('booking policy transition real D1', () => {
  let runtime: Awaited<ReturnType<typeof createDataTestRuntime>>;
  beforeEach(async () => { runtime = await createDataTestRuntime(); }, 30000);
  afterEach(async () => { await runtime?.dispose(); });
  const connect = () => createCloudflareDatabase(async command => {
    const response = await runtime.fetch(command), data = await response.json() as DataReadResult | DataCommitResult;
    if (!response.ok) throw new StorageError(response.status, (data as unknown as { code: string }).code);
    return data;
  });
  registerBookingTransitionCases(() => ({ db: connect(), second: connect() }));
});
