import { z } from 'zod';
import { isDataJson, isDataPath } from '../../shared/data-protocol.ts';
import { quotaProtocolSchema, quotaTurnSchema, quotaReceiptSchema, quotaReviewSchema, responsePeriodSchema, quotaReservationSchema } from '../../shared/response-quota-records.ts';
import { isSupportRecord, isSupportRecipient } from '../../shared/platform-support-records.ts';
import { isAdminPaymentRecord } from '../../shared/admin-payment-actions.ts';
import { isPlatformWhatsAppStoredEvent, isPlatformWhatsAppConversationRecord, isPlatformWhatsAppConnectionRecord } from '../../shared/platform-whatsapp-records.ts';
import { isWorkRecordAtPath } from '../../shared/platform-whatsapp-work.ts';
import { isPlatformWhatsAppStoredLinkControl, isPlatformWhatsAppLinkKeyMarker } from '../../shared/platform-whatsapp-link-records.ts';
import { bookingBeneficiarySchema, bookingSubjectCaseSchema } from '../../src/lib/booking-subject.ts';
import { factualFaqStateSchema, factualFaqAppliedSchema } from '../../src/lib/business-factual-faq.ts';
import { businessLocationSchema } from '../../src/lib/business-location.ts';

/** @returns {never} */
const fail = () => { throw new Error('D1_BACKUP_UNCLASSIFIED'); };
const s = z.string().max(12000), n = z.number().int().nonnegative().safe(), b = z.boolean(), h = z.string().regex(/^[a-f0-9]{64}$/), v = z.literal(1);
const money = z.number().finite().min(0).max(100000000);
const o = shape => z.object(shape).strict();
const optional = shape => Object.fromEntries(Object.entries(shape).map(([key, value]) => [key, value.optional()]));
const strings = keys => Object.fromEntries(keys.split(' ').map(key => [key, s]));
const counts = keys => Object.fromEntries(keys.split(' ').map(key => [key, n]));
const nullable = shape => Object.fromEntries(Object.entries(shape).map(([key, value]) => [key, value.nullable()]));
const anchor = o({ revision: n, fingerprint: h, receiptId: s });
const subjectCase = bookingSubjectCaseSchema;
const role = o({ id: z.literal('own_agenda_viewer'), version: v }).nullable();
const resource = o({ id: s, name: s, active: b });
const service = o({ ...strings('id name'), ...counts('durationMinutes bufferMinutes'), price: money, resourceIds: z.array(s), description: s.optional(), category: s.optional() });
const day = o({ isOpen: b, intervals: z.array(o({ start: s, end: s })) });
const week = o(Object.fromEntries(Array.from({ length: 7 }, (_, i) => [String(i), day.optional()])));
const logo = o({ sha256: h });
const location = businessLocationSchema;
const trial = o({ ...counts('activatedAt appointmentLimit appointmentsUsed'), ...optional({ source: s, paymentId: s, invitationId: s, accessSuspended: b }) });
const subscription = o({ status: s, trialEndsAt: n, currentPeriodEndsAt: n, ...optional({ graceEndsAt: n, graceGrantedAt: n, lastPaymentId: s, paidTrial: trial }) });
const business = o({ ...strings('id slug name category phoneWhatsApp timezone'), ...optional(strings('ownerUid ownerEmail')), createdAt: n.optional(),
  socialLinks: z.array(o({ platform: s, url: s })).optional(), location: location.nullable().optional(), logo: logo.optional(), subscription,
  sarinConfig: o({ onboardingCompleted: b, tone: s, customRules: s, intakeFields: z.array(o({ key: s, label: s, required: b })) }), resources: z.array(resource), services: z.array(service), weeklySchedule: week });
const attendance = o({ revision: n, lastEventId: s });
const appointment = o({ ...strings('id tenantId dateKey startTimeStr endTimeStr resourceId'), type: z.enum(['appointment', 'manual_block']), status: z.enum(['confirmed', 'cancelled_by_client', 'cancelled_by_owner', 'completed', 'no_show']), createdBy: z.enum(['sarin_client', 'sarin_owner', 'manual_panel']), ...counts('startAt endAt reservedUntilAt createdAt'),
  ...optional({ serviceId: s, serviceName: s, price: money, rescheduleRevision: n, lastRescheduleProposalId: s, rescheduledAt: n, attendance,
    beneficiary: bookingBeneficiarySchema, subjectAuthorization: o({ receiptId: s, bookingRequestId: s, policyRevision: n }),
    representationReview: o({ revision: n, status: z.enum(['declared', 'reviewed', 'needs_contact']), reviewedAt: n.nullable(), reviewedBy: s.nullable() }),
    client: o({ uid: s, name: s, email: s, phone: s.optional(), intakeAnswers: z.record(s, s), hasNoShowHistory: b.optional() }), motivo: s }) });
