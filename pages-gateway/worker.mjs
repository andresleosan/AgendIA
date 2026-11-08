export const PUBLIC_ORIGIN = 'https://agendia-app.pages.dev';
const PUBLIC_HOST = 'agendia-app.pages.dev';
const ID = '[A-Za-z0-9_-]{1,128}';
const SLUG = '[a-z0-9]+(?:-[a-z0-9]+)*';
const business = '/api/businesses/' + ID;
const appointment = business + '/appointments/' + ID;
const rules = [
  ['GET', '/api/session'],
  ['GET POST', '/api/(?:consent(?:/preauthorize)?|booking-subject-consent|businesses|billing)'],
  ['POST', '/api/(?:businesses/logo|invitations/redeem|sarin/chat|team/requests)'],
  ['GET', '/api/(?:businesses/qr-kit|sarin/health|public/commercial-offer|team/memberships)'],
  ['GET POST DELETE', '/api/platform-whatsapp/link'],
  ['GET POST', '/api/platform-support/conversations'],
  ['GET POST', '/api/platform-support/conversations/' + ID + '/messages'],
  ['GET', '/api/public/businesses/' + SLUG + '(?:/logo/[a-f0-9]{64})?'],
  ['DELETE', '/api/team/memberships/' + ID],
  ['GET', '/api/team/businesses/' + ID + '/agenda'],
  ['GET POST PATCH', business + '/appointments'],
  ['GET', appointment],
  ['GET PATCH', appointment + '/attendance'],
  ['GET POST', appointment + '/client-record'],
  ['PATCH', appointment + '/representation-review'],
  ['GET', appointment + '/owner-reschedule'],
  ['POST', appointment + '/owner-reschedule/(?:availability|proposals)'],
  ['GET', business + '/(?:booking-policy|factual-faq(?:/' + ID + ')?|operation-summary|reminders|team|waitlist/offer)'],
  ['GET PATCH', business + '/(?:booking-declaration|client-policy)'],
  ['GET PUT', business + '/(?:resource-schedules|factual-faq-settings)'],
  ['POST', business + '/(?:appointments/query|availability(?:/next)?|booking-proposals|reschedule/(?:availability|proposals)|reminders/seen|waitlist/cancel)'],
  ['PATCH', business + '/(?:reminders/preference|team/' + ID + ')'],
  ['POST', business + '/booking-proposals/' + ID + '/confirm'],
  ['GET', business + '/owner-reschedule-proposals/' + ID],
  ['POST', business + '/owner-reschedule-proposals/' + ID + '/confirm'],
  ['GET POST', business + '/waitlist'],
  ['GET', business + '/waitlist/offers/' + ID],
  ['POST', business + '/waitlist/offers/' + ID + '/(?:proposal|confirm|decline|close-expired)'],
  ['POST', business + '/owner-waitlist/(?:query|offers/query)'],
  ['GET', business + '/owner-waitlist/' + ID + '(?:/offer-context)?'],
  ['GET PATCH', business + '/owner-waitlist/' + ID + '/review'],
  ['POST', business + '/owner-waitlist/' + ID + '/offers'],
  ['GET', business + '/owner-waitlist/offers/' + ID],
  ['POST', business + '/owner-waitlist/offers/' + ID + '/(?:withdraw|close-expired)'],
].map(([methods, pattern]) => ({ methods: methods.split(' '), path: new RegExp('^' + pattern + '$') }));

function safePath(path) {
  return !/[%\\\x00-\x20\x7f]/.test(path) && !path.includes('//') && !path.split('/').some(part => part === '.' || part === '..');
}

export function isUiRequest(request) {
  const url = new URL(request.url), path = url.pathname;
  if (!['GET', 'HEAD'].includes(request.method) || request.headers.has('Next-Action')) return false;
  if (path.startsWith('/_next/static/')) {
    let decoded;
    try { decoded = decodeURIComponent(path); } catch { return false; }
    return safePath(decoded) && /^\/_next\/static\/[A-Za-z0-9_./@\[\]()-]+\.(?:js|css|woff2?|ttf|png|jpe?g|webp|svg|ico|txt)$/.test(decoded);
  }
  if (!safePath(path)) return false;
  if (path === '/_next/image') {
    const sources = url.searchParams.getAll('url');
    return sources.length === 1 && safePath(sources[0]) && /^\/brand\/[A-Za-z0-9_-]+\.(?:png|jpe?g|webp|svg)$/.test(sources[0]);
  }
  return /^\/(?:dashboard(?:\/(?:onboarding|billing|faq|qr-kit|reports|schedule|team|waitlist))?|team(?:\/[A-Za-z0-9_-]{1,128})?|b\/[a-z0-9]+(?:-[a-z0-9]+)*|soporte|privacidad|terminos|ayuda)?\/?$/.test(path)
    || /^\/(?:_next\/static|brand|fonts)\/[A-Za-z0-9_./-]+\.(?:js|css|woff2?|ttf|png|jpe?g|webp|svg|ico|txt)$/.test(path)
    || /^\/(?:favicon\.(?:ico|png)|apple-touch-icon\.png|(?:sarin|agendia)-[a-z0-9-]+\.(?:svg|png|ico)|robots\.txt|sitemap\.xml|manifest\.webmanifest)$/.test(path);
}

