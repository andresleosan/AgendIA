import { afterAll, beforeAll, expect, it } from 'vitest';
import { mkdtemp, rm, mkdir, copyFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

let root: string, report: any;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'sarin-drill-test-'));
  const { runRecoveryDrill } = await import('../scripts/recovery-drill.mjs');
  report = await runRecoveryDrill({ directory: join(root, 'new-private-drill'), fixture: 'demo-sarin-recovery-v1' });
}, 180000);
afterAll(async () => {
  if (root) { expect(dirname(resolve(root))).toBe(resolve(tmpdir())); await rm(root, { recursive: true, force: true }); }
});
it('full_synthetic_restore_preserves_journal_and_authority', () => {
  expect(report).toMatchObject({ ok: true, synthetic: true, localOnly: true, remoteMutations: false, recovery: 'partial_closed', admission: false });
  expect(report.restore).toMatchObject({ revision: 7, integrity: 'ok', r2: { objects: 1, verified: true } });
  expect(report.migrations).toHaveLength(13);
  expect(report.indexes).toEqual(expect.arrayContaining(['app_response_quota_pending', 'app_response_quota_discovery', 'app_client_page_ascending', 'app_client_page_status_ascending', 'app_client_page_status_descending']));
  expect(report.restore.tables.app_commits.count).toBe(1);
  expect(report.measurements.oldestComponentAgeMs).toBeGreaterThanOrEqual(0);
  expect(report.measurements.ciphertextBytes).toBeGreaterThan(0);
  expect(report.measurements.rtoProductionProven).toBe(false);
});
it('missing_or_altered_object_private_event_and_format_fail', () => {
  for (const id of ['sql_tamper', 'manifest_tamper', 'object_missing', 'object_altered', 'private_event_missing', 'wrong_key', 'missing_key', 'ciphertext_truncated', 'config_incomplete']) expect(report.cases[id]).toBe('pass');
});
it('post_snapshot_revocation_deletion_withdrawal_fail_closed', () => {
  for (const id of ['witness_missing', 'post_snapshot_invalidations', 'consent_withdrawn', 'deleted_and_expired', 'cancelled_offer_invalid_proposal', 'auth_fresh_login_no_role']) expect(report.cases[id]).toBe('pass');
  expect(report.blockers).toEqual(expect.arrayContaining(['INVALIDATIONS_REQUIRE_APPLICATION', 'SYNTHETIC_ONLY', 'OPERATIONAL_APPROVAL_REQUIRED']));
});
it('snapshot before admission cutover cannot roll back the marker or policy restrictions', async () => {
  const { buildRecoveryReconciliation } = await import('../scripts/lib/recovery-reconcile.mjs');
  const { recoveryManifest, recoverySql, recoverySha, recoveryMigrations } = await import('./recovery-backup-fixtures');
  const { sanitizeBackupSql } = await import('../scripts/lib/recovery-backup.mjs');
  const now = Date.parse('2030-01-01T12:00:00Z'), manifest = recoveryManifest(sanitizeBackupSql({ sql: recoverySql(), now, sourceSha: recoverySha, migrations: recoveryMigrations }).sanitization);
  const paths = ['serverSettings/bookingAdmissionProtocol', `serverSettings/booking_policy_${'a'.repeat(64)}`, `serverSettings/booking_dispatch_${'b'.repeat(64)}`];
  const witness = { complete: true, gaps: [], resourceId: 'a'.repeat(64), startedAt: 0, observedAt: now, fromRevision: manifest.d1Revision, toRevision: manifest.d1Revision + 1, intents: [{ status: 'complete', scopes: paths.map(path => ({ path, reason: 'mutation' })) }] };
  const plan = buildRecoveryReconciliation({ manifest, witness, currentAuth: null, now });
  expect(plan.bookingAdmission).toMatchObject({ minimumReader: 2, requiredRelease: 'enforce', preserveOutsideSnapshot: paths });
  expect(plan.blockers).toContain('BOOKING_ADMISSION_FLOOR_REQUIRED');
  expect(plan.canAdmit).toBe(false);
  const empty = buildRecoveryReconciliation({ manifest, witness: null, currentAuth: null, now });
  expect(empty.bookingAdmission).toMatchObject({ minimumReader: 2, requiredRelease: 'enforce', initializeBeforeWrites: true });
});
it('unknown_job_and_later_receipt_no_second_effect', () => {
  expect(report.cases.producers_disabled).toBe('pass');
  expect(report.cases.uncertain_quota_and_later_receipt).toBe('pass');
  expect(report.cases.post_snapshot_receipt).toBe('pass');
  expect(report.cases.team_domain_before_after_reconciliation).toBe('pass');
  expect(report.cases.effect_spies_tripwire).toBe('pass');
  expect(report.effects).toEqual({ inference: 0, send: 0, payment: 0, automaticQuotaRelease: 0, network: 0 });
  expect(report.unmeasuredEffects).toEqual(['financial_refund_no_product_api']);
});
it('refuses reused directories and unknown fixtures before starting any work', async () => {
  const { runRecoveryDrill } = await import('../scripts/recovery-drill.mjs');
  await expect(runRecoveryDrill({ directory: root, fixture: 'demo-sarin-recovery-v1' })).rejects.toThrow();
  await expect(runRecoveryDrill({ directory: join(root, 'bad'), fixture: 'production' })).rejects.toThrow('RECOVERY_DRILL_ARGUMENTS');
});
it('checks the pinned key generator before executing it', async () => {
  const drill = await import('../scripts/recovery-drill.mjs');
  expect(typeof drill.verifyDrillTools).toBe('function');
  const age = process.env.SARIN_TEST_AGE_PATH ?? (process.platform === 'win32' ? join(process.env.LOCALAPPDATA!, 'SarinBot/tooling/age-1.3.2/windows/age/age.exe') : '/usr/local/bin/age');
  const tools = join(root, 'bad-tools'); await mkdir(tools);
  const candidate = join(tools, process.platform === 'win32' ? 'age.exe' : 'age'); await copyFile(age, candidate);
  await writeFile(join(tools, process.platform === 'win32' ? 'age-keygen.exe' : 'age-keygen'), 'tampered');
  await expect(drill.verifyDrillTools(candidate)).rejects.toThrow('RECOVERY_DRILL_KEYGEN');
});
it('runs the standalone CLI with the native Node loader outside Vite', async () => {
  const { stdout } = await promisify(execFile)(process.execPath, ['scripts/recovery-drill.mjs', '--synthetic', '--directory', join(root, 'standalone-cli')], { cwd: process.cwd(), timeout: 180000, windowsHide: true });
  expect(JSON.parse(stdout)).toMatchObject({ ok: true, synthetic: true, admission: false, recovery: 'partial_closed' });
}, 180000);
