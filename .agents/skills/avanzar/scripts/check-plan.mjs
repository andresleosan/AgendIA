import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const statuses = new Set(['pending', 'ready', 'in_progress', 'needs_input', 'implemented', 'in_qa', 'verified', 'published', 'activated']);
const kinds = new Set(['design', 'decompose', 'build', 'integration', 'gate', 'qa', 'release', 'activate']);
const activeStatuses = new Set(['in_progress', 'needs_input', 'in_qa']);
const doneStatuses = new Set(['implemented', 'verified', 'published', 'activated']);
const reviewedKinds = new Set(['design', 'decompose', 'gate', 'qa']);
const finished = task => task && (reviewedKinds.has(task.kind) ? task.status === 'verified' : task.kind === 'release' ? task.status === 'published' : task.kind === 'activate' ? task.status === 'activated' : ['implemented', 'verified'].includes(task.status));
const safePath = value => typeof value === 'string' && value.length > 0 && !/^(?:[a-z]:|[/\\])|(?:^|[/\\])\.\.(?:[/\\]|$)|[\0\r\n]/i.test(value);
const nonempty = value => typeof value === 'string' && Boolean(value.trim());
const proof = value => Array.isArray(value) && value.some(item => item && ['command', 'artifact', 'review', 'qa', 'remote', 'existingImplementation'].includes(item.type) && ['reference', 'cwd', 'result'].every(key => nonempty(item[key])) && /^[a-f0-9]{40}$/i.test(item.sha ?? '') && (item.type !== 'command' || (nonempty(item.command) && Number.isInteger(item.exitCode))));
const approved = value => value?.status === 'approved' && typeof value.reference === 'string' && Boolean(value.reference.trim());
const concreteCases = value => Array.isArray(value) && value.length > 0 && value.every(item => item && ['id', 'actor', 'fixture'].every(key => typeof item[key] === 'string' && item[key].trim()) && ['steps', 'expected'].every(key => Array.isArray(item[key]) && item[key].length > 0 && item[key].every(step => typeof step === 'string' && step.trim())));
const reaches = (tasks, start, target, seen = new Set()) => start === target || (!seen.has(start) && (seen.add(start), (tasks.get(start)?.dependsOn ?? []).some(id => reaches(tasks, id, target, seen))));

