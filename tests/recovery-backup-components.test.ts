import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { captureRecoveryComponents } from '../scripts/lib/recovery-components.mjs';
import { d1SqlExporter } from '../scripts/cloudflare-data-migration.mjs';
import { sha256 } from '../scripts/lib/data-migration.mjs';
import { recoveryNow as now, recoverySha, recoveryMigrations, recoverySql } from './recovery-backup-fixtures';

const roots: string[] = [];
const fault = vi.hoisted(() => ({ partialWrite: false }));
vi.mock('../scripts/lib/data-migration.mjs', async importOriginal => {
  const original = await importOriginal<typeof import('../scripts/lib/data-migration.mjs')>();
  return { ...original, writePrivateFile: async (directory: string, name: string, bytes: Uint8Array) => {
    if (fault.partialWrite && name === 'sarin-bot-data.sql') { await writeFile(join(directory, name), bytes.subarray(0, 10), { flag: 'wx', mode: 0o600 }); throw Object.assign(new Error('synthetic disk full'), { code: 'ENOSPC' }); }
    return original.writePrivateFile(directory, name, bytes);
  } };
});
afterEach(async () => { for (const root of roots.splice(0)) { expect(dirname(resolve(root))).toBe(resolve(tmpdir())); expect(basename(root)).toMatch(/^sarin-components-/); await rm(root, { recursive: true, force: true }); } });
const stream = (value: Uint8Array) => new ReadableStream({ start(c) { c.enqueue(value.subarray(0, 10)); c.enqueue(value.subarray(10)); c.close(); } });
const ref = () => ({ version: 'demo-v1', sha256: 'a'.repeat(64), privateSource: 'operator-vault/demo', observedAt: now });
export function componentConfig() {
  return { formatVersion: 1, batchId: 'demo-config', observedAt: now, sourceSha: recoverySha, imageDigest: 'sha256:' + 'b'.repeat(64), migrations: recoveryMigrations, protocols: { quota: 2 },
    sections: Object.fromEntries(['providers', 'domains', 'indexes', 'rules', 'wif', 'access', 'bindings', 'flags'].map(k => [k, ref()])), requiredSecrets: ['DEMO_SECRET'], secrets: [{ name: 'DEMO_SECRET', ...ref() }], passwordBatch: null };
}
const user = (uid = 'demo-user') => ({ uid, disabled: true, email: 'demo@example.invalid', emailVerified: false, providerData: [{ uid, providerId: 'google.com', email: 'demo@example.invalid' }], metadata: { creationTime: new Date(now - 1000).toUTCString(), lastSignInTime: new Date(now - 500).toUTCString() }, tokensValidAfterTime: new Date(now).toUTCString(), customClaims: { role: 'owner' }, refreshToken: 'DO_NOT_COPY' });
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'sarin-components-')); roots.push(directory);
  const inventory: any = componentConfig();
  const source: any = { sourceSha: recoverySha, migrations: recoveryMigrations, exportSql: async () => ({ stream: stream(recoverySql()), bookmark: 'demo-bookmark', startedAt: now - 1000, completedAt: now, recoverableAt: now - 1000 }), readObject: async () => { throw Error('Unexpected R2 read'); } };
  const auth: any = { listUsers: async () => ({ users: [user()] }) };
  return { source, auth, config: { readInventory: async () => structuredClone(inventory) }, inventory, directory, now: () => now };
}

