import assert from 'node:assert/strict';
import { createCloudflareDatabase, StorageError } from '../src/lib/storage/database';
import { privateBusinessDraft } from '../src/lib/server/businesses';
import { assertConsent, consentStateKey, readConsent, updateConsent } from '../src/lib/server/consent';
import { markResponseQuotaDispatch, finishResponseQuota } from '../src/lib/server/response-quota-store';
import { recoverResponseQuotaBatch } from '../src/lib/server/response-quota-recovery';
import { processWhatsAppQueue, startWhatsAppWorker } from '../src/lib/server/whatsapp-worker';
import { startPlatformWhatsAppWorker, processPlatformWhatsAppWork } from '../src/lib/server/platform-whatsapp-worker';
import { createPlatformWorkStore } from '../src/lib/server/platform-whatsapp-work-store';
import { parseCanonicalWaitlistOffer } from '../src/lib/server/waitlist-offers';
import { readOwnTeamMemberships, requestTeamAccess, decideTeamAccess } from '../src/lib/server/business-team';
import { bookingDataPolicyKey } from '../src/lib/server/booking-data-policy';
import { assertTeamAgendaAccess } from '../src/lib/server/team-agenda';
import type { Database } from '../src/lib/storage/types';
import { isPlatformJob } from '../shared/platform-whatsapp-work';
import { runSarinChat } from '../src/lib/server/chat';
import { createPlatformYCloudClient } from '../src/lib/server/platform-ycloud-client';
import { confirmPaymentAction } from '../src/lib/server/admin-payment-actions';
import { clientPolicyKey, readClientPolicy } from '../src/lib/server/client-policy';
import { memoryFirestore } from './memoryFirestore';
import { acceptSyntheticConsent } from './consent-fixtures';
import { recoverySql, recoveryAppointment, recoveryTeamEvent } from './recovery-backup-fixtures';
import { sha256 } from '../scripts/lib/data-migration.mjs';

