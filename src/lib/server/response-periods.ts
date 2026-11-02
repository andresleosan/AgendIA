import 'server-only';
import type { Database as Firestore, Transaction } from '@/lib/storage/types';
import type { Business, ResponseQuotaPeriod } from '@/types/firestore';
import { PAID_TRIAL_INCLUDED_RESPONSES, PAID_TRIAL_PERIOD_END } from '@/lib/paid-trial';

import { parseResponsePeriod, type StoredResponsePeriod } from '../../../shared/response-quota-records';
export { parseResponsePeriod, type StoredResponsePeriod } from '../../../shared/response-quota-records';
export const businessQuotaScope = (businessId: string) => `business_${businessId}`;
export const responsePeriodReference = (db: Firestore, scopeId: string, periodId: string) => db.collection('responseQuotaScopes').doc(scopeId).collection('periods').doc(periodId);
export function publicResponsePeriod(period: StoredResponsePeriod): ResponseQuotaPeriod {
  return { ...period, remainingResponses: Math.max(0, period.includedResponses + period.extraResponses - period.usedResponses - period.reservedResponses) };
}

function initialPeriod(business: Business): StoredResponsePeriod | null {
  const sub = business.subscription;
  const paid = sub.currentPeriodEndsAt > 0;
  const trial = sub.paidTrial;
  const endsAt = paid ? sub.currentPeriodEndsAt : trial ? PAID_TRIAL_PERIOD_END : 0;
  if (!endsAt) return null;
  // Old subscriptions did not retain individual paid periods. Preserve their
  // remaining time with one explicit legacy monthly allowance; no retrocount.
  return { id: 'initial', source: paid ? 'legacy' : 'trial', planId: paid ? 'monthly' : null,
    startsAt: paid ? business.createdAt : trial!.activatedAt, endsAt, includedResponses: paid ? 3000 : PAID_TRIAL_INCLUDED_RESPONSES,
    extraResponses: 0, usedResponses: 0, reservedResponses: 0 };
}

export async function readResponsePeriodState(business: Business, db: Firestore, transaction?: Transaction, now = Date.now()) {
  const scopeId = businessQuotaScope(business.id);
  const scopeReference = db.collection('responseQuotaScopes').doc(scopeId);
  const scope = transaction ? await transaction.get(scopeReference) : await scopeReference.get();
  if (!scope.exists) return { scopeId, scopeReference, initialize: true, current: initialPeriod(business), next: null as StoredResponsePeriod | null };
  const periods = scopeReference.collection('periods');
  const currentQuery = periods.where('startsAt', '<=', now).orderBy('startsAt', 'desc').limit(2);
  const nextQuery = periods.where('startsAt', '>', now).orderBy('startsAt', 'asc').limit(1);
  const [current, next] = await Promise.all([transaction ? transaction.get(currentQuery) : currentQuery.get(), transaction ? transaction.get(nextQuery) : nextQuery.get()]);
  return { scopeId, scopeReference, initialize: false,
    current: current.empty ? null : current.docs.map(document => parseResponsePeriod(document.data())).sort((a, b) => b.startsAt - a.startsAt || Number(b.source === 'subscription') - Number(a.source === 'subscription'))[0],
    next: next.empty ? null : parseResponsePeriod(next.docs[0].data()) };
}

export function initializeResponsePeriods(transaction: Transaction, db: Firestore, state: Awaited<ReturnType<typeof readResponsePeriodState>>, now = Date.now()) {
  if (!state.initialize) return;
  transaction.create(state.scopeReference, { initializedAt: now });
  if (state.current) transaction.create(responsePeriodReference(db, state.scopeId, state.current.id), state.current);
}
