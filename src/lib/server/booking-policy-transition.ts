import 'server-only';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Database, Transaction } from '@/lib/storage/types';
import type { ChatActor } from '@/types/chat';
import { getAdminDb } from '@/lib/firebase/admin';
import { bookingDispatchHeadSchema, bookingPolicyOperationSchema, bookingPolicyV2Schema, normalizeBookingAdmission, type BookingAdmissionOperation, type BookingDispatchRef } from '@/lib/booking-admission';
import { BOOKING_ADMISSION_RELEASE, type BookingAdmissionRelease } from '@/lib/booking-admission-release';
import { assertBookingAdmission, bookingDispatchHeadKey, bookingPolicyOperationKey } from './booking-admission';
import { bookingDataPolicyKey, readBookingDataPolicy } from './booking-data-policy';
import { isSuperadmin } from './auth';
import { HttpError } from './http';

const unavailable = () => new HttpError(503, 'No se pudo comprobar la transición.', 'BOOKING_POLICY_UNAVAILABLE');
const conflict = () => new HttpError(409, 'La clasificación cambió. Actualiza antes de guardar.', 'BOOKING_POLICY_CONFLICT');
const transitioning = () => new HttpError(409, 'La clasificación está cambiando.', 'BOOKING_POLICY_TRANSITIONING');
const sameRef = (a: BookingDispatchRef, b: Pick<BookingDispatchRef, 'kind' | 'id'>) => a.kind === b.kind && a.id === b.id;
type Gate = { tail: Promise<void>; starting: Promise<void> | null; closing: Set<object>; users: number };
const singleton = globalThis as typeof globalThis & { __sarinBookingDispatchGates?: Map<string, Gate> };
const gates = singleton.__sarinBookingDispatchGates ??= new Map();
function gateFor(businessId: string): Gate {
  let gate = gates.get(businessId); if (!gate) { gate = { tail: Promise.resolve(), starting: null, closing: new Set(), users: 0 }; gates.set(businessId, gate); }
  gate.users++;
  return gate;
}
function releaseGate(businessId: string, gate: Gate) { if (--gate.users === 0 && !gate.closing.size) gates.delete(businessId); }
async function readHead(tx: Transaction, db: Database, businessId: string) {
  const ref = db.collection('serverSettings').doc(bookingDispatchHeadKey(businessId));
  const saved = await tx.get(ref);
  const parsed = bookingDispatchHeadSchema.safeParse(saved.exists ? saved.data() : { version: 1, businessId, revision: 0, refs: [] });
  if (!parsed.success || parsed.data.businessId !== businessId) throw unavailable();
  return { ref, head: parsed.data, exists: saved.exists };
}

/** Stage all reads before the caller writes its quota/outbox marker (Firestore). */
export async function prepareBookingDispatchRegistration(tx: Transaction, db: Database, businessId: string, identity: Pick<BookingDispatchRef, 'kind' | 'id'>, release: BookingAdmissionRelease = BOOKING_ADMISSION_RELEASE): Promise<() => void> {
  const capability = await assertBookingAdmission(tx, { id: businessId }, identity.kind === 'quota' ? 'inference' : 'channel_reply', db, release);
  // Prepare cannot transition an unclassified legacy business; preserve revision 0.
  if (capability.revision === 0 && release === 'prepare') return () => {};
  const { ref, head } = await readHead(tx, db, businessId);
  if (head.refs.some(saved => sameRef(saved, identity))) throw new HttpError(409, 'El envío requiere revisión.', 'BOOKING_DISPATCH_PENDING');
  if (head.refs.length === 64) throw new HttpError(503, 'Hay envíos pendientes de revisión.', 'BOOKING_DISPATCH_FULL');
  const next = bookingDispatchHeadSchema.parse({ ...head, revision: head.revision + 1, refs: [...head.refs, { ...identity, policyRevision: capability.revision, startedAt: Date.now() }] });
  return () => { tx.set(ref, next); };
}

/** Only a completed transport or explicit provider rejection resolves a reference. */
export async function finishBookingDispatch(tx: Transaction, db: Database, businessId: string, identity: Pick<BookingDispatchRef, 'kind' | 'id'>, resolution: 'transport_resolved'): Promise<void> {
  if (resolution !== 'transport_resolved') throw unavailable();
  const { ref, head } = await readHead(tx, db, businessId);
  if (!head.refs.some(saved => sameRef(saved, identity))) return;
  tx.set(ref, bookingDispatchHeadSchema.parse({ ...head, revision: head.revision + 1, refs: head.refs.filter(saved => !sameRef(saved, identity)) }));
}

