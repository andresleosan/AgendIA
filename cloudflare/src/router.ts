import { parseWorkloadAudience } from './identity-core.ts';
import { recoveryRestricted } from '../../shared/recovery-admission.ts';
import { recoveryAdmissionAllowed } from './recovery-witness.ts';

export const SINGLETON_NAME = 'sarin-global-app';

const runtimeKeys = [
  'FIREBASE_ADMIN_PROJECT_ID', 'FIREBASE_ADMIN_CLIENT_EMAIL', 'FIREBASE_ADMIN_PRIVATE_KEY', 'FIREBASE_ADMIN_CREDENTIAL_MODE',
  'PLATFORM_SUPPORT_KEY', 'ADMIN_PAYMENT_ACTION_KEY', 'FIREBASE_WIF_AUDIENCE', 'FIREBASE_WIF_SERVICE_ACCOUNT_EMAIL', 'SUPERADMIN_UID',
  'SARIN_TUNNEL_URL', 'OLLAMA_MAIN_MODEL', 'OLLAMA_VISION_MODEL', 'CF_ACCESS_CLIENT_ID', 'CF_ACCESS_CLIENT_SECRET',
  'SARIN_CHAT_PROVIDER', 'DEEPSEEK_MODEL', 'DEEPSEEK_API_KEY', 'GEMINI_MODEL', 'GEMINI_API_KEY', 'GEMINI_BILLING_VERIFIED',
  'GEMINI_TEST_MODEL', 'GEMINI_TEST_API_KEY',
  'WHATSAPP_ENABLED', 'WHATSAPP_RETENTION_ENABLED', 'WHATSAPP_GRAPH_API_VERSION', 'WHATSAPP_APP_SECRET',
  'WHATSAPP_VERIFY_TOKEN', 'WHATSAPP_CONTENT_KEY', 'WHATSAPP_PHONE_CREDENTIALS_JSON',
  'PLATFORM_WHATSAPP_RECEIVE_ENABLED', 'PLATFORM_WHATSAPP_RETENTION_ENABLED', 'PLATFORM_WHATSAPP_AI_ENABLED', 'PLATFORM_WHATSAPP_SEND_ENABLED',
  'PLATFORM_WHATSAPP_PROCESSING_ENABLED', 'PLATFORM_WHATSAPP_TRANSCRIPTION_ENABLED', 'PLATFORM_WHATSAPP_GENERATION_POLICY', 'PLATFORM_YCLOUD_API_KEY',
  'PLATFORM_WHATSAPP_ADMIN_BUDGET_REQUIRED',
  'PLATFORM_WHATSAPP_AUDIO_ENABLED', 'PLATFORM_WHATSAPP_TARIFF_POLICY', 'PLATFORM_WHATSAPP_AUDIO_DAILY_BUDGET_MICROS', 'PLATFORM_WHATSAPP_GENERATION_DAILY_BUDGET_MICROS', 'PLATFORM_WHATSAPP_SEND_DAILY_BUDGET_MICROS',
  'PLATFORM_YCLOUD_WEBHOOK_SECRET', 'PLATFORM_WHATSAPP_CONTENT_KEY', 'PLATFORM_WHATSAPP_LINK_HMAC_KEY', 'PLATFORM_WHATSAPP_WABA_ID', 'PLATFORM_WHATSAPP_PHONE_E164', 'PLATFORM_WHATSAPP_PHONE_NUMBER_ID',
  'PLATFORM_YCLOUD_DIAGNOSTIC_ENABLED', 'PLATFORM_YCLOUD_DIAGNOSTIC_RUN_ID', 'PLATFORM_YCLOUD_DIAGNOSTIC_EXPIRES_AT', 'PLATFORM_YCLOUD_DIAGNOSTIC_SENDER', 'PLATFORM_YCLOUD_DIAGNOSTIC_NONCE',
  'MAX_CONCURRENT_LLM_SLOTS', 'MAX_QUEUED_LLM_REQUESTS', 'LLM_QUEUE_TIMEOUT_MS', 'LLM_REQUEST_TIMEOUT_MS',
  'WEEKLY_PRICE_COP', 'FORTNIGHTLY_PRICE_COP', 'MONTHLY_PRICE_COP',
  'SARIN_DATA_BACKEND', 'SARIN_MAINTENANCE', 'SARIN_PUBLIC_BOOKING_ORIGIN', 'PILOT_AI_BUDGET_ENFORCED', 'SARIN_RESOURCE_SCHEDULE_WRITES_ENABLED', 'SARIN_WAITLIST_OFFERS_ENABLED', 'SARIN_TEAM_ACCESS_ENABLED',
  'SARIN_BACKUP_ENABLED', 'SARIN_BACKUP_HMAC_KEY', 'SARIN_BACKUP_RECIPIENT', 'SARIN_BACKUP_CONFIG_FILE', 'SARIN_BACKUP_PASSWORD_FILE', 'SARIN_BACKUP_SOURCE_SHA',
  'SARIN_RECOVERY_MODE',
] as const;
const publicKeys = ['NEXT_PUBLIC_FIREBASE_API_KEY', 'NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN', 'NEXT_PUBLIC_FIREBASE_PROJECT_ID', 'NEXT_PUBLIC_FIREBASE_APP_ID'] as const;
const forbiddenRuntimeKeys = ['FIREBASE_AUTH_EMULATOR_HOST', 'FIRESTORE_EMULATOR_HOST', 'NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST', 'NEXT_PUBLIC_FIRESTORE_EMULATOR_HOST', 'NEXT_PUBLIC_FIREBASE_EMULATORS'];
const requiredRuntimeKeys = ['FIREBASE_ADMIN_PROJECT_ID', 'SUPERADMIN_UID', 'SARIN_TUNNEL_URL', 'OLLAMA_MAIN_MODEL', 'CF_ACCESS_CLIENT_ID', 'CF_ACCESS_CLIENT_SECRET'];
const humanCredentialKeys = ['GOOGLE_APPLICATION_CREDENTIALS', 'CLOUDSDK_CONFIG', 'HOME', 'APPDATA'];

