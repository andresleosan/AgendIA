import { afterEach, beforeEach, expect, it } from 'vitest';
import { createDataTestRuntime } from '../cloudflare/tests/data-runtime.mjs';
import type { DataCommand, DataRead, DataReadResult, DataCommitResult } from '../shared/data-protocol';
import type { Appointment } from '@/types/firestore';
import type { OwnerClientRecordCursor, OwnerClientRecordFilter } from '@/lib/owner-client-record';
import { ownerClientRecordPageSchema } from '@/lib/owner-client-record';
import { createCloudflareDatabase, StorageError } from '@/lib/storage/database';
import { ownerClientRecordCursorRevision, readOwnerClientRecord } from '@/lib/server/owner-client-record';
import { makeOwnerClientRecordAppointment as make, ownerClientRecordBusinessId as businessId, ownerClientRecordUid as clientUid, ownerClientRecordResources as resources } from './owner-client-record-fixture';

const owner = { uid: 'demo-owner' }, sourceId = 'a0000', start = 1894024800000;
const collection = `businesses/${businessId}/appointments`;
const business = { id: businessId, ownerUid: owner.uid, resources, subscription: { status: 'expired' } };
const item = (index: number, overrides: Partial<Appointment> = {}) => make({ id: `a${String(index).padStart(4, '0')}`, startAt: index < 25 ? start : start - (index - 24) * 60000, ...overrides });
const cursorFor = (appointment: Appointment): OwnerClientRecordCursor => ({ appointmentId: appointment.id, startAt: appointment.startAt, revision: ownerClientRecordCursorRevision(appointment) });
type Observation = { command: DataCommand; result?: DataReadResult | DataCommitResult; error?: unknown };
let runtime: Awaited<ReturnType<typeof createDataTestRuntime>>;
let observations: Observation[];
let beforeRead: ((command: Extract<DataCommand, { action: 'read' }>) => Promise<void>) | undefined;

function connect(observed = false) {
  return createCloudflareDatabase(async command => {
    if (observed && command.action === 'read') await beforeRead?.(command);
    const entry: Observation = { command: structuredClone(command) };
    if (observed) observations.push(entry);
    const response = await runtime.fetch(command);
    const result = await response.json() as DataReadResult | DataCommitResult;
    if (!response.ok) { entry.error = result; throw new StorageError(response.status, (result as unknown as { code: string }).code); }
    entry.result = result;
    return result;
  });
}
const read = (cursor?: OwnerClientRecordCursor, filter: OwnerClientRecordFilter = 'all', actor = owner) =>
  readOwnerClientRecord(actor, businessId, sourceId, { clientUid, filter, ...(cursor ? { cursor } : {}) }, connect(true));
const queryObservations = () => observations.filter(entry => entry.command.action === 'read' && entry.command.read.kind === 'query');
function assertBoundedPage(hasCursor: boolean) {
  const queries = queryObservations();
  expect(queries.length).toBeGreaterThanOrEqual(1); expect(queries.length).toBeLessThanOrEqual(2);
  expect(queries.reduce((count, entry) => count + (entry.result as DataReadResult).documents.length, 0)).toBeLessThanOrEqual(21);
  for (const entry of queries) {
    const spec = (entry.command as Extract<DataCommand, { action: 'read' }>).read;
    expect(spec.kind === 'query' && spec.path === collection && spec.limit! <= 21).toBe(true);
  }
  expect(observations.filter(entry => entry.command.action === 'read' && entry.command.read.kind === 'document')).toHaveLength(hasCursor ? 3 : 2);
  expect(observations.some(entry => entry.command.action === 'commit')).toBe(false);
  expect(new Set(observations.map(entry => entry.result?.revision)).size).toBe(1);
}
async function seed(appointments: Appointment[], extras: { path: string; data: object }[] = []) {
  const rows = [{ path: `businesses/${businessId}`, data: business }, ...appointments.map(data => ({ path: `${collection}/${data.id}`, data })), ...extras];
  for (let offset = 0; offset < rows.length; offset += 100) await runtime.db.batch(rows.slice(offset, offset + 100).map(({ path, data }) => runtime.db.prepare('INSERT INTO app_documents(path,parent,document_id,data,updated_at) VALUES(?,?,?,?,?)').bind(path, path.split('/').slice(0, -1).join('/'), path.split('/').at(-1), JSON.stringify(data), Date.now())));
}
beforeEach(async () => { runtime = await createDataTestRuntime({ captureSql: true }); observations = []; beforeRead = undefined; }, 30000);
afterEach(async () => { await runtime?.dispose(); });

