import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { executeDataCommand } from '../src/data.ts';
import { prepareRecoveryWitness, readRecoveryWitness } from '../src/recovery-witness.ts';
import { forwardToSingleton, backgroundWorkEnabled } from '../src/router.ts';
import { cleanupPlatformSupportRetention } from '../src/platform-support-retention.ts';
import { SUPPORT_CONTROL_TTL } from '../../shared/platform-support-records.ts';

const require = createRequire(import.meta.url), wrangler = createRequire(require.resolve('wrangler/package.json'));
const { Miniflare, convertV4MiniflareOptions } = wrangler('miniflare');
const resource = 'a'.repeat(64);
async function fixture(t) {
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default {fetch(){return new Response()}}', compatibilityDate: '2026-10-13', d1Databases: { SARIN_DB: 'demo-app', SARIN_RECOVERY_DB: 'demo-witness' }, r2Buckets: { SARIN_FILES: 'demo-files' } }));
  t.after(() => mf.dispose());
  const env = { SARIN_DB: await mf.getD1Database('SARIN_DB'), SARIN_FILES: await mf.getR2Bucket('SARIN_FILES'), SARIN_RECOVERY_DB: await mf.getD1Database('SARIN_RECOVERY_DB'), SARIN_WITNESS_ENABLED: 'true', SARIN_RECOVERY_RESOURCE_ID: resource };
  for (const [db, file] of [[env.SARIN_DB, '../migrations/0001_data.sql'], [env.SARIN_RECOVERY_DB, '../recovery-migrations/0001_recovery_control.sql']]) await db.exec(readFileSync(new URL(file, import.meta.url), 'utf8').replace(/^--.*$/gm, '').replace(/\r?\n/g, ' '));
  await env.SARIN_RECOVERY_DB.prepare('INSERT INTO recovery_witness_start(id,resource_id,start_revision,started_at) VALUES(1,?,0,?)').bind(resource, Date.now()).run();
  return env;
}
const command = (revision, writes, requestId = crypto.randomUUID()) => ({ action: 'commit', expectedRevision: revision, requestId, writes });
const set = (path, data) => ({ op: 'set', path, data });
const coverage = (env, fromRevision, toRevision) => readRecoveryWitness(env, { fromRevision, toRevision });

test('revocation_survives_old_sql and private witness never stores document bodies', async t => {
  const env = await fixture(t), path = 'businesses/demo/teamAccessEvents/member';
  await executeDataCommand(command(0, [set(path, { active: true, privateBody: 'never-archive-this' })]), env);
  await executeDataCommand(command(1, [{ op: 'delete', path }]), env);
  const old = await env.SARIN_DB.prepare('SELECT revision FROM app_revision').first();
  // Simulate replacing only the application snapshot. The independent witness stays intact.
  await env.SARIN_DB.exec('DROP TRIGGER app_revision_cas; UPDATE app_revision SET revision=1;');
  const w = await coverage(env, 1, old.revision);
  assert.equal(w.complete, true); assert.deepEqual(w.intents.flatMap(i => i.scopes), [{ path, reason: 'delete' }]);
  assert.doesNotMatch(JSON.stringify(await env.SARIN_RECOVERY_DB.prepare('SELECT * FROM recovery_invalidations').all()), /never-archive-this|privateBody/);
  await assert.rejects(env.SARIN_RECOVERY_DB.prepare('DELETE FROM recovery_invalidations').run(), /retained/i);
});

test('unknown_witness_blocks_access and missing history cannot be initialized from a restored revision', async t => {
  const env = await fixture(t);
  await assert.rejects(env.SARIN_RECOVERY_DB.prepare('DELETE FROM recovery_witness_start').run(), /immutable/i);
  const missing = { ...env, SARIN_RECOVERY_DB: undefined };
  assert.equal((await coverage(missing, 0, 0)).complete, false);
  await assert.rejects(executeDataCommand(command(0, [set('businesses/demo', {})]), missing));
  assert.equal((await env.SARIN_DB.prepare('SELECT revision FROM app_revision').first()).revision, 0);
  await executeDataCommand(command(0, [set('businesses/demo', {})]), { ...missing, SARIN_WITNESS_ENABLED: 'false' });
  assert.equal((await coverage(env, 0, 1)).complete, false);
  assert.equal((await coverage(env, 1, 1)).complete, false, 'a snapshot cannot hide missing pre-snapshot history');
});

