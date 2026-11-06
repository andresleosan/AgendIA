import { z } from 'zod';
import type { BookingCapability } from './booking-subject';
import type { BookingAdmissionRelease } from './booking-admission-release';

const count = z.number().int().nonnegative().safe();
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const uid = z.string().min(1).max(128);
const requestId = z.string().regex(/^[A-Za-z0-9_-]{8,128}$/);
const textVersion = z.string().min(1).max(128);
const declaration = z.object({ ownerUid: uid, textVersion, receiptId: id }).strict();
const classification = { dataMode: z.enum(['general', 'health']), representedMinorsEnabled: z.boolean() };
const provenance = { origin: z.enum(['owner', 'admin']), reason: z.string().max(300), declaration: declaration.nullable() };
const finalState = z.object({ ...classification, ...provenance, status: z.enum(['active', 'withdrawn', 'suspended']) }).strict();
const dispatchRef = z.object({ kind: z.enum(['quota', 'whatsapp']), id, policyRevision: count.min(1), startedAt: count }).strict();
const dispatchRefs = z.array(dispatchRef).max(64).refine(refs => new Set(refs.map(ref => JSON.stringify([ref.kind, ref.id]))).size === refs.length);
export const bookingDispatchHeadSchema = z.object({ version: z.literal(1), businessId: id, revision: count, refs: dispatchRefs }).strict();
const validAuthority = (value: { origin: string; status: string; dataMode: string; representedMinorsEnabled: boolean; declaration: unknown }) => value.origin !== 'owner' || value.dataMode === 'general' && !value.representedMinorsEnabled && value.declaration !== null && value.status !== 'suspended';
export const bookingPolicyV1Schema = z.object({ version: z.literal(1), businessId: id, revision: count.min(1), ...classification, updatedAt: count, updatedBy: uid, reason: z.string().min(1).max(300) }).strict();
export const bookingPolicyV2Schema = z.object({
  version: z.literal(2), businessId: id, revision: count.min(1), ...classification, ...provenance,
  status: z.enum(['active', 'withdrawn', 'suspended', 'transitioning']), updatedAt: count, updatedBy: uid,
  transition: z.object({ requestId, targetRevision: count.min(1), target: finalState.refine(validAuthority), startedAt: count, dispatchRefs }).strict().optional(),
}).strict().refine(value => validAuthority(value) && (value.status === 'transitioning'
  ? value.transition !== undefined && value.transition.targetRevision === value.revision
  : value.transition === undefined));
export const bookingPolicySchema = z.union([bookingPolicyV1Schema, bookingPolicyV2Schema]);
export const bookingPolicyOperationSchema = z.object({
  version: z.literal(1), businessId: id, actorUid: uid, requestId,
  action: z.enum(['declare', 'withdraw', 'classify', 'suspend', 'resume']), operationHash: z.string().regex(/^[a-f0-9]{64}$/),
  occurredAt: count, previousRevision: count.max(Number.MAX_SAFE_INTEGER - 1), targetRevision: count.min(1), phase: z.enum(['transitioning', 'applied']), textVersion: textVersion.optional(),
}).strict().refine(value => value.targetRevision === value.previousRevision + 1 && (value.action !== 'declare' || value.textVersion !== undefined));
export type BookingPolicyV2 = z.infer<typeof bookingPolicyV2Schema>;
export type BookingPolicy = z.infer<typeof bookingPolicySchema>;
export type BookingPolicyOperation = z.infer<typeof bookingPolicyOperationSchema>;
export type BookingDispatchHead = z.infer<typeof bookingDispatchHeadSchema>;
export type BookingDispatchRef = z.infer<typeof dispatchRef>;
export type BookingAdmissionState = 'active' | 'classification_required' | 'withdrawn' | 'administrative_review' | 'transitioning';
export const bookingAdmissionOperationSchema = z.enum(['inference', 'proposal', 'appointment', 'reschedule', 'intake', 'waitlist', 'offer', 'subject_acceptance', 'channel_reply']);
export type BookingAdmissionOperation = z.infer<typeof bookingAdmissionOperationSchema>;
export type BookingAdmissionCapability = BookingCapability & { admission: BookingAdmissionState; canStartBooking: boolean; canUseInference: boolean };

export function normalizeBookingAdmission(policy: BookingPolicy | null, ownerUid: unknown, release: BookingAdmissionRelease): BookingAdmissionCapability {
  let admission: BookingAdmissionState = !policy && release === 'enforce' ? 'classification_required' : 'active';
  if (policy?.version === 2) {
    if (policy.status === 'transitioning') admission = 'transitioning';
    else if (policy.status === 'suspended') admission = 'administrative_review';
    else if (policy.status === 'withdrawn') admission = 'withdrawn';
    else if (policy.origin === 'owner' && policy.declaration?.ownerUid !== ownerUid) admission = 'classification_required';
  }
  const dataMode = policy?.dataMode ?? 'general';
  return { configured: policy !== null, revision: policy?.revision ?? 0, dataMode, representedMinorsEnabled: policy?.representedMinorsEnabled ?? false, admission, canStartBooking: admission === 'active', canUseInference: admission === 'active' && dataMode === 'general' };
}