const selection = o({ ...strings('dateKey startTimeStr serviceId resourceId') });
const rescheduleResult = o({ ...strings('proposalId appointmentId dateKey startTimeStr resourceId'), ...counts('revision startAt endAt confirmedAt') });
const proof = o({ receiptId: s, fingerprint: h, policyRevision: n });
const policy = o({ version: v, blocked: b, futureAppointmentLimit: n.nullable(), reason: s, updatedBy: s, updatedAt: n });
const subjectDecisions = o({ dataAuthorized: b, sensitiveDataAuthorized: b, representationDeclared: b });
const consentBusiness = o({ id: s, name: s, phoneWhatsApp: s });
const consentScope = z.enum(['account', 'business_client', 'platform_support']);
const consentAction = z.enum(['accept', 'revoke']);
const subjectDocuments = o({ ...strings('version dataAuthorization sensitiveDataAuthorization representationDeclaration notice alternative rights processors fingerprint'), scope: z.literal('booking_subject'), dataMode: z.enum(['general', 'health']), business: consentBusiness, case: subjectCase, policyRevision: n, purposes: z.array(s), categories: z.array(s), requirements: subjectDecisions });
const consentDocuments = o({ ...strings('version fingerprint'), scope: consentScope, business: consentBusiness.nullable(), ...optional(strings('termsAcceptance terms privacy dataAuthorization notice rights processors')), purposes: z.array(s).optional(), categories: z.array(s).optional() });
const teamState = o({ version: v, businessId: s, ...counts('revision requestedCount activeCount'), requestEvents: z.array(o({ at: n, requestHash: h })) });
const teamCommand = o({ ...strings('kind businessId actorUid requestId'), expectedMembershipRevision: n, expectedTeamRevision: n.nullable(), resourceId: s.nullable() });
const teamMember = o({ version: v, ...strings('id businessId memberUid status businessLabel lastEventId'), ...counts('revision createdAt updatedAt lastRequestedAt'), role, resourceId: s.nullable(), ownerUidAtApproval: s.nullable() });
const teamEvent = o({ version: v, ...strings('id businessId membershipId memberUid actorUid requestId'), commandHash: h, command: teamCommand, ...counts('sequence membershipRevision recordedAt'), beforeStatus: s.nullable(), afterStatus: s, role, resourceId: s.nullable() });
const ruleClosure = o({ ...strings('id fromDateKey throughDateKey label scope'), resourceId: s.optional(), interval: o({ start: s, end: s }).nullable() });
const schedulePolicy = o({ version: v, businessId: s, revision: n, updatedAt: n.nullable(), rules: o({ weekly: z.array(o({ resourceId: s, weeklySchedule: week })), exceptions: z.array(o({ resourceId: s, dateKey: s, day })), closures: z.array(ruleClosure) }) });
const budgetLimits = o({ globalDayUsd: z.number(), globalMonthUsd: z.number(), businessDayUsd: z.number(), businessMonthUsd: z.number(), ...counts('globalDayTokens globalMonthTokens businessDayTokens businessMonthTokens') });
const totals = counts('calls successfulCalls failedCalls usageReportedCalls missingUsageCalls costEstimatedCalls unknownCostCalls promptTokens cacheHitTokens cacheMissTokens completionTokens costNanoMin costNanoMax');
const usageCounters = counts('sent delivered read failed unknown serviceDelivered utilityDelivered marketingDelivered otherDelivered freeDelivered regularDelivered unknownPricingDelivered');
const cipher = o({ iv: z.string().max(24), tag: z.string().max(24), data: z.string().max(400000), version: v.optional() });
const whatsappCommon = { ...strings('businessId phoneNumberId wabaId'), ...counts('bodyExpiresAt expiresAt') };
const quotaCursor = o({ version: z.literal(2), after: h.nullable(), discoveryDone: b });
const budgetCall = o({ version: v, ...strings('id callId provider model pricingVersion businessId mode'), ...counts('inputNanoUsdPerToken outputNanoUsdPerToken createdAt maxTokens heldTokens maxCostNanoUsd'), actorHash: h, requestHash: h, periodIds: z.array(s), status: s, ...nullable(counts('actualTokens actualCostNanoUsd settledAt')), reconciliation: o({ resolution: s, reason: s, evidence: s, actorHash: h, at: n }).optional() });
const clientSource = o({ ...strings('dateKey resourceId'), ...counts('startAt endAt reservedUntilAt rescheduleRevision') });
const requestAnchors = o({ account: anchor, business: anchor, subject: anchor.nullable(), policyRevision: n });
const waitRequest = o({ ...strings('id serviceId dateKey'), case: subjectCase, resourceId: s.nullable(), createdAt: n, expiresAt: n, anchors: requestAnchors });
const intakeFields = z.array(o({ key: s, label: s, required: b }));
const offerTarget = o({ ...strings('serviceId serviceName resourceId resourceName dateKey startTimeStr endTimeStr'), ...counts('startAt endAt reservedUntilAt durationMinutes bufferMinutes priceCOP'), intakeFields });
const offerProposal = o({ id: s, requestId: s, createdAt: n, expiresAt: n, subjectCase, catalogFingerprint: h, resourceScheduleFingerprint: h, policyRevision: n });
const offerBooking = o({ ...strings('appointmentId proposalId entryId'), ...counts('previousWaitlistRevision resolvedWaitlistRevision confirmedAt'), source: o({ ...strings('dateKey resourceId serviceId'), ...counts('startAt endAt reservedUntilAt') }) });
const offerRecord = o({ version: v, ...strings('id businessId waitlistRecordId entryId clientUid ownerActorUid requestId dateKey'), ...counts('waitlistRevision headRevisionAtCreation createdAt expiresAt policyRevision'), commandFingerprint: h, requestFingerprint: h, catalogFingerprint: h, resourceScheduleFingerprint: h,
  target: offerTarget, catalog: o({ service, resource, intakeFields }), proposal: offerProposal.nullable(), state: z.enum(['offered', 'withdrawn', 'declined', 'expired', 'booked']), closedAt: n.nullable(), closedReason: z.enum(['withdrawn', 'declined', 'expired', 'booked']).nullable(), closedByUid: s.nullable(), booking: offerBooking.nullable() });
