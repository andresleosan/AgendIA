import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, realpathSync } from 'node:fs';
import { chmod, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join, resolve, delimiter, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Readable } from 'node:stream';
import { canonicalJson, privateDirectory, resolveBackupDirectory, sha256, writePrivateFile } from './lib/data-migration.mjs';
import { captureRecoveryComponents } from './lib/recovery-components.mjs';
import { encryptBackupComponents, decryptBackupSet, verifyAgeBinary } from './lib/recovery-age.mjs';
import { recoveryMigrationInventory, validateBackupManifest, verifySanitizedSql } from './lib/recovery-backup.mjs';
import { buildRecoveryReconciliation, assertRecoveryAdmission } from './lib/recovery-reconcile.mjs';
import { verifyD1Backup } from './verify-d1-backup.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(new URL('../package.json', import.meta.url));
const cfRequire = createRequire(new URL('../cloudflare/package.json', import.meta.url));
const tools = createRequire(cfRequire.resolve('wrangler/package.json'));
const fail = code => { throw Error(`RECOVERY_DRILL_${code}`); };
const quietEnv = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|Path|SystemRoot|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|JAVA_HOME|PATHEXT)$/i.test(key)));
const flags = ['WHATSAPP_ENABLED', 'WHATSAPP_RETENTION_ENABLED', 'PLATFORM_WHATSAPP_PROCESSING_ENABLED', 'PLATFORM_WHATSAPP_TRANSCRIPTION_ENABLED', 'PLATFORM_WHATSAPP_AI_ENABLED', 'PLATFORM_WHATSAPP_SEND_ENABLED', 'PLATFORM_WHATSAPP_RECEIVE_ENABLED', 'PLATFORM_WHATSAPP_RETENTION_ENABLED', 'SARIN_BACKUP_ENABLED', 'SARIN_BACKUP_CLEANUP_ENABLED'];

export async function verifyDrillTools(agePath) {
  await verifyAgeBinary(agePath);
  const lock = JSON.parse(await readFile(new URL('./lib/recovery-age.lock.json', import.meta.url), 'utf8'));
  const keygen = join(dirname(agePath), process.platform === 'win32' ? 'age-keygen.exe' : 'age-keygen');
  if (sha256(await readFile(keygen)) !== lock.platforms[`${process.platform}-${process.arch}`]?.keygenSha256) fail('KEYGEN');
  return keygen;
}