function supplied(input: Record<string, unknown>, key: string): boolean {
  return input[key] !== undefined && input[key] !== '';
}

export function runtimeEnvironment(input: Record<string, unknown>): Record<string, string> {
  if (forbiddenRuntimeKeys.some((key) => input[key] !== undefined && input[key] !== '')) throw new Error('Los emuladores no están permitidos en el runtime Cloudflare.');
  const env: Record<string, string> = { NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1', HOSTNAME: '0.0.0.0', PORT: '3000' };
  for (const key of runtimeKeys) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) env[key] = value;
  }
  for (const key of requiredRuntimeKeys) if (!env[key]) throw new Error('Falta configuración requerida del servidor.');
  if (input.SARIN_TEAM_ACCESS_ENABLED !== undefined && !['true', 'false'].includes(input.SARIN_TEAM_ACCESS_ENABLED as string)) throw new Error('El indicador de equipo no es válido.');
  env.SARIN_TEAM_ACCESS_ENABLED ??= 'false';
  env.SARIN_BACKUP_ENABLED ??= 'false';
  if (input.SARIN_RECOVERY_MODE !== undefined && !['normal', 'recovery'].includes(String(input.SARIN_RECOVERY_MODE))) throw new Error('El modo de recuperación no es válido.');
  if (recoveryRestricted(input)) {
    for (const key of Object.keys(env)) if (key.endsWith('_ENABLED')) env[key] = 'false';
    env.SARIN_MAINTENANCE = 'true';
  }
  if (!['true', 'false'].includes(env.SARIN_BACKUP_ENABLED)) throw new Error('El indicador de copia no es válido.');
  env.SARIN_DATA_BACKEND ??= 'firestore';
  if (!['firestore', 'd1'].includes(env.SARIN_DATA_BACKEND)) throw new Error('El backend de datos no es válido.');
  if (env.SARIN_MAINTENANCE !== undefined && !['true', 'false'].includes(env.SARIN_MAINTENANCE)) throw new Error('El indicador de mantenimiento no es válido.');
  if (env.SARIN_RESOURCE_SCHEDULE_WRITES_ENABLED !== undefined && !['true', 'false'].includes(env.SARIN_RESOURCE_SCHEDULE_WRITES_ENABLED)) throw new Error('El indicador de escritura de horarios no es válido.');
  if (env.SARIN_WAITLIST_OFFERS_ENABLED !== undefined && !['true', 'false'].includes(env.SARIN_WAITLIST_OFFERS_ENABLED)) throw new Error('El indicador de ofertas de espera no es válido.');
  if (env.PILOT_AI_BUDGET_ENFORCED !== undefined && !['true', 'false'].includes(env.PILOT_AI_BUDGET_ENFORCED)) throw new Error('El indicador de presupuesto no es válido.');
  if (env.FIREBASE_ADMIN_PROJECT_ID.startsWith('demo-')) throw new Error('No se permite el proyecto de emuladores.');
  const credentialMode = env.FIREBASE_ADMIN_CREDENTIAL_MODE ?? 'cert';
  if (!['cert', 'adc'].includes(credentialMode)) throw new Error('El modo de credenciales Firebase Admin no es válido.');
  env.FIREBASE_ADMIN_CREDENTIAL_MODE = credentialMode;
  if (credentialMode === 'adc') {
    if (['FIREBASE_ADMIN_CLIENT_EMAIL', 'FIREBASE_ADMIN_PRIVATE_KEY', ...humanCredentialKeys].some(key => supplied(input, key))) throw new Error('La identidad de Cloudflare no admite certificados ni credenciales humanas.');
    parseWorkloadAudience(env.FIREBASE_WIF_AUDIENCE);
    const email = env.FIREBASE_WIF_SERVICE_ACCOUNT_EMAIL ?? '';
    const account = /^([a-z][a-z0-9-]{4,28}[a-z0-9])@([a-z][a-z0-9-]{4,28}[a-z0-9])\.iam\.gserviceaccount\.com$/.exec(email);
    if (!account || account[1] !== 'sarin-runtime' || account[2] !== env.FIREBASE_ADMIN_PROJECT_ID) throw new Error('La cuenta de servicio debe ser la identidad de Sarin del proyecto Firebase.');
  } else {
    if (!env.FIREBASE_ADMIN_CLIENT_EMAIL || !env.FIREBASE_ADMIN_PRIVATE_KEY) throw new Error('Falta configuración requerida del servidor.');
    if (['FIREBASE_WIF_AUDIENCE', 'FIREBASE_WIF_SERVICE_ACCOUNT_EMAIL'].some(key => supplied(input, key))) throw new Error('Configura un único modo de identidad Firebase.');
  }
  let url: URL;
  try { url = new URL(env.SARIN_TUNNEL_URL); } catch { throw new Error('El motor remoto debe usar HTTPS privado.'); }
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.search || url.hash || !url.pathname.endsWith('/v1/chat/completions') || !(url.hostname === 'alsdevstudio.com' || url.hostname.endsWith('.alsdevstudio.com'))) throw new Error('El motor remoto debe usar HTTPS privado.');
  return env;
}

