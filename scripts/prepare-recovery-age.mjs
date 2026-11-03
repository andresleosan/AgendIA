import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, readFile, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

// Build-time only: runtime never downloads an executable or holds an identity.
const lock = JSON.parse(await readFile(new URL('./lib/recovery-age.lock.json', import.meta.url), 'utf8'));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const pin = lock.platforms[`${process.platform}-${process.arch}`];
if (process.platform !== 'linux' || !pin || process.argv[2] !== '--directory' || !process.argv[3]) throw Error('AGE_PREPARE_PLATFORM_OR_ARGUMENTS');
const target = resolve(process.argv[3]), staging = await mkdtemp(join(tmpdir(), 'sarin-age-build-'));
try {
  async function download(name, hash) {
    const response = await fetch(`https://github.com/FiloSottile/age/releases/download/${lock.version}/${name}`, { signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw Error('AGE_PREPARE_DOWNLOAD');
    const parts = []; let total = 0;
    for await (const chunk of response.body) { total += chunk.length; if (total > 100 * 1024 * 1024) throw Error('AGE_PREPARE_SIZE'); parts.push(chunk); }
    const bytes = Buffer.concat(parts);
    if (digest(bytes) !== hash) throw Error('AGE_PREPARE_CHECKSUM');
    await writeFile(join(staging, name), bytes, { flag: 'wx', mode: 0o600 }); return bytes;
  }
  const archive = await download(pin.archive, pin.archiveSha256);
  await download(pin.archive + '.proof', pin.proofSha256);
  await writeFile(join(staging, 'keys.pub'), lock.verification.keys.join('\n') + '\n');
  execFileSync('/usr/local/bin/sigsum-verify', ['-k', join(staging, 'keys.pub'), '-P', lock.verification.policy, join(staging, pin.archive + '.proof')], { input: archive, stdio: ['pipe', 'pipe', 'pipe'] });
  execFileSync('tar', ['-xzf', join(staging, pin.archive), '-C', staging], { stdio: 'pipe' });
  for (const [name, hash] of [['age', pin.binarySha256], ['age-keygen', pin.keygenSha256]]) {
    const file = join(staging, 'age', name);
    if (digest(await readFile(file)) !== hash) throw Error('AGE_PREPARE_BINARY');
    await copyFile(file, join(target, name)); await chmod(join(target, name), 0o755);
  }
  console.log(JSON.stringify({ version: lock.version, archiveVerified: true, proofVerified: true, binariesVerified: true }));
} finally {
  if (dirname(staging) !== resolve(tmpdir())) throw Error('AGE_PREPARE_CLEANUP');
  await rm(staging, { recursive: true, force: true });
}