async function compileProbe(directory) {
  const { build } = tools('esbuild');
  const external = { name: 'isolated-drill-imports', setup(build) {
    build.onLoad({ filter: /[\\/]src[\\/]lib[\\/]server[\\/](chat|platform-whatsapp-audio|platform-support-bot|admin-payment-actions|response-quota-store|platform-ycloud-client)\.ts$/ }, async ({ path }) => {
      let contents = await readFile(path, 'utf8');
      const names = {
        'chat.ts': ['runSarinChat', 'inference'], 'platform-whatsapp-audio.ts': ['transcribePlatformAudio', 'inference'],
        'platform-support-bot.ts': ['consumePlatformGenerationCapability', 'inference'], 'admin-payment-actions.ts': ['confirmPaymentAction', 'payment'],
        'response-quota-store.ts': ['finishResponseQuota', 'automaticQuotaRelease'], 'platform-ycloud-client.ts': ['createPlatformYCloudClient', 'send'],
      };
      const [name, effect] = names[path.split(/[\\/]/).at(-1)], async = contents.includes(`export async function ${name}(`);
      const declaration = `export ${async ? 'async ' : ''}function ${name}(`;
      if (contents.split(declaration).length !== 2) fail('SPY_SOURCE');
      contents = contents.replace(declaration, `${async ? 'async ' : ''}function __original_${name}(`);
      const hit = `const c=globalThis.__sarinRecoveryDrillEffects;if(c){c.${effect}++;throw Error('RECOVERY_DRILL_EFFECT_${effect}');}`;
      contents += name === 'createPlatformYCloudClient' ? `\nexport function ${name}(...args){const client=__original_${name}(...args);return {...client,sendText:async()=>{${hit}},sendButtons:async()=>{${hit}}};}`
        : `\nexport ${async ? 'async ' : ''}function ${name}(...args){${name === 'finishResponseQuota' ? `if(args[1]===false){${hit}}` : hit}return __original_${name}(...args);}`;
      return { contents, loader: 'ts' };
    });
    build.onResolve({ filter: /^server-only$/ }, () => ({ path: 'empty', namespace: 'drill' }));
    build.onResolve({ filter: /(?:@\/lib\/firebase\/admin|[\\/]firebase[\\/]admin)$/ }, () => ({ path: 'admin', namespace: 'drill' }));
    build.onLoad({ filter: /.*/, namespace: 'drill' }, ({ path }) => ({ contents: path === 'empty' ? '' : `
      export function getAdminDb(){const db=globalThis.__sarinRecoveryDrillDb;if(!db)throw Error('RECOVERY_DRILL_DEFAULT_DB');return db;}
      export function getAdminAuth(){throw Error('RECOVERY_DRILL_DEFAULT_AUTH');}` }));
    build.onResolve({ filter: /recovery-backup-fixtures$/ }, () => ({ path: pathToFileURL(join(root, 'tests/recovery-backup-fixtures.ts')).href, external: true }));
    build.onResolve({ filter: /\.mjs$/ }, args => ({ path: pathToFileURL(resolve(args.resolveDir, args.path)).href, external: true }));
    build.onResolve({ filter: /^[^./]/ }, args => {
      if (isAbsolute(args.path)) return;
      if (args.path.startsWith('@/')) return { path: resolve(root, 'src', args.path.slice(2) + '.ts') };
      return { path: args.path.startsWith('node:') ? args.path : pathToFileURL(require.resolve(args.path)).href, external: true };
    });
  } };
  const file = join(directory, 'probe.mjs');
  await build({ entryPoints: [join(root, 'tests/recovery-fixtures.ts')], outfile: file, bundle: true, format: 'esm', platform: 'node', plugins: [external], logLevel: 'silent' });
    const worker = await build({ stdin: { resolveDir: root, contents: `import {executeDataCommand} from './cloudflare/src/data.ts'; export default {async fetch(r,env){try{const config=new URL(r.url).pathname==='/closed'?{...env,SARIN_RECOVERY_MODE:'recovery'}:env;return Response.json(await executeDataCommand(await r.json(),config));}catch(e){return Response.json({code:e.code},{status:e.status??503});}}};` }, bundle: true, write: false, format: 'esm', platform: 'browser', logLevel: 'silent' });
  return { probe: await import(pathToFileURL(file).href), localWorker: worker.outputFiles[0].text };
}

function pnpmCli() {
  const candidates = [process.env.npm_execpath, join(dirname(process.execPath), 'node_modules/corepack/dist/pnpm.js'),
    ...(process.env.PATH ?? process.env.Path ?? '').split(delimiter).flatMap(p => [join(p, 'pnpm'), join(p, 'pnpm.cjs')])];
  for (const candidate of candidates.filter(Boolean)) {
    if (!existsSync(candidate)) continue;
    const file = realpathSync(candidate);
    try { if (execFileSync(process.execPath, [file, '--version'], { encoding: 'utf8', windowsHide: true, env: quietEnv(), stdio: ['ignore', 'pipe', 'pipe'] }).trim() === '11.23.0') return file; } catch { /* Try the next installed CLI. */ }
  }
  fail('PNPM_11_REQUIRED');
}
async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
async function startAuth(directory) {
  const port = await freePort(), hub = await freePort(), logging = await freePort();
  const config = join(directory, 'firebase.json');
  await writePrivateFile(directory, 'firebase.json', JSON.stringify({ emulators: { auth: { host: '127.0.0.1', port }, hub: { host: '127.0.0.1', port: hub }, logging: { host: '127.0.0.1', port: logging }, ui: { enabled: false }, singleProjectMode: true } }));
  const child = spawn(process.execPath, [pnpmCli(), 'dlx', '--allow-build=protobufjs', 'firebase-tools@15.33.0', 'emulators:start', '--only', 'auth', '--project', 'demo-sarin-recovery-drill', '--config', config, '--non-interactive'],
    { cwd: directory, env: { ...quietEnv(), CI: 'true', FIREBASE_CLI_DISABLE_UPDATE_CHECK: 'true' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
  child.stdout.resume(); child.stderr.resume(); let error; child.on('error', e => { error = e; });
  const stop = async () => {
    if (!child.pid || child.exitCode !== null) return;
    if (process.platform === 'win32') {
      await new Promise(resolve => { const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); killer.once('error', resolve); killer.once('exit', resolve); });
    } else { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* Already stopped. */ } }
    await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 3000))]);
  };
  try {
    for (let i = 0; i < 240; i++) {
      if (error || child.exitCode !== null) fail('AUTH_START');
      try { const r = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) }); await r.arrayBuffer(); if (r.ok) return { host: `127.0.0.1:${port}`, stop }; } catch { /* Only this newly spawned emulator is eligible. */ }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    fail('AUTH_TIMEOUT');
  } catch (e) { await stop(); throw e; }
}

