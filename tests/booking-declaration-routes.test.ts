import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { GET, PATCH } from '@/app/api/businesses/[id]/booking-declaration/route';
import { BOOKING_DECLARATION_TEXT_VERSION } from '@/lib/booking-declaration';
import { ensureBookingAdmissionProtocol, bookingDispatchHeadKey } from '@/lib/server/booking-admission';
import { finishBookingDispatch } from '@/lib/server/booking-policy-transition';
import type { Database } from '@/lib/storage/types';
import { privateBusinessDraft } from '@/lib/server/businesses';
import { memoryFirestore } from './memoryFirestore';

const boundary = vi.hoisted(() => ({ db: null as unknown, uid: 'demo-owner', release: 'prepare' }));
vi.mock('@/lib/firebase/admin', () => ({ getAdminDb: () => boundary.db, getAdminAuth: () => ({ verifyIdToken: async () => ({ uid: boundary.uid }) }) }));
vi.mock('@/lib/booking-admission-release', async importOriginal => ({ ...await importOriginal<object>(), get BOOKING_ADMISSION_RELEASE() { return boundary.release; } }));
const context = { params: Promise.resolve({ id: 'demo-declaration' }) };
const input = { action: 'declare', expectedRevision: 0, requestId: 'demo-request', textVersion: '' };
const request = (body?: object, query = '', authenticated = true) => new Request(`http://localhost/api/businesses/demo-declaration/booking-declaration${query}`, { method: body ? 'PATCH' : 'GET', headers: { ...(authenticated ? { authorization: 'Bearer synthetic' } : {}), 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
beforeEach(() => { boundary.uid = 'demo-owner'; boundary.release = 'prepare'; boundary.db = memoryFirestore({ 'businesses/demo-declaration': { ...privateBusinessDraft({ uid: 'demo-owner' }, 1), id: 'demo-declaration' } }).db; input.textVersion = BOOKING_DECLARATION_TEXT_VERSION; });
afterEach(() => vi.unstubAllEnvs());

it('prepare endpoints fail closed; authentication and no-store apply on every response', async () => {
  for (const response of [await GET(request(), context), await PATCH(request(input), context)]) {
    expect(response.status).toBe(503); expect(response.headers.get('Cache-Control')).toBe('no-store');
  }
  expect((await GET(request(undefined, '', false), context)).status).toBe(401);
  expect((await PATCH(request(input, '', false), context)).status).toBe(401);
});

it('withdrawal is 202 while transport is uncertain; GET exposes only its safe identity and replay finalizes', async () => {
  boundary.release = 'enforce'; const db = boundary.db as Database;
  await ensureBookingAdmissionProtocol(db, 'a'.repeat(40), 'enforce');
  expect((await PATCH(request(input), context)).status).toBe(200);
  await db.collection('serverSettings').doc(bookingDispatchHeadKey('demo-declaration')).set({ version: 1, businessId: 'demo-declaration', revision: 1, refs: [{ kind: 'quota', id: 'demo-turn', policyRevision: 1, startedAt: 1 }] });
  const withdraw = { action: 'withdraw', expectedRevision: 1, requestId: 'demo-withdraw' };
  const pending = await PATCH(request(withdraw), context);
  expect(pending.status).toBe(202); expect(await pending.json()).toMatchObject({ outcome: 'pending', operation: { requestId: 'demo-withdraw', phase: 'transitioning' } });
  expect(await (await GET(request(), context)).json()).toMatchObject({ operation: { requestId: 'demo-withdraw', phase: 'transitioning' } });
  await db.runTransaction(tx => finishBookingDispatch(tx, db, 'demo-declaration', { kind: 'quota', id: 'demo-turn' }, 'transport_resolved'));
  const completed = await PATCH(request(withdraw), context);
  expect(completed.status).toBe(200); expect(await completed.json()).toMatchObject({ outcome: 'applied', capability: { revision: 2, admission: 'withdrawn' } });
});

it('owner-only strict PATCH and GET do not leak private data to other actors', async () => {
  boundary.release = 'enforce'; await ensureBookingAdmissionProtocol(boundary.db as Parameters<typeof ensureBookingAdmissionProtocol>[0], 'a'.repeat(40), 'enforce');
  for (const uid of ['demo-employee', 'demo-foreign']) {
    boundary.uid = uid; expect((await GET(request(), context)).status).toBe(403); expect((await PATCH(request(input), context)).status).toBe(403);
  }
  boundary.uid = 'demo-owner';
  for (const extra of [{ ownerUid: 'demo-owner' }, { dataMode: 'health' }, { textVersion: 'old' }, { representedMinorsEnabled: true }]) expect((await PATCH(request({ ...input, ...extra }), context)).status).toBe(400);
  expect((await PATCH(request(input, '?extra=x'), context)).status).toBe(400);
  expect((await GET(request(undefined, '?requestId=x'), context)).status).toBe(400);
  expect((await PATCH(request({ ...input, padding: 'a'.repeat(4096) }), context)).status).toBe(413);
  const response = await PATCH(request(input), context);
  expect(response.status).toBe(200); expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(await response.json()).toMatchObject({ outcome: 'applied', capability: { admission: 'active', revision: 1 } });
  const read = await GET(request(), context);
  expect(read.status).toBe(200); expect(read.headers.get('Cache-Control')).toBe('no-store');
  expect(JSON.stringify(await read.json())).not.toMatch(/ownerUid|actorUid|reason|updatedBy|operationHash/);
});
