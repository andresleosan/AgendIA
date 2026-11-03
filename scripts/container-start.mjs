import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { prepareCloudflareEnvironment } from './lib/cloudflare-credentials.mjs';

// No child process: the single Node PID owns the Next server and inference queue.
export async function startContainer() {
  if (process.env.SARIN_BACKUP_ENABLED === 'true' && process.env.SARIN_MAINTENANCE !== 'true') {
    const { verifyAgeBinary } = await import('./scripts/lib/recovery-age.mjs');
    await verifyAgeBinary('/usr/local/bin/age');
  }
  const environment = await prepareCloudflareEnvironment(process.env);
  Object.assign(process.env, environment);
  await import(pathToFileURL(resolve('server.js')).href);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await startContainer(); }
  catch {
    // Authentication libraries may include token responses or private paths in errors.
    process.stderr.write('No se pudo iniciar el servidor de Sarin. Revisa la configuración del runtime.\n');
    process.exitCode = 1;
  }
}
