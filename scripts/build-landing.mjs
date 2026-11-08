import { copyFile, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
// Copy only the approved brand assets, never environment files or SaaS output.
await mkdir(resolve(root, 'landing/public/brand'), { recursive: true });
for (const file of ['sarin-welcome.png', 'sarin-flight.png', 'sarin-face-mark.png', 'agendia-icon.svg', 'agendia-192.png', 'agendia-512.png']) {
  await copyFile(resolve(root, 'public/brand', file), resolve(root, 'landing/public/brand', file));
}

const child = spawn(process.execPath, [resolve(root, 'node_modules/next/dist/bin/next'), 'build', 'landing'], {
  cwd: root, stdio: 'inherit', env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' },
});
child.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
child.on('exit', (code) => { process.exitCode = code ?? 1; });
