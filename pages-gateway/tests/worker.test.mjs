import assert from 'node:assert/strict';
import test from 'node:test';
import { handleRequest } from '../worker.mjs';

const origin = 'https://agendia-app.pages.dev';
const request = (path, init = {}) => new Request(origin + path, init);
function environment(api = async () => new Response('api'), ui = async () => new Response('ui')) {
  return { AGENDIA_PUBLIC_ORIGIN: origin, SARIN_API: { fetch: api }, AGENDIA_WEB: { fetch: ui } };
}
const forbidden = () => { throw new Error('A rejected request reached a backend'); };

test('commercial API and dynamic UI reach their independent services', async () => {
  const env = environment();
  for (const path of ['/api/session', '/api/businesses/qr-kit?application=agendia', '/api/public/businesses/demo-shop', '/api/businesses/b_demo/appointments']) {
    const response = await handleRequest(request(path), env);
    assert.equal(response.status, 200, path);
    assert.equal(await response.text(), 'api', path);
  }
  for (const path of ['/', '/dashboard', '/b/demo-shop', '/team/b_demo', '/_next/static/chunks/demo.js']) {
    assert.equal(await (await handleRequest(request(path), env)).text(), 'ui', path);
  }
});

test('rejects admin, internal, webhook, issuer and normalized bypass paths before any service call', async () => {
  const env = environment(forbidden, forbidden);
  for (const path of ['/admin', '/admin/assistant', '/api/admin', '/api/admin/ai', '/api/internal/recovery-backup', '/api/whatsapp/webhook', '/api/whatsapp/ycloud/platform/webhook', '/.well-known/jwks.json', '/.well-known/openid-configuration', '/Admin', '/API/admin', '/%61pi/admin', '/api%2fadmin', '/api/%2561dmin', '/api/businesses/../admin', '/dashboard/../admin', '/api//admin', '/_next/data/build/admin.json', '/api/sarin/health?scope=engine', '/api/businesses/b_demo/unknown']) {
    assert.equal((await handleRequest(request(path), env)).status, 404, path);
  }
});

test('matches allowed API methods and rejects browser origin changes', async () => {
  assert.equal((await handleRequest(request('/api/sarin/chat', { method: 'POST', headers: { Origin: origin }, body: '{}' }), environment())).status, 200);
  for (const originValue of ['https://sarinbotsaas.pages.dev', 'https://evil.invalid', 'null', `${origin}/`]) {
    assert.equal((await handleRequest(request('/api/businesses', { method: 'POST', headers: { Origin: originValue }, body: '{}' }), environment(forbidden, forbidden))).status, 403);
  }
  for (const [path, method] of [['/api/session', 'POST'], ['/api/sarin/chat', 'GET'], ['/dashboard', 'POST']]) {
    assert.equal((await handleRequest(request(path, { method }), environment(forbidden, forbidden))).status, 404);
  }
});

test('preserves authentication and the real origin while replacing spoofed routing headers', async () => {
  let received;
  const response = await handleRequest(request('/api/businesses', { method: 'POST', body: '{"name":"demo"}', headers: {
    Origin: origin, Authorization: 'Bearer synthetic', Host: 'evil.invalid', 'X-Forwarded-Host': 'evil.invalid', 'X-Forwarded-Proto': 'http',
    'CF-Container-Target-Port': '9229', 'X-Middleware-Subrequest': 'proxy', 'CF-Access-Client-Secret': 'synthetic-secret', 'X-Sarin-Surface': 'admin',
  } }), environment(async upstream => { received = upstream; return new Response(await upstream.text()); }));
  assert.equal(response.status, 200);
  assert.equal(received.url, `${origin}/api/businesses`);
  assert.equal(received.headers.get('authorization'), 'Bearer synthetic');
  assert.equal(received.headers.get('origin'), origin);
  assert.equal(received.headers.get('host'), 'agendia-app.pages.dev');
  assert.equal(received.headers.get('x-forwarded-host'), 'agendia-app.pages.dev');
  assert.equal(received.headers.get('x-forwarded-proto'), 'https');
  for (const name of ['cf-container-target-port', 'x-middleware-subrequest', 'cf-access-client-secret', 'x-sarin-surface']) assert.equal(received.headers.get(name), null);
  assert.equal(await response.text(), '{"name":"demo"}');
});

