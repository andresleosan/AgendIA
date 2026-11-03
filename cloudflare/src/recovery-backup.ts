import { RECOVERY_ENDPOINT, RECOVERY_ROUTE, RECOVERY_CHUNK_BYTES, RECOVERY_SET_BYTES, RECOVERY_ATTEMPT_MS, RECOVERY_CLAIM_MS, recoveryUuid, recoveryHash, validRecoveryWork, validEnvelope, validCiphertext, recoveryBytes, recoveryDigest, signRecoveryWork, type RecoveryWork, type BackupStatus, type CiphertextObject } from '../../shared/recovery-backup.ts';
import { SINGLETON_NAME } from './router.ts';

type Env = RecoveryBindings & Partial<Pick<CloudflareBindings, 'SARIN_APP' | 'SARIN_FILES' | 'SARIN_DB'>> & { SARIN_MAINTENANCE?: string; SARIN_DATA_BACKEND?: string };
type Run = { backup_id: string; fence: number; nonce: string; attempt: number; schedule_day: string; phase: BackupStatus['phase']; started_at: number; deadline_at: number; expires_at: number; heartbeat_at: number; consumed: number; finished_at: number | null; failure_code: string | null; bytes: number; export_bookmark: string | null; export_url: string | null; export_started_at: number | null; export_completed_at: number | null };
type Catalog = { backup_id: string; sealed_at: number; recoverable_at: number; envelope: string; snapshot_times: string; prechange: number };
const idle = (phase: BackupStatus['phase'] = 'idle'): BackupStatus => ({ phase, health: 'missing', lastRecoverableAt: null, ages: {}, bytes: 0, durationMs: 0, failureCode: null, gaps: { weeks: [], months: [] } });
const reply = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
function fail(code = 'DENIED'): never { throw new Error(`RECOVERY_${code}`); }
const uuid = (v: unknown): string => recoveryUuid(v) ? v : fail('INVALID');
const dbFor = (env: Env) => env.SARIN_RECOVERY_DB ?? fail('CONFIG');
function enabled(env: Env): boolean { return env.SARIN_BACKUP_ENABLED === 'true' && env.SARIN_MAINTENANCE !== 'true'; }
function configured(env: Env): boolean {
  return enabled(env) && !!env.SARIN_RECOVERY_DB && !!env.SARIN_BACKUPS && env.SARIN_BACKUPS !== env.SARIN_FILES && env.SARIN_RECOVERY_DB !== env.SARIN_DB && (env.SARIN_BACKUP_HMAC_KEY?.length ?? 0) >= 32;
}
const changed = (r: D1Result) => r.meta.changes > 0;
const leaseWhere = `backup_id=? AND fence=? AND nonce=? AND active=1 AND deadline_at>? AND expires_at>?`;
const leaseArgs = (w: RecoveryWork, now: number) => [w.backupId, w.fence, w.nonce, now, now];
function workFor(r: Run): RecoveryWork { return { backupId: r.backup_id, fence: r.fence, nonce: r.nonce, expiresAt: r.expires_at, deadlineAt: r.deadline_at, attempt: r.attempt }; }
async function expire(env: Env, now: number): Promise<void> {
  await dbFor(env).prepare("UPDATE backup_runs SET phase='failed',active=0,finished_at=?,failure_code='DEADLINE' WHERE active=1 AND (deadline_at<=? OR expires_at<=?)").bind(now, now, now).run();
}
export async function claimRecoveryBackup(env: Env, { backupId, attempt, now, prechange = false }: { backupId: string; attempt: number; now: number; prechange?: boolean }): Promise<RecoveryWork | null> {
  if (!configured(env)) return null;
  uuid(backupId); if (!Number.isSafeInteger(now) || now < 0 || !Number.isInteger(attempt) || attempt < 0 || attempt > 2) fail('INVALID');
  await expire(env, now);
  const db = dbFor(env), day = prechange ? `prechange:${backupId}` : new Date(now).toISOString().slice(0, 10), nonce = crypto.randomUUID();
  const r = await db.prepare(`INSERT OR IGNORE INTO backup_runs(backup_id,nonce,attempt,schedule_day,prechange,phase,started_at,deadline_at,expires_at,heartbeat_at) VALUES(?,?,?,?,?,'preparing',?,?,?,?)`).bind(backupId, nonce, attempt, day, prechange ? 1 : 0, now, now + RECOVERY_ATTEMPT_MS, now + RECOVERY_CLAIM_MS, now).run();
  if (!changed(r)) return null;
  const row = await db.prepare('SELECT * FROM backup_runs WHERE backup_id=?').bind(backupId).first<Run>();
  return row ? workFor(row) : null;
}
export async function recoveryStatus(env: Env, now = Date.now()): Promise<BackupStatus> {
  if (!enabled(env)) return idle('disabled');
  if (!env.SARIN_RECOVERY_DB) return { ...idle('failed'), failureCode: 'CONFIG' };
  const db = dbFor(env), latest = await db.prepare('SELECT * FROM backup_catalog ORDER BY recoverable_at DESC LIMIT 1').first<Catalog>();
  const run = await db.prepare('SELECT * FROM backup_runs ORDER BY fence DESC LIMIT 1').first<Run>();
  const catalog = (await db.prepare('SELECT * FROM backup_catalog').all<Catalog>()).results;
  const gaps = planRecoveryRetention(catalog.map(c => ({ backupId: c.backup_id, sealedAt: c.sealed_at, recoverableAt: c.recoverable_at, prechange: !!c.prechange, objects: [] })), [], now).gaps;
  const at = latest?.recoverable_at ?? null, age = at === null ? null : Math.max(0, now - at);
  const phase = run?.phase ?? 'idle';
  return { phase: run?.deadline_at && run.deadline_at <= now && ['preparing', 'copying', 'verifying'].includes(phase) ? 'failed' : phase,
    health: age === null ? 'missing' : age > 24 * 3600000 ? 'breached' : age >= 20 * 3600000 ? 'warning' : 'ok', lastRecoverableAt: at,
    ages: latest ? Object.fromEntries(Object.entries(JSON.parse(latest.snapshot_times) as Record<string, number>).map(([k, v]) => [k, Math.max(0, now - v)])) : {},
    bytes: run?.bytes ?? 0, durationMs: run ? Math.max(0, (run.finished_at ?? now) - run.started_at) : 0, failureCode: run?.failure_code ?? null, gaps };
}
export async function scheduleRecoveryBackup(env: Env, now = Date.now(), dispatch?: (request: Request) => Promise<Response>): Promise<BackupStatus> {
  if (!enabled(env)) return idle('disabled');
  if (!configured(env) || !env.SARIN_APP || env.SARIN_DATA_BACKEND !== 'd1' || !env.SARIN_BACKUP_EXPORT_TOKEN || !env.SARIN_BACKUP_RECIPIENT) return { ...idle('failed'), failureCode: 'CONFIG' };
  await expire(env, now);
  if (env.SARIN_BACKUP_CLEANUP_ENABLED === 'true') await cleanupRecoveryBackups(env, now, false);
  const date = new Date(now), day = date.toISOString().slice(0, 10);
  if (date.getUTCHours() < 7) return recoveryStatus(env, now);
  const last = await dbFor(env).prepare('SELECT * FROM backup_runs WHERE schedule_day=? ORDER BY attempt DESC LIMIT 1').bind(day).first<Run>();
  if (last && (last.phase !== 'failed' || last.attempt >= 2 || now < (last.finished_at ?? now) + 15 * 60000)) return recoveryStatus(env, now);
  const work = await claimRecoveryBackup(env, { backupId: crypto.randomUUID(), attempt: last ? last.attempt + 1 : 0, now });
  if (!work) return recoveryStatus(env, now);
  const request = new Request(`http://sarin-container.internal${RECOVERY_ROUTE}`, { method: 'POST', body: JSON.stringify(work), headers: { 'Content-Type': 'application/json', 'x-sarin-backup-signature': await signRecoveryWork(work, env.SARIN_BACKUP_HMAC_KEY!) }, signal: AbortSignal.timeout(15000), redirect: 'manual' });
  try {
    const response = await (dispatch ? dispatch(request) : env.SARIN_APP.get(env.SARIN_APP.idFromName(SINGLETON_NAME)).fetch(request));
    await response.body?.cancel();
    if (response.status !== 202) {
      const current = await dbFor(env).prepare('SELECT consumed FROM backup_runs WHERE backup_id=?').bind(work.backupId).first<{ consumed: number }>();
      if (!current?.consumed) await finishFailed(env, work, now, 'TRIGGER_FAILED');
    }
  } catch {
    // A lost acceptance may already be executing. Read consumption before failing it.
    const current = await dbFor(env).prepare('SELECT consumed FROM backup_runs WHERE backup_id=?').bind(work.backupId).first<{ consumed: number }>();
    if (!current?.consumed) await finishFailed(env, work, now, 'TRIGGER_UNKNOWN');
  }
  return recoveryStatus(env, now);
}
async function finishFailed(env: Env, w: RecoveryWork, now: number, code: string) {
  await dbFor(env).prepare(`UPDATE backup_runs SET phase='failed',active=0,finished_at=?,failure_code=? WHERE ${leaseWhere}`).bind(now, code, ...leaseArgs(w, now)).run();
}
/** All live source R2 objects are immutable; broad pin starts before SQL capture. */
export async function sourceObjectsPinned(env: Env, now = Date.now()): Promise<boolean> {
  if (!enabled(env)) return false;
  if (!env.SARIN_RECOVERY_DB) return true;
  const r = await dbFor(env).prepare('SELECT fence FROM backup_runs WHERE active=1 AND deadline_at>? AND expires_at>? LIMIT 1').bind(now, now).first();
  return !!r;
}
async function liveRun(env: Env, w: RecoveryWork, now: number): Promise<Run> {
  const r = await dbFor(env).prepare(`SELECT * FROM backup_runs WHERE ${leaseWhere}`).bind(...leaseArgs(w, now)).first<Run>();
  if (!r || r.expires_at !== w.expiresAt || r.deadline_at !== w.deadlineAt || r.attempt !== w.attempt) fail('FENCE');
  return r!;
}
const objectKey = (id: string) => `ciphertext/${uuid(id)}`;
async function archivePut(request: Request, env: Env, w: RecoveryWork, now: number, entry: CiphertextObject): Promise<Response> {
  const clockStart = performance.now();
  const clock = () => now + Math.floor(performance.now() - clockStart);
  if (!validCiphertext(entry)) fail('INVALID');
  const bytes = await recoveryBytes(request.body, RECOVERY_CHUNK_BYTES, AbortSignal.timeout(30000));
  if (bytes.length !== entry.bytes || await recoveryDigest(bytes) !== entry.sha256) fail('HASH');
  const db = dbFor(env);
  const reserve = await db.prepare(`UPDATE backup_runs SET bytes=bytes+?,phase='copying' WHERE ${leaseWhere} AND consumed=1 AND bytes+?<=?`).bind(entry.bytes, ...leaseArgs(w, clock()), entry.bytes, RECOVERY_SET_BYTES).run();
  if (!changed(reserve)) fail('FENCE');
  // Register before upload: an interrupted put remains discoverable for failed-run cleanup.
  await db.batch([
    db.prepare('INSERT INTO backup_objects(object_id,sha256,bytes) VALUES(?,?,?)').bind(entry.id, entry.sha256, entry.bytes),
    db.prepare('INSERT INTO backup_run_objects(backup_id,object_id) VALUES(?,?)').bind(w.backupId, entry.id),
  ]);
  const stored = await env.SARIN_BACKUPS!.put(objectKey(entry.id), bytes, { onlyIf: { etagDoesNotMatch: '*' }, httpMetadata: { contentType: 'application/octet-stream' } });
  if (!stored) fail('EXISTS');
  const readback = await env.SARIN_BACKUPS!.get(objectKey(entry.id));
  if (!readback || readback.size !== entry.bytes || await recoveryDigest(await recoveryBytes(readback.body, RECOVERY_CHUNK_BYTES, AbortSignal.timeout(30000))) !== entry.sha256) fail('READBACK');
  await liveRun(env, w, clock());
  await db.prepare('UPDATE backup_objects SET verified=1 WHERE object_id=?').bind(entry.id).run();
  return reply({ ok: true });
}
async function exportStep(env: Env, w: RecoveryWork, run: Run, op: string, now: number): Promise<Response> {
  if (!/^[a-f0-9]{32}$/.test(env.SARIN_BACKUP_ACCOUNT_ID ?? '') || !recoveryUuid(env.SARIN_BACKUP_DATABASE_ID) || !env.SARIN_BACKUP_EXPORT_TOKEN) fail('CONFIG');
  const db = dbFor(env);
  if (op === 'export-download') {
    if (!run.export_url || !run.export_completed_at) fail('EXPORT');
    const url = checkedDownload(run.export_url, env);
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(30000) });
    if (!response.ok || response.redirected) { await response.body?.cancel(); fail('EXPORT'); }
    // Bound stream at the Worker as well as at the private Node staging adapter.
    let total = 0;
    return new Response(response.body!.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, c) { total += chunk.length; if (total > RECOVERY_SET_BYTES) fail('LIMIT'); c.enqueue(chunk); } })), { headers: { 'Content-Type': 'application/sql', 'Cache-Control': 'no-store', 'x-recovery-start': String(run.export_started_at), 'x-recovery-complete': String(run.export_completed_at), 'x-recovery-bookmark': run.export_bookmark! } });
  }
  if (op === 'export-start' && run.export_started_at !== null || op === 'export-poll' && !run.export_bookmark) fail('EXPORT');
  if (op === 'export-start') {
    const r = await db.prepare(`UPDATE backup_runs SET export_started_at=? WHERE ${leaseWhere} AND export_started_at IS NULL`).bind(now, ...leaseArgs(w, now)).run();
    if (!changed(r)) fail('FENCE');
  }
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.SARIN_BACKUP_ACCOUNT_ID}/d1/database/${env.SARIN_BACKUP_DATABASE_ID}/export`, { method: 'POST', headers: { Authorization: `Bearer ${env.SARIN_BACKUP_EXPORT_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ output_format: 'polling', ...(run.export_bookmark ? { current_bookmark: run.export_bookmark } : {}) }), redirect: 'manual', signal: AbortSignal.timeout(30000) });
  const value = JSON.parse(new TextDecoder().decode(await recoveryBytes(response.body, 65536, AbortSignal.timeout(30000)))) as { success?: boolean; result?: { status?: string; at_bookmark?: string; result?: { signed_url?: string } } };
  const result = value.result;
  if (!response.ok || !value.success || !result || !['active', 'pending', 'complete'].includes(result.status ?? '') || typeof result.at_bookmark !== 'string' || result.at_bookmark.length > 512 || !result.at_bookmark || run.export_bookmark && result.at_bookmark !== run.export_bookmark) fail('EXPORT');
  const url = result.status === 'complete' ? checkedDownload(result.result?.signed_url ?? '', env).href : null;
  const updated = await db.prepare(`UPDATE backup_runs SET export_bookmark=?,export_url=?,export_completed_at=? WHERE ${leaseWhere}`).bind(result.at_bookmark, url, url ? now : null, ...leaseArgs(w, now)).run();
  if (!changed(updated)) fail('FENCE');
  return reply({ status: result.status });
}
function checkedDownload(raw: string, env: Env): URL {
  const url = new URL(raw), allowed = new URL(env.SARIN_BACKUP_DOWNLOAD_ORIGIN ?? 'http://invalid');
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || url.origin !== allowed.origin || allowed.pathname !== '/' || allowed.search || allowed.hash || !allowed.hostname.endsWith('.r2.cloudflarestorage.com')) fail('EXPORT_ORIGIN');
  return url;
}
async function seal(env: Env, w: RecoveryWork, body: Record<string, unknown>, clock: () => number, databaseClock: boolean): Promise<Response> {
  const now = clock();
  const envelope = body.envelope;
  if (!validEnvelope(envelope, w.backupId) || envelope.sealedAt > now || envelope.createdAt < w.deadlineAt - RECOVERY_ATTEMPT_MS) fail('INVALID');
  const times = body.snapshotTimes as Record<string, { startedAt: number; recoverableAt: number; completedAt: number }>;
  if (!times || Object.keys(times).sort().join() !== 'auth,config,d1,r2' || Object.values(times).some(t => !t || Object.keys(t).sort().join() !== 'completedAt,recoverableAt,startedAt' || ![t.startedAt, t.recoverableAt, t.completedAt].every(v => Number.isSafeInteger(v) && v >= 0 && v <= now) || t.startedAt > t.recoverableAt || t.recoverableAt > t.completedAt)) fail('INVALID');
  const db = dbFor(env), all = [envelope.manifest, ...envelope.objects];
  await db.prepare(`UPDATE backup_runs SET phase='verifying' WHERE ${leaseWhere} AND consumed=1 AND phase='copying'`).bind(...leaseArgs(w, clock())).run();
  const { results } = await db.prepare('SELECT o.* FROM backup_objects o JOIN backup_run_objects r ON o.object_id=r.object_id WHERE r.backup_id=? ORDER BY o.object_id').bind(w.backupId).all<{ object_id: string; sha256: string; bytes: number; verified: number }>();
  if (results.length !== all.length || results.some(r => !r.verified || !all.some(o => o.id === r.object_id && o.sha256 === r.sha256 && o.bytes === r.bytes))) fail('READBACK');
  const minimum = Math.min(...Object.values(times).map(t => t.recoverableAt));
  const snapshot = JSON.stringify(Object.fromEntries(Object.entries(times).map(([k, t]) => [k, t.recoverableAt])));
  const committedAt = clock();
  // D1 may queue the batch after Worker time was bound. Its own clock is the last fence.
  // An explicitly supplied clock is for isolated deterministic callers, never request input.
  const finalFence = databaseClock ? leaseWhere.replaceAll('>?', ">MAX(?,CAST(unixepoch('subsec')*1000 AS INTEGER))") : leaseWhere;
  // Catalog insertion and final CAS share one transaction. A stale fence cannot publish a seal.
  await db.batch([
    db.prepare(`INSERT INTO backup_catalog(backup_id,sealed_at,recoverable_at,envelope,snapshot_times,prechange) SELECT backup_id,?,?,?,?,prechange FROM backup_runs WHERE ${finalFence} AND consumed=1 AND phase IN ('copying','verifying')`).bind(committedAt, minimum, JSON.stringify(envelope), snapshot, ...leaseArgs(w, committedAt)),
    db.prepare(`UPDATE backup_runs SET phase='sealed',active=0,finished_at=? WHERE ${leaseWhere} AND EXISTS(SELECT 1 FROM backup_catalog WHERE backup_id=?)`).bind(committedAt, ...leaseArgs(w, committedAt), w.backupId),
    db.prepare('UPDATE backup_objects SET refcount=(SELECT count(*) FROM backup_run_objects r JOIN backup_catalog c ON r.backup_id=c.backup_id WHERE r.object_id=backup_objects.object_id)'),
  ]);
  const saved = await db.prepare('SELECT backup_id FROM backup_catalog WHERE backup_id=?').bind(w.backupId).first();
  if (!saved) fail('FENCE');
  return reply(await recoveryStatus(env, now));
}
/** Only the SDK-authenticated singleton can call this host; no public forwarding. */
export async function handleRecoveryOutbound(request: Request, env: Env, ctx: { containerId: string; className: string }, now?: number): Promise<Response> {
  const initial = now ?? Date.now(), started = performance.now(), clock = () => initial + Math.floor(performance.now() - started);
  if (ctx.className !== 'SarinApp' || !env.SARIN_APP || ctx.containerId !== env.SARIN_APP.idFromName(SINGLETON_NAME).toString()) return reply({ code: 'DENIED' }, 403);
  if (request.url !== RECOVERY_ENDPOINT || request.method !== 'POST' || !configured(env)) return reply({ code: 'DENIED' }, 403);
  try {
    // Chunk uploads carry a small validated command header and a binary body.
    const header = request.headers.get('x-sarin-backup-command');
    if (header && header.length > 4096) fail('INVALID');
    const body = (header ? JSON.parse(header) : JSON.parse(new TextDecoder().decode(await recoveryBytes(request.body, 4 * 1024 * 1024, AbortSignal.timeout(30000))))) as Record<string, unknown>;
    if (!body || !validRecoveryWork(body.work) || typeof body.op !== 'string') fail('INVALID');
    const w = body.work, op = body.op;
    if (op === 'status') {
      const r = await dbFor(env).prepare('SELECT * FROM backup_runs WHERE backup_id=? AND fence=? AND nonce=?').bind(w.backupId, w.fence, w.nonce).first<Run>();
      if (!r) fail('FENCE');
      return reply({ ...await recoveryStatus(env, clock()), phase: r.phase });
    }
    const run = await liveRun(env, w, clock());
    const fields: Record<string, string[]> = { consume: [], heartbeat: [], fail: ['code'], 'export-start': [], 'export-poll': [], 'export-download': [], 'r2-read': ['reference'], 'archive-put': ['entry'], 'archive-get': ['id'], seal: ['envelope', 'snapshotTimes'] };
    if (!fields[op] || Object.keys(body).some(k => !['work', 'op', ...fields[op]].includes(k)) || header && op !== 'archive-put') fail('INVALID');
    if (op === 'consume') {
      const r = await dbFor(env).prepare(`UPDATE backup_runs SET consumed=1 WHERE ${leaseWhere} AND consumed=0`).bind(...leaseArgs(w, clock())).run();
      if (!changed(r)) fail('FENCE'); return reply({ ok: true });
    }
    if (!run.consumed) fail('FENCE');
    if (op === 'heartbeat') {
      const at = clock(); await dbFor(env).prepare(`UPDATE backup_runs SET heartbeat_at=? WHERE ${leaseWhere}`).bind(at, ...leaseArgs(w, at)).run(); return reply({ ok: true });
    }
    if (op === 'fail') { const codes = ['CAPTURE_FAILED', 'ENCRYPT_FAILED', 'CANCELLED', 'TIMEOUT', 'INCOMPLETE', 'EXECUTION_FAILED']; if (!codes.includes(String(body.code))) fail('INVALID'); await finishFailed(env, w, clock(), String(body.code)); return reply(await recoveryStatus(env, clock())); }
    if (op.startsWith('export-')) return await exportStep(env, w, run, op, clock());
    if (op === 'archive-put') return await archivePut(request, env, w, clock(), body.entry as CiphertextObject);
    if (op === 'archive-get') {
      const id = uuid(body.id), entry = await dbFor(env).prepare('SELECT o.* FROM backup_objects o JOIN backup_run_objects r ON r.object_id=o.object_id WHERE r.backup_id=? AND o.object_id=? AND o.verified=1').bind(w.backupId, id).first();
      if (!entry) fail('INVALID'); const object = await env.SARIN_BACKUPS!.get(objectKey(id)); if (!object) fail('READBACK');
      return new Response(object!.body, { headers: { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' } });
    }
    if (op === 'r2-read') {
      const r = body.reference as { key: string; byteLength: number; contentType: string; sha256: string };
      if (!r || Object.keys(r).sort().join() !== 'byteLength,contentType,key,sha256' || !recoveryHash(r.sha256) || !Number.isSafeInteger(r.byteLength) || r.byteLength < 1 || r.byteLength > RECOVERY_CHUNK_BYTES || !['image/jpeg', 'image/png', 'image/webp'].includes(r.contentType) || !new RegExp(`^(payment-images|business-logos)/${r.sha256}$`).test(r.key)) fail('INVALID');
      if (!await sourceObjectsPinned(env, now)) fail('FENCE');
      const obj = await env.SARIN_FILES?.get(r.key); if (!obj || obj.size !== r.byteLength || obj.httpMetadata?.contentType !== r.contentType) fail('R2');
      return new Response(obj!.body, { headers: { 'Content-Type': r.contentType, 'Cache-Control': 'no-store' } });
    }
    return await seal(env, w, body, clock, now === undefined);
  } catch (error) {
    const code = /^RECOVERY_([A-Z_]+)$/.exec(error instanceof Error ? error.message : '')?.[1] ?? 'UNAVAILABLE';
    return reply({ code }, code === 'FENCE' ? 409 : ['INVALID', 'DENIED'].includes(code) ? 400 : code === 'LIMIT' ? 413 : 503);
  }
}

type RetentionSet = { backupId: string; sealedAt: number; recoverableAt: number; prechange: boolean; objects: { id: string; bytes: number }[] };
type FailedSet = { backupId: string; finishedAt: number; objects: { id: string; bytes: number }[] };
function bogota(at: number): string { return new Date(at - 5 * 3600000).toISOString().slice(0, 10); }
function isoWeek(day: string): string {
  const d = new Date(day + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const year = d.getUTCFullYear(), start = new Date(Date.UTC(year, 0, 1));
  return `${year}-W${String(Math.ceil(((d.getTime() - start.getTime()) / 86400000 + 1) / 7)).padStart(2, '0')}`;
}
export function planRecoveryRetention(sets: RetentionSet[], failed: FailedSet[], now: number) {
  const sorted = [...sets].sort((a, b) => b.recoverableAt - a.recoverableAt || b.sealedAt - a.sealedAt), categories: Record<string, string[]> = Object.fromEntries(sets.map(s => [s.backupId, []]));
  const days = [...new Set(sorted.map(s => bogota(s.recoverableAt)))].slice(0, 7);
  for (const day of days) categories[sorted.find(s => bogota(s.recoverableAt) === day)!.backupId].push('daily');
  const today = bogota(now), weeks = Array.from({ length: 4 }, (_, i) => isoWeek(bogota(now - i * 7 * 86400000)));
  const monthStart = new Date(today.slice(0, 7) + '-01T00:00:00Z');
  const months = Array.from({ length: 3 }, (_, i) => new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() - i, 1)).toISOString().slice(0, 7));
  const gaps = { weeks: [] as string[], months: [] as string[] };
  for (const week of weeks) {
    const s = sorted.find(s => isoWeek(bogota(s.recoverableAt)) === week && new Date(bogota(s.recoverableAt) + 'T00:00:00Z').getUTCDay() === 1);
    if (s) categories[s.backupId].push('weekly'); else gaps.weeks.push(week);
  }
  for (const month of months) { const s = sorted.find(s => bogota(s.recoverableAt).startsWith(month)); if (s) categories[s.backupId].push('monthly'); else gaps.months.push(month); }
  for (const s of sorted) if (s.prechange && now - s.sealedAt < 7 * 86400000) categories[s.backupId].push('prechange');
  if (sorted.length) categories[sorted[0].backupId].push('last-usable');
  const keep = sets.filter(s => categories[s.backupId].length).map(s => s.backupId), remove = sets.filter(s => !categories[s.backupId].length).map(s => s.backupId);
  const expired = failed.filter(s => now - s.finishedAt >= 48 * 3600000), summaries = failed.filter(s => now - s.finishedAt >= 30 * 86400000).map(s => s.backupId);
  const pinned = new Set([...sets.filter(s => keep.includes(s.backupId)), ...failed.filter(s => !expired.includes(s))].flatMap(s => s.objects.map(o => o.id)));
  const objects = [...new Map([...sets.filter(s => remove.includes(s.backupId)), ...expired].flatMap(s => s.objects).filter(o => !pinned.has(o.id)).map(o => [o.id, o])).values()];
  return { dryRun: true, keep, remove, failed: expired.map(s => s.backupId), summaries, categories, gaps, objects, bytes: objects.reduce((s, o) => s + o.bytes, 0) };
}
export async function cleanupRecoveryBackups(env: Env, now = Date.now(), dryRun = true) {
  if (!enabled(env) || !env.SARIN_RECOVERY_DB) return { ...planRecoveryRetention([], [], now), disabled: true };
  const db = dbFor(env), catalogs = (await db.prepare('SELECT * FROM backup_catalog').all<Catalog>()).results;
  const refs = (await db.prepare('SELECT r.backup_id,o.object_id,o.bytes FROM backup_run_objects r JOIN backup_objects o ON o.object_id=r.object_id').all<{ backup_id: string; object_id: string; bytes: number }>()).results;
  const objects = (id: string) => refs.filter(r => r.backup_id === id).map(r => ({ id: r.object_id, bytes: r.bytes }));
  const failures = (await db.prepare("SELECT backup_id,finished_at FROM backup_runs WHERE phase='failed' AND finished_at IS NOT NULL").all<{ backup_id: string; finished_at: number }>()).results;
  const plan = planRecoveryRetention(catalogs.map(c => ({ backupId: c.backup_id, sealedAt: c.sealed_at, recoverableAt: c.recoverable_at, prechange: !!c.prechange, objects: objects(c.backup_id) })), failures.map(f => ({ backupId: f.backup_id, finishedAt: f.finished_at, objects: objects(f.backup_id) })), now);
  if (dryRun || env.SARIN_BACKUP_CLEANUP_ENABLED !== 'true' || !env.SARIN_BACKUPS || await sourceObjectsPinned(env, now)) return plan;
  // Delete references first. Any uncertain storage delete leaves an indexed orphan for retry.
  for (const id of [...plan.remove, ...plan.failed]) {
    await db.batch([db.prepare('DELETE FROM backup_catalog WHERE backup_id=?').bind(id), db.prepare('DELETE FROM backup_run_objects WHERE backup_id=?').bind(id), db.prepare('UPDATE backup_runs SET artifacts_cleaned=1 WHERE backup_id=?').bind(id)]);
  }
  await db.prepare('UPDATE backup_objects SET refcount=(SELECT count(*) FROM backup_run_objects r WHERE r.object_id=backup_objects.object_id)').run();
  const orphaned = (await db.prepare('SELECT object_id FROM backup_objects WHERE refcount=0 AND NOT EXISTS(SELECT 1 FROM backup_run_objects r WHERE r.object_id=backup_objects.object_id)').all<{ object_id: string }>()).results;
  for (const o of orphaned) { await env.SARIN_BACKUPS.delete(objectKey(o.object_id)); await db.prepare('DELETE FROM backup_objects WHERE object_id=? AND refcount=0').bind(o.object_id).run(); }
  for (const id of plan.summaries) await db.prepare('DELETE FROM backup_runs WHERE backup_id=? AND artifacts_cleaned=1').bind(id).run();
  return { ...plan, dryRun: false };
}
