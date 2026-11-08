import { readFile } from 'node:fs/promises';
import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import { initializeApp, deleteApp, type App } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { initializeTestEnvironment, assertFails, type RulesTestEnvironment } from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, deleteDoc } from 'firebase/firestore';
import type { Database } from '@/lib/storage/types';
import { registerBookingPolicyCommandCases } from './booking-policy-commands-contract';
import { registerBookingAdmissionCases, registerBookingTransitionCases } from './booking-admission-storage-contract';
describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('booking admission official Firestore', () => {
  let environment: RulesTestEnvironment, apps: App[], stores: Firestore[];
  beforeAll(async () => {
    const projectId = 'demo-sarin-booking-admission';
    environment = await initializeTestEnvironment({ projectId, firestore: { rules: await readFile('firestore.rules', 'utf8') } });
    apps = [0, 1].map(i => initializeApp({ projectId }, `demo-admission-${i}-${crypto.randomUUID()}`)); stores = apps.map(app => getFirestore(app));
  }, 30000);
  beforeEach(async () => { await environment.clearFirestore(); });
  afterAll(async () => { await Promise.all(stores?.map(s => s.terminate()) ?? []); await Promise.all(apps?.map(a => deleteApp(a)) ?? []); await environment?.cleanup(); });
  registerBookingAdmissionCases(() => ({ db: stores[0] as unknown as Database, second: stores[1] as unknown as Database }));
  registerBookingPolicyCommandCases(() => ({ db: stores[0] as unknown as Database, second: stores[1] as unknown as Database }));
  registerBookingTransitionCases(() => ({ db: stores[0] as unknown as Database, second: stores[1] as unknown as Database }));
  it('denies browser reads and mutations including forged administrator claims', async () => {
    for (const context of [environment.unauthenticatedContext(), environment.authenticatedContext('demo-owner'), environment.authenticatedContext('demo-admin', { isSuperadmin: true })]) {
      for (const id of ['bookingAdmissionProtocol', 'booking_policy_demo', 'booking_dispatch_demo', 'booking_policy_operation_demo']) {
        const ref = doc(context.firestore(), 'serverSettings', id);
        await assertFails(getDoc(ref)); await assertFails(setDoc(ref, { version: 1 })); await assertFails(deleteDoc(ref));
      }
    }
    expect((await stores[0].collection('serverSettings').get()).empty).toBe(true);
  });
});