export async function createDrillFixture(now: number, sourceSha: string) {
  const memory = memoryFirestore(), owner = { uid: 'demo-recovery-owner' };
  await acceptSyntheticConsent(memory.db, owner.uid);
  await acceptSyntheticConsent(memory.db, 'demo-post-consent');
  const consent = await readConsent(owner.uid, 'account', undefined, memory.db);
  await updateConsent(owner, { scope: 'account', action: 'revoke', requestId: 'demo-withdraw', expectedRevision: consent.revision, fingerprint: consent.documents.fingerprint, termsAccepted: false, dataAuthorized: false }, memory.db);
  const teamOwner = { uid: 'demo-team-owner' }, member = { uid: 'demo-team-member' }, teamBusinessId = 'demo-team-business';
  process.env.SARIN_TEAM_ACCESS_ENABLED = 'true';
  await memory.db.collection('businesses').doc(teamBusinessId).set({ ...privateBusinessDraft(teamOwner, now), id: teamBusinessId, slug: teamBusinessId, name: 'Demo team', subscription: { status: 'active', trialEndsAt: 0, currentPeriodEndsAt: now + 86400000 }, sarinConfig: { onboardingCompleted: true, tone: '', customRules: '', intakeFields: [] }, resources: [{ id: 'demo-chair', name: 'Demo', active: true }] });
  await memory.db.collection('businessSlugs').doc(teamBusinessId).set({ businessId: teamBusinessId, ownerUid: teamOwner.uid });
  await memory.db.collection('serverSettings').doc(bookingDataPolicyKey(teamBusinessId)).set({ version: 1, businessId: teamBusinessId, revision: 1, dataMode: 'general', representedMinorsEnabled: false, reason: 'initial', updatedAt: now, updatedBy: teamOwner.uid });
  await acceptSyntheticConsent(memory.db, teamOwner.uid); await acceptSyntheticConsent(memory.db, member.uid);
  const requested = await requestTeamAccess(member, { businessSlug: teamBusinessId, requestId: 'demo-team-request', expectedMembershipRevision: 0 }, memory.db as unknown as Database);
  const approved = await decideTeamAccess(teamOwner, teamBusinessId, requested.current.membershipId, { action: 'approve', requestId: 'demo-team-approve', expectedMembershipRevision: 1, expectedTeamRevision: 1, resourceId: 'demo-chair' }, memory.db as unknown as Database);
  const membershipPath = `businessMemberships/${approved.current.membershipId}`;
  const business = { ...privateBusinessDraft(owner, now), id: 'demo-business', slug: 'demo-business' };
  const service = { id: 'demo-service', name: 'Demo', durationMinutes: 30, bufferMinutes: 0, price: 1000, resourceIds: ['demo-resource'] };
  const resource = { id: 'demo-resource', name: 'Demo', active: true }, selection = { dateKey: '2026-11-03', startTimeStr: '09:00', serviceId: service.id, resourceId: resource.id };
  const hash = 'a'.repeat(64), object = Buffer.from('RIFF0000WEBPdemo-recovery'), digest = sha256(object);
  const blob = { key: `business-logos/${digest}`, sha256: digest, byteLength: object.length, contentType: 'image/webp' };
  const reservation = { reservationId: 'b'.repeat(64), scopeId: 'demo-scope', periodId: 'demo-period', attemptId: '123e4567-e89b-42d3-a456-426614174000' };
  const turn = { ...reservation, fingerprint: hash, status: 'reserved', startedAt: now - 600000, mode: 'sarin_client', channel: 'web', nextAttemptAt: now - 1,
    execution: { protocol: 2, origin: 'v2', phase: 'may_have_dispatched', mayHaveDispatched: true, fenceRevision: 1, deadlineAt: now - 1, providerCallId: null, result: null } };
  const legacy = { ...turn, reservationId: 'c'.repeat(64), attemptId: '223e4567-e89b-42d3-a456-426614174000', execution: undefined };
  delete legacy.execution;
  const epoch = '00000000-0000-4000-8000-000000000001';
  const job = { version: 1, provider: 'ycloud', purpose: 'platform_support', wabaId: '10001', phoneE164: '+12025550100', phoneNumberId: '20001',
    recordType: 'job', jobId: 'job_' + '1'.repeat(64), epoch, sourceEventId: 'event_' + '2'.repeat(64), sourceKind: 'text', kind: 'control',
    requestFingerprint: '3'.repeat(64), conversationId: '4'.repeat(64), controlEpoch: epoch, controlRevision: 0, connectionRevision: 0, conversationRevision: null,
    sourceOccurredAt: now, sourceReceivedAt: now, createdAt: now, customerSentAt: now, windowExpiresAt: now + 86400000, bodyExpiresAt: now + 86400000, expiresAt: now + 2592000000,
    status: 'unknown', nextJobId: null, nextAttemptAt: null, leaseToken: null, leaseClaimedAt: null, leaseExpiresAt: null, processingStartedAt: null, processingDeadlineAt: null,
    outboxId: null, outputKind: 'none', catalogId: 'identification', catalogVersion: 1, bodyState: 'body_erased', content: null,
    authorityKind: 'fixed_notice', noticeId: 'identification', noticeVersion: 1,
    audioState: 'not_applicable', audioToken: null, audioLeaseToken: null, audioReservationId: null, audioStartedAt: null, audioFinishedAt: null,
    generationState: 'not_applicable', generationToken: null, generationLeaseToken: null, generationReservationId: null, generationStartedAt: null, generationFinishedAt: null };
  assert.equal(isPlatformJob(job), true);
  const offer = { version: 1, id: 'demo-offer', businessId: business.id, waitlistRecordId: 'demo-wait', entryId: 'demo-entry', clientUid: 'demo-client', ownerActorUid: owner.uid, requestId: 'demo-offer-request', dateKey: selection.dateKey,
    waitlistRevision: 1, headRevisionAtCreation: 0, createdAt: now - 1000, expiresAt: now - 1, policyRevision: 1, commandFingerprint: hash, requestFingerprint: hash, catalogFingerprint: hash, resourceScheduleFingerprint: hash,
    target: { serviceId: service.id, serviceName: service.name, resourceId: resource.id, resourceName: resource.name, dateKey: selection.dateKey, startTimeStr: '09:00', endTimeStr: '09:30', startAt: now, endAt: now + 1800000, reservedUntilAt: now + 1800000, durationMinutes: 30, bufferMinutes: 0, priceCOP: 1000, intakeFields: [] },
    catalog: { service, resource, intakeFields: [] }, proposal: null, state: 'withdrawn', closedAt: now - 1, closedReason: 'withdrawn', closedByUid: owner.uid, booking: null };
  const docs: any[] = [...memory.rows].map(([path, row]) => ({ path, data: row.data }));
  docs.push(
    { path: 'businesses/demo-business', data: business },
    { path: 'businesses/demo-business/appointments/demo-appointment', data: recoveryAppointment },
    { path: 'businesses/demo-business/teamAccessEvents/demo-private-event', data: recoveryTeamEvent },
    { path: `businesses/demo-business/clientPolicies/${clientPolicyKey('demo-client')}`, data: { version: 1, blocked: true, futureAppointmentLimit: 3, reason: 'PRIVATE_REASON', updatedBy: owner.uid, updatedAt: now } },
    { path: 'bookingProposals/demo-proposal', data: { version: 2, id: 'demo-proposal', businessId: business.id, actorUid: 'demo-client', selection, service, resource, intakeFields: [], createdAt: now - 1000, expiresAt: now - 1, appointmentId: null, closedAt: now - 1 } },
    { path: 'businesses/demo-business/waitlistOffers/demo-offer', data: offer },
    { path: 'chatStates/demo-expired', data: { version: 1, selection: {}, updatedAt: now - 1000, expiresAt: now - 1 } },
    { path: 'serverSettings/responseQuotaProtocol', data: { version: 2, minimumWriterProtocol: 2, sourceSha, oldWriterStoppedAt: now - 1000, reviewArtifactSha256: hash } },
    { path: 'responseQuotaScopes/demo-scope', data: { initializedAt: now - 1000 } },
    { path: 'responseQuotaScopes/demo-scope/periods/demo-period', data: { id: 'demo-period', source: 'legacy', planId: null, startsAt: now - 86400000, endsAt: now + 86400000, includedResponses: 10, extraResponses: 0, usedResponses: 0, reservedResponses: 2 } },
    { path: `responseQuotaTurns/${turn.reservationId}`, data: turn }, { path: `responseQuotaTurns/${legacy.reservationId}`, data: legacy },
    { path: `platformWhatsAppJobs/${job.jobId}`, data: job },
    { path: 'whatsappInbox/demo-unknown-job', data: { businessId: business.id, phoneNumberId: '12345', wabaId: '23456', conversationId: 'demo-conversation', state: 'unknown', bodyExpiresAt: now - 1, expiresAt: now + 86400000, windowEndsAt: now - 1, nextAttemptAt: Number.MAX_SAFE_INTEGER, leaseId: 'demo-old-lease', reservation } },
    { path: `businessLogos/demo-business_${digest}`, data: { businessId: business.id, ownerUid: owner.uid, sha256: digest, createdAt: now }, blob },
  );
  const live = memoryFirestore(Object.fromEntries(docs.map(doc => [doc.path, doc.data])));
  await finishResponseQuota(reservation, true, live.db as unknown as Database);
  const postSnapshot = [...live.rows].filter(([path]) => path.startsWith('responseQuotaReceipts/') || path === `responseQuotaTurns/${turn.reservationId}` || path === 'responseQuotaScopes/demo-scope/periods/demo-period').map(([path, row]) => ({ path, data: row.data }));
  assert.equal(postSnapshot.filter(doc => doc.path.startsWith('responseQuotaReceipts/')).length, 1);
  await decideTeamAccess(teamOwner, teamBusinessId, approved.current.membershipId, { action: 'revoke', requestId: 'demo-team-revoke', expectedMembershipRevision: approved.current.revision, expectedTeamRevision: 2 }, memory.db as unknown as Database);
  assert.equal(memory.rows.get(membershipPath)!.data.status, 'revoked');
  return { sql: recoverySql(docs), object, blob, reservation, turn, legacy, job, postSnapshot, member, teamBusinessId, membershipPath, ownerUid: owner.uid, consentPath: `serverSettings/${consentStateKey('demo-post-consent', 'account')}` };
}

