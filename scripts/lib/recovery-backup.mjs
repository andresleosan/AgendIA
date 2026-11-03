import { DatabaseSync, constants as sqlite } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { canonicalJson, normalizeImportedRow, sha256, sqlQuote, validateBlobReference } from './data-migration.mjs';
import { classifyBackupDocument } from './recovery-classification.mjs';
export { classifyBackupDocument, BACKUP_CLASSIFIED_ROOTS, BACKUP_CLASSIFIED_CHILDREN } from './recovery-classification.mjs';

/** @returns {never} */
const fail = code => { throw new Error(`D1_BACKUP_${code}`); };
const hash = z.string().regex(/^[a-f0-9]{64}$/), count = z.number().int().nonnegative().safe();
const strict = shape => z.object(shape).strict();
const migrationSchema = strict({ path: z.string().regex(/^cloudflare\/migrations\/\d+_[a-z0-9_]+\.sql$/), sha256: hash });
const protocolsSchema = strict({ quota: z.literal(2) });
const fingerprintSchema = strict({ count, sha256: hash });
const blobSchema = strict({ key: z.string(), contentType: z.string(), byteLength: count, sha256: hash });
const tables = ['app_commits', 'app_documents', 'app_revision'];
const schemaQuery = "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE tbl_name IN ('app_commits','app_documents','app_revision') AND name NOT LIKE 'sqlite_%' ORDER BY type,name";
const fingerprint = rows => ({ count: rows.length, sha256: sha256(canonicalJson(rows.map(row => canonicalJson(row)).sort())) });
const migrationsDirectory = new URL('../../cloudflare/migrations/', import.meta.url);

export function recoveryMigrationInventory() {
  return readdirSync(migrationsDirectory).filter(name => /^\d+.*\.sql$/.test(name)).sort().map(name => ({ path: `cloudflare/migrations/${name}`, sha256: sha256(readFileSync(new URL(name, migrationsDirectory))) }));
}
function checkedMigrations(value) {
  if (!z.array(migrationSchema).min(1).safeParse(value).success || canonicalJson(value) !== canonicalJson(recoveryMigrationInventory())) fail('MIGRATIONS');
}
function expectedSchema() {
  const db = new DatabaseSync(':memory:', { allowExtension: false });
  try {
    for (const { path } of recoveryMigrationInventory()) db.exec(readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8'));
    return db.prepare(schemaQuery).all();
  } finally { db.close(); }
}

/** SQL is untrusted even in memory: ATTACH/VACUUM/functions must not access operator files. */
function openSnapshot(sql) {
  if (!(sql instanceof Uint8Array) || sql.byteLength === 0 || sql.byteLength > 1024 ** 3) fail('SQL_INPUT');
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(sql); } catch { fail('SQL_ENCODING'); }
  const db = new DatabaseSync(':memory:', { allowExtension: false });
  const schema = expectedSchema(), knownNames = new Set([...schema.map(row => row.name), 'sqlite_autoindex_app_commits_1', 'sqlite_autoindex_app_documents_1']);
  const allowed = new Set([sqlite.SQLITE_CREATE_TABLE, sqlite.SQLITE_CREATE_INDEX, sqlite.SQLITE_CREATE_TRIGGER, sqlite.SQLITE_INSERT, sqlite.SQLITE_READ, sqlite.SQLITE_SELECT, sqlite.SQLITE_UPDATE, sqlite.SQLITE_TRANSACTION, sqlite.SQLITE_SAVEPOINT]);
  db.setAuthorizer((action, first, second, database) => {
    if (database && database !== 'main') return sqlite.SQLITE_DENY;
    if (action === sqlite.SQLITE_FUNCTION) return ['json_valid', 'json_type', 'json_extract', 'json', 'raise'].includes(second) ? sqlite.SQLITE_OK : sqlite.SQLITE_DENY;
    if (action === sqlite.SQLITE_REINDEX) return knownNames.has(first) ? sqlite.SQLITE_OK : sqlite.SQLITE_DENY;
    if (action === sqlite.SQLITE_PRAGMA) return first === 'defer_foreign_keys' ? sqlite.SQLITE_OK : sqlite.SQLITE_DENY;
    if (!allowed.has(action)) return sqlite.SQLITE_DENY;
    if ([sqlite.SQLITE_CREATE_TABLE, sqlite.SQLITE_CREATE_INDEX, sqlite.SQLITE_CREATE_TRIGGER].includes(action) && !knownNames.has(first)) return sqlite.SQLITE_DENY;
    return sqlite.SQLITE_OK;
  });
  try {
    db.exec(text);
    db.setAuthorizer(null);
    if (canonicalJson(db.prepare(schemaQuery).all()) !== canonicalJson(schema)) fail('SCHEMA');
    if (db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(row => row.name).sort().join(',') !== tables.join(',')) fail('SCHEMA');
    if (Object.values(db.prepare('PRAGMA quick_check').get())[0] !== 'ok') fail('INTEGRITY');
    const revisions = db.prepare('SELECT * FROM app_revision').all();
    if (revisions.length !== 1 || revisions[0].id !== 1 || !count.safeParse(revisions[0].revision).success) fail('REVISION');
    for (const row of db.prepare('SELECT * FROM app_commits').all()) {
      if (typeof row.request_id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(row.request_id) || !hash.safeParse(row.fingerprint).success || !count.safeParse(row.revision).success || row.revision > revisions[0].revision || !count.safeParse(row.created_at).success) fail('JOURNAL');
    }
    return db;
  } catch (error) {
    db.close();
    if (/^D1_BACKUP_[A-Z_]+$/.test(error.message)) throw error;
    fail('SQL_REJECTED');
  }
}