export function backgroundWorkEnabled(input: Record<string, unknown>): boolean {
  if (recoveryRestricted(input)) return false;
  if (input.SARIN_MAINTENANCE === 'true') return false;
  return input.WHATSAPP_ENABLED === 'true' || input.WHATSAPP_RETENTION_ENABLED === 'true';
}

export async function wakeBackgroundSingleton(input: Record<string, unknown>, get: (name: string) => { startAndWaitForPorts(): Promise<void> }): Promise<void> {
  if (!backgroundWorkEnabled(input)) return;
  try {
    // This starts the same process as browser traffic, without sending or replaying an application request.
    await get(SINGLETON_NAME).startAndWaitForPorts();
  } catch {
    throw new Error('El proceso de tareas de fondo no está disponible.');
  }
}

export function publicBuildArguments(input: Record<string, unknown>): Record<string, string> {
  const args: Record<string, string> = {};
  for (const key of publicKeys) {
    const value = input[key];
    if (typeof value !== 'string' || !value.trim() || /[\r\n\0]/.test(value)) throw new Error(`Configura ${key} con un valor público real.`);
    args[key] = value.trim();
  }
  if (args.NEXT_PUBLIC_FIREBASE_PROJECT_ID.startsWith('demo-') || input.NEXT_PUBLIC_FIREBASE_EMULATORS === 'true') throw new Error('El build Cloudflare no permite emuladores.');
  return args;
}

