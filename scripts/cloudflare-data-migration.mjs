import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, lstat, mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import {
  PROJECT_ID, buildReversePlan, canonicalJson, captureFirestoreSnapshot, normalizeImportedRow,
  prepareMigration, privateDirectory, readPreparedBundle, readPrivateFile, readSourceBackup,
  sha256, validateBlobReference, verifyImportedRows, verifyMigration, writePreparedBundle, writePrivateFile, writeSourceBackup,
} from './lib/data-migration.mjs';

const fail = (code) => { throw new Error(`MIGRATION_${code}`); };
const workspace = fileURLToPath(new URL('../', import.meta.url));
const cloudflare = join(workspace, 'cloudflare');
const wrangler = join(cloudflare, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const operations = ['--export', '--prepare', '--verify', '--verify-source', '--import', '--verify-target', '--export-d1', '--reverse-plan'];

/** SQL capture adapter; logical --export-d1 remains a separate migration format. No CLI/remote operation is added.
 * @param {{endpoint:string,downloadOrigin:string,tokenSupplier:()=>string|Promise<string>,fetchImpl?:Function,now?:()=>number,wait?:Function,maxPolls?:number}} options
 */
export function d1SqlExporter({ endpoint, downloadOrigin, tokenSupplier, fetchImpl = fetch, now = Date.now, wait = delay, maxPolls = 120 }) {
  /** @returns {never} */
  const reject = code => { throw new Error(`RECOVERY_${code}`); };
  const api = new URL(endpoint), origin = new URL(downloadOrigin);
  if (api.origin !== 'https://api.cloudflare.com' || !/^\/client\/v4\/accounts\/[a-f0-9]{32}\/d1\/database\/[a-f0-9-]{36}\/export$/.test(api.pathname) || api.search || api.hash || api.username || api.password || origin.protocol !== 'https:' || !/^[a-z0-9.-]+\.r2\.cloudflarestorage\.com$/.test(origin.hostname) || origin.origin !== downloadOrigin || !Number.isInteger(maxPolls) || maxPolls < 1 || maxPolls > 120) reject('EXPORT_DESTINATION');
  return { async exportSql({ signal } = {}) {
    const bounded = AbortSignal.any([AbortSignal.timeout(30 * 60 * 1000), ...(signal ? [signal] : [])]);
    const startedAt = now(); let bookmark;
    try {
      for (let attempt = 0; attempt < maxPolls; attempt++) {
        bounded.throwIfAborted();
        const response = await fetchImpl(endpoint, { method: 'POST', headers: { Authorization: `Bearer ${await tokenSupplier()}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ output_format: 'polling', ...(bookmark ? { current_bookmark: bookmark } : {}) }), redirect: 'error', signal: bounded });
        if (!response.ok) { await response.body?.cancel(); reject('EXPORT_HTTP'); }
        let reply;
        try { reply = await boundedJson(response, 1024 * 1024); } catch { reject('EXPORT_RESPONSE'); }
        const value = reply?.result;
        if (reply.success !== true || !value || typeof value.at_bookmark !== 'string' || !value.at_bookmark || value.at_bookmark.length > 512 || bookmark && value.at_bookmark !== bookmark) reject('EXPORT_BOOKMARK');
        bookmark = value.at_bookmark;
        if (value.status === 'error') reject('EXPORT_FAILED');
        if (value.status === 'complete') {
          let url; try { url = new URL(value.result.signed_url); } catch { reject('EXPORT_DESTINATION'); }
          if (url.origin !== downloadOrigin || url.username || url.password || url.hash) reject('EXPORT_DESTINATION');
          const download = await fetchImpl(url.href, { method: 'GET', redirect: 'error', signal: bounded });
          if (!download.ok || !download.body) { await download.body?.cancel(); reject('EXPORT_DOWNLOAD'); }
          return { stream: download.body, bookmark, startedAt, completedAt: now(), recoverableAt: startedAt };
        }
        if (value.status !== undefined && value.status !== 'pending') reject('EXPORT_RESPONSE');
        if (attempt + 1 < maxPolls) await wait(1000, undefined, { signal: bounded });
      }
      reject('EXPORT_TIMEOUT');
    } catch (error) {
      if (/^RECOVERY_[A-Z_]+$/.test(error?.message ?? '')) throw error;
      reject(bounded.aborted ? 'EXPORT_TIMEOUT' : 'EXPORT_NETWORK');
    }
  } };
}

export function parseArguments(args) {
  const result = {};
  const flags = new Set([...operations, '--remote', '--maintenance-confirmed']);
  const values = new Set(['--directory', '--database', '--bucket', '--baseline']);
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (Object.hasOwn(result, key) || (!flags.has(key) && !values.has(key))) fail('ARGUMENTS');
    if (flags.has(key)) result[key] = true;
    else { const value = args[++index]; if (!value || value.startsWith('--')) fail('ARGUMENTS'); result[key] = value; }
  }
  if (operations.filter((key) => result[key]).length !== 1 || typeof result['--directory'] !== 'string') fail('ARGUMENTS');
  const operation = operations.find((key) => result[key]);
  if (['--import', '--verify-target', '--export-d1'].includes(operation)) {
    if (result['--database'] !== 'sarin-bot-data' || result['--bucket'] !== 'sarin-bot-files') fail('DEDICATED_RESOURCES');
    if (result['--remote'] && ['--import', '--export-d1'].includes(operation) && !result['--maintenance-confirmed']) fail('MAINTENANCE_REQUIRED');
  }
  if (operation === '--reverse-plan' && typeof result['--baseline'] !== 'string') fail('BASELINE_REQUIRED');
  return { ...result, operation };
}

/** The operator's temporary OAuth token stays in memory, never env/argv/files/output. */
export function googleCloudSdkCommand(sdk, exists = existsSync) {
  const file = join(sdk, 'platform', 'bundledpython', 'python.exe');
  const script = join(sdk, 'lib', 'gcloud.py');
  if (!exists(file) || !exists(script)) fail('GCLOUD_SDK_MISSING');
  return { file, arguments: [script] };
}

export function googleAccessToken() {
  const args = [`--project=${PROJECT_ID}`, `--billing-project=${PROJECT_ID}`, 'auth', 'print-access-token'];
  const options = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    env: { ...process.env, CLOUDSDK_CORE_LOG_HTTP: 'false', CLOUDSDK_CORE_DISABLE_PROMPTS: '1', CLOUDSDK_CORE_VERBOSITY: 'error' }, maxBuffer: 32 * 1024 };
  let token;
  if (process.platform === 'win32') {
    const sdk = join(process.env.LOCALAPPDATA ?? '', 'Google', 'Cloud SDK', 'google-cloud-sdk');
    const command = googleCloudSdkCommand(sdk);
    token = execFileSync(command.file, [...command.arguments, ...args], options).trim();
  } else token = execFileSync('gcloud', args, options).trim();
  if (!/^[A-Za-z0-9._~+/-]{20,8192}={0,2}$/.test(token)) fail('GOOGLE_TOKEN');
  return token;
}

async function boundedJson(response, maxBytes = 64 * 1024 * 1024) {
  const reader = response.body?.getReader();
  if (!reader) fail('FIRESTORE_RESPONSE');
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) fail('FIRESTORE_RESPONSE_SIZE');
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    try { await reader.cancel(); } catch { /* Only a generic code escapes. */ }
    if (/^MIGRATION_[A-Z_]+$/.test(error.message)) throw error;
    fail('FIRESTORE_RESPONSE');
  }
}

export function firestoreRequester({ tokenSupplier = googleAccessToken, fetchImpl = fetch } = {}) {
  let token;
  return async (url, { method, body = /** @type {Record<string, unknown> | undefined} */ (undefined) }) => {
    const target = new URL(url);
    const path = decodeURIComponent(target.pathname), root = `/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
    const readOperation = method === 'GET' || (method === 'POST' && [':listCollectionIds', ':runQuery'].some((suffix) => path.endsWith(suffix)));
    if (target.origin !== 'https://firestore.googleapis.com' || ![root, `${root}:listCollectionIds`, `${root}:runQuery`].includes(path) && !path.startsWith(`${root}/`) || !readOperation) fail('FIRESTORE_DESTINATION');
    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (!token) token = tokenSupplier();
      let response;
      try {
        response = await fetchImpl(url, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          ...(body ? { body: JSON.stringify(body) } : {}), redirect: 'error', signal: AbortSignal.timeout(30_000) });
      } catch { fail('FIRESTORE_NETWORK'); }
      if (response.ok) return boundedJson(response);
      const status = response.status;
      await response.body?.cancel();
      if (status === 401 && attempt === 0) { token = undefined; continue; }
      if ([429, 500, 502, 503, 504].includes(status) && attempt < 3) { await delay(Math.min(500 * 2 ** attempt, 4000)); continue; }
      fail(`FIRESTORE_HTTP_${status}`);
    }
    fail('FIRESTORE_RETRIES');
  };
}

function runWrangler(directory, args) {
  try {
    return execFileSync(process.execPath, [wrangler, ...args], { cwd: cloudflare, windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
      // D1 --json suppresses progress internally; its final JSON requires the log level.
      // All output remains captured here and logs stay inside the private backup.
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG: 'log', WRANGLER_LOG_SANITIZE: 'true', WRANGLER_LOG_PATH: join(directory, 'wrangler-logs') } });
  } catch { fail('WRANGLER_OPERATION'); }
}

function storageFlags(directory, options) { return options['--remote'] ? ['--remote'] : ['--local', '--persist-to', join(directory, 'local-cloudflare-state')]; }

export function queryD1(directory, options, sql) {
  const output = runWrangler(directory, ['d1', 'execute', options['--database'], '--command', sql, ...storageFlags(directory, options), '--json', '--yes']);
  let results;
  try { results = JSON.parse(output); } catch { fail('D1_RESPONSE'); }
  if (!Array.isArray(results) || results.some((result) => result.success !== true || !Array.isArray(result.results))) fail('D1_RESPONSE');
  return results.flatMap((result) => result.results);
}

async function readD1(directory, options) {
  const before = queryD1(directory, options, 'SELECT revision FROM app_revision WHERE id=1;');
  if (before.length !== 1 || !Number.isSafeInteger(before[0].revision)) fail('D1_REVISION');
  const rows = [], seen = new Set();
  for (let offset = 0; ; offset += 25) {
    // Only an integer offset enters argv. Document paths/data never enter shell arguments.
    const page = queryD1(directory, options, `SELECT path,parent,document_id,data,updated_at,blob FROM app_documents ORDER BY path LIMIT 25 OFFSET ${offset};`);
    for (const raw of page) {
      const row = normalizeImportedRow(raw);
      if (seen.has(row.path)) fail('D1_DUPLICATE');
      seen.add(row.path); rows.push(row);
    }
    if (page.length < 25) break;
  }
  const after = queryD1(directory, options, 'SELECT revision FROM app_revision WHERE id=1;');
  if (after.length !== 1 || after[0].revision !== before[0].revision) fail('D1_CHANGED_DURING_EXPORT');
  return { version: 1, projectId: PROJECT_ID, revision: before[0].revision, rows };
}

async function downloadBlobs(directory, options, references, subdirectory) {
  const destination = join(directory, subdirectory);
  await mkdir(destination, { mode: 0o700 });
  const blobs = [];
  for (const reference of references) {
    validateBlobReference(reference);
    const file = join(destination, reference.sha256);
    // Fetch every remote key even when the two namespaces contain identical bytes.
    // The local hash-named file can be reused only after this download verifies it.
    runWrangler(directory, ['r2', 'object', 'get', `${options['--bucket']}/${reference.key}`, '--file', file, ...storageFlags(directory, options)]);
    await chmod(file, 0o600);
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== reference.byteLength) fail('R2_BYTES');
    const bytes = await readFile(file);
    if (sha256(bytes) !== reference.sha256) fail('R2_HASH');
    blobs.push({ ...reference, bytes });
  }
  return blobs;
}

export async function runMigration(options) {
  const operation = options.operation;
  const directory = await privateDirectory(options['--directory'], { create: ['--export', '--export-d1'].includes(operation) });
  if (operation === '--export') {
    const started = Date.now();
    const source = await captureFirestoreSnapshot({ request: firestoreRequester() });
    if (Date.now() - started > 55 * 60_000) fail('SNAPSHOT_WINDOW_EXCEEDED');
    source.maintenanceConfirmed = options['--maintenance-confirmed'] === true;
    const manifest = await writeSourceBackup(directory, source);
    return { operation: 'export', ...manifest.counts, sha256: manifest.sha256, readTime: source.readTime };
  }
  if (operation === '--verify-source') {
    const source = await readSourceBackup(directory);
    return { operation: 'verify-source', documents: source.documents.length, sha256: sha256(canonicalJson(source)) };
  }
  if (operation === '--prepare') {
    const bundle = prepareMigration(await readSourceBackup(directory));
    await writePreparedBundle(directory, bundle);
    return { operation: 'prepare', ...verifyMigration(bundle), runtimeCompatibility: bundle.manifest.runtimeCompatibility, reservations: { statusReserved: bundle.manifest.counts.statusReserved, reservedResponses: bundle.manifest.counts.reservedResponses, reservedResponseDocuments: bundle.manifest.counts.reservedResponseDocuments } };
  }
  if (operation === '--verify') return { operation: 'verify', ...verifyMigration(await readPreparedBundle(directory)) };
  if (operation === '--export-d1') {
    const state = await readD1(directory, options);
    const unique = new Map();
    for (const row of state.rows.filter((row) => row.blob)) {
      if (unique.has(row.blob.key) && canonicalJson(unique.get(row.blob.key)) !== canonicalJson(row.blob)) fail('R2_REFERENCE');
      unique.set(row.blob.key, row.blob);
    }
    const references = [...unique.values()];
    const blobs = await downloadBlobs(directory, options, references, 'blobs');
    const bytes = canonicalJson(state);
    const manifest = { version: 1, projectId: PROJECT_ID, revision: state.revision, documents: state.rows.length, sha256: sha256(bytes), blobs: references };
    await writePrivateFile(directory, 'd1-export.json', bytes);
    await writePrivateFile(directory, 'd1-manifest.json', canonicalJson(manifest));
    return { operation: 'export-d1', documents: state.rows.length, revision: state.revision, blobs: blobs.length, sha256: manifest.sha256 };
  }
  if (operation === '--reverse-plan') {
    const baselineDirectory = await privateDirectory(options['--baseline']);
    const baseline = (await readPreparedBundle(baselineDirectory)).source;
    const bytes = await readPrivateFile(directory, 'd1-export.json');
    const manifest = JSON.parse((await readPrivateFile(directory, 'd1-manifest.json')).toString('utf8'));
    if (sha256(bytes) !== manifest.sha256 || manifest.projectId !== PROJECT_ID) fail('D1_EXPORT_HASH');
    const state = JSON.parse(bytes.toString('utf8')), blobs = [];
    for (const reference of manifest.blobs) {
      validateBlobReference(reference);
      blobs.push({ ...reference, bytes: await readPrivateFile(join(directory, 'blobs'), reference.sha256) });
    }
    const plan = buildReversePlan({ baseline, rows: state.rows, revision: state.revision, blobs });
    await writePrivateFile(directory, 'firestore-reverse-plan.json', canonicalJson(plan));
    return { operation: 'reverse-plan', upserts: plan.upserts.length, deletionCandidates: plan.deletionCandidates.length, revision: plan.revision, sha256: plan.sha256 };
  }
  const bundle = await readPreparedBundle(directory);
  if (operation === '--import') {
    if (options['--remote'] && (bundle.source.maintenanceConfirmed !== true || bundle.source.snapshotBoundary !== 'firestore-server-read-time')) fail('FINAL_EXPORT_REQUIRES_MAINTENANCE');
    if (options['--remote'] && (bundle.manifest.counts.statusReserved !== 0 || bundle.manifest.counts.reservedResponses !== 0)) fail('UNRESOLVED_RESERVATIONS');
    const target = await readD1(directory, options);
    const journal = queryD1(directory, options, 'SELECT count(*) AS count FROM app_commits;');
    if (target.revision !== 0 || target.rows.length !== 0 || journal.length !== 1 || journal[0].count !== 0) fail('TARGET_NOT_EMPTY');
    for (const blob of bundle.blobs) runWrangler(directory, ['r2', 'object', 'put', `${options['--bucket']}/${blob.key}`, '--file', join(directory, 'blobs', blob.sha256), '--content-type', blob.contentType, '--force', ...storageFlags(directory, options)]);
    runWrangler(directory, ['r2', 'object', 'put', `${options['--bucket']}/migration-manifests/${bundle.manifest.sha256}.json`, '--file', join(directory, 'migration-manifest.json'), '--content-type', 'application/json', '--force', ...storageFlags(directory, options)]);
    runWrangler(directory, ['d1', 'execute', options['--database'], '--file', join(directory, 'import.sql'), '--yes', ...storageFlags(directory, options), '--json']);
  }
  const imported = await readD1(directory, options);
  if (imported.revision !== 0) fail('TARGET_REVISION_CHANGED');
  const verification = verifyImportedRows(bundle, imported.rows);
  await downloadBlobs(directory, options, bundle.manifest.blobs, `verified-${randomUUID()}`);
  return { operation: operation === '--import' ? 'import-verified' : 'verify-target', ...verification, blobs: bundle.blobs.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await runMigration(parseArguments(process.argv.slice(2))))); }
  catch (error) {
    const code = /^MIGRATION_[A-Z0-9_]+$/.test(error?.message) ? error.message : 'MIGRATION_OPERATION_FAILED';
    console.error(JSON.stringify({ ok: false, code }));
    process.exitCode = 1;
  }
}