const sanitizationSchema = strict({
  formatVersion: z.literal(1), sourceSha: z.string().regex(/^[a-f0-9]{40}$/), migrations: z.array(migrationSchema), protocols: protocolsSchema,
  sourceSha256: hash, sqlSha256: hash, bytes: count, d1Revision: count, exclusionVersion: z.literal(1),
  schema: fingerprintSchema, tables: strict(Object.fromEntries(tables.map(table => [table, fingerprintSchema]))),
  documents: z.array(strict({ path: z.string(), sha256: hash })), r2References: z.array(blobSchema),
  transformations: z.array(strict({ code: z.string().regex(/^[A-Z_]+$/), count: count.min(1) })),
});
const componentKind = z.enum(['d1', 'r2', 'auth', 'config']);
const componentSchema = strict({ id: z.string().uuid(), kind: componentKind, ciphertextSha256: hash, bytes: count.min(1), plaintextSha256: hash, classification: z.literal('private') });
const times = strict({ startedAt: count, completedAt: count, recoverableAt: count }).refine(t => t.recoverableAt >= t.startedAt && t.recoverableAt <= t.completedAt);
const batch = strict({ complete: z.literal(true), batchId: z.string().min(1).max(128), sha256: hash });
const manifestSchema = strict({ formatVersion: z.literal(1), backupId: z.string().uuid(), sourceSha: z.string().regex(/^[a-f0-9]{40}$/), migrations: z.array(migrationSchema), protocols: protocolsSchema,
  snapshotTimes: strict({ d1: times, r2: times, auth: times, config: times }), d1Revision: count, components: z.array(componentSchema).length(4), r2References: z.array(blobSchema), exclusionVersion: z.literal(1), sanitization: sanitizationSchema, auth: batch, config: batch });
const compatibilitySchema = strict({ sourceSha: z.string().regex(/^[a-f0-9]{40}$/), migrations: z.array(migrationSchema), protocols: protocolsSchema, backupId: z.string().uuid().optional() });
/** @typedef {import('zod').infer<typeof manifestSchema>} BackupManifestV1 */
/** @typedef {import('zod').infer<typeof sanitizationSchema>} SanitizationProof */

export function validateBackupManifest(value, expected) {
  if (!manifestSchema.safeParse(value).success || !compatibilitySchema.safeParse(expected).success) fail('MANIFEST');
  checkedMigrations(value.migrations);
  if (value.sourceSha !== expected.sourceSha || canonicalJson(value.migrations) !== canonicalJson(expected.migrations) || canonicalJson(value.protocols) !== canonicalJson(expected.protocols) || expected.backupId && value.backupId !== expected.backupId) fail('COMPATIBILITY');
  const proof = value.sanitization;
  if (proof.sourceSha !== value.sourceSha || proof.d1Revision !== value.d1Revision || canonicalJson(proof.migrations) !== canonicalJson(value.migrations) || canonicalJson(proof.protocols) !== canonicalJson(value.protocols) || canonicalJson(proof.r2References) !== canonicalJson(value.r2References)) fail('MANIFEST_LINK');
  if (new Set(value.components.map(c => c.id)).size !== value.components.length || ['d1', 'r2', 'auth', 'config'].some(kind => !value.components.some(c => c.kind === kind))) fail('COMPONENTS');
  // One logical component per kind; the encryption layer may frame it into independently checked chunks.
  for (const [kind, expectedHash] of [['d1', proof.sqlSha256], ['auth', value.auth.sha256], ['config', value.config.sha256]]) {
    if (value.components.find(component => component.kind === kind).plaintextSha256 !== expectedHash) fail('COMPONENT_LINK');
  }
  if (new Set(proof.documents.map(d => d.path)).size !== proof.documents.length || proof.documents.length !== proof.tables.app_documents.count) fail('INVENTORY');
  const references = new Set();
  for (const reference of value.r2References) {
    try { validateBlobReference(reference); } catch { fail('R2_REFERENCE'); }
    if (references.has(reference.key)) fail('R2_REFERENCE');
    references.add(reference.key);
  }
  return structuredClone(value);
}

