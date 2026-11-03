import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { configureBuild } from '../scripts/configure-build.mjs';
import { runtimeEnvironment } from '../src/router.ts';

test('audio AI binding stays Worker-only while A5 forwards the optional own provider key to Node', () => {
  const result = runtimeEnvironment({ FIREBASE_ADMIN_PROJECT_ID: 'synthetic-project', FIREBASE_ADMIN_CLIENT_EMAIL: 'synthetic@example.test', FIREBASE_ADMIN_PRIVATE_KEY: 'synthetic', SUPERADMIN_UID: 'synthetic', SARIN_TUNNEL_URL: 'https://engine.alsdevstudio.com/v1/chat/completions', OLLAMA_MAIN_MODEL: 'synthetic', CF_ACCESS_CLIENT_ID: 'synthetic', CF_ACCESS_CLIENT_SECRET: 'synthetic', AI: { run() {} }, PLATFORM_YCLOUD_API_KEY: 'synthetic-media-key' });
  assert.equal(result.AI, undefined);
  assert.equal(result.PLATFORM_YCLOUD_API_KEY, 'synthetic-media-key');
  assert.equal(result.PLATFORM_WHATSAPP_AUDIO_ENABLED, undefined);
});
test('backup defaults remain off, no active backup bindings and export token stays Worker-only',()=>{
  const config=JSON.parse(readFileSync(new URL('../wrangler.jsonc',import.meta.url),'utf8'));
  assert.equal(config.d1_databases.some(b=>b.binding==='SARIN_RECOVERY_DB'),false);
  assert.equal(config.r2_buckets.some(b=>b.binding==='SARIN_BACKUPS'),false);
  const runtime=runtimeEnvironment({ FIREBASE_ADMIN_PROJECT_ID:'synthetic-project',FIREBASE_ADMIN_CLIENT_EMAIL:'synthetic@example.test',FIREBASE_ADMIN_PRIVATE_KEY:'synthetic',SUPERADMIN_UID:'synthetic',SARIN_TUNNEL_URL:'https://engine.alsdevstudio.com/v1/chat/completions',OLLAMA_MAIN_MODEL:'synthetic',CF_ACCESS_CLIENT_ID:'synthetic',CF_ACCESS_CLIENT_SECRET:'synthetic',SARIN_BACKUP_EXPORT_TOKEN:'do-not-forward',SARIN_BACKUP_CLEANUP_ENABLED:'true'});
  assert.equal(runtime.SARIN_BACKUP_ENABLED,'false');assert.equal(runtime.SARIN_BACKUP_EXPORT_TOKEN,undefined);assert.equal(runtime.SARIN_BACKUP_CLEANUP_ENABLED,undefined);
});

test('configuration has one default container and no public route, logs, traces or beta scheduling', () => {
  const config = JSON.parse(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
  assert.equal(config.containers.length, 1);
  assert.equal(config.containers[0].scheduling_policy, 'default');
  assert.equal(config.containers[0].max_instances, 1);
  assert.equal(config.containers[0].instance_type, 'basic');
  assert.equal(config.workers_dev, false);
  assert.equal(config.preview_urls, false);
  assert.equal(config.routes, undefined);
  assert.deepEqual(config.ai, { binding: 'AI' });
  assert.equal(config.vars?.PLATFORM_WHATSAPP_AUDIO_ENABLED, undefined);
  assert.equal(config.vars?.PLATFORM_YCLOUD_API_KEY, undefined);
  assert.equal(config.vars?.PLATFORM_WHATSAPP_AUDIO_DAILY_BUDGET_MICROS, undefined);
  assert.equal(config.observability.logs.enabled, false);
  assert.equal(config.observability.traces.enabled, false);
  assert.equal(config.containers[0].observability.enabled, false);
  assert.deepEqual(config.triggers.crons, ['*/5 * * * *']);
  assert.deepEqual(config.durable_objects.bindings.map(binding => [binding.name, binding.class_name]), [['SARIN_APP', 'SarinApp'], ['SARIN_IDENTITY', 'SarinIdentity']]);
  assert.deepEqual(config.exports.SarinIdentity, { type: 'durable-object', storage: 'sqlite' });
});

test('build preparation writes only public build args to an isolated destination', () => {
  const directory = mkdtempSync(join(tmpdir(), 'sarin-cloudflare-config-'));
  try {
    const destination = join(directory, 'wrangler.build.json');
    configureBuild({ NEXT_PUBLIC_FIREBASE_API_KEY: 'public-key', NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: 'project.firebaseapp.com', NEXT_PUBLIC_FIREBASE_PROJECT_ID: 'project-production', NEXT_PUBLIC_FIREBASE_APP_ID: '1:123:web:abc', FIREBASE_ADMIN_PRIVATE_KEY: 'do-not-write', CLOUDFLARE_API_TOKEN: 'do-not-write', PLATFORM_WHATSAPP_LINK_HMAC_KEY: 'do-not-write' }, destination);
    const output = readFileSync(destination, 'utf8');
    const config = JSON.parse(output);
    assert.equal(Object.keys(config.containers[0].image_vars).length, 4);
    assert.equal(output.includes('do-not-write'), false);
    assert.equal(config.containers[0].image_build_context, '..');
  } finally {
    if (dirname(resolve(directory)) === resolve(tmpdir()) && basename(directory).startsWith('sarin-cloudflare-config-')) rmSync(directory, { recursive: true, force: true });
  }
});

test('launch uses workload identity and leaves background WhatsApp services disabled', () => {
  const config = JSON.parse(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
  assert.equal(config.vars?.FIREBASE_ADMIN_CREDENTIAL_MODE, 'adc');
  assert.equal(config.vars?.FIREBASE_ADMIN_PROJECT_ID, 'sarinbotsaas');
  assert.equal(config.vars?.FIREBASE_WIF_AUDIENCE, '//iam.googleapis.com/projects/153690559048/locations/global/workloadIdentityPools/sarin-cloudflare/providers/worker-oidc');
  assert.equal(config.vars?.FIREBASE_WIF_SERVICE_ACCOUNT_EMAIL, 'sarin-runtime@sarinbotsaas.iam.gserviceaccount.com');
  assert.equal(config.vars?.WHATSAPP_ENABLED, 'false');
  assert.equal(config.vars?.WHATSAPP_RETENTION_ENABLED, 'false');
  assert.equal(config.vars?.FIREBASE_ADMIN_PRIVATE_KEY, undefined);
  assert.equal(config.vars?.GOOGLE_APPLICATION_CREDENTIALS, undefined);
  assert.equal(config.vars?.PLATFORM_WHATSAPP_LINK_HMAC_KEY, undefined);
  assert.equal(config.vars?.SARIN_DATA_BACKEND, 'd1');
  assert.equal(config.vars?.SARIN_MAINTENANCE, 'false');
  assert.equal(config.vars?.PILOT_AI_BUDGET_ENFORCED, 'true');
  assert.equal(config.d1_databases?.[0].binding, 'SARIN_DB');
  assert.equal(config.r2_buckets?.[0].binding, 'SARIN_FILES');
});