test('requires both bindings and the exact public origin, including on previews', async () => {
  for (const env of [{}, { ...environment(), SARIN_API: undefined }, { ...environment(), AGENDIA_WEB: undefined }, { ...environment(), AGENDIA_PUBLIC_ORIGIN: 'https://preview.pages.dev' }, { ...environment(), SARIN_APP_HOST: {} }]) {
    assert.equal((await handleRequest(request('/'), env)).status, 503);
  }
  for (const host of ['preview.agendia-app.pages.dev', 'agendia.pages.dev', 'agendia-l75.pages.dev']) {
    assert.equal((await handleRequest(new Request('https://' + host + '/dashboard'), environment(forbidden, forbidden))).status, 404);
  }
});

test('never retries mutations and sanitizes failed upstream responses', async () => {
  let calls = 0;
  const response = await handleRequest(request('/api/businesses', { method: 'POST', body: '{}' }), environment(async () => { calls++; throw new Error('private details'); }));
  assert.equal(calls, 1);
  assert.equal(response.status, 503);
  assert.doesNotMatch(await response.text(), /private details/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('only permits redirects within the UI allowlist and removes credential response headers', async () => {
  for (const location of ['https://evil.invalid', '/admin', '/api/session', '/%61dmin']) {
    assert.equal((await handleRequest(request('/'), environment(undefined, async () => new Response(null, { status: 302, headers: { Location: location } })))).status, 503, location);
  }
  const response = await handleRequest(request('/'), environment(undefined, async () => new Response(null, { status: 307, headers: { Location: '/dashboard', Authorization: 'Bearer private', 'CF-Access-Client-Secret': 'private', 'Access-Control-Allow-Origin': '*' } })));
  assert.equal(response.status, 307);
  assert.equal(response.headers.get('location'), `${origin}/dashboard`);
  for (const name of ['authorization', 'cf-access-client-secret', 'access-control-allow-origin']) assert.equal(response.headers.get(name), null);
});

test('forwards abort signals and streams without buffering', async () => {
  const controller = new AbortController();
  let upstreamSignal;
  const stream = new ReadableStream({ start(target) { target.enqueue(new TextEncoder().encode('first')); } });
  const response = await handleRequest(request('/api/session', { signal: controller.signal }), environment(async upstream => { upstreamSignal = upstream.signal; return new Response(stream); }));
  const reader = response.body.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), 'first');
  controller.abort();
  assert.equal(upstreamSignal.aborted, true);
  await reader.cancel();
});

test('serves the PWA manifest and optimizes local brand images without becoming a backend fetch proxy', async () => {
  for (const path of ['/manifest.webmanifest', '/_next/image?url=%2Fbrand%2Fsarin-face-mark.png&w=64&q=75']) {
    assert.equal(await (await handleRequest(request(path), environment())).text(), 'ui', path);
  }
  for (const source of ['https://evil.invalid/image.png', '/api/admin', '/api/public/businesses/demo-shop/logo/abc', '/brand/../api/session', '/brand/%2e%2e/api/session']) {
    assert.equal((await handleRequest(request('/_next/image?url=' + encodeURIComponent(source) + '&w=64&q=75'), environment(forbidden, forbidden))).status, 404, source);
  }
});

test('accepts encoded Next chunk filenames but not encoded route or traversal components', async () => {
  for (const path of ['/_next/static/chunks/%5Bturbopack%5D_browser_dev_hmr-client.js', '/_next/static/chunks/0zix_%40swc_helpers_cjs_demo.js']) {
    assert.equal(await (await handleRequest(request(path), environment())).text(), 'ui');
  }
  for (const path of ['/_next/static/%252e%252e/api/admin.js', '/_next/static/a%2f..%2f..%2fapi/admin.js', '/_next%2fstatic/demo.js']) {
    assert.equal((await handleRequest(request(path), environment(forbidden, forbidden))).status, 404);
  }
});