function inventory(db) {
  const rows = Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT * FROM ${table}`).all()]));
  return { schema: fingerprint(db.prepare(schemaQuery).all()), tables: Object.fromEntries(tables.map(table => [table, fingerprint(rows[table])])),
    documents: rows.app_documents.map(row => ({ path: row.path, sha256: sha256(canonicalJson(row)) })).sort((a, b) => a.path < b.path ? -1 : 1), revision: rows.app_revision[0].revision };
}
function referencesFor(db) {
  const refs = new Map();
  for (const row of db.prepare('SELECT * FROM app_documents').all()) {
    let normalized;
    try { normalized = normalizeImportedRow(row); } catch { fail('ROW'); }
    if (!normalized.blob) continue;
    const ref = normalized.blob;
    if (refs.has(ref.key) && canonicalJson(refs.get(ref.key)) !== canonicalJson(ref)) fail('R2_REFERENCE');
    refs.set(ref.key, ref);
  }
  return [...refs.values()].sort((a, b) => a.key < b.key ? -1 : 1);
}

export function verifySanitizedSql(sql, expected) {
  if (!sanitizationSchema.safeParse(expected).success) fail('SANITIZATION_MANIFEST');
  checkedMigrations(expected.migrations);
  if (!(sql instanceof Uint8Array) || sql.byteLength !== expected.bytes || sha256(sql) !== expected.sqlSha256) fail('SQL_HASH');
  const db = openSnapshot(sql);
  try {
    const actual = inventory(db);
    if (actual.revision !== expected.d1Revision || canonicalJson(actual.schema) !== canonicalJson(expected.schema) || canonicalJson(actual.tables) !== canonicalJson(expected.tables) || canonicalJson(actual.documents) !== canonicalJson(expected.documents) || canonicalJson(referencesFor(db)) !== canonicalJson(expected.r2References)) fail('INVENTORY');
    return actual;
  } finally { db.close(); }
}

function dumpSnapshot(db) {
  const schema = db.prepare(schemaQuery).all();
  const sql = schema.filter(row => row.type === 'table').map(row => `${row.sql};`);
  // Triggers are installed after the existing journal/revision: replaying historical inserts is not a new commit.
  for (const table of tables) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name);
    for (const row of db.prepare(`SELECT * FROM ${table}`).all()) {
      const values = columns.map(key => row[key] === null ? 'NULL' : typeof row[key] === 'number' ? String(row[key]) : sqlQuote(row[key]));
      sql.push(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${values.join(',')});`);
    }
  }
  sql.push(...schema.filter(row => row.type !== 'table').map(row => `${row.sql};`));
  return Buffer.from(sql.join('\n') + '\n');
}

/** Produces a plaintext component for later encryption; it never claims a sealed backup. */
export function sanitizeBackupSql({ sql, now, migrations, sourceSha }) {
  if (!count.safeParse(now).success || !/^[a-f0-9]{40}$/.test(sourceSha ?? '')) fail('INPUT');
  checkedMigrations(migrations);
  const db = openSnapshot(sql), transformations = new Map();
  const record = code => transformations.set(code, (transformations.get(code) ?? 0) + 1);
  try {
    db.exec('BEGIN');
    for (const row of db.prepare('SELECT * FROM app_documents ORDER BY path').all()) {
      let normalized;
      try { normalized = normalizeImportedRow(row); } catch { fail('ROW'); }
      const classified = classifyBackupDocument(row.path, normalized.data, now);
      for (const code of classified.reasonCodes) record(code);
      if (classified.kind === 'exclude') db.prepare('DELETE FROM app_documents WHERE path=?').run(row.path);
      else {
        const expiredImage = row.blob && typeof normalized.data.expiresAt === 'number' && normalized.data.expiresAt <= now;
        if (expiredImage) record('EXPIRED_BLOB_REMOVED');
        db.prepare('UPDATE app_documents SET data=?,blob=? WHERE path=?').run(canonicalJson(classified.data), expiredImage ? null : row.blob, row.path);
      }
    }
    db.exec('COMMIT');
    const bytes = dumpSnapshot(db), actual = inventory(db), r2References = referencesFor(db);
    const sanitization = { formatVersion: 1, sourceSha, migrations, protocols: { quota: 2 }, sourceSha256: sha256(sql), sqlSha256: sha256(bytes), bytes: bytes.length, d1Revision: actual.revision, exclusionVersion: 1,
      schema: actual.schema, tables: actual.tables, documents: actual.documents, r2References, transformations: [...transformations].sort(([a], [b]) => a < b ? -1 : 1).map(([code, count]) => ({ code, count })) };
    verifySanitizedSql(bytes, sanitization);
    return { sql: bytes, sanitization, exportManifest: { ok: true, filename: 'sarin-bot-data.sql', sha256: sanitization.sqlSha256, bytes: bytes.length },
      r2Manifest: { sourceSqlSha256: sanitization.sqlSha256, bucket: 'sarin-bot-files', references: r2References } };
  } catch (error) {
    if (/^D1_BACKUP_[A-Z_]+$/.test(error.message)) throw error;
    fail('SANITIZATION_FAILED');
  } finally { db.close(); }
}
