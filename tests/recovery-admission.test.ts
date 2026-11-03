import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildRecoveryReconciliation, assertRecoveryAdmission } from '../scripts/lib/recovery-reconcile.mjs';
import { createCloudflareDatabase } from '../src/lib/storage/database';
import type { WitnessCoverage } from '../shared/recovery-admission';
import { recoverySql, recoveryManifest, recoveryMigrations, recoverySha } from './recovery-backup-fixtures';
import { sanitizeBackupSql } from '../scripts/lib/recovery-backup.mjs';

const sha = recoverySha, hash = 'b'.repeat(64), now = Date.now();
const witness: WitnessCoverage = { complete: true, resourceId: hash, fromRevision: 7, toRevision: 8, startedAt: 0, observedAt: now, gaps: [], intents: [{ intentId: 'demo', coveredRevision: 7, revision: 8, status: 'complete', scopes: [{ path: 'businesses/demo/teamAccessEvents/user', reason: 'mutation' }] }] };
const manifest = recoveryManifest(sanitizeBackupSql({ sql: recoverySql(), now, sourceSha: sha, migrations: recoveryMigrations }).sanitization);
const currentAuth = { complete: true, observedAt: now, resourceId: hash, requiresNewLogin: true, iamVerified: true, invalidatedUids: ['demo-user'] };
afterEach(() => vi.unstubAllEnvs());
describe('recovery reconciliation and admission', () => {
  it('keeps post-snapshot revocations and pending intents restrictive without granting permission', () => {
    const result = buildRecoveryReconciliation({ manifest, witness, currentAuth, now });
    expect(result.invalidations).toContainEqual({ path: 'businesses/demo/teamAccessEvents/user', reason: 'mutation' });
    expect(result.blockedUids).toEqual(['demo-user']);
    expect(result.canAdmit).toBe(false); expect(result.effectsEnabled).toBe(false);
    expect(buildRecoveryReconciliation({ manifest, witness: { ...witness, complete: false }, currentAuth, now }).blockers).toContain('WITNESS_INCOMPLETE');
    expect(buildRecoveryReconciliation({ manifest, witness, currentAuth: null, now }).blockers).toContain('CURRENT_AUTH_REQUIRED');
  });
  it('binds admission to candidate, reconciliation, resources, complete current coverage and explicit operation', () => {
    const input = { candidateSha: sha, manifestSha256: hash, reconciliationSha: hash, coverage: witness, mode: 'recovery', now, resourceId: hash, approval: { candidateSha: sha, manifestSha256: hash, reconciliationSha: hash, resourceId: hash, fromRevision: 7, toRevision: 8, approvedAt: now, expiresAt: now + 60000, blockers: 0, currentAuthAt: now, operationId: 'demo-approved' } };
    expect(() => assertRecoveryAdmission(input)).not.toThrow();
    for (const changed of [{ approval: null }, { candidateSha: 'c'.repeat(40) }, { resourceId: 'd'.repeat(64) }, { now: now + 60000 }, { coverage: { ...witness, complete: false } }, { approval: { ...input.approval, blockers: 1 } }, { approval: { ...input.approval, toRevision: 1 } }]) expect(() => assertRecoveryAdmission({ ...input, ...changed })).toThrow('RECOVERY_ADMISSION');
  });
  it('recovery mode refuses application writes before transport even with a fresh login', async () => {
    vi.stubEnv('SARIN_RECOVERY_MODE', 'recovery');
    const transport = vi.fn(async () => ({ revision: 0, documents: [] }));
    const db = createCloudflareDatabase(transport);
    await expect(db.collection('businesses').doc('demo').set({ ownerUid: 'recent-login' })).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
  });
  it('binds reconciliation to the concrete backup and rejects missing freshness evidence', () => {
    const first = buildRecoveryReconciliation({ manifest, witness: { ...witness, intents: [] }, currentAuth, now });
    const second = buildRecoveryReconciliation({ manifest: { ...manifest, backupId: crypto.randomUUID(), components: manifest.components.map(c => ({ ...c, ciphertextSha256: 'd'.repeat(64) })) }, witness: { ...witness, intents: [] }, currentAuth, now });
    expect(first.reconciliationSha).not.toBe(second.reconciliationSha);
    expect(() => buildRecoveryReconciliation({ manifest: { ...manifest, snapshotTimes: {} }, witness: { ...witness, observedAt: undefined }, currentAuth, now })).toThrow('RECOVERY_RECONCILIATION');
  });
});
