import assert from 'node:assert/strict';
import test from 'node:test';
import { deployedVersion, deployedPages, latestDeployment, inspectReleaseImage, imageReference, releaseTarget, productionReady, waitForRelease } from '../../scripts/agendia-release-state.mjs';

const sha = 'a'.repeat(40), account = 'b'.repeat(32), version = '12345678-1234-1234-1234-123456789abc';
const image = `registry.cloudflare.com/${account}/agendia-web-agendiaweb@sha256:${'c'.repeat(64)}`;
const app = { id: 'app-id', name: 'agendia-web-agendiaweb', account_id: account, version: 4, max_instances: 1, scheduling_policy: 'default', configuration: { image }, durable_objects: { namespace_id: 'namespace-id' }, health: { errors: [], instances: { active: 1, failed: 0, scheduling: 0, starting: 0 } } };
const target = { sha, account, workerVersion: version, image, appId: app.id, containerVersion: 4, namespaceId: 'namespace-id', pagesDeployment: 'pages-id' };
const snapshot = () => ({
  app: structuredClone(app),
  deployment: { versions: [{ version_id: version, percentage: 100 }] },
  version: { id: version, annotations: { 'workers/tag': sha }, resources: { bindings: [{ name: 'AGENDIA_UI', type: 'durable_object_namespace', class_name: 'AgendiaWeb', namespace_id: 'namespace-id' }] } },
  instances: { instances: [{ name: 'agendia-ui', state: 'running', version: 4 }], result_info: { next_page_token: null } },
  pages: { name: 'agendia-app', canonical_deployment: { id: 'pages-id', environment: 'production', latest_stage: { status: 'success' }, deployment_trigger: { metadata: { commit_hash: sha } } } },
});

test('pins the Worker version to this invocation machine output', () => {
  assert.equal(deployedVersion(JSON.stringify({ type: 'deploy', worker_name: 'agendia-web', version_id: version }) + '\n'), version);
  for (const value of ['', '{}', JSON.stringify({ type: 'deploy', worker_name: 'sarin-bot-app', version_id: version })]) assert.throws(() => deployedVersion(value), /AGENDIA_DEPLOYMENT_RECEIPT/);
});

test('selects the current deployment from Wrangler chronological JSON output', () => {
  const old = { id: 'old', created_on: '2026-11-08T04:09:00Z' }, current = { id: 'current', created_on: '2026-11-08T05:09:00Z' };
  assert.equal(latestDeployment([old, current]).id, 'current');
  assert.equal(latestDeployment([current, old]).id, 'current');
  for (const rows of [[], [{ id: 'unknown' }], [old, { ...current, created_on: old.created_on }]]) assert.throws(() => latestDeployment(rows), /AGENDIA_DEPLOYMENT_INVENTORY/);
});

test('pins Pages production identity and commit from the deployment receipt', () => {
  const row = { type: 'pages-deploy-detailed', pages_project: 'agendia-app', deployment_id: version, environment: 'production', deployment_trigger: { metadata: { commit_hash: sha } } };
  assert.equal(deployedPages(JSON.stringify(row), sha), version);
  for (const value of [{ ...row, environment: 'preview' }, { ...row, pages_project: 'sarinbotsaas' }, { ...row, deployment_trigger: {} }]) assert.throws(() => deployedPages(JSON.stringify(value), sha), /AGENDIA_DEPLOYMENT_RECEIPT/);
  assert.throws(() => deployedPages(JSON.stringify(row) + '\n' + JSON.stringify(row), sha), /AGENDIA_DEPLOYMENT_RECEIPT/);
});

test('inspects this release image and safely recovers an identical reused digest', async () => {
  const calls = [], local = { source: 'synthetic-image-metadata' };
  const inspect = async ref => { calls.push(['inspect', ref]); if (calls.length < 4) throw new Error('missing locally'); return local; };
  const result = await inspectReleaseImage({ account, workerVersion: version, workerOutput: 'Image already exists remotely, skipping push', appImage: image, inspect, pull: async ref => { calls.push(['pull', ref]); } });
  assert.equal(result, local);
  assert.deepEqual(calls, [['inspect', `registry.cloudflare.com/${account}/agendia-web-agendiaweb:12345678`], ['inspect', image], ['pull', image], ['inspect', image]]);
  assert.equal(await inspectReleaseImage({ account, workerVersion: version, inspect: async () => local }), local);
});

