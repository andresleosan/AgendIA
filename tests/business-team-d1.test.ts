import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { readFile, readdir, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDataTestRuntime } from '../cloudflare/tests/data-runtime.mjs';
import { createCloudflareDatabase, StorageError } from '@/lib/storage/database';
import type { Database } from '@/lib/storage/types';
import type { DataCommand, DataCommitResult, DataRead, DataReadResult } from '../shared/data-protocol';
import { decideTeamAccess, leaveTeamAccess, readOwnTeamMemberships, readOwnerBusinessTeam, requestTeamAccess } from '@/lib/server/business-team';
import { readTeamAssignedAgenda } from '@/lib/server/team-agenda';
import { stableDocumentId } from '@/lib/server/businesses';
import { teamAccessCommandCanonicalString, teamAccessEventSchema } from '@/lib/business-team';
import { acceptSyntheticConsent } from './consent-fixtures';
import { teamFixture, teamNow } from './business-team-contract';
import { activeTeam, approval, assertTeamIntegrity, registerTeamStorageCases, requestedTeam, teamAppointment, teamStateId } from './business-team-storage-contract';
import { buildImportSql, buildReversePlan, encodeFirestoreValue, prepareMigration, sha256, verifyImportedRows } from '../scripts/lib/data-migration.mjs';
import { verifyD1Backup } from '../scripts/verify-d1-backup.mjs';

