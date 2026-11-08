import 'server-only';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ChatActor } from '@/types/chat';
import type { Database, Transaction } from '@/lib/storage/types';
import type { Business } from '@/types/firestore';
import { getAdminDb } from '@/lib/firebase/admin';
import { BOOKING_ADMISSION_RELEASE, type BookingAdmissionRelease } from '@/lib/booking-admission-release';
import { BOOKING_DECLARATION_TEXT_VERSION } from '@/lib/booking-declaration';
import { bookingPolicyOperationSchema, type BookingPolicyOperation } from '@/lib/booking-admission';
import { bookingPolicyOperationKey } from './booking-admission';
import { bookingDataPolicyInputSchema, readBookingDataPolicy } from './booking-data-policy';
import { beginBookingPolicyTransition, resumeBookingPolicyTransition, type BookingPolicyTransitionCommand } from './booking-policy-transition';
import { assertOwner } from './businesses';
import { isSuperadmin } from './auth';
import { documentIdSchema } from './schemas';
import { HttpError } from './http';

const identity = { requestId: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/), expectedRevision: bookingDataPolicyInputSchema.shape.expectedRevision };
export const ownerBookingDeclarationInputSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('declare'), ...identity, textVersion: z.literal(BOOKING_DECLARATION_TEXT_VERSION) }).strict(),
  z.object({ action: z.literal('withdraw'), ...identity }).strict(),
]);
export const adminBookingPolicyInputSchema = bookingDataPolicyInputSchema.extend({ ...identity, action: z.enum(['classify', 'suspend', 'resume']) }).strict();
const conflict = () => new HttpError(409, 'La clasificación cambió. Actualiza antes de guardar.', 'BOOKING_POLICY_CONFLICT');
const unavailable = () => new HttpError(503, 'La declaración aún no está disponible.', 'BOOKING_POLICY_UNAVAILABLE');
type CurrentPolicy = Awaited<ReturnType<typeof readBookingDataPolicy>>;
type CommandIdentity = { requestId: string; hash: string };
type Scope = 'owner' | 'admin';

async function readContext(actor: ChatActor, businessId: string, db: Database, tx: Transaction, release: BookingAdmissionRelease, scope: Scope, identity?: CommandIdentity) {
  const business = await tx.get(db.collection('businesses').doc(businessId));
  if (!business.exists) throw new HttpError(404, 'El negocio no existe.');
  if (scope === 'owner') {
    if (!actor.uid) throw new HttpError(403, 'Esta operación requiere al dueño vigente.');
    assertOwner(business.data() as Business, actor.uid);
  } else if (!isSuperadmin(actor.uid)) throw new HttpError(403, 'Forbidden');
  const current = await readBookingDataPolicy(businessId, db, tx, release);
  let operation: BookingPolicyOperation | null = null;
  if (identity) {
    const saved = await tx.get(db.collection('serverSettings').doc(bookingPolicyOperationKey(businessId, actor.uid, identity.requestId)));
    if (saved.exists) {
      const parsed = bookingPolicyOperationSchema.safeParse(saved.data());
      if (!parsed.success || parsed.data.businessId !== businessId || parsed.data.actorUid !== actor.uid || parsed.data.requestId !== identity.requestId || parsed.data.operationHash !== identity.hash) throw conflict();
      operation = parsed.data;
    }
  }
  return { current, operation };
}

function ownerView(current: CurrentPolicy, actorUid: string, operation?: BookingPolicyOperation | null) {
  const policy = current.policy;
  const declaration = policy?.version === 2 && policy.declaration?.ownerUid === actorUid ? { textVersion: policy.declaration.textVersion, receiptId: policy.declaration.receiptId } : null;
  return {
    capability: current.capability, origin: policy ? policy.version === 1 ? 'admin' as const : policy.origin : null, declaration,
    ...(operation ? { operation: { requestId: operation.requestId, action: operation.action, phase: operation.phase, previousRevision: operation.previousRevision, targetRevision: operation.targetRevision, occurredAt: operation.occurredAt, ...(operation.textVersion ? { textVersion: operation.textVersion } : {}) } } : {}),
  };
}

