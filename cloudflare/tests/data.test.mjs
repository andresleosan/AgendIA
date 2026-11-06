import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import { executeDataCommand, handleDataOutbound } from '../src/data.ts';
import { isDataPath } from '../../shared/data-protocol.ts';

const require = createRequire(import.meta.url);
const wranglerRequire = createRequire(require.resolve('wrangler/package.json'));
const { Miniflare, convertV4MiniflareOptions } = wranglerRequire('miniflare');
const schema = readFileSync(new URL('../migrations/0001_data.sql', import.meta.url), 'utf8');
const commit = (revision, writes, requestId = crypto.randomUUID()) => ({ action: 'commit', expectedRevision: revision, requestId, writes });
const set = (path, data, merge) => ({ op: 'set', path, data, ...(merge === undefined ? {} : { merge }) });
const read = (path) => ({ action: 'read', read: { kind: 'document', path } });
const query = (path, filters = [], order = [], limit) => ({ action: 'read', read: { kind: 'query', path, filters, order, ...(limit === undefined ? {} : { limit }) } });
async function fixture(context) {
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default {fetch(){return new Response("test")}}', compatibilityDate: '2026-10-13',
    d1Databases: { SARIN_DB: 'sarin-data-test' }, r2Buckets: { SARIN_FILES: 'sarin-files-test' } }));
  context.after(() => mf.dispose());
  const env = { SARIN_DB: await mf.getD1Database('SARIN_DB'), SARIN_FILES: await mf.getR2Bucket('SARIN_FILES'),
    SARIN_APP: { idFromName: name => ({ toString: () => name === 'sarin-global-app' ? 'singleton' : 'other' }) } };
  // Execute the migration as one SQLite program, including its CAS trigger.
  await env.SARIN_DB.exec(schema.replace(/^--.*$/gm, '').replace(/\r?\n/g, ' '));
  return env;
}
const isError = code => error => error.code === code && !/private-payload/.test(error.message);

test('booking admission protocol cannot delete, merge, downgrade or replace its original marker', async context => {
  const env = await fixture(context), path = 'serverSettings/bookingAdmissionProtocol';
  const marker = { version: 1, minimumReader: 2, introducedBySha: 'a'.repeat(40) };
  await executeDataCommand(commit(0, [{ op: 'create', path, data: marker }]), env);
  for (const writes of [[{ op: 'delete', path }], [set(path, { ...marker, minimumReader: 1 })], [set(path, { ...marker, introducedBySha: 'b'.repeat(40) })], [set(path, marker, true)], [set(path, { ...marker, unexpected: true })]]) {
    await assert.rejects(executeDataCommand(commit(1, [set('serverSettings/demo-atomic', { value: 'private-payload' }), ...writes]), env), isError('DATA_INVALID'));
    assert.equal((await executeDataCommand(read('serverSettings/demo-atomic'), env)).documents.length, 0);
  }
  await executeDataCommand(commit(1, [set(path, marker)]), env);
  assert.deepEqual((await executeDataCommand(read(path), env)).documents[0].data, marker);
});

