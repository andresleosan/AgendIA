import 'server-only';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ChatMode, ChatSelection, ChatState } from '@/types/chat';
import type { Database } from '@/lib/storage/types';
import { getAdminDb } from '@/lib/firebase/admin';
import { dateKeySchema, documentIdSchema, timeSchema } from './schemas';
import { HttpError } from './http';
import type { QuotaEffectHooks } from './response-quota-store';
export type ChatScope = { actorUid: string; businessId: string; mode: ChatMode; channel: 'web' | 'whatsapp' };
export const chatSelectionSchema = z.object({ serviceId: documentIdSchema.optional(), resourceId: documentIdSchema.optional(), dateKey: dateKeySchema.optional(), startTimeStr: timeSchema.optional(), proposalId: documentIdSchema.optional() }).strict();
const schema = z.object({ version: z.number().int().nonnegative().safe(), selection: chatSelectionSchema, updatedAt: z.number().int().nonnegative().safe(), expiresAt: z.number().int().nonnegative().safe() }).strict();
const reference = (scope: ChatScope, db: Database) => db.collection('chatStates').doc(createHash('sha256').update(JSON.stringify([scope.actorUid, scope.businessId, scope.mode, scope.channel])).digest('hex'));
function parse(value: unknown): ChatState {
  const result = schema.safeParse(value);
  if (!result.success) throw new HttpError(503, 'No se pudo validar la selección de esta conversación.');
  return result.data;
}
const empty = (version: number, now: number): ChatState => ({ version, selection: {}, updatedAt: now, expiresAt: now + 86400000 });
export async function readChatState(scope: ChatScope, db: Database = getAdminDb(), now = Date.now()): Promise<ChatState> {
  const ref = reference(scope, db);
  return db.runTransaction(async tx => {
    const document = await tx.get(ref);
    if (!document.exists) return empty(0, now);
    const previous = parse(document.data());
    if (previous.expiresAt > now) return previous;
    const current = empty(previous.version + 1, now); tx.set(ref, current); return current;
  });
}
export async function saveChatState(scope: ChatScope, expectedVersion: number, selection: ChatSelection, db: Database = getAdminDb(), now = Date.now(), quota?: QuotaEffectHooks): Promise<ChatState> {
  const parsed = chatSelectionSchema.parse(selection), ref = reference(scope, db);
  return db.runTransaction(async tx => {
    const document = await tx.get(ref), previous = document.exists ? parse(document.data()) : empty(0, now);
    const version = previous.expiresAt <= now ? previous.version + 1 : previous.version;
    if (version !== expectedVersion) throw new HttpError(409, 'La selección cambió. Reintenta para usar los datos actuales.', 'CHAT_STATE_CONFLICT');
    const apply = await quota?.prepare(tx, { kind: 'chat_state', id: ref.id });
    const state = { ...empty(version + 1, now), selection: parsed }; tx.set(ref, state); apply?.(); return state;
  });
}