describe('component capture', () => {
  it('captures separate windows, sanitized SQL and non-granting Auth inventory', async () => {
    const f = await fixture(), result = await captureRecoveryComponents(f);
    expect(result.complete).toBe(true); expect(result.blockers).toEqual([]);
    expect(result.snapshotTimes.d1).toEqual({ startedAt: now - 1000, completedAt: now, recoverableAt: now - 1000 });
    expect(result.bookmark).toBe('demo-bookmark'); expect(result.sanitization.d1Revision).toBe(7);
    const auth = JSON.parse(await readFile(join(result.directory, 'auth.json'), 'utf8'));
    expect(auth.grantsAuthority).toBe(false); expect(auth.requiresNewLogin).toBe(true);
    expect(auth.users[0]).toMatchObject({ uid: 'demo-user', disabled: true, tokensValidAfterTime: new Date(now).toUTCString(), observedAt: now, customClaims: { role: 'owner' } });
    expect(JSON.stringify(auth)).not.toContain('DO_NOT_COPY');
    for (const file of result.files) expect(sha256(await readFile(join(result.directory, file.filename)))).toBe(file.sha256);
  });
  it('sql_export_is_not_logical_json and failed capture leaves no artifacts', async () => {
    const f = await fixture(); f.source.exportSql = async () => ({ stream: stream(Buffer.from('{"documents":[]}')), bookmark: 'demo', startedAt: now, completedAt: now, recoverableAt: now });
    const r = await captureRecoveryComponents(f); expect(r.complete).toBe(false); expect(r.blockers).toContain('SQL_INVALID'); expect(await readdir(f.directory)).toEqual([]);
  });
  it('auth_1001_disabled_revoked_and_duplicate_pages', async () => {
    const f = await fixture();
    f.auth.listUsers = async (size: number, token?: string) => { expect(size).toBe(1000); if (!token) return { users: Array.from({ length: 1000 }, (_, i) => user(`demo-${i}`)), pageToken: 'next' }; expect(token).toBe('next'); return { users: [user('demo-last')] }; };
    const r = await captureRecoveryComponents(f); expect(r.complete).toBe(true);
    expect(JSON.parse(await readFile(join(r.directory, 'auth.json'), 'utf8')).users).toHaveLength(1001);
    for (const kind of ['token', 'uid', 'error']) {
      f.auth.listUsers = async (_: number, token?: string) => { if (kind === 'error') throw Error('PRIVATE_AUTH_ERROR'); return { users: [user(kind === 'uid' ? 'duplicate' : token ?? 'first')], pageToken: token ? (kind === 'token' ? 'next' : undefined) : 'next' }; };
      const bad = await captureRecoveryComponents(f); expect(bad.complete).toBe(false); expect(JSON.stringify(bad)).not.toContain('PRIVATE_AUTH_ERROR');
    }
  });
  it.each(['secret', 'old', 'unknown', 'missing', 'changed', 'sha'])('config %s cannot produce an integral capture', async kind => {
    const f = await fixture();
    if (kind === 'secret') f.inventory.secrets = [];
    if (kind === 'old') f.inventory.sections.rules.observedAt = now - 86400001;
    if (kind === 'unknown') f.inventory.env = { SECRET_VALUE: 'DO_NOT_COPY' };
    if (kind === 'missing') delete f.inventory.sections.access;
    if (kind === 'sha') f.inventory.sourceSha = 'f'.repeat(40);
    if (kind === 'changed') { let reads = 0; f.config.readInventory = async () => ({ ...f.inventory, batchId: ++reads === 1 ? 'first' : 'second' }); }
    const r = await captureRecoveryComponents(f); expect(r.complete).toBe(false); expect(JSON.stringify(r)).not.toContain('DO_NOT_COPY');
  });
  it('password users require fresh operator batch and hash configuration, never runtime IAM changes', async () => {
    const f = await fixture(); f.auth.listUsers = async () => ({ users: [{ ...user(), providerData: [{ uid: 'demo-user', providerId: 'password' }] }] });
    expect((await captureRecoveryComponents(f)).blockers).toContain('AUTH_PASSWORD_MATERIAL_MISSING');
    const batch = { formatVersion: 1, observedAt: now, hashConfig: ref(), users: [{ uid: 'demo-user', passwordHash: 'ZGVtby1oYXNo', passwordSalt: 'ZGVtbw==' }] };
    f.inventory.passwordBatch = { ...ref(), sha256: sha256(JSON.stringify(batch)) };
    f.auth.readPasswordBatch = async () => Buffer.from(JSON.stringify(batch));
    expect((await captureRecoveryComponents(f)).complete).toBe(true);
    batch.users[0].uid = 'other';
    expect((await captureRecoveryComponents(f)).complete).toBe(false);
  });
  it('uses the oldest password material for Auth age, not the time of listing users', async () => {
    const f = await fixture(); f.auth.listUsers = async () => ({ users: [{ ...user(), providerData: [{ uid: 'demo-user', providerId: 'password' }] }] });
    const batch = { formatVersion: 1, observedAt: now - 2000, hashConfig: { ...ref(), observedAt: now - 3000 }, users: [{ uid: 'demo-user', passwordHash: 'ZGVtbw==', passwordSalt: '' }] };
    f.inventory.passwordBatch = { ...ref(), observedAt: now - 1000, sha256: sha256(JSON.stringify(batch)) }; f.auth.readPasswordBatch = async () => Buffer.from(JSON.stringify(batch));
    const r = await captureRecoveryComponents(f); expect(r.complete).toBe(true); expect(r.snapshotTimes.auth.recoverableAt).toBe(now - 3000);
  });
  it('cleans a partial private write when storage fills, without exposing the error', async () => {
    const f = await fixture(); fault.partialWrite = true;
    try { expect((await captureRecoveryComponents(f)).blockers).toEqual(['CAPTURE_FAILED']); expect(await readdir(f.directory)).toEqual([]); }
    finally { fault.partialWrite = false; }
  });
  it('invalid base64 cannot be accepted as password recovery material', async () => {
    const f = await fixture(); f.auth.listUsers = async () => ({ users: [{ ...user(), providerData: [{ uid: 'demo-user', providerId: 'password' }] }] });
    const batch = { formatVersion: 1, observedAt: now, hashConfig: ref(), users: [{ uid: 'demo-user', passwordHash: 'A', passwordSalt: '' }] };
    f.inventory.passwordBatch = { ...ref(), sha256: sha256(JSON.stringify(batch)) }; f.auth.readPasswordBatch = async () => Buffer.from(JSON.stringify(batch));
    expect((await captureRecoveryComponents(f)).blockers).toContain('AUTH_PASSWORD_MATERIAL_MISSING');
  });
  it('copies both R2 keys when two supported namespaces reference identical bytes', async () => {
    const f = await fixture(), bytes = Buffer.from('RIFFdemofileWEBP'), digest = sha256(bytes);
    const logo = { key: `business-logos/${digest}`, sha256: digest, byteLength: bytes.length, contentType: 'image/webp' }, payment = { ...logo, key: `payment-images/${digest}` };
    f.source.exportSql = async () => ({ stream: stream(recoverySql([{ path: `businessLogos/demo_${digest}`, data: { businessId: 'demo', ownerUid: 'demo-owner', createdAt: now, sha256: digest }, blob: logo }, { path: 'paymentImages/demo-payment', data: { ownerUid: 'demo-owner', createdAt: now }, blob: payment }])), bookmark: 'demo', startedAt: now, completedAt: now, recoverableAt: now });
    f.source.readObject = async () => ({ stream: stream(bytes), contentType: 'image/webp' });
    const r = await captureRecoveryComponents(f); expect(r.blockers).toEqual([]); expect(r.r2References).toHaveLength(2);
  });
  it('rejects aborts, oversized streams and windows from the future; cleans only its new staging directory', async () => {
    const f = await fixture(); const controller = new AbortController(); controller.abort();
    expect((await captureRecoveryComponents({ ...f, signal: controller.signal })).blockers).toEqual(['CANCELLED']);
    const original = f.source.exportSql;
    f.source.exportSql = async () => ({ ...await original(), completedAt: now + 1 });
    expect((await captureRecoveryComponents(f)).blockers).toEqual(['D1_WINDOW']);
    f.source.exportSql = async () => ({ ...await original(), stream: new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(8 * 1024 * 1024)); } }) });
    expect((await captureRecoveryComponents(f)).blockers).toEqual(['SIZE_LIMIT']);
    expect(await readdir(f.directory)).toEqual([]);
  }, 60000);
  it.each(['missing', 'bytes', 'type', 'size'])('missing_changed_r2_blocks_capture: %s', async kind => {
    const f = await fixture(), bytes = Buffer.from('RIFFdemofileWEBP'), digest = sha256(bytes);
    const reference = { key: `business-logos/${digest}`, sha256: digest, byteLength: bytes.length, contentType: 'image/webp' };
    f.source.exportSql = async () => ({ stream: stream(recoverySql([{ path: `businessLogos/demo_${digest}`, data: { businessId: 'demo', ownerUid: 'demo-owner', createdAt: now, sha256: digest }, blob: reference }])), bookmark: 'demo', startedAt: now, completedAt: now, recoverableAt: now });
    f.source.readObject = async (r: unknown) => { expect(r).toEqual(reference); return kind === 'missing' ? null : { stream: stream(kind === 'bytes' ? Buffer.alloc(bytes.length) : kind === 'size' ? bytes.subarray(1) : bytes), contentType: kind === 'type' ? 'image/png' : 'image/webp' }; };
    expect((await captureRecoveryComponents(f)).complete).toBe(false);
    f.source.readObject = async () => ({ stream: stream(bytes), contentType: 'image/webp' });
    const r = await captureRecoveryComponents(f); expect(r.complete).toBe(true); expect(r.r2References).toEqual([reference]);
    const manifest = JSON.parse(await readFile(join(r.directory, 'r2-backup-manifest.json'), 'utf8')); expect(manifest.sourceSqlSha256).toBe(r.sanitization.sqlSha256);
  });
});

