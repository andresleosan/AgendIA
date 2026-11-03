import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open, readFile, rm, rmdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import { canonicalJson, privateDirectory, resolveBackupDirectory, sha256 } from './data-migration.mjs';
import { validateBackupManifest } from './recovery-backup.mjs';

const lock = JSON.parse(await readFile(new URL('./recovery-age.lock.json', import.meta.url), 'utf8'));
const CHUNK = 8 * 1024 * 1024, CIPHER = CHUNK + 65536, MAX = 1024 ** 3;
const kinds = ['d1', 'r2', 'auth', 'config'];
const hash = z.string().regex(/^[a-f0-9]{64}$/), uuid = z.string().uuid();
const strict = shape => z.object(shape).strict();
const count = z.number().int().nonnegative().safe();
const objectSchema = strict({ id: uuid, sha256: hash, bytes: count.min(1).max(CIPHER) });
const chunkSchema = objectSchema.extend({ plaintextSha256: hash, plaintextBytes: count.max(CHUNK) });
const filename = z.string().regex(/^(sarin-bot-data\.sql|export-manifest\.json|r2-backup-manifest\.json|auth\.json|auth-passwords\.json|config\.json|r2-objects\/[a-f0-9]{64})$/);
const fileSchema = strict({ filename, kind: z.enum(kinds), sha256: hash, bytes: count.max(MAX), chunks: z.array(chunkSchema).min(1).max(16384) });
const batchSchema = strict({ batchId: z.string().min(1).max(128), sha256: hash });
const batchesSchema = strict({ auth: batchSchema, config: batchSchema.extend({ passwordSha256: hash.nullable() }) });
const archiveSchema = strict({ formatVersion: z.literal(1), manifest: z.unknown(), passwordSha256: hash.nullable(), files: z.array(fileSchema).min(5).max(16384) });
const envelopeSchema = strict({ formatVersion: z.literal(1), backupId: uuid, createdAt: count, sealedAt: count, status: z.literal('sealed'), keyId: hash,
  manifest: objectSchema, objects: z.array(objectSchema).min(1).max(65536) }).refine(e => e.createdAt <= e.sealedAt);
/** @returns {never} */
const fail = code => { throw new Error(`RECOVERY_AGE_${code}`); };
const descriptor = chunk => ({ id: chunk.id, sha256: chunk.sha256, bytes: chunk.bytes });
/** @typedef {{id:string,sha256:string,bytes:number}} CiphertextObject */
/** @typedef {{formatVersion:1,backupId:string,createdAt:number,sealedAt:number,status:'sealed',keyId:string,manifest:CiphertextObject,objects:CiphertextObject[]}} BackupEnvelope */

function context(signal) {
  const combined = AbortSignal.any([AbortSignal.timeout(30 * 60 * 1000), ...(signal ? [signal] : [])]);
  const check = () => { if (combined.aborted) fail('CANCELLED'); };
  const wait = promise => new Promise((resolve, reject) => {
    check(); const abort = () => reject(new Error('RECOVERY_AGE_CANCELLED'));
    combined.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => combined.removeEventListener('abort', abort));
  });
  return { signal: combined, check, wait };
}
/** @returns {never} */
function safeError(error, ctx) {
  if (ctx.signal.aborted) fail('CANCELLED');
  if (/^RECOVERY_AGE_[A-Z_]+$/.test(error?.message)) throw error;
  fail('FAILED');
}
async function noLinks(path) {
  if (typeof path !== 'string' || !isAbsolute(path)) fail('PRIVATE');
  let part = resolve(path);
  for (;;) {
    try { if ((await lstat(part)).isSymbolicLink()) fail('PRIVATE'); }
    catch (e) { if (e.code !== 'ENOENT') fail('PRIVATE'); }
    if (dirname(part) === part) break;
    part = dirname(part);
  }
}
async function privateRoot(path, create = false) {
  await noLinks(path);
  try { return await privateDirectory(path, { create }); } catch { fail('PRIVATE'); }
}
async function privateFile(path) {
  await noLinks(path);
  try {
    await resolveBackupDirectory(path);
    const info = await lstat(path);
    if (!info.isFile() || info.nlink !== 1) fail('PRIVATE');
    if (process.platform === 'win32') {
      const encoded = Buffer.from(path).toString('base64');
      const command = `$ErrorActionPreference='Stop'; $p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')); $u=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $f=New-Object IO.FileInfo($p); $a=$f.GetAccessControl([Security.AccessControl.AccessControlSections]::Access -bor [Security.AccessControl.AccessControlSections]::Owner); if($a.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $u){exit 1}; foreach($r in $a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){if($r.AccessControlType -eq 'Allow' -and $r.IdentityReference.Value -notin @($u,'S-1-5-18')){exit 1}}`;
      execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, stdio: 'pipe' });
    } else if ((info.mode & 0o077) !== 0 || info.uid !== process.getuid()) fail('PRIVATE');
    const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await file.stat();
    if (opened.ino !== info.ino || opened.dev !== info.dev || opened.size > MAX) { await file.close(); fail('PRIVATE'); }
    return file;
  } catch { fail('PRIVATE'); }
}

