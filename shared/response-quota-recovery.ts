import { z } from 'zod';
import { parseQuotaTurn, QUOTA_TERMINAL, type QuotaTurn, type QuotaEvidence } from './response-quota-records.ts';

export const quotaRecoveryCursorSchema = z.object({ version: z.literal(2), after: z.string().regex(/^[a-f0-9]{64}$/).nullable(), discoveryDone: z.boolean() }).strict();
export type QuotaRecoveryCursor = z.infer<typeof quotaRecoveryCursorSchema>;
export const emptyQuotaCursor = (): QuotaRecoveryCursor => ({ version: 2, after: null, discoveryDone: false });
export function planQuotaRecovery(input: { turn: unknown; receipt?: unknown; now: number }): { action: 'skip' | 'release_prepared' | 'consume' | 'needs_review'; evidence: QuotaEvidence | null } {
  const turn = parseQuotaTurn(input.turn), execution = turn.execution;
  if (turn.status !== 'reserved') return { action: 'skip', evidence: null };
  if (execution?.result) return { action: 'consume', evidence: { kind: 'application_proof', result: execution.result } };
  if (!execution || execution.origin === 'legacy_unknown') return { action: 'needs_review', evidence: null };
  if (execution.deadlineAt > input.now) return { action: 'skip', evidence: null };
  return execution.mayHaveDispatched ? { action: 'consume', evidence: { kind: 'dispatch_possible' } } : { action: 'release_prepared', evidence: { kind: 'prepared_fenced', expectedFenceRevision: execution.fenceRevision } };
}
export function quarantineQuotaTurn(turn: QuotaTurn): QuotaTurn {
  return parseQuotaTurn({ ...turn, nextAttemptAt: QUOTA_TERMINAL, execution: turn.execution ?? { protocol: 2, origin: 'legacy_unknown', phase: 'interrupted', mayHaveDispatched: true, fenceRevision: 0, deadlineAt: turn.startedAt, providerCallId: null, result: null } });
}
export interface QuotaRecoveryAdapter {
  cursor(): Promise<QuotaRecoveryCursor>;
  discover(after: string | null, limit: number): Promise<string[]>;
  due(now: number, limit: number): Promise<string[]>;
  process(id: string, now: number): Promise<'skip' | 'settled' | 'review'>;
  advance(before: QuotaRecoveryCursor, after: QuotaRecoveryCursor): Promise<void>;
}
export async function runQuotaRecoveryPage(adapter: QuotaRecoveryAdapter, now: number) {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('Invalid quota recovery clock');
  const result = { visited: 0, settled: 0, needsReview: 0, morePending: false, protocolReady: true };
  const visit = async (id: string) => { const state = await adapter.process(id, now); result.visited++; if (state === 'settled') result.settled++; if (state === 'review') result.needsReview++; };
  const cursor = await adapter.cursor();
  if (!cursor.discoveryDone) {
    const ids = await adapter.discover(cursor.after, 25);
    for (const id of ids) await visit(id);
    await adapter.advance(cursor, { version: 2, after: ids.at(-1) ?? cursor.after, discoveryDone: ids.length < 25 });
    result.morePending ||= ids.length === 25;
  }
  // Resolved rows leave the indexed head; restarting it also includes new earlier rows.
  const limit = 50 - result.visited, ids = await adapter.due(now, limit);
  for (const id of ids) await visit(id);
  result.morePending ||= ids.length === limit;
  return result;
}