let runtime: Awaited<ReturnType<typeof createDataTestRuntime>>, db: Database, second: Database;
let loseReply = false, now = teamNow;
const journals: Extract<DataCommand, { action: 'commit' }>[] = [], reads: DataRead[] = [];
beforeEach(async () => {
  vi.stubEnv('SARIN_TEAM_ACCESS_ENABLED', 'true'); now = teamNow; vi.spyOn(Date, 'now').mockImplementation(() => now);
  runtime = await createDataTestRuntime({ captureSql: true }); loseReply = false; journals.length = 0; reads.length = 0;
  const connect = () => createCloudflareDatabase(async command => {
    if (command.action === 'read') reads.push(structuredClone(command.read));
    const response = await runtime.fetch(command), result = await response.json() as DataReadResult | DataCommitResult;
    if (!response.ok) throw new StorageError(response.status, (result as unknown as { code: string }).code);
    if (loseReply && command.action === 'commit' && command.writes.some(w => w.op !== 'delete' && w.path.startsWith('businessMemberships/'))) {
      journals.push(structuredClone(command)); if (journals.length === 1) throw new StorageError(503, 'DATA_UNAVAILABLE');
    }
    return result;
  });
  db = connect(); second = connect();
}, 30000);
afterEach(async () => { await runtime?.dispose(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

registerTeamStorageCases('D1 two handles / one runtime', () => ({ db, second }));

it('lost actual D1 commit response repeats byte-identical journal once and domain receipt survives revocation', async () => {
  const f = await requestedTeam(db); loseReply = true;
  const result = await decideTeamAccess(f.owner, f.business.id, f.membershipId, approval(), db);
  expect(journals).toHaveLength(2); expect(journals[1]).toEqual(journals[0]);
  expect(journals[0].writes).toHaveLength(3);
  loseReply = false;
  expect(await decideTeamAccess(f.owner, f.business.id, f.membershipId, approval(), second)).toEqual({ ...result, replayed: true });
  await leaveTeamAccess(f.member, f.membershipId, { requestId: 'demo-loss-leave', expectedMembershipRevision: 2 }, second);
  expect(await decideTeamAccess(f.owner, f.business.id, f.membershipId, approval(), db)).toMatchObject({ applied: result.applied, current: { status: 'revoked', revision: 3 }, replayed: true });
  const roster = await assertTeamIntegrity(second, f.business.id); expect(roster.teamRevision).toBe(3); expect(roster.active).toHaveLength(0);
  expect((await db.collection('businesses').doc(f.business.id).collection('teamAccessEvents').get()).size).toBe(3);
}, 30000);

it('two real approval commits compete for the last active slot30 with tenant isolation', async () => {
  const f = await teamFixture(db); now = teamNow - 31 * 86400000;
  for (let i = 0; i < 29; i++) {
    const actor = { uid: `demo-capacity-${i}` }; await acceptSyntheticConsent(db, actor.uid);
    const request = await requestTeamAccess(actor, { ...f.request, requestId: `demo-capacity-request-${i}` }, db);
    await decideTeamAccess(f.owner, f.business.id, request.current.membershipId, approval(request.teamRevision, `demo-capacity-approve-${i}`), db);
    now += 86400001;
  }
  now = teamNow;
  const first = await requestTeamAccess(f.member, f.request, db), actor = { uid: 'demo-last-slot' };
  await acceptSyntheticConsent(db, actor.uid);
  const last = await requestTeamAccess(actor, { ...f.request, requestId: 'demo-last-slot-request' }, second);
  const isolated = await activeTeam(second, 'demo-isolated-team');
  const outcomes = await Promise.allSettled([
    decideTeamAccess(f.owner, f.business.id, first.current.membershipId, approval(last.teamRevision, 'demo-last-approve-a'), db),
    decideTeamAccess(f.owner, f.business.id, last.current.membershipId, approval(last.teamRevision, 'demo-last-approve-b'), second),
  ]);
  expect(outcomes.filter(item => item.status === 'fulfilled')).toHaveLength(1);
  expect(outcomes.find(item => item.status === 'rejected')).toMatchObject({ reason: { status: 409 } });
  const roster = await assertTeamIntegrity(db, f.business.id);
  expect(roster.active).toHaveLength(30); expect(roster.requested).toHaveLength(1); expect(roster.teamRevision).toBe(61);
  await expect(decideTeamAccess(f.owner, f.business.id, roster.requested[0].membershipId, approval(61, 'demo-capacity-overflow'), second)).rejects.toMatchObject({ status: 409, code: 'TEAM_CAPACITY' });
  expect((await assertTeamIntegrity(second, isolated.business.id)).active).toHaveLength(1);
  expect((await readOwnTeamMemberships(f.member, {}, db)).items.every(row => row.businessId === f.business.id || row.businessId === isolated.business.id)).toBe(true);
}, 60000);

it('requested capacity30 fails before rate limiting and foreign roster stays empty', async () => {
  const f = await teamFixture(db);
  for (let i = 0; i < 30; i++) {
    const actor = { uid: `demo-requested-capacity-${i}` }; await acceptSyntheticConsent(db, actor.uid);
    await requestTeamAccess(actor, { ...f.request, requestId: `demo-requested-capacity-${i}` }, i % 2 ? db : second);
  }
  await expect(requestTeamAccess(f.member, f.request, second)).rejects.toMatchObject({ status: 409, code: 'TEAM_CAPACITY' });
  const roster = await assertTeamIntegrity(db, f.business.id); expect(roster.requested).toHaveLength(30); expect(roster.teamRevision).toBe(30);
  expect((await readOwnTeamMemberships(f.member, {}, second)).items).toEqual([]);
}, 60000);

it.each(['missing-state', 'corrupt-state', 'missing-head', 'headSequenceCannotExceedTeamRevision', 'activeMembershipWithZeroActiveCountFailsClosed'])('%s fails503 on real storage', async corruption => {
  const f = await activeTeam(db), stateRef = second.collection('serverSettings').doc(teamStateId(f.business.id));
  const state = (await stateRef.get()).data()!, member = (await second.collection('businessMemberships').doc(f.membershipId).get()).data()!;
  const head = second.collection('businesses').doc(f.business.id).collection('teamAccessEvents').doc(String(member.lastEventId));
  if (corruption === 'missing-state') await stateRef.delete();
  if (corruption === 'corrupt-state') await stateRef.set({ ...state, revision: 'corrupt' });
  if (corruption === 'missing-head') await head.delete();
  if (corruption === 'headSequenceCannotExceedTeamRevision') {
    const saved = (await head.get()).data()!, command = { ...saved.command as object, expectedTeamRevision: 2 };
    const validFutureHead = teamAccessEventSchema.parse({ ...saved, sequence: 3, command, commandHash: createHash('sha256').update(teamAccessCommandCanonicalString(command as Parameters<typeof teamAccessCommandCanonicalString>[0])).digest('hex') });
    await head.set(validFutureHead);
  }
  if (corruption === 'activeMembershipWithZeroActiveCountFailsClosed') await stateRef.set({ ...state, activeCount: 0 });
  await expect(readTeamAssignedAgenda(f.member, f.business.id, '2030-01-07', db)).rejects.toMatchObject({ status: 503 });
  await expect(readOwnTeamMemberships(f.member, {}, db)).rejects.toMatchObject({ status: 503 });
}, 30000);

it('1000 real matching appointments produce413; smaller assigned query excludes other resources', async () => {
  const f = await activeTeam(db), parent = `businesses/${f.business.id}/appointments`;
  const records = Array.from({ length: 1000 }, (_, i) => ({ path: `${parent}/demo-row-${i}`, data: teamAppointment(f.business.id, `demo-row-${i}`) }));
  for (let offset = 0; offset < records.length; offset += 100) await db.runTransaction(async tx => { for (const row of records.slice(offset, offset + 100)) tx.set(db.collection('businesses').doc(f.business.id).collection('appointments').doc(row.data.id), row.data); });
  await expect(readTeamAssignedAgenda(f.member, f.business.id, '2030-01-07', second)).rejects.toMatchObject({ status: 413 });
  expect(reads).toContainEqual({ kind: 'query', path: parent, filters: [{ field: 'dateKey', op: '==', value: '2030-01-07' }, { field: 'resourceId', op: '==', value: 'demo-chair' }], order: [], limit: 1000 });
}, 30000);

it('generated real queries use team indexes and bounded descending suffix20 among1001 events', async () => {
  const f = await activeTeam(db), eventParent = `businesses/${f.business.id}/teamAccessEvents`;
  const template = (await db.collection('businesses').doc(f.business.id).collection('teamAccessEvents').doc(f.approved.applied.eventId).get()).data()!;
  // Historical load fixture: each independently valid receipt has its own canonical command/hash.
  const inserts = [];
  for (let sequence = 3; sequence <= 1001; sequence++) {
    const requestId = `demo-history-${sequence}`, command = { ...template.command as object, requestId, expectedTeamRevision: sequence - 1 };
    const id = stableDocumentId('team-access', f.business.id, f.owner.uid, requestId);
    const data = teamAccessEventSchema.parse({ ...template, id, requestId, sequence, command, commandHash: createHash('sha256').update(teamAccessCommandCanonicalString(command as Parameters<typeof teamAccessCommandCanonicalString>[0])).digest('hex') });
    inserts.push({ id, data });
  }
  // Bound preparation as well as execution; preparing all rows can outlive the sidecar's idle socket.
  for (let offset = 0; offset < inserts.length; offset += 100) await runtime.db.batch(inserts.slice(offset, offset + 100).map(({ id, data }) => runtime.db.prepare('INSERT INTO app_documents(path,parent,document_id,data,updated_at) VALUES(?,?,?,?,?)').bind(`${eventParent}/${id}`, eventParent, id, JSON.stringify(data), teamNow)));
  expect((await runtime.db.prepare('SELECT count(*) AS count FROM app_documents WHERE parent=?').bind(eventParent).first()).count).toBe(1001);
  const stateRef = db.collection('serverSettings').doc(teamStateId(f.business.id)); await stateRef.set({ ...(await stateRef.get()).data()!, revision: 1001 });
  await teamFixture(db, 'demo-query-isolation');
  reads.length = 0;
  expect((await readOwnTeamMemberships(f.member, {}, db)).items).toHaveLength(1);
  expect((await readOwnerBusinessTeam(f.owner, f.business.id, undefined, second)).events.map(event => event.sequence)).toEqual(Array.from({ length: 20 }, (_, i) => 1001 - i));
  const queries = reads.filter((read): read is Extract<DataRead, { kind: 'query' }> => read.kind === 'query');
  const expected = [['businessMemberships', 21, 'app_team_member'], ['businessMemberships', 31, 'app_team_business_status'], [eventParent, 20, 'app_team_events_sequence']] as const;
  for (const [path, limit, index] of expected) {
    const read = queries.find(query => query.path === path && query.limit === limit)!; expect(read).toBeDefined();
    const explained = await runtime.explain!(read);
    expect(explained.sql).toMatch(/LIMIT \?/); expect(explained.bindings.at(-1)).toBe(limit);
    const detail = explained.plan.map((row: { detail: string }) => row.detail).join('\n');
    expect(detail).toContain(`USING INDEX ${index}`); expect(detail).not.toMatch(/SCAN app_documents|USE TEMP B-TREE/);
    if (limit === 20) expect(explained.sql).toContain("json_extract(data,'$.sequence') DESC");
    console.info('S13_D1_EXPLAIN', JSON.stringify({ sql: explained.sql, limit, index, plan: explained.plan }));
  }
}, 30000);

it('synthetic team top/state/events survive migration reverse reconciliation SQL backup and restore', async () => {
  const f = await activeTeam(db);
  await leaveTeamAccess(f.member, f.membershipId, { requestId: 'demo-backup-leave', expectedMembershipRevision: 2 }, second);
  const rows = (await runtime.db.prepare('SELECT * FROM app_documents ORDER BY path').all()).results;
  // Migration codec requires its fixed source-project metadata. These are
  // synthetic local bytes only; no Firestore service is contacted by this test.
  const prefix = 'projects/sarinbotsaas/databases/(default)/documents/', stamp = '2030-01-07T15:00:00.000000Z';
  const source = { version: 1, projectId: 'sarinbotsaas', databaseId: '(default)', readTime: stamp, collections: [], missingAncestors: [], documents: rows.map((row: { path: string; data: string }) => ({ name: prefix + row.path, fields: Object.fromEntries(Object.entries(JSON.parse(row.data)).map(([key, value]) => [key, encodeFirestoreValue(value)])), createTime: stamp, updateTime: stamp })) };
  const bundle = prepareMigration(source, { updatedAt: teamNow });
  const teamRows = bundle.rows.filter((row: { path: string }) => row.path.startsWith('businessMemberships/') || row.path.includes('/teamAccessEvents/') || row.path === `serverSettings/${teamStateId(f.business.id)}`);
  expect(teamRows).toHaveLength(5);
  expect(teamRows.find((row: { path: string }) => row.path.startsWith('businessMemberships/')).data).toMatchObject({ status: 'revoked', revision: 3 });
  const plan = buildReversePlan({ baseline: source, rows, blobs: [], revision: 1 }); expect(plan.deletionCandidates).toEqual([]);
  const roundtrip = prepareMigration({ ...source, documents: plan.upserts.map((write: { update: object }) => ({ ...write.update, createTime: stamp, updateTime: stamp })) }, { updatedAt: teamNow });
  expect(roundtrip.rows).toEqual(bundle.rows);
  const directory = await mkdtemp(join(tmpdir(), 'sarin-s13-team-backup-'));
  // Evidence is retained outside the repository; no fixture cleanup deletes QA artifacts.
  const migrations = new URL('../cloudflare/migrations/', import.meta.url), names = (await readdir(migrations)).filter(name => /^\d+.*\.sql$/.test(name)).sort();
  expect(names.filter(name => name.startsWith('0011_'))).toEqual(['0011_business_team.sql']);
  const teamMigration = await readFile(new URL('0011_business_team.sql', migrations), 'utf8');
  expect(teamMigration).not.toMatch(/\bDROP\b|\bDELETE\b|\bALTER\b/i);
  const schema = (await Promise.all(names.map(name => readFile(new URL(name, migrations), 'utf8')))).join('\n');
  const bytes = Buffer.from(`${schema}\n${buildImportSql(bundle)}`), digest = sha256(bytes);
  await writeFile(join(directory, 'sarin-bot-data.sql'), bytes);
  await writeFile(join(directory, 'export-manifest.json'), JSON.stringify({ ok: true, filename: 'sarin-bot-data.sql', sha256: digest, bytes: bytes.length }));
  await mkdir(join(directory, 'r2-objects'));
  await writeFile(join(directory, 'r2-backup-manifest.json'), JSON.stringify({ sourceSqlSha256: digest, bucket: 'sarin-bot-files', references: [] }));
  await runtime.dispose();
  expect(await verifyD1Backup(directory)).toMatchObject({ ok: true, integrity: 'ok', dataPrinted: false, remoteMutations: false, tables: { app_documents: { count: bundle.rows.length } } });
  runtime = await createDataTestRuntime({ captureSql: true });
  await runtime.db.exec(buildImportSql(bundle));
  const restored = (await runtime.db.prepare('SELECT * FROM app_documents ORDER BY path').all()).results;
  expect(verifyImportedRows(bundle, restored).documents).toBe(bundle.rows.length);
  expect((await db.collection('businessMemberships').doc(f.membershipId).get()).data()).toMatchObject({ status: 'revoked', revision: 3 });
  expect((await assertTeamIntegrity(second, f.business.id)).teamRevision).toBe(3);
  console.info('S13_BACKUP_EVIDENCE', JSON.stringify({ directory, documents: bundle.rows.length, teamDocuments: 5, sha256: digest }));
}, 30000);
