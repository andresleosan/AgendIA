export const PUBLIC_KEYS = ['NEXT_PUBLIC_FIREBASE_API_KEY', 'NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN', 'NEXT_PUBLIC_FIREBASE_PROJECT_ID', 'NEXT_PUBLIC_FIREBASE_APP_ID'];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const keys = value => Object.keys(value ?? {}).sort();
const fail = () => { throw new Error('AGENDIA_DEPLOYMENT_SCOPE'); };

export function validateDeploymentConfigs(worker, pages) {
  if (!same(keys(worker), ['$schema', 'compatibility_date', 'compatibility_flags', 'containers', 'durable_objects', 'exports', 'main', 'name', 'observability', 'preview_urls', 'send_metrics', 'workers_dev'].sort())) fail();
  if (worker.name !== 'agendia-web' || worker.main !== 'src/agendia-ui.ts' || worker.workers_dev !== false || worker.preview_urls !== false || worker.send_metrics !== false
    || worker.compatibility_date !== '2026-10-13' || !same(worker.compatibility_flags, ['nodejs_compat']) || worker.containers?.length !== 1) fail();
  if (!same(worker.observability, { enabled: false, logs: { enabled: false }, traces: { enabled: false } })) fail();
  const container = worker.containers[0];
  if (!same(keys(container), ['class_name', 'scheduling_policy', 'image', 'image_build_context', 'instance_type', 'max_instances', 'observability', 'image_vars'].sort())) fail();
  if (container.class_name !== 'AgendiaWeb' || container.scheduling_policy !== 'default' || container.image !== '../Dockerfile' || container.image_build_context !== '..'
    || container.instance_type !== 'basic' || container.max_instances !== 1 || !same(container.observability, { enabled: false })
    || !same(keys(container.image_vars), [...PUBLIC_KEYS].sort()) || Object.values(container.image_vars).some(value => value !== '')) fail();
  if (!same(worker.durable_objects, { bindings: [{ name: 'AGENDIA_UI', class_name: 'AgendiaWeb' }] }) || !same(worker.exports, { AgendiaWeb: { type: 'durable-object', storage: 'sqlite' } })) fail();
  if (!same(keys(pages), ['name', 'pages_build_output_dir', 'compatibility_date', 'vars', 'services'].sort()) || pages.name !== 'agendia-app'
    || pages.pages_build_output_dir !== './landing/out' || pages.compatibility_date !== worker.compatibility_date
    || !same(pages.vars, { AGENDIA_PUBLIC_ORIGIN: 'https://agendia-app.pages.dev' })
    || !same(pages.services, [{ binding: 'SARIN_API', service: 'sarin-bot-app' }, { binding: 'AGENDIA_WEB', service: 'agendia-web' }])) fail();
  return true;
}

export function publicBuildArguments(input) {
  const output = Object.fromEntries(PUBLIC_KEYS.map(key => [key, input[key]]));
  if (Object.values(output).some(value => typeof value !== 'string' || !value || /[\x00-\x20\x7f]/.test(value))
    || !/^AIza[A-Za-z0-9_-]{20,100}$/.test(output.NEXT_PUBLIC_FIREBASE_API_KEY)
    || output.NEXT_PUBLIC_FIREBASE_PROJECT_ID !== 'sarinbotsaas' || output.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN !== 'sarinbotsaas.firebaseapp.com'
    || !/^1:153690559048:web:[a-f0-9]+$/.test(output.NEXT_PUBLIC_FIREBASE_APP_ID)) throw new Error('AGENDIA_PUBLIC_FIREBASE');
  return output;
}

export function classifyCommandFailure(output) {
  if (/authentication|unauthorized|not authenticated|permission denied|code: ?10000/i.test(output)) return 'COMMAND_AUTHENTICATION';
  if (/cannot connect to the docker daemon|docker daemon is not running|docker.*not found/i.test(output)) return 'COMMAND_DOCKER_UNAVAILABLE';
  if (/service binding|no such service/i.test(output)) return 'COMMAND_SERVICE_BINDING';
  if (/failed to solve|failed to build|build failed/i.test(output)) return 'COMMAND_IMAGE_BUILD';
  if (/timed? ?out|timeout/i.test(output)) return 'COMMAND_TIMEOUT';
  return 'COMMAND_FAILED';
}