test('waitlist offers admit only private children with bounded existing typed query fields', async context => {
  const env = await fixture(context);
  const parent = 'businesses/demo-offers/waitlistOffers';
  const head = 'businesses/demo-offers/waitlistOfferHeads/record';
  for (const child of ['waitlistOfferHeads', 'waitlistOffers']) {
    assert.equal(isDataPath(`businesses/demo-offers/${child}`, false), true);
    assert.equal(isDataPath(`businesses/demo-offers/${child}/${'a'.repeat(128)}`, true), true);
    assert.equal(isDataPath(`businesses/demo-offers/${child}/${'a'.repeat(129)}`, true), false);
    assert.equal(isDataPath(`publicBusinesses/demo-offers/${child}/record`, true), false);
  }
  await executeDataCommand(commit(0, [set(head, { revision: 1, currentOfferId: 'offer-a' }),
    set(parent + '/offer-b', { id: 'offer-b', waitlistRecordId: 'record', dateKey: '2030-01-07', createdAt: 100, state: 'booked' }),
    set(parent + '/offer-a', { id: 'offer-a', waitlistRecordId: 'record', dateKey: '2030-01-07', createdAt: 100, state: 'offered' }),
    set(parent + '/older', { id: 'older', waitlistRecordId: 'record', dateKey: '2030-01-07', createdAt: 99, state: 'offered' })]), env);
  assert.equal((await executeDataCommand(read(head), env)).documents[0].data.currentOfferId, 'offer-a');
  const order = [{ field: 'createdAt', direction: 'desc' }, { field: 'id', direction: 'asc' }];
  assert.deepEqual((await executeDataCommand(query(parent, [{ field: 'dateKey', op: '==', value: '2030-01-07' }], order, 2), env)).documents.map(row => row.data.id), ['offer-a', 'offer-b']);
  assert.deepEqual((await executeDataCommand(query(parent, [{ field: 'dateKey', op: '==', value: '2030-01-07' }, { field: 'state', op: '==', value: 'offered' }], order, 21), env)).documents.map(row => row.data.id), ['offer-a', 'older']);
  assert.equal((await executeDataCommand(query(parent, [{ field: 'waitlistRecordId', op: '==', value: 'record' }], [{ field: '__name__', direction: 'asc' }], 100), env)).documents.length, 3);
  const noAccess = new Proxy({}, { get() { assert.fail('Invalid offer command accessed storage.'); } });
  for (const command of [read(parent + '/offer-a/nested/secret'), query(parent + '/offer-a/nested'), read('waitlistOffers/offer-a'),
    read('businesses/demo-offers/waitlistOfferHistory/offer-a'), read('publicBusinesses/demo-offers/waitlistOffers/offer-a'),
    ...['dateKey', 'id', 'state', 'waitlistRecordId'].map(field => query(parent, [{ field, op: '==', value: 100 }])),
    query(parent, [{ field: 'createdAt', op: '==', value: '100' }]), query(parent, [{ field: 'clientUid', op: '==', value: 'client' }]),
    query(parent, [], [], 0), query(parent, [], [], 1001)]) {
    await assert.rejects(executeDataCommand(command, noAccess), isError('DATA_INVALID'));
  }
  await assert.rejects(executeDataCommand(commit(1, [set(parent + '/oversized', { payload: 'é'.repeat(524288) })]), noAccess), isError('DATA_LIMIT'));
});

test('owner waitlist review child and four query fields are private and strictly typed', async context => {
  const env = await fixture(context);
  const path = 'businesses/demo-wait/waitlistOwnerReviews/entry';
  assert.equal(isDataPath(path, true), true);
  assert.equal(isDataPath('publicBusinesses/demo/waitlistOwnerReviews/entry', true), false);
  await executeDataCommand(commit(0, [set(path, { waitlistRecordId: 'record', reviewed: true })]), env);
  assert.equal((await executeDataCommand(query('businesses/demo-wait/waitlistOwnerReviews', [{ field: 'waitlistRecordId', op: '==', value: 'record' }], [], 20), env)).documents.length, 1);
  await executeDataCommand(commit(1, [set('businesses/demo-wait/waitlistRequests/record', { request: { dateKey: '2030-01-07', createdAt: 100, id: 'entry' } })]), env);
  const result = await executeDataCommand(query('businesses/demo-wait/waitlistRequests', [{ field: 'request.dateKey', op: '==', value: '2030-01-07' }], [{ field: 'request.createdAt', direction: 'asc' }, { field: 'request.id', direction: 'asc' }], 21), env);
  assert.equal(result.documents.length, 1);
  const noAccess = new Proxy({}, { get() { assert.fail('Invalid owner waitlist command accessed storage.'); } });
  for (const command of [read('businesses/demo/waitlistOwnerReviewsUnknown/entry'), read('publicBusinesses/demo/waitlistOwnerReviews/entry'),
    query('businesses/demo-wait/waitlistRequests', [{ field: 'request.createdAt', op: '==', value: '100' }]),
    query('businesses/demo-wait/waitlistRequests', [{ field: 'request.id', op: '==', value: 100 }]),
    query('businesses/demo-wait/waitlistRequests', [{ field: 'request.dateKey', op: '==', value: 100 }]),
    query('businesses/demo-wait/waitlistOwnerReviews', [{ field: 'waitlistRecordId', op: '==', value: 100 }]),
    query('businesses/demo-wait/waitlistRequests', [{ field: 'request.case.bookingRequestId', op: '==', value: 'private' }])]) {
    await assert.rejects(executeDataCommand(command, noAccess), isError('DATA_INVALID'));
  }
});
test('owner waitlist review child document IDs paginate without trusting JSON id', async context => {
  const env=await fixture(context),parent='businesses/demo-wait/waitlistOwnerReviews';
  await executeDataCommand(commit(0,[set(parent+'/a',{waitlistRecordId:'record'}),set(parent+'/b',{waitlistRecordId:'record',id:'forged'})]),env);
  const result=await executeDataCommand(query(parent,[{field:'waitlistRecordId',op:'==',value:'record'},{field:'__name__',op:'>',value:'a'}],[{field:'__name__',direction:'asc'}],100),env);
  assert.deepEqual(result.documents.map(d=>d.path),[parent+'/b']);
  const noAccess=new Proxy({},{get(){assert.fail('Invalid document id accessed storage');}});
  for(const value of [null,100,'a/b','bad\n'])await assert.rejects(executeDataCommand(query(parent,[{field:'__name__',op:'>',value}]),noAccess),isError('DATA_INVALID'));
});