const rescheduleMetadata = o({ appointmentId: s, sourceRevision: n, sourceFingerprint: h, requestId: s, source: o({ ...strings('dateKey startTimeStr endTimeStr resourceId'), resourceName: s.optional(), priceCOP: money.optional() }), targetServiceId: s, targetResourceId: s });

export const BACKUP_CLASSIFIED_ROOTS = ['platformWhatsAppSpending', 'platformSupportConversations', 'platformSupportMessages', 'adminPaymentActions', 'users', 'businesses', 'businessMemberships', 'businessSlugs', 'publicBusinesses', 'paymentReceipts', 'paymentImages', 'platformSettings', 'serverSettings', 'invitations', 'businessLogos', 'chatStates', 'bookingProposals', 'responseQuotaScopes', 'responseQuotaTurns', 'responseQuotaReceipts', 'aiBudgetCalls', 'aiBudgetPeriods', 'aiUsageCalls', 'aiUsageMonths', 'aiUsageMeta', 'whatsappNumbers', 'whatsappBusinesses', 'whatsappInbox', 'whatsappOutbox', 'whatsappConversations', 'whatsappMessageIds', 'whatsappUsage', 'platformWhatsAppEvents', 'platformWhatsAppConversations', 'platformWhatsAppLinks', 'platformWhatsAppLinkChallenges', 'platformWhatsAppJobs', 'platformWhatsAppOutbox', 'platformWhatsAppBudgetCalls', 'platformWhatsAppBudgetPeriods'];
export const BACKUP_CLASSIFIED_CHILDREN = { businesses: ['appointments', 'attendanceEvents', 'ownerRescheduleProposals', 'bookingLocks', 'clientPolicies', 'reminderPreferences', 'reminderReceipts', 'waitlistRequests', 'waitlistOwnerReviews', 'waitlistOfferHeads', 'waitlistOffers', 'resourceSchedulePolicies', 'resourceScheduleOperations', 'factualFaq', 'factualFaqOperations', 'teamAccessEvents'], responseQuotaScopes: ['periods'], responseQuotaTurns: ['reviews'], aiUsageMonths: ['businesses'], whatsappUsage: ['businesses'] };