export async function probeRestoredRuntime(local: any, fixture: any, reconciliation: any, now: number) {
  const db = createCloudflareDatabase(async command => {
    const response = await local.fetch(command), result = await response.json();
    if (!response.ok) throw new StorageError(response.status, result.code);
    return result;
  });
  (globalThis as any).__sarinRecoveryDrillDb = db;
  const effects = { inference: 0, send: 0, payment: 0, automaticQuotaRelease: 0, network: 0 };
  (globalThis as any).__sarinRecoveryDrillEffects = effects;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { effects.network++; throw Error('RECOVERY_DRILL_NETWORK'); };
  const period = () => db.collection('responseQuotaScopes').doc('demo-scope').collection('periods').doc('demo-period').get();
  try {
    await assert.rejects(assertConsent(fixture.ownerUid, 'account', undefined, db));
    await assertConsent('demo-post-consent', 'account', undefined, db);
    assert.equal((await db.runTransaction(tx => assertTeamAgendaAccess(tx, fixture.member, fixture.teamBusinessId, db))).membership.status, 'active');
    const closed = await local.fetchClosed({ action: 'read', read: { kind: 'document', path: fixture.membershipPath } }); assert.equal(closed.status, 503);
    const read = async (path: string) => JSON.parse((await local.db.prepare('SELECT data FROM app_documents WHERE path=?').bind(path).first()).data);
    const proposal = await read('bookingProposals/demo-proposal'), offer = await read('businesses/demo-business/waitlistOffers/demo-offer');
    const policy = await read(`businesses/demo-business/clientPolicies/${clientPolicyKey('demo-client')}`);
    assert.equal(policy.backupControl.executable, false); assert.equal(policy.value.blocked, true);
    await assert.rejects(readClientPolicy('demo-business', 'demo-client', db), { status: 503 });
    assert.equal(proposal.backupControl.executable, false); assert.equal(offer.backupControl.executable, false);
    assert.equal(offer.value.state, 'withdrawn'); assert.equal(proposal.value.closedAt, now - 1);
    assert.throws(() => parseCanonicalWaitlistOffer('demo-offer', offer, 'demo-business'));
    const oldLease = { jobId: fixture.job.jobId, epoch: fixture.job.epoch, token: '00000000-0000-4000-8000-000000000002' };
    startWhatsAppWorker(); startPlatformWhatsAppWorker();
    await processWhatsAppQueue(db); await processPlatformWhatsAppWork(oldLease);
    await assert.rejects(createPlatformWorkStore(db).readAuthorized(oldLease), { code: 'PLATFORM_WORK_CORRUPT' });
    assert.equal((await db.collection('responseQuotaReceipts').get()).size, 0);
    // This receipt was committed in the independent live fixture after the SQL snapshot.
    await db.runTransaction(async tx => {
      const refs = fixture.postSnapshot.map((doc: any) => {
        const parts = doc.path.split('/'), ref = parts.length === 2 ? db.collection(parts[0]).doc(parts[1]) : db.collection(parts[0]).doc(parts[1]).collection(parts[2]).doc(parts[3]);
        return { ref, data: doc.data, immutable: doc.path.startsWith('responseQuotaReceipts/') };
      });
      await Promise.all(refs.map((row: any) => tx.get(row.ref)));
      for (const row of refs) { if (row.immutable) tx.create(row.ref, row.data); else tx.set(row.ref, row.data); }
    });
    const before = (await period()).data()!;
    await recoverResponseQuotaBatch(db, now);
    await assert.rejects(markResponseQuotaDispatch(fixture.reservation, fixture.turn.fingerprint, { providerCallId: null }, db));
    const settled = (await period()).data()!;
    assert.deepEqual(settled, before); assert.equal(settled.reservedResponses, 1);
    const receipts = await db.collection('responseQuotaReceipts').get(); assert.equal(receipts.size, 1);
    await finishResponseQuota(fixture.reservation, true, db);
    await recoverResponseQuotaBatch(db, now + 600000);
    assert.deepEqual((await period()).data(), settled);
    assert.equal((await db.collection('responseQuotaReceipts').get()).size, 1);
    const legacy = (await db.collection('responseQuotaTurns').doc(fixture.legacy.reservationId).get()).data()!;
    assert.equal(legacy.status, 'reserved'); assert.equal(legacy.execution.origin, 'legacy_unknown'); assert.equal(legacy.nextAttemptAt, Number.MAX_SAFE_INTEGER);
    assert.equal(reconciliation.canAdmit, false);
    const allowed = new Set([fixture.membershipPath, 'businesses/demo-business/appointments/demo-appointment', fixture.consentPath]);
    for (const invalidation of reconciliation.invalidations) {
      assert.ok(allowed.has(invalidation.path));
      const parts = invalidation.path.split('/'), ref = parts.length === 2 ? db.collection(parts[0]).doc(parts[1]) : db.collection(parts[0]).doc(parts[1]).collection(parts[2]).doc(parts[3]);
      await db.runTransaction(async tx => { await tx.get(ref); tx.delete(ref); });
    }
    await assert.rejects(assertConsent('demo-post-consent', 'account', undefined, db));
    await assert.rejects(db.runTransaction(tx => assertTeamAgendaAccess(tx, fixture.member, fixture.teamBusinessId, db)), { code: 'TEAM_AGENDA_DENIED' });
    assert.equal((await db.collection('businessMemberships').doc(fixture.membershipPath.split('/')[1]).get()).exists, false);
    assert.equal((await db.collection('chatStates').doc('demo-expired').get()).exists, false);
    assert.equal((await db.collection('businesses').doc('demo-business').collection('appointments').doc('demo-appointment').get()).exists, false);
    process.env.SARIN_RECOVERY_MODE = 'recovery';
    await assert.rejects(db.collection('businesses').doc('demo-business').set({ ownerUid: fixture.ownerUid }), { code: 'DATA_RECOVERY_CLOSED' });
    assert.deepEqual(effects, { inference: 0, send: 0, payment: 0, automaticQuotaRelease: 0, network: 0 });
    return effects;
  } finally { globalThis.fetch = originalFetch; delete (globalThis as any).__sarinRecoveryDrillDb; delete (globalThis as any).__sarinRecoveryDrillEffects; }
}

