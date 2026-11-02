import 'server-only';
import type { Database } from '@/lib/storage/types';
import { planQuotaRecovery, quarantineQuotaTurn, quotaRecoveryCursorSchema, emptyQuotaCursor, runQuotaRecoveryPage } from '../../../shared/response-quota-recovery';
import { quotaProtocolSchema } from '../../../shared/response-quota-records';
import { parseStoredQuotaTurn, prepareResponseQuotaSettlement, applyResponseQuotaStage } from './response-quota-store';
import { HttpError } from './http';

export async function recoverResponseQuotaBatch(db: Database, now = Date.now()) {
  const marker = (await db.collection('serverSettings').doc('responseQuotaProtocol').get()).data();
  if (!marker) return { visited: 0, settled: 0, needsReview: 0, morePending: false, protocolReady: false };
  if (!quotaProtocolSchema.safeParse(marker).success) throw new HttpError(503, 'No se pudo validar el protocolo de cuota.', 'AI_QUOTA_INVALID');
  const cursorRef = db.collection('serverSettings').doc('responseQuotaRecoveryCursor');
  return runQuotaRecoveryPage({
    cursor: async () => { const saved = (await cursorRef.get()).data(); return saved ? quotaRecoveryCursorSchema.parse(saved) : emptyQuotaCursor(); },
    discover: async (after, limit) => { let query = db.collection('responseQuotaTurns').where('status', '==', 'reserved').orderBy('__name__'); if (after) query = query.where('__name__', '>', after); return (await query.limit(limit).get()).docs.map(doc => doc.id); },
    due: async (at, limit) => (await db.collection('responseQuotaTurns').where('status', '==', 'reserved').where('nextAttemptAt', '<=', at).orderBy('nextAttemptAt').orderBy('__name__').limit(limit).get()).docs.map(doc => doc.id),
    advance: async (before, after) => db.runTransaction(async tx => { const old = (await tx.get(cursorRef)).data(), current = old ? quotaRecoveryCursorSchema.parse(old) : emptyQuotaCursor(); if (JSON.stringify(current) === JSON.stringify(before)) tx.set(cursorRef, after); }),
    process: async (id, at) => db.runTransaction(async tx => {
      const ref = db.collection('responseQuotaTurns').doc(id), row = await tx.get(ref);
      if (!row.exists) return 'skip';
      const turn = parseStoredQuotaTurn(row.data()), plan = planQuotaRecovery({ turn, now: at });
      if (plan.action === 'skip') return 'skip';
      if (plan.action === 'needs_review') { const next = quarantineQuotaTurn(turn); if (JSON.stringify(next) !== JSON.stringify(turn)) tx.set(ref, next); return 'review'; }
      const identity = { quotaTurnId: id, expectedFingerprint: turn.fingerprint, expectedScopeId: turn.scopeId, reservation: { reservationId: turn.reservationId, scopeId: turn.scopeId, periodId: turn.periodId, attemptId: turn.attemptId } };
      const stage = await prepareResponseQuotaSettlement(tx, db, identity, plan.action === 'consume', plan.evidence!, at);
      applyResponseQuotaStage(tx, db, stage); return 'settled';
    }),
  }, now);
}