test('owner reschedule proofs use only the private business child', async context => {
  assert.equal(isDataPath('businesses/demo/ownerRescheduleProposals/proof', true), true);
  assert.equal(isDataPath('businesses/demo/ownerRescheduleProposals', false), true);
  assert.equal(isDataPath('businesses/demo/arbitraryProofs/proof', true), false);
  assert.equal(isDataPath('publicBusinesses/demo/ownerRescheduleProposals/proof', true), false);
  const env = await fixture(context);
  await executeDataCommand(commit(0, [set('businesses/demo/ownerRescheduleProposals/proof', { state: 'prepared' })]), env);
  assert.deepEqual((await executeDataCommand(read('businesses/demo/ownerRescheduleProposals/proof'), env)).documents[0].data, { state: 'prepared' });
});

test('resource schedule policy and operation children are private and atomic', async context => {
  const env = await fixture(context);
  const result = await executeDataCommand(commit(0, [set('businesses/demo/resourceSchedulePolicies/current', { revision: 1 }), set('businesses/demo/resourceScheduleOperations/receipt', { resultRevision: 1 })]), env);
  assert.equal(result.revision, 1);
  assert.equal((await executeDataCommand(read('businesses/demo/resourceSchedulePolicies/current'), env)).documents[0].data.revision, 1);
  await assert.rejects(executeDataCommand(commit(1, [set('publicBusinesses/demo/resourceSchedulePolicies/current', { revision: 2 })]), env), isError('DATA_INVALID'));
});

test('attendance events use the private business child with exact paths and bounded typed queries', async context => {
  const env = await fixture(context);
  const migration = readFileSync(new URL('../migrations/0007_appointment_attendance.sql', import.meta.url), 'utf8').replace(/^--.*$/gm, '').replace(/\r?\n/g, ' ');
  await env.SARIN_DB.exec(migration);
  await env.SARIN_DB.exec(migration);
  const path = 'businesses/demo-attendance/attendanceEvents/demo-event';
  const event = { appointmentId: 'demo-appointment', sequence: 1, status: 'completed' };
  await executeDataCommand(commit(0, [set(path, event)]), env);
  assert.deepEqual((await executeDataCommand(read(path), env)).documents, [{ path, data: event }]);
  const result = await executeDataCommand(query('businesses/demo-attendance/attendanceEvents',
    [{ field: 'appointmentId', op: '==', value: 'demo-appointment' }, { field: 'sequence', op: '<', value: 2 }],
    [{ field: 'sequence', direction: 'desc' }], 21), env);
  assert.deepEqual(result.documents, [{ path, data: event }]);
  assert.deepEqual((await executeDataCommand(query('businesses/demo-other/attendanceEvents'), env)).documents, []);
  const noAccess = new Proxy({}, { get() { assert.fail('Invalid attendance command accessed storage.'); } });
  for (const command of [read(path + '/nested/secret'), query(path + '/nested'), read('attendanceEvents/demo-event'),
    read('businesses/demo-attendance/unknownEvents/demo-event'), query('businesses/demo-attendance/attendanceEvents', [{ field: 'sequence', op: '<', value: '2' }]),
    commit(1, [set(path, { payload: 'é'.repeat(524288) })])]) {
    await assert.rejects(executeDataCommand(command, noAccess), error => ['DATA_INVALID', 'DATA_LIMIT'].includes(error.code));
  }
});