/** Verifies each compiled transport tripwire before using its zero counts as evidence. */
export async function probeEffectTripwires() {
  const counts = { inference: 0, send: 0, payment: 0, automaticQuotaRelease: 0 };
  (globalThis as any).__sarinRecoveryDrillEffects = counts;
  try {
    await assert.rejects(runSarinChat(undefined as any), /RECOVERY_DRILL_EFFECT_inference/);
    const client = createPlatformYCloudClient({ scope: { wabaId: '10001', phoneNumberId: '20001', phoneE164: '+12025550100' }, apiKey: 'demo-only', sendEnabled: false });
    await assert.rejects(client.sendText(undefined as any), /RECOVERY_DRILL_EFFECT_send/);
    await assert.rejects(confirmPaymentAction(undefined as any, '', undefined as any), /RECOVERY_DRILL_EFFECT_payment/);
    await assert.rejects(finishResponseQuota(undefined as any, false, undefined as any), /RECOVERY_DRILL_EFFECT_automaticQuotaRelease/);
    assert.deepEqual(counts, { inference: 1, send: 1, payment: 1, automaticQuotaRelease: 1 });
  } finally { delete (globalThis as any).__sarinRecoveryDrillEffects; }
}

export async function probeRecoveryAuth(auth: any, host: string, restoredUsers?: any[]) {
  assert.match(host, /^127\.0\.0\.1:\d+$/);
  const uid = 'demo-drill-user', disabledUid = 'demo-drill-disabled';
  const providerData = [{ providerId: 'google.com', uid: 'demo-drill-provider', email: 'demo@example.invalid' }];
  const metadata = { creationTime: new Date().toUTCString() };
  assert.equal((await auth.importUsers([{ uid, providerData, metadata }, { uid: disabledUid, disabled: true, metadata }])).failureCount, 0);
  await auth.setCustomUserClaims(uid, { role: 'owner' });
  const login = async (id = uid) => {
    const token = await auth.createCustomToken(id);
    const response = await fetch(`http://${host}/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=demo-key`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, returnSecureToken: true }) });
    return { response, body: await response.json() };
  };
  const old = await login(); assert.equal(old.response.ok, true);
  const captured = restoredUsers ?? (await auth.listUsers()).users.filter((u: any) => [uid, disabledUid].includes(u.uid));
  assert.deepEqual(captured.map((u: any) => u.uid).sort(), [uid, disabledUid].sort());
  await auth.deleteUsers([uid, disabledUid]);
  const imported = await auth.importUsers(captured.map((u: any) => ({ uid: u.uid, disabled: u.disabled, providerData: u.providerData, metadata: u.metadata })));
  assert.equal(imported.failureCount, 0);
  assert.equal((await auth.getUser(uid)).providerData[0].uid, 'demo-drill-provider');
  await new Promise(resolve => setTimeout(resolve, 1100)); await auth.revokeRefreshTokens(uid);
  await assert.rejects(auth.verifyIdToken(old.body.idToken, true), { code: 'auth/id-token-revoked' });
  const fresh = await login(); assert.equal(fresh.response.ok, true);
  const verified = await auth.verifyIdToken(fresh.body.idToken, true); assert.equal(verified.uid, uid); assert.equal(verified.role, undefined);
  assert.equal((await auth.getUser(disabledUid)).disabled, true); assert.equal((await login(disabledUid)).response.ok, false);
  const empty = memoryFirestore(); assert.deepEqual((await readOwnTeamMemberships(verified, {}, empty.db)).items, []);
  await auth.deleteUsers([uid, disabledUid]);
  return { users: captured, ok: true };
}
