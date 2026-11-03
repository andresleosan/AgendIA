import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmod, copyFile, lstat, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { captureRecoveryComponents } from '../scripts/lib/recovery-components.mjs';
import { decryptBackupSet, encryptBackupComponents, verifyAgeBinary } from '../scripts/lib/recovery-age.mjs';
import { privateDirectory, sha256 } from '../scripts/lib/data-migration.mjs';
import { verifyD1Backup } from '../scripts/verify-d1-backup.mjs';
import { recoveryMigrations, recoveryNow as now, recoverySha, recoverySql } from './recovery-backup-fixtures';

const roots: string[] = [];
const agePath = process.env.SARIN_TEST_AGE_PATH ?? (process.platform === 'win32'
  ? join(process.env.LOCALAPPDATA!, 'SarinBot/tooling/age-1.3.2/windows/age/age.exe') : '/usr/local/bin/age');
const keygen = join(dirname(agePath), process.platform === 'win32' ? 'age-keygen.exe' : 'age-keygen');
beforeAll(async () => { await verifyAgeBinary(agePath); });
afterEach(async () => {
  for (const directory of roots.splice(0)) {
    expect(dirname(resolve(directory))).toBe(resolve(tmpdir()));
    await rm(directory, { recursive: true, force: true });
  }
});

async function fixture(options: { largeAuth?: boolean; r2?: boolean; passwords?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'sarin-age-')); roots.push(root);
  const directory = await privateDirectory(root);
  const identityFile = join(directory, 'identity.txt');
  execFileSync(keygen, ['-o', identityFile], { windowsHide: true, stdio: 'pipe' });
  await chmod(identityFile, 0o600);
  const recipient = execFileSync(keygen, ['-y', identityFile], { windowsHide: true, encoding: 'utf8' }).trim();
  const ref = { version: 'demo', sha256: 'a'.repeat(64), privateSource: 'operator/demo', observedAt: now };
  const passwordBatch = Buffer.from(JSON.stringify({ formatVersion: 1, observedAt: now, hashConfig: ref, users: [{ uid: 'demo-PRIVATE_UID', passwordHash: 'ZGVtbw==', passwordSalt: '' }] }));
  const config = { formatVersion: 1, batchId: 'demo-config', observedAt: now, sourceSha: recoverySha, imageDigest: 'sha256:' + 'b'.repeat(64), migrations: recoveryMigrations, protocols: { quota: 2 },
    sections: Object.fromEntries(['providers', 'domains', 'indexes', 'rules', 'wif', 'access', 'bindings', 'flags'].map(k => [k, ref])), requiredSecrets: [], secrets: [], passwordBatch: options.passwords ? { ...ref, sha256: sha256(passwordBatch) } : null };
  const object = Buffer.from('RIFFdemofileWEBP'), digest = sha256(object);
  const logo = { key: `business-logos/${digest}`, sha256: digest, byteLength: object.length, contentType: 'image/webp' };
  const capture = await captureRecoveryComponents({ directory, now, source: { sourceSha: recoverySha, migrations: recoveryMigrations,
    exportSql: async () => ({ stream: new ReadableStream({ start(c) { c.enqueue(recoverySql(options.r2 ? [{ path: `businessLogos/demo_${digest}`, data: { businessId: 'demo', ownerUid: 'demo-owner', createdAt: now, sha256: digest }, blob: logo }] : [])); c.close(); } }), bookmark: 'demo', startedAt: now, completedAt: now, recoverableAt: now }),
    readObject: async () => ({ stream: Readable.toWeb(Readable.from([object])), contentType: 'image/webp' }) },
    config: { readInventory: async () => config }, auth: { readPasswordBatch: async () => passwordBatch, listUsers: async () => ({ users: [{ uid: 'demo-PRIVATE_UID', disabled: true,
      ...(options.largeAuth ? { displayName: 'x'.repeat(17 * 1024 * 1024) } : {}), providerData: options.passwords ? [{ uid: 'demo-PRIVATE_UID', providerId: 'password' }] : [], metadata: { creationTime: new Date(now).toUTCString() } }] }) } });
  expect(capture.complete).toBe(true);
  const objects = new Map<string, Buffer>();
  const destination = {
    async putIfAbsent(id: string, stream: any) {
      if (objects.has(id)) throw Error('PRIVATE_DESTINATION_COLLISION');
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(Buffer.from(chunk));
      objects.set(id, Buffer.concat(chunks));
    },
    async get(id: string) { const b = objects.get(id); return b ? Readable.from([b]) : null; },
  };
  const expected = { sourceSha: recoverySha, migrations: recoveryMigrations, protocols: { quota: 2 } };
  return { root, capture, agePath, recipient, identityFile, objects, destination, expected };
}
async function decrypt(f: Awaited<ReturnType<typeof fixture>>, envelope: any, extra = {}) {
  return decryptBackupSet({ envelope, source: f.destination, agePath, identityFile: f.identityFile, directory: f.root, expected: f.expected, ...extra });
}

