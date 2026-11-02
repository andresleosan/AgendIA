import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Appointment } from '@/types/firestore';
import type { Database, DocumentReference, Query, Transaction } from '@/lib/storage/types';
import { ownerClientRecordPageSchema } from '@/lib/owner-client-record';
import { HttpError } from '@/lib/server/http';
import { GET, POST } from '@/app/api/businesses/[id]/appointments/[appointmentId]/client-record/route';
import { makeOwnerClientRecordAppointment as make, ownerClientRecordBusinessId as businessId, ownerClientRecordUid as clientUid, ownerClientRecordResources as resources } from './owner-client-record-fixture';
import { memoryFirestore } from './memoryFirestore';

const session = vi.hoisted(() => ({ uid: 'demo-owner' as string | null, db: undefined as unknown as Database }));
vi.mock('@/lib/server/auth', () => ({ requireUser: async () => {
  if (!session.uid) throw new HttpError(401, 'Session required');
  return { uid: session.uid };
} }));
vi.mock('@/lib/firebase/admin', () => ({ getAdminDb: () => session.db }));

const source = make(), sourceId = source.id, now = 1894027500000;
const collection = `businesses/${businessId}/appointments`;
const input = { clientUid, filter: 'all' };
const context = (id = businessId, appointmentId = sourceId) => ({ params: Promise.resolve({ id, appointmentId }) });
const request = (body: unknown = input, search = '', headers = { 'Content-Type': 'application/json' }) => new Request(
  `http://localhost/api/businesses/${businessId}/appointments/${sourceId}/client-record${search}`,
  { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) },
);
function scenario(appointments: Appointment[] = [source]) {
  const memory = memoryFirestore({
    [`businesses/${businessId}`]: { id: businessId, ownerUid: 'demo-owner', resources, subscription: { status: 'expired' } },
    ...Object.fromEntries(appointments.map(appointment => [`${collection}/${appointment.id}`, appointment])),
  });
  session.db = memory.db as unknown as Database;
  return { ...memory, db: session.db };
}
type CapturedQuery = { path: string; filters: [string, string, unknown][]; ordering: [string, string][]; cap: number };
// Keep the actual service/authorization/transaction; observe only its local storage boundary.
function observe(db: Database, queryFailure?: Error) {
  const reads: string[] = [], queries: CapturedQuery[] = [], writes: string[] = [], collections: string[] = [];
  let transactions = 0;
  const observed: Database = {
    collection: name => { collections.push(name); return db.collection(name); },
    runTransaction: (handler, options) => db.runTransaction(tx => {
      transactions++;
      return handler(new Proxy(tx, { get(target, key) {
        if (key === 'get') return (reference: DocumentReference | Query) => {
          if ('where' in reference) {
            queries.push(reference as unknown as CapturedQuery);
            if (queryFailure) throw queryFailure;
          } else reads.push(reference.path);
          return (target.get as (reference: DocumentReference | Query) => Promise<unknown>).call(target, reference);
        };
        if (['set', 'create', 'update', 'delete'].includes(String(key))) return () => { writes.push(String(key)); throw new Error('Read cannot write'); };
        return Reflect.get(target, key);
      } }) as Transaction);
    }, options),
  };
  session.db = observed;
  return { reads, queries, writes, collections, transactions: () => transactions };
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); session.uid = 'demo-owner'; });
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('private owner client record HTTP boundary', () => {
  it('unauthenticated401', async () => {
    const f = scenario(), observed = observe(f.db); session.uid = null;
    expect((await POST(request(), context())).status).toBe(401);
    expect(observed.transactions()).toBe(0);
  });

  it('clientOtherOwnerAndSuperadmin403', async () => {
    const f = scenario(), before = structuredClone(f.rows); vi.stubEnv('SUPERADMIN_UID', 'demo-superadmin');
    for (const uid of [clientUid, 'demo-other-owner', 'demo-chair', 'demo-superadmin']) {
      session.uid = uid;
      expect((await POST(request(), context())).status).toBe(403);
    }
    session.uid = 'demo-owner';
    await f.db.collection('businesses').doc(businessId).set({ id: businessId, ownerUid: 'demo-next-owner', resources });
    expect((await POST(request(), context())).status).toBe(403);
    expect(f.rows.get(`${collection}/${sourceId}`)).toEqual(before.get(`${collection}/${sourceId}`));
  });

  it('sourceAndTenantPathCannotBeSubstituted', async () => {
    const f = scenario();
    for (const [id, appointmentId] of [['bad/path', sourceId], [businessId, 'bad/path'], [`${businessId}\n`, sourceId], [businessId, `${sourceId}\n`]]) {
      expect((await POST(request(), context(id, appointmentId))).status).toBe(400);
    }
    expect((await POST(request(), context('demo-missing', sourceId))).status).toBe(404);
    expect((await POST(request(), context(businessId, 'demo-missing'))).status).toBe(404);
    expect((await POST(request({ ...input, clientUid: 'demo-guessed-account' }), context())).status).toBe(404);
    const sourceRef = f.db.collection('businesses').doc(businessId).collection('appointments').doc(sourceId);
    for (const patch of [{ id: 'demo-other' }, { tenantId: 'demo-other' }, { type: 'manual_block' }]) {
      await sourceRef.set({ ...source, ...patch });
      expect((await POST(request(), context())).status).toBe(404);
    }
    await sourceRef.set(source);
    await f.db.collection('businesses').doc(businessId).set({ id: 'demo-other', ownerUid: 'demo-owner', resources });
    expect((await POST(request(), context())).status).toBe(404);
  });

  it('postOnlyReadHasNoSideEffects', async () => {
    const f = scenario(), before = structuredClone(f.rows), observed = observe(f.db);
    const response = await POST(request(), context()), page = await response.json();
    expect(response.status).toBe(200);
    expect(ownerClientRecordPageSchema.safeParse(page).success).toBe(true);
    expect(page).toEqual({
      scope: { businessId, sourceAppointmentId: sourceId, clientUid }, filter: 'all', checkedAt: now,
      rows: [{ appointmentId: sourceId, dateKey: '2030-01-07', startAt: 1894024800000, endAt: 1894026600000,
        status: 'confirmed', resourceLabel: 'Demo resource', beneficiaryKind: 'represented_minor' }],
      nextCursor: null, coverage: { mode: 'indexed_appointments', completeness: 'not_guaranteed' },
    });
    expect(observed.transactions()).toBe(1); expect(observed.writes).toEqual([]); expect(f.rows).toEqual(before);
    const rejected = await GET(new Request(request().url), context());
    expect(rejected.status).toBe(405); expect(rejected.headers.get('Allow')).toBe('POST');
    expect(await rejected.json()).not.toHaveProperty('rows');
    expect(observed.transactions()).toBe(1);
  });

  it('strict2048ByteBodyAndNoQuery', async () => {
    const f = scenario(), observed = observe(f.db), json = JSON.stringify(input);
    expect((await POST(request(json + ' '.repeat(2048 - Buffer.byteLength(json))), context())).status).toBe(200);
    for (const body of [json + ' '.repeat(2049 - Buffer.byteLength(json)), JSON.stringify({ ...input, extra: 'é'.repeat(1000) })]) {
      expect((await POST(request(body), context())).status).toBe(413);
    }
    for (const search of ['?', '?clientUid=demo-guessed', '?filter=all', '?x=', '?x=1&x=2']) {
      expect((await POST(request(input, search), context())).status).toBe(400);
    }
    for (const extra of [{ pageSize: 1 }, { requestId: 'demo-request' }, { ownerUid: 'demo-owner' }, { uid: clientUid }]) {
      expect((await POST(request({ ...input, ...extra }), context())).status).toBe(400);
    }
    expect(observed.transactions()).toBe(1);
  });

  it('malformedFilterCursorAndUid400', async () => {
    const f = scenario(), observed = observe(f.db);
    const cursor = { appointmentId: sourceId, startAt: 1894024800000, revision: '0'.repeat(64) };
    for (const body of [null, [], {}, '{broken', '', { ...input, filter: 'confirmed' }, { ...input, filter: null },
      ...['', 'a'.repeat(129), `${clientUid}\n`, `${clientUid}\x00`, `${clientUid}\x7f`, 12].map(uid => ({ ...input, clientUid: uid })),
      ...[null, [], {}, { ...cursor, appointmentId: 'bad/path' }, { ...cursor, startAt: 0 }, { ...cursor, startAt: 1.5 },
        { ...cursor, revision: 'A'.repeat(64) }, { ...cursor, revision: '0'.repeat(63) }, { ...cursor, extra: true }].map(value => ({ ...input, cursor: value }))]) {
      expect((await POST(request(body), context())).status).toBe(400);
    }
    expect(observed.transactions()).toBe(0);
  });

  it('contentType415', async () => {
    const f = scenario(), observed = observe(f.db);
    for (const type of ['text/plain', 'application/x-www-form-urlencoded', '']) {
      expect((await POST(request(input, '', { 'Content-Type': type }), context())).status).toBe(415);
    }
    expect(observed.transactions()).toBe(0);
  });

  it('actualStreamOver2048Bytes413', async () => {
    const f = scenario(), observed = observe(f.db);
    for (const length of [undefined, '1']) {
      const cancelled = vi.fn(), encoder = new TextEncoder(); let chunk = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) { controller.enqueue(encoder.encode(chunk++ === 0 ? JSON.stringify(input) : 'é'.repeat(1025))); },
        cancel: cancelled,
      });
      const streamed = new Request(request().url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(length ? { 'Content-Length': length } : {}) }, body, duplex: 'half' } as RequestInit);
      expect((await POST(streamed, context())).status).toBe(413);
      expect(cancelled).toHaveBeenCalledOnce();
    }
    expect(observed.transactions()).toBe(0);
  });

  it('allErrorsAndSuccessNoStore', async () => {
    const f = scenario();
    const responses = [await POST(request(), context()), await POST(request({ ...input, filter: 'invalid' }), context())];
    session.uid = null; responses.push(await POST(request(), context()));
    session.uid = 'demo-other'; responses.push(await POST(request(), context())); session.uid = 'demo-owner';
    responses.push(await POST(request(), context(businessId, 'demo-missing')),
      await POST(request(' '.repeat(2049)), context()), await POST(request(input, '', { 'Content-Type': 'text/plain' }), context()));
    responses.push(await POST(request({ ...input, cursor: { appointmentId: sourceId, startAt: source.startAt, revision: '0'.repeat(64) } }), context()));
    expect(await responses.at(-1)!.clone().json()).toMatchObject({ code: 'CLIENT_RECORD_CHANGED' });
    const ref = f.db.collection('businesses').doc(businessId).collection('appointments').doc(sourceId);
    await ref.set({ ...source, client: null }); responses.push(await POST(request(), context()));
    expect(await responses.at(-1)!.clone().json()).toMatchObject({ code: 'CLIENT_RECORD_NO_ACCOUNT' });
    await ref.set({ ...source, rescheduleRevision: -1 }); responses.push(await POST(request(), context()));
    expect(await responses.at(-1)!.clone().json()).toEqual({ error: 'No se pueden verificar las reservas de esta cuenta.', code: 'CLIENT_RECORD_UNVERIFIABLE' });
    responses.push(await GET(new Request(request().url), context()));
    expect(responses.map(response => response.status)).toEqual([200, 400, 401, 403, 404, 413, 415, 409, 409, 503, 405]);
    for (const response of responses) expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('storageFailureIsSafe503NeverAnEmptyPageOrArbitraryCode', async () => {
    const f = scenario(), failure = Object.assign(new Error('Synthetic private upstream detail'), { code: 'FORGED_STORAGE_CODE', status: 503 });
    observe(f.db, failure);
    const response = await POST(request(), context()), body = await response.json();
    expect(response.status).toBe(503); expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(body).toEqual({ error: 'Servicio temporalmente no disponible. Revisa la configuración o inténtalo de nuevo.' });
    expect(body).not.toHaveProperty('rows');
  });

  it('unknown429AndAbortErrorsAreSafe503WithoutUpstreamText', async () => {
    for (const failure of [Object.assign(new Error('Synthetic private upstream throttle detail'), { status: 429 }),
      Object.assign(new Error('Synthetic private upstream cancellation detail'), { name: 'AbortError' })]) {
      const f = scenario(); observe(f.db, failure);
      const response = await POST(request(), context());
      expect(response.status).toBe(503); expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(response.headers.get('Retry-After')).toBeNull();
      expect(await response.json()).toEqual({ error: 'Servicio temporalmente no disponible. Revisa la configuración o inténtalo de nuevo.' });
    }
  });

  it('doesNotCallViewMineOrProfileDirectory', async () => {
    const foreign = make({ id: 'demo-foreign', tenantId: 'demo-foreign-business' });
    const f = scenario([source, make({ id: 'demo-other-account', client: { ...source.client!, uid: 'demo-other-account' } })]);
    await f.db.collection('businesses').doc(foreign.tenantId).collection('appointments').doc(foreign.id).set(foreign);
    await f.db.collection('businesses').doc(foreign.tenantId).set({ id: foreign.tenantId, ownerUid: 'demo-other-owner', resources });
    expect((await POST(request(), context(foreign.tenantId, foreign.id))).status).toBe(403);
    const observed = observe(f.db), network = vi.fn(() => { throw new Error('No network or view=mine'); }); vi.stubGlobal('fetch', network);
    const response = await POST(request(), context()), page = await response.json();
    expect(response.status).toBe(200); expect(page.rows.map((row: { appointmentId: string }) => row.appointmentId)).toEqual([sourceId]);
    expect(observed.collections).toEqual(['businesses']);
    expect(observed.reads).toEqual([`businesses/${businessId}`, `${collection}/${sourceId}`]);
    expect(observed.queries.map(query => ({ path: query.path, filters: query.filters, ordering: query.ordering, cap: query.cap }))).toEqual([
      { path: collection, filters: [['client.uid', '==', clientUid], ['type', '==', 'appointment']], ordering: [['startAt', 'desc'], ['id', 'asc']], cap: 21 },
    ]);
    expect(network).not.toHaveBeenCalled();
    expect(JSON.stringify(page)).not.toMatch(/Synthetic|phone|email|intakeAnswers|serviceName|serviceId|price|subjectAuthorization|representationReview|displayName/);
  });

  it('pagesAndExactOutcomeFiltersUseExistingBoundedDomainQueries', async () => {
    const f = scenario([source, ...Array.from({ length: 24 }, (_, index) => make({ id: `demo-${String(index).padStart(2, '0')}`, status: 'completed' }))]);
    const observed = observe(f.db), first = await POST(request({ clientUid, filter: 'completed' }), context()), page = await first.json();
    expect(first.status).toBe(200); expect(page.rows).toHaveLength(20); expect(page.nextCursor.appointmentId).toBe('demo-19');
    const second = await POST(request({ clientUid, filter: 'completed', cursor: page.nextCursor }), context()), next = await second.json();
    expect(second.status).toBe(200); expect(next.rows.map((row: { appointmentId: string }) => row.appointmentId)).toEqual(['demo-20', 'demo-21', 'demo-22', 'demo-23']);
    expect(next.nextCursor).toBeNull();
    expect(observed.queries.map(query => query.cap)).toEqual([21, 21, 17]);
    expect(observed.queries.every(query => query.filters.some(([field, op, value]) => field === 'status' && op === '==' && value === 'completed'))).toBe(true);
    expect((await (await POST(request({ clientUid, filter: 'no_show' }), context())).json()).rows).toEqual([]);
  });
});

