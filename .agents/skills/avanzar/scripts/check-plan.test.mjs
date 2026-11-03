import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePlan, selectNextTask } from './check-plan.mjs';

const expectedRequirements = [{ id: 'A01.01', name: 'Consultar oferta' }];
const proof = [{ type: 'command', command: 'node --test fixture.test.mjs', exitCode: 0, reference: 'synthetic-run', cwd: '/isolated', sha: 'a'.repeat(40), result: 'pass' }];
const task = (id, changes = {}) => ({ id, phase: 'R0', kind: 'build', title: id,
  requirementIds: ['A01.01'], dependsOn: [], plan: 'docs/plan.md', anchor: id.toLowerCase(),
  files: { create: [], modify: [], test: [] }, skills: ['ponytail'], acceptance: ['Resultado comprobable'],
  checks: [{ command: 'node --test fixture.test.mjs', expected: 'exit 0' }], status: 'pending', evidence: [], ...changes });
const plan = (tasks = [task('T1')]) => ({ schemaVersion: 1, planVersion: 1, revision: 0,
  approval: { design: { status: 'approved', reference: 'user-design' },
    plan: { status: 'approved', approvedVersion: 1, reference: 'user-plan' }, external: {} },
  workspace: { codeRoot: null }, currentTaskId: null, tasks,
  requirements: [{ ...expectedRequirements[0], planningTaskIds: [], implementationTaskIds: ['T1'], acceptanceTaskIds: ['T1'],
    implementationResolved: false, status: 'pending', evidence: [] }] });
const check = state => validatePlan(state, { expectedRequirements });

test('a valid queue chooses exactly one ready task and resumes the current task', () => {
  const state = plan([task('T1'), task('T2', { dependsOn: ['T1'] })]);
  assert.deepEqual(check(state), []);
  assert.equal(selectNextTask(state).id, 'T1');
  state.tasks[0].status = 'needs_input'; state.currentTaskId = 'T1';
  assert.equal(selectNextTask(state).id, 'T1');
});

test('review must be recorded for the current plan version before execution', () => {
  const state = plan(); state.approval.plan = { status: 'pending_review' };
  assert.equal(selectNextTask(state), null);
  state.approval.plan = { status: 'approved', approvedVersion: 0, reference: 'older-plan' };
  assert.match(check(state).join('\n'), /approval/);
});

test('duplicate tasks, unknown dependencies and cycles are rejected', () => {
  assert.match(check(plan([task('T1'), task('T1')])).join('\n'), /duplicate/);
  assert.match(check(plan([task('T1', { dependsOn: ['MISSING'] })])).join('\n'), /unknown dependency/);
  assert.match(check(plan([task('T1', { dependsOn: ['T2'] }), task('T2', { dependsOn: ['T1'] })])).join('\n'), /cycle/);
});

test('every original requirement and name must survive with valid task mappings', () => {
  const missing = plan(); missing.requirements = [];
  assert.match(check(missing).join('\n'), /requirement/);
  const renamed = plan(); renamed.requirements[0].name = 'Otro alcance';
  assert.match(check(renamed).join('\n'), /name changed/);
  const invented = plan(); invented.tasks[0].requirementIds.push('A99.99');
  assert.match(check(invented).join('\n'), /unknown requirement/);
});

test('only one active task and its matching current pointer are allowed', () => {
  const state = plan([task('T1', { status: 'in_progress' }), task('T2', { status: 'needs_input' })]);
  state.currentTaskId = 'T1';
  assert.match(check(state).join('\n'), /active/);
  state.tasks.pop(); state.currentTaskId = null;
  assert.match(check(state).join('\n'), /currentTaskId/);
});

test('completed work needs evidence and unsafe repository paths are rejected', () => {
  assert.match(check(plan([task('T1', { status: 'implemented' })])).join('\n'), /evidence/);
  const state = plan(); state.tasks[0].files.modify = ['../another-project/secret'];
  assert.match(check(state).join('\n'), /unsafe path/);
});

test('a completed decomposition needs actual build children and a downstream integration dependency', () => {
  const parent = task('T1', { kind: 'decompose', status: 'verified', evidence: proof,
    expansion: { moduleKey: 'sample', children: [], integrationTaskId: null, continuationTaskIds: ['NEXT'] } });
  const state = plan([parent, task('NEXT', { dependsOn: ['T1'] })]);
  assert.match(check(state).join('\n'), /expansion/);
  state.tasks.push(task('BUILD', { moduleKey: 'sample', dependsOn: ['T1'] }),
    task('INTEGRATE', { moduleKey: 'sample', kind: 'integration', dependsOn: ['BUILD'] }));
  parent.expansion.children = ['BUILD', 'INTEGRATE']; parent.expansion.integrationTaskId = 'INTEGRATE';
  assert.match(check(state).join('\n'), /continuation/);
  state.tasks[1].dependsOn = ['INTEGRATE'];
  assert.deepEqual(check(state), []);
  assert.equal(selectNextTask(state).id, 'BUILD');
});

test('a phase gate cannot bypass unfinished generated work', () => {
  const parent = task('T1', { kind: 'decompose', status: 'verified', evidence: proof,
    expansion: { moduleKey: 'sample', children: ['BUILD', 'INTEGRATE'], integrationTaskId: 'INTEGRATE', continuationTaskIds: ['GATE'] } });
  const state = plan([parent, task('GATE', { kind: 'gate', dependsOn: ['INTEGRATE'], requiresExpandedPhase: 'R0' }),
    task('BUILD', { moduleKey: 'sample', dependsOn: ['T1'] }), task('INTEGRATE', { moduleKey: 'sample', kind: 'integration', dependsOn: ['BUILD'] })]);
  assert.deepEqual(check(state), []);
  assert.equal(selectNextTask(state).id, 'BUILD');
});

