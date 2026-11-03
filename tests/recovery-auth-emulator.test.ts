import { expect, it, vi } from 'vitest';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { captureRecoveryComponents } from '../scripts/lib/recovery-components.mjs';
import { recoverySql, recoveryMigrations, recoverySha } from './recovery-backup-fixtures';
import { createDataTestRuntime } from '../cloudflare/tests/data-runtime.mjs';
import { createCloudflareDatabase } from '@/lib/storage/database';
import { readOwnTeamMemberships } from '@/lib/server/business-team';
import type { DataReadResult, DataCommitResult } from '../shared/data-protocol';

const enabled = process.env.SARIN_RECOVERY_AUTH_TEST === 'true';
it.skipIf(!enabled)('auth_restore_requires_new_login_and_grants_no_business_role', async () => {
  const host = process.env.FIREBASE_AUTH_EMULATOR_HOST;
  if (!host || !/^127\.0\.0\.1:\d+$/.test(host)) throw Error('Local Auth emulator required');
  const projectId = 'demo-sarin-recovery-auth';
  const app = initializeApp({ projectId }, `recovery-${crypto.randomUUID()}`), auth = getAuth(app);
  const directory = await mkdtemp(join(tmpdir(), 'sarin-recovery-auth-'));
  const runtime = await createDataTestRuntime();
  try {
    const reset = await fetch(`http://${host}/emulator/v1/projects/${projectId}/accounts`, { method: 'DELETE' }); expect(reset.ok).toBe(true);
    const uid = 'demo-user-' + crypto.randomUUID(), disabledUid = 'demo-disabled-' + crypto.randomUUID();
    await auth.createUser({ uid }); await auth.createUser({ uid: disabledUid, disabled: true });
    await auth.setCustomUserClaims(uid, { role: 'owner', isSuperadmin: true });
    const login = async () => {
      const token = await auth.createCustomToken(uid);
      const response = await fetch(`http://${host}/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=demo-key`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, returnSecureToken: true }) });
      expect(response.ok).toBe(true); return (await response.json()).idToken as string;
    };
    const oldToken = await login(); await expect(auth.verifyIdToken(oldToken, true)).resolves.toMatchObject({ uid });
    const start = Date.now(), reference = { version: 'demo-v1', observedAt: start, sha256: 'a'.repeat(64), privateSource: 'demo-vault' };
    const inventory = { formatVersion: 1, batchId: 'demo-auth-config', observedAt: start, sourceSha: recoverySha, imageDigest: 'sha256:' + 'b'.repeat(64), migrations: recoveryMigrations, protocols: { quota: 2 }, sections: Object.fromEntries(['providers', 'domains', 'indexes', 'rules', 'wif', 'access', 'bindings', 'flags'].map(k => [k, reference])), requiredSecrets: [], secrets: [], passwordBatch: null };
    const r = await captureRecoveryComponents({ directory, source: { sourceSha: recoverySha, migrations: recoveryMigrations, exportSql: async () => ({ stream: new Response(recoverySql()).body, bookmark: 'demo', startedAt: start, completedAt: start, recoverableAt: start }) }, auth, config: { readInventory: async () => inventory } });
    expect(r.blockers).toEqual([]); expect(r.complete).toBe(true);
    const snapshot = JSON.parse(await readFile(join(r.directory, 'auth.json'), 'utf8'));
    expect(snapshot.grantsAuthority).toBe(false); expect(snapshot.requiresNewLogin).toBe(true);
    const restored = snapshot.users.filter((u: any) => [uid, disabledUid].includes(u.uid));
    expect(restored.find((u: any) => u.uid === disabledUid).disabled).toBe(true);
    await auth.deleteUsers([uid, disabledUid]);
    // Restore policy: import identity only, then revoke before allowing a fresh login.
    const imported = await auth.importUsers(restored.map((u: any) => ({ uid: u.uid, disabled: u.disabled, providerData: u.providerData, metadata: u.metadata })));
    expect(imported.failureCount).toBe(0);
    await new Promise(resolve => setTimeout(resolve, 1100));
    await auth.revokeRefreshTokens(uid);
    await expect(auth.verifyIdToken(oldToken, true)).rejects.toMatchObject({ code: 'auth/id-token-revoked' });
    const fresh = await auth.verifyIdToken(await login(), true);
    expect(fresh.uid).toBe(uid); expect(fresh.role).toBeUndefined(); expect(fresh.isSuperadmin).toBeUndefined();
    expect((await auth.getUser(disabledUid)).disabled).toBe(true);
    const db = createCloudflareDatabase(async command => { const reply = await runtime.fetch(command); return await reply.json() as DataReadResult | DataCommitResult; });
    expect(await readOwnTeamMemberships(fresh, {}, db)).toMatchObject({ items: [], nextAfterBusinessId: null });
    vi.stubEnv('SARIN_RECOVERY_MODE', 'recovery');
    await expect(db.collection('businesses').doc('demo-recovery').set({ ownerUid: fresh.uid })).rejects.toMatchObject({ code: 'DATA_RECOVERY_CLOSED' });
    vi.unstubAllEnvs();
    await auth.deleteUsers([uid, disabledUid]);
  } finally {
    vi.unstubAllEnvs();
    await runtime.dispose(); await deleteApp(app);
    expect(dirname(resolve(directory))).toBe(resolve(tmpdir())); expect(basename(directory)).toMatch(/^sarin-recovery-auth-/);
    await rm(directory, { recursive: true, force: true });
  }
}, 60000);