export function validatePlan(plan, { expectedRequirements = [], controlRoot } = {}) {
  const errors = [];
  const fail = message => errors.push(message);
  if (!plan || plan.schemaVersion !== 1 || !Number.isInteger(plan.revision) || plan.revision < 0 || !Number.isInteger(plan.planVersion) || plan.planVersion < 1) return ['Invalid plan schema/version/revision'];
  if (!Array.isArray(plan.tasks) || !Array.isArray(plan.requirements)) return ['Invalid task/requirement arrays'];
  if (plan.approval?.plan?.status === 'approved' && (!approved(plan.approval.plan) || plan.approval.plan.approvedVersion !== plan.planVersion)) fail('Plan approval does not match the current version');
  const tasks = new Map(), requirements = new Map();
  for (const task of plan.tasks) {
    if (!task || typeof task.id !== 'string' || !/^[A-Z][A-Z0-9-]*$/.test(task.id)) { fail('Invalid task id'); continue; }
    if (tasks.has(task.id)) fail(`duplicate task ${task.id}`);
    tasks.set(task.id, task);
    if (!kinds.has(task.kind) || !statuses.has(task.status)) fail(`Invalid kind/status ${task.id}`);
    if (!Array.isArray(task.dependsOn) || !Array.isArray(task.requirementIds)) fail(`Invalid dependency/requirement list ${task.id}`);
    if (!safePath(task.plan) || !/^[a-z0-9-]+$/.test(task.anchor ?? '')) fail(`unsafe path or anchor ${task.id}`);
    for (const mode of ['create', 'modify', 'test']) if (!Array.isArray(task.files?.[mode]) || !task.files[mode].every(safePath)) fail(`unsafe path in files ${task.id}`);
    if (!Array.isArray(task.skills) || !task.skills.length || !Array.isArray(task.acceptance) || !task.acceptance.length || !Array.isArray(task.checks) || !task.checks.length) fail(`Missing execution contract ${task.id}`);
    if (doneStatuses.has(task.status) && !proof(task.evidence)) fail(`Missing completion evidence ${task.id}`);
    if (doneStatuses.has(task.status) && !finished(task)) fail(`Invalid completion status ${task.id}`);
    if (task.kind === 'design' && task.status === 'verified' && (!approved(task.contractApproval) || !safePath(task.contractApproval?.artifact?.path) || !/^[a-f0-9]{64}$/i.test(task.contractApproval?.artifact?.sha256 ?? ''))) fail(`Missing concrete contract approval ${task.id}`);
    if (task.requiresCodeWorkspace && (activeStatuses.has(task.status) || doneStatuses.has(task.status)) && (!plan.workspace?.codeRoot || (controlRoot && path.resolve(plan.workspace.codeRoot).toLowerCase() === path.resolve(controlRoot).toLowerCase()))) fail(`Invalid code workspace ${task.id}`);
    if (['published', 'activated'].includes(task.status) && (!['release', 'activate'].includes(task.kind) || !approved(plan.approval?.external?.[task.authorizationKey]))) fail(`Missing explicit external approval ${task.id}`);
  }
  for (const requirement of plan.requirements) {
    if (!requirement || typeof requirement.id !== 'string' || requirements.has(requirement.id)) { fail('Invalid or duplicate requirement'); continue; }
    requirements.set(requirement.id, requirement);
    for (const field of ['planningTaskIds', 'implementationTaskIds', 'acceptanceTaskIds']) {
      if (!Array.isArray(requirement[field]) || requirement[field].some(id => !tasks.has(id))) fail(`Invalid requirement mapping ${requirement.id}:${field}`);
    }
    if (!requirement.acceptanceTaskIds?.length || !(requirement.planningTaskIds?.length || requirement.implementationTaskIds?.length)) fail(`Unmapped requirement ${requirement.id}`);
    if (requirement.implementationResolved && !((requirement.implementationTaskIds?.length && requirement.implementationTaskIds.every(id => ['build', 'integration'].includes(tasks.get(id)?.kind) && finished(tasks.get(id)))) || (requirement.existingImplementationVerified === true && proof(requirement.evidence)))) fail(`Unproven implementation resolution ${requirement.id}`);
    if (requirement.status === 'verified' && (!requirement.implementationResolved || !concreteCases(requirement.qaCases) || !requirement.acceptanceTaskIds?.every(id => tasks.get(id)?.status === 'verified') || !proof(requirement.evidence))) fail(`Unproven requirement acceptance ${requirement.id}`);
  }
  const expected = new Map(expectedRequirements.map(item => [item.id, item.name]));
  if (expected.size) {
    for (const [id, name] of expected) {
      if (!requirements.has(id)) fail(`Missing requirement ${id}`);
      else if (name !== undefined && requirements.get(id).name !== name) fail(`Requirement name changed ${id}`);
    }
    for (const id of requirements.keys()) if (!expected.has(id)) fail(`Unknown requirement ${id}`);
  }
  for (const task of tasks.values()) {
    for (const id of task.dependsOn ?? []) if (!tasks.has(id)) fail(`unknown dependency ${task.id}->${id}`);
    for (const id of task.requirementIds ?? []) if (!requirements.has(id)) fail(`unknown requirement ${task.id}->${id}`);
    if (task.status === 'ready' && !(task.dependsOn ?? []).every(id => finished(tasks.get(id)))) fail(`Task prematurely ready ${task.id}`);
    if (finished(task) && (!(task.dependsOn ?? []).every(id => finished(tasks.get(id))) || !gateReady(plan, task, tasks))) fail(`Completed task has unfinished prerequisites or gates ${task.id}`);
    if (task.kind === 'decompose' && task.status === 'verified') {
      const expansion = task.expansion;
      const children = (expansion?.children ?? []).map(id => tasks.get(id));
      if (!expansion || !children.length || children.some(child => !child || child.moduleKey !== expansion.moduleKey) || !children.some(child => child?.kind === 'build') || !children.some(child => child?.kind === 'integration') || !expansion.children.includes(expansion.integrationTaskId) || tasks.get(expansion.integrationTaskId)?.kind !== 'integration') fail(`Incomplete expansion ${task.id}`);
      else {
        for (const child of children) {
          if (!reaches(tasks, child.id, task.id)) fail(`Missing expansion parent dependency ${task.id}->${child.id}`);
          if (child.kind === 'build' && !reaches(tasks, expansion.integrationTaskId, child.id)) fail(`Missing integration dependency ${expansion.integrationTaskId}->${child.id}`);
        }
        for (const id of expansion.continuationTaskIds ?? []) if (!reaches(tasks, id, expansion.integrationTaskId)) fail(`Unrewired continuation ${task.id}->${id}`);
      }
    }
  }
  const visited = new Set(), visiting = new Set();
  function visit(id) {
    if (visiting.has(id)) { fail(`Dependency cycle ${id}`); return; }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of tasks.get(id)?.dependsOn ?? []) if (tasks.has(dependency)) visit(dependency);
    visiting.delete(id); visited.add(id);
  }
  for (const id of tasks.keys()) visit(id);
  const active = plan.tasks.filter(task => activeStatuses.has(task?.status));
  if (active.length > 1) fail('Multiple active tasks');
  if ((active.length === 1 && plan.currentTaskId !== active[0].id) || (!active.length && plan.currentTaskId !== null)) fail('currentTaskId does not match the active task');
  return errors;
}