async function readDrainQueue(upstream: Response): Promise<Record<string, number>> {
  const reader = upstream.body?.getReader();
  if (!reader) throw new Error('Falta el estado de la cola.');
  let body = '';
  let bytes = 0;
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 16_384) throw new Error('El estado de la cola excede el límite.');
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
  } catch {
    await reader.cancel().catch(() => {});
    throw new Error('El estado de la cola no está disponible.');
  } finally {
    reader.releaseLock();
  }
  const health: unknown = JSON.parse(body);
  const queue = health && typeof health === 'object' && !Array.isArray(health) ? (health as Record<string, unknown>).queue : undefined;
  const fields = ['activeSlots', 'queuedRequests', 'criticalQueued', 'normalQueued', 'maxSlots'];
  if (!queue || typeof queue !== 'object' || Array.isArray(queue) || Object.keys(queue).length !== fields.length) throw new Error('El estado de la cola no es válido.');
  const counters = queue as Record<string, unknown>;
  if (!fields.every(field => Number.isSafeInteger(counters[field]) && (counters[field] as number) >= 0)) throw new Error('El estado de la cola no es válido.');
  const result = Object.fromEntries(fields.map(field => [field, counters[field] as number]));
  if (result.maxSlots < 1 || result.activeSlots > result.maxSlots || result.queuedRequests !== result.criticalQueued + result.normalQueued) throw new Error('El estado de la cola no es válido.');
  return result;
}