test('a planning document alone cannot resolve implementation or unlock final QA', () => {
  const state = plan([task('T1', { kind: 'design', status: 'verified', evidence: proof }),
    task('QA', { phase: 'QA', kind: 'qa', dependsOn: ['T1'], requiresAllRequirementsResolved: true })]);
  assert.equal(selectNextTask(state), null);
  state.requirements[0].implementationResolved = true;
  assert.match(check(state).join('\n'), /implementation/);
});

test('publication requires verified QA and explicit authorization for the action', () => {
  const state = plan([task('T1', { kind: 'qa', phase: 'QA', status: 'implemented', evidence: proof }),
    task('PUBLISH', { kind: 'release', phase: 'RELEASE', dependsOn: ['T1'], authorizationKey: 'deployment', requiresVerifiedQa: true })]);
  assert.equal(selectNextTask(state), null);
  state.tasks[0].status = 'verified';
  assert.equal(selectNextTask(state), null);
  state.approval.external.deployment = { status: 'approved', reference: 'user-publish-exact-artifact' };
  assert.equal(selectNextTask(state).id, 'PUBLISH');
});

test('product edits cannot run in the mixed control checkout', () => {
  const state = plan([task('T1', { status: 'in_progress', requiresCodeWorkspace: true })]);
  state.currentTaskId = 'T1'; state.workspace.codeRoot = '/control';
  assert.match(validatePlan(state, { expectedRequirements, controlRoot: '/control' }).join('\n'), /code workspace/);
});

test('malformed entries produce diagnostics rather than crashing validation', () => {
  const state = plan(); state.tasks.push(null);
  assert.match(check(state).join('\n'), /Invalid task id/);
});

test('completed product work still requires the isolated code workspace', () => {
  const state = plan([task('T1', { status: 'implemented', evidence: proof, requiresCodeWorkspace: true })]);
  assert.match(validatePlan(state, { expectedRequirements, controlRoot: '/control' }).join('\n'), /code workspace/);
});

test('a final QA gate requires concrete cases for every requirement', () => {
  const state = plan([task('T1', { status: 'implemented', evidence: proof }),
    task('FREEZE', { kind: 'gate', phase: 'BUILD', dependsOn: ['T1'], requiresConcreteQaCases: true })]);
  assert.equal(selectNextTask(state), null);
  state.requirements[0].qaCases = [{ id: 'CASE-1', actor: 'cliente demo', fixture: 'demo-appointment',
    steps: ['Enviar solicitud con UID distinto'], expected: ['403; cita intacta'] }];
  assert.equal(selectNextTask(state).id, 'FREEZE');
});

test('an integration must wait for every build child of its decomposition', () => {
  const parent = task('T1', { kind: 'decompose', status: 'verified', evidence: proof,
    expansion: { moduleKey: 'sample', children: ['BUILD', 'INTEGRATE'], integrationTaskId: 'INTEGRATE', continuationTaskIds: ['NEXT'] } });
  const state = plan([parent, task('BUILD', { moduleKey: 'sample', dependsOn: ['T1'] }),
    task('INTEGRATE', { moduleKey: 'sample', kind: 'integration', dependsOn: ['T1'] }),
    task('NEXT', { dependsOn: ['INTEGRATE'] })]);
  assert.match(check(state).join('\n'), /integration dependency/i);
  state.tasks[2].dependsOn = ['BUILD'];
  assert.deepEqual(check(state), []);
});

test('external task completion cannot be represented as ordinary implementation', () => {
  const state = plan([task('T1', { kind: 'release', phase: 'RELEASE', status: 'implemented', evidence: proof, authorizationKey: 'deployment' }),
    task('NEXT', { dependsOn: ['T1'] })]);
  assert.match(check(state).join('\n'), /completion status/i);
  assert.equal(selectNextTask(state), null);
});

test('a completed task cannot bypass unfinished prerequisites or gates', () => {
  const state = plan([task('T1'), task('NEXT', { dependsOn: ['T1'], status: 'implemented', evidence: proof })]);
  state.requirements[0].implementationTaskIds = ['NEXT']; state.requirements[0].implementationResolved = true;
  assert.match(check(state).join('\n'), /unfinished prerequisites/i);
});

test('the first dependency-ready external step waiting for approval cannot be skipped', () => {
  const state = plan([task('T1', { kind: 'release', phase: 'RELEASE', authorizationKey: 'deployment' }), task('NEXT')]);
  assert.deepEqual(check(state), []);
  assert.equal(selectNextTask(state), null);
});

test('completed designs need approval bound to a concrete contract artifact', () => {
  const state = plan([task('T1', { kind: 'design', status: 'verified', evidence: proof })]);
  assert.match(check(state).join('\n'), /contract approval/i);
  state.tasks[0].contractApproval = { status: 'approved', reference: 'user-approved-contract', artifact: { path: 'docs/spec.md', sha256: 'b'.repeat(64) } };
  assert.deepEqual(check(state), []);
});

test('a bare reference does not establish completion evidence', () => {
  const state = plan([task('T1', { status: 'implemented', evidence: [{ reference: 'synthetic' }] })]);
  assert.match(check(state).join('\n'), /completion evidence/i);
});
