import 'server-only';
import { createHash } from 'node:crypto';
import type { Database, Transaction } from '@/lib/storage/types';
import { getAdminDb } from '@/lib/firebase/admin';
import { BOOKING_ADMISSION_RELEASE, bookingAdmissionProtocolSchema, type BookingAdmissionRelease } from '@/lib/booking-admission-release';
import { bookingAdmissionOperationSchema, type BookingAdmissionCapability, type BookingAdmissionOperation } from '@/lib/booking-admission';
import { readBookingDataPolicy } from './booking-data-policy';
import { HttpError } from './http';

const hash = (parts: string[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
export const bookingDispatchHeadKey = (businessId: string) => `booking_dispatch_${hash([businessId])}`;
export const bookingPolicyOperationKey = (businessId: string, actorUid: string, requestId: string) => `booking_policy_operation_${hash([businessId, actorUid, requestId])}`;
export async function readBookingAdmission(businessId: string, db: Database = getAdminDb(), tx?: Transaction, release: BookingAdmissionRelease = BOOKING_ADMISSION_RELEASE): Promise<BookingAdmissionCapability> {
  return (await readBookingDataPolicy(businessId, db, tx, release)).capability;
}
export async function assertBookingAdmission(tx: Transaction, business: { id: string; ownerUid?: string }, operation: BookingAdmissionOperation, db: Database, release: BookingAdmissionRelease = BOOKING_ADMISSION_RELEASE): Promise<BookingAdmissionCapability> {
  bookingAdmissionOperationSchema.parse(operation);
  if (!(await tx.get(db.collection('businesses').doc(business.id))).exists) throw new HttpError(404, 'El negocio no existe.');
  const capability = await readBookingAdmission(business.id, db, tx, release);
  const errors = { classification_required: 'BOOKING_CLASSIFICATION_REQUIRED', withdrawn: 'BOOKING_DECLARATION_WITHDRAWN', administrative_review: 'BOOKING_ADMIN_REVIEW_REQUIRED', transitioning: 'BOOKING_POLICY_TRANSITIONING' } as const;
  if (capability.admission !== 'active') throw new HttpError(409, 'La clasificación no permite iniciar esta operación. Consulta tus citas o contacta al negocio.', errors[capability.admission]);
  if (operation === 'inference' && !capability.canUseInference) throw new HttpError(409, 'Este negocio gestiona reservas mediante formulario.', 'STRUCTURED_BOOKING_REQUIRED');
  return capability;
}
export async function ensureBookingAdmissionProtocol(db: Database, candidateSha: string, release: BookingAdmissionRelease = BOOKING_ADMISSION_RELEASE): Promise<void> {
  if (release !== 'enforce') throw new HttpError(503, 'El candidato aún prepara la admisión.', 'BOOKING_POLICY_UNAVAILABLE');
  const marker = bookingAdmissionProtocolSchema.parse({ version: 1, minimumReader: 2, introducedBySha: candidateSha });
  await db.runTransaction(async tx => {
    const ref = db.collection('serverSettings').doc('bookingAdmissionProtocol'), current = await tx.get(ref);
    if (current.exists) {
      if (!bookingAdmissionProtocolSchema.safeParse(current.data()).success) throw new HttpError(503, 'El protocolo requiere revisión.', 'BOOKING_POLICY_UNAVAILABLE');
    } else tx.create(ref, marker);
  });
}
