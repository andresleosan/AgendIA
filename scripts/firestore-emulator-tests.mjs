import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createConnection } from 'node:net';
import { pnpmFirebaseInvocation } from './lib/local-development.mjs';

// Official Firebase emulator, pinned to the SHA-256 in firebase-tools 15.33.0.
// Keep deployment tooling out of the application dependency tree.
const version = '1.22.0';
const checksum = '9b6498b7f62714d67f48f59b3818883cd682dbcd46b9f59511de81c97bb5166c';
const cache = path.join(homedir(), '.cache', 'sarin-emulators');
const jar = path.join(cache, `cloud-firestore-emulator-v${version}.jar`);
await mkdir(cache, { recursive: true });
let bytes;
try { bytes = await readFile(jar); } catch { /* Download once from the official distribution. */ }
if (!bytes || createHash('sha256').update(bytes).digest('hex') !== checksum) {
  console.log('Downloading official Firestore emulator…');
  const response = await fetch(`https://storage.googleapis.com/firebase-preview-drop/emulator/cloud-firestore-emulator-v${version}.jar`);
  if (!response.ok) throw new Error('Could not download Firestore emulator.');
  bytes = Buffer.from(await response.arrayBuffer());
  if (createHash('sha256').update(bytes).digest('hex') !== checksum) throw new Error('Firestore emulator checksum mismatch.');
  await writeFile(jar, bytes);
}
const host = '127.0.0.1'; const port = '8188';
const java = process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java') : 'java';
// Emulator 1.22.0 omits validation resource bundles for es_US; use its bundled locale.
const emulator = spawn(java, ['-Duser.language=en', '-Duser.country=US', '-jar', jar, '--host', host, '--port', port, '--project_id', 'demo-sarin-bot', '--rules', 'firestore.rules'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
let bootError;
emulator.on('error', (error) => { bootError = error; });
let output = '';
for (const stream of [emulator.stdout, emulator.stderr]) stream.on('data', (chunk) => { output = (output + chunk.toString()).slice(-10000); });
let authEmulator, authDirectory, authStopped;
const stop = () => {
  if (!emulator.killed) emulator.kill();
  if (authEmulator?.pid && authEmulator.exitCode === null) {
    if (process.platform === 'win32') authStopped ??= new Promise(resolve => {
      const killer = spawn('taskkill.exe', ['/PID', String(authEmulator.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      killer.on('error', resolve); killer.on('exit', resolve);
    });
    else { try { process.kill(-authEmulator.pid, 'SIGTERM'); } catch { /* Already stopped. */ } }
  }
  return authStopped;
};
process.on('SIGINT', () => { stop(); process.exit(130); });
process.on('SIGTERM', () => { stop(); process.exit(143); });
try {
  let ready = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    if (bootError || emulator.exitCode !== null) throw new Error(`Firestore emulator requires Java 21+. ${bootError?.message ?? output}`);
    try { const response = await fetch(`http://${host}:${port}/`); if (response.ok) { ready = true; break; } } catch { /* Booting. */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!ready) throw new Error(`Firestore emulator did not start. ${output}`);
  const authPort = 9198;
  const occupied = await new Promise(resolve => { const socket = createConnection({ host, port: authPort }); socket.once('connect', () => { socket.destroy(); resolve(true); }); socket.once('error', () => { socket.destroy(); resolve(false); }); });
  if (occupied) throw new Error('Recovery Auth emulator port 9198 is occupied; refusing to reuse another session.');
  authDirectory = await mkdtemp(path.join(tmpdir(), 'sarin-rules-auth-'));
  const config = path.join(authDirectory, 'firebase.json');
  await writeFile(config, JSON.stringify({ emulators: { auth: { host, port: authPort }, hub: { host, port: 4498 }, logging: { host, port: 4598 }, ui: { enabled: false }, singleProjectMode: false } }));
  const invocation = pnpmFirebaseInvocation(process.env, fileURLToPath(new URL('../', import.meta.url)), process.execPath);
  const args = [...invocation.args]; args[args.indexOf('--only') + 1] = 'auth'; args[args.indexOf('--config') + 1] = config; args[args.indexOf('--project') + 1] = 'demo-sarin-recovery-auth';
  authEmulator = spawn(invocation.command, args, { cwd: authDirectory, env: { ...process.env, CI: 'true', FIREBASE_CLI_DISABLE_UPDATE_CHECK: 'true' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
  let authError, authOutput = '';
  authEmulator.on('error', error => { authError = error; });
  for (const stream of [authEmulator.stdout, authEmulator.stderr]) stream.on('data', chunk => { authOutput = (authOutput + chunk.toString()).slice(-4000); });
  let authReady = false;
  for (let attempt = 0; attempt < 240; attempt++) {
    if (authError || authEmulator.exitCode !== null) throw new Error(`Recovery Auth emulator did not start: ${authOutput}`);
    try { const reply = await fetch(`http://${host}:${authPort}/`, { signal: AbortSignal.timeout(1000) }); if (reply.ok) { authReady = true; break; } } catch { /* Booting. */ }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  if (!authReady) throw new Error('Recovery Auth emulator startup timeout.');
  const test = spawn(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', 'tests/firestore.rules.test.ts', 'tests/firestore.integration.test.ts', 'tests/waitlist-offers-firestore.test.ts', 'tests/business-team-firestore.test.ts', 'tests/response-quota-recovery-firestore.test.ts', 'tests/client-appointments-pagination-firestore.test.ts', 'tests/recovery-auth-emulator.test.ts'], {
    stdio: 'inherit', windowsHide: true,
    env: { ...process.env, FIRESTORE_EMULATOR_HOST: `${host}:${port}`, FIREBASE_AUTH_EMULATOR_HOST: `${host}:${authPort}`, FIREBASE_ADMIN_PROJECT_ID: 'demo-sarin-bot', SARIN_RECOVERY_AUTH_TEST: 'true' },
  });
  test.on('error', (error) => { console.error(error.message); stop(); process.exitCode = 1; });
  process.exitCode = await new Promise((resolve) => test.on('exit', (code) => resolve(code ?? 1)));
  if (process.exitCode !== 0) console.error(output.slice(-6000));
} finally {
  await stop();
  if (authDirectory && path.dirname(path.resolve(authDirectory)) === path.resolve(tmpdir()) && path.basename(authDirectory).startsWith('sarin-rules-auth-')) await rm(authDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
