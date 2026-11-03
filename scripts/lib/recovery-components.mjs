import { createHash, randomUUID } from 'node:crypto';
import { open, readFile, rm, rmdir } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { canonicalJson, privateDirectory, sha256, writePrivateFile } from './data-migration.mjs';
import { sanitizeBackupSql } from './recovery-backup.mjs';

/** @returns {never} */
const fail = code => { throw new Error(`RECOVERY_${code}`); };
const strict = shape => z.object(shape).strict();
const stamp = z.number().int().nonnegative().safe(), hash = z.string().regex(/^[a-f0-9]{64}$/), text = z.string().min(1).max(512);
const reference = strict({ version: text, sha256: hash, privateSource: text, observedAt: stamp });
const sections = ['providers', 'domains', 'indexes', 'rules', 'wif', 'access', 'bindings', 'flags'];
const configSchema = strict({ formatVersion: z.literal(1), batchId: text, observedAt: stamp, sourceSha: z.string().regex(/^[a-f0-9]{40}$/), imageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  migrations: z.array(strict({ path: text, sha256: hash })).min(1), protocols: strict({ quota: z.literal(2) }),
  sections: strict(Object.fromEntries(sections.map(key => [key, reference]))), requiredSecrets: z.array(text), secrets: z.array(reference.extend({ name: text })), passwordBatch: reference.nullable() });
const passwordSchema = strict({ formatVersion: z.literal(1), observedAt: stamp, hashConfig: reference, users: z.array(strict({ uid: text, passwordHash: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/), passwordSalt: z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/) })) });
const providerSchema = strict({ uid: text, providerId: text, email: z.string().optional(), displayName: z.string().optional(), phoneNumber: z.string().optional(), photoURL: z.string().optional() });
const uidSchema = z.string().min(1).max(128);
const authSchema = strict({ uid: uidSchema, disabled: z.boolean(), email: z.string().optional(), emailVerified: z.boolean().optional(), phoneNumber: z.string().optional(), displayName: z.string().optional(), photoURL: z.string().optional(),
  providerData: z.array(providerSchema), metadata: strict({ creationTime: text, lastSignInTime: text.optional(), lastRefreshTime: text.nullable().optional() }), tokensValidAfterTime: text.nullable(), customClaims: z.record(z.string(), z.unknown()).optional(), observedAt: stamp });
const timeSchema = strict({ startedAt: stamp, completedAt: stamp, recoverableAt: stamp }).refine(t => t.startedAt <= t.recoverableAt && t.recoverableAt <= t.completedAt);
const maxBytes = 1024 ** 3;

function fresh(at, now) { if (!Number.isSafeInteger(at) || at > now || now - at > 86400000) fail('CONFIG_STALE'); }
function checkedConfig(value, source, now) {
  if (!configSchema.safeParse(value).success) fail('CONFIG_INCOMPLETE');
  if (value.sourceSha !== source.sourceSha || canonicalJson(value.migrations) !== canonicalJson(source.migrations)) fail('CONFIG_INCOMPATIBLE');
  const names = value.secrets.map(s => s.name);
  if (new Set(names).size !== names.length || new Set(value.requiredSecrets).size !== value.requiredSecrets.length || canonicalJson([...names].sort()) !== canonicalJson([...value.requiredSecrets].sort())) fail('CONFIG_SECRET_MISSING');
  for (const at of [value.observedAt, ...Object.values(value.sections).map(s => s.observedAt), ...value.secrets.map(s => s.observedAt), ...(value.passwordBatch ? [value.passwordBatch.observedAt] : [])]) fresh(at, now);
  return structuredClone(value);
}

/** @typedef {{directory?:string,complete:boolean,blockers:string[],files?:Array<{filename:string,sha256:string,bytes:number,kind:string}>,snapshotTimes?:Record<string,{startedAt:number,completedAt:number,recoverableAt:number}>}} ComponentCapture */
/** Plaintext staging only, in a new private child; B3 encrypts before any remote persistence.
 * @param {{source:any,auth:any,config:any,directory:string,now?:number|(()=>number),signal?:AbortSignal}} options
 * @returns {Promise<any>}
 */
