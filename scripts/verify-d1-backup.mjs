import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { normalizeImportedRow, privateDirectory, readPrivateFile, writePrivateFile } from './lib/data-migration.mjs';
import { recoveryMigrationInventory, validateBackupManifest, verifySanitizedSql } from './lib/recovery-backup.mjs';

const tables = ['app_commits', 'app_documents', 'app_revision'];
const sha256 = value => createHash('sha256').update(value).digest('hex');
const canonical = value => JSON.stringify(Array.isArray(value) ? value.map(item => JSON.parse(canonical(item))) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, JSON.parse(canonical(value[key]))])) : value);
const schemaQuery = "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE tbl_name IN ('app_commits','app_documents','app_revision') AND name NOT LIKE 'sqlite_%' ORDER BY type,name";
const fingerprint = rows => ({ count: rows.length, sha256: sha256(canonical(rows.map(row => canonical(row)).sort())) });

/** Only imports an existing private SQL backup into an isolated local D1. No remote API exists here. */
export async function verifyD1Backup(inputDirectory, options = {}) {
  if (inputDirectory && typeof inputDirectory === 'object') {
    const set = inputDirectory;
    if (typeof set.directory !== 'string' || !set.manifest || !set.expected) throw new Error('D1_BACKUP_MANIFEST');
    options = { ...options, expectedManifest: set.manifest, expected: set.expected };
    inputDirectory = set.directory;
  }
  const directory = await privateDirectory(inputDirectory);
  const manifest = JSON.parse((await readPrivateFile(directory, 'export-manifest.json')).toString('utf8').replace(/^\uFEFF/, ''));
  if (manifest.ok !== true || manifest.filename !== 'sarin-bot-data.sql' || !/^[a-f0-9]{64}$/.test(manifest.sha256)) throw new Error('D1_BACKUP_MANIFEST');
  const bytes = await readPrivateFile(directory, manifest.filename);
  if (bytes.length !== manifest.bytes || sha256(bytes) !== manifest.sha256) throw new Error('D1_BACKUP_HASH');
  if (Object.hasOwn(options, 'expectedManifest')) {
    const expected = options.expected ?? { sourceSha: options.expectedManifest?.sourceSha, migrations: recoveryMigrationInventory(), protocols: { quota: 2 } };
    const set = validateBackupManifest(options.expectedManifest, expected);
    verifySanitizedSql(bytes, set.sanitization);
  }
  const source = new DatabaseSync(':memory:', { allowExtension: false });
  let runtime;
  try {
    source.exec(bytes.toString('utf8'));
    const found = source.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name IN ('app_commits','app_documents','app_revision') ORDER BY name").all();
    if (found.map(row => row.name).join(',') !== tables.join(',')) throw new Error('D1_BACKUP_SCHEMA');
    const references = new Map();
    for (const row of source.prepare('SELECT * FROM app_documents WHERE blob IS NOT NULL').all()) {
      let reference;
      try { reference = normalizeImportedRow(row).blob; } catch { throw new Error('D1_BACKUP_R2_REFERENCE'); }
      if (!reference) throw new Error('D1_BACKUP_R2_REFERENCE');
      if (references.has(reference.key) && canonical(references.get(reference.key)) !== canonical(reference)) throw new Error('D1_BACKUP_R2_REFERENCE');
      references.set(reference.key, reference);
    }
    let objectDirectory;
    if (references.size) {
      const objects = JSON.parse((await readPrivateFile(directory, 'r2-backup-manifest.json')).toString('utf8'));
      if (objects.sourceSqlSha256 !== manifest.sha256 || objects.bucket !== 'sarin-bot-files' || !Array.isArray(objects.references) || objects.references.length !== references.size || new Set(objects.references.map(reference => reference.key)).size !== references.size || objects.references.some(reference => canonical(references.get(reference.key)) !== canonical(reference))) throw new Error('D1_BACKUP_R2_MANIFEST');
      objectDirectory = await privateDirectory(join(directory, 'r2-objects'));
    }
    const require = createRequire(new URL('../cloudflare/package.json', import.meta.url));
    const wranglerRequire = createRequire(require.resolve('wrangler/package.json'));
    const { Miniflare, convertV4MiniflareOptions, Log, LogLevel } = wranglerRequire('miniflare');
    const { unstable_splitSqlQuery } = require('wrangler');
    const localDirectory = join(directory, `local-restore-${Date.now()}`);
    await mkdir(localDirectory, { mode: 0o700 });
    runtime = new Miniflare(convertV4MiniflareOptions({ modules: true, script: options.localWorker ?? 'export default {fetch(){return new Response(null,{status:404})}}',
      compatibilityDate: '2026-10-13', d1Databases: { BACKUP_DB: 'sarin-recovery-local-only', SARIN_DB: 'sarin-recovery-local-only' }, d1Persist: join(localDirectory, 'd1'),
      r2Buckets: { BACKUP_FILES: 'sarin-recovery-files-local-only' }, r2Persist: join(localDirectory, 'r2'), log: new Log(LogLevel.NONE) }));
    const target = await runtime.getD1Database('BACKUP_DB');
    const commands = unstable_splitSqlQuery(bytes.toString('utf8'));
    // This API belongs to the local Miniflare binding, never Wrangler remote execute.
    await target.batch(commands.map(command => target.prepare(command)));
    const expectedSchema = fingerprint(source.prepare(schemaQuery).all());
    const actualSchema = fingerprint((await target.prepare(schemaQuery).all()).results);
    if (canonical(expectedSchema) !== canonical(actualSchema)) throw new Error('D1_RECOVERY_SCHEMA_MISMATCH');
    const counts = {};
    for (const table of tables) {
      const expected = fingerprint(source.prepare(`SELECT * FROM ${table}`).all());
      const actual = fingerprint((await target.prepare(`SELECT * FROM ${table}`).all()).results);
      if (canonical(expected) !== canonical(actual)) throw new Error('D1_RECOVERY_ROWS_MISMATCH');
      counts[table] = actual;
    }
    const check = await target.prepare('PRAGMA quick_check').all();
    if (check.results.length !== 1 || Object.values(check.results[0])[0] !== 'ok') throw new Error('D1_RECOVERY_INTEGRITY');
    const revision = (await target.prepare('SELECT revision FROM app_revision WHERE id=1').first())?.revision;
    const bucket = await runtime.getR2Bucket('BACKUP_FILES');
    let objectBytes = 0;
    for (const reference of references.values()) {
      const file = await readPrivateFile(objectDirectory, reference.sha256);
      if (file.length !== reference.byteLength || sha256(file) !== reference.sha256) throw new Error('D1_BACKUP_R2_HASH');
      await bucket.put(reference.key, file, { httpMetadata: { contentType: reference.contentType } });
      const restored = await bucket.get(reference.key);
      if (!restored || restored.size !== reference.byteLength || restored.httpMetadata?.contentType !== reference.contentType || sha256(Buffer.from(await restored.arrayBuffer())) !== reference.sha256) throw new Error('D1_RECOVERY_R2_HASH');
      objectBytes += file.length;
    }
    const result = { ok: true, verifiedAt: new Date().toISOString(), sourceSha256: manifest.sha256, sourceBytes: bytes.length, localOnly: true, schema: actualSchema,
      tables: counts, revision, r2: { objects: references.size, bytes: objectBytes, verified: true }, integrity: 'ok', statements: commands.length, dataPrinted: false, remoteMutations: false };
    // Inspect only after the exact restored fingerprints and every object have passed.
    if (options.inspectLocal) await options.inspectLocal({ db: target, bucket,
      fetch: command => runtime.dispatchFetch('http://demo-recovery.test/execute', { method: 'POST', body: JSON.stringify(command) }),
      fetchClosed: command => runtime.dispatchFetch('http://demo-recovery.test/closed', { method: 'POST', body: JSON.stringify(command) }) });
    await writePrivateFile(directory, `recovery-verification-${Date.now()}.json`, JSON.stringify(result, null, 2));
    return result;
  } finally {
    source.close();
    if (runtime) await runtime.dispose();
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    if (process.argv.length !== 4 || process.argv[2] !== '--directory') throw new Error('D1_BACKUP_ARGUMENTS');
    console.log(JSON.stringify(await verifyD1Backup(process.argv[3])));
  } catch (error) {
    // SQLite errors can contain values from a statement. Never expose the original text.
    console.error(JSON.stringify({ ok: false, code: /^D1_[A-Z_]+$/.test(error?.message) ? error.message : 'D1_LOCAL_RECOVERY_FAILED' }));
    process.exitCode = 1;
  }
}