export function isCommercialApiRequest(request) {
  const url = new URL(request.url);
  if (!safePath(url.pathname) || request.headers.has('Next-Action')) return false;
  if (url.pathname === '/api/sarin/health' && [...url.searchParams].some(([key, value]) => key !== 'scope' || value !== 'chat')) return false;
  return rules.some(rule => rule.path.test(url.pathname) && rule.methods.includes(request.method === 'HEAD' ? 'GET' : request.method));
}

export function privateHeaders(input = new Headers()) {
  const headers = new Headers(input);
  headers.set('Cache-Control', 'no-store');
  headers.set('CDN-Cache-Control', 'no-store');
  headers.set('Cloudflare-CDN-Cache-Control', 'no-store');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
  return headers;
}

export function rejected(request, status = 404) {
  const headers = privateHeaders();
  if (status === 503) headers.set('Retry-After', '5');
  headers.set('Content-Type', 'application/json; charset=utf-8');
  const message = status === 403 ? 'Origen no autorizado.' : status === 503 ? 'AgendIA está temporalmente no disponible.' : 'No disponible.';
  return new Response(request.method === 'HEAD' ? null : JSON.stringify({ error: message }), { status, headers });
}

const hop = new Set(['connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer', 'upgrade', 'proxy-connection']);
export function upstreamHeaders(request) {
  const headers = new Headers(request.headers);
  for (const name of [...headers.keys()]) {
    if (hop.has(name.toLowerCase()) || /^(?:cf-access-|x-forwarded-|x-middleware-|x-sarin-|x-original-|x-rewrite-)/i.test(name)
      || ['forwarded', 'x-real-ip', 'true-client-ip', 'cf-connecting-ip', 'cf-connecting-ipv6', 'cf-container-target-port', 'proxy-authorization', 'proxy-authenticate'].includes(name.toLowerCase())) headers.delete(name);
  }
  // Authentication is the Firebase bearer token. Access cookies are not an app credential.
  headers.delete('Cookie');
  headers.set('Host', PUBLIC_HOST);
  headers.set('X-Forwarded-Host', PUBLIC_HOST);
  headers.set('X-Forwarded-Proto', 'https');
  return headers;
}

export async function serviceResponse(request, service) {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), 660_000);
  try {
    const upstream = await service.fetch(new Request(request, { headers: upstreamHeaders(request), redirect: 'manual', cache: 'no-store', signal: AbortSignal.any([request.signal, timeout.signal]) }));
    const headers = new Headers(upstream.headers);
    if (upstream.status >= 500 || headers.get('cf-mitigated') === 'challenge') {
      await upstream.body?.cancel();
      return rejected(request, 503);
    }
    const location = headers.get('location');
    if (location) {
      const target = new URL(location, request.url);
      if (target.origin !== PUBLIC_ORIGIN || target.username || target.password || !isUiRequest(new Request(target))) {
        await upstream.body?.cancel();
        return rejected(request, 503);
      }
      headers.set('Location', target.href);
    }
    for (const name of [...headers.keys()]) {
      if (hop.has(name.toLowerCase()) || /^(?:cf-access-|access-control-)/i.test(name) || ['authorization', 'proxy-authorization', 'proxy-authenticate', 'set-cookie', 'refresh', 'server', 'x-powered-by', 'alt-svc', 'report-to', 'nel'].includes(name.toLowerCase())) headers.delete(name);
    }
    const bodyless = request.method === 'HEAD' || upstream.status >= 300 && upstream.status < 400;
    if (bodyless) { await upstream.body?.cancel(); headers.delete('Content-Length'); }
    return new Response(bodyless ? null : upstream.body, { status: upstream.status, headers: privateHeaders(headers) });
  } catch {
    return rejected(request, 503);
  } finally { clearTimeout(timer); }
}

export async function handleRequest(request, env) {
  if (env.AGENDIA_PUBLIC_ORIGIN !== PUBLIC_ORIGIN || !env.SARIN_API || typeof env.SARIN_API.fetch !== 'function'
    || !env.AGENDIA_WEB || typeof env.AGENDIA_WEB.fetch !== 'function' || 'SARIN_APP_HOST' in env) return rejected(request, 503);
  if (new URL(request.url).origin !== PUBLIC_ORIGIN) return rejected(request);
  const api = isCommercialApiRequest(request);
  if (!api && !isUiRequest(request)) return rejected(request);
  const origin = request.headers.get('Origin');
  if (origin !== null && origin !== PUBLIC_ORIGIN) return rejected(request, 403);
  return serviceResponse(request, api ? env.SARIN_API : env.AGENDIA_WEB);
}

export default { fetch: (request, env) => handleRequest(request, env) };