test('never pulls mutable tags, foreign images or an image after an unrelated failure', async () => {
  let pulls = 0;
  for (const appImage of ['evil.invalid/image:latest', `registry.cloudflare.com/${account}/agendia-web-agendiaweb:latest`, image.replace(account, 'd'.repeat(32)), image.replace('agendia-web-agendiaweb', 'sarin-bot-app')]) {
    await assert.rejects(inspectReleaseImage({ account, workerVersion: version, workerOutput: 'Image already exists remotely, skipping push', appImage, inspect: async () => { throw new Error('missing'); }, pull: async () => { pulls++; } }), /AGENDIA_IMAGE_SOURCE/);
  }
  await assert.rejects(inspectReleaseImage({ account, workerVersion: version, workerOutput: '', appImage: image, inspect: async () => { throw new Error('COMMAND_FAILED'); }, pull: async () => { pulls++; } }), /COMMAND_FAILED/);
  assert.equal(pulls, 0);
});

test('requires local published image provenance and pins its digest before observing rollout', () => {
  const local = { Os: 'linux', Architecture: 'amd64', RepoDigests: [image], Config: { Labels: { 'org.opencontainers.image.revision': sha, 'org.opencontainers.image.source': 'https://github.com/andresleosan/AgendIA' } } };
  assert.equal(imageReference(local, { sha, account }), image);
  const old = structuredClone(local); old.Config.Labels['org.opencontainers.image.revision'] = 'd'.repeat(40);
  assert.throws(() => imageReference(old, { sha, account }), /AGENDIA_IMAGE_SOURCE/);
  assert.throws(() => imageReference({ ...local, RepoDigests: [] }, { sha, account }), /AGENDIA_IMAGE_SOURCE/);
  assert.deepEqual(releaseTarget(app, { sha, account, workerVersion: version, image }), { ...target, pagesDeployment: undefined });
  assert.throws(() => releaseTarget({ ...app, configuration: { image: image.replace(/c{64}/, 'd'.repeat(64)) } }, { sha, account, workerVersion: version, image }), /AGENDIA_CONTAINER_TARGET/);
});

test('accepts only the exact published Worker, Container and Pages revisions', () => {
  assert.equal(productionReady(snapshot(), target), true);
  for (const mutate of [
    value => { value.version.annotations['workers/tag'] = 'd'.repeat(40); },
    value => { value.version.id = 'older-worker-version'; },
    value => { value.deployment.versions[0].percentage = 50; },
    value => { value.app.version = 3; },
    value => { value.app.configuration.image = 'old-image'; },
    value => { value.instances.instances[0].version = 3; },
    value => { value.instances.instances[0].state = 'inactive'; },
    value => { value.app.active_rollout_id = 'rollout-pending'; },
    value => { value.pages.canonical_deployment.id = 'old-pages'; },
    value => { value.pages.canonical_deployment.deployment_trigger.metadata.commit_hash = 'd'.repeat(40); },
  ]) { const value = snapshot(); mutate(value); assert.equal(productionReady(value, target), false); }
});

test('fails closed on errors, missing metadata, extra bindings or incomplete inventory', () => {
  for (const mutate of [
    value => { value.app.health.errors = ['private failure details']; },
    value => { delete value.app.health; },
    value => { value.app.health.instances.failed = 1; },
    value => { value.app.health.instances.scheduling = 1; },
    value => { value.instances.result_info.next_page_token = 'more'; },
    value => { delete value.instances.result_info; },
    value => { value.instances.instances.push({ name: 'second', state: 'running', version: 4 }); },
    value => { value.version.resources.bindings.push({ name: 'DB', type: 'd1' }); },
    value => { value.app.durable_objects.namespace_id = 'other'; },
  ]) { const value = snapshot(); mutate(value); assert.equal(productionReady(value, target), false); }
});

test('HTTP success never ends polling while the old container still serves', async () => {
  let attempts = 0, clock = 0;
  await waitForRelease({ target, checkHttp: async () => true, readSnapshot: async () => { attempts++; const value = snapshot(); if (attempts === 1) value.instances.instances[0].version = 3; return value; }, now: () => clock, sleep: async ms => { clock += ms; }, timeoutMs: 30_000 });
  assert.equal(attempts, 2);
  await assert.rejects(waitForRelease({ target, checkHttp: async () => false, readSnapshot: async () => snapshot(), now: () => clock, sleep: async ms => { clock += ms; }, timeoutMs: 10_000 }), /AGENDIA_RELEASE_NOT_READY/);
  await assert.rejects(waitForRelease({ target, checkHttp: async () => true, readSnapshot: async () => { throw new Error('COMMAND_AUTHENTICATION'); } }), /COMMAND_AUTHENTICATION/);
});
