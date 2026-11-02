import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

test('a quota recovery error is sanitized and does not block unrelated maintenance or wakeup', async () => {
  const require = createRequire(import.meta.url), { build } = createRequire(require.resolve('wrangler/package.json'))('esbuild');
  const result = await build({ entryPoints: [fileURLToPath(new URL('../src/index.ts', import.meta.url))], bundle: true, write: false, format: 'esm', platform: 'node', plugins: [{ name: 'scheduled-dependencies', setup(build) {
    build.onResolve({ filter: /^(\.\/|@cloudflare\/containers)/ }, args => args.importer.endsWith('index.ts') ? { path: args.path, namespace: 'scheduled-test' } : undefined);
    build.onLoad({ filter: /.*/, namespace: 'scheduled-test' }, args => {
      const sources = {
        '@cloudflare/containers': 'export class Container {}; export class ContainerProxy {}; export const getContainer=()=>({startAndWaitForPorts:async()=>globalThis.calls.push("wake")});',
        './response-quota-recovery.ts': 'export const recoverWorkerResponseQuota=async()=>{throw Error("private body must not log")};',
        './admin-payment-retention.ts': 'export const cleanupAdminPaymentRetention=async()=>{globalThis.calls.push("payment");return {}};',
        './platform-support-retention.ts': 'export const cleanupPlatformSupportRetention=async()=>{globalThis.calls.push("support");return {}};',
        './platform-whatsapp-wake.ts': 'export const hasPotentialPlatformWork=async()=>true;',
        './router.ts': 'export const backgroundWorkEnabled=()=>false; export const forwardToSingleton=()=>{}; export const runtimeEnvironment=()=>{}; export const wakeBackgroundSingleton=()=>{}; export const SINGLETON_NAME="main";',
        './platform-whatsapp-audio.ts': 'export const handlePlatformAudioOutbound=()=>{};',
        './identity.ts': 'export class SarinIdentity {}; export const handleIdentityOutbound=()=>{}; export const handlePublicIdentityRequest=()=>{};',
        './data.ts': 'export const handleDataOutbound=()=>{};',
        './platform-whatsapp-retention.ts': 'export const cleanupPlatformWhatsAppRetention=async()=>({});',
      }; if (!sources[args.path]) throw Error(`Unhandled scheduled dependency ${args.path}`); return { contents: sources[args.path], loader: 'js' };
    });
  } }] });
  const logs = [], oldError = console.error; globalThis.calls = [];
  console.error = value => logs.push(value);
  try {
    const worker = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
    await worker.default.scheduled({}, { SARIN_MAINTENANCE: 'false' });
    assert.deepEqual(globalThis.calls, ['payment', 'support', 'wake']);
    assert.deepEqual(logs, [{ event: 'response_quota_recovery_failed' }]);
  } finally { console.error = oldError; delete globalThis.calls; }
});
