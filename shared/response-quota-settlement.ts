import { parseQuotaTurn, parseResponsePeriod, quotaReceiptSchema, quotaReservationSchema, quotaConflict, quotaInvalid, QUOTA_TERMINAL, type ResponseQuotaReservation, type StoredResponsePeriod, type QuotaEvidence, type QuotaExecution } from './response-quota-records.ts';

export function planResponseQuotaSettlement(input: { turn: unknown; period: unknown; receipt: unknown; reservation: ResponseQuotaReservation; completion: boolean; evidence: QuotaEvidence; now: number }): { turn: Record<string, unknown>; period: StoredResponsePeriod; receipt: Record<string, unknown> } | null {
  let turn, period, reservation;
  try { turn = parseQuotaTurn(input.turn); period = parseResponsePeriod(input.period); reservation = quotaReservationSchema.parse(input.reservation); }
  catch { throw quotaInvalid(); }
  if (!Number.isSafeInteger(input.now) || input.now < 0) throw quotaInvalid();
  for (const key of ['reservationId', 'scopeId', 'periodId', 'attemptId'] as const) if (turn[key] !== reservation[key]) throw quotaConflict();
  if (period.id !== reservation.periodId) throw quotaConflict();
  const decision = input.completion ? 'completed' : 'released';
  if (turn.status !== 'reserved') {
    if (turn.status !== decision) throw quotaConflict();
    if (turn.execution || input.receipt !== undefined) {
      const receipt = quotaReceiptSchema.safeParse(input.receipt);
      if (!receipt.success) throw quotaInvalid();
      for (const key of ['reservationId', 'scopeId', 'periodId', 'attemptId'] as const) if (receipt.data[key] !== reservation[key]) throw quotaConflict();
      if (receipt.data.fingerprint !== turn.fingerprint || receipt.data.decision !== decision) throw quotaConflict();
      if (JSON.stringify(receipt.data.execution) !== JSON.stringify(turn.execution) || receipt.data.finishedAt !== turn.finishedAt) throw quotaInvalid();
    }
    return null;
  }
  if (input.receipt !== undefined || period.reservedResponses < 1) throw quotaInvalid();
  const execution: QuotaExecution = turn.execution ?? { protocol: 2, origin: 'legacy_unknown', phase: 'interrupted', mayHaveDispatched: true, fenceRevision: 0, deadlineAt: turn.startedAt, providerCallId: null, result: null };
  const evidence = input.evidence;
  if (!input.completion) {
    if (execution.origin !== 'v2' || execution.phase !== 'prepared' || execution.mayHaveDispatched || evidence.kind !== 'prepared_fenced' || evidence.expectedFenceRevision !== execution.fenceRevision) throw quotaConflict();
  } else if (evidence.kind === 'application_proof') {
    if (execution.result && JSON.stringify(execution.result) !== JSON.stringify(evidence.result)) throw quotaConflict();
  } else if (evidence.kind === 'legacy_admin') {
    if (execution.origin !== 'legacy_unknown' || !/^[A-Za-z0-9_-]{1,128}$/.test(evidence.reviewId)) throw quotaConflict();
  } else if (evidence.kind !== 'dispatch_possible' || execution.origin !== 'v2' || !execution.mayHaveDispatched) throw quotaConflict();
  if (execution.fenceRevision >= Number.MAX_SAFE_INTEGER) throw quotaInvalid();
  const result = evidence.kind === 'application_proof' ? evidence.result : execution.result;
  const closed: QuotaExecution = { ...execution, phase: result ? 'result_recorded' : 'interrupted', result, fenceRevision: execution.fenceRevision + 1 };
  if (result) closed.mayHaveDispatched = true;
  const next = { ...period, reservedResponses: period.reservedResponses - 1, usedResponses: period.usedResponses + Number(input.completion) };
  try { parseResponsePeriod(next); } catch { throw quotaInvalid(); }
  const receipt = quotaReceiptSchema.parse({ ...reservation, version: 2, fingerprint: turn.fingerprint, decision, basis: !input.completion ? 'undispatched_fenced' : evidence.kind === 'legacy_admin' ? 'legacy_admin_consume' : evidence.kind, finishedAt: input.now, execution: closed, ...(evidence.kind === 'legacy_admin' ? { reviewId: evidence.reviewId } : {}) });
  return { turn: { ...turn, status: decision, execution: closed, nextAttemptAt: QUOTA_TERMINAL, finishedAt: input.now, outcome: result ? (result.kind === 'chat_state' ? 'receipt_only' : 'recoverable') : 'unknown' }, period: next, receipt };
}