/** No PATH lookup, plugins or on-demand download. A different architecture needs a reviewed pin. */
export async function verifyAgeBinary(agePath) {
  const pin = lock.platforms[`${process.platform}-${process.arch}`];
  try {
    if (!pin || !isAbsolute(agePath)) fail('BINARY');
    await noLinks(agePath);
    const info = await lstat(agePath);
    if (!info.isFile() || info.size > 64 * 1024 * 1024 || sha256(await readFile(agePath)) !== pin.binarySha256) fail('BINARY');
  } catch { fail('BINARY'); }
}

async function collect(stream, limit, ctx) {
  if (!stream) fail('READBACK');
  const readable = typeof stream.getReader === 'function' ? Readable.fromWeb(stream) : stream;
  if (!readable[Symbol.asyncIterator]) fail('READBACK');
  const iterator = readable[Symbol.asyncIterator](), chunks = []; let total = 0;
  try {
    for (;;) {
      const next = await ctx.wait(iterator.next()); if (next.done) break;
      if (!(next.value instanceof Uint8Array)) fail('READBACK');
      total += next.value.length; if (total > limit) fail('READBACK');
      chunks.push(Buffer.from(next.value));
    }
    return Buffer.concat(chunks, total);
  } finally { readable.destroy?.(); void iterator.return?.().catch(() => {}); }
}
async function age(agePath, args, bytes, ctx, decrypt = false) {
  ctx.check();
  const child = spawn(agePath, args, { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], signal: ctx.signal });
  child.stderr.resume(); // age diagnostics may contain private paths; never forward them.
  const done = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => code === 0 ? resolve(null) : reject(Error('age failed'))); });
  try {
    const [, result] = await Promise.all([pipeline(Readable.from([bytes]), child.stdin, { signal: ctx.signal }), collect(child.stdout, decrypt ? CHUNK : CIPHER, ctx), done]);
    return result;
  } catch { if (ctx.signal.aborted) fail('CANCELLED'); fail(decrypt ? 'DECRYPT' : 'ENCRYPT'); }
  finally { if (child.exitCode === null) child.kill(); }
}
async function readback(source, entry, ctx) {
  const bytes = await collect(await ctx.wait(source.get(entry.id, { signal: ctx.signal })), entry.bytes, ctx);
  if (bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256) fail('READBACK');
  return bytes;
}
function validateFiles(files, references, passwordSha256) {
  if (!Array.isArray(files) || files.length > 16384 || new Set(files.map(f => f.filename)).size !== files.length) fail('INVENTORY');
  const required = { 'sarin-bot-data.sql': 'd1', 'export-manifest.json': 'd1', 'r2-backup-manifest.json': 'r2', 'auth.json': 'auth', 'config.json': 'config', 'auth-passwords.json': 'auth' };
  for (const file of files) {
    if (!filename.safeParse(file.filename).success || file.kind !== (required[file.filename] ?? 'r2') || !hash.safeParse(file.sha256).success || !count.max(MAX).safeParse(file.bytes).success) fail('INVENTORY');
  }
  for (const name of Object.keys(required).filter(n => n !== 'auth-passwords.json')) if (!files.some(f => f.filename === name)) fail('INVENTORY');
  if (!Array.isArray(references)) fail('INVENTORY');
  const objects = new Map();
  for (const ref of references) {
    if (!hash.safeParse(ref.sha256).success || !count.safeParse(ref.byteLength).success) fail('INVENTORY');
    const key = `r2-objects/${ref.sha256}`, file = files.find(f => f.filename === key);
    if (!file || file.sha256 !== ref.sha256 || file.bytes !== ref.byteLength) fail('INVENTORY');
    objects.set(key, file);
  }
  if (files.filter(f => f.filename.startsWith('r2-objects/')).length !== objects.size) fail('INVENTORY');
  const password = files.find(f => f.filename === 'auth-passwords.json');
  if (passwordSha256 ? password?.sha256 !== passwordSha256 : password) fail('INVENTORY');
  if (files.reduce((sum, f) => sum + f.bytes, 0) > MAX) fail('LIMIT');
}
function summaries() {
  return Object.fromEntries(kinds.map(kind => [kind, { id: randomUUID(), kind, ciphertextSha256: '', bytes: 0, plaintextSha256: '', classification: 'private' }]));
}
function makeManifest(capture, files, components, backupId) {
  const proof = capture.sanitization;
  components.d1.plaintextSha256 = files.find(f => f.filename === 'sarin-bot-data.sql').sha256;
  components.auth.plaintextSha256 = files.find(f => f.filename === 'auth.json').sha256;
  components.config.plaintextSha256 = files.find(f => f.filename === 'config.json').sha256;
  components.r2.plaintextSha256 = sha256(canonicalJson(capture.r2References));
  return validateBackupManifest({ formatVersion: 1, backupId, sourceSha: proof.sourceSha, migrations: proof.migrations, protocols: proof.protocols, snapshotTimes: capture.snapshotTimes,
    d1Revision: proof.d1Revision, components: Object.values(components), r2References: capture.r2References, exclusionVersion: 1, sanitization: proof,
    auth: { complete: true, batchId: capture.batches.auth.batchId, sha256: components.auth.plaintextSha256 }, config: { complete: true, batchId: capture.batches.config.batchId, sha256: components.config.plaintextSha256 } },
  { sourceSha: proof.sourceSha, migrations: proof.migrations, protocols: proof.protocols });
}