export async function forwardToSingleton(request: Request, get: (name: string) => { fetch(request: Request): Promise<Response> }, input: Record<string, unknown> = {}): Promise<Response> {
  if (recoveryRestricted(input) && !await recoveryAdmissionAllowed(input as RecoveryBindings)) return Response.json({ error: 'La recuperación requiere validación operativa.' }, { status: 503, headers: { 'Cache-Control': 'no-store', 'CDN-Cache-Control': 'no-store', 'Cloudflare-CDN-Cache-Control': 'no-store', 'Retry-After': '60' } });
  let publicPath: string;
  try { publicPath = decodeURIComponent(new URL(request.url).pathname).replaceAll('\\', '/'); }
  catch { return new Response(null, { status: 404 }); }
  if (/^\/api\/internal(?:\/|$)/i.test(publicPath)) return new Response(null, { status: 404, headers: { 'Cache-Control': 'no-store' } });
  let drainRead = false;
  if (input.SARIN_MAINTENANCE === 'true') {
    const url = new URL(request.url);
    // Session refresh must reach Next's Firebase authentication during maintenance.
    // Match the complete URL so even empty query/fragment delimiters stay closed.
    const sessionRead = request.method === 'GET' && url.href === `${url.origin}/api/session`
      && /^Bearer [^\s]+$/i.test(request.headers.get('Authorization') ?? '');
    // The existing Next handler still verifies Firebase and the superadmin UID.
    // Its engine queue probe and exact budget administration remain available;
    // Next still authorizes the superadmin before either action.
    drainRead = request.method === 'GET' && url.pathname === '/api/sarin/health' && url.search === '?scope=engine' && !url.hash
      && /^Bearer [^\s]+$/i.test(request.headers.get('Authorization') ?? '');
    const budgetCursorRead = request.method === 'GET' && [...url.searchParams.keys()].every(key => key === 'cursor') && url.searchParams.getAll('cursor').length === 1 && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(url.searchParams.get('cursor') ?? '');
    const businessBudgetRead = request.method === 'GET' && [...url.searchParams.keys()].every(key => key === 'businessId') && url.searchParams.getAll('businessId').length === 1 && /^[A-Za-z0-9_-]{1,128}$/.test(url.searchParams.get('businessId') ?? '');
    const budgetAdministration = ['GET', 'PATCH'].includes(request.method) && url.pathname === '/api/admin/abuse' && (!url.search || budgetCursorRead || businessBudgetRead) && !url.hash && /^Bearer [^\s]+$/i.test(request.headers.get('Authorization') ?? '');
    const bookingAdministration = url.pathname === '/api/admin/booking-data-policy' && !url.hash && /^Bearer [^\s]+$/i.test(request.headers.get('Authorization') ?? '') && ((request.method === 'GET' && businessBudgetRead) || (request.method === 'PATCH' && !url.search));
    if (!sessionRead && !drainRead && !budgetAdministration && !bookingAdministration) return Response.json({ error: 'La aplicación está en mantenimiento.' }, { status: 503, headers: { 'Cache-Control': 'no-store', 'CDN-Cache-Control': 'no-store', 'Cloudflare-CDN-Cache-Control': 'no-store', 'Retry-After': '60' } });
  }
  try {
    const requestHeaders = new Headers(request.headers);
    for (const name of [...requestHeaders.keys()]) if (name.startsWith('x-sarin-backup-') || name.startsWith('x-sarin-recovery-')) requestHeaders.delete(name);
    // The SDK supports port switching through this header. It is never a public
    // capability: all traffic must reach the single Next port fixed at 3000.
    requestHeaders.delete('cf-container-target-port');
    requestHeaders.delete('cf-access-client-id');
    requestHeaders.delete('cf-access-client-secret');
    const upstream = await get(SINGLETON_NAME).fetch(new Request(request, { headers: requestHeaders, redirect: 'manual' }));
    if (drainRead && upstream.status === 503) {
      if (upstream.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
        await upstream.body?.cancel();
        throw new Error('El estado de la cola no está disponible.');
      }
      // Only the existing superadmin handler includes this queue. Offline Ollama
      // must not hide drain counters behind the Pages gateway's 5xx response.
      const queue = await readDrainQueue(upstream);
      return Response.json({ status: 'offline', online: false, provider: 'ollama', queue }, { headers: { 'Cache-Control': 'no-store', 'CDN-Cache-Control': 'no-store', 'Cloudflare-CDN-Cache-Control': 'no-store' } });
    }
    if (upstream.status >= 500 && !upstream.headers.get('Content-Type')?.toLowerCase().includes('application/json')) {
      await upstream.body?.cancel();
      throw new Error('El transporte del contenedor no está disponible.');
    }
    const headers = new Headers(upstream.headers);
    headers.set('Cache-Control', 'no-store');
    headers.set('CDN-Cache-Control', 'no-store');
    headers.set('Cloudflare-CDN-Cache-Control', 'no-store');
    headers.delete('cf-access-client-id'); headers.delete('cf-access-client-secret'); headers.delete('authorization');
    // Use the same stream without clone(), text(), json() or an application
    // retry loop. Next retains responsibility for Firebase authentication.
    return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers });
  } catch {
    return Response.json({ error: 'La aplicación está temporalmente indisponible. Reintenta cuando vuelva a estar disponible.' }, { status: 503, headers: { 'Cache-Control': 'no-store', 'Retry-After': '5' } });
  }
}
