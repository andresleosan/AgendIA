import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { canonicalJson, sha256, sqlQuote } from '../scripts/lib/data-migration.mjs';

export const recoveryNow = 1_793_659_200_000;
export const recoverySha = 'e20d602e17f8a57b4d935bba8ce6f8411f042574';
export const recoveryMigrations = readdirSync(new URL('../cloudflare/migrations/', import.meta.url)).filter(name => /^\d+.*\.sql$/.test(name)).sort().map(name => ({ path: `cloudflare/migrations/${name}`, sha256: sha256(readFileSync(new URL(`../cloudflare/migrations/${name}`, import.meta.url))) }));
export const recoveryAppointment = {
  id: 'demo-appointment', tenantId: 'demo-business', dateKey: '2026-11-02', startAt: recoveryNow, endAt: recoveryNow + 1800000, reservedUntilAt: recoveryNow + 1800000,
  startTimeStr: '09:00', endTimeStr: '09:30', type: 'appointment', resourceId: 'demo-resource', serviceId: 'demo-service', serviceName: 'Consulta demo', price: 1000,
  client: { uid: 'demo-adult', name: 'Adulto demo', email: 'demo@example.invalid', intakeAnswers: { symptoms: 'PRIVATE_INTAKE_SENTINEL' } },
  beneficiary: { kind: 'represented_minor', displayName: 'Menor demo', representativeRole: 'parent' }, subjectAuthorization: { receiptId: 'demo-receipt', bookingRequestId: 'demo-request', policyRevision: 1 },
  status: 'confirmed', createdBy: 'manual_panel', createdAt: recoveryNow - 1000,
};
export const recoveryTeamEvent = {
  version: 1, id: 'demo-private-event', businessId: 'demo-business', membershipId: 'demo-membership', memberUid: 'demo-member', actorUid: 'demo-owner', requestId: 'demo-revoke', commandHash: 'a'.repeat(64),
  command: { kind: 'revoke', businessId: 'demo-business', actorUid: 'demo-owner', requestId: 'demo-revoke', expectedMembershipRevision: 1, expectedTeamRevision: 1, resourceId: null },
  sequence: 2, membershipRevision: 2, recordedAt: recoveryNow, beforeStatus: 'active', afterStatus: 'revoked', role: { id: 'own_agenda_viewer', version: 1 }, resourceId: 'demo-chair',
};
export function recoverySql(documents: { path: string; data: unknown; blob?: unknown }[] = []) {
  const db = new DatabaseSync(':memory:', { allowExtension: false });
  try {
    for (const migration of recoveryMigrations) db.exec(readFileSync(new URL(`../${migration.path}`, import.meta.url), 'utf8'));
    const schema = db.prepare("SELECT type,name,sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { type: string; name: string; sql: string }[];
    const statements = schema.filter(row => row.type === 'table').map(row => `${row.sql};`);
    statements.push('INSERT INTO app_revision VALUES(1,7);');
    statements.push(`INSERT INTO app_commits VALUES('demo-commit','${'a'.repeat(64)}',7,${recoveryNow});`);
    for (const doc of documents) {
      const parts = doc.path.split('/');
      statements.push(`INSERT INTO app_documents VALUES(${[doc.path, parts.slice(0, -1).join('/'), parts.at(-1)!, canonicalJson(doc.data)].map(sqlQuote).join(',')},${recoveryNow},${doc.blob ? sqlQuote(canonicalJson(doc.blob)) : 'NULL'});`);
    }
    statements.push(...schema.filter(row => row.type !== 'table').map(row => `${row.sql};`));
    return Buffer.from(statements.join('\n'));
  } finally { db.close(); }
}
export function recoveryManifest(snapshot: Record<string, any>) {
  const component = (kind: string) => ({ id: crypto.randomUUID(), kind, ciphertextSha256: 'b'.repeat(64), bytes: 100, plaintextSha256: kind === 'd1' ? snapshot.sqlSha256 : kind === 'auth' ? 'd'.repeat(64) : kind === 'config' ? 'e'.repeat(64) : 'c'.repeat(64), classification: 'private' });
  return { formatVersion: 1, backupId: crypto.randomUUID(), sourceSha: recoverySha, migrations: recoveryMigrations, protocols: { quota: 2 },
    snapshotTimes: Object.fromEntries(['d1', 'r2', 'auth', 'config'].map(key => [key, { startedAt: recoveryNow - 1000, completedAt: recoveryNow, recoverableAt: recoveryNow - 1000 }])),
    d1Revision: 7, components: ['d1', 'r2', 'auth', 'config'].map(component), r2References: snapshot.r2References, exclusionVersion: 1, sanitization: snapshot,
    auth: { complete: true, batchId: 'demo-auth', sha256: 'd'.repeat(64) }, config: { complete: true, batchId: 'demo-config', sha256: 'e'.repeat(64) } };
}
