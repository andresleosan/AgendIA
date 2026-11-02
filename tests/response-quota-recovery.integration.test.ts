import { beforeEach, afterEach, describe, vi } from 'vitest';
import { createDataTestRuntime } from '../cloudflare/tests/data-runtime.mjs';
import { createCloudflareDatabase, StorageError } from '@/lib/storage/database';
import type { Database } from '@/lib/storage/types';
import type { DataReadResult, DataCommitResult } from '../shared/data-protocol';
import { quotaStorageNow, registerQuotaStorageCases } from './response-quota-storage-contract';
describe('quota recovery with independent real D1 handles', () => {
  let runtime: Awaited<ReturnType<typeof createDataTestRuntime>>, db: Database, second: Database;
  beforeEach(async () => {
    vi.spyOn(Date, 'now').mockReturnValue(quotaStorageNow); runtime = await createDataTestRuntime();
    const connect = () => createCloudflareDatabase(async command => {
      const response = await runtime.fetch(command), data = await response.json() as DataReadResult | DataCommitResult;
      if (!response.ok) throw new StorageError(response.status, (data as unknown as { code: string }).code); return data;
    }); db = connect(); second = connect();
  }, 30000);
  afterEach(async () => { await runtime?.dispose(); vi.restoreAllMocks(); });
  registerQuotaStorageCases(() => ({ db, second }));
});
