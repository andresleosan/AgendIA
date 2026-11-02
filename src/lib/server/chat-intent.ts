import 'server-only';
import { z } from 'zod';
import type { ChatMode, ChatState } from '@/types/chat';
import type { Business } from '@/types/firestore';
import { completeChat, type ToolDefinition, type EngineDispatchContext } from '@/lib/sarin/engine';
import { buildBusinessIntentPrompt } from '@/lib/sarin/prompts';
import { getAiProviderSelection } from './provider-settings';
import { recordAiUsage } from './ai-usage';
import { businessConfigSchema } from './schemas';
import { chatSelectionSchema } from './chat-state';
import { HttpError } from './http';
export const chatIntentSchema = z.enum(['services', 'service_details', 'price', 'location', 'contact', 'hours', 'availability', 'booking', 'own_appointments', 'configure_business', 'owner_agenda', 'owner_usage', 'owner_block', 'out_of_scope', 'clarify']);
export type ChatIntent = z.infer<typeof chatIntentSchema>;
const interpretedSchema = z.object({ intent: chatIntentSchema, selection: chatSelectionSchema, configurationDraft: businessConfigSchema.optional() }).strict();
export type InterpretedChat = z.infer<typeof interpretedSchema>;
export const INTERPRETATION_TOOLS: readonly ToolDefinition[] = [{ type: 'function', function: { name: 'interpretar_solicitud', description: 'Clasifica la solicitud y extrae exclusivamente identificadores y fechas. No ejecuta operaciones ni confirma reservas.', parameters: z.toJSONSchema(interpretedSchema) } }];
export async function interpretChat(input: { mode: ChatMode; message: string; business: Business; state: ChatState; signal?: AbortSignal; requestId: string; actorUid: string; beforeInference?: () => Promise<void>; beforeDispatch?: (context: EngineDispatchContext) => Promise<void> }): Promise<InterpretedChat> {
  const { provider } = await getAiProviderSelection();
  await input.beforeInference?.();
  const assistant = await completeChat([{ role: 'system', content: buildBusinessIntentPrompt(input.business, input.mode, input.state.selection) }, { role: 'user', content: input.message }], INTERPRETATION_TOOLS, { signal: input.signal, provider, beforeDispatch: async context => { await input.beforeInference?.(); await input.beforeDispatch?.(context); }, billingContext: { businessId: input.business.id, actorUid: input.actorUid, mode: input.mode, requestId: input.requestId },
    ...(provider !== 'ollama' ? { onUsage: observation => recordAiUsage(observation, { businessId: input.business.id, mode: input.mode }) } : {}),
  });
  const clarify = (): InterpretedChat => ({ intent: 'clarify', selection: input.state.selection });
  if (assistant.tool_calls?.length !== 1 || assistant.tool_calls[0].function.name !== 'interpretar_solicitud') return clarify();
  let value: unknown;
  try { value = JSON.parse(assistant.tool_calls[0].function.arguments); } catch { return clarify(); }
  const parsed = interpretedSchema.safeParse(value);
  if (!parsed.success) return clarify();
  const result = parsed.data;
  const ownerOnly = ['configure_business', 'owner_agenda', 'owner_usage', 'owner_block'];
  if ((input.mode === 'sarin_client' && ownerOnly.includes(result.intent)) || (result.configurationDraft && input.mode !== 'sarin_onboarding')) throw new HttpError(403, 'Esta consulta requiere el modo autorizado del dueño.');
  if (result.intent === 'configure_business' && input.mode !== 'sarin_onboarding') throw new HttpError(403, 'Abre la configuración del negocio para preparar cambios.');
  if (['owner_agenda', 'owner_usage', 'owner_block'].includes(result.intent) && input.mode !== 'sarin_owner_copilot') throw new HttpError(403, 'Esta consulta requiere el copiloto con una suscripción vigente.');
  if (result.intent === 'service_details' && !result.selection.serviceId) return clarify();
  const selection = { ...input.state.selection, ...result.selection };
  if (result.intent === 'service_details' && result.selection.resourceId === undefined) delete selection.resourceId;
  const service = input.business.services.find(item => item.id === selection.serviceId);
  const resource = input.business.resources.find(item => item.id === selection.resourceId && item.active);
  if ((selection.serviceId && !service) || (selection.resourceId && (!resource || (service && !service.resourceIds.includes(resource.id))))) return { intent: 'clarify', selection: {} };
  // A model never supplies a server proposal identifier.
  delete selection.proposalId;
  if (result.intent === 'service_details') return { intent: 'service_details', selection };
  return { ...result, selection };
}
