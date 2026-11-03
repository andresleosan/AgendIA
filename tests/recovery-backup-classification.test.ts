import { describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/firebase/admin', () => ({ getAdminDb: () => { throw new Error('Default backend forbidden'); }, getAdminAuth: () => ({ getUser: async (uid: string) => ({ uid, disabled: false }) }) }));
import { DATA_COLLECTIONS, DATA_CHILDREN } from '../shared/data-protocol';
import { classifyBackupDocument, BACKUP_CLASSIFIED_ROOTS, BACKUP_CLASSIFIED_CHILDREN } from '../scripts/lib/recovery-backup.mjs';
import { recoveryAppointment, recoveryNow, recoverySha } from './recovery-backup-fixtures';

const classify = (path: string, data: unknown) => classifyBackupDocument(path, data, recoveryNow);
describe('daily backup classification', () => {
  it('all_current_paths_and_fields_are_classified', () => {
    expect([...BACKUP_CLASSIFIED_ROOTS].sort()).toEqual([...DATA_COLLECTIONS].sort());
    expect(BACKUP_CLASSIFIED_CHILDREN).toEqual(DATA_CHILDREN);
    for (const data of [{ ...recoveryAppointment, medicalHistory: 'PRIVATE' }, { ...recoveryAppointment, client: { ...recoveryAppointment.client, diagnosis: 'PRIVATE' } }]) {
      expect(() => classify('businesses/demo-business/appointments/demo-appointment', data)).toThrow('D1_BACKUP_UNCLASSIFIED');
    }
    for (const path of ['unknown/demo', 'serverSettings/unknown', 'businesses/demo-business/unknown/demo']) expect(() => classify(path, {})).toThrow(/^D1_BACKUP_/);
  });
  it('keeps approved minor minimum but removes intake answers without mutating live data', () => {
    const data = structuredClone(recoveryAppointment), result = classify('businesses/demo-business/appointments/demo-appointment', data);
    expect(result.kind).toBe('sanitize');
    expect(result.data.client.intakeAnswers).toEqual({});
    expect(result.data.beneficiary).toEqual(data.beneficiary);
    expect(data.client.intakeAnswers.symptoms).toBe('PRIVATE_INTAKE_SENTINEL');
    expect(JSON.stringify(result)).not.toContain('PRIVATE_INTAKE_SENTINEL');
  });
  it('preserves quota protocol and revision markers and rejects nested extensions', () => {
    const protocol = { version: 2, minimumWriterProtocol: 2, sourceSha: recoverySha, oldWriterStoppedAt: recoveryNow, reviewArtifactSha256: 'a'.repeat(64) };
    expect(classify('serverSettings/responseQuotaProtocol', protocol)).toMatchObject({ kind: 'retain', data: protocol });
    expect(() => classify('serverSettings/responseQuotaProtocol', { ...protocol, password: 'PRIVATE' })).toThrow('D1_BACKUP_UNCLASSIFIED');
    const cursor = { version: 2, after: null, discoveryDone: true };
    expect(classify('serverSettings/responseQuotaRecoveryCursor', cursor).data).toEqual(cursor);
  });
  it('removes free policy reasons but keeps restrictive permission facts as non-executable control', () => {
    const data = { version: 1, blocked: true, futureAppointmentLimit: 2, reason: 'PRIVATE_REASON', updatedBy: 'demo-owner', updatedAt: recoveryNow };
    const result = classify('businesses/demo-business/clientPolicies/demo-client', data);
    expect(JSON.stringify(result)).not.toContain('PRIVATE_REASON');
    expect(result.kind).toBe('control'); expect(result.data.backupControl).toMatchObject({ version: 1, executable: false });
    expect(result.data.value).toMatchObject({ blocked: true, futureAppointmentLimit: 2 });
  });
  it('erases ciphertext from the first daily support backup and rejects unknown fields', () => {
    const digest = 'a'.repeat(64), anchor = { revision: 1, fingerprint: digest, receiptId: 'demo-receipt' };
    const encodedBody = Buffer.from('PRIVATE_CIPHERTEXT').toString('base64');
    const message = { version: 1, recordType: 'message', id: digest, conversationId: '123e4567-e89b-42d3-a456-426614174000', authorUid: 'demo-user', author: 'customer', requestDigest: digest, requestFingerprint: digest, sequence: 1, revision: 1, createdAt: recoveryNow, bodyExpiresAt: recoveryNow + 86400000, expiresAt: recoveryNow + 2592000000, bodyState: 'body_present', content: { version: 1, iv: 'a'.repeat(16), tag: 'a'.repeat(22) + '==', data: encodedBody }, account: anchor, support: anchor };
    const path = `platformSupportMessages/${digest}`, result = classify(path, message);
    expect(result.data.content).toBeNull(); expect(result.data.bodyState).toBe('body_erased');
    expect(JSON.stringify(result)).not.toContain('PRIVATE_CIPHERTEXT');
    expect(JSON.stringify(result)).not.toContain(encodedBody);
    expect(() => classify(path, { ...message, audio: 'PRIVATE' })).toThrow('D1_BACKUP_UNCLASSIFIED');
  });
  it('expired messages are explicitly excluded and unknown schema is never silently expired', () => {
    expect(() => classify('chatStates/demo-state', { expiresAt: recoveryNow - 1, secret: 'PRIVATE' })).toThrow('D1_BACKUP_UNCLASSIFIED');
    const result = classify('chatStates/demo-state', { version: 1, selection: {}, updatedAt: recoveryNow - 2000, expiresAt: recoveryNow - 1 });
    expect(result).toMatchObject({ kind: 'exclude', data: null, reasonCodes: ['EXPIRED'] });
  });
  it('classifies real team revocation and waitlist offer records produced by domain writers', async () => {
    const { memoryFirestore } = await import('./memoryFirestore');
    const { teamFixture, teamNow } = await import('./business-team-contract');
    const { requestTeamAccess, decideTeamAccess } = await import('@/lib/server/business-team');
    const { waitlistOffersFixture } = await import('./waitlist-offers-contract');
    const { subjectAdmin } = await import('./represented-booking-contract');
    const { waitlistNow } = await import('./waitlist-contract');
    const { createOwnerWaitlistOffer, withdrawOwnerWaitlistOffer } = await import('@/lib/server/waitlist-offers');
    const clock = vi.spyOn(Date, 'now').mockReturnValue(teamNow);
    vi.stubEnv('SARIN_TEAM_ACCESS_ENABLED', 'true'); vi.stubEnv('SARIN_WAITLIST_OFFERS_ENABLED', 'true'); vi.stubEnv('SUPERADMIN_UID', subjectAdmin.uid);
    const memory = memoryFirestore();
    try {
      const f = await teamFixture(memory.db), request = await requestTeamAccess(f.member, f.request, memory.db);
      const approved = await decideTeamAccess(f.owner, f.business.id, request.current.membershipId, { action: 'approve', requestId: 'demo-backup-approve', expectedMembershipRevision: 1, expectedTeamRevision: 1, resourceId: 'demo-chair' }, memory.db);
      await decideTeamAccess(f.owner, f.business.id, request.current.membershipId, { action: 'revoke', requestId: 'demo-backup-revoke', expectedMembershipRevision: approved.current.revision, expectedTeamRevision: 2 }, memory.db);
      clock.mockReturnValue(waitlistNow);
      const w = await waitlistOffersFixture(memory.db);
      const offered = await createOwnerWaitlistOffer(w.owner, w.business.id, w.recordId, { requestId: 'demo-backup-offer', entryId: w.first.request!.id, expectedWaitlistRevision: w.first.revision, expectedHeadRevision: 0, selection: { resourceId: 'one', startTimeStr: '09:00' } }, memory.db);
      await withdrawOwnerWaitlistOffer(w.owner, w.business.id, offered.recovery.offer.id, memory.db);
      const rejected = [...memory.rows].flatMap(([path, row]) => {
        if (row.data.type === 'manual_block' && !Object.hasOwn(row.data, 'startAt')) { expect(() => classifyBackupDocument(path, row.data, waitlistNow)).toThrow('D1_BACKUP_UNCLASSIFIED'); return []; }
        try { classifyBackupDocument(path, row.data, waitlistNow); return []; } catch { return [path]; }
      });
      expect(rejected).toEqual([]);
      for (const [path, row] of memory.rows) expect(() => classifyBackupDocument(path, { ...row.data, unexpectedSensitiveField: 'PRIVATE' }, waitlistNow), path).toThrow('D1_BACKUP_UNCLASSIFIED');
    } finally { clock.mockRestore(); vi.unstubAllEnvs(); }
  });
  it('does not archive a free manual block reason stored in serviceName', () => {
    const block = { ...recoveryAppointment, type: 'manual_block', serviceName: 'PRIVATE_BLOCK_REASON' };
    const result = classify('businesses/demo-business/appointments/demo-block', block);
    expect(JSON.stringify(result)).not.toContain('PRIVATE_BLOCK_REASON');
    expect(result.kind).toBe('control');
  });
  it('classifies real platform support, link, job and budget variants while removing their ciphertext', async () => {
    const { buildSupportScenario } = await import('./platform-support-fixtures');
    const { now } = await import('./platform-whatsapp-test-fixtures');
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const fixture = await buildSupportScenario();
      const rejected: string[] = [];
      for (const [path, data] of fixture.rows) {
        try {
          const result = classifyBackupDocument(path, data, now);
          if (typeof data.content === 'object' && data.content) expect(JSON.stringify(result)).not.toContain((data.content as { data: string }).data);
          if (data.recordType === 'budget_call') expect(result.data.effectToken).toBe(data.effectToken);
          expect(() => classifyBackupDocument(path, { ...data, unexpectedSensitiveField: 'PRIVATE' }, now), path).toThrow('D1_BACKUP_UNCLASSIFIED');
        } catch (error) { if ((error as Error).message === 'D1_BACKUP_UNCLASSIFIED') rejected.push(path); else throw error; }
      }
      expect(rejected).toEqual([]);
    } finally { clock.mockRestore(); vi.unstubAllEnvs(); }
  });
  it('accepts current WhatsApp index and control history and validates transient proposal selections', async () => {
    const { appendConversationControl } = await import('@/lib/server/whatsapp-conversations');
    expect(classify('whatsappBusinesses/demo-business', { phoneNumberId: '12345' }).data).toEqual({ phoneNumberId: '12345' });
    const base = { businessId: 'demo-business', phoneNumberId: '12345', wabaId: '23456', mode: 'bot', revision: 1, updatedAt: recoveryNow, lastInboundAt: null, lastHumanAt: null, controlChangedAt: recoveryNow, bodyExpiresAt: recoveryNow + 1000, expiresAt: recoveryNow + 2000 };
    const current = { ...base, ...appendConversationControl(base, 'human', 'demo-owner', 'admin', recoveryNow) };
    expect(classify('whatsappConversations/demo-conversation', current).data.controlEvents).toEqual(current.controlEvents);
    expect(classify('whatsappMessageIds/demo-message', { outboxId: 'demo-outbox', expiresAt: recoveryNow + 1000 }).data).toMatchObject({ outboxId: 'demo-outbox' });
    expect(classify('chatStates/demo-state', { version: 1, selection: { proposalId: 'demo-proposal' }, updatedAt: recoveryNow, expiresAt: recoveryNow + 1000 }).kind).toBe('exclude');
  });
  it('retains legal fractional prices without admitting unknown appointment kinds', () => {
    const result = classify('businesses/demo-business/appointments/demo-appointment', { ...recoveryAppointment, price: 1000.5 });
    expect(result.data.price).toBe(1000.5);
    expect(() => classify('businesses/demo-business/appointments/demo-appointment', { ...recoveryAppointment, type: 'clinical_note' })).toThrow('D1_BACKUP_UNCLASSIFIED');
  });
});
