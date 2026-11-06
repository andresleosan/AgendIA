import { z } from 'zod';
export const representativeRoleSchema = z.enum(['parent', 'legal_guardian']);
const requestId = z.string().min(8).max(128).regex(/^[A-Za-z0-9_-]+$/);
export const bookingSubjectCaseSchema = z.discriminatedUnion('subjectKind', [
  z.object({ bookingRequestId: requestId, subjectKind: z.literal('self') }).strict(),
  z.object({ bookingRequestId: requestId, subjectKind: z.literal('represented_minor'), representativeRole: representativeRoleSchema }).strict(),
]);
export const bookingBeneficiarySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('self') }).strict(),
  z.object({ kind: z.literal('represented_minor'), displayName: z.string().trim().min(1).max(80), representativeRole: representativeRoleSchema }).strict(),
]);
export type BookingSubjectKind = 'self' | 'represented_minor';
export type RepresentativeRole = z.infer<typeof representativeRoleSchema>;
export type BookingBeneficiary = z.infer<typeof bookingBeneficiarySchema>;
export type BookingSubjectCase = z.infer<typeof bookingSubjectCaseSchema>;
export type BookingDataPolicy = { version: 1; revision: number; dataMode: 'general' | 'health'; representedMinorsEnabled: boolean; reason: string; updatedAt: number; updatedBy: string } | Omit<import('./booking-admission').BookingPolicyV2, 'businessId'>;
export type BookingCapability = { configured: boolean; revision: number; dataMode: 'general' | 'health'; representedMinorsEnabled: boolean };
export type BookingSubjectDecisions = { dataAuthorized: boolean; sensitiveDataAuthorized: boolean; representationDeclared: boolean };
export type RepresentationReview = { revision: number; status: 'declared' | 'reviewed' | 'needs_contact'; reviewedBy: string | null; reviewedAt: number | null };
export type StructuredProposalContext = { case: BookingSubjectCase; beneficiary: BookingBeneficiary };
export type ValidatedBookingSubject = StructuredProposalContext & { proposalId: string; authorization: { receiptId: string; fingerprint: string; policyRevision: number } | null };
