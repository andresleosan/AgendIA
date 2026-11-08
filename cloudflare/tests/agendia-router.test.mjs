import assert from 'node:assert/strict';
import test from 'node:test';
import { handleUiRequest } from '../src/agendia-router.ts';

test('UI worker never starts a container for API, admin or noncanonical traffic', async () => {
  let starts = 0;
  const get = () => { starts++; return { fetch: async () => new Response('unexpected') }; };
  for (const url of ['https://agendia-app.pages.dev/api/session', 'https://agendia-app.pages.dev/api/admin', 'https://agendia-app.pages.dev/admin', 'https://agendia-app.pages.dev/%61pi/session', 'https://agendia-app.pages.dev/.well-known/jwks.json', 'https://preview.pages.dev/dashboard']) {
    assert.equal((await handleUiRequest(new Request(url), get)).status, 404);
  }
  assert.equal(starts, 0);
});

test('UI worker fixes the singleton and strips port/header bypasses', async () => {
  let name, upstream;
  const response = await handleUiRequest(new Request('https://agendia-app.pages.dev/b/demo-shop', { headers: { 'CF-Container-Target-Port': '9229', 'X-Middleware-Subrequest': 'proxy', 'X-Forwarded-Host': 'evil.invalid' } }), actual => {
    name = actual;
    return { async fetch(request) { upstream = request; return new Response('business interface'); } };
  });
  assert.equal(name, 'agendia-ui');
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'business interface');
  assert.equal(upstream.headers.get('cf-container-target-port'), null);
  assert.equal(upstream.headers.get('x-middleware-subrequest'), null);
  assert.equal(upstream.headers.get('x-forwarded-host'), 'agendia-app.pages.dev');
});