/** Synthetic data only. No remote restore, caller project, credentials or admission API. */
export async function runRecoveryDrill({ directory, fixture, now = Date.now(), adapters = {} }) {
  if (fixture !== 'demo-sarin-recovery-v1' || !Number.isSafeInteger(now) || now < 0 || Object.keys(adapters).some(key => key !== 'agePath')) fail('ARGUMENTS');
  directory = await resolveBackupDirectory(directory);
  let ancestor = dirname(directory);
  while (!existsSync(ancestor) && dirname(ancestor) !== ancestor) ancestor = dirname(ancestor);
  try { execFileSync('git', ['-C', ancestor, 'rev-parse', '--absolute-git-dir'], { stdio: 'pipe', windowsHide: true }); fail('INSIDE_GIT'); }
  catch (error) { if (error?.message === 'RECOVERY_DRILL_INSIDE_GIT') throw error; if (error.status !== 128) fail('GIT_GUARD'); }
  directory = await privateDirectory(directory, { create: true });
  const started = performance.now(), stages = {}, cases = {};
  const stage = async (name, fn) => { const at = performance.now(); try { return await fn(); } finally { stages[name] = Math.round(performance.now() - at); } };
  const reject = async (name, fn, pattern) => { await assert.rejects(fn, pattern); cases[name] = 'pass'; };
  const saved = { ...process.env };
  let authRuntime, app;
  try {
    const isolated = quietEnv();
    if (saved.npm_execpath) isolated.npm_execpath = saved.npm_execpath;
    for (const key of Object.keys(process.env)) delete process.env[key]; Object.assign(process.env, isolated);
    for (const flag of flags) process.env[flag] = 'false'; process.env.SARIN_MAINTENANCE = 'true'; process.env.SARIN_RECOVERY_MODE = 'normal';
    const agePath = adapters.agePath ?? saved.SARIN_TEST_AGE_PATH ?? (process.platform === 'win32' ? join(process.env.LOCALAPPDATA, 'SarinBot/tooling/age-1.3.2/windows/age/age.exe') : '/usr/local/bin/age');
    const keygen = await verifyDrillTools(agePath);
    const identityFile = join(directory, 'identity.txt');
    execFileSync(keygen, ['-o', identityFile], { windowsHide: true, stdio: 'pipe' }); await chmod(identityFile, 0o600);
    const recipient = execFileSync(keygen, ['-y', identityFile], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const { probe, localWorker } = await compileProbe(directory);
    await probe.probeEffectTripwires(); cases.effect_spies_tripwire = 'pass';
    const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim(), migrations = recoveryMigrationInventory();
    const data = await probe.createDrillFixture(now, sourceSha);
    authRuntime = await stage('authEmulatorStart', () => startAuth(directory));
    process.env.FIREBASE_AUTH_EMULATOR_HOST = authRuntime.host; process.env.GCLOUD_PROJECT = 'demo-sarin-recovery-drill';
    const { initializeApp } = require('firebase-admin/app'), { getAuth } = require('firebase-admin/auth');
    app = initializeApp({ projectId: 'demo-sarin-recovery-drill' }, 'drill-' + crypto.randomUUID());
    const identities = await stage('authRestore', () => probe.probeRecoveryAuth(getAuth(app), authRuntime.host));
    cases.auth_fresh_login_no_role = 'pass';
    const reference = { version: 'demo-v1', observedAt: now - 1000, sha256: 'a'.repeat(64), privateSource: 'demo-manager' };
    const inventory = { formatVersion: 1, batchId: 'demo-config', observedAt: now - 1000, sourceSha, imageDigest: 'sha256:' + 'b'.repeat(64), migrations, protocols: { quota: 2 }, sections: Object.fromEntries(['providers', 'domains', 'indexes', 'rules', 'wif', 'access', 'bindings', 'flags'].map(key => [key, reference])), requiredSecrets: [], secrets: [], passwordBatch: null };
    const captureInput = { directory, now, source: { sourceSha, migrations,
      exportSql: async () => ({ stream: new Response(data.sql).body, bookmark: 'demo-local', startedAt: now - 1000, completedAt: now, recoverableAt: now - 1000 }),
      readObject: async () => ({ stream: new Response(data.object).body, contentType: data.blob.contentType }) },
      auth: { listUsers: async () => ({ users: identities.users }) }, config: { readInventory: async () => inventory } };
    const incomplete = await captureRecoveryComponents({ ...captureInput, config: { readInventory: async () => ({ ...inventory, sections: {} }) } });
    assert.equal(incomplete.complete, false); assert.ok(incomplete.blockers.includes('CONFIG_INCOMPLETE')); cases.config_incomplete = 'pass';
    const capture = await stage('capture', () => captureRecoveryComponents(captureInput));
    assert.equal(capture.complete, true, canonicalJson(capture.blockers));
    const objects = new Map();
    const destination = { async putIfAbsent(id, stream) { assert.equal(objects.has(id), false); const chunks = []; for await (const chunk of stream) chunks.push(Buffer.from(chunk)); objects.set(id, Buffer.concat(chunks)); }, async get(id) { const b = objects.get(id); return b ? Readable.from([b]) : null; } };
    const encrypted = await stage('encrypt', () => encryptBackupComponents(capture, { agePath, recipient, destination }));
    const expected = { sourceSha, migrations, protocols: { quota: 2 } };
    const decrypt = (patch = {}) => decryptBackupSet({ envelope: encrypted.envelope, source: destination, agePath, identityFile, directory, expected, ...patch });
    const other = join(directory, 'other-identity.txt'); execFileSync(keygen, ['-o', other], { windowsHide: true, stdio: 'pipe' }); await chmod(other, 0o600);
    await reject('wrong_key', () => decrypt({ identityFile: other }), /RECOVERY_AGE_DECRYPT/);
    await reject('missing_key', () => decrypt({ identityFile: join(directory, 'absent.txt') }), /RECOVERY_AGE_PRIVATE/);
    const first = encrypted.envelope.objects[0].id, original = objects.get(first); objects.set(first, original.subarray(0, -1));
    await reject('ciphertext_truncated', () => decrypt(), /RECOVERY_AGE_READBACK/); objects.set(first, original);
    const restored = await stage('decrypt', () => decrypt());
    const restoredAuth = JSON.parse(await readFile(join(restored.directory, 'auth.json'), 'utf8'));
    assert.equal(restoredAuth.grantsAuthority, false); assert.equal(restoredAuth.requiresNewLogin, true);
    await stage('decryptedAuthRestore', () => probe.probeRecoveryAuth(getAuth(app), authRuntime.host, restoredAuth.users));
    const sql = await readFile(join(restored.directory, 'sarin-bot-data.sql'));
    await reject('sql_tamper', async () => verifySanitizedSql(Buffer.concat([sql, Buffer.from('\n--tampered')]), restored.manifest.sanitization), /D1_BACKUP_SQL_HASH/);
    await reject('manifest_tamper', async () => validateBackupManifest({ ...restored.manifest, formatVersion: 2 }, expected), /D1_BACKUP_MANIFEST/);
    const missingEvent = Buffer.from(sql.toString().split('\n').filter(line => !line.includes('demo-private-event')).join('\n'));
    await reject('private_event_missing', async () => verifySanitizedSql(missingEvent, { ...restored.manifest.sanitization, sqlSha256: sha256(missingEvent), bytes: missingEvent.length }), /D1_BACKUP_INVENTORY/);
    const objectFile = join(restored.directory, 'r2-objects', data.blob.sha256);
    const object = await readFile(objectFile); await rm(objectFile);
    await reject('object_missing', () => verifyD1Backup(restored), /ENOENT/);
    await writeFile(objectFile, Buffer.alloc(object.length), { mode: 0o600 });
    await reject('object_altered', () => verifyD1Backup(restored), /D1_BACKUP_R2_HASH/);
    await writeFile(objectFile, object, { mode: 0o600 });
    const currentAuth = { complete: true, resourceId: 'd'.repeat(64), observedAt: now, requiresNewLogin: true, iamVerified: true, invalidatedUids: ['demo-member'] };
    const scopes = [data.membershipPath, data.consentPath, 'businesses/demo-business/appointments/demo-appointment'].map(path => ({ path, reason: 'delete' }));
    const witness = { complete: true, resourceId: currentAuth.resourceId, fromRevision: 7, toRevision: 8, startedAt: now - 2000, observedAt: now, gaps: [], intents: [{ intentId: 'demo-restrictive', coveredRevision: 7, revision: 8, status: 'complete', scopes }] };
    const reconciliation = buildRecoveryReconciliation({ manifest: restored.manifest, witness, currentAuth, now });
    assert.equal(reconciliation.canAdmit, false); assert.equal(reconciliation.invalidations.length, scopes.length);
    assert.ok(buildRecoveryReconciliation({ manifest: restored.manifest, witness: null, currentAuth: null, now }).blockers.includes('WITNESS_INCOMPLETE')); cases.witness_missing = 'pass';
    assert.throws(() => assertRecoveryAdmission({ candidateSha: sourceSha, manifestSha256: reconciliation.manifestSha256, reconciliationSha: reconciliation.reconciliationSha, resourceId: witness.resourceId, coverage: witness, mode: 'recovery', now }), /RECOVERY_ADMISSION/);
    let effects, indexes;
    const restore = await stage('d1R2RestoreAndProbes', () => verifyD1Backup(restored, { localWorker, inspectLocal: async local => {
      indexes = (await local.db.prepare("SELECT name FROM sqlite_schema WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()).results.map(r => r.name);
      effects = await probe.probeRestoredRuntime(local, data, reconciliation, now);
    } }));
    for (const id of ['post_snapshot_invalidations', 'consent_withdrawn', 'deleted_and_expired', 'cancelled_offer_invalid_proposal', 'producers_disabled', 'uncertain_quota_and_later_receipt', 'post_snapshot_receipt', 'team_domain_before_after_reconciliation']) cases[id] = 'pass';
    const oldest = Math.min(...Object.values(capture.snapshotTimes).map(t => t.recoverableAt));
    const report = { ok: true, synthetic: true, localOnly: true, sourceSha, remoteMutations: false, recovery: 'partial_closed', admission: false, migrations, indexes, restore, cases, effects,
      blockers: [...reconciliation.blockers, 'SYNTHETIC_ONLY', 'OPERATIONAL_APPROVAL_REQUIRED'], unmeasuredEffects: ['financial_refund_no_product_api'],
      measurements: { stagesMs: stages, elapsedMs: Math.round(performance.now() - started), plaintextBytes: capture.files.reduce((sum, f) => sum + f.bytes, 0), ciphertextBytes: [...objects.values()].reduce((sum, b) => sum + b.length, 0), oldestComponentAgeMs: now - oldest + Math.round(performance.now() - started), rpoTargetMs: 86400000, rtoTargetMs: 28800000, rtoProductionProven: false, safeOpenRtoMs: null, scope: 'small_synthetic_fixture_only' } };
    await writePrivateFile(directory, 'drill-report.json', JSON.stringify(report, null, 2)); return report;
  } finally {
    if (app) await require('firebase-admin/app').deleteApp(app);
    if (authRuntime) await authRuntime.stop();
    // Only disposable synthetic keys generated by this invocation are removed.
    for (const name of ['identity.txt', 'other-identity.txt']) await rm(join(directory, name), { force: true });
    for (const key of Object.keys(process.env)) delete process.env[key]; Object.assign(process.env, saved);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    if (process.argv.length !== 5 || process.argv[2] !== '--synthetic' || process.argv[3] !== '--directory') fail('ARGUMENTS');
    console.log(JSON.stringify(await runRecoveryDrill({ directory: process.argv[4], fixture: 'demo-sarin-recovery-v1' })));
  } catch (error) { console.error(JSON.stringify({ ok: false, code: /^(RECOVERY_DRILL|RECOVERY_AGE|D1_BACKUP|MIGRATION)_[A-Z0-9_]+$/.test(error?.message) ? error.message : 'RECOVERY_DRILL_FAILED' })); process.exitCode = 1; }
}