describe('D1 SQL export HTTP adapter', () => {
  const endpoint = 'https://api.cloudflare.com/client/v4/accounts/' + 'a'.repeat(32) + '/d1/database/11111111-1111-4111-8111-111111111111/export';
  const downloadOrigin = 'https://demo-export.r2.cloudflarestorage.com';
  it('polling_keeps_bookmark_and_bounds without forwarding credentials to the download', async () => {
    const bodies: any[] = []; let polls = 0;
    const exporter = d1SqlExporter({ endpoint, downloadOrigin, tokenSupplier: () => 'SECRET', now: () => now, wait: async () => {}, fetchImpl: async (url: string, options: any) => {
      expect(options.redirect).toBe('error');
      if (url === endpoint) { bodies.push(JSON.parse(options.body)); expect(options.headers.Authorization).toBe('Bearer SECRET'); return Response.json({ success: true, result: { at_bookmark: 'bm', ...(++polls === 2 ? { status: 'complete', result: { signed_url: `${downloadOrigin}/demo.sql?private=yes` } } : {}) } }); }
      expect(url).toBe(`${downloadOrigin}/demo.sql?private=yes`); expect(options.headers).toBeUndefined(); return new Response(recoverySql());
    } });
    const r = await exporter.exportSql({}); expect(r.bookmark).toBe('bm'); expect(bodies).toEqual([{ output_format: 'polling' }, { output_format: 'polling', current_bookmark: 'bm' }]);
    expect(await new Response(r.stream).text()).toContain('CREATE TABLE');
  });
  it.each(['error', 'timeout', 'url', 'bookmark', 'redirect', 'network', 'oversized'])('rejects %s with a safe code', async kind => {
    let n = 0;
    const exporter = d1SqlExporter({ endpoint, downloadOrigin, tokenSupplier: () => 'SECRET', now: () => now, wait: async () => {}, maxPolls: 2, fetchImpl: async (url: string) => {
      if (kind === 'network') throw Error('https://private/?token=SECRET');
      if (kind === 'oversized') return new Response(JSON.stringify({ success: true, padding: 'x'.repeat(1024 * 1024), result: { at_bookmark: 'bm', status: 'complete', result: { signed_url: downloadOrigin + '/demo.sql' } } }));
      if (url !== endpoint) return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1' } });
      n++;
      return Response.json({ success: true, result: { at_bookmark: kind === 'bookmark' && n === 2 ? 'changed' : 'bm', ...(kind === 'error' ? { status: 'error', error: 'PRIVATE' } : kind === 'timeout' || kind === 'bookmark' && n === 1 ? {} : { status: 'complete', result: { signed_url: kind === 'url' ? 'https://evil.invalid/private?SECRET' : downloadOrigin + '/demo.sql' } }) } });
    } });
    await expect(exporter.exportSql({})).rejects.toThrow(/^RECOVERY_/);
  });
});