describe('additive client record index composition (no physical backend claim)', () => {
  it('addsBothFirestoreOrdersAndRetainsExistingIndexes', () => {
    const indexes = JSON.parse(readFileSync('firestore.indexes.json', 'utf8'));
    const field = (fieldPath: string, order = 'ASCENDING') => ({ fieldPath, order });
    for (const status of [[], [field('status')]]) expect(indexes.indexes).toContainEqual({ collectionGroup: 'appointments', queryScope: 'COLLECTION',
      fields: [field('client.uid'), field('type'), ...status, field('startAt', 'DESCENDING'), field('id')] });
    expect(indexes.indexes).toHaveLength(18);
    expect(indexes.indexes).toContainEqual({ collectionGroup: 'waitlistRequests', queryScope: 'COLLECTION', fields: [field('request.dateKey'), field('request.createdAt'), field('request.id')] });
    expect(indexes.indexes).toContainEqual({ collectionGroup: 'attendanceEvents', queryScope: 'COLLECTION', fields: [field('appointmentId'), field('sequence', 'DESCENDING')] });
    expect(indexes.indexes).toContainEqual({ collectionGroup: 'appointments', queryScope: 'COLLECTION', fields: [field('client.uid'), field('status'), field('type'), field('startAt')] });
    expect(indexes.indexes).toContainEqual({ collectionGroup: 'reminderReceipts', queryScope: 'COLLECTION', fields: [field('ownerUid'), field('appointmentId')] });
    expect(indexes.fieldOverrides).toEqual([{ collectionGroup: 'paymentImages', fieldPath: 'receiptDataUrl', indexes: [] }]);
  });

  it('migration0008DeclaresOnlyTheTwoAdditiveExactExpressionOrders', () => {
    const sql = readFileSync('cloudflare/migrations/0008_owner_client_record.sql', 'utf8').replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').trim();
    expect(sql).toBe("CREATE INDEX IF NOT EXISTS app_client_record_all ON app_documents ( parent, json_extract(data, '$.client.uid'), json_extract(data, '$.type'), json_extract(data, '$.startAt') DESC, json_extract(data, '$.id') ASC, path ); CREATE INDEX IF NOT EXISTS app_client_record_status ON app_documents ( parent, json_extract(data, '$.client.uid'), json_extract(data, '$.type'), json_extract(data, '$.status'), json_extract(data, '$.startAt') DESC, json_extract(data, '$.id') ASC, path );");
  });
});
