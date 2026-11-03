import 'server-only';
import { mkdtemp, rm, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { getAdminAuth } from '@/lib/firebase/admin';
import { RECOVERY_ENDPOINT, RECOVERY_ATTEMPT_MS, RECOVERY_CHUNK_BYTES, recoveryBytes, validRecoveryWork, verifyRecoveryWork, type RecoveryWork, type BackupStatus, type CiphertextObject } from '../../../shared/recovery-backup.ts';

type Environment = Record<string, string | undefined>;
type Bridge = (op: string, value?: Record<string, unknown>, bytes?: Uint8Array) => Promise<any>;
type Adapters = { capture: (signal: AbortSignal) => Promise<any>; encrypt: (capture: any, signal: AbortSignal) => Promise<any>; bridge: Bridge; cleanup: () => Promise<void>; now?: () => number };
const state = globalThis as typeof globalThis & { __sarinRecoveryBackup?: boolean };
export async function authenticateRecoveryTrigger(request: Request, env: Environment, now = Date.now()): Promise<RecoveryWork | null> {
  if (env.SARIN_BACKUP_ENABLED !== 'true' || env.SARIN_MAINTENANCE === 'true' || !env.SARIN_BACKUP_HMAC_KEY || request.method !== 'POST') return null;
  try {
    const body = JSON.parse(new TextDecoder().decode(await recoveryBytes(request.body, 2048, AbortSignal.timeout(3000))));
    if (!validRecoveryWork(body) || now >= body.deadlineAt || body.deadlineAt - now > RECOVERY_ATTEMPT_MS || !await verifyRecoveryWork(body, request.headers.get('x-sarin-backup-signature') ?? '', env.SARIN_BACKUP_HMAC_KEY)) return null;
    return body;
  } catch { return null; }
}
export function recoveryBridge(work: RecoveryWork, signal?: AbortSignal): Bridge {
  return async (op, value = {}, bytes) => {
    const command = { work, op, ...value };
    const response = await fetch(RECOVERY_ENDPOINT, { method: 'POST', headers: bytes ? { 'x-sarin-backup-command': JSON.stringify(command), 'Content-Type': 'application/octet-stream' } : { 'Content-Type': 'application/json' }, body: bytes ? bytes as Uint8Array<ArrayBuffer> : JSON.stringify(command), redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(30000), ...(signal ? [signal] : [])]) });
    if (!response.ok) { await response.body?.cancel(); throw new Error('RECOVERY_BRIDGE'); }
    if (['export-download', 'r2-read', 'archive-get'].includes(op)) return response;
    return JSON.parse(new TextDecoder().decode(await recoveryBytes(response.body, 65536, signal)));
  };
}
export async function runRecoveryBackup(work: RecoveryWork, adapters: Adapters): Promise<BackupStatus> {
  if (state.__sarinRecoveryBackup) throw new Error('RECOVERY_BUSY');
  state.__sarinRecoveryBackup = true;
  const now = adapters.now ?? Date.now, controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), Math.max(1, work.deadlineAt - now()));
  let heartbeatFailed = false;
  const heartbeat = setInterval(() => { void adapters.bridge('heartbeat').catch(() => { heartbeatFailed = true; controller.abort(); }); }, 60000);
  let sealing = false;
  const check = () => { if (controller.signal.aborted || now() >= work.deadlineAt || heartbeatFailed) throw new Error('RECOVERY_CANCELLED'); };
  try {
    check(); const capture = await adapters.capture(controller.signal); check();
    if (!capture.complete || capture.blockers?.length) throw new Error('RECOVERY_CAPTURE');
    const archive = await adapters.encrypt(capture, controller.signal); check();
    sealing = true;
    try { return await adapters.bridge('seal', { envelope: archive.envelope, snapshotTimes: capture.snapshotTimes }); }
    catch { return await adapters.bridge('status'); }
  } catch {
    if (sealing) return adapters.bridge('status');
    return await adapters.bridge('fail', { code: controller.signal.aborted ? 'CANCELLED' : 'EXECUTION_FAILED' });
  } finally {
    clearTimeout(deadline); clearInterval(heartbeat);
    try { await adapters.cleanup(); } finally { state.__sarinRecoveryBackup = false; }
  }
}
// These modules also run under plain Node in the image. Keep SQLite and staging paths out of the Next bundle.
async function recoveryModule(name: string): Promise<any> {
  return import(/* webpackIgnore: true */ pathToFileURL(join(process.cwd(), 'scripts/lib', name)).href);
}
export async function cleanupRecoveryDirectory(root: string): Promise<void> {
  if (dirname(resolve(root)) !== resolve(tmpdir()) || !/^sarin-recovery-[A-Za-z0-9]+$/.test(basename(root))) throw new Error('RECOVERY_CLEANUP');
  await rm(root, { recursive: true, force: true });
}
export async function createRecoveryAdapters(work: RecoveryWork, env: Environment = process.env): Promise<Adapters> {
  if (env.SARIN_BACKUP_ENABLED !== 'true' || env.SARIN_MAINTENANCE === 'true' || !/^[a-f0-9]{40}$/.test(env.SARIN_BACKUP_SOURCE_SHA ?? '') || !env.SARIN_BACKUP_CONFIG_FILE || !env.SARIN_BACKUP_RECIPIENT) throw new Error('RECOVERY_CONFIG');
  const [components, age, data, format] = await Promise.all([recoveryModule('recovery-components.mjs'), recoveryModule('recovery-age.mjs'), recoveryModule('data-migration.mjs'), recoveryModule('recovery-backup.mjs')]);
  const bridge = recoveryBridge(work);
  const root = await mkdtemp(join(tmpdir(), 'sarin-recovery-'));
  await data.privateDirectory(root);
  async function privateMaterial(file: string): Promise<Buffer> {
    const path = resolve(file), directory = await data.privateDirectory(dirname(path));
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile() || process.platform !== 'win32' && (info.mode & 0o077)) throw new Error('RECOVERY_CONFIG');
    return data.readPrivateFile(directory, basename(path));
  }
  const source = { sourceSha: env.SARIN_BACKUP_SOURCE_SHA, migrations: format.recoveryMigrationInventory(),
    async exportSql({ signal }: { signal: AbortSignal }) {
      const call = recoveryBridge(work, signal);
      let result = await call('export-start');
      for (let poll = 0; result.status !== 'complete' && poll < 120; poll++) { await delay(1000, undefined, { signal }); result = await call('export-poll'); }
      if (result.status !== 'complete') throw new Error('RECOVERY_EXPORT_TIMEOUT');
      const response: Response = await call('export-download');
      const startedAt = Number(response.headers.get('x-recovery-start')), completedAt = Number(response.headers.get('x-recovery-complete'));
      return { stream: response.body, bookmark: response.headers.get('x-recovery-bookmark'), startedAt, completedAt, recoverableAt: startedAt };
    },
    async readObject(reference: unknown, { signal }: { signal: AbortSignal }) {
      const response: Response = await recoveryBridge(work, signal)('r2-read', { reference });
      return { stream: response.body, contentType: response.headers.get('Content-Type') };
    },
  };
  return { bridge,
    capture: signal => components.captureRecoveryComponents({ directory: root, source, signal, auth: { listUsers: (size: number, token?: string) => getAdminAuth().listUsers(size, token), readPasswordBatch: async () => { if (!env.SARIN_BACKUP_PASSWORD_FILE) throw new Error('RECOVERY_PASSWORD'); return privateMaterial(env.SARIN_BACKUP_PASSWORD_FILE); } }, config: { readInventory: async () => JSON.parse((await privateMaterial(env.SARIN_BACKUP_CONFIG_FILE!)).toString('utf8')) } }),
    encrypt: (capture, signal) => age.encryptBackupComponents(capture, { backupId: work.backupId, agePath: '/usr/local/bin/age', recipient: env.SARIN_BACKUP_RECIPIENT, signal,
      destination: { async putIfAbsent(id: string, stream: AsyncIterable<Uint8Array>) {
        const chunks: Uint8Array[] = []; let total = 0;
        for await (const chunk of stream) { total += chunk.length; if (total > RECOVERY_CHUNK_BYTES) throw new Error('RECOVERY_LIMIT'); chunks.push(chunk); }
        const bytes = Buffer.concat(chunks), sha256 = data.sha256(bytes);
        await recoveryBridge(work, signal)('archive-put', { entry: { id, sha256, bytes: total } satisfies CiphertextObject }, bytes);
      }, async get(id: string) { const response: Response = await recoveryBridge(work, signal)('archive-get', { id }); return Readable.fromWeb(response.body as import('node:stream/web').ReadableStream); } },
    }),
    cleanup: () => cleanupRecoveryDirectory(root),
  };
}