test('reads a missing document with the current global revision and preserves nested JSON', async context => {
  const env = await fixture(context);
  assert.deepEqual(await executeDataCommand(read('users/missing'), env), { revision: 0, documents: [] });
  await executeDataCommand(commit(0, [set('users/one', { name: 'private-payload', profile: { phone: null, tags: ['one'] } })]), env);
  assert.deepEqual(await executeDataCommand(read('users/one'), env), { revision: 1, documents: [{ path: 'users/one', data: { name: 'private-payload', profile: { phone: null, tags: ['one'] } } }] });
});

test('validates the complete command before accessing any database or bucket', async () => {
  const noAccess = new Proxy({}, { get() { assert.fail('Invalid input accessed storage.'); } });
  for (const command of [
    read('secrets/one'), read('businesses/one/private/secret'), read('users/../one'), read('/users/one'),
    { action: 'sql', sql: 'SELECT * FROM users' }, query('businesses', [{ field: "ownerUid') OR 1=1 --", op: '==', value: 'one' }]),
    query('businesses', [{ field: 'createdAt', op: '==', value: 'string-is-not-time' }]),
    query('businesses', [{ field: 'ownerUid', op: '!=', value: 'one' }]), query('businesses', [], [], 1001),
    commit(-1, []), commit(0, [], 'not-a-uuid'), commit(0, [set('users/one', JSON.parse('{"nested":{"__proto__":{"polluted":true}}}'))]),
    commit(0, [set('users/one', { private: Infinity })]), commit(0, [set('users/one', { text: 'x'.repeat(1_100_000) })]),
    commit(0, [set('users/valid', {}), set('unrecognized/invalid', {})]),
  ]) await assert.rejects(executeDataCommand(command, noAccess), error => ['DATA_INVALID', 'DATA_LIMIT'].includes(error.code));
});

test('shares path and JSON rejection rules with migration preflight before touching storage', async () => {
  const noAccess = new Proxy({}, { get() { assert.fail('Invalid shared-contract input accessed storage.'); } });
  let deep = { leaf: null };
  for (let depth = 0; depth < 33; depth++) deep = { nested: deep };
  for (const command of [
    read(`users/${'a'.repeat(129)}`), read('users/constructor'), read('businesses/constructor/appointments/one'),
    commit(0, [set('users/one', deep)]), commit(0, [set('users/one', JSON.parse('{"nested":{"constructor":1}}'))]),
    commit(0, [set('users/one', { invalidUnicode: '\ud800' })]), commit(0, [set('users/one', { negativeZero: -0 })]),
  ]) await assert.rejects(executeDataCommand(command, noAccess), isError('DATA_INVALID'));
});

test('accepts the shared JSON depth boundary independently of the command envelope', async context => {
  const env = await fixture(context);
  let data = { leaf: null };
  for (let depth = 0; depth < 31; depth++) data = { nested: data };
  await executeDataCommand(commit(0, [set('users/one', data)]), env);
  assert.deepEqual((await executeDataCommand(read('users/one'), env)).documents[0].data, data);
});

test('uses typed parameterized queries, exact parents, ordering and explicit limits', async context => {
  const env = await fixture(context);
  await executeDataCommand(commit(0, [
    set('businesses/a', { ownerUid: "o' OR 1=1 --", createdAt: 20 }), set('businesses/b', { ownerUid: 'other', createdAt: 10 }),
    set('businesses/c', { ownerUid: "o' OR 1=1 --", createdAt: 30 }), set('businesses/a/appointments/child', { ownerUid: "o' OR 1=1 --", createdAt: 40 }),
  ]), env);
  const result = await executeDataCommand(query('businesses', [{ field: 'ownerUid', op: '==', value: "o' OR 1=1 --" }], [{ field: 'createdAt', direction: 'desc' }], 1), env);
  assert.equal(result.revision, 1);
  assert.deepEqual(result.documents.map(row => row.path), ['businesses/c']);
  const range = await executeDataCommand(query('businesses', [{ field: 'createdAt', op: '<=', value: 20 }], [{ field: 'createdAt', direction: 'asc' }]), env);
  assert.deepEqual(range.documents.map(row => row.path), ['businesses/b', 'businesses/a']);
});

