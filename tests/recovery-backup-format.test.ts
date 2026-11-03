import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { sanitizeBackupSql, validateBackupManifest, verifySanitizedSql } from '../scripts/lib/recovery-backup.mjs';
import { verifyD1Backup } from '../scripts/verify-d1-backup.mjs';
import { privateDirectory, writePrivateFile, sha256 } from '../scripts/lib/data-migration.mjs';
import { recoverySql, recoveryNow, recoverySha, recoveryMigrations, recoveryAppointment, recoveryManifest, recoveryTeamEvent } from './recovery-backup-fixtures';

const input = () => ({ sql: recoverySql([{ path: 'businesses/demo-business/appointments/demo-appointment', data: recoveryAppointment }]), now: recoveryNow, sourceSha: recoverySha, migrations: recoveryMigrations });
const expected = { sourceSha: recoverySha, migrations: recoveryMigrations, protocols: { quota: 2 } };
describe('sanitized SQL recovery snapshots', () => {
  it('daily_excludes_bodies_and_preserves_controls', () => {
    const source = input(), result = sanitizeBackupSql(source);
    expect(result.sql.toString()).not.toContain('PRIVATE_INTAKE_SENTINEL');
    expect(result.sanitization.sourceSha256).toBe(sha256(source.sql));
    expect(result.exportManifest.sha256).toBe(sha256(result.sql));
    expect(result.sanitization.sqlSha256).not.toBe(result.sanitization.sourceSha256);
    const db = new DatabaseSync(':memory:');
    try {
      db.exec(result.sql.toString());
      expect(db.prepare('SELECT * FROM app_commits').all()).toHaveLength(1);
      expect(db.prepare('SELECT revision FROM app_revision WHERE id=1').get()?.revision).toBe(7);
      const row = db.prepare('SELECT data FROM app_documents').get();
      const data = JSON.parse(row!.data as string);
      expect(data.client.intakeAnswers).toEqual({});
      expect(data.beneficiary).toEqual(recoveryAppointment.beneficiary);
      expect(data.subjectAuthorization).toEqual(recoveryAppointment.subjectAuthorization);
      expect(db.prepare("SELECT name FROM sqlite_schema WHERE name='app_client_page_ascending'").get()).toBeDefined();
    } finally { db.close(); }
    expect(verifySanitizedSql(result.sql, result.sanitization)).toMatchObject({ revision: 7 });
  });
  it('format_rejects_tamper_or_mixed_sets', () => {
    const result = sanitizeBackupSql(input()), manifest = recoveryManifest(result.sanitization);
    expect(validateBackupManifest(manifest, expected)).toEqual(manifest);
    for (const patch of [{ formatVersion: 2 }, { backupId: 'not-a-uuid' }, { sourceSha: 'f'.repeat(40) }, { protocols: { quota: 1 } }, { migrations: recoveryMigrations.slice(1) }, { secret: 'PRIVATE' }, { d1Revision: 8 }]) {
      expect(() => validateBackupManifest({ ...manifest, ...patch }, expected)).toThrow(/^D1_BACKUP_/);
    }
    expect(() => validateBackupManifest({ ...manifest, components: [...manifest.components, manifest.components[0]] }, expected)).toThrow(/^D1_BACKUP_/);
    expect(() => validateBackupManifest({ ...manifest, components: [...manifest.components, { ...manifest.components[0], id: crypto.randomUUID() }] }, expected)).toThrow(/^D1_BACKUP_/);
    expect(() => validateBackupManifest({ ...manifest, components: manifest.components.map(c => c.kind === 'd1' ? { ...c, plaintextSha256: 'f'.repeat(64) } : c) }, expected)).toThrow(/^D1_BACKUP_/);
    expect(() => validateBackupManifest({ ...manifest, auth: { ...manifest.auth, sha256: 'f'.repeat(64) } }, expected)).toThrow(/^D1_BACKUP_/);
    expect(() => validateBackupManifest({ ...manifest, config: { ...manifest.config, sha256: 'f'.repeat(64) } }, expected)).toThrow(/^D1_BACKUP_/);
    expect(() => validateBackupManifest(manifest, { ...expected, backupId: crypto.randomUUID() })).toThrow(/^D1_BACKUP_/);
    expect(() => verifySanitizedSql(Buffer.from(result.sql.toString() + '\n--changed'), result.sanitization)).toThrow('D1_BACKUP_SQL_HASH');
    expect(() => validateBackupManifest({ ...manifest, auth: { ...manifest.auth, complete: false } }, expected)).toThrow(/^D1_BACKUP_/);
  });
  it('private_event_loss_is_detected even if the outer SQL hash is recomputed', () => {
    const result = sanitizeBackupSql({ ...input(), sql: recoverySql([{ path: 'businesses/demo-business/teamAccessEvents/demo-private-event', data: recoveryTeamEvent }]) });
    const altered = Buffer.from(result.sql.toString().split('\n').filter((line: string) => !line.includes('demo-private-event')).join('\n'));
    expect(() => verifySanitizedSql(altered, { ...result.sanitization, sqlSha256: sha256(altered), bytes: altered.length })).toThrow('D1_BACKUP_INVENTORY');
  });
  it.each(["ATTACH DATABASE '/forbidden' AS stolen;", "VACUUM INTO '/forbidden';", "SELECT load_extension('forbidden');", "CREATE TABLE unknown(secret TEXT);", "CREATE VIRTUAL TABLE evil USING fts5(secret);", "SELECT randomblob(1000000000);"])(
    'refuses unsafe or unclassified SQL without leaking its content: %s', addition => {
      expect(() => sanitizeBackupSql({ ...input(), sql: Buffer.concat([input().sql, Buffer.from(addition)]) })).toThrow(/^D1_BACKUP_/);
    });
  it('rejects unknown migrations, schema drift, bad clock and logical JSON input', () => {
    expect(() => sanitizeBackupSql({ ...input(), sql: Buffer.from('{"documents":[]}') })).toThrow(/^D1_BACKUP_/);
    expect(() => sanitizeBackupSql({ ...input(), migrations: recoveryMigrations.slice(1) })).toThrow(/^D1_BACKUP_/);
    expect(() => sanitizeBackupSql({ ...input(), now: NaN })).toThrow(/^D1_BACKUP_/);
    expect(() => sanitizeBackupSql({ ...input(), sql: Buffer.from(input().sql.toString().replace('CREATE INDEX app_parent', 'CREATE INDEX altered_parent')) })).toThrow(/^D1_BACKUP_/);
  });
  it('restores sanitized SQL through the existing real local D1/R2 verifier and rejects lost rows', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sarin-recovery-format-'));
    try {
      await privateDirectory(directory);
      const result = sanitizeBackupSql(input()), manifest = recoveryManifest(result.sanitization);
      await writePrivateFile(directory, 'sarin-bot-data.sql', result.sql);
      await writePrivateFile(directory, 'export-manifest.json', JSON.stringify(result.exportManifest));
      const proof = await verifyD1Backup(directory, { expectedManifest: manifest, expected });
      expect(proof).toMatchObject({ ok: true, localOnly: true, revision: 7, remoteMutations: false });
      const db = new DatabaseSync(':memory:');
      try { db.exec(result.sql.toString()); expect(db.prepare('SELECT count(*) AS n FROM app_documents').get()?.n).toBe(1); } finally { db.close(); }
      await expect(verifyD1Backup(directory, { expectedManifest: { ...manifest, backupId: 'wrong' }, expected })).rejects.toThrow(/^D1_BACKUP_/);
      await expect(verifyD1Backup(directory, { expectedManifest: null, expected })).rejects.toThrow(/^D1_BACKUP_/);
    } finally {
      expect(dirname(resolve(directory))).toBe(resolve(tmpdir())); expect(basename(directory).startsWith('sarin-recovery-format-')).toBe(true);
      await rm(directory, { recursive: true, force: true });
    }
  }, 60000);
  it('verifies retained R2 bytes and rejects missing, changed or wrong-type object metadata', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sarin-recovery-format-'));
    try {
      await privateDirectory(directory); const objects = await privateDirectory(join(directory, 'r2-objects'), { create: true });
      const bytes = Buffer.from('RIFF0000WEBPsynthetic'), digest = sha256(bytes);
      const reference = { key: `business-logos/${digest}`, sha256: digest, byteLength: bytes.length, contentType: 'image/webp' };
      const result = sanitizeBackupSql({ ...input(), sql: recoverySql([{ path: `businessLogos/demo-business_${digest}`, data: { businessId: 'demo-business', ownerUid: 'demo-owner', sha256: digest, createdAt: recoveryNow }, blob: reference }]) });
      const manifest = recoveryManifest(result.sanitization);
      await writePrivateFile(directory, 'sarin-bot-data.sql', result.sql);
      await writePrivateFile(directory, 'export-manifest.json', JSON.stringify(result.exportManifest));
      await writePrivateFile(directory, 'r2-backup-manifest.json', JSON.stringify(result.r2Manifest));
      await expect(verifyD1Backup(directory, { expectedManifest: manifest, expected })).rejects.toThrow();
      await writePrivateFile(objects, digest, Buffer.alloc(bytes.length));
      await expect(verifyD1Backup(directory, { expectedManifest: manifest, expected })).rejects.toThrow('D1_BACKUP_R2_HASH');
      await rm(join(objects, digest)); await writePrivateFile(objects, digest, bytes);
      expect(await verifyD1Backup(directory, { expectedManifest: manifest, expected })).toMatchObject({ ok: true, r2: { objects: 1, bytes: bytes.length, verified: true } });
      const incompatible = { ...result.r2Manifest, references: [{ ...reference, contentType: 'image/png' }] };
      await rm(join(directory, 'r2-backup-manifest.json')); await writePrivateFile(directory, 'r2-backup-manifest.json', JSON.stringify(incompatible));
      await expect(verifyD1Backup(directory, { expectedManifest: manifest, expected })).rejects.toThrow('D1_BACKUP_R2_MANIFEST');
    } finally {
      expect(dirname(resolve(directory))).toBe(resolve(tmpdir())); expect(basename(directory).startsWith('sarin-recovery-format-')).toBe(true);
      await rm(directory, { recursive: true, force: true });
    }
  }, 60000);
});
