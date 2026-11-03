import type { DataCommand, DataCommitResult } from '../../shared/data-protocol.ts';
import { isDataPath } from '../../shared/data-protocol.ts';
import { assertRecoveryAdmission, recoveryRestricted, type RecoveryApproval, type WitnessCoverage, type WitnessIntent } from '../../shared/recovery-admission.ts';

type Env = RecoveryBindings & { SARIN_DB?: D1Database };
type Commit = Extract<DataCommand, { action: 'commit' }>;
type Intent = { intentId: string; coveredRevision: number; fingerprint: string };
type Row = { request_id: string; fingerprint: string; covered_revision: number; revision: number | null; status: 'pending' | 'complete'; scopes: string };
const fail = (): never => { throw new Error('RECOVERY_WITNESS'); };
const validRevision = (n: number) => Number.isSafeInteger(n) && n >= 0;
function database(env: Env): D1Database {
  if (!env.SARIN_RECOVERY_DB || env.SARIN_RECOVERY_DB === env.SARIN_DB || !/^[a-f0-9]{64}$/.test(env.SARIN_RECOVERY_RESOURCE_ID ?? '')) fail();
  return env.SARIN_RECOVERY_DB!;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
async function start(env: Env) {
  const row = await database(env).prepare('SELECT * FROM recovery_witness_start WHERE id=1').first<{ resource_id: string; start_revision: number; started_at: number }>();
  if (!row || row.resource_id !== env.SARIN_RECOVERY_RESOURCE_ID || !validRevision(row.start_revision) || !validRevision(row.started_at)) fail();
  return row!;
}
/** Coverage starts only at an operator-prepared marker; never infer lost history from SQL. */
export async function prepareRecoveryWitness(command: Commit, env: Env): Promise<Intent | null> {
  if (env.SARIN_WITNESS_ENABLED !== 'true') { if (env.SARIN_BACKUP_ENABLED === 'true') fail(); return null; }
  const marker = await start(env);
  if (!validRevision(command.expectedRevision) || command.expectedRevision < marker.start_revision) fail();
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(command)));
  const fingerprint = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
  // Conservatively invalidate every touched path, including unknown future authorization fields.
  const scopes = command.writes.map(w => ({ path: w.path, reason: w.op === 'delete' ? 'delete' : 'mutation' }));
  await database(env).prepare("INSERT OR IGNORE INTO recovery_invalidations(request_id,fingerprint,covered_revision,created_at,scopes,status) VALUES(?,?,?,?,?,'pending')").bind(command.requestId, fingerprint, command.expectedRevision, Date.now(), JSON.stringify(scopes)).run();
  const row = await database(env).prepare('SELECT * FROM recovery_invalidations WHERE request_id=?').bind(command.requestId).first<Row>();
  if (!row || row.fingerprint !== fingerprint || row.covered_revision !== command.expectedRevision) fail();
  return { intentId: command.requestId, coveredRevision: command.expectedRevision, fingerprint };
}
export async function completeRecoveryWitness(intent: Intent | null, result: DataCommitResult, env: Env): Promise<void> {
  if (!intent) return;
  if (result.revision !== intent.coveredRevision + 1) fail();
  const r = await database(env).prepare("UPDATE recovery_invalidations SET status='complete',revision=? WHERE request_id=? AND fingerprint=? AND covered_revision=? AND (status='pending' OR revision=?)").bind(result.revision, intent.intentId, intent.fingerprint, intent.coveredRevision, result.revision).run();
  if (!r.meta.changes) fail();
}
export async function readRecoveryWitness(env: Env, { fromRevision, toRevision }: { fromRevision: number; toRevision: number }): Promise<WitnessCoverage> {
  const result: WitnessCoverage = { complete: false, resourceId: env.SARIN_RECOVERY_RESOURCE_ID ?? '', fromRevision, toRevision, startedAt: 0, observedAt: Date.now(), gaps: [], intents: [] };
  try {
    const marker = await start(env), db = database(env);
    result.startedAt = marker.started_at;
    if (!validRevision(fromRevision) || !validRevision(toRevision) || fromRevision < marker.start_revision || toRevision < fromRevision) fail();
    const prior = await db.prepare("SELECT count(*) AS n,count(DISTINCT revision) AS distinct_n FROM recovery_invalidations WHERE status='complete' AND revision>? AND revision<=?").bind(marker.start_revision, fromRevision).first<{ n: number; distinct_n: number }>();
    if (!prior || prior.n !== fromRevision - marker.start_revision || prior.distinct_n !== prior.n) result.gaps.push('PRE_SNAPSHOT_GAP');
    // Do not truncate an interval and call it covered. Large histories need paged reconciliation.
    const rows = (await db.prepare("SELECT * FROM recovery_invalidations WHERE status='pending' OR revision>? ORDER BY covered_revision,request_id LIMIT 10001").bind(fromRevision).all<Row>()).results;
    if (rows.length > 10000) fail();
    const revisions = new Set<number>();
    for (const row of rows) {
      const scopes = JSON.parse(row.scopes) as WitnessIntent['scopes'];
      if (!Array.isArray(scopes) || scopes.some(s => !isDataPath(s.path, true) || !['delete', 'mutation'].includes(s.reason)) || !validRevision(row.covered_revision) || !/^[a-f0-9]{64}$/.test(row.fingerprint)) fail();
      result.intents.push({ intentId: row.request_id, coveredRevision: row.covered_revision, revision: row.revision, status: row.status, scopes });
      if (row.status !== 'complete') result.gaps.push('PENDING_INTENT');
      else if (row.revision !== row.covered_revision + 1 || row.revision > toRevision || revisions.has(row.revision)) fail();
      else revisions.add(row.revision);
    }
    if (revisions.size !== toRevision - fromRevision) result.gaps.push('REVISION_GAP');
    result.complete = result.gaps.length === 0;
  } catch { result.gaps.push('WITNESS_UNAVAILABLE'); }
  return result;
}
/** Gate record is private, outside restored SQL, and has no public write endpoint. */
export async function recoveryAdmissionAllowed(env: Env): Promise<boolean> {
  if (!recoveryRestricted(env)) return true;
  if (env.SARIN_RECOVERY_MODE !== 'recovery' || env.SARIN_WITNESS_ENABLED !== 'true' || !env.SARIN_DB) return false;
  try {
    const row = await database(env).prepare('SELECT approval FROM recovery_admission WHERE resource_id=?').bind(env.SARIN_RECOVERY_RESOURCE_ID).first<{ approval: string }>();
    if (!row) return false;
    const approval = JSON.parse(row.approval) as RecoveryApproval;
    const coverage = await readRecoveryWitness(env, { fromRevision: approval.fromRevision, toRevision: approval.toRevision });
    assertRecoveryAdmission({ candidateSha: env.SARIN_RECOVERY_CANDIDATE_SHA ?? '', manifestSha256: env.SARIN_RECOVERY_MANIFEST_SHA ?? '', reconciliationSha: env.SARIN_RECOVERY_RECONCILIATION_SHA ?? '', resourceId: env.SARIN_RECOVERY_RESOURCE_ID ?? '', coverage, mode: 'recovery', approval });
    const revision = await env.SARIN_DB.prepare('SELECT revision FROM app_revision WHERE id=1').first<{ revision: number }>();
    return revision?.revision === approval.toRevision;
  } catch { return false; }
}
export async function assertBackupWitness(env: Env, fromRevision?: number): Promise<WitnessCoverage> {
  if (env.SARIN_WITNESS_ENABLED !== 'true' || recoveryRestricted(env) || !env.SARIN_DB) fail();
  await start(env);
  const current = await env.SARIN_DB!.prepare('SELECT revision FROM app_revision WHERE id=1').first<{ revision: number }>();
  if (!current) fail();
  const coverage = await readRecoveryWitness(env, { fromRevision: fromRevision ?? current!.revision, toRevision: current!.revision });
  if (!coverage.complete) fail();
  return coverage;
}
