import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { validateDeploymentConfigs, publicBuildArguments, classifyCommandFailure } from '../../scripts/agendia-deployment.mjs';

const worker = JSON.parse(await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
const pages = JSON.parse(await readFile(new URL('../../wrangler.jsonc', import.meta.url), 'utf8'));

test('deployment accepts only the independent AgendIA Worker and Pages target', () => {
  assert.equal(validateDeploymentConfigs(worker, pages), true);
  for (const mutate of [
    value => { value.name = 'sarin-bot-app'; },
    value => { value.main = 'src/index.ts'; },
    value => { value.d1_databases = [{ binding: 'SARIN_DB' }]; },
    value => { value.vars = { WHATSAPP_ENABLED: 'true' }; },
    value => { value.containers[0].class_name = 'SarinApp'; },
    value => { value.containers[0].max_instances = 2; },
    value => { value.triggers = { crons: ['* * * * *'] }; },
  ]) {
    const invalid = structuredClone(worker); mutate(invalid);
    assert.throws(() => validateDeploymentConfigs(invalid, pages));
  }
  for (const mutate of [
    value => { value.name = 'agendia'; },
    value => { value.name = 'sarinbotsaas'; },
    value => { value.services[1].service = 'sarin-bot-app'; },
    value => { value.vars.SUPERADMIN_UID = 'synthetic'; },
  ]) {
    const invalid = structuredClone(pages); mutate(invalid);
    assert.throws(() => validateDeploymentConfigs(worker, invalid));
  }
});

test('only public Firebase values reach the image build and use the existing project', () => {
  const input = { NEXT_PUBLIC_FIREBASE_API_KEY: 'AIzaSyntheticPublicFirebaseKey12345', NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: 'sarinbotsaas.firebaseapp.com', NEXT_PUBLIC_FIREBASE_PROJECT_ID: 'sarinbotsaas', NEXT_PUBLIC_FIREBASE_APP_ID: '1:153690559048:web:0123456789abcdef', SUPERADMIN_UID: 'private', PLATFORM_YCLOUD_API_KEY: 'private' };
  const output = publicBuildArguments(input);
  assert.equal(Object.keys(output).length, 4);
  assert.equal('SUPERADMIN_UID' in output, false);
  assert.equal('PLATFORM_YCLOUD_API_KEY' in output, false);
  assert.throws(() => publicBuildArguments({ ...input, NEXT_PUBLIC_FIREBASE_PROJECT_ID: 'new-project' }));
  assert.throws(() => publicBuildArguments({ ...input, NEXT_PUBLIC_FIREBASE_API_KEY: 'private-provider-secret' }));
});

test('deployment diagnostics classify failures without reproducing command output', () => {
  assert.equal(classifyCommandFailure('Authentication error: synthetic-private-token'), 'COMMAND_AUTHENTICATION');
  assert.equal(classifyCommandFailure('Cannot connect to the Docker daemon at a private endpoint'), 'COMMAND_DOCKER_UNAVAILABLE');
  assert.equal(classifyCommandFailure('No such service for service binding'), 'COMMAND_SERVICE_BINDING');
  assert.equal(classifyCommandFailure('failed to solve: build details contain private text'), 'COMMAND_IMAGE_BUILD');
  assert.equal(classifyCommandFailure('unknown failure synthetic-private-token'), 'COMMAND_FAILED');
});
