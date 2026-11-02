import { beforeEach, expect, it, vi } from 'vitest';
import { memoryFirestore } from './memoryFirestore';
const state = vi.hoisted(() => ({ uid: 'demo-admin' as string | null, db: null as unknown }));
vi.mock('@/lib/firebase/admin', () => ({ getAdminDb: () => state.db }));
vi.mock('@/lib/server/auth', async () => { const { HttpError } = await import('@/lib/server/http'); return { isSuperadmin: (uid: string) => uid === 'demo-admin', requireSuperadmin: async () => { if (!state.uid) throw new HttpError(401, 'Login'); if (state.uid !== 'demo-admin') throw new HttpError(403, 'Forbidden'); return { uid: state.uid }; } }; });
import { GET, PATCH } from '@/app/api/admin/response-quota/route';
beforeEach(() => { state.uid = 'demo-admin'; state.db = memoryFirestore().db; });
it.each([null, 'demo-client', 'demo-owner', 'demo-staff'])('quota review endpoint denies nonadmins: %s', async uid => {
  state.uid = uid;
  for (const response of [await GET(new Request('https://sarin.test/api/admin/response-quota')), await PATCH(new Request('https://sarin.test/api/admin/response-quota', { method: 'PATCH', body: '{}' }))]) {
    expect(response.status).toBe(uid ? 403 : 401); expect(response.headers.get('cache-control')).toBe('no-store');
  }
});
it.each(['after=', 'after=bad', 'after=a&after=b', 'business=other'])('quota listing rejects malformed or extraneous cursor: %s', async query => {
  expect((await GET(new Request('https://sarin.test/api/admin/response-quota?' + query))).status).toBe(400);
});
it('read-only quota listing is private and write bodies are bounded and strict', async () => {
  const response = await GET(new Request('https://sarin.test/api/admin/response-quota'));
  expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store'); expect(await response.json()).toEqual({ attempts: [], next: null });
  const oversized = await PATCH(new Request('https://sarin.test/api/admin/response-quota', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: 'x'.repeat(5000) }) }));
  expect(oversized.status).toBe(413);
  expect((await PATCH(new Request('https://sarin.test/api/admin/response-quota', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{"ownerUid":"forged"}' }))).status).toBe(400);
});
