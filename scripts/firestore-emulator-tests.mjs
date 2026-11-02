import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

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
const stop = () => { if (!emulator.killed) emulator.kill(); };
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
  const test = spawn(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', 'tests/firestore.rules.test.ts', 'tests/firestore.integration.test.ts', 'tests/waitlist-offers-firestore.test.ts', 'tests/business-team-firestore.test.ts', 'tests/response-quota-recovery-firestore.test.ts'], {
    stdio: 'inherit', windowsHide: true,
    env: { ...process.env, FIRESTORE_EMULATOR_HOST: `${host}:${port}`, FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099', FIREBASE_ADMIN_PROJECT_ID: 'demo-sarin-bot' },
  });
  test.on('error', (error) => { console.error(error.message); stop(); process.exitCode = 1; });
  process.exitCode = await new Promise((resolve) => test.on('exit', (code) => resolve(code ?? 1)));
  if (process.exitCode !== 0) console.error(output.slice(-6000));
} finally { stop(); }
