import { describe, expect, it } from 'vitest';
import { planResponseQuotaSettlement } from '../shared/response-quota-settlement';
import { parseQuotaTurn, quotaReceiptId } from '../shared/response-quota-records';

const reservation = { reservationId: 'a'.repeat(64), scopeId: 'business_demo-quota', periodId: 'initial', attemptId: '00000000-0000-4000-8000-000000000001' };
const period = { id: 'initial', source: 'trial', planId: null, startsAt: 1, endsAt: 999999, includedResponses: 700, extraResponses: 0, usedResponses: 0, reservedResponses: 1 };
const execution = { protocol: 2, origin: 'v2', phase: 'may_have_dispatched', mayHaveDispatched: true, fenceRevision: 0, deadlineAt: 1000, providerCallId: null, result: null };
const turn = { ...reservation, fingerprint: 'b'.repeat(64), status: 'reserved', startedAt: 1, mode: 'sarin_client', channel: 'web', execution, nextAttemptAt: 1000 };
const input = { turn, period, receipt: undefined, reservation, completion: true, evidence: { kind: 'dispatch_possible' as const }, now: 2000 };

describe('durable quota settlement model', () => {
  it('sameAttemptSettlesOnce', () => {
    const result = planResponseQuotaSettlement(input)!;
    expect(result.period).toMatchObject({ reservedResponses: 0, usedResponses: 1 });
    expect(result.receipt).toMatchObject({ decision: 'completed', fingerprint: turn.fingerprint, attemptId: reservation.attemptId });
    expect(result.turn.execution).toMatchObject({ phase: 'interrupted', mayHaveDispatched: true, fenceRevision: 1 });
    expect(planResponseQuotaSettlement({ ...input, ...result })).toBeNull();
  });
  it('changedAttemptOrFingerprintConflicts', () => {
    expect(() => planResponseQuotaSettlement({ ...input, reservation: { ...reservation, attemptId: '00000000-0000-4000-8000-000000000002' } })).toThrow();
    const settled = planResponseQuotaSettlement(input)!;
    expect(() => planResponseQuotaSettlement({ ...input, ...settled, turn: { ...settled.turn, fingerprint: 'c'.repeat(64) } })).toThrow();
  });
  it('preparedReleaseRequiresFence', () => {
    const prepared = { ...turn, execution: { ...execution, phase: 'prepared', mayHaveDispatched: false } };
    const result = planResponseQuotaSettlement({ ...input, turn: prepared, completion: false, evidence: { kind: 'prepared_fenced', expectedFenceRevision: 0 } })!;
    expect(result.period).toMatchObject({ usedResponses: 0, reservedResponses: 0 });
    expect(result.receipt.decision).toBe('released');
    expect(() => planResponseQuotaSettlement({ ...input, turn: prepared, completion: false, evidence: { kind: 'prepared_fenced', expectedFenceRevision: 1 } })).toThrow();
  });
  it('dispatchCannotRelease', () => {
    expect(() => planResponseQuotaSettlement({ ...input, completion: false, evidence: { kind: 'prepared_fenced', expectedFenceRevision: 0 } })).toThrow();
  });
  it('terminalDecisionCannotFlip', () => {
    const settled = planResponseQuotaSettlement(input)!;
    expect(() => planResponseQuotaSettlement({ ...input, ...settled, completion: false })).toThrow();
  });
  it.each([-1, 0, 0.5, '1', Number.MAX_SAFE_INTEGER])('periodCorruptionNeverBecomesZero (%s)', reservedResponses => {
    expect(() => planResponseQuotaSettlement({ ...input, period: { ...period, reservedResponses } })).toThrow();
  });
  it('receiptHasNoConversationFields', () => {
    const result = planResponseQuotaSettlement(input)!;
    expect(Object.keys(result.receipt).sort()).toEqual(['attemptId', 'basis', 'decision', 'execution', 'fingerprint', 'finishedAt', 'periodId', 'reservationId', 'scopeId', 'version'].sort());
    expect(() => parseQuotaTurn({ ...turn, reply: 'private conversation' })).toThrow();
  });
  it('legacyMissingPhaseIsUnknown', () => {
    const { execution: _execution, nextAttemptAt: _next, ...legacy } = turn;
    expect(parseQuotaTurn(legacy).execution).toBeUndefined();
    expect(() => planResponseQuotaSettlement({ ...input, turn: legacy })).toThrow();
    const settled = planResponseQuotaSettlement({ ...input, turn: legacy, evidence: { kind: 'legacy_admin', reviewId: 'demo-review' } })!;
    expect(settled.period.usedResponses).toBe(1);
    expect(settled.receipt.execution).toMatchObject({ origin: 'legacy_unknown', phase: 'interrupted' });
  });
  it('missingV2ReceiptIsNotACompletedReplay', () => {
    expect(() => planResponseQuotaSettlement({ ...input, turn: { ...turn, status: 'completed', finishedAt: 2 } })).toThrow();
  });
  it('terminal replay rejects a receipt with a different execution fence', () => {
    const settled = planResponseQuotaSettlement(input)!;
    expect(() => planResponseQuotaSettlement({ ...input, ...settled, receipt: { ...settled.receipt, execution: { ...(settled.receipt.execution as object), fenceRevision: 2 } } })).toThrow();
  });
  it('resultProofKeepsOriginalResult', () => {
    const result = { kind: 'proposal' as const, id: 'demo-proposal' };
    const settled = planResponseQuotaSettlement({ ...input, turn: { ...turn, execution: { ...execution, phase: 'result_recorded', result } }, evidence: { kind: 'application_proof', result } })!;
    expect(settled.turn.execution).toMatchObject({ phase: 'result_recorded', result });
  });
  it('receiptIdentityIsDeterministicAndBindsAttempt', async () => {
    expect(await quotaReceiptId(reservation)).toMatch(/^[a-f0-9]{64}$/);
    expect(await quotaReceiptId(reservation)).not.toBe(await quotaReceiptId({ ...reservation, attemptId: '00000000-0000-4000-8000-000000000002' }));
  });
});