test('crash_between_witness_and_app_commit_is_restrictive and replay completes only the identical intent', async t => {
  const env = await fixture(t), c = command(0, [set('businesses/demo', { published: false })]);
  await prepareRecoveryWitness(c, env);
  assert.equal((await coverage(env, 0, 0)).complete, false);
  await executeDataCommand(c, env); await executeDataCommand(c, env);
  assert.equal((await coverage(env, 0, 1)).complete, true);
  assert.equal((await env.SARIN_RECOVERY_DB.prepare('SELECT count(*) AS n FROM recovery_invalidations').first()).n, 1);
  await assert.rejects(executeDataCommand({ ...c, writes: [set('businesses/demo', { published: true })] }, env));
});

test('direct_worker_retention_and_replay_are_covered and losing completion fails closed', async t => {
  const env = await fixture(t);
  // A retention pass uses executeDataCommand without going through the Node adapter.
  const path = 'platformSettings/platform_support_recipient';
  const anchor = { revision: 1, fingerprint: 'a'.repeat(64), receiptId: 'demo' };
  const recipient = { version: 1, revision: 1, linkId: crypto.randomUUID(), linkRevision: 1, ownerUid: 'demo', account: anchor, support: anchor, createdAt: 1, expiresAt: 1 + SUPPORT_CONTROL_TTL };
  await executeDataCommand(command(0, [set(path, recipient)]), env);
  const result = await cleanupPlatformSupportRetention(env, Date.now());
  assert.equal(result.deletedMetadata, 1);
  assert.equal((await coverage(env, 0, 2)).complete, true);
  const c = command(2, [set('businesses/second', {})]);
  const broken = { ...env, SARIN_RECOVERY_DB: { prepare(sql) { if (sql.startsWith('UPDATE recovery_invalidations')) throw Error('lost second store'); return env.SARIN_RECOVERY_DB.prepare(sql); } } };
  await assert.rejects(executeDataCommand(c, broken));
  assert.equal((await coverage(env, 0, 3)).complete, false);
  await executeDataCommand(c, env);
  assert.equal((await coverage(env, 0, 3)).complete, true);
});

test('no_backup_reopens_public_or_private_data: recovery closes maintenance allowlist before obtaining singleton', async () => {
  for (const path of ['/', '/reservar/demo', '/api/session', '/api/admin/abuse', '/api/sarin/health?scope=engine']) {
    const response = await forwardToSingleton(new Request('https://demo.test' + path, { headers: { Authorization: 'Bearer demo', 'x-sarin-recovery-approved': 'true', Cookie: 'approved=true' } }), () => { assert.fail('recovery started app'); }, { SARIN_RECOVERY_MODE: 'recovery', SARIN_MAINTENANCE: 'true' });
    assert.equal(response.status, 503);
  }
  assert.equal(backgroundWorkEnabled({ SARIN_RECOVERY_MODE: 'recovery', WHATSAPP_ENABLED: 'true' }), false);
});

test('private operational approval admits only matching reconciled reads and is invalidated by a new pending intent', async t => {
  const env = await fixture(t), now = Date.now(), sha = 'b'.repeat(40), reconciliationSha = 'c'.repeat(64);
  const manifestSha256 = 'e'.repeat(64);
  Object.assign(env, { SARIN_RECOVERY_MODE: 'recovery', SARIN_RECOVERY_CANDIDATE_SHA: sha, SARIN_RECOVERY_MANIFEST_SHA: manifestSha256, SARIN_RECOVERY_RECONCILIATION_SHA: reconciliationSha });
  const approval = { candidateSha: sha, manifestSha256, reconciliationSha, resourceId: resource, fromRevision: 0, toRevision: 0, approvedAt: now, expiresAt: now + 60000, currentAuthAt: now, blockers: 0, operationId: 'demo-explicit-operation' };
  await env.SARIN_RECOVERY_DB.prepare('INSERT INTO recovery_admission VALUES(?,?)').bind(resource, JSON.stringify(approval)).run();
  const read = { action: 'read', read: { kind: 'document', path: 'businesses/demo' } };
  assert.equal((await executeDataCommand(read, env)).revision, 0);
  await assert.rejects(executeDataCommand(command(0, [set('businesses/demo', {})]), env));
  await assert.rejects(executeDataCommand(read, { ...env, SARIN_RECOVERY_CANDIDATE_SHA: 'd'.repeat(40) }));
  await assert.rejects(executeDataCommand(read, { ...env, SARIN_RECOVERY_MANIFEST_SHA: 'f'.repeat(64) }));
  await prepareRecoveryWitness(command(0, [set('businesses/demo', {})]), env);
  await assert.rejects(executeDataCommand(read, env));
});