async function execute(actor: ChatActor, businessId: string, db: Database, release: BookingAdmissionRelease, scope: Scope, identity: CommandIdentity, target: (current: CurrentPolicy) => BookingPolicyTransitionCommand) {
  if (release !== 'enforce') throw unavailable();
  const initial = await db.runTransaction(tx => readContext(actor, businessId, db, tx, release, scope, identity));
  try {
    if (initial.operation) await resumeBookingPolicyTransition(actor, businessId, identity.requestId, db, release);
    else await beginBookingPolicyTransition(actor, target(initial.current), db, release, identity.hash);
  } catch (error) {
    // A lost commit ACK is resolved by the durable identity, never by a fresh write.
    const recovered = await db.runTransaction(tx => readContext(actor, businessId, db, tx, release, scope, identity));
    if (!recovered.operation) throw error;
    await resumeBookingPolicyTransition(actor, businessId, identity.requestId, db, release);
  }
  return db.runTransaction(async tx => {
    const { current, operation } = await readContext(actor, businessId, db, tx, release, scope, identity);
    if (!operation) throw unavailable();
    return { outcome: operation.phase === 'applied' ? 'applied' as const : 'pending' as const, ...ownerView(current, actor.uid, operation), ...(scope === 'admin' ? { policy: current.policy } : {}) };
  });
}

export async function executeOwnerBookingDeclaration(actor: ChatActor, businessId: string, supplied: z.input<typeof ownerBookingDeclarationInputSchema>, db: Database = getAdminDb(), release: BookingAdmissionRelease = BOOKING_ADMISSION_RELEASE) {
  documentIdSchema.parse(businessId);
  const input = ownerBookingDeclarationInputSchema.parse(supplied);
  const hash = createHash('sha256').update(JSON.stringify({ businessId, ...input })).digest('hex');
  return execute(actor, businessId, db, release, 'owner', { requestId: input.requestId, hash }, current => {
    const declaration = input.action === 'declare'
      ? { ownerUid: actor.uid, textVersion: input.textVersion, receiptId: createHash('sha256').update(JSON.stringify([businessId, actor.uid, input.requestId])).digest('hex') }
      : current.policy?.version === 2 ? current.policy.declaration : null;
    if (!declaration || input.action === 'withdraw' && declaration.ownerUid !== actor.uid) throw conflict();
    return { businessId, ...input, target: { status: input.action === 'declare' ? 'active' : 'withdrawn', dataMode: 'general', representedMinorsEnabled: false, origin: 'owner', reason: '', declaration } };
  });
}

export async function executeAdminBookingPolicy(actor: ChatActor, supplied: z.input<typeof adminBookingPolicyInputSchema>, db: Database = getAdminDb(), release: BookingAdmissionRelease = BOOKING_ADMISSION_RELEASE) {
  if (!isSuperadmin(actor.uid)) throw new HttpError(403, 'Forbidden');
  const input = adminBookingPolicyInputSchema.parse(supplied);
  const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
  return execute(actor, input.businessId, db, release, 'admin', { requestId: input.requestId, hash }, current => ({
    businessId: input.businessId, requestId: input.requestId, expectedRevision: input.expectedRevision, action: input.action,
    target: { status: input.action === 'suspend' ? 'suspended' : 'active', origin: 'admin', dataMode: input.dataMode, representedMinorsEnabled: input.representedMinorsEnabled, reason: input.reason, declaration: current.policy?.version === 2 ? current.policy.declaration : null },
  }));
}

export async function readOwnerBookingDeclaration(actor: ChatActor, businessId: string, db: Database = getAdminDb(), release: BookingAdmissionRelease = BOOKING_ADMISSION_RELEASE) {
  documentIdSchema.parse(businessId);
  if (release !== 'enforce') throw unavailable();
  return db.runTransaction(async tx => {
    const { current } = await readContext(actor, businessId, db, tx, release, 'owner');
    const policy = current.policy;
    if (policy?.version !== 2 || !policy.transition || policy.updatedBy !== actor.uid) return ownerView(current, actor.uid);
    const saved = await tx.get(db.collection('serverSettings').doc(bookingPolicyOperationKey(businessId, actor.uid, policy.transition.requestId)));
    const operation = bookingPolicyOperationSchema.safeParse(saved.data());
    if (!operation.success || operation.data.businessId !== businessId || operation.data.actorUid !== actor.uid || operation.data.requestId !== policy.transition.requestId || operation.data.targetRevision !== policy.revision) throw unavailable();
    return ownerView(current, actor.uid, operation.data);
  });
}
