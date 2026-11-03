export type WitnessIntent = { intentId: string; coveredRevision: number; revision: number | null; status: 'pending' | 'complete'; scopes: { path: string; reason: 'delete' | 'mutation' }[] };
export type WitnessCoverage = { complete: boolean; resourceId: string; fromRevision: number; toRevision: number; startedAt: number; observedAt: number; gaps: string[]; intents: WitnessIntent[] };
export type RecoveryApproval = { candidateSha: string; manifestSha256: string; reconciliationSha: string; resourceId: string; fromRevision: number; toRevision: number; approvedAt: number; expiresAt: number; currentAuthAt: number; blockers: number; operationId: string };
export const recoveryRestricted = (env: { SARIN_RECOVERY_MODE?: unknown }) => env.SARIN_RECOVERY_MODE !== undefined && env.SARIN_RECOVERY_MODE !== 'normal';
const hash = (v: unknown, length: number) => typeof v === 'string' && new RegExp(`^[a-f0-9]{${length}}$`).test(v);
export function assertRecoveryAdmission(input: { candidateSha: string; manifestSha256: string; reconciliationSha: string; resourceId: string; coverage: WitnessCoverage; mode: string; approval?: RecoveryApproval | null; now?: number }): void {
  const { coverage: c, approval: a } = input, now = input.now ?? Date.now();
  if (input.mode !== 'recovery' || !hash(input.candidateSha, 40) || !hash(input.manifestSha256, 64) || !hash(input.reconciliationSha, 64) || !hash(input.resourceId, 64) || !c?.complete || c.gaps.length || c.resourceId !== input.resourceId || !a
    || a.candidateSha !== input.candidateSha || a.manifestSha256 !== input.manifestSha256 || a.reconciliationSha !== input.reconciliationSha || a.resourceId !== input.resourceId || a.toRevision !== c.toRevision || a.fromRevision !== c.fromRevision || a.blockers !== 0
    || !Number.isSafeInteger(a.approvedAt) || !Number.isSafeInteger(a.expiresAt) || !Number.isSafeInteger(a.currentAuthAt) || a.approvedAt > now || a.expiresAt <= now || a.expiresAt > a.approvedAt + 15 * 60000
    || a.currentAuthAt > a.approvedAt || a.currentAuthAt < now - 15 * 60000 || c.observedAt > now || c.observedAt < now - 60000 || !/^[A-Za-z0-9_-]{1,128}$/.test(a.operationId)) throw new Error('RECOVERY_ADMISSION');
}
