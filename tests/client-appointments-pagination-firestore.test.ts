import { readFile } from 'node:fs/promises';
import { beforeAll,beforeEach,afterAll,describe } from 'vitest';
import { initializeApp,deleteApp,type App } from 'firebase-admin/app';
import { getFirestore,type Firestore } from 'firebase-admin/firestore';
import { initializeTestEnvironment,type RulesTestEnvironment } from '@firebase/rules-unit-testing';
import type { Database } from '@/lib/storage/types';
import { registerClientPaginationCases } from './client-appointments-pagination-storage-contract';
describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('client pagination official Firestore',()=>{
 let environment:RulesTestEnvironment,apps:App[],stores:Firestore[];
 beforeAll(async()=>{const projectId='demo-sarin-client-pagination';environment=await initializeTestEnvironment({projectId,firestore:{rules:await readFile('firestore.rules','utf8')}});apps=[0,1].map(i=>initializeApp({projectId},`demo-pagination-${i}-${crypto.randomUUID()}`));stores=apps.map(app=>getFirestore(app));},30000);
 beforeEach(async()=>{await environment.clearFirestore();});afterAll(async()=>{await Promise.all(stores?.map(s=>s.terminate())??[]);await Promise.all(apps?.map(a=>deleteApp(a))??[]);await environment?.cleanup();});
 registerClientPaginationCases(()=>({db:stores[0] as unknown as Database,second:stores[1] as unknown as Database}));
});