function serverSchema(id, data) {
  if (id === 'responseQuotaProtocol') return quotaProtocolSchema;
  if (id === 'responseQuotaRecoveryCursor') return quotaCursor;
  if (id === 'ai') return o({ provider: z.enum(['ollama', 'deepseek', 'gemini']), updatedAt: n });
  if (id === 'platform_whatsapp') return isPlatformWhatsAppConnectionRecord;
  if (id === 'platform_whatsapp_budget') return o({ version: n, ...counts('dayMicros monthMicros updatedAt'), updatedBy: s });
  if (/^platform_whatsapp_link_key_/.test(id)) return isPlatformWhatsAppLinkKeyMarker;
  if (/^booking_policy_[a-f0-9]{64}$/.test(id)) return o({ version: v, businessId: s, dataMode: z.enum(['general', 'health']), representedMinorsEnabled: b, revision: n, updatedAt: n, updatedBy: s, reason: s });
  if (/^business_team_/.test(id)) return teamState;
  if (/^team_request_uid_/.test(id)) return o({ version: v, uid: s, requestEvents: z.array(o({ at: n, requestHash: h })) });
  if (/^(?:client_rate_|inference_(?:tenant|business)_|admin_copilot_rate_)/.test(id)) return o({ version: v, events: z.array(o({ at: n, request: h, fingerprint: h })) });
  if (/^booking_action_(?:uid|business)_/.test(id)) return o({ version: v, events: z.array(o({ at: n, request: h })) });
  if (/^invitation_(?:email_)?rate_/.test(id)) return o({ version: n, timestamps: z.array(n) });
  if (/^invitation_code_/.test(id)) return o({ version: v, invitationId: s, codeHash: h });
  if (/^invitation_command_/.test(id)) return o({ fingerprint: h, action: s, at: n });
  if (/^consent_claim_/.test(id)) return o({ uid: s, receiptId: s, occurredAt: n });
  if (/^consent_state_/.test(id)) return o({ version: v, uid: s, scope: consentScope, businessId: s.nullable(), revision: n, active: b, fingerprint: h, receiptId: s });
  if (/^subject_state_/.test(id)) return o({ version: v, scope: z.literal('booking_subject'), uid: s, businessId: s, case: subjectCase, revision: n, active: b, fingerprint: h, receiptId: s, policyRevision: n });
  // Historical consent receipts can have noncanonical IDs; their complete field schema still applies.
  if (/^(?:consent_receipt_|subject_receipt_)/.test(id) || ['account', 'business_client', 'platform_support', 'booking_subject'].includes(data.scope) && ['accept', 'revoke'].includes(data.action) && data.documents) return data.scope === 'booking_subject'
    ? o({ uid: s, scope: z.literal('booking_subject'), businessId: s, case: subjectCase, requestId: s, action: consentAction, revision: n, occurredAt: n, policyRevision: n, decisions: subjectDecisions, documents: subjectDocuments, operationHash: h })
    : o({ uid: s, scope: consentScope, businessId: s.nullable(), requestId: s, action: consentAction, revision: n, occurredAt: n, preauthorizedAt: n.nullable(), termsAccepted: b, dataAuthorized: b, documents: consentDocuments, operationHash: h.optional() });
  if (id === 'pilotAiBudget') return o({ version: n, paused: b, limits: budgetLimits, reason: s, updatedAt: n, updatedBy: s });
  if (/^pilotAiBudgetBusiness_/.test(id)) return o({ businessId: s, version: n, limits: o({ businessDayUsd: z.number(), businessMonthUsd: z.number() }).nullable(), reason: s, updatedAt: n, updatedBy: s });
  if (id === 'ycloud_retry_diagnostic') return o({ version: v, runId: s, bootId: s, ...counts('createdAt expiresAt requests'), status: z.enum(['armed', 'pinned', 'compatible', 'incompatible', 'inconclusive', 'aborted', 'closed']), attempts: z.array(o({ eventId: s, bodySha256: h, arrivalUtc: s, signedT: n, hmacValid: z.literal(true) })) });
  return null;
}

