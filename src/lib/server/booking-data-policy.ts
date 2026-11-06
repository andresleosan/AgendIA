import 'server-only';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ChatActor } from '@/types/chat';
import type { BookingDataPolicy } from '@/lib/booking-subject';
import { bookingPolicySchema, normalizeBookingAdmission, type BookingAdmissionCapability } from '@/lib/booking-admission';
import { BOOKING_ADMISSION_RELEASE, bookingAdmissionProtocolSchema, type BookingAdmissionRelease } from '@/lib/booking-admission-release';
import type { Database, Transaction } from '@/lib/storage/types';
import { StorageError } from '@/lib/storage/database';
import { getAdminDb } from '@/lib/firebase/admin';
import { isSuperadmin } from './auth';
import { documentIdSchema } from './schemas';
import { HttpError } from './http';
const count = z.number().int().nonnegative().safe();
export const bookingDataPolicyInputSchema = z.object({ businessId: documentIdSchema, expectedRevision: count.max(Number.MAX_SAFE_INTEGER - 1), dataMode: z.enum(['general', 'health']), representedMinorsEnabled: z.boolean(), reason: z.string().trim().min(1).max(300) }).strict();
export const bookingDataPolicyKey = (businessId: string) => `booking_policy_${createHash('sha256').update(JSON.stringify([businessId])).digest('hex')}`;
export async function readBookingDataPolicy(businessId: string, db: Database = getAdminDb(), tx?: Transaction, release: BookingAdmissionRelease = BOOKING_ADMISSION_RELEASE): Promise<{ policy: BookingDataPolicy | null; capability: BookingAdmissionCapability }> {
  documentIdSchema.parse(businessId);
  try {
    if (!tx) return await db.runTransaction(transaction => readBookingDataPolicy(businessId, db, transaction, release));
    const [doc, business, marker] = await Promise.all([tx.get(db.collection('serverSettings').doc(bookingDataPolicyKey(businessId))), tx.get(db.collection('businesses').doc(businessId)), tx.get(db.collection('serverSettings').doc('bookingAdmissionProtocol'))]);
    if (marker.exists ? release !== 'enforce' || !bookingAdmissionProtocolSchema.safeParse(marker.data()).success : release === 'enforce') throw Error('Incompatible booking admission protocol');
    const parsed = doc.exists ? bookingPolicySchema.parse(doc.data()) : null;
    if (parsed && parsed.businessId !== businessId) throw Error('Wrong business');
    const capability = normalizeBookingAdmission(parsed, business.data()?.ownerUid, release);
    if (!parsed) return { policy: null, capability };
    const { businessId: _id, ...policy } = parsed;
    return { policy, capability };
  } catch (error) {
    // The transaction runner must see conflicts so it can retry the complete snapshot.
    if (tx && (error instanceof StorageError && error.code === 'DATA_CONFLICT' || error && typeof error === 'object' && 'code' in error && error.code === 10)) throw error;
    throw new HttpError(503, 'La configuración de reservas requiere revisión.', 'BOOKING_POLICY_UNAVAILABLE');
  }
}
export async function assertBookingIntakePolicy(tx: Transaction, businessId: string, intakeFields: readonly unknown[], db: Database): Promise<void> {
  const { capability } = await readBookingDataPolicy(businessId, db, tx);
  if ((capability.dataMode === 'health' || capability.representedMinorsEnabled) && intakeFields.length) throw new HttpError(409, 'Retira los campos de texto libre para habilitar salud o reservas para menores.', 'BOOKING_FREE_INTAKE_NOT_ALLOWED');
}
export async function assertBusinessAllowsInference(businessId: string, db: Database = getAdminDb(), tx?: Transaction): Promise<void> {
  if ((await readBookingDataPolicy(businessId, db, tx)).capability.dataMode === 'health') throw new HttpError(409, 'Este negocio gestiona reservas mediante formulario. Usa la agenda o contacta directamente al negocio.', 'STRUCTURED_BOOKING_REQUIRED');
}
export async function saveBookingDataPolicy(admin: ChatActor, supplied: z.input<typeof bookingDataPolicyInputSchema>, db: Database = getAdminDb()): Promise<BookingDataPolicy> {
  if (!isSuperadmin(admin.uid)) throw new HttpError(403, 'Forbidden');
  const input = bookingDataPolicyInputSchema.parse(supplied);
  return db.runTransaction(async tx => {
    const [business, current] = await Promise.all([tx.get(db.collection('businesses').doc(input.businessId)), readBookingDataPolicy(input.businessId, db, tx)]);
    if (!business.exists) throw new HttpError(404, 'El negocio no existe.');
    if (current.policy?.version === 2) throw new HttpError(503, 'La clasificación requiere un escritor compatible.', 'BOOKING_POLICY_UNAVAILABLE');
    if (current.capability.revision !== input.expectedRevision) throw new HttpError(409, 'La clasificación cambió. Actualiza antes de guardar.', 'BOOKING_POLICY_CONFLICT');
    const intake = business.data()?.sarinConfig?.intakeFields;
    if (!Array.isArray(intake)) throw new HttpError(503, 'Revisa la configuración del negocio.');
    if ((input.dataMode === 'health' || input.representedMinorsEnabled) && intake.length) throw new HttpError(409, 'Retira los campos de texto libre antes de habilitar esta capacidad.', 'BOOKING_FREE_INTAKE_NOT_ALLOWED');
    const policy: BookingDataPolicy = { version: 1, revision: input.expectedRevision + 1, dataMode: input.dataMode, representedMinorsEnabled: input.representedMinorsEnabled, reason: input.reason, updatedAt: Date.now(), updatedBy: admin.uid };
    tx.set(db.collection('serverSettings').doc(bookingDataPolicyKey(input.businessId)), { ...policy, businessId: input.businessId }); return policy;
  });
}