it('d1CompositeTiesAndFiltersUseIndexes', async () => {
  const appointments = Array.from({ length: 45 }, (_, index) => item(index, { status: (['confirmed', 'completed', 'no_show'] as const)[index % 3] }));
  await seed(appointments);
  const evidence: unknown[] = [];
  for (const filter of ['all', 'completed', 'no_show'] as const) {
    const expected = appointments.filter(row => filter === 'all' || row.status === filter).map(row => row.id);
    const actual: string[] = []; let cursor: OwnerClientRecordCursor | undefined;
    do {
      observations = []; const page = await read(cursor, filter); assertBoundedPage(Boolean(cursor));
      expect(ownerClientRecordPageSchema.safeParse(page).success).toBe(true);
      actual.push(...page.rows.map(row => row.appointmentId)); cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(actual).toEqual(expected); expect(new Set(actual).size).toBe(expected.length);
    // Capture the first query and both continuation queries actually emitted by
    // the domain, including status filters with fewer than a full first page.
    observations = []; await read(undefined, filter);
    const first = queryObservations().map(entry => (entry.command as Extract<DataCommand, { action: 'read' }>).read);
    const anchor = appointments.filter(row => row.startAt === start && (filter === 'all' || row.status === filter)).at(-2)!;
    observations = []; await read(cursorFor(anchor), filter);
    const continuation = queryObservations().map(entry => (entry.command as Extract<DataCommand, { action: 'read' }>).read);
    expect(continuation).toHaveLength(2);
    for (const [index, spec] of [...first, ...continuation].entries()) {
      const result = await runtime.explain!(spec);
      expect(result.bindings[0]).toBe(collection); expect(result.bindings).toContain(clientUid); expect(result.bindings).toContain('appointment');
      if (filter !== 'all') expect(result.bindings).toContain(filter);
      if (index > 0) expect(result.bindings).toContain(anchor.startAt);
      if (index === 1) expect(result.bindings).toContain(anchor.id);
      expect(result.bindings.at(-1)).toBe((spec as Extract<DataRead, { kind: 'query' }>).limit);
      const details = result.plan.map((row: { detail: string }) => row.detail).join('\n');
      expect(details).toMatch(filter === 'all' ? /USING INDEX app_client_(record_all|page_ascending)/ : /USING INDEX app_client_(record_status|page_status_(ascending|descending))/);
      expect(details).not.toMatch(/SCAN app_documents|TEMP B-TREE/);
      evidence.push({ filter, block: ['first', 'tail', 'older'][index], ...result });
    }
  }
  console.info('owner-record generated SQL EXPLAIN', JSON.stringify(evidence));
  // D1 may still execute with no intended index. The operational EXPLAIN gate
  // detects that condition rather than inventing a runtime schema check.
  await runtime.db.exec('DROP INDEX app_client_record_all; DROP INDEX app_client_record_status;');
  observations = []; await read();
  const absent = await runtime.explain!((queryObservations()[0].command as Extract<DataCommand, { action: 'read' }>).read);
  expect(absent.plan.map((row: { detail: string }) => row.detail).join('\n')).not.toContain('app_client_record_');
}, 60000);

it('d1ThousandPlusAppointmentsNeverHitGlobalQueryCap', async () => {
  const selected = Array.from({ length: 1001 }, (_, index) => item(index));
  const extras = Array.from({ length: 1200 }, (_, index) => ({ path: `${collection}/foreign-${index}`, data: make({ id: `foreign-${index}`, client: { ...make().client!, uid: 'demo-other-client' } }) }));
  extras.push(...Array.from({ length: 1200 }, (_, index) => ({ path: `businesses/demo-other/appointments/other-${index}`, data: make({ id: `other-${index}`, tenantId: 'demo-other' }) })));
  await seed(selected, extras);
  let cursor: OwnerClientRecordCursor | undefined, pages = 0, queries = 0, returned = 0, documentReads = 0;
  const ids: string[] = [];
  do {
    observations = []; const page = await read(cursor); assertBoundedPage(Boolean(cursor));
    ids.push(...page.rows.map(row => row.appointmentId)); pages++; queries += queryObservations().length;
    documentReads += observations.length - queryObservations().length;
    returned += queryObservations().reduce((sum, entry) => sum + (entry.result as DataReadResult).documents.length, 0);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  expect(ids).toEqual(selected.map(row => row.id)); expect(new Set(ids).size).toBe(1001); expect(pages).toBe(51);
  expect(queries).toBe(101); expect(returned).toBe(1051); expect(documentReads).toBe(152);
  expect(await runtime.db.prepare('SELECT count(*) AS total FROM app_commits').first('total')).toBe(0);
  console.info('owner-record D1 bounded counts', JSON.stringify({ selected: 1001, otherUid: 1200, otherBusiness: 1200, pages, queries, queryRows: returned, documentReads, readOnlyCommits: 0 }));
}, 120000);

it('d1CursorAnchorChangeRejects', async () => {
  const rows = Array.from({ length: 45 }, (_, index) => item(index)); await seed(rows);
  const first = await read(), anchor = rows.find(row => row.id === first.nextCursor!.appointmentId)!;
  const ref = connect().collection('businesses').doc(businessId).collection('appointments').doc(anchor.id);
  for (const patch of [{ startAt: start + 1, rescheduleRevision: 1 }, { status: 'completed' }, { attendance: { revision: 1, lastEventId: 'demo-event' } }]) {
    await ref.set({ ...anchor, ...patch });
    await expect(read(first.nextCursor!)).rejects.toMatchObject({ status: 409, code: 'CLIENT_RECORD_CHANGED' });
  }
  await ref.delete(); await expect(read(first.nextCursor!)).rejects.toMatchObject({ status: 409, code: 'CLIENT_RECORD_CHANGED' });
}, 60000);

it('d1EachPageHasCoherentTransaction', async () => {
  await seed(Array.from({ length: 45 }, (_, index) => item(index)));
  let release!: () => void, paused!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; }), reached = new Promise<void>(resolve => { paused = resolve; });
  let stopped = false;
  beforeRead = async command => {
    if (!stopped && command.read.kind === 'document' && command.read.path === `${collection}/${sourceId}`) { stopped = true; paused(); await barrier; }
  };
  const pending = read(); await reached;
  const writer = connect();
  await writer.runTransaction(async tx => {
    tx.set(writer.collection('businesses').doc(businessId), { ...business, resources: resources.map(row => ({ ...row, name: 'Revised resource' })) });
    tx.set(writer.collection('businesses').doc(businessId).collection('appointments').doc(sourceId), item(0, { status: 'completed' }));
  });
  const commits = await runtime.db.prepare('SELECT count(*) AS total FROM app_commits').first('total');
  release(); const page = await pending;
  expect(page.rows.find(row => row.appointmentId === sourceId)).toMatchObject({ status: 'completed', resourceLabel: 'Revised resource' });
  expect(page.rows.every(row => row.resourceLabel === 'Revised resource')).toBe(true);
  expect(observations.map(entry => entry.result?.revision)).toEqual([0, 1, 1, 1, 1]);
  expect(observations.filter(entry => entry.command.action === 'read' && entry.command.read.kind === 'document' && entry.command.read.path === `businesses/${businessId}`)).toHaveLength(2);
  expect(queryObservations()).toHaveLength(1); expect((queryObservations()[0].result as DataReadResult).documents).toHaveLength(21);
  expect(observations.some(entry => entry.command.action === 'commit')).toBe(false);
  expect(await runtime.db.prepare('SELECT count(*) AS total FROM app_commits').first('total')).toBe(commits);
}, 60000);

