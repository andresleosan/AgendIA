import 'server-only';
import type { Database, Transaction } from '@/lib/storage/types';
import { getAdminDb } from '@/lib/firebase/admin';
import { parseQuotaTurn, quotaReceiptId, quotaReservationSchema, QUOTA_TERMINAL, QuotaModelError, type QuotaIdentity, type QuotaStage, type QuotaEvidence, type QuotaResultRef, type ResponseQuotaReservation } from '../../../shared/response-quota-records';
import { planResponseQuotaSettlement } from '../../../shared/response-quota-settlement';
import { HttpError } from './http';

export type { QuotaIdentity, QuotaStage, QuotaEvidence, QuotaResultRef, ResponseQuotaReservation } from '../../../shared/response-quota-records';
const conflict = () => new HttpError(409, 'Este intento ya cambió.', 'AI_REQUEST_CONFLICT');
const interrupted = () => new HttpError(409, 'Este intento terminó. Envía un mensaje nuevo para iniciar otra consulta.', 'AI_RESPONSE_INTERRUPTED');
export function parseStoredQuotaTurn(value: unknown) {
  try { return parseQuotaTurn(value); } catch { throw new HttpError(503, 'No se pudo validar la cuota.', 'AI_QUOTA_INVALID'); }
}
export async function readQuotaIdentity(tx: Transaction, db: Database, identity: QuotaIdentity) {
  if (!/^[a-f0-9]{64}$/.test(identity.quotaTurnId) || !/^[a-f0-9]{64}$/.test(identity.expectedFingerprint)) throw conflict();
  const snapshot = await tx.get(db.collection('responseQuotaTurns').doc(identity.quotaTurnId));
  if (!snapshot.exists) return null;
  const turn = parseStoredQuotaTurn(snapshot.data());
  if (turn.reservationId !== identity.quotaTurnId || turn.fingerprint !== identity.expectedFingerprint || turn.scopeId !== identity.expectedScopeId) throw conflict();
  if (identity.reservation) for (const key of ['reservationId', 'scopeId', 'periodId', 'attemptId'] as const) if (identity.reservation[key] !== turn[key]) throw conflict();
  return { turn, reservation: quotaReservationSchema.parse({ reservationId: turn.reservationId, scopeId: turn.scopeId, periodId: turn.periodId, attemptId: turn.attemptId }) };
}
export function applyResponseQuotaStage(tx: Transaction, db: Database, stage: QuotaStage): void {
  for (const write of stage.writes) {
    const parts = write.path.split('/');
    const ref = parts.length === 2 ? db.collection(parts[0]).doc(parts[1]) : db.collection(parts[0]).doc(parts[1]).collection(parts[2]).doc(parts[3]);
    if (write.op === 'create') tx.create(ref, write.data); else tx.set(ref, write.data);
  }
}
export async function prepareResponseQuotaSettlement(tx: Transaction, db: Database, identity: QuotaIdentity, completion: boolean, evidence: QuotaEvidence, now: number): Promise<QuotaStage> {
  const saved = await readQuotaIdentity(tx, db, identity);
  if (!saved) return { state: 'pending', writes: [] };
  const { turn, reservation } = saved, receiptId = await quotaReceiptId(reservation);
  const periodPath = `responseQuotaScopes/${turn.scopeId}/periods/${turn.periodId}`, receiptPath = `responseQuotaReceipts/${receiptId}`;
  const [period, receipt] = await Promise.all([tx.get(db.collection('responseQuotaScopes').doc(turn.scopeId).collection('periods').doc(turn.periodId)), tx.get(db.collection('responseQuotaReceipts').doc(receiptId))]);
  let planned;
  try { planned = planResponseQuotaSettlement({ turn, period: period.data(), receipt: receipt.data(), reservation, completion, evidence, now }); }
  catch (error) { if (error instanceof QuotaModelError) throw new HttpError(error.status, 'No se pudo conciliar este intento.', error.code); throw new HttpError(503, 'No se pudo validar la cuota.', 'AI_QUOTA_INVALID'); }
  return { state: completion ? 'committed' : 'released', writes: planned ? [{ op: 'set', path: periodPath, data: planned.period }, { op: 'set', path: `responseQuotaTurns/${turn.reservationId}`, data: planned.turn }, { op: 'create', path: receiptPath, data: planned.receipt }] : [] };
}
export async function markResponseQuotaDispatch(reservation: ResponseQuotaReservation, expectedFingerprint: string, context: { providerCallId: string | null }, db: Database = getAdminDb()): Promise<'dispatch_allowed' | 'already_marked'> {
  return db.runTransaction(async tx => {
    const saved = await readQuotaIdentity(tx, db, { quotaTurnId: reservation.reservationId, expectedFingerprint, expectedScopeId: reservation.scopeId, reservation });
    if (!saved) throw conflict();
    const { turn } = saved, execution = turn.execution;
    if (!execution || execution.origin !== 'v2' || turn.status !== 'reserved' || execution.phase === 'interrupted') throw interrupted();
    if (execution.mayHaveDispatched) return 'already_marked';
    if (execution.phase !== 'prepared' || execution.deadlineAt <= Date.now()) throw interrupted();
    const next = parseStoredQuotaTurn({ ...turn, execution: { ...execution, phase: 'may_have_dispatched', mayHaveDispatched: true, providerCallId: context.providerCallId } });
    tx.set(db.collection('responseQuotaTurns').doc(turn.reservationId), next);
    return 'dispatch_allowed';
  });
}
export async function prepareQuotaResult(tx: Transaction, db: Database, identity: QuotaIdentity, result: QuotaResultRef, now: number): Promise<QuotaStage> {
  const saved = await readQuotaIdentity(tx, db, identity);
  if (!saved) throw conflict();
  const { turn } = saved, execution = turn.execution;
  if (turn.status !== 'reserved' || !execution || execution.origin !== 'v2' || !execution.mayHaveDispatched || execution.phase === 'interrupted' || execution.deadlineAt <= Math.max(now, Date.now())) throw interrupted();
  const next = parseStoredQuotaTurn({ ...turn, outcome: result.kind === 'chat_state' ? 'receipt_only' : 'recoverable', execution: { ...execution, phase: 'result_recorded', result: execution.result ?? result } });
  return { state: 'pending', writes: [{ op: 'set', path: `responseQuotaTurns/${turn.reservationId}`, data: next }] };
}
export async function assertQuotaPublication(identity: QuotaIdentity, kind: 'initial' | 'replay', db: Database = getAdminDb()): Promise<void> {
  await db.runTransaction(async tx => { await readQuotaPublication(tx, db, identity, kind); });
}
export async function readQuotaPublication(tx: Transaction, db: Database, identity: QuotaIdentity, kind: 'initial' | 'replay'): Promise<void> {
  const saved = await readQuotaIdentity(tx, db, identity);
  if (!saved) throw conflict();
  const { turn } = saved;
  if (!turn.execution) { if (kind === 'replay' && turn.status === 'completed') return; throw interrupted(); }
  if (turn.execution.phase !== 'result_recorded' || turn.status === 'released' || (kind === 'initial' && turn.execution.deadlineAt <= Date.now())) throw interrupted();
}
export type QuotaEffectHooks = { prepare: (tx: Transaction, result: QuotaResultRef) => Promise<() => void> };
export function quotaEffectHooks(identity: QuotaIdentity, db: Database): QuotaEffectHooks {
  return { prepare: async (tx, result) => { const stage = await prepareQuotaResult(tx, db, identity, result, Date.now()); return () => applyResponseQuotaStage(tx, db, stage); } };
}
export async function finishResponseQuota(reservation: ResponseQuotaReservation, completion: boolean, db: Database, proof?: QuotaResultRef): Promise<void> {
  await db.runTransaction(async tx => {
    const turn = parseStoredQuotaTurn((await tx.get(db.collection('responseQuotaTurns').doc(reservation.reservationId))).data());
    // A recovered appointment can be newer than the proposal that won the effect fence.
    const result = turn.execution?.result ?? proof;
    const evidence: QuotaEvidence = !completion ? { kind: 'prepared_fenced', expectedFenceRevision: turn.execution?.fenceRevision ?? -1 } : result ? { kind: 'application_proof', result } : { kind: 'dispatch_possible' };
    const stage = await prepareResponseQuotaSettlement(tx, db, { quotaTurnId: reservation.reservationId, expectedFingerprint: turn.fingerprint, expectedScopeId: reservation.scopeId, reservation }, completion, evidence, Date.now());
    applyResponseQuotaStage(tx, db, stage);
  });
}
export { QUOTA_TERMINAL };
