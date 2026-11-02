import type { Database } from '@/lib/storage/types';

export const quotaProtocolFixture = { version: 2, minimumWriterProtocol: 2, sourceSha: 'a'.repeat(40), oldWriterStoppedAt: 1, reviewArtifactSha256: 'b'.repeat(64) };
export const quotaProtocolEntries = { 'serverSettings/responseQuotaProtocol': quotaProtocolFixture };
export async function seedQuotaProtocol(db: Database) {
  const ref = db.collection('serverSettings').doc('responseQuotaProtocol');
  if (!(await ref.get()).exists) await ref.set(quotaProtocolFixture);
}
