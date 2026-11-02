import { PAYMENT_UUID } from './admin-payment-actions.ts';
/** Private Container -> Worker storage protocol; never exposed as a public API. */
export type DataRecord = Record<string, unknown>;
export type DataFilter = { field: string; op: '==' | '<' | '<=' | '>' | '>='; value: string | number | boolean | null };
export type DataRead =
  | { kind: 'document'; path: string }
  | { kind: 'query'; path: string; filters: DataFilter[]; order: { field: string; direction: 'asc' | 'desc' }[]; limit?: number };
export type DataWrite = { op: 'set' | 'create'; path: string; data: DataRecord; merge?: boolean } | { op: 'delete'; path: string };
export type DataCommand =
  | { action: 'read'; read: DataRead }
  | { action: 'commit'; expectedRevision: number; requestId: string; writes: DataWrite[] };
export type DataReadResult = { revision: number; documents: { path: string; data: DataRecord }[] };
export type DataCommitResult = { revision: number };

export const DATA_COLLECTIONS = ['platformWhatsAppSpending', 'platformSupportConversations', 'platformSupportMessages', 'adminPaymentActions', 'users', 'businesses', 'businessMemberships', 'businessSlugs', 'publicBusinesses', 'paymentReceipts', 'paymentImages', 'platformSettings', 'serverSettings', 'invitations', 'businessLogos', 'chatStates', 'bookingProposals', 'responseQuotaScopes', 'responseQuotaTurns', 'responseQuotaReceipts', 'aiBudgetCalls', 'aiBudgetPeriods', 'aiUsageCalls', 'aiUsageMonths', 'aiUsageMeta', 'whatsappNumbers', 'whatsappBusinesses', 'whatsappInbox', 'whatsappOutbox', 'whatsappConversations', 'whatsappMessageIds', 'whatsappUsage', 'platformWhatsAppEvents', 'platformWhatsAppConversations', 'platformWhatsAppLinks', 'platformWhatsAppLinkChallenges', 'platformWhatsAppJobs', 'platformWhatsAppOutbox', 'platformWhatsAppBudgetCalls', 'platformWhatsAppBudgetPeriods'] as const;
export const DATA_CHILDREN: Record<string, readonly string[]> = { businesses: ['appointments', 'attendanceEvents', 'ownerRescheduleProposals', 'bookingLocks', 'clientPolicies', 'reminderPreferences', 'reminderReceipts', 'waitlistRequests', 'waitlistOwnerReviews', 'waitlistOfferHeads', 'waitlistOffers', 'resourceSchedulePolicies', 'resourceScheduleOperations', 'factualFaq', 'factualFaqOperations', 'teamAccessEvents'], responseQuotaScopes: ['periods'], responseQuotaTurns: ['reviews'], aiUsageMonths: ['businesses'], whatsappUsage: ['businesses'] };
export function isDataPath(value: unknown, document: boolean): value is string {
  if (typeof value !== 'string' || value.length > 1024) return false;
  const parts = value.split('/');
  if (parts.some(part => !/^[A-Za-z0-9_-]{1,128}$/.test(part) || ['__proto__', 'prototype', 'constructor'].includes(part))) return false;
  if (!(DATA_COLLECTIONS as readonly string[]).includes(parts[0])) return false;
  if (parts[0] === 'platformSupportConversations') return document ? parts.length === 2 && (parts[1] === 'key_marker' || PAYMENT_UUID.test(parts[1]) || /^(?:create|config)_[a-f0-9]{64}(?![\s\S])/.test(parts[1])) : parts.length === 1;
  if (parts[0] === 'platformSupportMessages') return document ? parts.length === 2 && /^(?:intent_)?[a-f0-9]{64}(?![\s\S])/.test(parts[1]) : parts.length === 1;
  if (parts[0] === 'adminPaymentActions') return document ? parts.length === 2 && (parts[1] === 'key_marker' || PAYMENT_UUID.test(parts[1]) || /^request_[a-f0-9]{64}(?![\s\S])/.test(parts[1])) : parts.length === 1;
  if (!(document ? [2, 4] : [1, 3]).includes(parts.length)) return false;
  return parts.length <= 2 || Boolean(DATA_CHILDREN[parts[0]]?.includes(parts[2]));
}
export function isDataJson(value: unknown, depth = 0): boolean {
  if (depth > 32) return false;
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'string') return wellFormed(value);
  if (typeof value === 'number') return Number.isFinite(value) && !Object.is(value, -0);
  if (Array.isArray(value)) return value.every(item => isDataJson(item, depth + 1));
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  return Object.entries(value).every(([key, item]) => wellFormed(key) && !key.includes('\0') && !['__proto__', 'prototype', 'constructor'].includes(key) && isDataJson(item, depth + 1));
}

function wellFormed(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