function childSchema(root, child) {
  if (root === 'responseQuotaScopes' && child === 'periods') return responsePeriodSchema.strict();
  if (root === 'responseQuotaTurns' && child === 'reviews') return quotaReviewSchema;
  if (root === 'aiUsageMonths' && child === 'businesses') return o({ businessId: s.nullable(), ...totals });
  if (root === 'whatsappUsage' && child === 'businesses') return o(usageCounters);
  if (root !== 'businesses') return null;
  switch (child) {
    case 'appointments': return appointment;
    case 'clientPolicies': return policy;
    case 'teamAccessEvents': return teamEvent;
    case 'resourceSchedulePolicies': return schedulePolicy;
    case 'resourceScheduleOperations': return o({ version: v, businessId: s, actorUid: s, requestId: s, operationHash: h, resultRevision: n, appliedAt: n });
    case 'factualFaq': return factualFaqStateSchema;
    case 'factualFaqOperations': return o({ version: v, businessId: s, actorUid: s, requestId: s, commandFingerprint: h, applied: factualFaqAppliedSchema });
    case 'bookingLocks': return o({ version: n, updatedAt: n });
    case 'attendanceEvents': return o({ schemaVersion: v, ...strings('businessId appointmentId actorUid requestId previousStatus status'), requestFingerprint: h, ...counts('sequence recordedAt'), reason: z.enum(['initial', 'recording_error']), legacyPreviousOutcome: b, source: clientSource });
    case 'reminderPreferences': return o({ version: v, ownerUid: s, businessId: s, revision: n, enabled: b, offsetMinutes: n, updatedAt: n, anchors: o({ account: anchor, business: anchor }).nullable() });
    case 'reminderReceipts': return o({ version: v, ...strings('ownerUid businessId appointmentId'), ...counts('seenAt sourceRevision sourceStartAt offsetMinutes') });
    case 'waitlistRequests': return o({ version: v, ownerUid: s, businessId: s, revision: n, updatedAt: n, request: waitRequest.nullable(), lastOperation: o({ requestId: s, operationHash: h, appliedRevision: n }) });
    case 'waitlistOwnerReviews': return o({ version: z.union([v, z.literal(2)]), ...strings('businessId waitlistRecordId entryId actorUid'), waitlistRevision: n.optional(), revision: n, reviewed: b, updatedAt: n, lastOperation: o({ requestId: s, operationHash: h, appliedRevision: n }) });
    case 'ownerRescheduleProposals': return o({ version: v, ...strings('id businessId appointmentId requestId actorUid state'), sourceRevision: n, sourceFingerprint: h, commandFingerprint: h, catalogFingerprint: h, resourceScheduleFingerprint: h, createdAt: n, expiresAt: n,
      source: o({ ...strings('dateKey startTimeStr endTimeStr resourceId resourceName'), ...counts('startAt endAt reservedUntilAt'), priceCOP: n.nullable() }), target: o({ ...strings('dateKey startTimeStr endTimeStr resourceId resourceName serviceId serviceName'), ...counts('startAt endAt reservedUntilAt durationMinutes bufferMinutes priceCOP') }), result: rescheduleResult.nullable(), closedAt: n.optional(), closedReason: z.literal('expired').optional() });
    case 'waitlistOfferHeads': return o({ version: v, businessId: s, waitlistRecordId: s, entryId: s, revision: n, currentOfferId: s });
    case 'waitlistOffers': return offerRecord;
    default: return null;
  }
}