describe('immutable age recovery archives', { timeout: 90000 }, () => {
  it('recovers exact component bytes through real age and the existing SQL verifier', async () => {
    const f = await fixture();
    const result = await encryptBackupComponents(f.capture, f);
    expect(result.envelope.status).toBe('sealed');
    const restored = await decrypt(f, result.envelope);
    for (const file of f.capture.files) expect((await readFile(join(restored.directory, file.filename))).equals(await readFile(join(f.capture.directory, file.filename)))).toBe(true);
    const checked = await verifyD1Backup(restored);
    expect(checked).toMatchObject({ ok: true, localOnly: true, revision: 7, remoteMutations: false });
  }, 60000);

  it('manifest_and_sensitive_names_are_encrypted and retry uses fresh opaque IDs', async () => {
    const f = await fixture();
    const first = await encryptBackupComponents(f.capture, f), before = new Map(f.objects);
    const second = await encryptBackupComponents(f.capture, f);
    expect(first.envelope.backupId).not.toBe(second.envelope.backupId);
    for (const [id, bytes] of before) expect(f.objects.get(id)).toEqual(bytes);
    const publicText = JSON.stringify([first.envelope, second.envelope]) + [...f.objects.values()].map(b => b.toString()).join('');
    for (const secret of ['demo-PRIVATE_UID', 'operator/demo', 'sarin-bot-data.sql', 'auth.json', 'privateSource', recoverySha]) expect(publicText).not.toContain(secret);
    expect(Object.keys(first.envelope).sort()).toEqual(['backupId', 'createdAt', 'formatVersion', 'keyId', 'manifest', 'objects', 'sealedAt', 'status']);
  });

  it('wrong_key_truncated_ciphertext_and_missing_chunk_fail without leaving partial plaintext', async () => {
    const f = await fixture(), other = await fixture();
    const { envelope } = await encryptBackupComponents(f.capture, f);
    await expect(decrypt(f, envelope, { identityFile: other.identityFile })).rejects.toThrow('RECOVERY_AGE_DECRYPT');
    await expect(decrypt(f, envelope, { identityFile: join(f.root, 'absent') })).rejects.toThrow('RECOVERY_AGE_PRIVATE');
    const id = envelope.objects[0].id, bytes = f.objects.get(id)!;
    f.objects.set(id, bytes.subarray(0, -1));
    await expect(decrypt(f, envelope)).rejects.toThrow('RECOVERY_AGE_READBACK');
    f.objects.delete(id);
    await expect(decrypt(f, envelope)).rejects.toThrow('RECOVERY_AGE_READBACK');
    expect((await readdir(f.root)).filter(n => n.startsWith('restore-'))).toEqual([]);
  });

  it('reordered, duplicated and mixed-set chunks fail before restoration', async () => {
    const f = await fixture(); const a = await encryptBackupComponents(f.capture, f), b = await encryptBackupComponents(f.capture, f);
    for (const objects of [[...a.envelope.objects].reverse(), [a.envelope.objects[0], ...a.envelope.objects], b.envelope.objects]) {
      await expect(decrypt(f, { ...a.envelope, objects })).rejects.toThrow(/RECOVERY_AGE_(ENVELOPE|INVENTORY)/);
    }
  });

  it('readback_mismatch_never_seals, collisions and cancellation fail closed with sanitized errors', async () => {
    const f = await fixture();
    await expect(encryptBackupComponents(f.capture, { ...f, destination: { ...f.destination, get: async () => Readable.from([Buffer.from('tampered')]) } })).rejects.toThrow('RECOVERY_AGE_READBACK');
    await expect(encryptBackupComponents(f.capture, { ...f, destination: { ...f.destination, putIfAbsent: async () => { throw Error('PRIVATE_DESTINATION_COLLISION'); } } })).rejects.toThrow('RECOVERY_AGE_FAILED');
    const c = new AbortController(); c.abort();
    await expect(encryptBackupComponents(f.capture, { ...f, signal: c.signal })).rejects.toThrow('RECOVERY_AGE_CANCELLED');
    await expect(encryptBackupComponents({ ...f.capture, complete: false }, f)).rejects.toThrow('RECOVERY_AGE_CAPTURE');
  });

  it('streams files over 8 MiB into bounded independent chunks and detects changed plaintext', async () => {
    const f = await fixture({ largeAuth: true }), file = f.capture.files.find((file: any) => file.filename === 'auth.json');
    const content = await readFile(join(f.capture.directory, file.filename));
    const { envelope } = await encryptBackupComponents(f.capture, f);
    for (const bytes of f.objects.values()) expect(bytes.length).toBeLessThanOrEqual(8 * 1024 * 1024 + 65536);
    const result = await decrypt(f, envelope);
    expect((await readFile(join(result.directory, 'auth.json'))).equals(content)).toBe(true);
    await writeFile(join(f.capture.directory, file.filename), 'changed');
    await expect(encryptBackupComponents(f.capture, f)).rejects.toThrow('RECOVERY_AGE_PLAINTEXT');
  }, 90000);

  it.each(['r2', 'passwords'] as const)('missing referenced %s material cannot upload or seal', async kind => {
    const f = await fixture({ [kind]: true });
    const removed = f.capture.files.find((file: any) => kind === 'r2' ? file.filename.startsWith('r2-objects/') : file.filename === 'auth-passwords.json');
    expect(removed).toBeDefined();
    f.capture.files = f.capture.files.filter((file: any) => file !== removed);
    await expect(encryptBackupComponents(f.capture, f)).rejects.toThrow('RECOVERY_AGE_INVENTORY');
    expect(f.objects.size).toBe(0);
  });

  it('restores R2 and password material with the full referenced inventory', async () => {
    const f = await fixture({ r2: true, passwords: true });
    const { envelope } = await encryptBackupComponents(f.capture, f);
    const result = await decrypt(f, envelope);
    for (const file of f.capture.files) expect((await readFile(join(result.directory, file.filename))).equals(await readFile(join(f.capture.directory, file.filename)))).toBe(true);
    expect((await verifyD1Backup(result)).r2).toMatchObject({ objects: 1, verified: true });
  }, 90000);

  it('rejects path traversal and a set over 1 GiB before writing any ciphertext', async () => {
    const f = await fixture(), original = f.capture.files[0].filename;
    f.capture.files[0].filename = '../escape.sql';
    await expect(encryptBackupComponents(f.capture, f)).rejects.toThrow('RECOVERY_AGE_INVENTORY');
    f.capture.files[0].filename = original; f.capture.files[0].bytes = 1024 ** 3;
    await expect(encryptBackupComponents(f.capture, f)).rejects.toThrow('RECOVERY_AGE_LIMIT');
    expect(f.objects.size).toBe(0);
  });

  it('cancels a stalled readback without a sealed result', async () => {
    const f = await fixture(), c = new AbortController();
    const destination = { ...f.destination, get: async () => { setTimeout(() => c.abort(), 30); return new Readable({ read() {} }); } };
    await expect(encryptBackupComponents(f.capture, { ...f, destination, signal: c.signal })).rejects.toThrow('RECOVERY_AGE_CANCELLED');
  });

  it('private_paths_and_acl_reject_symlinks, public identity files and modified executables', async () => {
    const f = await fixture();
    const alias = join(f.root, 'alias'); await symlink(f.capture.directory, alias, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(encryptBackupComponents({ ...f.capture, directory: alias }, f)).rejects.toThrow('RECOVERY_AGE_PRIVATE');
    const binary = join(f.root, process.platform === 'win32' ? 'age.exe' : 'age'); await copyFile(agePath, binary); await writeFile(binary, 'bad');
    await expect(verifyAgeBinary(binary)).rejects.toThrow('RECOVERY_AGE_BINARY');
    if (process.platform !== 'win32') {
      await chmod(f.identityFile, 0o644);
    } else {
      execFileSync('icacls', [f.identityFile, '/grant', '*S-1-1-0:(R)'], { windowsHide: true, stdio: 'pipe' });
    }
    const { envelope } = await encryptBackupComponents(f.capture, f);
    await expect(decrypt(f, envelope)).rejects.toThrow('RECOVERY_AGE_PRIVATE');
    expect((await lstat(f.identityFile)).isSymbolicLink()).toBe(false);
  });
});
