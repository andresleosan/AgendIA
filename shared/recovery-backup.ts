export const RECOVERY_ENDPOINT = 'http://sarin-backup.internal/execute';
export const RECOVERY_ROUTE = '/api/internal/recovery-backup';
export const RECOVERY_CHUNK_BYTES = 8 * 1024 * 1024 + 65536;
export const RECOVERY_SET_BYTES = 1024 ** 3;
export const RECOVERY_ATTEMPT_MS = 30 * 60000;
export const RECOVERY_CLAIM_MS = 40 * 60000;
export type RecoveryWork = { backupId: string; fence: number; nonce: string; expiresAt: number; deadlineAt: number; attempt: number };
export type CiphertextObject = { id: string; sha256: string; bytes: number };
export type BackupEnvelope = { formatVersion: 1; backupId: string; createdAt: number; sealedAt: number; status: 'sealed'; keyId: string; manifest: CiphertextObject; objects: CiphertextObject[] };
export type BackupStatus = { phase: 'disabled' | 'idle' | 'preparing' | 'copying' | 'verifying' | 'sealed' | 'failed'; health: 'missing' | 'ok' | 'warning' | 'breached'; lastRecoverableAt: number | null; ages: Record<string, number>; bytes: number; durationMs: number; failureCode: string | null; gaps: { weeks: string[]; months: string[] } };
export const recoveryUuid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
export const recoveryHash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const natural = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
export function validRecoveryWork(v: unknown): v is RecoveryWork {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const w = v as RecoveryWork;
  return Object.keys(v).sort().join() === 'attempt,backupId,deadlineAt,expiresAt,fence,nonce' && recoveryUuid(w.backupId) && recoveryUuid(w.nonce) && natural(w.fence) && w.fence > 0 && natural(w.attempt) && w.attempt <= 2 && natural(w.expiresAt) && natural(w.deadlineAt) && w.expiresAt - w.deadlineAt === RECOVERY_CLAIM_MS - RECOVERY_ATTEMPT_MS;
}
export function validCiphertext(v: unknown): v is CiphertextObject {
  if (!v || typeof v !== 'object') return false;
  const o = v as CiphertextObject;
  return Object.keys(o).sort().join() === 'bytes,id,sha256' && recoveryUuid(o.id) && recoveryHash(o.sha256) && natural(o.bytes) && o.bytes > 0 && o.bytes <= RECOVERY_CHUNK_BYTES;
}
export function validEnvelope(v: unknown, backupId: string): v is BackupEnvelope {
  if (!v || typeof v !== 'object') return false;
  const e = v as BackupEnvelope;
  if (Object.keys(e).sort().join() !== 'backupId,createdAt,formatVersion,keyId,manifest,objects,sealedAt,status' || e.formatVersion !== 1 || e.backupId !== backupId || e.status !== 'sealed' || !natural(e.createdAt) || !natural(e.sealedAt) || e.createdAt > e.sealedAt || !recoveryHash(e.keyId) || !validCiphertext(e.manifest) || !Array.isArray(e.objects) || !e.objects.length || e.objects.length > 65536 || !e.objects.every(validCiphertext)) return false;
  const entries = [e.manifest, ...e.objects];
  return new Set(entries.map(o => o.id)).size === entries.length && entries.reduce((s, o) => s + o.bytes, 0) <= RECOVERY_SET_BYTES;
}
function workMessage(w: RecoveryWork): string {
  return JSON.stringify([w.backupId, w.fence, w.nonce, w.expiresAt, w.deadlineAt, w.attempt]);
}
export async function signRecoveryWork(w: RecoveryWork, secret: string): Promise<string> {
  if (!validRecoveryWork(w) || secret.length < 32) throw new Error('RECOVERY_AUTH');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(workMessage(w))))).map(v => v.toString(16).padStart(2, '0')).join('');
}
export async function verifyRecoveryWork(w: RecoveryWork, signature: string, secret: string): Promise<boolean> {
  if (!validRecoveryWork(w) || !recoveryHash(signature) || secret.length < 32) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  return crypto.subtle.verify('HMAC', key, Uint8Array.from(signature.match(/../g)!, v => parseInt(v, 16)), new TextEncoder().encode(workMessage(w)));
}
export async function recoveryBytes(stream: ReadableStream<Uint8Array> | null, max: number, signal?: AbortSignal): Promise<Uint8Array> {
  if (!stream) throw new Error('RECOVERY_BODY');
  const reader = stream.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      let abort: (() => void) | undefined;
      const pending = signal ? new Promise<never>((_, reject) => { abort = () => reject(new Error('RECOVERY_TIMEOUT')); if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true }); }) : null;
      let result: ReadableStreamReadResult<Uint8Array>;
      try { result = await (pending ? Promise.race([reader.read(), pending]) : reader.read()); }
      finally { if (abort) signal!.removeEventListener('abort', abort); }
      const { done, value } = result;
      if (done) break;
      size += value.length; if (size > max) throw new Error('RECOVERY_LIMIT'); chunks.push(value);
    }
    const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; } return bytes;
  } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
}
export async function recoveryDigest(bytes: Uint8Array): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>))).map(v => v.toString(16).padStart(2, '0')).join('');
}
