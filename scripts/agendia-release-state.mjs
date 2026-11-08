const fail = code => { throw new Error(code); };
const uuid = value => /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value ?? '');

function receipt(text, type) {
  let rows;
  try { rows = text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(row => row.type === type); }
  catch { fail('AGENDIA_DEPLOYMENT_RECEIPT'); }
  if (rows.length !== 1) fail('AGENDIA_DEPLOYMENT_RECEIPT');
  return rows[0];
}

export function deployedVersion(text) {
  const row = receipt(text, 'deploy');
  if (row.worker_name !== 'agendia-web' || !uuid(row.version_id)) fail('AGENDIA_DEPLOYMENT_RECEIPT');
  return row.version_id;
}

export function deployedPages(text, sha) {
  const row = receipt(text, 'pages-deploy-detailed');
  if (row.pages_project !== 'agendia-app' || !uuid(row.deployment_id) || row.environment !== 'production'
    || row.deployment_trigger?.metadata?.commit_hash !== sha) fail('AGENDIA_DEPLOYMENT_RECEIPT');
  return row.deployment_id;
}

export function latestDeployment(rows) {
  if (!Array.isArray(rows) || rows.length === 0 || rows.some(row => !Number.isFinite(Date.parse(row.created_on)))) fail('AGENDIA_DEPLOYMENT_INVENTORY');
  const sorted = [...rows].sort((a, b) => Date.parse(b.created_on) - Date.parse(a.created_on));
  if (sorted.length > 1 && Date.parse(sorted[0].created_on) === Date.parse(sorted[1].created_on)) fail('AGENDIA_DEPLOYMENT_INVENTORY');
  return sorted[0];
}

export async function inspectReleaseImage({ account, workerVersion, workerOutput = '', appImage, inspect, pull }) {
  if (!/^[a-f0-9]{32}$/.test(account) || !uuid(workerVersion)) fail('AGENDIA_IMAGE_SOURCE');
  // Pinned Wrangler 4.150 uses this version prefix for the published Docker tag.
  const tag = `registry.cloudflare.com/${account}/agendia-web-agendiaweb:${workerVersion.split('-')[0]}`;
  try { return await inspect(tag); }
  catch (error) {
    if (!workerOutput.includes('Image already exists remotely, skipping push')) throw error;
  }
  if (!new RegExp(`^registry\\.cloudflare\\.com/${account}/agendia-web-agendiaweb@sha256:[a-f0-9]{64}$`).test(appImage ?? '')) fail('AGENDIA_IMAGE_SOURCE');
  try { return await inspect(appImage); }
  catch { await pull(appImage); return inspect(appImage); }
}

export function imageReference(local, { sha, account }) {
  const pattern = new RegExp(`^registry\\.cloudflare\\.com/${account}/agendia-web-agendiaweb@sha256:[a-f0-9]{64}$`);
  const images = local?.RepoDigests?.filter(value => pattern.test(value)) ?? [];
  if (!/^[a-f0-9]{40}$/.test(sha) || !/^[a-f0-9]{32}$/.test(account) || images.length !== 1
    || local?.Os !== 'linux' || local.Architecture !== 'amd64'
    || local.Config?.Labels?.['org.opencontainers.image.revision'] !== sha
    || local.Config?.Labels?.['org.opencontainers.image.source'] !== 'https://github.com/andresleosan/AgendIA') fail('AGENDIA_IMAGE_SOURCE');
  return images[0];
}

function validateContainerScope(app, account) {
  if (app?.name !== 'agendia-web-agendiaweb' || app.account_id !== account || !app.id || !app.durable_objects?.namespace_id
    || app.max_instances !== 1 || app.scheduling_policy !== 'default' || !Number.isInteger(app.version) || app.version < 1) fail('AGENDIA_CONTAINER_TARGET');
}

export function releaseTarget(app, { sha, account, workerVersion, image }) {
  validateContainerScope(app, account);
  if (app.configuration?.image !== image || !uuid(workerVersion)) fail('AGENDIA_CONTAINER_TARGET');
  return { sha, account, workerVersion, image, appId: app.id, containerVersion: app.version, namespaceId: app.durable_objects.namespace_id, pagesDeployment: undefined };
}

export async function waitForContainerTarget({ initialApp, readApp, wake, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), timeoutMs = 600_000, ...details }) {
  validateContainerScope(initialApp, details.account);
  const deadline = now() + timeoutMs;
  let app = initialApp;
  while (now() < deadline) {
    validateContainerScope(app, details.account);
    if (app.id !== initialApp.id || app.durable_objects.namespace_id !== initialApp.durable_objects.namespace_id) fail('AGENDIA_CONTAINER_TARGET');
    // The API keeps the previous configuration/version until asynchronous rollout completes.
    if (app.configuration?.image === details.image && !app.active_rollout_id) return releaseTarget(app, details);
    await wake();
    await sleep(10_000);
    app = await readApp();
  }
  fail('AGENDIA_CONTAINER_ROLLOUT_NOT_READY');
}

export function productionReady({ app, deployment, version, instances, pages }, target) {
  const health = app?.health, traffic = deployment?.versions, bindings = version?.resources?.bindings;
  const active = Array.isArray(instances?.instances) ? instances.instances.filter(item => !['inactive', 'stopped'].includes(item.state)) : [];
  const canonical = pages?.canonical_deployment;
  return app?.id === target.appId && app.name === 'agendia-web-agendiaweb' && app.account_id === target.account
    && app.max_instances === 1 && app.scheduling_policy === 'default' && app.durable_objects?.namespace_id === target.namespaceId
    && app.version === target.containerVersion && app.configuration?.image === target.image && !app.active_rollout_id
    && Array.isArray(health?.errors) && health.errors.length === 0 && health.instances?.active === 1
    && health.instances.failed === 0 && health.instances.scheduling === 0 && health.instances.starting === 0
    && Array.isArray(traffic) && traffic.length === 1 && traffic[0].version_id === target.workerVersion && traffic[0].percentage === 100
    && version?.id === target.workerVersion && version.annotations?.['workers/tag'] === target.sha
    && Array.isArray(bindings) && bindings.length === 1 && bindings[0].name === 'AGENDIA_UI'
    && bindings[0].type === 'durable_object_namespace' && bindings[0].class_name === 'AgendiaWeb'
    && bindings[0].namespace_id === target.namespaceId && (!bindings[0].script_name || bindings[0].script_name === 'agendia-web')
    && instances?.result_info?.next_page_token === null && Array.isArray(active) && active.length === 1
    && active[0].name === 'agendia-ui' && active[0].state === 'running' && active[0].version === target.containerVersion
    && pages?.name === 'agendia-app' && canonical?.id === target.pagesDeployment && canonical.environment === 'production'
    && canonical.latest_stage?.status === 'success' && canonical.deployment_trigger?.metadata?.commit_hash === target.sha;
}

export async function waitForRelease({ target, checkHttp, readSnapshot, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), timeoutMs = 600_000 }) {
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    const httpReady = await checkHttp(); // Wake the singleton before inspecting its active version.
    if (productionReady(await readSnapshot(), target) && httpReady) return;
    await sleep(10_000);
  }
  fail('AGENDIA_RELEASE_NOT_READY');
}