/** @param {import('./recovery-components.mjs').ComponentCapture | any} capture
 * @param {{agePath:string,recipient:string,destination:any,signal?:AbortSignal}} options
 * @returns {Promise<{manifest:import('./recovery-backup.mjs').BackupManifestV1,envelope:BackupEnvelope}>} */
export async function encryptBackupComponents(capture, { agePath, recipient, destination, signal }) {
  const ctx = context(signal);
  try {
    ctx.check(); if (!capture?.complete || capture.blockers?.length || !capture.sanitization) fail('CAPTURE');
    if (!/^age1[0-9a-z]{58}$/.test(recipient)) fail('RECIPIENT');
    await verifyAgeBinary(agePath); const root = await privateRoot(capture.directory);
    if (!batchesSchema.safeParse(capture.batches).success) fail('CAPTURE');
    validateFiles(capture.files, capture.r2References, capture.batches.config.passwordSha256);
    for (const [kind, name] of [['auth', 'auth.json'], ['config', 'config.json']]) if (capture.batches[kind].sha256 !== capture.files.find(f => f.filename === name).sha256) fail('INVENTORY');
    const backupId = randomUUID(), createdAt = Date.now(), files = [], objects = [], components = summaries();
    const digests = Object.fromEntries(kinds.map(kind => [kind, createHash('sha256')]));
    async function store(plain) {
      const cipher = await age(agePath, ['--encrypt', '--recipient', recipient], plain, ctx);
      const entry = { id: randomUUID(), sha256: sha256(cipher), bytes: cipher.length };
      await ctx.wait(destination.putIfAbsent(entry.id, Readable.from([cipher]), { signal: ctx.signal }));
      await readback(destination, entry, ctx);
      return { cipher, entry };
    }
    for (const input of capture.files) {
      ctx.check(); const path = join(root, input.filename);
      const handle = await privateFile(path), digest = createHash('sha256'), chunks = []; let total = 0;
      try {
        do {
          const buffer = Buffer.alloc(CHUNK); let length = 0;
          while (length < CHUNK) { ctx.check(); const { bytesRead } = await handle.read(buffer, length, CHUNK - length, null); if (!bytesRead) break; length += bytesRead; }
          if (!length && chunks.length) break;
          const plain = buffer.subarray(0, length); total += length;
          if (total > input.bytes) fail('PLAINTEXT');
          digest.update(plain);
          const { cipher, entry } = await store(plain);
          chunks.push({ ...entry, plaintextSha256: sha256(plain), plaintextBytes: length }); objects.push(entry);
          digests[input.kind].update(cipher); components[input.kind].bytes += cipher.length;
          if (!length) break;
        } while (true);
      } finally { await handle.close(); }
      if (total !== input.bytes || digest.digest('hex') !== input.sha256) fail('PLAINTEXT');
      files.push({ ...input, chunks });
    }
    for (const kind of kinds) components[kind].ciphertextSha256 = digests[kind].digest('hex');
    const manifest = makeManifest(capture, files, components, backupId);
    const internal = Buffer.from(canonicalJson({ formatVersion: 1, manifest, passwordSha256: capture.batches.config.passwordSha256, files })); if (internal.length > CHUNK) fail('LIMIT');
    const { entry } = await store(internal);
    ctx.check();
    return { manifest, envelope: { formatVersion: 1, backupId, createdAt, sealedAt: Date.now(), status: 'sealed', keyId: sha256(recipient), manifest: entry, objects } };
  } catch (e) { return safeError(e, ctx); }
}

