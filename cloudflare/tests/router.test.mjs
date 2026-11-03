import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forwardToSingleton, runtimeEnvironment, publicBuildArguments, SINGLETON_NAME } from '../src/router.ts';
import { readFileSync } from 'node:fs';

test('waitlist offers gate is private, strictly boolean and disabled by default', () => {
  assert.equal(runtimeEnvironment(certificateRuntime).SARIN_WAITLIST_OFFERS_ENABLED, undefined);
  for (const value of ['false', 'true']) assert.equal(runtimeEnvironment({ ...certificateRuntime, SARIN_WAITLIST_OFFERS_ENABLED: value }).SARIN_WAITLIST_OFFERS_ENABLED, value);
  for (const value of ['enabled', 'TRUE', ' true ', '0']) assert.throws(() => runtimeEnvironment({ ...certificateRuntime, SARIN_WAITLIST_OFFERS_ENABLED: value }));
  const config = JSON.parse(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
  assert.equal(runtimeEnvironment({ ...certificateRuntime, ...config.vars, FIREBASE_ADMIN_CREDENTIAL_MODE: 'cert', FIREBASE_WIF_AUDIENCE: '', FIREBASE_WIF_SERVICE_ACCOUNT_EMAIL: '' }).SARIN_WAITLIST_OFFERS_ENABLED, 'false');
  assert.equal(publicBuildArguments({ ...certificateRuntime, SARIN_WAITLIST_OFFERS_ENABLED: 'true', NEXT_PUBLIC_FIREBASE_API_KEY: 'public-synthetic', NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: 'real-project.firebaseapp.com', NEXT_PUBLIC_FIREBASE_PROJECT_ID: 'real-project', NEXT_PUBLIC_FIREBASE_APP_ID: 'app-id' }).SARIN_WAITLIST_OFFERS_ENABLED, undefined);
});

test('resource schedule write gate is private, boolean and forwarded without enabling by absence', () => {
  assert.equal(runtimeEnvironment(certificateRuntime).SARIN_RESOURCE_SCHEDULE_WRITES_ENABLED, undefined);
  for (const value of ['false', 'true']) assert.equal(runtimeEnvironment({ ...certificateRuntime, SARIN_RESOURCE_SCHEDULE_WRITES_ENABLED: value }).SARIN_RESOURCE_SCHEDULE_WRITES_ENABLED, value);
  assert.throws(() => runtimeEnvironment({ ...certificateRuntime, SARIN_RESOURCE_SCHEDULE_WRITES_ENABLED: 'enabled' }));
  assert.equal(publicBuildArguments({ ...certificateRuntime, SARIN_RESOURCE_SCHEDULE_WRITES_ENABLED: 'true', NEXT_PUBLIC_FIREBASE_API_KEY: 'public-synthetic', NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: 'real-project.firebaseapp.com', NEXT_PUBLIC_FIREBASE_PROJECT_ID: 'real-project', NEXT_PUBLIC_FIREBASE_APP_ID: 'app-id' }).SARIN_RESOURCE_SCHEDULE_WRITES_ENABLED, undefined);
});

const certificateRuntime = {
  FIREBASE_ADMIN_PROJECT_ID: 'real-project', FIREBASE_ADMIN_CLIENT_EMAIL: 'configured@example.test', FIREBASE_ADMIN_PRIVATE_KEY: 'synthetic-key',
  SUPERADMIN_UID: 'owner', SARIN_TUNNEL_URL: 'https://ia-sarin.alsdevstudio.com/v1/chat/completions', OLLAMA_MAIN_MODEL: 'main-local',
  OLLAMA_VISION_MODEL: 'vision-local', CF_ACCESS_CLIENT_ID: 'synthetic-id', CF_ACCESS_CLIENT_SECRET: 'synthetic-secret',
};
const workloadRuntime = {
  ...certificateRuntime, FIREBASE_ADMIN_CREDENTIAL_MODE: 'adc', FIREBASE_ADMIN_CLIENT_EMAIL: '', FIREBASE_ADMIN_PRIVATE_KEY: '',
  FIREBASE_WIF_AUDIENCE: '//iam.googleapis.com/projects/123456789012/locations/global/workloadIdentityPools/sarin-cloudflare/providers/worker-oidc',
  FIREBASE_WIF_SERVICE_ACCOUNT_EMAIL: 'sarin-runtime@real-project.iam.gserviceaccount.com',
};
test('public internal paths stay closed and recovery headers never reach the singleton', async()=>{
  for(const path of ['/api/internal/recovery-backup','/api/%69nternal/recovery-backup','/api/internal%2frecovery-backup']){
    const response=await forwardToSingleton(new Request('https://example.test'+path,{method:'POST',headers:{'x-sarin-backup-signature':'forged'}}),()=>{throw Error('must not wake');});
    assert.equal(response.status,404);
  }
  let forwarded;
  await forwardToSingleton(new Request('https://example.test/api/session',{headers:{'x-sarin-backup-signature':'forged','x-sarin-backup-command':'private'}}),()=>({fetch:async r=>{forwarded=r;return Response.json({});}}));
  assert.equal(forwarded.headers.get('x-sarin-backup-command'),null);assert.equal(forwarded.headers.get('x-sarin-backup-signature'),null);
});
test('maintenance allows only exact authenticated booking classification administration', async () => {
  const allowed = [['GET', '?businessId=demo'], ['PATCH', '']];
  for (const [method, query] of allowed) {
    let calls = 0;
    const response = await forwardToSingleton(new Request(`https://example.com/api/admin/booking-data-policy${query}`, { method, headers: { authorization: 'Bearer synthetic' } }), () => ({ fetch: async () => { calls++; return new Response('authorized in Next'); } }), { SARIN_MAINTENANCE: 'true' });
    assert.equal(response.status, 200); assert.equal(calls, 1);
  }
  for (const [method, suffix, auth] of [['GET', '', true], ['GET', '?businessId=demo&businessId=demo', true], ['GET', '?businessId=demo&cursor=a', true], ['GET', '?businessId=demo&extra=1', true], ['GET', '?businessId=bad%2Fid', true], ['PATCH', '?businessId=demo', true], ['GET', '?businessId=demo', false], ['POST', '', true], ['GET', '/extra?businessId=demo', true]]) {
    let calls = 0;
    const response = await forwardToSingleton(new Request(`https://example.com/api/admin/booking-data-policy${suffix}`, { method, headers: auth ? { authorization: 'Bearer synthetic' } : {} }), () => { calls++; throw new Error('must stay closed'); }, { SARIN_MAINTENANCE: 'true' });
    assert.equal(response.status, 503); assert.equal(calls, 0);
  }
});

test('maintains a narrowly authenticated budget configuration route while chat stays closed', async () => {
  const get = () => ({ fetch: async () => Response.json({ configured: true }) });
  for (const method of ['GET', 'PATCH']) assert.equal((await forwardToSingleton(new Request('https://app.example.invalid/api/admin/abuse', { method, headers: { Authorization: 'Bearer synthetic' } }), get, { SARIN_MAINTENANCE: 'true' })).status, 200);
  const cursorUrl = 'https://app.example.invalid/api/admin/abuse?cursor=00000000-0000-4000-8000-000000000001';
  assert.equal((await forwardToSingleton(new Request(cursorUrl, { headers: { Authorization: 'Bearer synthetic' } }), get, { SARIN_MAINTENANCE: 'true' })).status, 200);
  assert.equal((await forwardToSingleton(new Request(cursorUrl, { method: 'PATCH', headers: { Authorization: 'Bearer synthetic' } }), get, { SARIN_MAINTENANCE: 'true' })).status, 503);
  for (const path of ['/api/admin/abuse?extra=1', '/api/admin/abuse/', '/api/sarin/chat', '/api/admin/invitations']) assert.equal((await forwardToSingleton(new Request(`https://app.example.invalid${path}`, { headers: { Authorization: 'Bearer synthetic' } }), get, { SARIN_MAINTENANCE: 'true' })).status, 503);
  assert.equal((await forwardToSingleton(new Request('https://app.example.invalid/api/admin/abuse'), get, { SARIN_MAINTENANCE: 'true' })).status, 503);
  assert.equal(runtimeEnvironment({ ...workloadRuntime, PILOT_AI_BUDGET_ENFORCED: 'true' }).PILOT_AI_BUDGET_ENFORCED, 'true');
  assert.throws(() => runtimeEnvironment({ ...workloadRuntime, PILOT_AI_BUDGET_ENFORCED: 'yes' }));
});

test('all business, admin and local engine requests use one constant container', async () => {
  const names = [];
  const get = (name) => { names.push(name); return { fetch: async () => new Response('ok') }; };
  for (const path of ['/b/one', '/b/two', '/admin/ai', '/api/sarin/health?scope=engine']) await forwardToSingleton(new Request(`https://app.example.invalid${path}`), get);
  assert.deepEqual(names, Array(4).fill(SINGLETON_NAME));
  assert.equal(new Set(names).size, 1);
});

test('maintenance allows only one authenticated business budget read without opening other queries', async () => {
  let forwarded = 0;
  const get = () => ({ fetch: async () => { forwarded++; return new Response('ok'); } });
  const send = (query, method = 'GET', authorized = true) => forwardToSingleton(new Request(`https://app.example.invalid/api/admin/abuse${query}`, { method, headers: authorized ? { Authorization: 'Bearer synthetic' } : {} }), get, { SARIN_MAINTENANCE: 'true' });
  assert.equal((await send('?businessId=b_one')).status, 200);
  assert.equal(forwarded, 1);
  for (const query of ['?businessId=', '?businessId=one&businessId=two', '?businessId=../one', '?businessId=one&cursor=00000000-0000-4000-8000-000000000001', '?businessId=one&extra=1']) assert.equal((await send(query)).status, 503);
  assert.equal((await send('?businessId=one', 'PATCH')).status, 503);
  assert.equal((await send('?businessId=one', 'GET', false)).status, 503);
  assert.equal(forwarded, 1);
});
test('forwards a POST exactly once and returns an unconsumed response stream', async () => {
  let calls = 0;
  const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('private result')); } });
  const upstream = new Response(body, { status: 409, headers: { 'Content-Type': 'application/json' } });
  const request = new Request('https://app.example.invalid/api/sarin/chat', { method: 'POST', headers: { Authorization: 'Bearer synthetic' }, body: 'private request' });
  const response = await forwardToSingleton(request, () => ({ fetch: async (forwarded) => { calls++; assert.equal(forwarded.bodyUsed, false); assert.equal(forwarded.headers.get('Authorization'), 'Bearer synthetic'); return upstream; } }));
  assert.equal(calls, 1);
  assert.equal(response.status, 409);
  assert.equal(response.body, upstream.body);
  assert.equal(response.bodyUsed, false);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  await response.body.cancel();
});
test('does not replay a failed POST and hides internal exception details', async () => {
  let calls = 0;
  const response = await forwardToSingleton(new Request('https://app.example.invalid/api/billing', { method: 'POST', body: 'sensitive' }), () => ({ fetch: async () => { calls++; throw new Error('sensitive failure detail'); } }));
  assert.equal(calls, 1);
  assert.equal(response.status, 503);
  assert.equal((await response.text()).includes('sensitive'), false);
});
test('cannot pass an internal SDK error or switch-port header to the browser', async () => {
  const request = new Request('https://app.example.invalid/api/sarin/chat', { method: 'POST', headers: { 'cf-container-target-port': '9229', 'CF-Access-Client-Secret': 'injected' }, body: 'private' });
  const response = await forwardToSingleton(request, () => ({ fetch: async (forwarded) => {
    assert.equal(forwarded.headers.get('cf-container-target-port'), null);
    assert.equal(forwarded.headers.get('CF-Access-Client-Secret'), null);
    return new Response('private crash detail', { status: 500 });
  } }));
  assert.equal(response.status, 503);
  assert.equal((await response.text()).includes('private crash detail'), false);
});
test('only allows explicit server runtime variables, with no development emulators', () => {
  const env = runtimeEnvironment({ ...certificateRuntime, UNRELATED_SECRET: 'excluded' });
  assert.equal(env.CF_ACCESS_CLIENT_SECRET, 'synthetic-secret');
  assert.equal(env.UNRELATED_SECRET, undefined);
  assert.equal(env.NODE_ENV, 'production');
  assert.equal(env.HOSTNAME, '0.0.0.0');
  assert.throws(() => runtimeEnvironment({ FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080' }));
  assert.throws(() => runtimeEnvironment({ NEXT_PUBLIC_FIREBASE_EMULATORS: 'true' }));
});
test('forwards the explicit canonical booking origin only to the server runtime', () => {
  const input = { ...certificateRuntime, SARIN_PUBLIC_BOOKING_ORIGIN: 'https://sarinbotsaas.pages.dev' };
  assert.equal(runtimeEnvironment(input).SARIN_PUBLIC_BOOKING_ORIGIN, input.SARIN_PUBLIC_BOOKING_ORIGIN);
});
test('accepts a runtime without a vision model while still requiring the main model', () => {
  const input = { ...workloadRuntime };
  delete input.OLLAMA_VISION_MODEL;
  const env = runtimeEnvironment(input);
  assert.equal(env.OLLAMA_MAIN_MODEL, 'main-local');
  assert.equal(env.OLLAMA_VISION_MODEL, undefined);
  assert.throws(() => runtimeEnvironment({ ...input, OLLAMA_MAIN_MODEL: '' }));
});

test('forwards explicit data rollout flags and rejects an unknown backend', () => {
  const env = runtimeEnvironment({ ...workloadRuntime, SARIN_DATA_BACKEND: 'd1', SARIN_MAINTENANCE: 'true' });
  assert.equal(env.SARIN_DATA_BACKEND, 'd1');
  assert.equal(env.SARIN_MAINTENANCE, 'true');
  assert.throws(() => runtimeEnvironment({ ...workloadRuntime, SARIN_DATA_BACKEND: 'automatic-fallback' }));
});

test('maintenance rejects all application paths before acquiring the singleton', async () => {
  let calls = 0;
  for (const path of ['/', '/api/session', '/api/sarin/chat']) {
    const response = await forwardToSingleton(new Request(`https://sarinbotsaas.pages.dev${path}`), () => { calls++; return { fetch: async () => new Response('should not run') }; }, { SARIN_MAINTENANCE: 'true' });
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
  }
  assert.equal(calls, 0);
});

test('maintenance forwards only exact bearer-format session reads to the existing Next authentication', async () => {
  let calls = 0;
  for (const [authorization, status, body] of [
    ['Bearer synthetic-valid-token', 200, { user: { uid: 'synthetic-user' }, isSuperadmin: false }],
    ['bearer synthetic-invalid-token', 401, { error: 'Session rejected by Next' }],
    ['Bearer synthetic-denied-token', 403, { error: 'Access rejected by Next' }],
  ]) {
    const request = new Request('https://app.example.invalid/api/session', { headers: { Authorization: authorization } });
    const upstream = Response.json(body, { status });
    const response = await forwardToSingleton(request, name => ({ fetch: async forwarded => {
      calls++;
      assert.equal(name, SINGLETON_NAME);
      assert.equal(forwarded.url, request.url);
      assert.equal(forwarded.method, 'GET');
      assert.equal(forwarded.headers.get('Authorization'), authorization);
      return upstream;
    } }), { SARIN_MAINTENANCE: 'true' });
    assert.equal(response.status, status);
    assert.equal(response.body, upstream.body);
    assert.deepEqual(await response.json(), body);
    for (const header of ['Cache-Control', 'CDN-Cache-Control', 'Cloudflare-CDN-Cache-Control']) assert.equal(response.headers.get(header), 'no-store');
  }
  assert.equal(calls, 3);
});

test('maintenance rejects session route, query, fragment, method and bearer variants before acquiring the singleton', async () => {
  let calls = 0;
  const get = () => { calls++; throw new Error('must stay closed'); };
  const send = (path = '/api/session', method = 'GET', authorization = 'Bearer synthetic') => forwardToSingleton(new Request(`https://app.example.invalid${path}`, {
    method, headers: authorization === null ? {} : { Authorization: authorization },
  }), get, { SARIN_MAINTENANCE: 'true' });
  for (const path of [
    '/api/session/', '/api/session/extra', '/api/Session', '/api/%73ession',
    '/api/session?', '/api/session?refresh=1', '/api/session?scope=engine', '/api/session?refresh=',
    '/api/session#', '/api/session#fragment', '/api/session?refresh=1#fragment',
    '/', '/b/demo', '/api/businesses/demo/appointments?view=mine', '/api/sarin/chat', '/api/admin',
  ]) {
    const response = await send(path);
    assert.equal(response.status, 503, path);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
  }
  for (const method of ['HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) assert.equal((await send('/api/session', method)).status, 503, method);
  for (const authorization of [null, '', 'synthetic', 'Basic synthetic', 'Bearer', 'Bearer ', 'Bearer token with spaces', 'Bearer  synthetic', 'Bearer\tsynthetic']) {
    assert.equal((await send('/api/session', 'GET', authorization)).status, 503, String(authorization));
  }
  assert.equal(calls, 0);
});

test('maintenance forwards only the exact authenticated local engine health read to the existing Next authorization', async () => {
  let calls = 0;
  for (const status of [200, 401, 403]) {
    const request = new Request('https://sarinbotsaas.pages.dev/api/sarin/health?scope=engine', { headers: { Authorization: 'Bearer synthetic-firebase-token' } });
    const response = await forwardToSingleton(request, name => ({ fetch: async forwarded => {
      calls++;
      assert.equal(name, 'sarin-global-app');
      assert.equal(forwarded.method, 'GET');
      assert.equal(forwarded.url, request.url);
      assert.equal(forwarded.headers.get('Authorization'), 'Bearer synthetic-firebase-token');
      return Response.json({ status: status === 200 ? 'online' : 'denied' }, { status });
    } }), { SARIN_MAINTENANCE: 'true' });
    assert.equal(response.status, status);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
  }
  assert.equal(calls, 3);
});

test('maintenance rejects method, route, query and credential variants without acquiring the singleton', async () => {
  let calls = 0;
  const get = () => { calls++; return { fetch: async () => new Response('must not run') }; };
  const canonical = '/api/sarin/health?scope=engine';
  const paths = [
    '/api/sarin/health', '/api/sarin/health/', '/api/sarin/health/extra?scope=engine', '/api/sarin/health?scope=chat',
    '/api/sarin/health?scope=engine&scope=engine', '/api/sarin/health?scope=engine&scope=chat', '/api/sarin/health?scope=engine&extra=1',
    '/api/sarin/health?scope=engine&', '/api/sarin/health?Scope=engine', '/api/sarin/health?scope=%65ngine',
    '/api/sarin/health?scope=engine#fragment', '/api/admin', '/api/businesses', '/api/sarin/chat',
  ];
  for (const path of paths) assert.equal((await forwardToSingleton(new Request(`https://sarinbotsaas.pages.dev${path}`, { headers: { Authorization: 'Bearer synthetic' } }), get, { SARIN_MAINTENANCE: 'true' })).status, 503, path);
  for (const method of ['HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) assert.equal((await forwardToSingleton(new Request(`https://sarinbotsaas.pages.dev${canonical}`, { method, headers: { Authorization: 'Bearer synthetic' } }), get, { SARIN_MAINTENANCE: 'true' })).status, 503, method);
  for (const authorization of [undefined, '', 'synthetic', 'Basic synthetic', 'Bearer', 'Bearer ', 'Bearer token with spaces', 'Bearer  synthetic', 'Bearer\tsynthetic']) {
    const request = new Request(`https://sarinbotsaas.pages.dev${canonical}`, { headers: authorization === undefined ? {} : { Authorization: authorization } });
    assert.equal((await forwardToSingleton(request, get, { SARIN_MAINTENANCE: 'true' })).status, 503, String(authorization));
  }
  assert.equal(calls, 0);
});
test('maintenance rejects the retired local probe scope before acquiring the singleton', async () => {
  let calls = 0;
  const response = await forwardToSingleton(new Request('https://sarinbotsaas.pages.dev/api/sarin/health?scope=vault', { headers: { Authorization: 'Bearer synthetic' } }), () => {
    calls++;
    return { fetch: async () => Response.json({ status: 'online' }) };
  }, { SARIN_MAINTENANCE: 'true' });
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(calls, 0);
});

test('maintenance exposes only validated queue counters when local engine health is offline', async () => {
  const request = new Request('https://sarinbotsaas.pages.dev/api/sarin/health?scope=engine', { headers: { Authorization: 'Bearer synthetic' } });
  const response = await forwardToSingleton(request, () => ({ fetch: async () => Response.json({
    status: 'offline', online: false, provider: 'ollama', model: 'private-model', error: 'private-error', privateText: 'private-text',
    queue: { activeSlots: 2, queuedRequests: 3, criticalQueued: 1, normalQueued: 2, maxSlots: 4 },
  }, { status: 503, headers: { 'X-Private-Detail': 'private-header' } }) }), { SARIN_MAINTENANCE: 'true' });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'offline', online: false, provider: 'ollama', queue: { activeSlots: 2, queuedRequests: 3, criticalQueued: 1, normalQueued: 2, maxSlots: 4 } });
  assert.equal(response.headers.get('X-Private-Detail'), null);
  for (const header of ['Cache-Control', 'CDN-Cache-Control', 'Cloudflare-CDN-Cache-Control']) assert.equal(response.headers.get(header), 'no-store');
});

test('maintenance keeps malformed offline health responses generic instead of exposing their body', async () => {
  const valid = { activeSlots: 0, queuedRequests: 0, criticalQueued: 0, normalQueued: 0, maxSlots: 4 };
  const payloads = [
    { error: 'private-error' }, { queue: null }, { queue: [] }, { queue: { ...valid, activeSlots: -1 } },
    { queue: { ...valid, queuedRequests: '0' } }, { queue: { ...valid, criticalQueued: 0.5 } },
    { queue: { ...valid, normalQueued: Number.MAX_SAFE_INTEGER + 1 } }, { queue: { ...valid, maxSlots: 0 } },
    { queue: { ...valid, activeSlots: 5 } }, { queue: { ...valid, queuedRequests: 1 } },
    { queue: { activeSlots: 0, queuedRequests: 0, criticalQueued: 0, maxSlots: 4 } },
    { queue: { ...valid, privateText: 'private-error' } },
  ];
  const responses = payloads.map(payload => Response.json({ ...payload, privateText: 'private-error' }, { status: 503 }));
  responses.push(new Response('private-error', { status: 503, headers: { 'Content-Type': 'application/json' } }));
  responses.push(Response.json({ queue: valid, privateText: 'private-error'.repeat(2000) }, { status: 503 }));
  for (const upstream of responses) {
    const request = new Request('https://sarinbotsaas.pages.dev/api/sarin/health?scope=engine', { headers: { Authorization: 'Bearer synthetic' } });
    const response = await forwardToSingleton(request, () => ({ fetch: async () => upstream }), { SARIN_MAINTENANCE: 'true' });
    assert.equal(response.status, 503);
    const result = await response.json();
    assert.deepEqual(Object.keys(result), ['error']);
    assert.equal(JSON.stringify(result).includes('private-error'), false);
  }
});

test('offline health keeps its original status outside maintenance and never rewrites authorization failures', async () => {
  const body = { status: 'offline', online: false, queue: { activeSlots: 0, queuedRequests: 0, criticalQueued: 0, normalQueued: 0, maxSlots: 4 } };
  for (const [maintenance, status] of [['false', 503], ['true', 401], ['true', 403], ['true', 500]]) {
    const upstream = Response.json(body, { status });
    const request = new Request('https://sarinbotsaas.pages.dev/api/sarin/health?scope=engine', { headers: { Authorization: 'Bearer synthetic' } });
    const response = await forwardToSingleton(request, () => ({ fetch: async () => upstream }), { SARIN_MAINTENANCE: maintenance });
    assert.equal(response.status, status);
    assert.equal(response.body, upstream.body);
    assert.deepEqual(await response.json(), body);
  }
});

test('requires the four public build values and never includes Admin credentials', () => {
  const input = { NEXT_PUBLIC_FIREBASE_API_KEY: 'public-client-key', NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: 'configured.firebaseapp.com', NEXT_PUBLIC_FIREBASE_PROJECT_ID: 'configured-project', NEXT_PUBLIC_FIREBASE_APP_ID: '1:123:web:abc', FIREBASE_ADMIN_PRIVATE_KEY: 'excluded' };
  const args = publicBuildArguments(input);
  assert.equal(Object.keys(args).length, 4);
  assert.equal(args.FIREBASE_ADMIN_PRIVATE_KEY, undefined);
  assert.throws(() => publicBuildArguments({}));
  assert.throws(() => publicBuildArguments({ ...input, NEXT_PUBLIC_FIREBASE_PROJECT_ID: 'demo-sarin-bot' }));
});

test('forwards all three optional subscription prices only to server runtime', () => {
  const input = { ...certificateRuntime, WEEKLY_PRICE_COP: '20000', FORTNIGHTLY_PRICE_COP: '35000', MONTHLY_PRICE_COP: '59900' };
  const env = runtimeEnvironment(input);
  assert.equal(env.WEEKLY_PRICE_COP, '20000');
  assert.equal(env.FORTNIGHTLY_PRICE_COP, '35000');
  assert.equal(env.MONTHLY_PRICE_COP, '59900');
});

test('passes explicit cloud AI and WhatsApp runtime settings without public or unrelated secrets', () => {
  const settings = {
    SARIN_CHAT_PROVIDER: 'gemini', DEEPSEEK_MODEL: 'deepseek-flash', DEEPSEEK_API_KEY: 'synthetic-deepseek',
    GEMINI_MODEL: 'gemini-3.5-flash-lite', GEMINI_API_KEY: 'synthetic-paid-key', GEMINI_BILLING_VERIFIED: 'true',
    GEMINI_TEST_MODEL: 'gemini-3.5-flash-lite', GEMINI_TEST_API_KEY: 'synthetic-test-key',
    WHATSAPP_ENABLED: 'false', WHATSAPP_RETENTION_ENABLED: 'false', WHATSAPP_GRAPH_API_VERSION: 'v25.0',
    WHATSAPP_APP_SECRET: 'synthetic-app-secret', WHATSAPP_VERIFY_TOKEN: 'synthetic-verify-token',
    WHATSAPP_CONTENT_KEY: 'synthetic-content-key', WHATSAPP_PHONE_CREDENTIALS_JSON: '{}',
  };
  const env = runtimeEnvironment({ ...certificateRuntime, ...settings, NEXT_PUBLIC_FIREBASE_API_KEY: 'excluded', CLOUDFLARE_API_TOKEN: 'excluded' });
  for (const [key, value] of Object.entries(settings)) assert.equal(env[key], value, key);
  assert.equal(env.NEXT_PUBLIC_FIREBASE_API_KEY, undefined);
  assert.equal(env.CLOUDFLARE_API_TOKEN, undefined);
});

test('supports ADC through the reviewed workload identity settings without a certificate', () => {
  const env = runtimeEnvironment(workloadRuntime);
  assert.equal(env.FIREBASE_ADMIN_CREDENTIAL_MODE, 'adc');
  assert.equal(env.FIREBASE_WIF_AUDIENCE, workloadRuntime.FIREBASE_WIF_AUDIENCE);
  assert.equal(env.FIREBASE_WIF_SERVICE_ACCOUNT_EMAIL, 'sarin-runtime@real-project.iam.gserviceaccount.com');
  assert.equal(env.FIREBASE_ADMIN_PRIVATE_KEY, undefined);
  assert.equal(env.GOOGLE_APPLICATION_CREDENTIALS, undefined);
});

test('rejects mixed credentials, human ADC paths and an unapproved service account', () => {
  for (const overrides of [
    { FIREBASE_ADMIN_CREDENTIAL_MODE: 'human' }, { FIREBASE_ADMIN_PRIVATE_KEY: 'forbidden-certificate' },
    { FIREBASE_ADMIN_CLIENT_EMAIL: 'forbidden@example.test' }, { GOOGLE_APPLICATION_CREDENTIALS: '/private/human-adc.json' },
    { CLOUDSDK_CONFIG: '/private/gcloud' }, { HOME: '/private/home' }, { APPDATA: 'C:/private' },
    { FIREBASE_WIF_SERVICE_ACCOUNT_EMAIL: 'sarin-runtime@other-project.iam.gserviceaccount.com' },
    { FIREBASE_WIF_SERVICE_ACCOUNT_EMAIL: 'other-runtime@real-project.iam.gserviceaccount.com' },
    { FIREBASE_WIF_AUDIENCE: '' }, { FIREBASE_WIF_AUDIENCE: '//iam.googleapis.com/projects/not-a-number/locations/global/workloadIdentityPools/sarin-cloudflare/providers/worker-oidc' },
    { FIREBASE_WIF_AUDIENCE: 'https://evil.invalid/audience' },
  ]) assert.throws(() => runtimeEnvironment({ ...workloadRuntime, ...overrides }), JSON.stringify(Object.keys(overrides)));
});

test('certificate mode requires its pair and rejects workload identity settings', () => {
  assert.equal(runtimeEnvironment(certificateRuntime).FIREBASE_ADMIN_CREDENTIAL_MODE, 'cert');
  assert.throws(() => runtimeEnvironment({ ...certificateRuntime, FIREBASE_ADMIN_PRIVATE_KEY: '' }));
  assert.throws(() => runtimeEnvironment({ ...certificateRuntime, FIREBASE_WIF_AUDIENCE: workloadRuntime.FIREBASE_WIF_AUDIENCE }));
  assert.throws(() => runtimeEnvironment({ ...certificateRuntime, FIREBASE_WIF_SERVICE_ACCOUNT_EMAIL: workloadRuntime.FIREBASE_WIF_SERVICE_ACCOUNT_EMAIL }));
});

test('only permits the private HTTPS engine under alsdevstudio.com', () => {
  for (const origin of ['https://alsdevstudio.com', 'https://ia-sarin.alsdevstudio.com']) {
    assert.equal(runtimeEnvironment({ ...certificateRuntime, SARIN_TUNNEL_URL: `${origin}/v1/chat/completions` }).SARIN_TUNNEL_URL, `${origin}/v1/chat/completions`);
  }
  for (const origin of ['https://engine.example.invalid', 'https://alsdevstudio.com.evil.invalid', 'https://evilalsdevstudio.com', 'http://ia-sarin.alsdevstudio.com', 'https://user:pass@ia-sarin.alsdevstudio.com', 'https://ia-sarin.alsdevstudio.com:8443']) {
    assert.throws(() => runtimeEnvironment({ ...certificateRuntime, SARIN_TUNNEL_URL: `${origin}/v1/chat/completions` }));
  }
});
