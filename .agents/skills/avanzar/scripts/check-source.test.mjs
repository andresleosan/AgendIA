import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyWorkingSource } from './check-source.mjs';

const local = 'a'.repeat(40), remote = 'b'.repeat(40);
const plan = { workspace: { codeRoot: '/demo-code', branch: 'main' }, preferences: { gitDelivery: { repository: 'andresleosan/SarinBotSAAS', remote: 'origin', branch: 'main' } } };
const fixture = (overrides = {}) => async (cwd, args) => {
  assert.equal(cwd, '/demo-code');
  const key = args.join(' ');
  const outputs = {
    'remote get-url --all origin': 'https://github.com/andresleosan/SarinBotSAAS.git\n',
    'remote get-url --push --all origin': 'git@github.com:andresleosan/SarinBotSAAS.git\n',
    'branch --show-current': 'main\n',
    'rev-parse --verify HEAD': `${local}\n`,
    'ls-remote --exit-code --refs origin refs/heads/main': `${local}\trefs/heads/main\n`,
    'status --porcelain=v1 --untracked-files=normal': '',
    ...overrides,
  };
  if (!Object.hasOwn(outputs, key)) throw Error(`Unexpected mutation or command: ${key}`);
  if (outputs[key] instanceof Error) throw outputs[key];
  return outputs[key];
};

test('verifies the live main SHA rather than the cached remote-tracking branch', async () => {
  const result = await verifyWorkingSource(plan, fixture());
  assert.equal(result.aligned, true);
  assert.equal(result.localSha, local); assert.equal(result.remoteSha, local);
  assert.equal(result.repository, 'andresleosan/SarinBotSAAS'); assert.equal(result.dirty, false);
});
test('a different live SHA is reported without updating, resetting or pushing files', async () => {
  const result = await verifyWorkingSource(plan, fixture({ 'ls-remote --exit-code --refs origin refs/heads/main': `${remote}\trefs/heads/main\n` }));
  assert.equal(result.aligned, false); assert.equal(result.localSha, local); assert.equal(result.remoteSha, remote);
});
test('uncommitted work is visible even when HEAD matches main', async () => {
  const result = await verifyWorkingSource(plan, fixture({ 'status --porcelain=v1 --untracked-files=normal': ' M src/demo.ts\n?? private/\n' }));
  assert.equal(result.aligned, true); assert.equal(result.dirty, true); assert.equal(result.changedEntries, 2);
});
test('rejects a wrong fetch or push repository before contacting it', async () => {
  for (const key of ['remote get-url --all origin', 'remote get-url --push --all origin']) {
    await assert.rejects(verifyWorkingSource(plan, fixture({ [key]: 'https://github.com/another/project.git\n' })), /SOURCE_REPOSITORY_MISMATCH/);
  }
});
test('rejects lookalike hosts and multiple remotes without exposing credential-bearing URLs', async () => {
  for (const url of ['https://github.com.attacker.invalid/andresleosan/SarinBotSAAS.git', 'https://github.com/another/project.git\nhttps://github.com/andresleosan/SarinBotSAAS.git', 'https://secret-token@attacker.invalid/private.git']) {
    await assert.rejects(verifyWorkingSource(plan, fixture({ 'remote get-url --all origin': url })), error => /SOURCE_REPOSITORY_MISMATCH/.test(error.message) && !error.message.includes('secret-token'));
  }
});
test('rejects detached HEAD and a different branch', async () => {
  for (const branch of ['', 'other']) await assert.rejects(verifyWorkingSource(plan, fixture({ 'branch --show-current': branch })), /SOURCE_BRANCH_MISMATCH/);
});
test('offline, missing main and malformed SHAs never count as verified', async () => {
  for (const value of [new Error('network unavailable: secret-token'), '', `${local}\trefs/heads/other\n`, 'invalid\trefs/heads/main\n']) {
    await assert.rejects(verifyWorkingSource(plan, fixture({ 'ls-remote --exit-code --refs origin refs/heads/main': value })), error => /SOURCE_REMOTE_UNAVAILABLE/.test(error.message) && !error.message.includes('secret-token'));
  }
  await assert.rejects(verifyWorkingSource(plan, fixture({ 'rev-parse --verify HEAD': 'invalid' })), /SOURCE_HEAD_INVALID/);
});
test('missing codeRoot or delivery identity never falls back to the mixed checkout', async () => {
  await assert.rejects(verifyWorkingSource({ ...plan, workspace: { codeRoot: null } }, fixture()), /SOURCE_WORKSPACE_MISSING/);
  await assert.rejects(verifyWorkingSource({ ...plan, preferences: {} }, fixture()), /SOURCE_DELIVERY_INVALID/);
});
