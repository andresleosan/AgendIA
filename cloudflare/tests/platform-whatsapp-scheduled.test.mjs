import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { fixture, event, set, seed, get } from './platform-whatsapp-fixture.mjs';

// Node supplies only the platform-owned base class. The installed Container SDK,
// router, retention and D1 executor remain real; network calls fail closed.
const platform = 'data:text/javascript,' + encodeURIComponent('export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } } export class WorkerEntrypoint extends DurableObject {}');
const hooks = registerHooks({ resolve(specifier, options, next) {
  if (specifier === 'cloudflare:workers') return { url: platform, shortCircuit: true };
  try { return next(specifier, options); }
  catch (error) { if (specifier.startsWith('.') && options.parentURL?.includes('@cloudflare')) return next(`${specifier}.js`, options); throw error; }
} });
const { default: worker, SarinApp } = await import('../src/index.ts');
hooks.deregister();

test('scheduled awaits cleanup and aggregate log before legacy singleton wake', async context => {
  const env = await fixture(context);
  await seed(env, [set('platformWhatsAppEvents/a', event(0))]);
  const order = [];
  context.mock.method(console, 'info', value => order.push(value));
  context.mock.method(globalThis, 'fetch', async () => assert.fail('No network permitted'));
  env.PLATFORM_WHATSAPP_RETENTION_ENABLED = 'true'; env.WHATSAPP_ENABLED = 'true';
  env.SARIN_APP = { idFromName(name) { assert.equal(name, 'sarin-global-app'); return name; }, get() { return { async startAndWaitForPorts() {
    assert.equal(await get(env, 'platformWhatsAppEvents/a'), undefined); order.push('wake');
  } }; } };
  await worker.scheduled({}, env);
  assert.deepEqual(order, [{ event: 'platform_whatsapp_retention', clearedBodies: 1, deletedMetadata: 1, morePending: false }, 'wake']);
});

test('scheduled uses exact string flags and maintenance, with no platform-only wake or renewal', async context => {
  const env = await fixture(context);
  const logs = []; context.mock.method(console, 'info', value => logs.push(value));
  env.SARIN_APP = new Proxy({}, { get() { assert.fail('Platform flags must not acquire a Container'); } });
  for (const [flag, maintenance, expected] of [['true', undefined, 1], ['true', 'false', 1], ['true', true, 1], ['true', 'true', 0], ['TRUE', undefined, 0], [true, undefined, 0], [' true ', undefined, 0], ['false', undefined, 0], [undefined, undefined, 0]]) {
    logs.length = 0;
    await worker.scheduled({}, { ...env, PLATFORM_WHATSAPP_RETENTION_ENABLED: flag, SARIN_MAINTENANCE: maintenance });
    assert.equal(logs.length, expected);
    if (expected) assert.deepEqual(logs[0], { event: 'platform_whatsapp_retention', clearedBodies: 0, deletedMetadata: 0, morePending: false });
  }
  let stopped = 0;
  await SarinApp.prototype.onActivityExpired.call({ env: {}, envVars: { PLATFORM_WHATSAPP_RETENTION_ENABLED: 'true' }, ctx: { container: { running: true } }, stop: async () => { stopped++; }, renewActivityTimeout() { assert.fail('Platform retention must not renew activity'); } });
  assert.equal(stopped, 1);
});

test('scheduled propagates an invocation error before log or wake and captures flags before cleanup', async context => {
  const env = await fixture(context);
  const logs = []; context.mock.method(console, 'info', value => logs.push(value));
  let wake = 0;
  env.SARIN_APP = { idFromName: name => name, get: () => ({ startAndWaitForPorts: async () => { wake++; } }) };
  env.PLATFORM_WHATSAPP_RETENTION_ENABLED = 'true'; env.WHATSAPP_ENABLED = 'true';
  const database = env.SARIN_DB;
  env.SARIN_DB = { prepare: database.prepare.bind(database), batch: async statements => { env.WHATSAPP_ENABLED = 'false'; return database.batch(statements); } };
  await worker.scheduled({}, env);
  assert.equal(wake, 1); assert.equal(logs.length, 1);
  logs.length = 0; wake = 0;
  context.mock.method(Date, 'now', () => -1);
  await assert.rejects(worker.scheduled({}, { ...env, WHATSAPP_ENABLED: 'true' }), { message: 'Invalid retention options' });
  assert.equal(logs.length, 0); assert.equal(wake, 0);
});
