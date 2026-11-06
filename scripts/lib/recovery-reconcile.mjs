import { canonicalJson, sha256 } from './data-migration.mjs';
import { validateBackupManifest } from './recovery-backup.mjs';
import { isDataPath } from '../../shared/data-protocol.ts';
export { assertRecoveryAdmission } from '../../shared/recovery-admission.ts';

/** Produces a restrictive review plan, never permission to execute it or repeat effects. */
export function buildRecoveryReconciliation({ manifest, witness, currentAuth, now }) {
  const blockers = [], invalidations = [];
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(manifest?.d1Revision) || manifest.d1Revision < 0 || !/^[a-f0-9]{40}$/.test(manifest?.sourceSha ?? '')) throw Error('RECOVERY_RECONCILIATION');
  try { validateBackupManifest(manifest, { sourceSha: manifest.sourceSha, migrations: manifest.migrations, protocols: manifest.protocols }); } catch { throw Error('RECOVERY_RECONCILIATION'); }
  const stamp = v => Number.isSafeInteger(v) && v >= 0;
  if (witness && (!stamp(witness.startedAt) || !stamp(witness.observedAt) || !stamp(witness.fromRevision) || !stamp(witness.toRevision) || witness.toRevision < witness.fromRevision || !/^[a-f0-9]{64}$/.test(witness.resourceId ?? '') || !Array.isArray(witness.gaps) || !Array.isArray(witness.intents))) throw Error('RECOVERY_RECONCILIATION');
  if (!witness?.complete || witness.gaps?.length || witness.fromRevision !== manifest.d1Revision || !Number.isSafeInteger(witness.startedAt) || witness.startedAt > manifest.snapshotTimes?.d1?.recoverableAt || witness.observedAt > now || witness.observedAt < now - 60000) blockers.push('WITNESS_INCOMPLETE');
  for (const intent of witness?.intents ?? []) {
    if (!['pending', 'complete'].includes(intent.status) || !Array.isArray(intent.scopes) || intent.scopes.some(s => !isDataPath(s.path, true) || !['delete', 'mutation'].includes(s.reason))) throw Error('RECOVERY_RECONCILIATION');
    if (intent.status !== 'complete') blockers.push('PENDING_INTENT');
    for (const scope of intent.scopes) invalidations.push({ path: scope.path, reason: scope.reason });
  }
  const authCurrent = currentAuth?.complete === true && currentAuth.resourceId === witness?.resourceId && currentAuth.requiresNewLogin === true && currentAuth.iamVerified === true && Number.isSafeInteger(currentAuth.observedAt) && currentAuth.observedAt <= now && currentAuth.observedAt >= now - 15 * 60000 && Array.isArray(currentAuth.invalidatedUids) && currentAuth.invalidatedUids.every(uid => typeof uid === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(uid));
  if (!authCurrent) blockers.push('CURRENT_AUTH_REQUIRED');
  if (invalidations.length) blockers.push('INVALIDATIONS_REQUIRE_APPLICATION');
  // A snapshot cannot prove that a later cutover or restrictive revision never existed.
  blockers.push('BOOKING_ADMISSION_FLOOR_REQUIRED');
  const bookingAdmission = { minimumReader: 2, requiredRelease: 'enforce', recoveryCompatible: true, initializeBeforeWrites: true,
    preserveOutsideSnapshot: [...new Set(['serverSettings/bookingAdmissionProtocol', ...invalidations.map(scope => scope.path).filter(path => /^serverSettings\/booking_(?:policy_|dispatch_)/.test(path))])] };
  const plan = { formatVersion: 1, candidateSha: manifest.sourceSha, manifestSha256: sha256(canonicalJson(manifest)), witnessSha256: witness ? sha256(canonicalJson(witness)) : null, currentAuthoritySha256: authCurrent ? sha256(canonicalJson(currentAuth)) : null, resourceId: witness?.resourceId ?? null, fromRevision: manifest.d1Revision, toRevision: witness?.toRevision ?? null, createdAt: now,
    invalidations, bookingAdmission, blockedUids: authCurrent ? [...currentAuth.invalidatedUids] : [], blockers: [...new Set(blockers)], effectsEnabled: false, uncertainEffects: 'preserve_without_retry', canAdmit: false };
  return { ...plan, reconciliationSha: sha256(canonicalJson(plan)) };
}