export async function captureRecoveryComponents({ source, auth, config, directory, now = Date.now, signal }) {
  const clock = typeof now === 'function' ? now : () => now;
  const combined = AbortSignal.any([AbortSignal.timeout(30 * 60 * 1000), ...(signal ? [signal] : [])]);
  let target, parent, objectsDirectory;
  const owned = [], files = [], snapshotTimes = {};
  let total = 0;
  const check = () => { if (combined.aborted) fail('CANCELLED'); };
  const wait = promise => new Promise((resolve, reject) => {
    check(); const abort = () => reject(new Error('RECOVERY_CANCELLED'));
    combined.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => combined.removeEventListener('abort', abort));
  });
  async function save(name, bytes, kind) {
    check(); total += bytes.length; if (total > maxBytes) fail('SIZE_LIMIT');
    owned.push(name); await writePrivateFile(target, name, bytes);
    files.push({ filename: name, sha256: sha256(bytes), bytes: bytes.length, kind });
  }
  async function saveStream(name, stream, kind, limit = maxBytes) {
    if (!stream || typeof stream.getReader !== 'function') fail('STREAM');
    const file = await open(join(target, name), 'wx', 0o600); owned.push(name);
    const reader = stream.getReader(), digest = createHash('sha256'); let bytes = 0;
    try {
      while (true) {
        check(); const chunk = await wait(reader.read()); if (chunk.done) break;
        if (!(chunk.value instanceof Uint8Array)) fail('STREAM');
        bytes += chunk.value.length; total += chunk.value.length;
        if (bytes > limit || total > maxBytes) fail('SIZE_LIMIT');
        digest.update(chunk.value); await file.writeFile(chunk.value);
      }
      const result = { filename: name, sha256: digest.digest('hex'), bytes, kind }; files.push(result); return result;
    } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); await file.close(); }
  }
  try {
    check(); parent = await privateDirectory(directory);
    target = await privateDirectory(join(parent, `capture-${randomUUID()}`), { create: true });
    const initial = checkedConfig(await wait(config.readInventory({ signal: combined })), source, clock());
    const exported = await wait(source.exportSql({ signal: combined }));
    const d1Times = { startedAt: exported.startedAt, completedAt: exported.completedAt, recoverableAt: exported.recoverableAt };
    if (!timeSchema.safeParse(d1Times).success || d1Times.completedAt > clock() || typeof exported.bookmark !== 'string' || !exported.bookmark || exported.bookmark.length > 512) fail('D1_WINDOW');
    snapshotTimes.d1 = d1Times;
    await saveStream('raw.sql', exported.stream, 'temporary');
    let sanitized;
    try {
      // B1 validates in SQLite memory; streamed staging bounds transport, not SQLite's memory footprint.
      sanitized = sanitizeBackupSql({ sql: await readFile(join(target, 'raw.sql')), now: clock(), migrations: source.migrations, sourceSha: source.sourceSha });
    } catch { fail('SQL_INVALID'); }
    await rm(join(target, 'raw.sql')); owned.splice(owned.indexOf('raw.sql'), 1); files.splice(files.findIndex(f => f.filename === 'raw.sql'), 1);
    await save('sarin-bot-data.sql', sanitized.sql, 'd1');
    await save('export-manifest.json', Buffer.from(canonicalJson(sanitized.exportManifest)), 'd1');
    const r2Start = clock();
    if (sanitized.r2Manifest.references.length) objectsDirectory = await privateDirectory(join(target, 'r2-objects'), { create: true });
    for (const r of sanitized.r2Manifest.references) {
      const object = await wait(source.readObject(r, { signal: combined }));
      if (!object || object.contentType !== r.contentType) { void object?.stream?.cancel().catch(() => {}); fail('R2_MISSING_OR_TYPE'); }
      const duplicate = files.some(f => f.filename === `r2-objects/${r.sha256}`);
      const filename = duplicate ? `r2-check-${randomUUID()}` : `r2-objects/${r.sha256}`;
      const copied = await saveStream(filename, object.stream, 'r2', r.byteLength);
      if (copied.bytes !== r.byteLength || copied.sha256 !== r.sha256) fail('R2_HASH');
      if (duplicate) { await rm(join(target, filename)); owned.splice(owned.indexOf(filename), 1); files.splice(files.indexOf(copied), 1); }
    }
    await save('r2-backup-manifest.json', Buffer.from(canonicalJson(sanitized.r2Manifest)), 'r2');
    snapshotTimes.r2 = { startedAt: r2Start, completedAt: clock(), recoverableAt: r2Start };
    const authStart = clock(), users = [], uids = new Set(), tokens = new Set(), passwords = new Set(); let token;
    do {
      const page = await wait(auth.listUsers(1000, token));
      if (!page || !Array.isArray(page.users) || page.users.length > 1000 || page.pageToken !== undefined && (typeof page.pageToken !== 'string' || !page.pageToken || page.pageToken.length > 8192)) fail('AUTH_PAGE');
      for (const user of page.users) {
        const candidate = Object.fromEntries(Object.keys(authSchema.shape).filter(key => key !== 'observedAt' && user[key] !== undefined).map(key => [key, user[key]]));
        candidate.observedAt = clock();
        candidate.tokensValidAfterTime ??= null;
        const parsed = authSchema.safeParse(candidate);
        if (!parsed.success || uids.has(user.uid) || candidate.tokensValidAfterTime !== null && !Number.isFinite(Date.parse(candidate.tokensValidAfterTime)) || !Number.isFinite(Date.parse(user.metadata?.creationTime))) fail('AUTH_USER');
        uids.add(user.uid); users.push(parsed.data);
        if (user.providerData.some(p => p.providerId === 'password')) passwords.add(user.uid);
      }
      token = page.pageToken;
      if (token && (tokens.has(token) || page.users.length === 0)) fail('AUTH_PAGE_REPEATED');
      if (token) tokens.add(token);
      if (Buffer.byteLength(canonicalJson(users)) + total > maxBytes) fail('SIZE_LIMIT');
    } while (token);
    let authRecoverableAt = authStart;
    if (passwords.size) {
      if (!initial.passwordBatch || typeof auth.readPasswordBatch !== 'function') fail('AUTH_PASSWORD_MATERIAL_MISSING');
      const bytes = await wait(auth.readPasswordBatch(initial.passwordBatch, { signal: combined }));
      if (!(bytes instanceof Uint8Array) || bytes.length > maxBytes || sha256(bytes) !== initial.passwordBatch.sha256) fail('AUTH_PASSWORD_MATERIAL_MISSING');
      let batch; try { batch = passwordSchema.parse(JSON.parse(Buffer.from(bytes).toString('utf8'))); } catch { fail('AUTH_PASSWORD_MATERIAL_MISSING'); }
      fresh(batch.observedAt, clock()); fresh(batch.hashConfig.observedAt, clock());
      authRecoverableAt = Math.min(authStart, initial.passwordBatch.observedAt, batch.observedAt, batch.hashConfig.observedAt);
      const base64 = value => Buffer.from(value, 'base64').toString('base64') === value;
      if (new Set(batch.users.map(u => u.uid)).size !== batch.users.length || batch.users.length !== passwords.size || batch.users.some(u => !passwords.has(u.uid) || !base64(u.passwordHash) || Buffer.from(u.passwordHash, 'base64').length === 0 || !base64(u.passwordSalt))) fail('AUTH_PASSWORD_MATERIAL_MISSING');
      await save('auth-passwords.json', Buffer.from(bytes), 'auth');
    }
    const authComplete = clock(); snapshotTimes.auth = { startedAt: authRecoverableAt, completedAt: authComplete, recoverableAt: authRecoverableAt };
    const authBatchId = randomUUID();
    await save('auth.json', Buffer.from(canonicalJson({ formatVersion: 1, batchId: authBatchId, requiresNewLogin: true, grantsAuthority: false, users })), 'auth');
    const latest = checkedConfig(await wait(config.readInventory({ signal: combined })), source, clock());
    if (canonicalJson(initial) !== canonicalJson(latest)) fail('CONFIG_CHANGED');
    snapshotTimes.config = { startedAt: initial.observedAt, completedAt: clock(), recoverableAt: Math.min(initial.observedAt, ...Object.values(initial.sections).map(s => s.observedAt), ...initial.secrets.map(s => s.observedAt)) };
    snapshotTimes.config.startedAt = snapshotTimes.config.recoverableAt;
    await save('config.json', Buffer.from(canonicalJson(initial)), 'config'); check();
    const batches = { auth: { batchId: authBatchId, sha256: files.find(f => f.filename === 'auth.json').sha256 },
      config: { batchId: initial.batchId, sha256: files.find(f => f.filename === 'config.json').sha256, passwordSha256: initial.passwordBatch?.sha256 ?? null } };
    return { complete: true, blockers: [], directory: target, files, snapshotTimes, batches, bookmark: exported.bookmark, sanitization: sanitized.sanitization, r2References: sanitized.r2Manifest.references };
  } catch (error) {
    if (target) {
      if (dirname(resolve(target)) !== resolve(parent) || !/^capture-[a-f0-9-]+$/.test(basename(target))) fail('CLEANUP_PATH');
      for (const name of owned) await rm(join(target, name), { force: true });
      if (objectsDirectory) await rmdir(objectsDirectory);
      await rmdir(target);
    }
    const code = /^RECOVERY_([A-Z0-9_]+)$/.exec(error?.message ?? '')?.[1] ?? (combined.aborted ? 'CANCELLED' : 'CAPTURE_FAILED');
    return { complete: false, blockers: [code] };
  }
}
