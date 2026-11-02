import 'server-only';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Database as Firestore, Transaction } from '@/lib/storage/types';
import { getAdminDb } from '@/lib/firebase/admin';
import type { Appointment, Business, ResponseAllowance } from '@/types/firestore';
import type { ChatResponse } from '@/types/chat';
import { getBusinessAccess, isOwnerAiAllowed, isSubscriptionAllowed } from '@/lib/sarin/subscription';
import { HttpError } from './http';
import { documentIdSchema, requestIdSchema } from './schemas';
import { stableDocumentId } from './businesses';
import { initializeResponsePeriods, publicResponsePeriod, readResponsePeriodState, responsePeriodReference } from './response-periods';
import { quotaProtocolSchema, quotaReceiptId, quotaReceiptSchema, quotaReservationSchema, type QuotaIdentity } from '../../../shared/response-quota-records';
import { finishResponseQuota, parseStoredQuotaTurn, prepareResponseQuotaSettlement } from './response-quota-store';

const hash = (...parts: unknown[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
const requestSchema = z.object({ businessId: documentIdSchema.nullable(), actorUid: z.string().min(1).max(256), mode: z.enum(['sarin_client', 'sarin_owner_copilot', 'sarin_onboarding']), requestId: requestIdSchema, fingerprint: z.string().regex(/^[a-f0-9]{64}$/), channel: z.enum(['web', 'whatsapp']) }).strict();
export type ResponseQuotaInput = z.infer<typeof requestSchema>;
export interface ResponseQuotaReservation { reservationId: string; scopeId: string; periodId: string; attemptId: string; }
export type ResponseQuotaResult = { kind: 'reserved'; reservation: ResponseQuotaReservation } | { kind: 'replay'; reservation: ResponseQuotaReservation; response: null };
export function responseQuotaIdentity(input: ResponseQuotaInput): QuotaIdentity {
  const request = requestSchema.parse(input);
  return { quotaTurnId: hash(request.mode === 'sarin_onboarding' ? null : request.businessId, request.actorUid, request.mode, request.channel, request.requestId), expectedFingerprint: request.fingerprint, expectedScopeId: `business_${request.businessId}`, reservation: null };
}
export async function readResponseQuotaReservation(input: ResponseQuotaInput, db: Firestore = getAdminDb()) {
  const identity = responseQuotaIdentity(input), data = (await db.collection('responseQuotaTurns').doc(identity.quotaTurnId).get()).data();
  if (!data) return null;
  const turn = parseStoredQuotaTurn(data);
  if (turn.fingerprint !== identity.expectedFingerprint || turn.scopeId !== identity.expectedScopeId) throw new HttpError(409, 'Esta solicitud cambió.', 'AI_REQUEST_CONFLICT');
  return { status: turn.status, reservation: quotaReservationSchema.parse({ reservationId: turn.reservationId, scopeId: turn.scopeId, periodId: turn.periodId, attemptId: turn.attemptId }), execution: turn.execution };
}

export async function getResponseQuota(businessId: string, db: Firestore = getAdminDb()): Promise<ResponseAllowance> {
  documentIdSchema.parse(businessId);
  const document = await db.collection('businesses').doc(businessId).get();
  if (!document.exists) throw new HttpError(404, 'El negocio no existe.');
  const business = document.data() as Business;
  const state = await readResponsePeriodState(business, db);
  const period = state.current && publicResponsePeriod(state.current);
  const allowed = isSubscriptionAllowed(business) && period && (period.endsAt > Date.now() || (business.subscription.graceEndsAt ?? 0) > Date.now());
  return { businessId, currentPeriod: period, nextPeriod: state.next && publicResponsePeriod(state.next), warningThresholdPercent: 80,
    state: getBusinessAccess(business) === 'suspended' ? 'suspended' : !allowed ? 'expired' : period.remainingResponses === 0 ? 'exhausted' : period.usedResponses >= (period.includedResponses + period.extraResponses) * 0.8 ? 'warning' : 'active' };
}

/** Read-only recovery; never reserves capacity or creates a new turn. */
export async function hasResponseQuotaReplay(input: ResponseQuotaInput, db: Firestore = getAdminDb()): Promise<boolean> {
  const request = requestSchema.parse(input);
  const id = hash(request.mode === 'sarin_onboarding' ? null : request.businessId, request.actorUid, request.mode, request.channel, request.requestId);
  const saved = (await db.collection('responseQuotaTurns').doc(id).get()).data();
  if (!saved) return false;
  if (saved.fingerprint !== request.fingerprint) throw new HttpError(409, 'Este identificador pertenece a otra consulta.', 'AI_REQUEST_CONFLICT');
  return saved.status === 'completed' || saved.status === 'reserved';
}
export async function reserveResponseQuota(input: ResponseQuotaInput, db: Firestore = getAdminDb(), authorize?: (transaction: Transaction, business: Business) => Promise<void>, execution?: { deadlineAt: number }): Promise<ResponseQuotaResult> {
  const request = requestSchema.parse(input);
  if (request.businessId === null && request.mode !== 'sarin_onboarding') throw new HttpError(403, 'Primero configura tu negocio.');
  if (request.businessId === null) throw new HttpError(402, 'Primero envía tu comprobante y espera la aprobación del pago.', 'PAYMENT_REQUIRED');
  // Preserve the identity of existing onboarding turns for safe retries.
  const reservationId = hash(request.mode === 'sarin_onboarding' ? null : request.businessId, request.actorUid, request.mode, request.channel, request.requestId);
  const reference = db.collection('responseQuotaTurns').doc(reservationId);
  return db.runTransaction(async transaction => {
    const previous = await transaction.get(reference);
    if (previous.exists) {
      const saved = parseStoredQuotaTurn(previous.data());
      if (saved.fingerprint !== request.fingerprint) throw new HttpError(409, 'Este identificador pertenece a otra consulta.', 'AI_REQUEST_CONFLICT');
      const reservation: ResponseQuotaReservation = { reservationId, scopeId: saved.scopeId, periodId: saved.periodId, attemptId: saved.attemptId };
      if (saved.execution && saved.status !== 'reserved') await prepareResponseQuotaSettlement(transaction, db, { quotaTurnId: reservationId, expectedFingerprint: request.fingerprint, expectedScopeId: `business_${request.businessId}`, reservation }, saved.status === 'completed', { kind: 'dispatch_possible' }, Date.now());
      if (saved.status === 'completed') return { kind: 'replay', reservation, response: null };
      if (saved.status === 'reserved') {
        // The mutation may have committed before the process lost its reply or
        // quota acknowledgement. A matching authenticated turn can recover that
        // result while retaining and then settling the original reserved unit.
        if (request.mode === 'sarin_client') {
          const proposalRequest = await transaction.get(db.collection('bookingProposals').doc(`request_${stableDocumentId('proposal-request', request.businessId!, request.actorUid, request.requestId)}`));
          if (proposalRequest.exists) {
            const mapping = proposalRequest.data()!;
            if (mapping.actorUid !== request.actorUid || mapping.businessId !== request.businessId || !documentIdSchema.safeParse(mapping.proposalId).success) throw new HttpError(503, 'No se pudo validar la propuesta pendiente.');
            const proposal = await transaction.get(db.collection('bookingProposals').doc(mapping.proposalId));
            if (proposal.data()?.actorUid === request.actorUid && proposal.data()?.businessId === request.businessId) return { kind: 'replay', reservation, response: null };
          }
          const id = stableDocumentId(request.actorUid, stableDocumentId(request.requestId, 'crear_cita'), 'appointment');
          const document = await transaction.get(db.collection('businesses').doc(request.businessId!).collection('appointments').doc(id));
          const appointment = document.data() as Appointment | undefined;
          if (appointment?.type === 'appointment' && appointment.tenantId === request.businessId && appointment.client?.uid === request.actorUid) return { kind: 'replay', reservation, response: null };
        }
        throw new HttpError(409, 'La respuesta anterior sigue pendiente de confirmación.', 'AI_RESPONSE_PENDING');
      }
      if (saved.status !== 'released') throw new HttpError(503, 'No se pudo validar la capacidad de respuestas.');
      if (!saved.execution || saved.execution.origin !== 'v2') throw new HttpError(409, 'Este intento antiguo no puede repetirse. Envía un mensaje nuevo.', 'AI_RESPONSE_INTERRUPTED');
      const receipt = quotaReceiptSchema.safeParse((await transaction.get(db.collection('responseQuotaReceipts').doc(await quotaReceiptId(reservation)))).data());
      if (!receipt.success || receipt.data.decision !== 'released' || receipt.data.fingerprint !== saved.fingerprint || receipt.data.basis !== 'undispatched_fenced') throw new HttpError(503, 'No se pudo validar la devolución de cuota.', 'AI_QUOTA_INVALID');
    }
    const businessDocument = await transaction.get(db.collection('businesses').doc(request.businessId!));
    if (!businessDocument.exists) throw new HttpError(404, 'El negocio no existe.');
    const business = businessDocument.data() as Business;
    await authorize?.(transaction, business);
    if (request.mode !== 'sarin_client' && business.ownerUid !== request.actorUid) throw new HttpError(403, 'Esta operación es exclusiva del dueño del negocio.');
    if (request.mode === 'sarin_client' && (!business.sarinConfig.onboardingCompleted || !business.slug)) throw new HttpError(403, 'El negocio todavía no está configurado.');
    if (request.mode === 'sarin_owner_copilot' && !isOwnerAiAllowed(business)) throw new HttpError(402, 'El copiloto requiere una suscripción vigente.', 'OWNER_AI_REQUIRES_SUBSCRIPTION');
    if (request.channel === 'whatsapp' && !isOwnerAiAllowed(business)) throw new HttpError(402, 'WhatsApp requiere su plan vigente.', 'WHATSAPP_UNAVAILABLE');
    if (!isSubscriptionAllowed(business)) throw new HttpError(402, 'La suscripción está vencida.', 'SUBSCRIPTION_EXPIRED');
    const protocol = quotaProtocolSchema.safeParse((await transaction.get(db.collection('serverSettings').doc('responseQuotaProtocol'))).data());
    if (!protocol.success || !execution || !Number.isSafeInteger(execution.deadlineAt) || execution.deadlineAt <= Date.now()) throw new HttpError(503, 'La atención de IA está en preparación. La agenda sigue disponible.', 'AI_QUOTA_PROTOCOL_NOT_READY');
    const initialState = await readResponsePeriodState(business, db, transaction);
    if (!initialState.current || (initialState.current.endsAt <= Date.now() && (business.subscription.graceEndsAt ?? 0) <= Date.now())) throw new HttpError(402, 'No hay una vigencia disponible.', 'SUBSCRIPTION_EXPIRED');
    const scopeId = initialState.scopeId;
    const period = initialState.current;
    if (period.usedResponses + period.reservedResponses >= period.includedResponses + period.extraResponses) throw new HttpError(402, 'Se agotaron las respuestas de IA. La agenda continúa disponible.', 'AI_QUOTA_EXHAUSTED');
    const reservation: ResponseQuotaReservation = { reservationId, scopeId, periodId: period.id, attemptId: randomUUID() };
    initializeResponsePeriods(transaction, db, { ...initialState, current: null });
    transaction.set(responsePeriodReference(db, scopeId, period.id), { ...period, reservedResponses: period.reservedResponses + 1 });
    transaction.set(reference, { ...reservation, fingerprint: request.fingerprint, status: 'reserved', startedAt: Date.now(), mode: request.mode, channel: request.channel, nextAttemptAt: execution.deadlineAt, execution: { protocol: 2, origin: 'v2', phase: 'prepared', mayHaveDispatched: false, fenceRevision: 0, deadlineAt: execution.deadlineAt, providerCallId: null, result: null } });
    return { kind: 'reserved', reservation };
  });
}

export async function commitResponseQuota(reservation: ResponseQuotaReservation, _response?: ChatResponse, db: Firestore = getAdminDb()): Promise<void> {
  // Replies and tool arguments remain out of persistent quota accounting.
  await finishResponseQuota(reservation, true, db);
}
export async function releaseResponseQuota(reservation: ResponseQuotaReservation, db: Firestore = getAdminDb()): Promise<void> { await finishResponseQuota(reservation, false, db); }
