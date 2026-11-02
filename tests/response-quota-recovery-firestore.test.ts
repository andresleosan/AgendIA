import { readFile } from 'node:fs/promises';
import { beforeAll, beforeEach, afterAll, afterEach, describe, vi } from 'vitest';
import { initializeApp, deleteApp, type App } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { initializeTestEnvironment, type RulesTestEnvironment } from '@firebase/rules-unit-testing';
import type { Database } from '@/lib/storage/types';
import { quotaStorageNow, registerQuotaStorageCases } from './response-quota-storage-contract';
describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('quota recovery on official Firestore Admin transactions', () => {
  let environment: RulesTestEnvironment, apps: App[], stores: Firestore[];
  beforeAll(async () => {
    const projectId = 'demo-sarin-quota-storage';
    environment = await initializeTestEnvironment({ projectId, firestore: { rules: await readFile('firestore.rules', 'utf8') } });
    apps = [0, 1].map(index => initializeApp({ projectId }, `demo-quota-${index}-${crypto.randomUUID()}`)); stores = apps.map(app => getFirestore(app));
  }, 30000);
  beforeEach(async () => { await environment.clearFirestore(); });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => { await Promise.all(stores?.map(store => store.terminate()) ?? []); await Promise.all(apps?.map(app => deleteApp(app)) ?? []); await environment?.cleanup(); });
  registerQuotaStorageCases(() => ({ db: stores[0] as unknown as Database, second: stores[1] as unknown as Database }));
});
