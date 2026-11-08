import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const fail = (code, message) => { throw new Error(`${code}: ${message}`); };
const repositoryName = value => /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i.exec(value)?.[1].toLowerCase();
async function runGit(cwd, args) {
  const { stdout } = await execute('git', args, { cwd, timeout: 20_000, maxBuffer: 1024 * 1024, windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_OPTIONAL_LOCKS: '0' } });
  return stdout;
}

/** Read-only: remote HEAD is queried live; uncommitted files are never overwritten. */
export async function verifyWorkingSource(plan, git = runGit) {
  const codeRoot = plan.workspace?.codeRoot;
  if (typeof codeRoot !== 'string' || !codeRoot) fail('SOURCE_WORKSPACE_MISSING', 'Falta workspace.codeRoot; no usar el checkout de control como sustituto.');
  const delivery = plan.preferences?.gitDelivery;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(delivery?.repository ?? '') || delivery.remote !== 'origin' || delivery.branch !== 'main' || plan.workspace.branch !== 'main') fail('SOURCE_DELIVERY_INVALID', 'Revisa el repositorio y el destino origin/main registrados.');
  const { repository, remote, branch } = delivery;
  const localRead = async args => {
    try { return await git(codeRoot, args); }
    catch { fail('SOURCE_GIT_UNAVAILABLE', 'No se pudo leer Git en workspace.codeRoot. No cambiar permisos globales ni sustituir el workspace.'); }
  };
  for (const args of [['remote', 'get-url', '--all', remote], ['remote', 'get-url', '--push', '--all', remote]]) {
    if (repositoryName((await localRead(args)).trim()) !== repository.toLowerCase()) fail('SOURCE_REPOSITORY_MISMATCH', `El remoto no identifica únicamente ${repository}.`);
  }
  if ((await localRead(['branch', '--show-current'])).trim() !== branch) fail('SOURCE_BRANCH_MISMATCH', 'El workspace debe estar en main, sin HEAD separado.');
  const localSha = (await localRead(['rev-parse', '--verify', 'HEAD'])).trim();
  if (!/^[a-f0-9]{40}$/.test(localSha)) fail('SOURCE_HEAD_INVALID', 'No se pudo identificar el commit local.');
  let remoteLine;
  try { remoteLine = (await git(codeRoot, ['ls-remote', '--exit-code', '--refs', remote, `refs/heads/${branch}`])).trim(); }
  catch { fail('SOURCE_REMOTE_UNAVAILABLE', 'No se pudo consultar main en GitHub; no usar una referencia en caché como verificación.'); }
  const remoteSha = /^([a-f0-9]{40})\trefs\/heads\/main$/.exec(remoteLine)?.[1];
  if (!remoteSha) fail('SOURCE_REMOTE_UNAVAILABLE', 'GitHub no devolvió un SHA válido de main.');
  const status = await localRead(['status', '--porcelain=v1', '--untracked-files=normal']);
  const changedEntries = status.split(/\r?\n/).filter(Boolean).length;
  return { repository, remote, branch, codeRoot, localSha, remoteSha, aligned: localSha === remoteSha, dirty: changedEntries > 0, changedEntries };
}