test('CAS catches query phantoms and only one simultaneous stale writer commits', async context => {
  const env = await fixture(context);
  const empty = await executeDataCommand(query('businesses/shop/appointments'), env);
  const outcomes = await Promise.allSettled([
    executeDataCommand(commit(empty.revision, [set('businesses/shop/appointments/a', { dateKey: '2030-01-01', resourceId: 'one' })]), env),
    executeDataCommand(commit(empty.revision, [set('businesses/shop/appointments/b', { dateKey: '2030-01-01', resourceId: 'one' })]), env),
  ]);
  assert.equal(outcomes.filter(row => row.status === 'fulfilled').length, 1);
  assert.equal(outcomes.find(row => row.status === 'rejected').reason.code, 'DATA_CONFLICT');
  assert.equal((await executeDataCommand(query('businesses/shop/appointments'), env)).documents.length, 1);
  assert.equal((await env.SARIN_DB.prepare('SELECT COUNT(*) AS n FROM app_commits').first()).n, 1);
});
test('platform continuation cursor fields are typed strings with strict bounded ordering', async context => {
  const env = await fixture(context);
  for (const field of ['outboxId', 'jobId', 'conversationId']) {
    const root = field === 'outboxId' ? 'platformWhatsAppOutbox' : 'platformWhatsAppJobs';
    const revision = (await executeDataCommand(read('users/missing'), env)).revision;
    await executeDataCommand(commit(revision, [
      set(root + '/first_' + field, { [field]: 'a', status: 'prepared' }),
      set(root + '/last_' + field, { [field]: 'z', status: 'prepared' }),
      set(root + '/wrong_' + field, { [field]: 1, status: 'prepared' }),
    ]), env);
    const result = await executeDataCommand(query(root, [{ field: 'status', op: '==', value: 'prepared' }, { field, op: '>', value: 'a' }], [{ field, direction: 'asc' }], 25), env);
    assert.deepEqual(result.documents.map(row => row.path), [root + '/last_' + field]);
    await assert.rejects(executeDataCommand(query(root, [{ field, op: '>', value: 1 }], [], 25), env), isError('DATA_INVALID'));
  }
});

test('an existing create rolls back every write, journal entry and revision increment', async context => {
  const env = await fixture(context);
  await executeDataCommand(commit(0, [set('users/existing', { stable: true })]), env);
  await assert.rejects(executeDataCommand(commit(1, [set('users/new', { private: 'private-payload' }), { op: 'create', path: 'users/existing', data: {} }]), env), isError('DATA_EXISTS'));
  assert.deepEqual(await executeDataCommand(read('users/new'), env), { revision: 1, documents: [] });
  assert.deepEqual((await executeDataCommand(read('users/existing'), env)).documents[0].data, { stable: true });
  assert.equal((await env.SARIN_DB.prepare('SELECT COUNT(*) AS n FROM app_commits').first()).n, 1);
});

test('missing revision metadata fails closed without publishing documents or journal entries', async context => {
  const env = await fixture(context);
  await env.SARIN_DB.prepare('DELETE FROM app_revision').run();
  await assert.rejects(executeDataCommand(commit(0, [set('users/one', {})]), env), isError('DATA_UNAVAILABLE'));
  assert.equal((await env.SARIN_DB.prepare('SELECT COUNT(*) AS n FROM app_documents').first()).n, 0);
  assert.equal((await env.SARIN_DB.prepare('SELECT COUNT(*) AS n FROM app_commits').first()).n, 0);
});

test('a lost response replays the original UUID after later commits without a second write', async context => {
  const env = await fixture(context);
  const command = commit(0, [set('users/one', { count: 1 })]);
  assert.deepEqual(await executeDataCommand(command, env), { revision: 1 });
  await executeDataCommand(commit(1, [set('users/one', { count: 2 })]), env);
  assert.deepEqual(await executeDataCommand(command, env), { revision: 1 });
  assert.equal((await executeDataCommand(read('users/one'), env)).documents[0].data.count, 2);
  await assert.rejects(executeDataCommand({ ...command, writes: [set('users/one', { count: 3 })] }, env), isError('DATA_INVALID'));
});