function gateReady(plan, task, tasks) {
  if (task.requiresExpandedPhase && plan.tasks.some(parent => parent.phase === task.requiresExpandedPhase && parent.kind === 'decompose' && (!finished(parent) || !(parent.expansion?.children?.length) || !parent.expansion.children.every(id => finished(tasks.get(id)))))) return false;
  if (task.requiresAllConstruction && plan.tasks.some(candidate => /^R[0-5]$/.test(candidate.phase) && !finished(candidate))) return false;
  if (task.requiresAllRequirementsResolved && plan.requirements.some(requirement => !requirement.implementationResolved)) return false;
  if (task.requiresConcreteQaCases && plan.requirements.some(requirement => !concreteCases(requirement.qaCases))) return false;
  if (task.requiresVerifiedQa && plan.tasks.some(candidate => candidate.phase === 'QA' && candidate.status !== 'verified')) return false;
  if (task.requiresAllRequirementsVerified && plan.requirements.some(requirement => requirement.status !== 'verified')) return false;
  if (task.authorizationKey && !approved(plan.approval?.external?.[task.authorizationKey])) return false;
  return true;
}

export function selectNextTask(plan) {
  if (!approved(plan.approval?.plan) || plan.approval.plan.approvedVersion !== plan.planVersion) return null;
  if (plan.currentTaskId) return plan.tasks.find(task => task.id === plan.currentTaskId) ?? null;
  const tasks = new Map(plan.tasks.map(task => [task.id, task]));
  for (const task of plan.tasks) {
    if (!['pending', 'ready'].includes(task.status) || !task.dependsOn.every(id => finished(tasks.get(id)))) continue;
    if (task.authorizationKey && !approved(plan.approval?.external?.[task.authorizationKey])) return null;
    if (gateReady(plan, task, tasks)) return task;
  }
  return null;
}

async function main() {
  const root = fileURLToPath(new URL('../../../../', import.meta.url));
  const args = process.argv.slice(2);
  if (args.some(arg => !['--next', '--ready-for-qa'].includes(arg))) throw new Error('Usage: check-plan.mjs [--next] [--ready-for-qa]');
  const plan = JSON.parse(await readFile(path.join(root, 'docs/implementation/fresha/tasks.json'), 'utf8'));
  const matrix = await readFile(path.join(root, 'docs/product/fresha-admin-coverage-matrix.md'), 'utf8');
  const expectedRequirements = matrix.split(/\r?\n/).filter(line => /^\| A\d{2}\.\d{2} \|/.test(line)).map(line => ({ id: line.split('|')[1].trim(), name: line.split('|')[2].trim() }));
  if (expectedRequirements.length !== 165) throw new Error('Original inventory must contain exactly 165 rows; review a scope change explicitly.');
  const errors = validatePlan(plan, { expectedRequirements, controlRoot: root });
  for (const task of plan.tasks) {
    if (!task || !safePath(task.plan)) continue;
    try { if (!(await readFile(path.join(root, task.plan), 'utf8')).includes(`id="${task.anchor}"`)) errors.push(`Missing plan anchor ${task.id}`); }
    catch { errors.push(`Missing plan file ${task.id}`); }
  }
  if (args.includes('--ready-for-qa')) {
    const tasks = new Map(plan.tasks.map(task => [task.id, task]));
    if (!gateReady(plan, { requiresAllConstruction: true, requiresAllRequirementsResolved: true, requiresConcreteQaCases: true }, tasks)) errors.push('Construction, requirement implementation or concrete cases are not complete; final QA remains locked.');
  }
  if (errors.length) { console.error(JSON.stringify({ valid: false, errors }, null, 2)); process.exitCode = 1; return; }
  console.log(JSON.stringify({ valid: true, tasks: plan.tasks.length, requirements: expectedRequirements.length,
    planReview: plan.approval.plan.status, next: args.includes('--next') ? selectNextTask(plan)?.id ?? null : undefined }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
