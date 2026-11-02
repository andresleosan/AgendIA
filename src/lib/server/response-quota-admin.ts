import 'server-only';
import { z } from 'zod';
import type { Database } from '@/lib/storage/types';
import type { ChatActor } from '@/types/chat';
import { getAdminDb } from '@/lib/firebase/admin';
import { isSuperadmin } from './auth';
import { HttpError } from './http';
import { requestIdSchema } from './schemas';
import { quotaReservationSchema, quotaProtocolSchema, quotaDigest, quotaReviewSchema, type QuotaEvidence } from '../../../shared/response-quota-records';
import { readQuotaIdentity, parseStoredQuotaTurn, prepareResponseQuotaSettlement, applyResponseQuotaStage } from './response-quota-store';
export const quotaReconcileSchema = z.object({ requestId: requestIdSchema, reservation: quotaReservationSchema, expectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/), resolution: z.enum(['consume', 'keep_pending', 'release_undispatched']), reason: z.string().trim().min(1).max(300), evidenceSha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
function authorize(actor: ChatActor) { if (!isSuperadmin(actor.uid)) throw new HttpError(403, 'Forbidden'); }
export async function listResponseQuotaReviews(actor: ChatActor, after?: string, db: Database = getAdminDb()) {
  authorize(actor); if (after !== undefined && !/^[a-f0-9]{64}$/.test(after)) throw new HttpError(400, 'Cursor inválido.');
  let query = db.collection('responseQuotaTurns').where('status', '==', 'reserved').orderBy('__name__'); if (after) query = query.where('__name__', '>', after);
  const rows = (await query.limit(21).get()).docs, page = rows.slice(0, 20);
  return { attempts: page.map(doc => { const turn = parseStoredQuotaTurn(doc.data()); return { reservation: quotaReservationSchema.parse({ reservationId: turn.reservationId, scopeId: turn.scopeId, periodId: turn.periodId, attemptId: turn.attemptId }), expectedFingerprint: turn.fingerprint, phase: turn.execution?.phase ?? 'legacy_unknown', origin: turn.execution?.origin ?? 'legacy_unknown', startedAt: turn.startedAt }; }), next: rows.length > 20 ? page.at(-1)!.id : null };
}
export async function reconcileResponseQuota(actor: ChatActor, supplied: z.input<typeof quotaReconcileSchema>, db: Database = getAdminDb()) {
  authorize(actor); const input = quotaReconcileSchema.parse(supplied);
  const reviewId = await quotaDigest([input.reservation.attemptId, input.requestId]);
  const fingerprint = await quotaDigest([input]), actorHash = await quotaDigest([actor.uid]);
  const reviewRef = db.collection('responseQuotaTurns').doc(input.reservation.reservationId).collection('reviews').doc(reviewId);
  return db.runTransaction(async tx => {
    const [previous, protocol] = await Promise.all([tx.get(reviewRef), tx.get(db.collection('serverSettings').doc('responseQuotaProtocol'))]);
    if (!quotaProtocolSchema.safeParse(protocol.data()).success) throw new HttpError(503, 'El protocolo no está preparado.', 'AI_QUOTA_PROTOCOL_NOT_READY');
    if (previous.exists) { const saved = quotaReviewSchema.parse(previous.data()); if (saved.requestFingerprint !== fingerprint) throw new HttpError(409, 'La decisión cambió.', 'AI_REQUEST_CONFLICT'); return { resolution: saved.resolution, replayed: true }; }
    const identity = { quotaTurnId: input.reservation.reservationId, expectedFingerprint: input.expectedFingerprint, expectedScopeId: input.reservation.scopeId, reservation: input.reservation };
    const saved = await readQuotaIdentity(tx, db, identity); if (!saved) throw new HttpError(404, 'El intento no existe.');
    const turn = saved.turn;
    if (turn.status !== 'reserved') throw new HttpError(409, 'El intento ya terminó.', 'AI_REQUEST_CONFLICT');
    let stage;
    if (input.resolution === 'keep_pending') {
      if (turn.execution?.origin === 'v2') throw new HttpError(409, 'El intento tiene una ejecución verificable.', 'AI_REQUEST_CONFLICT');
    } else {
      const evidence: QuotaEvidence = input.resolution === 'release_undispatched' ? { kind: 'prepared_fenced', expectedFenceRevision: turn.execution?.fenceRevision ?? -1 } : turn.execution?.result ? { kind: 'application_proof', result: turn.execution.result } : !turn.execution || turn.execution.origin === 'legacy_unknown' ? { kind: 'legacy_admin', reviewId } : { kind: 'dispatch_possible' };
      stage = await prepareResponseQuotaSettlement(tx, db, identity, input.resolution === 'consume', evidence, Date.now());
    }
    const review = quotaReviewSchema.parse({ version: 2, requestFingerprint: fingerprint, reservation: input.reservation, resolution: input.resolution, actorHash, reason: input.reason, evidenceSha256: input.evidenceSha256, at: Date.now() });
    if (stage) applyResponseQuotaStage(tx, db, stage);
    tx.create(reviewRef, review); return { resolution: input.resolution, replayed: false };
  });
}
