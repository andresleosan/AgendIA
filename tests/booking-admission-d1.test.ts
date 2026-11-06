import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDataTestRuntime } from '../cloudflare/tests/data-runtime.mjs';
import { createCloudflareDatabase, StorageError } from '@/lib/storage/database';
import { admissionPolicy, registerBookingAdmissionCases } from './booking-admission-storage-contract';
import { privateBusinessDraft } from '@/lib/server/businesses';
import { bookingDataPolicyKey } from '@/lib/server/booking-data-policy';
import { assertBookingAdmission } from '@/lib/server/booking-admission';
import type { DataReadResult, DataCommitResult } from '../shared/data-protocol';
describe('booking admission real D1', () => {
  let runtime: Awaited<ReturnType<typeof createDataTestRuntime>>;
  beforeEach(async () => { runtime = await createDataTestRuntime(); }, 30000);
  afterEach(async () => { await runtime?.dispose(); });
  const connect = () => createCloudflareDatabase(async command => {
    const response = await runtime.fetch(command), data = await response.json() as DataReadResult | DataCommitResult;
    if (!response.ok) throw new StorageError(response.status, (data as unknown as { code: string }).code);
    return data;
  });
  registerBookingAdmissionCases(() => ({ db: connect(), second: connect() }));
  it('CAS retries admission after an owner change and aborts the dependent write', async () => {
    const db = connect(), second = connect(), business = { ...privateBusinessDraft({ uid: 'demo-owner' }, 1), id: admissionPolicy.businessId };
    await db.collection('businesses').doc(business.id).set(business);
    await db.collection('serverSettings').doc(bookingDataPolicyKey(business.id)).set(admissionPolicy);
    let changed = false;
    await expect(db.runTransaction(async tx => {
      await assertBookingAdmission(tx, business, 'appointment', db);
      if (!changed) { changed = true; await second.collection('businesses').doc(business.id).set({ ...business, ownerUid: 'demo-new-owner' }); }
      tx.set(db.collection('serverSettings').doc('demo-dependent-write'), { admitted: true });
    })).rejects.toMatchObject({ code: 'BOOKING_CLASSIFICATION_REQUIRED' });
    expect((await db.collection('serverSettings').doc('demo-dependent-write').get()).exists).toBe(false);
  });
});