function rootSchema(root, id, data) {
  switch (root) {
    case 'users': return o({ uid: s, createdAt: n, ...optional({ email: s, displayName: s, photoURL: s, role: z.enum(['superadmin', 'user']), isSuperadmin: b, ownedTenantId: s, visitedTenants: z.array(s) }) });
    case 'businesses': case 'publicBusinesses': return business;
    case 'businessMemberships': return teamMember;
    case 'businessSlugs': return o({ businessId: s, ownerUid: s });
    case 'serverSettings': return serverSchema(id, data);
    case 'platformSupportConversations': case 'platformSupportMessages': return value => isSupportRecord(`${root}/${id}`, value);
    case 'adminPaymentActions': return value => isAdminPaymentRecord(`${root}/${id}`, value);
    case 'platformWhatsAppEvents': return isPlatformWhatsAppStoredEvent;
    case 'platformWhatsAppConversations': return isPlatformWhatsAppConversationRecord;
    case 'platformWhatsAppJobs': case 'platformWhatsAppOutbox': case 'platformWhatsAppBudgetCalls': case 'platformWhatsAppBudgetPeriods': return value => isWorkRecordAtPath(`${root}/${id}`, value);
    case 'platformWhatsAppLinks': case 'platformWhatsAppLinkChallenges': return isPlatformWhatsAppStoredLinkControl;
    case 'responseQuotaTurns': return quotaTurnSchema;
    case 'responseQuotaReceipts': return quotaReceiptSchema;
    case 'responseQuotaScopes': return o({ initializedAt: n });
    case 'aiBudgetCalls': return budgetCall;
    case 'aiBudgetPeriods': return o(counts('usedTokens reservedTokens usedCostNanoUsd reservedCostNanoUsd'));
    case 'aiUsageMonths': return o(totals);
    case 'aiUsageMeta': return o({ measurementStartedAt: n });
    case 'aiUsageCalls': return o({ ...strings('callId provider mode month pricingVersion'), model: s.nullable(), ...counts('startedAt finishedAt'), success: b, usage: o(counts('promptTokens cacheHitTokens cacheMissTokens completionTokens totalTokens')).nullable(), businessId: s.nullable(), ...nullable(counts('costNanoMin costNanoMax')), serviceTier: s.nullable().optional(), platformOutput: s.optional() });
    case 'platformWhatsAppSpending': return id.startsWith('call_') ? o({ maximumMicros: n, actualMicros: n.nullable(), periodIds: z.array(s), status: s }) : o({ usedMicros: n, heldMicros: n, blocked: b });
    case 'whatsappUsage': return o(usageCounters);
    case 'chatStates': return o({ version: n, selection: o(optional(strings('serviceId resourceId dateKey startTimeStr proposalId'))), updatedAt: n, expiresAt: n });
    case 'whatsappNumbers': return o({ ...strings('businessId phoneNumberId wabaId'), enabled: b, verifiedAt: n.nullable(), updatedAt: n, lastInboundAt: n.optional(), lastDeliveredAt: n.optional() });
    case 'whatsappBusinesses': return o({ phoneNumberId: s });
    case 'whatsappMessageIds': return o({ expiresAt: n, outboxId: s.optional() });
    case 'whatsappConversations': return o({ ...whatsappCommon, mode: z.enum(['bot', 'human', 'review']), revision: n, updatedAt: n, lastInboundAt: n.nullable(), lastHumanAt: n.nullable(), controlChangedAt: n, content: cipher.nullable().optional(), contactContent: cipher.nullable().optional(), controlEvents: z.array(o({ mode: z.enum(['bot', 'human', 'review']), actorUid: s.nullable(), source: z.enum(['admin', 'business_app', 'system']), at: n })).optional() });
    case 'whatsappInbox': case 'whatsappOutbox': return o({ ...whatsappCommon, ...strings('conversationId state'), ...counts('windowEndsAt nextAttemptAt'), ...optional({ createdAt: n, receivedAt: n, conversationRevision: n, content: cipher.nullable(), attempts: n, leaseId: s, reservation: quotaReservationSchema, sent: b, delivered: b, read: b, failed: b, metaMessageId: s, errorCode: n, pricing: o({ type: s, category: s }) }) });
    case 'paymentImages': return o({ ownerUid: s, createdAt: n.optional(), expiresAt: n.optional() });
    case 'businessLogos': return o({ businessId: s, ownerUid: s, sha256: h, createdAt: n });
    case 'paymentReceipts': return o({ ...strings('id tenantId tenantName ownerUid ownerEmail bankSelected status'), amountCOP: n, submittedAt: n, ...optional({ kind: s, appointmentAllowance: n, responseAllowance: n, quotaPeriodId: s, planId: s, periodDays: n, reviewedAt: n, reviewedBy: s, rejectionReason: s, receiptImageUrl: s, expiresAt: n, requestId: s }) });
    case 'invitations': return o({ ...strings('id codeHash maskedCode recipientEmail createdBy createFingerprint state'), ...counts('createdAt expiresAt expiresInDays version'), redemption: o({ ...strings('uid email businessId requestId trialPeriodId'), at: n }).optional(), codeRevocation: o({ at: n, by: s, reason: s }).optional(), access: o({ state: s, at: n, by: s, reason: s }).optional() });
    case 'platformSettings': return id === 'platform_support_recipient' ? isSupportRecipient : id === 'main' ? o({ companyName: s, ...counts('weeklyPriceCOP fortnightlyPriceCOP monthlyPriceCOP whatsappPriceCOP responsePackPriceCOP graceHoursOnUpload'), bankAccounts: z.array(o({ ...strings('id bankName accountType accountNumber holderName'), holderDoc: s.optional() })), tunnelStatus: o({ isOnline: b, lastPingAt: n }) }) : null;
    case 'bookingProposals': return id.startsWith('request_') ? o({ ...strings('proposalId actorUid businessId'), selection, reschedule: rescheduleMetadata.optional() }) : o({ version: z.union([v, z.literal(2)]), ...strings('id businessId actorUid'), selection, service, resource, intakeFields, createdAt: n, expiresAt: n, appointmentId: s.nullable(), ...optional({ subjectCase, beneficiaryHash: h, policyRevision: n, authorization: proof.nullable(), closedAt: n, reschedule: rescheduleMetadata, rescheduleResult }) });
    default: return null;
  }
}

