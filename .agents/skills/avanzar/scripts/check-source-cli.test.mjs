import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

test('CLI refuses a wrong source branch without selecting a task or changing the valid plan', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sarin-source-check-'));
  try {
    const codeRoot = join(root, 'code'), scripts = join(root, '.agents/skills/avanzar/scripts');
    await mkdir(codeRoot); await mkdir(scripts, { recursive: true });
    const git = args => execFileSync('git', args, { cwd: codeRoot, encoding: 'utf8', windowsHide: true });
    git(['init', '--initial-branch=demo-other']);
    git(['-c', 'user.name=Demo', '-c', 'user.email=demo@example.invalid', 'commit', '--allow-empty', '-m', 'demo baseline']);
    git(['remote', 'add', 'origin', 'https://github.com/andresleosan/SarinBotSAAS.git']);
    const before = git(['rev-parse', 'HEAD']);
    for (const file of ['check-plan.mjs', 'check-source.mjs']) await copyFile(new URL(file, import.meta.url), join(scripts, file));
    await mkdir(join(root, 'docs/implementation/fresha'), { recursive: true }); await mkdir(join(root, 'docs/product'), { recursive: true });
    const requirements = Array.from({ length: 165 }, (_, i) => ({ id: `A${String(Math.floor(i / 11) + 1).padStart(2, '0')}.${String(i % 11 + 1).padStart(2, '0')}`, name: `Demo ${i}`, planningTaskIds: [], implementationTaskIds: ['T1'], acceptanceTaskIds: ['T1'], implementationResolved: false, status: 'pending', evidence: [] }));
    const state = { schemaVersion: 1, revision: 0, planVersion: 1, currentTaskId: null,
      approval: { plan: { status: 'approved', approvedVersion: 1, reference: 'demo approval' } },
      workspace: { codeRoot, branch: 'main' }, preferences: { gitDelivery: { repository: 'andresleosan/SarinBotSAAS', remote: 'origin', branch: 'main' } },
      requirements, tasks: [{ id: 'T1', phase: 'R0', kind: 'build', requirementIds: requirements.map(r => r.id), dependsOn: [], plan: 'docs/plan.md', anchor: 't1', files: { create: [], modify: [], test: [] }, skills: ['ponytail'], acceptance: ['demo result'], checks: [{ command: 'demo', expected: 'pass' }], status: 'pending', evidence: [] }] };
    const file = join(root, 'docs/implementation/fresha/tasks.json'), original = JSON.stringify(state);
    await writeFile(file, original); await writeFile(join(root, 'docs/product/fresha-admin-coverage-matrix.md'), requirements.map(r => `| ${r.id} | ${r.name} |`).join('\n')); await writeFile(join(root, 'docs/plan.md'), '<a id="t1"></a>');
    const run = spawnSync(process.execPath, [join(scripts, 'check-plan.mjs'), '--next'], { cwd: root, encoding: 'utf8', windowsHide: true });
    assert.equal(run.status, 1); const result = JSON.parse(run.stderr);
    assert.equal(result.valid, true); assert.equal(result.sourceVerified, false); assert.equal(result.next, null);
    assert.match(result.errors[0], /SOURCE_BRANCH_MISMATCH/);
    assert.equal(await readFile(file, 'utf8'), original); assert.equal(git(['rev-parse', 'HEAD']), before); assert.equal(git(['status', '--porcelain']), '');
  } finally {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true });
  }
});
