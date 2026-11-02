import { executeDataCommand, DataError } from './data.ts';
import type { DataRead, DataReadResult, DataWrite } from '../../shared/data-protocol.ts';
import { parseQuotaTurn, quotaProtocolSchema, quotaReceiptId } from '../../shared/response-quota-records.ts';
import { planResponseQuotaSettlement } from '../../shared/response-quota-settlement.ts';
import { planQuotaRecovery, quarantineQuotaTurn, quotaRecoveryCursorSchema, emptyQuotaCursor, runQuotaRecoveryPage } from '../../shared/response-quota-recovery.ts';
type Env = Parameters<typeof executeDataCommand>[1];
export async function recoverWorkerResponseQuota(env: Env, now = Date.now()) {
  const read = async (spec: DataRead): Promise<DataReadResult> => {
    const value = await executeDataCommand({ action: 'read', read: spec }, env);
    if (!('documents' in value)) throw new DataError(503, 'DATA_UNAVAILABLE'); return value;
  };
  const marker = (await read({ kind: 'document', path: 'serverSettings/responseQuotaProtocol' })).documents[0]?.data;
  if (!marker) return { visited: 0, settled: 0, needsReview: 0, morePending: false, protocolReady: false };
  if (!quotaProtocolSchema.safeParse(marker).success) throw new DataError(503, 'DATA_UNAVAILABLE');
  const cursorPath = 'serverSettings/responseQuotaRecoveryCursor';
  async function transaction<T>(callback: (get: (path: string) => Promise<Record<string, unknown> | undefined>) => Promise<{ result: T; writes: DataWrite[] }>): Promise<T> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        let revision: number | undefined;
        const get = async (path: string) => { const value = await read({ kind: 'document', path }); if (revision !== undefined && revision !== value.revision) throw new DataError(409, 'DATA_CONFLICT'); revision = value.revision; return value.documents[0]?.data; };
        const prepared = await callback(get);
        if (prepared.writes.length) { if (revision === undefined) throw new DataError(503, 'DATA_UNAVAILABLE'); await executeDataCommand({ action: 'commit', expectedRevision: revision, requestId: crypto.randomUUID(), writes: prepared.writes }, env); }
        return prepared.result;
      } catch (error) { if (!(error instanceof DataError) || error.code !== 'DATA_CONFLICT' || attempt === 2) throw error; }
    }
    throw new DataError(503, 'DATA_UNAVAILABLE');
  }
  return runQuotaRecoveryPage({
    cursor: async () => { const row = (await read({ kind: 'document', path: cursorPath })).documents[0]?.data; return row ? quotaRecoveryCursorSchema.parse(row) : emptyQuotaCursor(); },
    discover: async (after, limit) => (await read({ kind: 'query', path: 'responseQuotaTurns', filters: [{ field: 'status', op: '==', value: 'reserved' }, ...(after ? [{ field: '__name__', op: '>' as const, value: after }] : [])], order: [{ field: '__name__', direction: 'asc' }], limit })).documents.map(row => row.path.split('/')[1]),
    due: async (at, limit) => (await read({ kind: 'query', path: 'responseQuotaTurns', filters: [{ field: 'status', op: '==', value: 'reserved' }, { field: 'nextAttemptAt', op: '<=', value: at }], order: [{ field: 'nextAttemptAt', direction: 'asc' }, { field: '__name__', direction: 'asc' }], limit })).documents.map(row => row.path.split('/')[1]),
    advance: (before, after) => transaction(async get => { const value = await get(cursorPath), current = value ? quotaRecoveryCursorSchema.parse(value) : emptyQuotaCursor(); return { result: undefined, writes: JSON.stringify(current) === JSON.stringify(before) ? [{ op: 'set', path: cursorPath, data: after }] : [] }; }),
    process: (id, at) => transaction(async get => {
      const path = `responseQuotaTurns/${id}`, value = await get(path);
      if (!value) return { result: 'skip' as const, writes: [] };
      const turn = parseQuotaTurn(value), plan = planQuotaRecovery({ turn, now: at });
      if (plan.action === 'skip') return { result: 'skip' as const, writes: [] };
      if (plan.action === 'needs_review') { const next = quarantineQuotaTurn(turn); return { result: 'review' as const, writes: JSON.stringify(next) === JSON.stringify(turn) ? [] : [{ op: 'set', path, data: next }] }; }
      const reservation = { reservationId: turn.reservationId, scopeId: turn.scopeId, periodId: turn.periodId, attemptId: turn.attemptId };
      const periodPath = `responseQuotaScopes/${turn.scopeId}/periods/${turn.periodId}`, receiptPath = `responseQuotaReceipts/${await quotaReceiptId(reservation)}`;
      const period = await get(periodPath), receipt = await get(receiptPath);
      const result = planResponseQuotaSettlement({ turn, period, receipt, reservation, completion: plan.action === 'consume', evidence: plan.evidence!, now: at });
      return { result: 'settled' as const, writes: result ? [{ op: 'set', path, data: result.turn }, { op: 'set', path: periodPath, data: result.period }, { op: 'create', path: receiptPath, data: result.receipt }] : [] };
    }),
  }, now);
}