// effectToken is a settlement/idempotency fence, retained as evidence; restored jobs remain non-executable controls.
const scrubbedKeys = new Set(['content', 'contactContent', 'intakeAnswers', 'knownIntakeData', 'reason', 'motivo', 'rejectionReason', 'evidence', 'secretHash', 'maskedCode', 'codeHash', 'receiptImageUrl', 'leaseId', 'leaseToken', 'sendToken', 'audioToken', 'generationToken', 'audioLeaseToken', 'generationLeaseToken']);
const codedReasons = new Set(['initial', 'recording_error', 'expired', 'unexpected_model_or_tier', 'usage_exceeded_reserved_bound']);
function scrub(value, reasons, key = '') {
  if (scrubbedKeys.has(key) && !(key === 'reason' && codedReasons.has(value))) {
    reasons.add(key === 'intakeAnswers' || key === 'knownIntakeData' ? 'FREE_ANSWERS_REMOVED' : key === 'content' || key === 'contactContent' ? 'BODY_REMOVED' : 'TRANSIENT_OR_FREE_TEXT_REMOVED');
    return key === 'intakeAnswers' || key === 'knownIntakeData' ? {} : null;
  }
  if (Array.isArray(value)) return value.map(item => scrub(item, reasons));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([field, item]) => [field, scrub(item, reasons, field)]));
  return value;
}

/** No source value escapes in an exception; a new field needs an explicit retention decision. */
export function classifyBackupDocument(path, data, now) {
  if (!Number.isSafeInteger(now) || now < 0 || !isDataPath(path, true) || !isDataJson(data) || !data || Array.isArray(data)) fail();
  const [root, id, child] = path.split('/');
  const schema = child ? childSchema(root, child) : rootSchema(root, id, data);
  if (!schema || !(typeof schema === 'function' ? schema(data) : schema.safeParse(data).success)) fail();
  const expirable = ['platformSupportMessages', 'platformSupportConversations', 'platformWhatsAppEvents', 'platformWhatsAppConversations', 'chatStates', 'paymentImages'];
  if (expirable.includes(root) && typeof data.expiresAt === 'number' && data.expiresAt <= now) return { kind: 'exclude', data: null, reasonCodes: ['EXPIRED'] };
  const reasons = new Set(), value = scrub(data, reasons);
  if (child === 'appointments' && data.type === 'manual_block' && Object.hasOwn(data, 'serviceName')) { value.serviceName = null; reasons.add('TRANSIENT_OR_FREE_TEXT_REMOVED'); }
  if (value.bodyState === 'body_present') value.bodyState = 'body_erased';
  if (value.state === 'body_present') value.state = 'body_erased';
  if (root === 'chatStates' || root === 'platformWhatsAppLinkChallenges') {
    return { kind: 'exclude', data: null, reasonCodes: ['TRANSIENT_STATE_EXCLUDED'] };
  }
  const control = reasons.has('TRANSIENT_OR_FREE_TEXT_REMOVED') || ['platformWhatsAppLinks', 'whatsappInbox', 'whatsappOutbox', 'platformWhatsAppJobs', 'platformWhatsAppOutbox', 'bookingProposals', 'invitations'].includes(root)
    || ['ownerRescheduleProposals', 'waitlistOffers'].includes(child) || root === 'serverSettings' && /^invitation_code_/.test(id);
  if (control) return { kind: 'control', data: { backupControl: { version: 1, executable: false }, value }, reasonCodes: [...reasons, 'RECOVERY_RECONCILIATION_REQUIRED'] };
  return { kind: reasons.size ? 'sanitize' : 'retain', data: value, reasonCodes: [...reasons] };
}
