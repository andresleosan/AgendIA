import 'server-only';
import { readResourceSchedulePolicy } from './resource-schedules';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { getAdminDb } from '@/lib/firebase/admin';
import type { Database } from '@/lib/storage/types';
import type { Business, Appointment } from '@/types/firestore';
import type { ChatActor, BookingProposalView } from '@/types/chat';
import { isSubscriptionAllowed } from '@/lib/sarin/subscription';
import { getAvailableSlots, toColombiaTimestamp, toMinutes, toTimeStr } from '@/lib/sarin/availability';
import { stableDocumentId } from './businesses';
import { assertClientCanBook } from './client-policy';
import { createAppointmentInTransaction } from './bookings';
import { businessConfigSchema, bookingSchema, documentIdSchema, requestIdSchema, type BookingInput } from './schemas';
import { HttpError } from './http';
import { assertConsent } from './consent';
import { bookingSubjectCaseSchema, bookingBeneficiarySchema, type StructuredProposalContext, type ValidatedBookingSubject } from '@/lib/booking-subject';
import { readBookingDataPolicy, assertBookingIntakePolicy } from './booking-data-policy';
import { assertBookingSubjectConsent, bookingSubjectHash } from './booking-subject-consent';
import { prepareBookingActionAdmission } from './booking-action-admission';
import { appointmentRescheduleViewSchema, rescheduleResultSchema, type RescheduleResult } from '@/lib/appointment-reschedule';
import { appointmentRescheduleFingerprint, assertRescheduleAccess, assertRescheduleSource, currentRescheduleService, readRescheduleSource, resolveRescheduleSubject, rescheduleAppointmentInTransaction, type AppointmentRescheduleContext, type AppointmentRescheduleMetadata } from './appointment-rescheduling';
import { assertClientCanReschedule } from './client-policy';
import type { QuotaEffectHooks } from './response-quota-store';
const selectionSchema = bookingSchema.pick({ dateKey: true, startTimeStr: true, serviceId: true, resourceId: true });
const rescheduleMetadataSchema = appointmentRescheduleViewSchema.extend({ sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/), requestId: requestIdSchema }).strict();
const legacyProposalSchema = z.object({ version: z.literal(1), id: documentIdSchema, businessId: documentIdSchema, actorUid: z.string().min(1).max(128), selection: selectionSchema,
  service: businessConfigSchema.shape.services.element, resource: businessConfigSchema.shape.resources.element, intakeFields: businessConfigSchema.shape.intakeFields,
  createdAt: z.number().int().nonnegative(), expiresAt: z.number().int().nonnegative(), appointmentId: documentIdSchema.nullable(),
  reschedule: rescheduleMetadataSchema.optional(), rescheduleResult: rescheduleResultSchema.optional(), closedAt: z.number().int().nonnegative().safe().optional(),
}).strict();
const authorizationSchema = z.object({ receiptId: documentIdSchema, fingerprint: z.string().regex(/^[a-f0-9]{64}$/), policyRevision: z.number().int().nonnegative().safe() }).strict();
const proposalSchema = z.discriminatedUnion('version', [legacyProposalSchema, legacyProposalSchema.extend({ version: z.literal(2), subjectCase: bookingSubjectCaseSchema, beneficiaryHash: z.string().regex(/^[a-f0-9]{64}$/), policyRevision: z.number().int().nonnegative().safe(), authorization: authorizationSchema.nullable(), closedAt: z.number().int().nonnegative().safe().optional() }).strict()]);
type Proposal = z.infer<typeof proposalSchema>;
export const proposalRequestKey = (uid: string, businessId: string, requestId: string) => `request_${stableDocumentId('proposal-request', businessId, uid, requestId)}`;
function parse(value: unknown): Proposal {
  const parsed = proposalSchema.safeParse(value); if (!parsed.success) throw new HttpError(503, 'No se pudo validar la propuesta de reserva.'); return parsed.data;
}
function view(proposal: Proposal): BookingProposalView {
  const reschedule = proposal.reschedule ? (({ sourceFingerprint: _private, requestId: _request, ...publicView }) => publicView)(proposal.reschedule) : undefined;
  return { id: proposal.id, businessId: proposal.businessId, serviceName: proposal.service.name, resourceName: proposal.resource.name, dateKey: proposal.selection.dateKey, startTimeStr: proposal.selection.startTimeStr,
    endTimeStr: toTimeStr(toMinutes(proposal.selection.startTimeStr) + proposal.service.durationMinutes), priceCOP: proposal.service.price, expiresAt: proposal.expiresAt, intakeFields: proposal.intakeFields, ...(proposal.version === 2 ? { subjectCase: proposal.subjectCase } : {}), ...(reschedule ? { reschedule } : {}) };
}
export async function createBookingProposal(user: ChatActor, businessId: string, input: Pick<BookingInput, 'dateKey' | 'startTimeStr' | 'serviceId' | 'resourceId'>, requestId: string, db: Database = getAdminDb(), suppliedSubject?: StructuredProposalContext, reschedule?: AppointmentRescheduleContext, quota?: QuotaEffectHooks): Promise<BookingProposalView> {
  documentIdSchema.parse(businessId); requestIdSchema.parse(requestId);
  const requestedSelection = selectionSchema.parse(input), id = randomBytes(24).toString('base64url');
  const supplied = suppliedSubject ? { case: bookingSubjectCaseSchema.parse(suppliedSubject.case), beneficiary: bookingBeneficiarySchema.parse(suppliedSubject.beneficiary) } : undefined;
  if (reschedule && supplied) throw new HttpError(400, 'El beneficiario del cambio lo determina la cita.');
  if (reschedule) { documentIdSchema.parse(reschedule.appointmentId); z.number().int().nonnegative().safe().parse(reschedule.sourceRevision); }
  if (supplied && (supplied.case.bookingRequestId !== requestId || supplied.case.subjectKind !== supplied.beneficiary.kind || (supplied.case.subjectKind === 'represented_minor' && (supplied.beneficiary.kind !== 'represented_minor' || supplied.case.representativeRole !== supplied.beneficiary.representativeRole)))) throw new HttpError(400, 'El beneficiario no corresponde a este caso.');
  const businessRef = db.collection('businesses').doc(businessId), collection = db.collection('bookingProposals'), requestRef = collection.doc(proposalRequestKey(user.uid, businessId, requestId));
  return db.runTransaction(async tx => {
    const [businessDoc, mapping] = await Promise.all([tx.get(businessRef), tx.get(requestRef)]);
    let previous: Proposal | null = null;
    if (mapping.exists) {
      const saved = mapping.data()!;
      const boundSelection = reschedule ? { ...requestedSelection, serviceId: saved.selection?.serviceId } : requestedSelection;
      if (saved.actorUid !== user.uid || saved.businessId !== businessId || bookingSubjectHash(saved.selection) !== bookingSubjectHash(boundSelection) || Boolean(saved.reschedule) !== Boolean(reschedule) || (reschedule && (saved.reschedule.appointmentId !== reschedule.appointmentId || saved.reschedule.sourceRevision !== reschedule.sourceRevision))) throw new HttpError(409, 'La solicitud pertenece a otra propuesta.');
      previous = parse((await tx.get(collection.doc(documentIdSchema.parse(saved.proposalId)))).data());
      const requestedSubjectCase = reschedule?.case ?? supplied?.case;
      if (previous.actorUid !== user.uid || previous.businessId !== businessId || bookingSubjectHash(previous.selection) !== bookingSubjectHash(boundSelection) || bookingSubjectHash(previous.reschedule ?? null) !== bookingSubjectHash(saved.reschedule ?? null) || (requestedSubjectCase ? previous.version !== 2 || bookingSubjectHash(previous.subjectCase) !== bookingSubjectHash(requestedSubjectCase) || (supplied && previous.beneficiaryHash !== bookingSubjectHash(supplied.beneficiary)) : previous.version !== 1)) throw new HttpError(409, 'La referencia ya está vinculada a otro beneficiario o propuesta.', 'BOOKING_SUBJECT_CONFLICT');
      if (previous.appointmentId) return view(previous);
    }
    if (!businessDoc.exists) throw new HttpError(404, 'El negocio no existe.');
    const business = businessDoc.data() as Business;
    const source = reschedule ? await readRescheduleSource(tx, user, businessId, reschedule, db) : undefined;
    const selection = source ? { ...requestedSelection, serviceId: currentRescheduleService(business, source).id } : requestedSelection;
    await assertConsent(user.uid, 'account', undefined, db, tx);
    await assertConsent(user.uid, 'business_client', business, db, tx);
    const { capability } = await readBookingDataPolicy(businessId, db, tx);
    const subject = source ? resolveRescheduleSubject(source, reschedule?.case, capability, requestId) : supplied;
    if (!subject && capability.dataMode === 'health') throw new HttpError(409, 'Utiliza el formulario para esta reserva.', 'STRUCTURED_BOOKING_REQUIRED');
    const authorization = subject ? await assertBookingSubjectConsent(tx, user, business, subject.case, db) : null;
    await assertBookingIntakePolicy(tx, businessId, business.sarinConfig.intakeFields, db);
    if (source) await assertClientCanReschedule(tx, business, user.uid, db);
    if (previous) {
      if (previous.version === 2 && (previous.policyRevision !== capability.revision || bookingSubjectHash(previous.authorization) !== bookingSubjectHash(authorization))) throw new HttpError(409, 'La política o autorización cambió. Inicia una nueva reserva.', 'BOOKING_PROPOSAL_CHANGED');
      if (source && (appointmentRescheduleFingerprint(source) !== previous.reschedule?.sourceFingerprint || (previous.version === 2 && previous.beneficiaryHash !== bookingSubjectHash(subject?.beneficiary)))) throw new HttpError(409, 'La cita cambió. Actualiza Mis citas.', 'RESCHEDULE_SOURCE_CHANGED');
      if (source && reschedule) { const now = Date.now(); assertRescheduleSource(source, user, businessId, reschedule, now); assertRescheduleAccess(business, now); }
      const apply = await quota?.prepare(tx, { kind: 'proposal', id: previous.id }); apply?.();
      return view(previous);
    }
    if (!business.sarinConfig.onboardingCompleted || !business.slug) throw new HttpError(403, 'El negocio todavía no está configurado.');
    if (!source) {
      if (!isSubscriptionAllowed(business)) throw new HttpError(402, 'Activa una suscripción para continuar.');
      await assertClientCanBook(tx, business, user.uid, Date.now(), db);
    }
    const service = business.services.find(item => item.id === selection.serviceId), resource = business.resources.find(item => item.id === selection.resourceId && item.active);
    if (!service || !resource || !service.resourceIds.includes(resource.id)) throw new HttpError(400, 'Selecciona un servicio y profesional del negocio.');
    if (source && source.dateKey === selection.dateKey && source.startTimeStr === selection.startTimeStr && source.resourceId === selection.resourceId) throw new HttpError(400, 'Selecciona un horario o profesional diferente.', 'RESCHEDULE_NO_CHANGE');
    const appointments = await tx.get(businessRef.collection('appointments').where('dateKey', '==', selection.dateKey).where('resourceId', '==', selection.resourceId).where('status', '==', 'confirmed'));
    const admit = subject || source ? await prepareBookingActionAdmission(tx, db, user.uid, businessId, 'proposal', requestId) : null;
    const now = Date.now();
    if (source && reschedule) { assertRescheduleSource(source, user, businessId, reschedule, now); assertRescheduleAccess(business, now); }
    if (toColombiaTimestamp(selection.dateKey, '00:00') > now + 366 * 86400000) throw new HttpError(400, 'Puedes reservar hasta un año por adelantado.');
    if (!getAvailableSlots({ resourceSchedulePolicy: await readResourceSchedulePolicy(tx, business.id, db), tenant: business, ...selection, existingAppointments: appointments.docs.filter(doc => doc.id !== source?.id).map(doc => doc.data() as Appointment), now }).some(item => item.slots.includes(selection.startTimeStr))) throw new HttpError(409, 'El horario ya no está disponible.');
    const metadata: AppointmentRescheduleMetadata | undefined = source && reschedule ? { appointmentId: source.id, sourceRevision: reschedule.sourceRevision, sourceFingerprint: appointmentRescheduleFingerprint(source), requestId, source: { dateKey: source.dateKey, startTimeStr: source.startTimeStr, endTimeStr: source.endTimeStr, resourceId: source.resourceId, ...(business.resources.find(item => item.id === source.resourceId)?.name ? { resourceName: business.resources.find(item => item.id === source.resourceId)!.name } : {}), ...(source.price !== undefined ? { priceCOP: source.price } : {}) }, targetServiceId: service.id, targetResourceId: resource.id } : undefined;
    const proposal: Proposal = proposalSchema.parse({ version: subject ? 2 : 1, id, businessId, actorUid: user.uid, selection, service, resource, intakeFields: subject && (capability.dataMode === 'health' || subject.case.subjectKind === 'represented_minor') ? [] : business.sarinConfig.intakeFields, createdAt: now, expiresAt: now + 600000, appointmentId: null,
      ...(subject ? { subjectCase: subject.case, beneficiaryHash: bookingSubjectHash(subject.beneficiary), policyRevision: capability.revision, authorization } : {}), ...(metadata ? { reschedule: metadata } : {}) });
    const applyQuota = await quota?.prepare(tx, { kind: 'proposal', id });
    admit?.(); tx.create(collection.doc(id), proposal); tx.create(requestRef, { actorUid: user.uid, businessId, selection, proposalId: id, ...(metadata ? { reschedule: metadata } : {}) }); applyQuota?.();
    return view(proposal);
  });
}
type ProposalContact = { clientPhone: unknown; intakeAnswers: unknown; beneficiary?: unknown };
export type BookingProposalConfirmation = { appointment: Appointment; rescheduleResult?: RescheduleResult };
export async function confirmBookingProposalDetailed(user: ChatActor, businessId: string, proposalId: string, contact: ProposalContact, db: Database = getAdminDb()): Promise<BookingProposalConfirmation> {
  documentIdSchema.parse(businessId); documentIdSchema.parse(proposalId);
  const ref = db.collection('bookingProposals').doc(proposalId), businessRef = db.collection('businesses').doc(businessId);
  const result = await db.runTransaction(async tx => {
    const [document, businessDoc] = await Promise.all([tx.get(ref), tx.get(businessRef)]);
    if (!document.exists) throw new HttpError(404, 'La propuesta no existe.');
    const proposal = parse(document.data());
    if (proposal.businessId !== businessId) throw new HttpError(404, 'La propuesta no existe.');
    if (proposal.actorUid !== user.uid) throw new HttpError(403, 'Esta propuesta pertenece a otra cuenta.');
    if (proposal.appointmentId) {
      const appointment = (await tx.get(businessRef.collection('appointments').doc(proposal.appointmentId))).data() as Appointment | undefined;
      if (!appointment || appointment.client?.uid !== user.uid || appointment.tenantId !== businessId) throw new HttpError(503, 'No se pudo recuperar la cita.');
      if (proposal.reschedule && (!proposal.rescheduleResult || proposal.rescheduleResult.proposalId !== proposal.id || proposal.rescheduleResult.appointmentId !== proposal.appointmentId || proposal.rescheduleResult.revision !== proposal.reschedule.sourceRevision + 1 || proposal.rescheduleResult.dateKey !== proposal.selection.dateKey || proposal.rescheduleResult.startTimeStr !== proposal.selection.startTimeStr || proposal.rescheduleResult.resourceId !== proposal.selection.resourceId)) throw new HttpError(503, 'No se pudo recuperar el resultado del cambio.');
      return { appointment, ...(proposal.rescheduleResult ? { rescheduleResult: proposal.rescheduleResult } : {}) };
    }
    const now = Date.now();
    if ((proposal.version === 2 || proposal.reschedule) && (proposal.closedAt !== undefined || proposal.expiresAt <= now)) {
      // Commit a terminal state that conflicts with an older confirmation.
      // Throwing inside the transaction would roll this closure back.
      if (proposal.closedAt === undefined) tx.set(ref, { ...proposal, closedAt: now });
      return null;
    }
    if (proposal.expiresAt <= now) throw new HttpError(409, 'La propuesta venció. Consulta otra vez la disponibilidad.', 'BOOKING_PROPOSAL_EXPIRED');
    if (!businessDoc.exists) throw new HttpError(404, 'El negocio no existe.');
    const business = businessDoc.data() as Business;
    if (proposal.reschedule) {
      const mapping = (await tx.get(db.collection('bookingProposals').doc(proposalRequestKey(user.uid, businessId, proposal.reschedule.requestId)))).data();
      if (!mapping || mapping.actorUid !== user.uid || mapping.businessId !== businessId || mapping.proposalId !== proposal.id || bookingSubjectHash(mapping.selection) !== bookingSubjectHash(proposal.selection) || bookingSubjectHash(mapping.reschedule ?? null) !== bookingSubjectHash(proposal.reschedule) || (proposal.version === 2 && proposal.subjectCase.bookingRequestId !== proposal.reschedule.requestId)) throw new HttpError(503, 'No se pudo validar la referencia del cambio de horario.');
    }
    const { capability } = await readBookingDataPolicy(businessId, db, tx);
    if (proposal.version === 1 && capability.dataMode === 'health') throw new HttpError(409, 'Utiliza el formulario para esta reserva.', 'STRUCTURED_BOOKING_REQUIRED');
    let subject: ValidatedBookingSubject | undefined;
    if (proposal.version === 2) {
      const beneficiary = bookingBeneficiarySchema.parse(contact.beneficiary);
      if (bookingSubjectHash(beneficiary) !== proposal.beneficiaryHash || beneficiary.kind !== proposal.subjectCase.subjectKind || (beneficiary.kind === 'represented_minor' && (proposal.subjectCase.subjectKind !== 'represented_minor' || beneficiary.representativeRole !== proposal.subjectCase.representativeRole))) throw new HttpError(409, 'El beneficiario cambió. Inicia una nueva reserva.', 'BOOKING_SUBJECT_CONFLICT');
      const authorization = await assertBookingSubjectConsent(tx, user, business, proposal.subjectCase, db);
      if (proposal.policyRevision !== capability.revision || bookingSubjectHash(authorization) !== bookingSubjectHash(proposal.authorization)) throw new HttpError(409, 'La política o autorización cambió. Inicia una nueva reserva.', 'BOOKING_PROPOSAL_CHANGED');
      const mapping = (await tx.get(db.collection('bookingProposals').doc(proposalRequestKey(user.uid, businessId, proposal.subjectCase.bookingRequestId)))).data();
      if (!mapping || mapping.actorUid !== user.uid || mapping.businessId !== businessId || mapping.proposalId !== proposal.id || bookingSubjectHash(mapping.selection) !== bookingSubjectHash(proposal.selection)) throw new HttpError(503, 'No se pudo validar la referencia de reserva.');
      subject = { case: proposal.subjectCase, beneficiary, authorization, proposalId: proposal.id };
    }
    await assertBookingIntakePolicy(tx, businessId, business.sarinConfig.intakeFields, db);
    const service = businessConfigSchema.shape.services.element.safeParse(business.services.find(item => item.id === proposal.selection.serviceId)), resource = businessConfigSchema.shape.resources.element.safeParse(business.resources.find(item => item.id === proposal.selection.resourceId));
    const current = { service: service.success ? service.data : null, resource: resource.success ? resource.data : null, intakeFields: businessConfigSchema.shape.intakeFields.parse(business.sarinConfig.intakeFields) };
    if (bookingSubjectHash(current) !== bookingSubjectHash({ service: proposal.service, resource: proposal.resource, intakeFields: proposal.intakeFields })) throw new HttpError(409, 'El catálogo cambió. Solicita una propuesta actualizada.', 'BOOKING_PROPOSAL_CHANGED');
    if (proposal.reschedule) {
      const result = await rescheduleAppointmentInTransaction(tx, user, business, proposal.selection, proposal.id, proposal.reschedule, proposal.expiresAt, contact, db, subject);
      if (!result) { tx.set(ref, { ...proposal, closedAt: Date.now() }); return null; }
      tx.set(ref, { ...proposal, appointmentId: result.appointment.id, rescheduleResult: result.rescheduleResult });
      return result;
    }
    const input = bookingSchema.parse({ ...proposal.selection, clientPhone: contact.clientPhone, intakeAnswers: contact.intakeAnswers });
    if (Object.keys(input.intakeAnswers).some(key => !proposal.intakeFields.some(field => field.key === key))) throw new HttpError(400, 'Las respuestas no corresponden a los campos de esta propuesta.');
    const appointment = await createAppointmentInTransaction(tx, user, business, input, `proposal-${proposal.id}`, db, now, subject);
    tx.set(ref, { ...proposal, appointmentId: appointment.id });
    return { appointment };
  });
  if (!result) throw new HttpError(409, 'La propuesta está cerrada. Inicia otra reserva.', 'BOOKING_PROPOSAL_CLOSED');
  return result;
}
export async function confirmBookingProposal(user: ChatActor, businessId: string, proposalId: string, contact: ProposalContact, db: Database = getAdminDb()): Promise<Appointment> {
  return (await confirmBookingProposalDetailed(user, businessId, proposalId, contact, db)).appointment;
}
export async function recoverBookingProposal(user: ChatActor, businessId: string, requestId: string, db: Database = getAdminDb()): Promise<{ proposal: BookingProposalView; appointment?: Appointment } | null> {
  const mapping = (await db.collection('bookingProposals').doc(proposalRequestKey(user.uid, businessId, requestId)).get()).data();
  if (!mapping) return null;
  if (mapping.actorUid !== user.uid || mapping.businessId !== businessId) throw new HttpError(403, 'La propuesta pertenece a otra cuenta.');
  const proposal = parse((await db.collection('bookingProposals').doc(documentIdSchema.parse(mapping.proposalId)).get()).data());
  if (proposal.actorUid !== user.uid || proposal.businessId !== businessId) throw new HttpError(503, 'No se pudo validar la propuesta.');
  const appointment = proposal.appointmentId ? (await db.collection('businesses').doc(businessId).collection('appointments').doc(proposal.appointmentId).get()).data() as Appointment | undefined : undefined;
  if (proposal.appointmentId && (!appointment || appointment.client?.uid !== user.uid || appointment.tenantId !== businessId)) throw new HttpError(503, 'No se pudo recuperar la cita.');
  return { proposal: view(proposal), ...(appointment ? { appointment } : {}) };
}
