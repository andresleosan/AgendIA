import { z } from 'zod';
import { SUBSCRIPTION_PLAN_IDS } from '../src/lib/billing-plans.ts';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const integer = z.number().int().nonnegative().safe();
const count = integer.max(1_000_000_000);
export const responsePeriodSchema = z.object({ id, source: z.enum(['trial', 'subscription', 'legacy']), planId: z.enum(SUBSCRIPTION_PLAN_IDS).nullable(), startsAt: integer, endsAt: integer, includedResponses: count, extraResponses: count, usedResponses: count, reservedResponses: count });
export type StoredResponsePeriod = z.infer<typeof responsePeriodSchema>;
export const parseResponsePeriod = (value: unknown): StoredResponsePeriod => responsePeriodSchema.parse(value);
export const quotaReservationSchema = z.object({ reservationId: digest, scopeId: id, periodId: id, attemptId: z.string().uuid() }).strict();
export type ResponseQuotaReservation = z.infer<typeof quotaReservationSchema>;
export type QuotaIdentity = { quotaTurnId: string; expectedFingerprint: string; expectedScopeId: string; reservation: ResponseQuotaReservation | null };
export const quotaResultSchema = z.object({ kind: z.enum(['proposal', 'appointment', 'chat_state', 'whatsapp_outbox', 'inbox_operation']), id }).strict();
export type QuotaResultRef = z.infer<typeof quotaResultSchema>;
export const quotaExecutionSchema = z.object({ protocol: z.literal(2), origin: z.enum(['v2', 'legacy_unknown']), phase: z.enum(['prepared', 'may_have_dispatched', 'result_recorded', 'interrupted']), mayHaveDispatched: z.boolean(), fenceRevision: integer, deadlineAt: integer, providerCallId: z.string().uuid().nullable(), result: quotaResultSchema.nullable() }).strict().refine(value => {
  if (value.phase === 'prepared') return value.origin === 'v2' && !value.mayHaveDispatched && value.result === null && value.providerCallId === null;
  if (value.phase === 'may_have_dispatched') return value.mayHaveDispatched && value.result === null;
  if (value.phase === 'result_recorded') return value.mayHaveDispatched && value.result !== null;
  return value.result === null;
});
export type QuotaExecution = z.infer<typeof quotaExecutionSchema>;
export const quotaTurnSchema = quotaReservationSchema.extend({ fingerprint: digest, status: z.enum(['reserved', 'completed', 'released']), startedAt: integer, mode: z.enum(['sarin_client', 'sarin_owner_copilot', 'sarin_onboarding']), channel: z.enum(['web', 'whatsapp']), finishedAt: integer.optional(), execution: quotaExecutionSchema.optional(), nextAttemptAt: integer.optional(), outcome: z.enum(['recoverable', 'receipt_only', 'suppressed', 'failed', 'unknown']).optional() }).strict();
export type QuotaTurn = z.infer<typeof quotaTurnSchema>;
export function parseQuotaTurn(value: unknown): QuotaTurn { return quotaTurnSchema.parse(value); }
export const quotaReceiptSchema = quotaReservationSchema.extend({ version: z.literal(2), fingerprint: digest, decision: z.enum(['completed', 'released']), basis: z.enum(['undispatched_fenced', 'dispatch_possible', 'application_proof', 'legacy_admin_consume']), finishedAt: integer, execution: quotaExecutionSchema, reviewId: id.optional() }).strict();
export type QuotaReceipt = z.infer<typeof quotaReceiptSchema>;
export const quotaReviewSchema = z.object({ version: z.literal(2), requestFingerprint: digest, reservation: quotaReservationSchema, resolution: z.enum(['consume', 'keep_pending', 'release_undispatched']), actorHash: digest, reason: z.string().min(1).max(300), evidenceSha256: digest, at: integer }).strict();
export const quotaProtocolSchema = z.object({ version: z.literal(2), minimumWriterProtocol: z.literal(2), sourceSha: z.string().regex(/^[a-f0-9]{40}$/), oldWriterStoppedAt: integer, reviewArtifactSha256: digest }).strict();
export type QuotaStage = { state: 'none' | 'pending' | 'committed' | 'released'; writes: readonly { op: 'set' | 'create'; path: string; data: Record<string, unknown> }[] };
export type QuotaEvidence = { kind: 'prepared_fenced'; expectedFenceRevision: number } | { kind: 'dispatch_possible' } | { kind: 'application_proof'; result: QuotaResultRef } | { kind: 'legacy_admin'; reviewId: string };
export class QuotaModelError extends Error {
  readonly status: 409 | 503;
  readonly code: string;
  constructor(status: 409 | 503, code: string) { super(code); this.status = status; this.code = code; }
}
export const quotaConflict = () => new QuotaModelError(409, 'AI_REQUEST_CONFLICT');
export const quotaInvalid = () => new QuotaModelError(503, 'AI_QUOTA_INVALID');
export async function quotaDigest(parts: readonly unknown[]): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(parts)));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}
export const quotaReceiptId = (reservation: ResponseQuotaReservation) => quotaDigest([reservation.reservationId, reservation.attemptId]);
export const QUOTA_TERMINAL = Number.MAX_SAFE_INTEGER;