test('an ambiguous D1 batch response is resolved from its committed journal', async context => {
  const env = await fixture(context);
  const database = env.SARIN_DB;
  let batches = 0;
  const interrupted = { ...env, SARIN_DB: { prepare: database.prepare.bind(database), batch: async statements => {
    const result = await database.batch(statements);
    if (++batches === 2) throw new Error('private-payload: response lost after commit');
    return result;
  } } };
  assert.deepEqual(await executeDataCommand(commit(0, [set('users/one', { count: 1 })]), interrupted), { revision: 1 });
  assert.equal((await executeDataCommand(read('users/one'), env)).documents[0].data.count, 1);
  assert.equal((await env.SARIN_DB.prepare('SELECT COUNT(*) AS n FROM app_commits').first()).n, 1);
});

test('simultaneous duplicate UUIDs resolve to one committed revision', async context => {
  const env = await fixture(context);
  const command = commit(0, [set('users/one', { count: 1 })]);
  assert.deepEqual(await Promise.all([executeDataCommand(command, env), executeDataCommand(command, env)]), [{ revision: 1 }, { revision: 1 }]);
  assert.equal((await env.SARIN_DB.prepare('SELECT COUNT(*) AS n FROM app_commits').first()).n, 1);
});

test('successful batches prune journal entries older than 24 hours without deleting the current replay', async context => {
  const env = await fixture(context);
  const old = commit(0, [set('users/one', { count: 1 })]);
  await executeDataCommand(old, env);
  await env.SARIN_DB.prepare('UPDATE app_commits SET created_at=? WHERE request_id=?').bind(Date.now() - 25 * 60 * 60 * 1000, old.requestId).run();
  const current = commit(1, [set('users/two', { count: 2 })]);
  await executeDataCommand(current, env);
  assert.equal((await env.SARIN_DB.prepare('SELECT COUNT(*) AS n FROM app_commits').first()).n, 1);
  assert.deepEqual(await executeDataCommand(current, env), { revision: 2 });
  await assert.rejects(executeDataCommand(old, env), isError('DATA_CONFLICT'));
});

test('a missing blob returns a generic failure instead of an incomplete receipt', async context => {
  const env = await fixture(context);
  await executeDataCommand(commit(0, [set('paymentImages/one', { receiptDataUrl: receipt })]), env);
  const stored = await env.SARIN_DB.prepare('SELECT blob FROM app_documents WHERE path=?').bind('paymentImages/one').first();
  await env.SARIN_FILES.delete(JSON.parse(stored.blob).key);
  await assert.rejects(executeDataCommand(read('paymentImages/one'), env), isError('DATA_UNAVAILABLE'));
});

test('deep merges retain explicit nulls and handle sequential writes and deletion atomically', async context => {
  const env = await fixture(context);
  await executeDataCommand(commit(0, [set('users/one', { nested: { a: 1, b: 2 }, nullable: 'before', tags: ['before'] })]), env);
  await executeDataCommand(commit(1, [set('users/one', { nested: { a: null }, nullable: null, tags: ['after'] }, true), set('users/one', { nested: { c: 3 } }, true)]), env);
  assert.deepEqual((await executeDataCommand(read('users/one'), env)).documents[0].data, { nested: { a: null, b: 2, c: 3 }, nullable: null, tags: ['after'] });
  await executeDataCommand(commit(2, [{ op: 'delete', path: 'users/one' }]), env);
  assert.deepEqual(await executeDataCommand(read('users/one'), env), { revision: 3, documents: [] });
});

test('unbounded queries fail explicitly instead of silently dropping records', async context => {
  const env = await fixture(context);
  for (let start = 0; start < 1001; start += 100) await env.SARIN_DB.batch(Array.from({ length: Math.min(100, 1001 - start) }, (_, offset) => {
    const id = String(start + offset);
    return env.SARIN_DB.prepare('INSERT INTO app_documents(path,parent,document_id,data,updated_at) VALUES(?,?,?,?,0)').bind(`users/${id}`, 'users', id, '{}');
  }));
  await assert.rejects(executeDataCommand(query('users'), env), isError('DATA_LIMIT'));
  assert.equal((await executeDataCommand(query('users', [], [], 2), env)).documents.length, 2);
});