/** Only creates a new closed local directory. Restoring bytes does not restore authority or effects.
 * @param {{envelope:any,source:any,agePath:string,identityFile:string,directory:string,expected:any,signal?:AbortSignal}} options
 * @returns {Promise<{directory:string,manifest:import('./recovery-backup.mjs').BackupManifestV1,expected:any}>} */
export async function decryptBackupSet({ envelope, source, agePath, identityFile, directory, expected, signal }) {
  const ctx = context(signal); let target, objectRoot; const owned = [];
  try {
    ctx.check(); if (!envelopeSchema.safeParse(envelope).success) fail('ENVELOPE');
    const ids = [envelope.manifest.id, ...envelope.objects.map(o => o.id)]; if (new Set(ids).size !== ids.length) fail('ENVELOPE');
    if (envelope.objects.reduce((sum, o) => sum + o.bytes, 0) > MAX + 65536 * envelope.objects.length) fail('LIMIT');
    await verifyAgeBinary(agePath);
    const key = await privateFile(identityFile);
    try {
      if ((await key.stat()).size > 65536) fail('PRIVATE');
      const text = (await key.readFile('utf8')).split(/\r?\n/).filter(line => line && !line.startsWith('#'));
      if (text.length !== 1 || !/^AGE-SECRET-KEY-1[0-9A-Z]{58}$/.test(text[0])) fail('PRIVATE');
    } finally { await key.close(); }
    const root = await privateRoot(directory);
    const plain = await age(agePath, ['--decrypt', '--identity', identityFile], await readback(source, envelope.manifest, ctx), ctx, true);
    let archive;
    try { archive = JSON.parse(plain.toString('utf8')); } catch { fail('INVENTORY'); }
    if (!archiveSchema.safeParse(archive).success) fail('INVENTORY');
    if (expected.backupId && expected.backupId !== envelope.backupId) fail('INVENTORY');
    const manifest = validateBackupManifest(archive.manifest, { ...expected, backupId: envelope.backupId });
    validateFiles(archive.files, manifest.r2References, archive.passwordSha256);
    const listed = archive.files.flatMap(f => f.chunks.map(descriptor));
    if (canonicalJson(listed) !== canonicalJson(envelope.objects)) fail('INVENTORY');
    target = await privateRoot(join(root, `restore-${randomUUID()}`), true);
    const digests = Object.fromEntries(kinds.map(kind => [kind, createHash('sha256')])), sizes = Object.fromEntries(kinds.map(kind => [kind, 0]));
    for (const file of archive.files) {
      ctx.check(); if (file.filename.startsWith('r2-objects/') && !objectRoot) objectRoot = await privateRoot(join(target, 'r2-objects'), true);
      const path = join(target, file.filename), handle = await open(path, 'wx', 0o600); owned.push(path);
      const digest = createHash('sha256'); let total = 0;
      try {
        for (const chunk of file.chunks) {
          const cipher = await readback(source, chunk, ctx); digests[file.kind].update(cipher); sizes[file.kind] += cipher.length;
          const bytes = await age(agePath, ['--decrypt', '--identity', identityFile], cipher, ctx, true);
          if (bytes.length !== chunk.plaintextBytes || sha256(bytes) !== chunk.plaintextSha256) fail('PLAINTEXT');
          total += bytes.length; if (total > file.bytes) fail('PLAINTEXT'); digest.update(bytes); await handle.writeFile(bytes);
        }
      } finally { await handle.close(); }
      if (total !== file.bytes || digest.digest('hex') !== file.sha256) fail('PLAINTEXT');
    }
    for (const kind of kinds) {
      const component = manifest.components.find(c => c.kind === kind);
      if (component.bytes !== sizes[kind] || component.ciphertextSha256 !== digests[kind].digest('hex')) fail('INVENTORY');
      const expectedHash = kind === 'r2' ? sha256(canonicalJson(manifest.r2References)) : archive.files.find(f => f.filename === ({ d1: 'sarin-bot-data.sql', auth: 'auth.json', config: 'config.json' })[kind]).sha256;
      if (component.plaintextSha256 !== expectedHash) fail('INVENTORY');
    }
    ctx.check(); return { directory: target, manifest, expected };
  } catch (e) {
    if (target) { for (const path of owned) await rm(path, { force: true }); if (objectRoot) await rmdir(objectRoot); await rmdir(target); }
    return safeError(e, ctx);
  }
}
