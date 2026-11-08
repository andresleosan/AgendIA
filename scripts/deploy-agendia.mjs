import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdtemp, mkdir, rm, cp } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { publicBuildArguments, validateDeploymentConfigs, classifyCommandFailure } from './agendia-deployment.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const wrangler = join(root, 'cloudflare/node_modules/wrangler/bin/wrangler.js');
const scratch = join(root, 'cloudflare/.wrangler');
const argumentsList = process.argv.slice(2);
let temporary;
let stage = 'VALIDATE';
const progress = next => { stage = next; console.log('AgendIA: ' + next); };
const commandEnv = Object.fromEntries(['PATH', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH', 'SYSTEMROOT', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
Object.assign(commandEnv, { CI: 'true', NO_COLOR: '1', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', WRANGLER_SEND_METRICS: 'false', WRANGLER_WRITE_LOGS: 'false' });

function command(binary, args, timeout = 120000, cwd = root) {
  return new Promise((accept, reject) => {
    const child = spawn(binary, args, { cwd, env: commandEnv, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', diagnostics = '', size = 0, ended = false;
    const timer = setTimeout(() => { child.kill(); finish(new Error('COMMAND_TIMEOUT')); }, timeout);
    function finish(error) { if (ended) return; ended = true; clearTimeout(timer); error ? reject(error) : accept(output.trim()); }
    child.stdout.on('data', chunk => { size += chunk.length; if (size > 16000000) { child.kill(); finish(new Error('COMMAND_OUTPUT_LIMIT')); } else output += chunk; });
    child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-65536); });
    child.on('error', () => finish(new Error('COMMAND_START_FAILED')));
    child.on('close', code => finish(code === 0 ? undefined : new Error(classifyCommandFailure(output + diagnostics))));
  });
}

async function verifySource(sha) {
  if (await command('git', ['rev-parse', 'HEAD']) !== sha || await command('git', ['branch', '--show-current']) !== 'main'
    || await command('git', ['status', '--porcelain', '--untracked-files=normal'])) throw new Error('CLEAN_MAIN_REQUIRED');
  if ((await command('git', ['ls-remote', 'origin', 'refs/heads/main'])).split(/\s+/)[0] !== sha) throw new Error('PUBLISHED_MAIN_REQUIRED');
}

async function main() {
  if (argumentsList.some(value => value !== '--deploy')) throw new Error('USE_DEPLOY_FLAG_ONLY');
  const worker = JSON.parse(await readFile(join(root, 'cloudflare/wrangler.jsonc'), 'utf8'));
  const pages = JSON.parse(await readFile(join(root, 'wrangler.jsonc'), 'utf8'));
  validateDeploymentConfigs(worker, pages);
  if (!argumentsList.includes('--deploy')) {
    console.log(JSON.stringify({ worker: 'agendia-web', pages: 'agendia-app', apiService: 'sarin-bot-app', effect: 'UI Worker/Container and AgendIA Pages only; no central Worker, data or secrets are changed', deploy: false }));
    return;
  }
  if (!/^[a-f0-9]{32}$/.test(process.env.CLOUDFLARE_ACCOUNT_ID ?? '')) throw new Error('CLOUDFLARE_ACCOUNT_REQUIRED');
  const imageArguments = publicBuildArguments(process.env);
  const sha = await command('git', ['rev-parse', 'HEAD']);
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('CLEAN_MAIN_REQUIRED');
  const origin = await command('git', ['remote', 'get-url', 'origin']);
  if (!/^(?:https:\/\/github\.com\/|git@github\.com:)andresleosan\/AgendIA(?:\.git)?$/.test(origin)) throw new Error('AGENDIA_REPOSITORY_REQUIRED');
  await verifySource(sha);
  if (process.env.GITHUB_SHA && process.env.GITHUB_SHA !== sha) throw new Error('SOURCE_SHA_CHANGED');
  const artifact = join(root, 'landing/out');
  if (!(await readFile(join(artifact, '_worker.js'))).equals(await readFile(join(root, 'pages-gateway/worker.mjs')))
    || JSON.stringify(JSON.parse(await readFile(join(artifact, '_routes.json'), 'utf8'))) !== JSON.stringify({ version: 1, include: ['/*'], exclude: [] })) throw new Error('PAGES_ARTIFACT_REQUIRED');
  await mkdir(scratch, { recursive: true });
  temporary = await mkdtemp(join(scratch, 'agendia-release-'));
  const source = join(temporary, 'source');
  await mkdir(source);
  const archive = join(temporary, 'source.tar');
  await command('git', ['archive', '--format=tar', '--output', archive, sha]);
  await command('tar', ['-xf', archive, '-C', source]);
  const pagesArtifact = join(source, 'landing/out');
  await cp(artifact, pagesArtifact, { recursive: true, errorOnExist: true });
  // Use the exact Git blob, including its line endings, after validating the reviewed local export.
  await writeFile(join(pagesArtifact, '_worker.js'), await readFile(join(source, 'pages-gateway/worker.mjs')));
  const config = structuredClone(worker);
  delete config.$schema;
  config.main = join(source, 'cloudflare/src/agendia-ui.ts');
  config.containers[0].image = join(source, 'Dockerfile');
  config.containers[0].image_build_context = source;
  config.containers[0].image_vars = { ...imageArguments, AGENDIA_SOURCE_SHA: sha };
  const configPath = join(temporary, 'worker.json');
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  await verifySource(sha);
  progress('DEPLOY_UI_WORKER');
  await command(process.execPath, [wrangler, 'deploy', '--config', configPath, '--tsconfig', join(source, 'cloudflare/tsconfig.json'), '--autoconfig=false', '--containers-rollout=immediate', '--tag', sha, '--message', 'AgendIA UI ' + sha], 1200000);
  await verifySource(sha);
  progress('DEPLOY_AGENDIA_PAGES');
  await command(process.execPath, [wrangler, 'pages', 'deploy', pagesArtifact, '--project-name', 'agendia-app', '--branch', 'main', '--commit-hash', sha, '--commit-dirty=false', '--commit-message', 'AgendIA ' + sha], 180000, source);
  progress('VERIFY_PUBLIC_BOUNDARIES');
  let ready = false;
  const deadline = Date.now() + 300000;
  while (!ready && Date.now() < deadline) {
    try {
      const checks = [['/dashboard', 200], ['/api/session', 401], ['/api/admin', 404], ['/api/whatsapp/webhook', 404]];
      ready = (await Promise.all(checks.map(async ([path, status]) => {
        const response = await fetch('https://agendia-app.pages.dev' + path, { redirect: 'error', signal: AbortSignal.timeout(30000) });
        await response.body?.cancel();
        return response.status === status && response.headers.get('cache-control') === 'no-store';
      }))).every(Boolean);
    } catch { ready = false; }
    if (!ready) await new Promise(resolveDelay => setTimeout(resolveDelay, 10000));
  }
  if (!ready) throw new Error('PUBLIC_BOUNDARY_CHECK_FAILED');
  console.log(JSON.stringify({ sha, worker: 'agendia-web', pages: 'agendia-app', publicChecks: 'passed' }));
}

try { await main(); }
catch (error) {
  const code = /^[A-Z][A-Z0-9_]+$/.test(error?.message ?? '') ? error.message : 'AGENDIA_RELEASE_FAILED';
  console.error('AgendIA release stopped at ' + stage + ': ' + code + '. Check live AgendIA state before retrying; no automatic rollback.');
  process.exitCode = 1;
} finally {
  if (temporary) {
    const target = resolve(temporary), parent = resolve(scratch);
    if (dirname(target) !== parent || !target.startsWith(join(parent, 'agendia-release-'))) throw new Error('UNSAFE_TEMPORARY_PATH');
    await rm(target, { recursive: true, force: true });
  }
}