export async function withBookingDispatch<T>(input: { businessId: string; operation: BookingAdmissionOperation; identity: Pick<BookingDispatchRef, 'kind' | 'id'>; db?: Database; release?: BookingAdmissionRelease }, dispatch: (startTransport: () => void, resolveTransport: () => void) => Promise<T>): Promise<T> {
  const db = input.db ?? getAdminDb(), gate = gateFor(input.businessId);
  const previous = gate.tail;
  let unlock!: () => void; gate.tail = new Promise<void>(resolve => { unlock = resolve; });
  let startTransport = () => {};
  try {
    await previous;
    if (gate.closing.size) throw transitioning();
    let releaseStart!: () => void;
    const starting = new Promise<void>(resolve => { releaseStart = resolve; }); gate.starting = starting;
    startTransport = () => { if (gate.starting === starting) gate.starting = null; releaseStart(); };
    await db.runTransaction(tx => assertBookingAdmission(tx, { id: input.businessId }, input.operation, db, input.release));
    let resolved = false;
    try { return await dispatch(startTransport, () => { resolved = true; }); }
    finally {
      // A normal callback return alone proves nothing (e.g. an outbox not claimed).
      if (resolved) await db.runTransaction(tx => finishBookingDispatch(tx, db, input.businessId, input.identity, 'transport_resolved'));
    }
  } finally { startTransport(); unlock(); releaseGate(input.businessId, gate); }
}

const commandSchema = z.object({ businessId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), requestId: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/), expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1), action: bookingPolicyOperationSchema.shape.action, textVersion: z.string().min(1).max(128).optional(), target: bookingPolicyV2Schema.shape.transition.unwrap().shape.target }).strict();
export type BookingPolicyTransitionCommand = z.infer<typeof commandSchema>;

function assertActor(actor: ChatActor, ownerUid: unknown, command?: BookingPolicyTransitionCommand) {
  if (!actor.uid || !isSuperadmin(actor.uid) && actor.uid !== ownerUid) throw new HttpError(403, 'Esta operación requiere al dueño vigente o superadministración.');
  if (command && ['declare', 'withdraw'].includes(command.action) && actor.uid !== ownerUid) throw new HttpError(403, 'Esta operación requiere al dueño vigente.');
  if (command && !isSuperadmin(actor.uid) && !['declare', 'withdraw'].includes(command.action)) throw new HttpError(403, 'Esta operación requiere superadministración.');
}

export async function beginBookingPolicyTransition(actor: ChatActor, supplied: BookingPolicyTransitionCommand, db: Database = getAdminDb(), release: BookingAdmissionRelease = BOOKING_ADMISSION_RELEASE, requestHash?: string) {
  const command = commandSchema.parse(supplied);
  if (release !== 'enforce') throw unavailable();
  const gate = gateFor(command.businessId), token = {}; gate.closing.add(token);
  // Public commands bind replay to accepted input, independent of later policy targets.
  const operationHash = requestHash === undefined ? createHash('sha256').update(JSON.stringify(commandSchema.parse(command))).digest('hex') : z.string().regex(/^[a-f0-9]{64}$/).parse(requestHash);
  try {
    // Exclude the durable-marker→fetch gap, then persist without waiting for response.
    await gate.starting;
    await db.runTransaction(async tx => {
      const business = await tx.get(db.collection('businesses').doc(command.businessId));
      if (!business.exists) throw new HttpError(404, 'El negocio no existe.');
      assertActor(actor, business.data()?.ownerUid, command);
      const current = await readBookingDataPolicy(command.businessId, db, tx, release);
      const receiptRef = db.collection('serverSettings').doc(bookingPolicyOperationKey(command.businessId, actor.uid, command.requestId));
      const saved = await tx.get(receiptRef);
      if (saved.exists) {
        const receipt = bookingPolicyOperationSchema.safeParse(saved.data());
        if (!receipt.success || receipt.data.businessId !== command.businessId || receipt.data.actorUid !== actor.uid || receipt.data.requestId !== command.requestId || receipt.data.operationHash !== operationHash) throw conflict();
        return;
      }
      if (current.capability.revision !== command.expectedRevision) throw conflict();
      if (current.capability.admission === 'transitioning' && !(isSuperadmin(actor.uid) && command.action === 'suspend' && command.target.status === 'suspended' && command.target.origin === 'admin')) throw transitioning();
      const suspended = current.policy?.version === 2 && (current.policy.status === 'suspended' || current.policy.transition?.target.status === 'suspended');
      if (command.action === 'classify' && suspended) throw new HttpError(409, 'Levanta la suspensión con una reanudación administrativa.', 'BOOKING_ADMIN_REVIEW_REQUIRED');
      if (command.action === 'resume' && !suspended) throw conflict();
      if (command.action === 'declare' || command.action === 'withdraw') {
        if (current.policy && (current.policy.version !== 2 || current.policy.origin !== 'owner' || current.policy.dataMode !== 'general' || current.policy.representedMinorsEnabled || current.policy.status === 'suspended')) throw new HttpError(403, 'La clasificación requiere revisión administrativa.');
        if (command.target.origin !== 'owner' || command.target.dataMode !== 'general' || command.target.representedMinorsEnabled || command.target.declaration?.ownerUid !== actor.uid || command.target.status !== (command.action === 'withdraw' ? 'withdrawn' : 'active')) throw new HttpError(403, 'Declaración no permitida.');
        if (command.action === 'withdraw' && (!current.policy || current.policy.version !== 2 || JSON.stringify(command.target.declaration) !== JSON.stringify(current.policy.declaration))) throw conflict();
      }
      if (command.target.status === 'active' && (command.target.dataMode === 'health' || command.target.representedMinorsEnabled) && (!Array.isArray(business.data()?.sarinConfig?.intakeFields) || business.data()!.sarinConfig.intakeFields.length)) throw new HttpError(409, 'Retira los campos de texto libre.', 'BOOKING_FREE_INTAKE_NOT_ALLOWED');
      const { head } = await readHead(tx, db, command.businessId), now = Date.now();
      const revision = command.expectedRevision + 1;
      const policy = bookingPolicyV2Schema.parse({ version: 2, businessId: command.businessId, revision, ...command.target, status: 'transitioning', updatedBy: actor.uid, updatedAt: now, transition: { requestId: command.requestId, targetRevision: revision, target: command.target, startedAt: now, dispatchRefs: head.refs } });
      const receipt = bookingPolicyOperationSchema.parse({ version: 1, businessId: command.businessId, actorUid: actor.uid, requestId: command.requestId, action: command.action, operationHash, occurredAt: now, previousRevision: command.expectedRevision, targetRevision: revision, phase: 'transitioning', ...(command.textVersion ? { textVersion: command.textVersion } : {}) });
      tx.set(db.collection('serverSettings').doc(bookingDataPolicyKey(command.businessId)), policy);
      tx.create(receiptRef, receipt);
    });
    gate.closing.delete(token);
    return await resumeBookingPolicyTransition(actor, command.businessId, command.requestId, db, release);
  } finally {
    // Every later dispatch re-reads durable policy, including after a lost commit ACK.
    gate.closing.delete(token); releaseGate(command.businessId, gate);
  }
}

