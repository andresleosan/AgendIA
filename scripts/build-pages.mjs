import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { packagePagesGateway } from './package-pages-gateway.mjs';

// Explicit alternate artifact: Pages gateway + static fallback. Building this
// never changes the existing Pages project, DNS, VPS, or runtime secrets.
const root = fileURLToPath(new URL('../', import.meta.url));
const env = { ...process.env, NEXT_TELEMETRY_DISABLED: '1', SARIN_PUBLIC_APP_URL: 'https://agendia-app.pages.dev' };
async function run(script) {
  const child = spawn(process.execPath, [script], { cwd: root, env, stdio: 'inherit', windowsHide: true });
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  if (code !== 0) throw new Error(`La preparación de Pages falló en ${script}.`);
}

try {
  await run('scripts/build-landing.mjs');
  await run('scripts/verify-landing.mjs');
  await packagePagesGateway({ enabled: true });
  console.log('Artefacto Pages preparado con gateway y fallback estático. No se ha publicado ni validado el backend real.');
} catch (error) {
  console.error(error instanceof Error ? error.message : 'No se pudo preparar el artefacto Pages.');
  process.exitCode = 1;
}
