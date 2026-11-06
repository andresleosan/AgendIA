import 'server-only';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { HttpError } from '@/lib/server/http';
import type { AiProvider, CloudAiProvider } from '@/types/ai';
import { reservePaidCallBudget, releaseUndispatchedPaidCallBudget, settlePaidCallBudget, type PaidCallContext, type BudgetReservation } from '@/lib/server/ai-budget';
import { consumePlatformGenerationCapability } from '@/lib/server/platform-support-bot';
import { quotePaidCall } from '@/lib/server/ai-pricing';

export type ContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };
export interface ToolCall { id: string; type: 'function'; function: { name: string; arguments: string }; }
export interface ToolDefinition { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> }; }
export interface EngineMessage { role: 'system' | 'user' | 'assistant' | 'tool'; content: string | null | ContentPart[]; tool_calls?: ToolCall[]; tool_call_id?: string; }
export interface EngineAssistantMessage { role: 'assistant'; content: string | null; tool_calls?: ToolCall[]; }
export type EngineProvider = AiProvider;
export type EngineDispatchContext = { provider: EngineProvider; providerCallId: string | null };
export interface EngineHealth { provider: EngineProvider | null; online: boolean; checkedAt: number; visionAvailable: boolean; error?: string; }
export interface EngineTokenUsage { promptTokens: number; cacheHitTokens: number; cacheMissTokens: number; completionTokens: number; totalTokens: number; thinkingTokens?: number; }
export interface EngineUsageObservation { callId: string; provider: CloudAiProvider; model: string | null; serviceTier?: 'standard' | 'flex' | 'priority' | null; startedAt: number; finishedAt: number; success: boolean; usage: EngineTokenUsage | null; }

function validateProvider(provider: string): EngineProvider {
  if (provider !== 'ollama' && provider !== 'deepseek' && provider !== 'gemini') throw new HttpError(503, 'El proveedor de conversaciones no es válido.');
  return provider;
}

export function getChatProvider(): EngineProvider {
  return validateProvider(process.env.SARIN_CHAT_PROVIDER ?? 'ollama');
}