const receipt = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jwL8AAAAASUVORK5CYII=';
test('separates public logo objects from private receipt policy and hydrates logos only by direct read', async context => {
  const env = await fixture(context);
  const bytes = await sharp({ create: { width: 512, height: 512, channels: 4, background: 'blue' } }).webp().toBuffer();
  const sha256 = Buffer.from(await crypto.subtle.digest('SHA-256', bytes)).toString('hex');
  const path = `businessLogos/b_one_${sha256}`;
  const data = { businessId: 'b_one', ownerUid: 'one', sha256, logoDataUrl: `data:image/webp;base64,${bytes.toString('base64')}`, createdAt: 1 };
  await executeDataCommand(commit(0, [set(path, data)]), env);
  const stored = await env.SARIN_DB.prepare('SELECT data,blob FROM app_documents WHERE path=?').bind(path).first();
  assert.equal(stored.data.includes('base64'), false);
  const blob = JSON.parse(stored.blob);
  assert.equal(blob.key, `business-logos/${sha256}`);
  assert.deepEqual((await executeDataCommand(read(path), env)).documents[0].data, data);
  assert.equal(Object.hasOwn((await executeDataCommand(query('businessLogos'), env)).documents[0].data, 'logoDataUrl'), false);
  const revision = (await executeDataCommand(read(path), env)).revision;
  const broken = { ...env, SARIN_FILES: { put: async () => { throw new Error('private-payload'); } } };
  await assert.rejects(executeDataCommand(commit(revision, [set(path, data), set('businesses/b_one', { logo: { sha256 } })]), broken), isError('DATA_UNAVAILABLE'));
  assert.equal((await executeDataCommand(read('businesses/b_one'), env)).documents.length, 0);
  await env.SARIN_DB.prepare('UPDATE app_documents SET blob=? WHERE path=?').bind(JSON.stringify({ ...blob, key: `payment-images/${sha256}` }), path).run();
  await assert.rejects(executeDataCommand(read(path), env), isError('DATA_UNAVAILABLE'));
});

test('rejects invalid logo signatures, oversized data and digest mismatch before storage', async () => {
  const noAccess = new Proxy({}, { get() { assert.fail('Invalid logo accessed storage.'); } });
  const sha256 = 'a'.repeat(64), path = `businessLogos/b_one_${sha256}`;
  for (const logoDataUrl of [receipt, 'data:image/webp;base64,UklGRnh4eHhXRUJQZml4dHVyZQ==', `data:image/webp;base64,${Buffer.alloc(256 * 1024 + 1).toString('base64')}`]) {
    await assert.rejects(executeDataCommand(commit(0, [set(path, { businessId: 'b_one', ownerUid: 'one', sha256, createdAt: 1, logoDataUrl })]), noAccess), isError('DATA_INVALID'));
  }
});
test('receipt bytes live only in private R2, are read back exactly and survive document deletion', async context => {
  const env = await fixture(context);
  const data = { ownerUid: 'one', receiptDataUrl: receipt, submittedAt: 1 };
  await executeDataCommand(commit(0, [set('paymentImages/one', data)]), env);
  const stored = await env.SARIN_DB.prepare('SELECT data,blob FROM app_documents WHERE path=?').bind('paymentImages/one').first();
  assert.equal(stored.data.includes('base64'), false);
  const blob = JSON.parse(stored.blob);
  assert.match(blob.key, /^payment-images\/[a-f0-9]{64}$/);
  assert.equal((await env.SARIN_FILES.get(blob.key)).httpMetadata.contentType, 'image/png');
  assert.deepEqual((await executeDataCommand(read('paymentImages/one'), env)).documents[0].data, data);
  await executeDataCommand(commit(1, [{ op: 'delete', path: 'paymentImages/one' }]), env);
  assert.notEqual(await env.SARIN_FILES.head(blob.key), null);
});