it('d1SnapshotIsNotRetainedAcrossPages', async () => {
  const rows = Array.from({ length: 45 }, (_, index) => item(index)); await seed(rows);
  const first = await read(), cursor = first.nextCursor!;
  const writer = connect(), appointments = writer.collection('businesses').doc(businessId).collection('appointments');
  await writer.runTransaction(async tx => {
    tx.set(appointments.doc('new-before'), make({ id: 'new-before', startAt: start + 1 }));
    tx.set(appointments.doc('new-after'), make({ id: 'new-after', startAt: start - 1 }));
    tx.set(appointments.doc('a0030'), item(30, { startAt: start + 2 }));
    tx.set(appointments.doc(sourceId), item(0, { startAt: start - 2 }));
  });
  observations = []; const second = await read(cursor); assertBoundedPage(true);
  expect(first.rows.some(row => row.appointmentId === sourceId)).toBe(true);
  expect(second.rows.some(row => row.appointmentId === sourceId)).toBe(true);
  expect(second.rows.some(row => row.appointmentId === 'new-after')).toBe(true);
  expect(second.rows.some(row => ['new-before', 'a0030'].includes(row.appointmentId))).toBe(false);
  for (const page of [first, second]) expect(page.coverage).toEqual({ mode: 'indexed_appointments', completeness: 'not_guaranteed' });
}, 60000);