export async function resumeBookingPolicyTransition(actor: ChatActor, businessId: string, requestId: string, db: Database = getAdminDb(), release: BookingAdmissionRelease = BOOKING_ADMISSION_RELEASE) {
  if (release !== 'enforce') throw unavailable();
  return db.runTransaction(async tx => {
    const business = await tx.get(db.collection('businesses').doc(businessId));
    if (!business.exists) throw new HttpError(404, 'El negocio no existe.');
    assertActor(actor, business.data()?.ownerUid);
    const current = await readBookingDataPolicy(businessId, db, tx, release);
    const receiptRef = db.collection('serverSettings').doc(bookingPolicyOperationKey(businessId, actor.uid, requestId)), saved = await tx.get(receiptRef);
    const receipt = bookingPolicyOperationSchema.safeParse(saved.data());
    if (!receipt.success || receipt.data.businessId !== businessId || receipt.data.actorUid !== actor.uid || receipt.data.requestId !== requestId) throw conflict();
    if (['declare', 'withdraw'].includes(receipt.data.action) && actor.uid !== business.data()?.ownerUid) throw new HttpError(403, 'Esta operación requiere al dueño vigente.');
    const policy = current.policy;
    if (receipt.data.phase === 'applied') return { outcome: 'applied' as const, capability: current.capability, operation: receipt.data };
    if (!policy || policy.version !== 2 || policy.status !== 'transitioning' || policy.revision !== receipt.data.targetRevision || policy.transition?.requestId !== requestId || policy.updatedBy !== actor.uid) throw conflict();
    const { head, exists } = await readHead(tx, db, businessId);
    if (policy.transition.dispatchRefs.length && !exists) throw unavailable();
    // Never infer transport resolution from quota completion, outbox TTL or time.
    if (head.refs.length) return { outcome: 'pending' as const, capability: current.capability, operation: receipt.data };
    const { transition, ...base } = policy;
    tx.set(db.collection('serverSettings').doc(bookingDataPolicyKey(businessId)), bookingPolicyV2Schema.parse({ ...base, ...transition.target, businessId }));
    const operation = bookingPolicyOperationSchema.parse({ ...receipt.data, phase: 'applied' }); tx.set(receiptRef, operation);
    return { outcome: 'applied' as const, capability: normalizeBookingAdmission({ ...base, ...transition.target, businessId }, business.data()?.ownerUid, release), operation };
  });
}