test('legacy receipt images hydrate only a direct document read and metadata merges preserve the blob', async context => {
  const env = await fixture(context);
  const data = { ownerUid: 'one', receiptDataUrl: receipt, submittedAt: 1, status: 'pending' };
  await executeDataCommand(commit(0, [set('paymentReceipts/legacy', data)]), env);
  assert.equal((await executeDataCommand(read('paymentReceipts/legacy'), env)).documents[0].data.receiptDataUrl, receipt);
  const listed = await executeDataCommand(query('paymentReceipts'), env);
  assert.equal(Object.hasOwn(listed.documents[0].data, 'receiptDataUrl'), false);
  await executeDataCommand(commit(1, [set('paymentReceipts/legacy', { status: 'approved' }, true)]), env);
  assert.equal((await executeDataCommand(read('paymentReceipts/legacy'), env)).documents[0].data.receiptDataUrl, receipt);
});

test('R2 failure cannot commit a document or revision, while CAS conflicts may leave only safe orphan blobs', async context => {
  const env = await fixture(context);
  const broken = { ...env, SARIN_FILES: { put: async () => { throw new Error('private-payload'); } } };
  await assert.rejects(executeDataCommand(commit(0, [set('paymentImages/one', { receiptDataUrl: receipt })]), broken), isError('DATA_UNAVAILABLE'));
  assert.deepEqual(await executeDataCommand(read('paymentImages/one'), env), { revision: 0, documents: [] });
  await executeDataCommand(commit(0, [set('users/change', {})]), env);
  await assert.rejects(executeDataCommand(commit(0, [set('paymentImages/orphan', { receiptDataUrl: receipt })]), env), isError('DATA_CONFLICT'));
  assert.deepEqual((await executeDataCommand(read('paymentImages/orphan'), env)).documents, []);
});

test('the outbound bridge rejects other containers, URIs, methods and oversized bodies without storage access', async () => {
  const env = { SARIN_APP: { idFromName: () => ({ toString: () => 'singleton' }) } };
  const ctx = { containerId: 'singleton', className: 'SarinApp' };
  const request = body => new Request('http://sarin-data.internal/execute', { method: 'POST', body });
  for (const context of [{ ...ctx, containerId: 'other' }, { ...ctx, className: 'OtherClass' }]) assert.equal((await handleDataOutbound(request('{}'), env, context)).status, 403);
  assert.equal((await handleDataOutbound(new Request('http://sarin-data.internal/execute?'), env, ctx)).status, 404);
  assert.equal((await handleDataOutbound(new Request('http://sarin-data.internal/execute'), env, ctx)).status, 405);
  const tooLarge = await handleDataOutbound(request('x'.repeat(8 * 1024 * 1024 + 1)), env, ctx);
  assert.equal(tooLarge.status, 413);
  assert.equal((await tooLarge.json()).code, 'DATA_LIMIT');
});

test('a valid outbound request uses private bindings and errors never expose the submitted body', async context => {
  const env = await fixture(context);
  const ctx = { containerId: 'singleton', className: 'SarinApp' };
  const send = body => handleDataOutbound(new Request('http://sarin-data.internal/execute', { method: 'POST', body: JSON.stringify(body) }), env, ctx);
  assert.equal((await send(commit(0, [set('users/one', { secret: 'private-payload' })]))).status, 200);
  const result = await send(read('users/one'));
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('Cache-Control'), 'no-store');
  assert.equal((await result.json()).documents[0].data.secret, 'private-payload');
  const invalid = await send(commit(1, [set('invalid/path', { private: 'private-payload' })]));
  assert.equal(invalid.status, 400);
  assert.doesNotMatch(await invalid.text(), /private-payload/);
});

test('factual FAQ admits exactly private state and receipt children', async context => {
  const env = await fixture(context);
  for (const [index, child] of ['factualFaq', 'factualFaqOperations'].entries()) {
    const path = `businesses/demo/${child}/current`;
    assert.equal(isDataPath(path, true), true);
    assert.equal(isDataPath(`publicBusinesses/demo/${child}/current`, true), false);
    await executeDataCommand(commit(index, [set(path, { version: 1, revision: 1 })]), env);
    assert.deepEqual((await executeDataCommand(read(path), env)).documents[0].data, { version: 1, revision: 1 });
  }
  assert.equal(isDataPath('businesses/demo/factualFaqHistory/current', true), false);
});