it('D1 excludes absent ordering fields, preserves incomplete coverage and fails on returned corrupt data', async () => {
  const noStart = { ...item(1) } as Partial<Appointment>, noId = { ...item(2) } as Partial<Appointment>;
  delete noStart.startAt; delete noId.id;
  await seed([item(0)], [{ path: `${collection}/missing-start`, data: noStart }, { path: `${collection}/missing-id`, data: noId }]);
  const before = (await runtime.db.prepare('SELECT path,data FROM app_documents ORDER BY path').all()).results;
  observations = []; const page = await read(); assertBoundedPage(false);
  expect(page.rows.map(row => row.appointmentId)).toEqual([sourceId]);
  expect(page.coverage).toEqual({ mode: 'indexed_appointments', completeness: 'not_guaranteed' });
  expect((await runtime.db.prepare('SELECT path,data FROM app_documents ORDER BY path').all()).results).toEqual(before);
  await connect().collection('businesses').doc(businessId).collection('appointments').doc('corrupt').set(make({ id: 'corrupt', startAt: start + 1, rescheduleRevision: -1 }));
  await expect(read()).rejects.toMatchObject({ status: 503, code: 'CLIENT_RECORD_UNVERIFIABLE' });
}, 60000);

it('D1 owner authorization and minor DTO stay private and backend errors never become empty pages', async () => {
  await seed([item(0)]);
  for (const uid of [clientUid, 'demo-other-owner', 'demo-admin']) await expect(read(undefined, 'all', { uid })).rejects.toMatchObject({ status: 403 });
  const page = await read(); expect(page.rows[0].beneficiaryKind).toBe('represented_minor');
  expect(Object.keys(page.rows[0]).sort()).toEqual(['appointmentId', 'beneficiaryKind', 'dateKey', 'endAt', 'resourceLabel', 'startAt', 'status']);
  expect(JSON.stringify(page)).not.toMatch(/Synthetic|phone|email|intakeAnswers|subjectAuthorization|representationReview|receiptId/);
  beforeRead = async command => {
    if (command.read.kind === 'query') { beforeRead = undefined; await runtime.db.exec('DROP TABLE app_documents'); }
  };
  observations = []; await expect(read()).rejects.toMatchObject({ status: 503, code: 'DATA_UNAVAILABLE' });
  expect(observations).toHaveLength(3); expect(queryObservations()).toHaveLength(1);
  expect(observations[2].error).toMatchObject({ code: 'DATA_UNAVAILABLE' });
}, 60000);