function engineConfig(vision = false, selectedProvider = getChatProvider()) {
  const provider = validateProvider(selectedProvider);
  const timeoutMs = Number(process.env.LLM_REQUEST_TIMEOUT_MS ?? 120_000);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300_000) throw new HttpError(503, 'Tiempo de espera del motor no válido.');
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (provider === 'gemini') {
    if (vision) throw new HttpError(503, 'Las imágenes requieren el motor local de la Mac.');
    const key = process.env.GEMINI_API_KEY;
    if (!key || !/^[\x21-\x7e]+$/.test(key)) throw new HttpError(503, 'Configura una credencial válida de Gemini en el servidor.');
    if (process.env.GEMINI_BILLING_VERIFIED !== 'true') throw new HttpError(503, 'Gemini requiere facturación de pago verificada en el servidor.');
    const model = process.env.GEMINI_MODEL ?? 'gemini-3.5-flash-lite';
    if (model !== 'gemini-3.5-flash-lite') throw new HttpError(503, 'El modelo configurado de Gemini no está habilitado.');
    headers['x-goog-api-key'] = key;
    return { provider, url: new URL(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`), headers, model, timeoutMs };
  }
  if (provider === 'deepseek') {
    if (vision) throw new HttpError(503, 'Las imágenes requieren el motor local de la Mac.');
    const key = process.env.DEEPSEEK_API_KEY;
    if (!key || /\s|[\x00-\x1f\x7f]/.test(key)) throw new HttpError(503, 'Configura una credencial válida de DeepSeek en el servidor.');
    const model = process.env.DEEPSEEK_MODEL ?? 'deepseek-flash';
    if (model !== 'deepseek-flash') throw new HttpError(503, 'El modelo configurado de DeepSeek no está habilitado.');
    // The cloud destination and its credential are independent of the private tunnel.
    headers.Authorization = `Bearer ${key}`;
    return { provider, url: new URL('https://api.deepseek.com/chat/completions'), headers, model, timeoutMs };
  }
  let url: URL;
  try { url = new URL(process.env.SARIN_TUNNEL_URL ?? ''); } catch { throw new HttpError(503, 'El motor local no está configurado.'); }
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if ((!local && url.protocol !== 'https:') || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !url.pathname.endsWith('/v1/chat/completions')) {
    throw new HttpError(503, 'La dirección del motor local no es válida.');
  }
  const hostname = url.hostname.replace(/\.$/, '');
  if (['ollama.com', 'api.openai.com', 'api.deepseek.com', 'generativelanguage.googleapis.com'].some((host) => hostname === host || hostname.endsWith(`.${host}`))) throw new HttpError(503, 'Se requiere un motor local privado.');
  const clientId = process.env.CF_ACCESS_CLIENT_ID;
  const secret = process.env.CF_ACCESS_CLIENT_SECRET;
  if (!local && (!clientId || !secret)) throw new HttpError(503, 'Configura el service token de Cloudflare Access.');
  if (clientId && secret) { headers['CF-Access-Client-Id'] = clientId; headers['CF-Access-Client-Secret'] = secret; }
  const model = vision ? process.env.OLLAMA_VISION_MODEL : process.env.OLLAMA_MAIN_MODEL;
  if (!model || /(?:[:\-])cloud(?:$|[:\-])/i.test(model)) throw new HttpError(503, vision ? 'Configura un modelo de visión local.' : 'Configura el modelo principal local.');
  return { provider, url, headers, model, timeoutMs };
}

function unavailableMessage(provider: EngineProvider, status?: number): string {
  if (provider === 'ollama') return 'El motor local no está disponible. Comprueba Ollama y el túnel.';
  const name = provider === 'gemini' ? 'Gemini' : 'DeepSeek';
  if (status === 401 || status === 403) return `${name} rechazó la credencial del servidor. Revisa su configuración.`;
  if (status === 402) return `${name} no tiene saldo disponible. Revisa la cuenta del proveedor.`;
  if (status === 429) return `${name} alcanzó su límite de solicitudes o cuota. Inténtalo de nuevo en un momento.`;
  return `SarinBot no puede conectar con ${name}. Inténtalo de nuevo en un momento.`;
}

async function responseJson(response: Response, onResolved?: () => void): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) { onResolved?.(); throw new HttpError(502, 'El motor devolvió una respuesta vacía.'); }
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > 2 * 1024 * 1024) { await reader.cancel(); throw new HttpError(502, 'Respuesta del motor demasiado grande.'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  onResolved?.();
  const all = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(all)); } catch { throw new HttpError(502, 'Respuesta no válida del motor.'); }
}

const assistantSchema = z.object({ choices: z.array(z.object({ message: z.object({
  content: z.string().max(512_000).nullable().optional(),
  tool_calls: z.array(z.object({ id: z.string().min(1).max(200), type: z.literal('function'), function: z.object({ name: z.string().min(1).max(100), arguments: z.string().max(64_000) }) })).max(8).optional(),
}) })).min(1).max(4) });

const tokenCount = z.number().int().min(0).max(2_000_000);
const usageSchema = z.object({ prompt_tokens: tokenCount, prompt_cache_hit_tokens: tokenCount, prompt_cache_miss_tokens: tokenCount, completion_tokens: tokenCount, total_tokens: z.number().int().min(0).max(4_000_000) })
  .refine(value => value.prompt_tokens === value.prompt_cache_hit_tokens + value.prompt_cache_miss_tokens && value.total_tokens === value.prompt_tokens + value.completion_tokens);

const geminiPartSchema = z.object({
  text: z.string().max(512_000).optional(), thought: z.boolean().optional(), thoughtSignature: z.string().min(1).max(128_000).optional(),
  functionCall: z.object({ id: z.string().min(1).max(200), name: z.string().min(1).max(100), args: z.record(z.string(), z.unknown()).default({}).refine(value => JSON.stringify(value).length <= 64_000) }).optional(),
}).refine(part => (part.text !== undefined) !== (part.functionCall !== undefined));
const geminiAssistantSchema = z.object({ candidates: z.array(z.object({
  content: z.object({ role: z.literal('model'), parts: z.array(geminiPartSchema).min(1).max(32) }),
  finishReason: z.literal('STOP'),
})).length(1) });
type GeminiPart = z.infer<typeof geminiPartSchema>;
// Native signatures and private thought parts live only for this in-memory tool loop.
// They never become enumerable assistant fields, client JSON or persisted accounting.
const geminiHistory = new WeakMap<EngineAssistantMessage, GeminiPart[]>();
const geminiUsageSchema = z.object({
  promptTokenCount: tokenCount, cachedContentTokenCount: tokenCount.default(0), toolUsePromptTokenCount: tokenCount.default(0),
  candidatesTokenCount: tokenCount.default(0), thoughtsTokenCount: tokenCount.default(0), totalTokenCount: z.number().int().min(0).max(4_000_000),
}).refine(value => value.cachedContentTokenCount <= value.promptTokenCount
  && value.promptTokenCount + value.toolUsePromptTokenCount <= 2_000_000 && value.candidatesTokenCount + value.thoughtsTokenCount <= 2_000_000
  && value.totalTokenCount === value.promptTokenCount + value.toolUsePromptTokenCount + value.candidatesTokenCount + value.thoughtsTokenCount);

function invalidGeminiHistory(): never { throw new HttpError(502, 'El historial de herramientas de Gemini no es válido.'); }

function geminiRequest(messages: EngineMessage[], tools?: readonly ToolDefinition[]) {
  const contents: { role: 'user' | 'model'; parts: unknown[] }[] = [];
  const systemParts: { text: string }[] = [];
  let pending = new Map<string, string>();
  let responses: unknown[] = [];
  for (const message of messages) {
    if (message.role === 'tool') {
      const id = message.tool_call_id;
      const name = id ? pending.get(id) : undefined;
      if (!id || !name || typeof message.content !== 'string') invalidGeminiHistory();
      let result: unknown;
      try { result = JSON.parse(message.content); } catch { invalidGeminiHistory(); }
      if (!result || typeof result !== 'object' || Array.isArray(result)) invalidGeminiHistory();
      responses.push({ functionResponse: { id, name, response: result } });
      pending.delete(id);
      if (!pending.size) { contents.push({ role: 'user', parts: responses }); responses = []; }
      continue;
    }
    if (pending.size) invalidGeminiHistory();
    const textParts = typeof message.content === 'string' ? [{ text: message.content }] : Array.isArray(message.content)
      ? message.content.filter((part): part is Extract<ContentPart, { type: 'text' }> => part.type === 'text').map(part => ({ text: part.text })) : [];
    if (message.role === 'system') { systemParts.push(...textParts); continue; }
    if (message.role === 'assistant') {
      const native = geminiHistory.get(message as EngineAssistantMessage);
      if (message.tool_calls?.length && !native) invalidGeminiHistory();
      if (native) {
        pending = new Map(native.flatMap(part => part.functionCall ? [[part.functionCall.id, part.functionCall.name]] : []));
        contents.push({ role: 'model', parts: native });
      } else if (textParts.length) contents.push({ role: 'model', parts: textParts });
    } else contents.push({ role: 'user', parts: textParts });
  }
  if (pending.size) invalidGeminiHistory();
  return {
    ...(systemParts.length ? { systemInstruction: { parts: systemParts } } : {}), contents,
    serviceTier: 'standard', generationConfig: { maxOutputTokens: 4096, thinkingConfig: { thinkingLevel: 'MINIMAL' } },
    ...(tools?.length ? { tools: [{ functionDeclarations: tools.map(tool => ({ name: tool.function.name, description: tool.function.description, parametersJsonSchema: tool.function.parameters })) }], toolConfig: { functionCallingConfig: { mode: 'AUTO' } } } : {}),
  };
}

function geminiAssistant(data: unknown): EngineAssistantMessage {
  const parsed = geminiAssistantSchema.safeParse(data);
  if (!parsed.success) throw new HttpError(502, 'Respuesta no válida de Gemini.');
  const parts = parsed.data.candidates[0].content.parts;
  const calls = parts.filter(part => part.functionCall);
  if (calls.length > 8 || (calls.length && !calls[0].thoughtSignature) || new Set(calls.map(part => part.functionCall!.id)).size !== calls.length) {
    throw new HttpError(502, 'Respuesta de herramientas no válida de Gemini.');
  }
  const content = parts.filter(part => !part.thought && part.text !== undefined).map(part => part.text).join('');
  if (!content.trim() && !calls.length) throw new HttpError(502, 'El motor no produjo una respuesta.');
  const assistant: EngineAssistantMessage = { role: 'assistant', content: content || null,
    ...(calls.length ? { tool_calls: calls.map(part => ({ id: part.functionCall!.id, type: 'function' as const, function: { name: part.functionCall!.name, arguments: JSON.stringify(part.functionCall!.args) } })) } : {}),
  };
  geminiHistory.set(assistant, parts);
  return assistant;
}


function chatRequest(provider: EngineProvider, model: string, messages: EngineMessage[], tools?: readonly ToolDefinition[]) {
  return { model, messages, stream: false, max_tokens: 4096, temperature: 0.2,
    ...(provider === 'deepseek' ? { thinking: { type: 'disabled' } } : { think: false }),
    ...(tools?.length ? { tools, tool_choice: 'auto' } : {}) };
}
export function serializePlatformSupportRequest(system: string, question: string): string {
  return JSON.stringify(chatRequest('deepseek', 'deepseek-flash', [{ role: 'system', content: system }, { role: 'user', content: question }]));
}
async function chatTransport(config: ReturnType<typeof engineConfig>, body: string, signal: AbortSignal, onStart?: () => void, onResolved?: () => void) {
  signal.throwIfAborted();
  onStart?.();
  const response = await fetch(config.url.toString(), { method: 'POST', headers: config.headers, cache: 'no-store', redirect: 'error', signal, body });
  if (!response.ok) { await response.body?.cancel(); if (response.status >= 400 && response.status < 500) onResolved?.(); throw new HttpError(503, unavailableMessage(config.provider, response.status)); }
  return responseJson(response, onResolved);
}
function deepSeekUsage(raw: unknown): EngineTokenUsage | null {
  const usage = usageSchema.safeParse(raw);
  return usage.success ? { promptTokens: usage.data.prompt_tokens, cacheHitTokens: usage.data.prompt_cache_hit_tokens, cacheMissTokens: usage.data.prompt_cache_miss_tokens, completionTokens: usage.data.completion_tokens, totalTokens: usage.data.total_tokens } : null;
}
function chatAssistant(data: unknown): EngineAssistantMessage {
  const parsed = assistantSchema.safeParse(data);
  if (!parsed.success) throw new HttpError(502, 'Respuesta no válida del motor.');
  const message = parsed.data.choices[0].message;
  if (!message.content?.trim() && !message.tool_calls?.length) throw new HttpError(502, 'El motor no produjo una respuesta.');
  return { role: 'assistant', content: message.content ?? null, ...(message.tool_calls?.length ? { tool_calls: message.tool_calls } : {}) };
}
/** Internal runtime capability is consumed before fetch; structural objects grant nothing. */
export async function completePlatformSupport(capability: object, body: string, signal: AbortSignal, onUsage: (value: EngineUsageObservation) => void): Promise<EngineAssistantMessage> {
  const grant = consumePlatformGenerationCapability(capability, body, signal);
  const observation: EngineUsageObservation = { callId: grant.generationToken, provider: 'deepseek', model: null, startedAt: Date.now(), finishedAt: 0, success: false, usage: null };
  try {
    const config = engineConfig(false, 'deepseek');
    const data = await chatTransport(config, body, AbortSignal.any([signal, AbortSignal.timeout(config.timeoutMs)]));
    if (data && typeof data === 'object') {
      const metadata = data as Record<string, unknown>;
      observation.model = typeof metadata.model === 'string' && /^[A-Za-z0-9_.:-]{1,100}$/.test(metadata.model) ? metadata.model : null;
      observation.usage = deepSeekUsage(metadata.usage);
    }
    const assistant = chatAssistant(data); observation.success = true; return assistant;
  } finally { observation.finishedAt = Date.now(); onUsage(observation); }
}

export type EngineDispatch = <T>(context: EngineDispatchContext, send: (onStart?: () => void, onResolved?: () => void) => Promise<T>) => Promise<T>;
export async function completeChat(messages: EngineMessage[], tools?: readonly ToolDefinition[], options: { vision?: boolean; signal?: AbortSignal; provider?: EngineProvider; billingContext?: PaidCallContext; beforeDispatch?: (context: EngineDispatchContext) => Promise<void>; dispatch?: EngineDispatch; onUsage?: (observation: EngineUsageObservation) => void | Promise<void> } = {}): Promise<EngineAssistantMessage> {
  const config = engineConfig(options.vision, options.provider);
  if (config.provider !== 'ollama' && messages.some(message => Array.isArray(message.content) && message.content.some(part => part.type === 'image_url'))) {
    throw new HttpError(503, 'Las imágenes requieren el motor local de la Mac.');
  }
  // Only the supported function-call fields may leave the server.
  const requestMessages = messages.map(message => message.tool_calls ? {
    ...message, tool_calls: message.tool_calls.map(call => ({ id: call.id, type: call.type, function: call.function })),
  } : message);
  // Validate native history before allocating a billable-call observation or fetching.
  const body = config.provider === 'gemini' ? geminiRequest(messages, tools) : chatRequest(config.provider, config.model, requestMessages, tools);
  const gate = process.env.PILOT_AI_BUDGET_ENFORCED;
  if (gate !== undefined && !['true', 'false'].includes(gate)) throw new HttpError(503, 'El presupuesto de IA no está configurado.', 'AI_BUDGET_UNAVAILABLE');
  const budgetActive = config.provider !== 'ollama' && gate === 'true';
  const requestBody = JSON.stringify(body);
  const observation: EngineUsageObservation | undefined = config.provider !== 'ollama'
    ? { callId: randomUUID(), provider: config.provider, model: config.provider === 'gemini' ? null : config.model,
      ...(config.provider === 'gemini' ? { serviceTier: null } : {}), startedAt: Date.now(), finishedAt: 0, success: false, usage: null } : undefined;
  let reservation: BudgetReservation | undefined;
  if (budgetActive) {
    if (!options.billingContext) throw new HttpError(503, 'Falta el contexto del presupuesto de IA.', 'AI_BUDGET_UNAVAILABLE');
    if (options.signal?.aborted) throw new DOMException('Solicitud cancelada.', 'AbortError');
    const quote = quotePaidCall({ provider: config.provider as CloudAiProvider, model: config.model, requestBytes: Buffer.byteLength(requestBody, 'utf8'), maxOutputTokens: 4096 });
    reservation = await reservePaidCallBudget({ ...options.billingContext, ...quote, callId: observation!.callId, provider: config.provider as CloudAiProvider, model: config.model });
    observation!.model = null;
  }
  // No provider request has been dispatched here. A denied policy check can
  // release this reservation; failures after fetch must retain normal accounting.
  let transportStarted = false;
  const context = { provider: config.provider, providerCallId: observation?.callId ?? null };
  const send = async (onStart?: () => void, onResolved?: () => void) => {
    if (options.beforeDispatch) await options.beforeDispatch(context);
    if (options.signal?.aborted) { onResolved?.(); throw new DOMException('Solicitud cancelada.', 'AbortError'); }
    const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(config.timeoutMs)]) : AbortSignal.timeout(config.timeoutMs);
    transportStarted = true;
    return chatTransport(config, requestBody, signal, onStart, onResolved);
  };
  try {
    const data = await (options.dispatch ? options.dispatch(context, send) : send());
    if (observation && data && typeof data === 'object') {
      const metadata = data as Record<string, unknown>;
      if (config.provider === 'gemini') {
        observation.model = typeof metadata.modelVersion === 'string' && /^[A-Za-z0-9_.:-]{1,100}$/.test(metadata.modelVersion) ? metadata.modelVersion : null;
        const nativeUsage = metadata.usageMetadata;
        const tier = nativeUsage && typeof nativeUsage === 'object' ? (nativeUsage as Record<string, unknown>).serviceTier : undefined;
        observation.serviceTier = tier === 'standard' || tier === 'flex' || tier === 'priority' ? tier : null;
        const usage = geminiUsageSchema.safeParse(nativeUsage);
        if (usage.success) {
          const value = usage.data; const promptTokens = value.promptTokenCount + value.toolUsePromptTokenCount;
          observation.usage = { promptTokens, cacheHitTokens: value.cachedContentTokenCount, cacheMissTokens: promptTokens - value.cachedContentTokenCount,
            completionTokens: value.candidatesTokenCount + value.thoughtsTokenCount, thinkingTokens: value.thoughtsTokenCount, totalTokens: value.totalTokenCount };
        }
      } else {
        if ('model' in metadata) observation.model = typeof metadata.model === 'string' && /^[A-Za-z0-9_.:-]{1,100}$/.test(metadata.model) ? metadata.model : null;
        observation.usage = deepSeekUsage(metadata.usage);
      }
    }
    if (config.provider === 'gemini') {
      const assistant = geminiAssistant(data);
      if (observation) observation.success = true;
      return assistant;
    }
    const assistant = chatAssistant(data);
    if (observation) observation.success = true;
    return assistant;
  } catch (error) {
    if (!transportStarted) {
      if (reservation) { try { await releaseUndispatchedPaidCallBudget(reservation); } catch { /* retain maximum on storage outage */ } }
      throw error;
    }
    if (options.signal?.aborted) throw new DOMException('Solicitud cancelada.', 'AbortError');
    if (error instanceof HttpError) throw error;
    throw new HttpError(503, unavailableMessage(config.provider));
  } finally {
    if (observation && transportStarted) {
      observation.finishedAt = Date.now();
      // Accounting never changes a model result or retries a committed tool.
      if (reservation) { try { await settlePaidCallBudget(reservation, observation); } catch { /* maximum reservation stays held; never repeat fetch */ } }
      try { await options.onUsage?.(observation); } catch { /* The recorder reports its own safe write-failure counter. */ }
    }
  }
}

/** Safe configuration summary for the authenticated administrator; no endpoints or credentials. */
export function getEngineConfiguration(provider: EngineProvider): { configured: boolean; model: string | null; error?: string } {
  try { return { configured: true, model: engineConfig(false, provider).model }; }
  catch (error) { return { configured: false, model: null, error: error instanceof HttpError ? error.message : 'La configuración del proveedor no es válida.' }; }
}

export async function probeEngine(selectedProvider?: EngineProvider): Promise<EngineHealth> {
  let provider: EngineProvider | null = null;
  try {
    provider = selectedProvider === undefined ? getChatProvider() : validateProvider(selectedProvider);
    const config = engineConfig(false, provider);
    const modelsUrl = new URL(config.url); modelsUrl.pathname = config.provider === 'gemini' ? modelsUrl.pathname.replace(/:generateContent$/, '') : modelsUrl.pathname.replace(/chat\/completions$/, 'models');
    const response = await fetch(modelsUrl.toString(), { headers: config.headers, method: 'GET', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(5000) });
    if (!response.ok) { await response.body?.cancel(); throw new HttpError(503, unavailableMessage(provider, response.status)); }
    const raw = await responseJson(response);
    if (provider === 'gemini') {
      const model = z.object({ name: z.string(), supportedGenerationMethods: z.array(z.string()) }).safeParse(raw);
      const online = model.success && model.data.name === `models/${config.model}` && model.data.supportedGenerationMethods.includes('generateContent');
      return { provider, online, checkedAt: Date.now(), visionAvailable: false, ...(!online ? { error: unavailableMessage(provider) } : {}) };
    }
    const data = z.object({ data: z.array(z.object({ id: z.string() })) }).safeParse(raw);
    const ids = data.success ? data.data.data.map((entry) => entry.id) : [];
    const online = ids.includes(config.model);
    return { provider, online, checkedAt: Date.now(), visionAvailable: provider === 'ollama' && Boolean(process.env.OLLAMA_VISION_MODEL && ids.includes(process.env.OLLAMA_VISION_MODEL)),
      ...(!online ? { error: unavailableMessage(provider) } : {}) };
  } catch (error) {
    return { provider, online: false, checkedAt: Date.now(), visionAvailable: false,
      error: error instanceof HttpError ? error.message : provider ? unavailableMessage(provider) : 'El proveedor de conversaciones no es válido.' };
  }
}
