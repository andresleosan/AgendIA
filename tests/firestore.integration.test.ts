import { seedOperationSummary, summaryBusinessId } from './owner-operation-summary-contract';
import { readOwnerOperationSummary } from '@/lib/server/owner-operation-summary';
import { ownerWaitlistFixture, seedOwnerWaitlistRows } from './owner-waitlist-contract';
import { readOwnerWaitlistPage, updateOwnerWaitlistReview } from '@/lib/server/owner-waitlist';
import { exportWaitlistData, deleteExportedWaitlistDataBatch, reconcileWaitlistDataErasure } from '@/lib/server/waitlist-data-maintenance';
import { seedFactualFaqScenario, factualFaqNow, syntheticFaqItems } from './business-factual-faq-contract';
import { saveOwnerFactualFaq, readOwnerFactualFaq } from '@/lib/server/business-factual-faq';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { deleteApp, getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { subjectAdmin, verifyStructuredCases, verifySubjectBindingAndWithdrawal, verifySubjectRaces, verifyLegacyPolicyCompatibility } from './represented-booking-contract';
import type { DecodedIdToken } from 'firebase-admin/auth';
import type { Firestore } from 'firebase-admin/firestore';
import { getAdminDb } from '@/lib/firebase/admin';
import { ownerRescheduleActor, ownerRescheduleBusiness, ownerRescheduleSource, seedOwnerRescheduleScenario } from './owner-rescheduling-contract';
import { readOwnerRescheduleSource, prepareOwnerReschedule, confirmOwnerReschedule } from '@/lib/server/owner-rescheduling';
import { createBusiness, getOwnedBusiness, publicBusiness } from '@/lib/server/businesses';
import { cancelAppointment, createAppointment } from '@/lib/server/bookings';
import { reviewPayment, submitReceipt } from '@/lib/server/billing';
import { businessConfigSchema, receiptSchema } from '@/lib/server/schemas';
import { readAdminAiUsage, recordAiUsage } from '@/lib/server/ai-usage';
import type { EngineUsageObservation } from '@/lib/sarin/engine';
import { reserveResponseQuota as reserveQuota, commitResponseQuota, releaseResponseQuota, getResponseQuota } from '@/lib/server/response-quota';
import { markResponseQuotaDispatch } from '@/lib/server/response-quota-store';
import { seedQuotaProtocol } from './response-quota-fixtures';
async function reserveResponseQuota(input: Parameters<typeof reserveQuota>[0], db: Parameters<typeof reserveQuota>[1]) {
  await seedQuotaProtocol(db!); return reserveQuota(input, db, undefined, { deadlineAt: Date.now() + 300000 });
}
import { ingestWhatsAppWebhook, persistWhatsAppReply, cleanupWhatsAppRetention, getWhatsAppUsage, whatsappHash } from '@/lib/server/whatsapp-store';
import { syntheticWhatsAppEnv, inbound, phoneId, wabaId } from './whatsapp-fixtures';
import { verifyInvitationLifecycle } from './invitation-contract';
import { readPublicBusinessLogo, saveBusinessLogo } from '@/lib/server/business-logos';
import sharp from 'sharp';
import { createBookingProposal, confirmBookingProposal } from '@/lib/server/booking-proposals';
import { updateClientPolicy } from '@/lib/server/client-policy';
import { acceptSyntheticConsent } from './consent-fixtures';
import { attendanceCorrectionCommand, attendanceFixture } from './appointment-attendance-contract';
import { updateAppointmentAttendance } from '@/lib/server/appointment-attendance';
import { clientPolicyKey } from '@/lib/server/client-policy';
import { toColombiaTimestamp } from '@/lib/sarin/availability';
import { readFileSync } from 'node:fs';
import { readOwnerClientRecord, ownerClientRecordCursorRevision } from '@/lib/server/owner-client-record';
import { ownerClientRecordPageSchema, type OwnerClientRecordCursor, type OwnerClientRecordFilter } from '@/lib/owner-client-record';
import { makeOwnerClientRecordAppointment, ownerClientRecordUid, ownerClientRecordResources } from './owner-client-record-fixture';

function user(uid: string): DecodedIdToken { return { uid, sub:uid, aud:'demo-sarin-bot', auth_time:0, exp:9999999999, iat:0, iss:'https://securetoken.google.com/demo-sarin-bot', firebase:{identities:{},sign_in_provider:'google.com'}, email:`${uid}@example.test`, name:uid }; }

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('real Firestore serializable operations', () => {
  let db: Firestore;
  const owner = user(`owner-${crypto.randomUUID()}`);
  const dateKey = new Intl.DateTimeFormat('en-CA',{timeZone:'America/Bogota',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(Date.now()+2*86400000));
  const config = businessConfigSchema.parse({ name:'Integration business', category:'Services', slug:`test-${crypto.randomUUID()}`, phoneWhatsApp:'573001234567',
    intakeFields:[], resources:[{id:'r',name:'Room',active:true}], services:[{id:'s',name:'Service',durationMinutes:60,bufferMinutes:15,price:100,resourceIds:['r']}],
    weeklySchedule:Object.fromEntries(Array.from({length:7},(_,day)=>[day,{isOpen:true,intervals:[{start:'09:00',end:'18:00'}]}])) });
  beforeAll(async () => {
    // This suite exercises the official Firestore emulator and its additional
    // cleanup APIs, beyond the application's smaller database interface.
    db = getAdminDb() as unknown as Firestore;
    await db.doc('platformSettings/main').set({ bankAccounts: [{ id: 'bank', bankName: 'Synthetic bank', accountType: 'Test', accountNumber: 'fixture-only', holderName: 'Fixture' }] }, { merge: true });
  });
  async function paidBusiness(identity: DecodedIdToken, chosenConfig = config) {
    await acceptSyntheticConsent(db, identity.uid);
    const existing = await getOwnedBusiness(identity.uid, db);
    if (!existing?.subscription.paidTrial && existing?.subscription.status !== 'active') {
      const uploaded = await submitReceipt(identity, { kind: 'paid_trial', bankSelected: 'bank', requestId: crypto.randomUUID(),
        receiptDataUrl: `data:image/webp;base64,${Buffer.from('RIFFxxxxWEBPfixture').toString('base64')}` }, db);
      await reviewPayment(uploaded.receipt.id, 'approve', undefined, db);
    }
    return createBusiness(identity, chosenConfig, db);
  }
  afterAll(async () => { if (db) { await db.terminate(); const app = getApps().find(value => value.name === 'sarin-admin'); if (app) await deleteApp(app); } });
  it('owner waitlist FIFO ties anchor and review CAS work with the real Admin SDK', async () => {
    const prior=process.env.SUPERADMIN_UID;process.env.SUPERADMIN_UID=subjectAdmin.uid;
    try {
      const date=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Bogota'}).format(Date.now()+86400000);
      const f=await ownerWaitlistFixture(db,'general',false,date),expected=await seedOwnerWaitlistRows(f),first=await readOwnerWaitlistPage(f.owner,f.business.id,{dateKey:date},db);
      const second=await readOwnerWaitlistPage(f.owner,f.business.id,{dateKey:date,cursor:first.nextCursor!},db),third=await readOwnerWaitlistPage(f.owner,f.business.id,{dateKey:date,cursor:second.nextCursor!},db);
      expect([first.rows.length,second.rows.length,third.rows.length]).toEqual([20,20,5]);expect([...first.rows,...second.rows,...third.rows].map(r=>r.recordId)).toEqual(expected.map(r=>r.recordId));
      await db.doc(`businesses/${f.business.id}/waitlistRequests/${first.nextCursor!.recordId}`).delete();
      await expect(readOwnerWaitlistPage(f.owner,f.business.id,{dateKey:date,cursor:first.nextCursor!},db)).rejects.toMatchObject({code:'OWNER_WAITLIST_CHANGED'});
      await acceptSyntheticConsent(db,f.owner.uid);const row=first.rows[0],command={requestId:'firestore-review-a',entryId:row.entryId,expectedWaitlistRevision:row.waitlistRevision,expectedReviewRevision:0,reviewed:true};
      const results=await Promise.allSettled([updateOwnerWaitlistReview(f.owner,f.business.id,row.recordId,command,db),updateOwnerWaitlistReview(f.owner,f.business.id,row.recordId,{...command,requestId:'firestore-review-b'},db)]);
      expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(results.find(r=>r.status==='rejected')).toMatchObject({reason:{status:409}});
      expect((await db.doc(`businesses/${f.business.id}/waitlistOwnerReviews/${row.entryId}`).get()).data()?.revision).toBe(1);
      const source=(await db.doc(`businesses/${f.business.id}/waitlistRequests/${row.recordId}`).get()).data()!;
      const batch=db.batch();for(let i=0;i<201;i++){const id='erase-'+String(i).padStart(4,'0');batch.create(db.doc(`businesses/${f.business.id}/waitlistOwnerReviews/${id}`),{version:2,businessId:f.business.id,waitlistRecordId:row.recordId,entryId:id,waitlistRevision:1,revision:1,reviewed:true,updatedAt:Date.now(),actorUid:f.owner.uid,lastOperation:{requestId:'erase-review-'+i,operationHash:'a'.repeat(64),appliedRevision:1}});}await batch.commit();
      const exported=await exportWaitlistData(db,{businessId:f.business.id,ownerUid:source.ownerUid});expect(exported.documents).toHaveLength(203);
      await deleteExportedWaitlistDataBatch(db,exported,{writersStopped:true});let progress=await reconcileWaitlistDataErasure(db,exported,{writersStopped:true});expect(progress.deletedCount).toBe(100);
      while(!progress.complete)progress=await deleteExportedWaitlistDataBatch(db,exported,{writersStopped:true,previous:progress});expect(progress.deletedCount).toBe(203);expect((await exportWaitlistData(db,exported.scope)).documents).toEqual([]);
    } finally { if(prior===undefined)delete process.env.SUPERADMIN_UID;else process.env.SUPERADMIN_UID=prior; }
  },60000);
  it('atomically moves owner appointment and receipt then serializes a destination competitor across Admin handles', async () => {
    expect(process.env.FIRESTORE_EMULATOR_HOST).toMatch(/^(?:127\.0\.0\.1|localhost):\d+$/);
    // gRPC deadlines combine Date.now() and new Date(); keep the SDK clock real.
    const now = Date.now(), sourceDate = new Date(now + 2 * 86400000).toISOString().slice(0, 10), targetDate = new Date(now + 9 * 86400000).toISOString().slice(0, 10);
    const business = { ...ownerRescheduleBusiness,
      subscription: { ...ownerRescheduleBusiness.subscription, currentPeriodEndsAt: now + 30 * 86400000 },
      weeklySchedule: Object.fromEntries(Array.from({ length: 7 }, (_, day) => [day, { isOpen: true, intervals: [{ start: '09:00', end: '17:00' }] }])),
    };
    const selection = { dateKey: sourceDate, startTimeStr: '10:00', resourceId: 'demo-chair' };
    const app = initializeApp({ projectId: 'demo-sarin-bot' }, `demo-owner-reschedule-${crypto.randomUUID()}`), secondDb = getFirestore(app);
    try {
      await seedOwnerRescheduleScenario(db, business);
      const ref = db.collection('businesses').doc(business.id), appointmentRef = ref.collection('appointments').doc(ownerRescheduleSource.id);
      await appointmentRef.set({ ...ownerRescheduleSource, dateKey: sourceDate, startAt: toColombiaTimestamp(sourceDate, '09:00'), endAt: toColombiaTimestamp(sourceDate, '09:30'), reservedUntilAt: toColombiaTimestamp(sourceDate, '09:45'), createdAt: now - 86400000 });
      const fresh = await readOwnerRescheduleSource(ownerRescheduleActor, business.id, ownerRescheduleSource.id, db);
      const first = await prepareOwnerReschedule(ownerRescheduleActor, business.id, ownerRescheduleSource.id, { ...fresh.expectation, requestId: 'demo-admin-first', selection: { ...selection, dateKey: targetDate, resourceId: 'demo-second' } }, db);
      const applied = await confirmOwnerReschedule(ownerRescheduleActor, business.id, first.proposal.id, secondDb);
      expect(applied.appointment).toMatchObject({ id: 'demo-source', dateKey: targetDate, resourceId: 'demo-second', rescheduleRevision: 1, client: ownerRescheduleSource.client, historicalMetadata: { imported: true } });
      expect((await ref.collection('bookingLocks').get()).size).toBe(3);
      expect((await ref.collection('ownerRescheduleProposals').doc(first.proposal.id).get()).data()).toMatchObject({ state: 'applied', result: applied.rescheduleResult });
      expect((await ref.get()).data()).toEqual(business);
      const source = await readOwnerRescheduleSource(ownerRescheduleActor, ownerRescheduleBusiness.id, ownerRescheduleSource.id, db);
      const { proposal } = await prepareOwnerReschedule(ownerRescheduleActor, ownerRescheduleBusiness.id, ownerRescheduleSource.id, { ...source.expectation, requestId: 'demo-admin-competitor', selection }, db);
      const outcomes = await Promise.allSettled([
        confirmOwnerReschedule(ownerRescheduleActor, ownerRescheduleBusiness.id, proposal.id, db),
        createAppointment({ uid: 'demo-other-client' }, ownerRescheduleBusiness.id, { ...selection, serviceId: 'demo-cut', clientPhone: '573001111111', intakeAnswers: {} }, 'demo-admin-booking', secondDb),
      ]);
      expect(outcomes.filter(value => value.status === 'fulfilled')).toHaveLength(1);
      const rows = await db.collection('businesses').doc(ownerRescheduleBusiness.id).collection('appointments').get();
      expect(rows.docs.map(row => row.data()).filter(row => row.status === 'confirmed' && row.dateKey === sourceDate && row.resourceId === 'demo-chair' && row.startAt < toColombiaTimestamp(sourceDate, '10:30') && row.reservedUntilAt > toColombiaTimestamp(sourceDate, '10:00'))).toHaveLength(1);
    } finally { await secondDb.terminate(); await deleteApp(app); }
  }, 60000);
  it('reads owner account records with 45 reservations, 25 ties, status filters, private minor DTO and changed anchors on real Admin SDK', async () => {
    expect(process.env.FIRESTORE_EMULATOR_HOST).toMatch(/^(?:127\.0\.0\.1|localhost):\d+$/);
    const app = initializeApp({ projectId: 'demo-sarin-bot' }, `demo-owner-record-${crypto.randomUUID()}`), secondDb = getFirestore(app);
    const businessId = `demo-record-${crypto.randomUUID()}`, owner = { uid: `demo-owner-${crypto.randomUUID()}` };
    const businessRef = db.collection('businesses').doc(businessId), appointments = businessRef.collection('appointments');
    const start = 1894024800000, sourceId = 'a0000';
    const rows = Array.from({ length: 45 }, (_, index) => makeOwnerClientRecordAppointment({
      id: `a${String(index).padStart(4, '0')}`, tenantId: businessId,
      startAt: index < 25 ? start : start - (index - 24) * 60000,
      status: (['confirmed', 'completed', 'no_show'] as const)[index % 3],
    }));
    const read = (cursor?: OwnerClientRecordCursor, filter: OwnerClientRecordFilter = 'all', actor = owner) => readOwnerClientRecord(actor, businessId, sourceId, { clientUid: ownerClientRecordUid, filter, ...(cursor ? { cursor } : {}) }, db);
    try {
      const batch = db.batch();
      batch.set(businessRef, { id: businessId, ownerUid: owner.uid, resources: ownerClientRecordResources, subscription: { status: 'expired' } });
      for (const row of rows) batch.set(appointments.doc(row.id), row);
      batch.set(appointments.doc('foreign-account'), makeOwnerClientRecordAppointment({ id: 'foreign-account', tenantId: businessId, client: { ...makeOwnerClientRecordAppointment().client!, uid: 'demo-another-account' } }));
      await batch.commit();
      for (const filter of ['all', 'completed', 'no_show'] as const) {
        const found: string[] = []; let cursor: OwnerClientRecordCursor | undefined;
        do {
          const page = await read(cursor, filter); expect(ownerClientRecordPageSchema.safeParse(page).success).toBe(true);
          expect(page.coverage).toEqual({ mode: 'indexed_appointments', completeness: 'not_guaranteed' });
          found.push(...page.rows.map(row => row.appointmentId)); cursor = page.nextCursor ?? undefined;
        } while (cursor);
        expect(found).toEqual(rows.filter(row => filter === 'all' || row.status === filter).map(row => row.id));
        expect(new Set(found).size).toBe(found.length);
        // Explicit cursor also exercises tail plus older for both small filters.
        const anchor = rows.filter(row => row.startAt === start && (filter === 'all' || row.status === filter)).at(-2)!;
        const tail = await read({ appointmentId: anchor.id, startAt: anchor.startAt, revision: ownerClientRecordCursorRevision(anchor) }, filter);
        expect(tail.rows.map(row => row.appointmentId)).toEqual(rows.filter(row => (filter === 'all' || row.status === filter) && row.id > anchor.id).slice(0, 20).map(row => row.id));
      }
      const page = await read();
      expect(page.rows[0].beneficiaryKind).toBe('represented_minor');
      expect(Object.keys(page.rows[0]).sort()).toEqual(['appointmentId', 'beneficiaryKind', 'dateKey', 'endAt', 'resourceLabel', 'startAt', 'status']);
      expect(JSON.stringify(page)).not.toMatch(/Synthetic|phone|email|intakeAnswers|subjectAuthorization|representationReview|receiptId/);
      for (const uid of [ownerClientRecordUid, 'demo-other-owner', 'demo-admin']) await expect(read(undefined, 'all', { uid })).rejects.toMatchObject({ status: 403 });
      await expect(readOwnerClientRecord(owner, businessId, sourceId, { clientUid: 'demo-guessed', filter: 'all' }, db)).rejects.toMatchObject({ status: 404 });
      const anchor = rows.find(row => row.id === page.nextCursor!.appointmentId)!;
      const remote = secondDb.collection('businesses').doc(businessId).collection('appointments').doc(anchor.id);
      for (const patch of [{ startAt: start + 1, rescheduleRevision: 1 }, { status: 'completed', attendance: { revision: 1, lastEventId: 'demo-correction' } }]) {
        await remote.set({ ...anchor, ...patch });
        await expect(read(page.nextCursor!)).rejects.toMatchObject({ status: 409, code: 'CLIENT_RECORD_CHANGED' });
      }
      await remote.delete(); await expect(read(page.nextCursor!)).rejects.toMatchObject({ status: 409, code: 'CLIENT_RECORD_CHANGED' });
      await remote.set(anchor);
      // Emulator success does not certify production composite-index availability.
      // Verify the deployed declaration independently; Admin SDK bypasses browser
      // rules, so owner authorization above must remain in the server domain.
      const declared = JSON.parse(readFileSync(new URL('../firestore.indexes.json', import.meta.url), 'utf8')).indexes;
      for (const status of [false, true]) expect(declared).toContainEqual({ collectionGroup: 'appointments', queryScope: 'COLLECTION', fields: [
        { fieldPath: 'client.uid', order: 'ASCENDING' }, { fieldPath: 'type', order: 'ASCENDING' },
        ...(status ? [{ fieldPath: 'status', order: 'ASCENDING' }] : []),
        { fieldPath: 'startAt', order: 'DESCENDING' }, { fieldPath: 'id', order: 'ASCENDING' },
      ] });
    } finally { await db.recursiveDelete(businessRef); await secondDb.terminate(); await deleteApp(app); }
  }, 120000);
  it('real Firestore orderBy omits missing ordering values and returned corrupt values fail closed without repairing data', async () => {
    expect(process.env.FIRESTORE_EMULATOR_HOST).toMatch(/^(?:127\.0\.0\.1|localhost):\d+$/);
    const businessId = `demo-record-legacy-${crypto.randomUUID()}`, sourceId = 'demo-source', owner = { uid: 'demo-legacy-owner' };
    const businessRef = db.collection('businesses').doc(businessId), appointments = businessRef.collection('appointments');
    const saved = makeOwnerClientRecordAppointment({ id: sourceId, tenantId: businessId });
    const noStart: Record<string, unknown> = { ...saved, id: 'missing-start' }, noId: Record<string, unknown> = { ...saved };
    delete noStart.startAt; delete noId.id;
    const read = () => readOwnerClientRecord(owner, businessId, sourceId, { clientUid: ownerClientRecordUid, filter: 'all' }, db);
    try {
      const batch = db.batch();
      batch.set(businessRef, { id: businessId, ownerUid: owner.uid, resources: ownerClientRecordResources });
      batch.set(appointments.doc(sourceId), saved); batch.set(appointments.doc('missing-start'), noStart); batch.set(appointments.doc('missing-id'), noId);
      await batch.commit();
      const before = (await appointments.orderBy('__name__').get()).docs.map(row => ({ id: row.id, data: row.data(), updateTime: row.updateTime.toMillis() }));
      const page = await read(); expect(page.rows.map(row => row.appointmentId)).toEqual([sourceId]);
      expect(page.coverage).toEqual({ mode: 'indexed_appointments', completeness: 'not_guaranteed' });
      expect((await appointments.orderBy('__name__').get()).docs.map(row => ({ id: row.id, data: row.data(), updateTime: row.updateTime.toMillis() }))).toEqual(before);
      await appointments.doc('corrupt').set({ ...saved, id: 'corrupt', startAt: saved.startAt + 1, rescheduleRevision: -1 });
      await expect(read()).rejects.toMatchObject({ status: 503, code: 'CLIENT_RECORD_UNVERIFIABLE' });
    } finally { await db.recursiveDelete(businessRef); }
  }, 120000);
  it('serializes attendance and corrections with appointment event and both locks through independent Admin SDK handles', async () => {
    // This test must never select a real Firebase project or a remote endpoint.
    expect(process.env.FIRESTORE_EMULATOR_HOST).toMatch(/^(?:127\.0\.0\.1|localhost):\d+$/);
    const app = initializeApp({ projectId: 'demo-sarin-bot' }, `demo-attendance-${crypto.randomUUID()}`), secondDb = getFirestore(app);
    try {
      const f = await attendanceFixture(db);
      // Real SDK deadlines mix new Date() and Date.now(); keep their real clock
      // intact and put only this saved occurrence on the previous Colombia day.
      const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() - 86400000));
      const appointment = { ...f.appointment, dateKey: day, startAt: toColombiaTimestamp(day, '09:00'), endAt: toColombiaTimestamp(day, '09:30'), reservedUntilAt: toColombiaTimestamp(day, '09:45') };
      await f.appointmentRef.set(appointment);
      const earliestRecordAt = Date.now();
      const save = (handle: Firestore, command = f.command as { requestId: string; expectedRevision: number; expectedRescheduleRevision: number; expectedStatus: 'confirmed' | 'completed' | 'no_show'; status: 'completed' | 'no_show'; correctionReason?: 'recording_error' }) => updateAppointmentAttendance(f.owner, f.business.id, f.appointment.id, command, handle);
      const outcomes = await Promise.allSettled([save(db), save(secondDb, { ...f.command, requestId: 'demo-admin-competitor', status: 'no_show' })]);
      expect(outcomes.filter(row => row.status === 'fulfilled')).toHaveLength(1);
      expect(outcomes.find(row => row.status === 'rejected')).toMatchObject({ reason: { code: 'ATTENDANCE_SOURCE_CHANGED' } });
      const first = (await f.appointmentRef.get()).data()!;
      const correction = { ...attendanceCorrectionCommand, expectedStatus: first.status as 'completed' | 'no_show', status: first.status === 'completed' ? 'no_show' as const : 'completed' as const };
      const changes = await Promise.allSettled([save(db, correction), save(secondDb, { ...correction, requestId: 'demo-admin-correction-competitor' })]);
      expect(changes.filter(row => row.status === 'fulfilled')).toHaveLength(1);
      expect(changes.find(row => row.status === 'rejected')).toMatchObject({ reason: { code: 'ATTENDANCE_SOURCE_CHANGED' } });
      const current = (await f.appointmentRef.get()).data()!;
      expect(current).toMatchObject({ attendance: { revision: 2 }, beneficiary: f.appointment.beneficiary, client: f.appointment.client, subjectAuthorization: f.appointment.subjectAuthorization });
      const events = await f.businessRef.collection('attendanceEvents').orderBy('sequence').get();
      expect(events.docs.map(row => row.data()?.sequence)).toEqual([1, 2]);
      expect(events.docs[1].id).toBe(current.attendance.lastEventId);
      for (const event of events.docs) {
        expect(event.data().recordedAt).toBeGreaterThanOrEqual(earliestRecordAt);
        expect(event.data().recordedAt).toBeLessThanOrEqual(Date.now());
        expect(event.data().source).toMatchObject({ dateKey: day, startAt: appointment.startAt, endAt: appointment.endAt, reservedUntilAt: appointment.reservedUntilAt });
      }
      for (const key of [`${day}_demo-chair`, `client_${clientPolicyKey(f.appointment.client!.uid)}`]) expect((await f.businessRef.collection('bookingLocks').doc(key).get()).data()).toMatchObject({ version: 2, updatedAt: events.docs[1].data()?.recordedAt });
      expect((await f.businessRef.collection('bookingLocks').get()).size).toBe(2);
      expect((await f.businessRef.collection('appointments').get()).size).toBe(1);
      expect((await f.businessRef.get()).data()).toEqual(f.business);
    } finally { await secondDb.terminate(); await deleteApp(app); }
  }, 120000);
  it('confirms the three subject cases with scoped authorization across independent Firestore handles', async () => {
    const prior = process.env.SUPERADMIN_UID; process.env.SUPERADMIN_UID = subjectAdmin.uid;
    const app = initializeApp({ projectId: 'demo-sarin-bot' }, `demo-subject-${crypto.randomUUID()}`), secondDb = getFirestore(app);
    try {
      await verifyStructuredCases(db, secondDb);
      await verifySubjectBindingAndWithdrawal(db, secondDb);
      await verifySubjectRaces(db, secondDb);
      await verifyLegacyPolicyCompatibility(db, secondDb);
    } finally { if (prior === undefined) delete process.env.SUPERADMIN_UID; else process.env.SUPERADMIN_UID = prior; await secondDb.terminate(); await deleteApp(app); }
  }, 120000);
  it('confirms proposals atomically with client policy and preserves replay on Firestore', async () => {
    const identity = user(`proposal-${crypto.randomUUID()}`), client = user(`client-${crypto.randomUUID()}`);
    const business = await paidBusiness(identity, { ...config, slug: `proposal-${crypto.randomUUID()}` });
    await acceptSyntheticConsent(db, client.uid, business);
    const proposal = await createBookingProposal(client, business.id, { serviceId: 's', resourceId: 'r', dateKey, startTimeStr: '10:00' }, crypto.randomUUID(), db);
    await updateClientPolicy(identity, business.id, { clientUid: client.uid, blocked: true, reason: 'Synthetic review' }, db);
    await expect(confirmBookingProposal(client, business.id, proposal.id, { clientPhone: '573001234567', intakeAnswers: {} }, db)).rejects.toMatchObject({ code: 'CLIENT_BLOCKED' });
    await updateClientPolicy(identity, business.id, { clientUid: client.uid, blocked: false, reason: 'Synthetic release' }, db);
    const results = await Promise.all([confirmBookingProposal(client, business.id, proposal.id, { clientPhone: '573001234567', intakeAnswers: {} }, db), confirmBookingProposal(client, business.id, proposal.id, { clientPhone: '573001234567', intakeAnswers: {} }, db)]);
    expect(results[0].id).toBe(results[1].id);
    await cancelAppointment(client, business.id, results[0].id, db);
    expect(await confirmBookingProposal(client, business.id, proposal.id, {} as never, db)).toMatchObject({ status: 'cancelled_by_client' });
  }, 60000);
  it('preserves invitation access, quota, suspension and concurrent payment invariants on Firestore', async () => {
    await verifyInvitationLifecycle(db, config, dateKey);
  }, 75000);
  it('keeps normalized business logos separate from profile photos and protects stale replacements on Firestore', async () => {
    const identity = user(`logo-${crypto.randomUUID()}`);
    const value = await paidBusiness(identity, { ...config, slug: `logo-${crypto.randomUUID()}` });
    const png = await sharp({ create: { width: 120, height: 60, channels: 4, background: 'blue' } }).png().toBuffer();
    const input = { logoDataUrl: `data:image/png;base64,${png.toString('base64')}`, expectedSha256: null };
    const saved = await saveBusinessLogo(identity, input, db);
    expect((await readPublicBusinessLogo(value.slug, saved.logo!.sha256, db)).length).toBeGreaterThan(12);
    await expect(saveBusinessLogo(identity, { logoDataUrl: null, expectedSha256: null }, db)).rejects.toMatchObject({ code: 'BRANDING_CHANGED' });
    await saveBusinessLogo(identity, { logoDataUrl: null, expectedSha256: saved.logo!.sha256 }, db);
    await expect(readPublicBusinessLogo(value.slug, saved.logo!.sha256, db)).rejects.toMatchObject({ status: 404 });
  }, 75000);
  it('persists one encrypted WhatsApp turn and reconciles duplicate delivery and quota exactly once', async () => {
    syntheticWhatsAppEnv();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('External HTTP prohibited in WhatsApp emulator test'); }));
    try {
      const waOwner = user(`wa-${crypto.randomUUID()}`);
      const business = await paidBusiness(waOwner, { ...config, slug: `wa-${crypto.randomUUID()}` });
      // This storage/delivery test starts from an already paid WhatsApp plan;
      // payment approval and external connection gates have separate coverage.
      const paidAt = Date.now(), paidUntil = paidAt + 30 * 86400000;
      const paid = { ...business, subscription: { ...business.subscription, status: 'active' as const, currentPeriodEndsAt: paidUntil } };
      await db.doc(`businesses/${business.id}`).set(paid);
      await db.doc(`publicBusinesses/${business.slug}`).set(publicBusiness(paid));
      await db.doc(`responseQuotaScopes/business_${business.id}/periods/fixture_whatsapp`).set({ id: 'fixture_whatsapp', source: 'subscription', planId: 'whatsapp', startsAt: paidAt, endsAt: paidUntil, includedResponses: 4500, extraResponses: 0, usedResponses: 0, reservedResponses: 0 });
      await db.collection('whatsappNumbers').doc(phoneId).set({ businessId: business.id, phoneNumberId: phoneId, wabaId, enabled: true, verifiedAt: Date.now(), updatedAt: Date.now() });
      await db.collection('whatsappBusinesses').doc(business.id).set({ phoneNumberId: phoneId });
      const messageId = `wamid.${crypto.randomUUID()}`, id = whatsappHash(phoneId, messageId);
      const payload = inbound(messageId);
      await Promise.all([ingestWhatsAppWebhook(payload, db), ingestWhatsAppWebhook(payload, db)]);
      const inboxes = await db.collection('whatsappInbox').where('businessId', '==', business.id).get();
      expect(inboxes.size).toBe(1);
      expect(JSON.stringify(inboxes.docs[0].data())).not.toMatch(/Reserva|573001112233/);
      const due = await db.collection('whatsappInbox').where('nextAttemptAt', '<=', Date.now()).orderBy('nextAttemptAt').limit(10).get();
      expect(due.docs.some(document => document.id === id)).toBe(true);
      const quota = await reserveResponseQuota({ businessId: business.id, actorUid: 'wa-synthetic-actor', mode: 'sarin_client', channel: 'whatsapp', requestId: id, fingerprint: 'b'.repeat(64) }, db);
      await markResponseQuotaDispatch(quota.reservation, 'b'.repeat(64), { providerCallId: null }, db);
      const identity = { quotaTurnId: quota.reservation.reservationId, expectedFingerprint: 'b'.repeat(64), expectedScopeId: quota.reservation.scopeId, reservation: quota.reservation };
      await db.collection('whatsappInbox').doc(id).update({ state: 'processing', leaseId: 'fixture-lease' });
      const response = { reply: 'Synthetic durable reply' };
      await persistWhatsAppReply(id, 'fixture-lease', response, quota.reservation, db, identity);
      await persistWhatsAppReply(id, 'fixture-lease', response, quota.reservation, db, identity);
      await commitResponseQuota(quota.reservation, undefined, db);
      await commitResponseQuota(quota.reservation, undefined, db);
      const status = { object: 'whatsapp_business_account', entry: [{ id: wabaId, changes: [{ field: 'messages', value: {
        messaging_product: 'whatsapp', metadata: { phone_number_id: phoneId }, statuses: [{ id: 'wamid.synthetic-delivered', status: 'read', timestamp: String(Math.floor(Date.now() / 1000)), biz_opaque_callback_data: id, pricing: { type: 'regular', category: 'service' } }],
      } }] }] };
      await ingestWhatsAppWebhook(status, db); await ingestWhatsAppWebhook(status, db);
      status.entry[0].changes[0].value.statuses[0].status = 'delivered'; await ingestWhatsAppWebhook(status, db);
      const usage = await getWhatsAppUsage(db);
      expect(usage.businesses.find(row => row.businessId === business.id)).toMatchObject({ sent: 1, delivered: 1, read: 1, regularDelivered: 1, serviceDelivered: 1 });
      expect(await getResponseQuota(business.id, db)).toMatchObject({ currentPeriod: { usedResponses: 1, reservedResponses: 0 } });
      const outbox = await db.collection('whatsappOutbox').doc(id).get();
      expect(outbox.data()?.state).toBe('delivered');
      expect(JSON.stringify(outbox.data())).not.toMatch(/Synthetic durable reply|573001112233/);
      await cleanupWhatsAppRetention(db, Date.now() + 86_400_001);
      expect((await db.collection('whatsappInbox').doc(id).get()).data()?.content).toBeNull();
      expect((await db.collection('whatsappOutbox').doc(id).get()).data()?.content).toBeNull();
      expect(fetch).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); vi.unstubAllEnvs(); }
  }, 75000);
  it('atomically records a repeated provider call once across the ledger and both monthly totals', async () => {
    const callId = crypto.randomUUID();
    const businessId = `usage-${crypto.randomUUID()}`;
    const startedAt = Date.parse('2098-07-15T12:00:00Z');
    const observation: EngineUsageObservation = { callId, provider: 'deepseek', model: 'deepseek-flash', startedAt, finishedAt: startedAt + 1, success: true,
      usage: { promptTokens: 1000, cacheHitTokens: 800, cacheMissTokens: 200, completionTokens: 100, totalTokens: 1100 } };
    const scope = { businessId, mode: 'sarin_client' as const };
    await Promise.all([recordAiUsage(observation, scope, db), recordAiUsage(observation, scope, db)]);
    // The recorder bounds the chat wait, not the lifetime of a contended RPC.
    // Observe the eventual commit before asserting atomic stored totals.
    await expect.poll(async () => (await db.doc('aiUsageMonths/2098-07').get()).data()?.calls, { timeout: 50000, interval: 100 }).toBe(1);
    const usage = await readAdminAiUsage('2098-07', db);
    expect(usage.totals).toMatchObject({ calls: 1, successfulCalls: 1, usageReportedCalls: 1, promptTokens: 1000, completionTokens: 100, estimatedCostUSD: { min: 0.0000924, max: 0.0001848 } });
    expect(usage.businesses).toHaveLength(1);
    expect(usage.businesses[0]).toMatchObject({ businessId, calls: 1 });
    const ledger = await db.collection('aiUsageCalls').where('businessId', '==', businessId).get();
    expect(ledger.size).toBe(1);
    expect(ledger.docs[0].id).toBe(callId);
    expect(usage.measurementStartedAt).toBe(startedAt);
  }, 60000);
  it('requires approved introductory payment before configuration and never publishes its private receipt ID', async () => {
    const firstOwner = user(`first-${crypto.randomUUID()}`);
    const firstConfig = { ...config, slug: `first-${crypto.randomUUID()}` };
    await acceptSyntheticConsent(db, firstOwner.uid);
    await expect(createBusiness(firstOwner, firstConfig, db)).rejects.toMatchObject({ status: 402 });
    const uploaded = await submitReceipt(firstOwner, { kind: 'paid_trial', bankSelected: 'bank', requestId: crypto.randomUUID(),
      receiptDataUrl: `data:image/webp;base64,${Buffer.from('RIFFxxxxWEBPfixture').toString('base64')}` }, db);
    expect(uploaded.receipt).toMatchObject({ kind: 'paid_trial', amountCOP: 5000, appointmentAllowance: 10, status: 'pending' });
    expect(uploaded.business.subscription.status).toBe('pending_payment');
    expect(uploaded.business.subscription.graceEndsAt).toBeUndefined();
    expect((await db.doc(`publicBusinesses/${firstConfig.slug}`).get()).exists).toBe(false);
    await expect(createBusiness(firstOwner, firstConfig, db)).rejects.toMatchObject({ status: 402 });
    const [approved, repeatedApproval] = await Promise.all([
      reviewPayment(uploaded.receipt.id, 'approve', undefined, db), reviewPayment(uploaded.receipt.id, 'approve', undefined, db),
    ]);
    expect(approved.business.subscription.paidTrial).toEqual(repeatedApproval.business.subscription.paidTrial);
    const [a,b] = await Promise.all([createBusiness(firstOwner,firstConfig,db),createBusiness(firstOwner,firstConfig,db)]);
    expect(a.id).toBe(b.id);
    expect(a.subscription.trialEndsAt).toBe(0);
    expect(a.subscription.paidTrial).toMatchObject({ paymentId: uploaded.receipt.id, appointmentLimit: 10, appointmentsUsed: 0 });
    const projection = (await db.doc(`publicBusinesses/${a.slug}`).get()).data();
    expect(projection?.ownerEmail).toBeUndefined(); expect(projection?.ownerUid).toBeUndefined();
    expect(projection?.subscription?.paidTrial?.paymentId).toBeUndefined();
    expect(projection?.subscription?.paidTrial).toMatchObject({ appointmentLimit: 10, appointmentsUsed: 0 });
  }, 75000);
  it('allows only one of two simultaneous reservations for an initially empty resource/day', async () => {
    const business = await paidBusiness(owner);
    const input={dateKey,startTimeStr:'10:00',resourceId:'r',serviceId:'s',clientPhone:'573001234567',intakeAnswers:{}};
    await acceptSyntheticConsent(db, 'client-a', business);
    await acceptSyntheticConsent(db, 'client-b', business);
    const results=await Promise.allSettled([createAppointment(user('client-a'),business.id,input,crypto.randomUUID(),db),createAppointment(user('client-b'),business.id,input,crypto.randomUUID(),db)]);
    expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1);
    const rejected=results.find(result=>result.status==='rejected');
    expect(rejected?.status==='rejected' && rejected.reason.status).toBe(409);
    const saved=await db.collection(`businesses/${business.id}/appointments`).get(); expect(saved.size).toBe(1);
    const appointment=saved.docs[0].data(); expect(appointment.reservedUntilAt-appointment.endAt).toBe(15*60000);
  });
  it('serializes the tenth introductory appointment across different resources and keeps retries and cancellations from resetting it', async () => {
    const cappedOwner = user(`capped-${crypto.randomUUID()}`);
    const cappedConfig = { ...config, slug: `capped-${crypto.randomUUID()}`,
      resources: [{ id: 'r', name: 'First', active: true }, { id: 'r2', name: 'Second', active: true }],
      services: [{ ...config.services[0], resourceIds: ['r', 'r2'] }] };
    const business = await paidBusiness(cappedOwner, cappedConfig);
    const subscription = { ...business.subscription, paidTrial: { ...business.subscription.paidTrial!, appointmentsUsed: 9 } };
    await db.doc(`businesses/${business.id}`).update({ subscription });
    const attempts = ['r', 'r2'].map(resourceId => ({ actor: user(`last-${resourceId}-${crypto.randomUUID()}`), requestId: crypto.randomUUID(),
      input: { dateKey, startTimeStr: '10:00', resourceId, serviceId: 's', clientPhone: '573001234567', intakeAnswers: {} } }));
    for (const attempt of attempts) await acceptSyntheticConsent(db, attempt.actor.uid, business);
    const results = await Promise.allSettled(attempts.map(attempt => createAppointment(attempt.actor, business.id, attempt.input, attempt.requestId, db)));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { status: 402 } });
    const winner = results.findIndex(result => result.status === 'fulfilled');
    const committed = results[winner];
    if (committed.status !== 'fulfilled') throw new Error('Expected one committed tenth appointment');
    const attempt = attempts[winner];
    expect((await createAppointment(attempt.actor, business.id, attempt.input, attempt.requestId, db)).id).toBe(committed.value.id);
    expect((await getOwnedBusiness(cappedOwner.uid, db))?.subscription.paidTrial?.appointmentsUsed).toBe(10);
    expect((await db.doc(`publicBusinesses/${business.slug}`).get()).data()?.subscription?.paidTrial).toMatchObject({ appointmentLimit: 10, appointmentsUsed: 10 });
    await cancelAppointment(attempt.actor, business.id, committed.value.id, db);
    await expect(createAppointment(attempt.actor, business.id, { ...attempt.input, startTimeStr: '12:00' }, crypto.randomUUID(), db)).rejects.toMatchObject({ status: 402 });
    await expect(submitReceipt(cappedOwner, { kind: 'paid_trial', bankSelected: 'bank', requestId: crypto.randomUUID(),
      receiptDataUrl: `data:image/webp;base64,${Buffer.from('RIFFxxxxWEBPfixture').toString('base64')}` }, db)).rejects.toMatchObject({ status: 409 });
    expect((await getOwnedBusiness(cappedOwner.uid, db))?.subscription.paidTrial?.appointmentsUsed).toBe(10);
  }, 75000);
  it('keeps image content out of payment lists and extends only once under concurrent approvals', async () => {
    await acceptSyntheticConsent(db, owner.uid);
    await db.doc('platformSettings/main').set({companyName:'Test',monthlyPriceCOP:49900,bankAccounts:[{id:'bank',bankName:'Configured test bank',accountType:'Savings',accountNumber:'fixture-only',holderName:'Fixture'}]});
    // A small raster signature fixture; production validation also imposes the byte cap.
    const input=receiptSchema.parse({bankSelected:'bank',requestId:crypto.randomUUID(),receiptDataUrl:`data:image/webp;base64,${Buffer.from('RIFFxxxxWEBPfixture').toString('base64')}`});
    const uploaded=await submitReceipt(owner,input,db);
    expect((await db.doc(`paymentReceipts/${uploaded.receipt.id}`).get()).data()?.receiptDataUrl).toBeUndefined();
    expect((await db.doc(`paymentImages/${uploaded.receipt.id}`).get()).data()?.receiptDataUrl).toBe(input.receiptDataUrl);
    const [a,b]=await Promise.all([reviewPayment(uploaded.receipt.id,'approve',undefined,db),reviewPayment(uploaded.receipt.id,'approve',undefined,db)]);
    expect(a.business.subscription.currentPeriodEndsAt).toBe(b.business.subscription.currentPeriodEndsAt);
    expect(a.business.subscription.currentPeriodEndsAt).toBeGreaterThanOrEqual(uploaded.receipt.submittedAt + 30 * 86400000);
    expect(a.business.subscription.currentPeriodEndsAt).toBeLessThanOrEqual(Date.now() + 30 * 86400000);
  });
  // Each plan runs two sequential races (upload and approval). Emulator locks
  // can take 30s to release per race; allow both plus 15s for setup/RPC overhead.
  // https://firebase.google.com/docs/emulator-suite/connect_firestore#transactions
  it.each([
    { planId: 'weekly', amountCOP: 20000, periodDays: 7 },
    { planId: 'fortnightly', amountCOP: 35000, periodDays: 15 },
    { planId: 'monthly', amountCOP: 59900, periodDays: 30 },
  ])('stores and approves $planId without repricing a pending receipt', async ({ planId, amountCOP, periodDays }) => {
    const planOwner = user(`plan-${crypto.randomUUID()}`);
    const business = await paidBusiness(planOwner, { ...config, slug: `plan-${crypto.randomUUID()}` });
    await db.doc('platformSettings/main').set({ weeklyPriceCOP: 20000, fortnightlyPriceCOP: 35000, monthlyPriceCOP: 59900,
      bankAccounts: [{ id: 'bank', bankName: 'Synthetic bank', accountType: 'Test', accountNumber: 'fixture-only', holderName: 'Fixture' }] });
    const input = receiptSchema.parse({ planId, bankSelected: 'bank', requestId: crypto.randomUUID(),
      receiptDataUrl: `data:image/webp;base64,${Buffer.from('RIFFxxxxWEBPfixture').toString('base64')}` });
    const [first, retried] = await Promise.all([submitReceipt(planOwner, input, db), submitReceipt(planOwner, input, db)]);
    expect(first.receipt.id).toBe(retried.receipt.id);
    expect(first.receipt).toMatchObject({ planId, amountCOP, periodDays, status: 'pending' });
    await db.doc('platformSettings/main').update({ weeklyPriceCOP: 25000, fortnightlyPriceCOP: 40000, monthlyPriceCOP: 65000 });
    const [approved, duplicate] = await Promise.all([
      reviewPayment(first.receipt.id, 'approve', undefined, db), reviewPayment(first.receipt.id, 'approve', undefined, db),
    ]);
    expect(approved.receipt).toMatchObject({ planId, amountCOP, periodDays, status: 'approved' });
    expect(approved.business.subscription.currentPeriodEndsAt).toBe(approved.receipt.reviewedAt! + periodDays * 86400000);
    expect(duplicate.business.subscription.currentPeriodEndsAt).toBe(approved.business.subscription.currentPeriodEndsAt);
    expect(approved.business.subscription.trialEndsAt).toBe(business.subscription.trialEndsAt);
    const receipts = await db.collection('paymentReceipts').where('ownerUid', '==', planOwner.uid).get();
    expect(receipts.docs.filter(document => document.data().kind === 'subscription')).toHaveLength(1);
    expect(receipts.docs.filter(document => document.data().kind === 'paid_trial')).toHaveLength(1);
  }, 75000);
  it('serializes the final response across client and owner and replays completion without another debit', async () => {
    const quotaOwner = user(`quota-${crypto.randomUUID()}`);
    const business = await paidBusiness(quotaOwner, { ...config, slug: `quota-${crypto.randomUUID()}` });
    const request = { businessId: business.id, actorUid: 'fixture-client', mode: 'sarin_client' as const, channel: 'web' as const, requestId: crypto.randomUUID(), fingerprint: 'a'.repeat(64) };
    const initial = await reserveResponseQuota(request, db);
    await releaseResponseQuota(initial.reservation, db);
    await db.collection('responseQuotaScopes').doc(initial.reservation.scopeId).collection('periods').doc(initial.reservation.periodId).update({ usedResponses: 699 });
    const inputs = [{ ...request, requestId: crypto.randomUUID() }, { ...request, actorUid: 'another-fixture-client', requestId: crypto.randomUUID() }];
    const results = await Promise.allSettled(inputs.map(input => reserveResponseQuota(input, db)));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { status: 402, code: 'AI_QUOTA_EXHAUSTED' } });
    const index = results.findIndex(result => result.status === 'fulfilled');
    const successful = results[index];
    if (successful.status !== 'fulfilled') throw new Error('Expected one successful reservation');
    await markResponseQuotaDispatch(successful.value.reservation, request.fingerprint, { providerCallId: null }, db);
    await commitResponseQuota(successful.value.reservation, undefined, db);
    expect(await reserveResponseQuota(inputs[index], db)).toMatchObject({ kind: 'replay', response: null });
    expect(await getResponseQuota(business.id, db)).toMatchObject({ state: 'exhausted', currentPeriod: { usedResponses: 700, reservedResponses: 0, remainingResponses: 0 } });
  }, 60000);
  it('approves a response pack once under contention without extending the paid period', async () => {
    const packOwner = user(`pack-${crypto.randomUUID()}`);
    const business = await paidBusiness(packOwner, { ...config, slug: `pack-${crypto.randomUUID()}` });
    await db.doc('platformSettings/main').set({ responsePackPriceCOP: 20000, bankAccounts: [{ id: 'bank', bankName: 'Synthetic bank', accountType: 'Test', accountNumber: 'fixture-only', holderName: 'Fixture' }] });
    const monthly = await submitReceipt(packOwner, { kind: 'subscription', planId: 'monthly', bankSelected: 'bank', requestId: crypto.randomUUID(),
      receiptDataUrl: `data:image/webp;base64,${Buffer.from('RIFFxxxxWEBPfixture').toString('base64')}` }, db);
    const paid = await reviewPayment(monthly.receipt.id, 'approve', undefined, db);
    const endsAt = paid.business.subscription.currentPeriodEndsAt;
    const input = receiptSchema.parse({ kind: 'response_pack', bankSelected: 'bank', requestId: crypto.randomUUID(), receiptDataUrl: `data:image/webp;base64,${Buffer.from('RIFFxxxxWEBPfixture').toString('base64')}` });
    const receipt = await submitReceipt(packOwner, input, db);
    const [first, duplicate] = await Promise.all([reviewPayment(receipt.receipt.id, 'approve', undefined, db), reviewPayment(receipt.receipt.id, 'approve', undefined, db)]);
    expect(first.receipt).toMatchObject({ kind: 'response_pack', responseAllowance: 1000, amountCOP: 20000, status: 'approved' });
    expect(first.business.subscription.currentPeriodEndsAt).toBe(endsAt);
    expect(duplicate.business.subscription.currentPeriodEndsAt).toBe(endsAt);
    expect(await getResponseQuota(business.id, db)).toMatchObject({ currentPeriod: { includedResponses: 3000, extraResponses: 1000, endsAt } });
  }, 60000);
  it('atomically saves factual FAQ and one receipt under owner CAS', async () => {
    // Keep gRPC deadlines on the real SDK clock.
    {
      const f = await seedFactualFaqScenario(db, Date.now()), command = { requestId: 'demo-firestore-faq-one', expectedRevision: 0, expectedPolicyRevision: 1, items: syntheticFaqItems };
      const results = await Promise.allSettled([saveOwnerFactualFaq(f.owner, f.business.id, command, db), saveOwnerFactualFaq(f.owner, f.business.id, { ...command, requestId: 'demo-firestore-faq-two' }, db)]);
      expect(results.filter(row => row.status === 'fulfilled')).toHaveLength(1);
      expect(results.find(row => row.status === 'rejected')).toMatchObject({ reason: { code: 'FACTUAL_FAQ_CHANGED' } });
      expect((await f.stateRef.get()).data()?.revision).toBe(1);
      expect((await f.operations.get()).docs).toHaveLength(1);
      const winner = results.find(row => row.status === 'fulfilled');
      if (winner?.status !== 'fulfilled') throw new Error('Missing winner');
      expect((await readOwnerFactualFaq(f.owner, f.business.id, winner.value.applied!.requestId, db)).applied).toEqual(winner.value.applied);
    }
  }, 60000);
  it('reads one bounded owner summary with legacy coverage and no writes on real Firestore', async () => {
    const f = await seedOperationSummary(db, Date.now()), today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(Date.now()), range = { from: today, through: today }, appointments = f.ref.collection('appointments');
    await appointments.doc('missing-date').set({ tenantId: summaryBusinessId, type: 'appointment', status: 'completed' });
    await appointments.doc('numeric-date').set({ tenantId: summaryBusinessId, type: 'appointment', status: 'completed', dateKey: 20300107 });
    const snap = async () => ({ business: (await f.ref.get()).data(), rows: (await appointments.get()).docs.map(doc => ({ id: doc.id, data: doc.data() })) });
    const before = await snap(), result = await readOwnerOperationSummary(f.owner, summaryBusinessId, range, db);
    expect(result.totals).toMatchObject({ total: 7, confirmed: 3, completed: 1, noShow: 1 });
    expect(result.coverage).toEqual({ basis: 'stored_date_key', invalidRecords: 1, excludedManualBlocks: 1 });
    expect(await snap()).toEqual(before);
    await expect(readOwnerOperationSummary(user('demo-other-owner'), summaryBusinessId, range, db)).rejects.toMatchObject({ status: 403 });
    for (let start = 0; start < 990; start += 90) {
      const batch = db.batch(); for (let i = start; i < Math.min(990, start + 90); i++) batch.set(db.doc(`businesses/${summaryBusinessId}/appointments/capacity-${i}`), { tenantId: summaryBusinessId, dateKey: today, type: 'manual_block' }); await batch.commit();
    }
    expect((await readOwnerOperationSummary(f.owner, summaryBusinessId, range, db)).totals.total).toBe(7);
    await appointments.doc('capacity-thousand').set({ tenantId: summaryBusinessId, dateKey: today, type: 'manual_block' });
    await expect(readOwnerOperationSummary(f.owner, summaryBusinessId, range, db)).rejects.toMatchObject({ status: 413, code: 'OPERATION_SUMMARY_RANGE_TOO_LARGE' });
  }, 60000);});
