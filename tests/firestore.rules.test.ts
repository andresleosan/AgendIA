import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { initializeTestEnvironment, assertFails, assertSucceeds, type RulesTestEnvironment } from '@firebase/rules-unit-testing';
import { collection, deleteDoc, doc, getDoc, getDocs, query, setDoc, updateDoc, where, setLogLevel } from 'firebase/firestore';

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('Firestore rules on real emulator', () => {
  let environment: RulesTestEnvironment;
  beforeAll(async () => {
    setLogLevel('silent');
    environment = await initializeTestEnvironment({ projectId: 'demo-sarin-rules', firestore: { rules: await readFile('firestore.rules', 'utf8') } });
  });
  beforeEach(async () => {
    await environment.clearFirestore();
    await environment.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      await Promise.all([
        setDoc(doc(db, 'businesses', 'one'), { ownerUid: 'owner-one', subscription: { status:'trial' } }),
        setDoc(doc(db, 'businesses', 'two'), { ownerUid: 'owner-two' }),
        setDoc(doc(db, 'publicBusinesses', 'private-island'), { id: 'one', name: 'Public projection' }),
        setDoc(doc(db, 'businesses', 'one', 'appointments', 'mine'), { client: { uid: 'customer' }, dateKey:'2026-10-14' }),
        setDoc(doc(db, 'businesses', 'one', 'appointments', 'other'), { client: { uid: 'another' }, dateKey:'2026-10-14' }),
        setDoc(doc(db, 'users', 'customer'), { isSuperadmin: false }),
        setDoc(doc(db, 'users', 'stale-admin'), { isSuperadmin: true, role:'superadmin' }),
        setDoc(doc(db, 'paymentReceipts', 'payment'), { ownerUid:'owner-one' }),
        setDoc(doc(db, 'paymentImages', 'payment'), { ownerUid:'owner-one', receiptDataUrl:'sensitive' }),
        setDoc(doc(db, 'serverSettings', 'ai'), { provider:'ollama', updatedAt:1 }),
        setDoc(doc(db, 'aiUsageCalls', 'synthetic-call'), { businessId:'one', promptTokens:100 }),
        setDoc(doc(db, 'aiUsageMonths', '2026-10'), { calls:1 }),
        setDoc(doc(db, 'aiUsageMonths', '2026-10', 'businesses', 'one'), { calls:1 }),
        setDoc(doc(db, 'aiUsageMeta', 'main'), { measurementStartedAt:1 }),
        setDoc(doc(db, 'responseQuotaScopes', 'business_one'), { initializedAt: 1 }),
        setDoc(doc(db, 'responseQuotaScopes', 'business_one', 'periods', 'initial'), { includedResponses: 700 }),
        setDoc(doc(db, 'responseQuotaTurns', 'synthetic-turn'), { status: 'reserved' }),
        setDoc(doc(db, 'whatsappNumbers', 'synthetic-number'), { businessId: 'one', enabled: false }),
        setDoc(doc(db, 'whatsappBusinesses', 'one'), { phoneNumberId: 'synthetic-number' }),
      ]);
    });
  });
  afterAll(async () => { await environment?.cleanup(); });
  it('denies quota attempts receipts and reconciliation reviews to every raw browser SDK', async () => {
    const paths = ['responseQuotaTurns/demo-turn', 'responseQuotaReceipts/demo-receipt', 'responseQuotaTurns/demo-turn/reviews/demo-review'];
    await environment.withSecurityRulesDisabled(async context => {
      for (const path of paths) await setDoc(doc(context.firestore(), path), { version: 2 });
    });
    for (const context of [environment.unauthenticatedContext(), ...['owner-one', 'customer', 'staff', 'stale-admin'].map(uid => environment.authenticatedContext(uid, { isSuperadmin: true }))]) {
      for (const path of paths) {
        const db = context.firestore(), ref = doc(db, path);
        await assertFails(getDoc(ref)); await assertFails(getDocs(collection(db, path.split('/').slice(0, -1).join('/'))));
        await assertFails(setDoc(ref, { version: 2 })); await assertFails(updateDoc(ref, { version: 3 })); await assertFails(deleteDoc(ref));
      }
    }
  });
  it('denies all owner reschedule proofs to browser SDKs while moved appointment reads remain authorized', async () => {
    const appointment = { client: { uid: 'customer' }, dateKey: '2030-01-07', status: 'confirmed', rescheduleRevision: 1, lastRescheduleProposalId: 'synthetic-proof', rescheduledAt: 1 };
    await environment.withSecurityRulesDisabled(async context => {
      await setDoc(doc(context.firestore(), 'businesses/one/appointments/mine'), appointment);
      await setDoc(doc(context.firestore(), 'businesses/one/ownerRescheduleProposals/synthetic-proof'), { actorUid: 'owner-one', commandFingerprint: 'a'.repeat(64), state: 'applied' });
    });
    for (const context of [environment.unauthenticatedContext(), environment.authenticatedContext('owner-one'), environment.authenticatedContext('customer'), environment.authenticatedContext('other-account'), environment.authenticatedContext('stale-admin', { isSuperadmin: true })]) {
      const db = context.firestore(), ref = doc(db, 'businesses/one/ownerRescheduleProposals/synthetic-proof');
      await assertFails(getDoc(ref)); await assertFails(getDocs(collection(db, 'businesses/one/ownerRescheduleProposals')));
      await assertFails(setDoc(doc(db, 'businesses/one/ownerRescheduleProposals/forged'), { actorUid: 'owner-one' }));
      await assertFails(updateDoc(ref, { state: 'applied' })); await assertFails(deleteDoc(ref));
    }
    for (const uid of ['owner-one', 'customer']) {
      const ref = doc(environment.authenticatedContext(uid).firestore(), 'businesses/one/appointments/mine');
      expect((await assertSucceeds(getDoc(ref))).data()).toEqual(appointment);
      await assertFails(updateDoc(ref, { rescheduleRevision: 2 }));
    }
  });
  it('denies private attendance audit to every browser SDK while authorized appointment reads preserve only metadata', async () => {
    const appointment = { client: { uid: 'customer' }, dateKey: '2026-10-14', status: 'completed', attendance: { revision: 1, lastEventId: 'synthetic-event' } };
    await environment.withSecurityRulesDisabled(async context => {
      await setDoc(doc(context.firestore(), 'businesses/one/appointments/mine'), appointment);
      await setDoc(doc(context.firestore(), 'businesses/one/attendanceEvents/synthetic-event'), { actorUid: 'owner-one', reason: 'recording_error', sequence: 1, appointmentId: 'mine' });
    });
    for (const context of [environment.unauthenticatedContext(), environment.authenticatedContext('owner-one'), environment.authenticatedContext('customer'), environment.authenticatedContext('other-account'), environment.authenticatedContext('stale-admin', { isSuperadmin: true })]) {
      const db = context.firestore(), ref = doc(db, 'businesses/one/attendanceEvents/synthetic-event');
      await assertFails(getDoc(ref));
      await assertFails(getDocs(collection(db, 'businesses/one/attendanceEvents')));
      await assertFails(getDocs(query(collection(db, 'businesses/one/attendanceEvents'), where('appointmentId', '==', 'mine'))));
      await assertFails(setDoc(doc(db, 'businesses/one/attendanceEvents/forged'), { actorUid: 'owner-one' }));
      await assertFails(updateDoc(ref, { reason: 'recording_error' }));
      await assertFails(deleteDoc(ref));
    }
    for (const uid of ['owner-one', 'customer']) {
      const ref = doc(environment.authenticatedContext(uid).firestore(), 'businesses/one/appointments/mine');
      const read = await assertSucceeds(getDoc(ref));
      expect(read.data()).toEqual(appointment);
      expect(read.data()).not.toHaveProperty('actorUid'); expect(read.data()).not.toHaveProperty('reason'); expect(read.data()).not.toHaveProperty('events');
      await assertFails(updateDoc(ref, { status: 'no_show', attendance: { revision: 2 } }));
    }
    await assertFails(getDoc(doc(environment.authenticatedContext('other-account').firestore(), 'businesses/one/appointments/mine')));
  });
  it('allows owner queries and denies cross-tenant reads and browser writes', async () => {
    const db = environment.authenticatedContext('owner-one').firestore();
    await assertSucceeds(getDoc(doc(db,'businesses','one')));
    await assertSucceeds(getDocs(query(collection(db,'businesses'),where('ownerUid','==','owner-one'))));
    await assertFails(getDoc(doc(db,'businesses','two')));
    await assertFails(updateDoc(doc(db,'businesses','one'),{'subscription.status':'active'}));
    await assertFails(setDoc(doc(db,'businesses','new'),{ownerUid:'owner-one'}));
  });
  it('denies invitation reads, commands and courtesy entitlement changes even with forged admin flags', async () => {
    for (const context of [environment.unauthenticatedContext(), environment.authenticatedContext('owner-one'), environment.authenticatedContext('stale-admin', { role: 'superadmin', isSuperadmin: true })]) {
      const db = context.firestore();
      for (const path of ['invitations/synthetic', 'serverSettings/invitation_command_synthetic', 'businessLogos/synthetic', 'businesses/one/clientPolicies/defaults', 'chatStates/synthetic', 'bookingProposals/synthetic', 'aiBudgetCalls/synthetic', 'aiBudgetPeriods/synthetic']) {
        await assertFails(getDoc(doc(db, path)));
        await assertFails(setDoc(doc(db, path), { state: 'redeemed' }));
      }
      await assertFails(getDocs(collection(db, 'invitations')));
      await assertFails(updateDoc(doc(db, 'businesses/one'), { 'subscription.paidTrial.source': 'invitation', 'subscription.paidTrial.invitationId': 'fake', 'subscription.paidTrial.accessSuspended': false }));
    }
  });
  it('forbids owners and clients from activating introductory access, resetting its counter or approving a receipt', async () => {
    for (const uid of ['owner-one', 'customer']) {
      const db = environment.authenticatedContext(uid).firestore();
      await assertFails(updateDoc(doc(db, 'businesses', 'one'), { 'subscription.paidTrial': { paymentId: 'forged', activatedAt: 1, appointmentLimit: 10, appointmentsUsed: 0 } }));
      await assertFails(updateDoc(doc(db, 'businesses', 'one'), { 'subscription.paidTrial.appointmentsUsed': 0 }));
      await assertFails(updateDoc(doc(db, 'publicBusinesses', 'private-island'), { 'subscription.paidTrial.appointmentsUsed': 0 }));
      await assertFails(updateDoc(doc(db, 'paymentReceipts', 'payment'), { status: 'approved', amountCOP: 5000 }));
    }
  });
  it('permits a signed in island get while denying enumeration and anonymous reads', async () => {
    const db = environment.authenticatedContext('customer').firestore();
    await assertSucceeds(getDoc(doc(db,'publicBusinesses','private-island')));
    await assertFails(getDocs(collection(db,'publicBusinesses')));
    await assertFails(getDoc(doc(environment.unauthenticatedContext().firestore(),'publicBusinesses','private-island')));
  });
  it('isolates appointment lists and forbids direct double-booking writes', async () => {
    const db = environment.authenticatedContext('customer').firestore();
    await assertSucceeds(getDocs(query(collection(db,'businesses','one','appointments'),where('client.uid','==','customer'))));
    await assertFails(getDoc(doc(db,'businesses','one','appointments','other')));
    await assertFails(getDocs(collection(db,'businesses','one','appointments')));
    await assertFails(setDoc(doc(db,'businesses','one','appointments','new'),{client:{uid:'customer'}}));
    await assertSucceeds(getDocs(collection(environment.authenticatedContext('owner-one').firestore(),'businesses','one','appointments')));
  });
  it('keeps reminder preferences and seen receipts private to authenticated server handlers', async () => {
    await environment.withSecurityRulesDisabled(async context => {
      await setDoc(doc(context.firestore(), 'businesses/one/reminderPreferences/synthetic'), { ownerUid: 'customer', businessId: 'one', enabled: true });
      await setDoc(doc(context.firestore(), 'businesses/one/reminderReceipts/synthetic'), { ownerUid: 'customer', businessId: 'one', seenAt: 1 });
    });
    for (const context of [environment.unauthenticatedContext(), environment.authenticatedContext('customer'), environment.authenticatedContext('owner-one'), environment.authenticatedContext('stale-admin', { isSuperadmin: true })]) {
      for (const name of ['reminderPreferences', 'reminderReceipts']) {
        const db = context.firestore();
        await assertFails(getDoc(doc(db, `businesses/one/${name}/synthetic`)));
        await assertFails(getDocs(collection(db, `businesses/one/${name}`)));
        await assertFails(setDoc(doc(db, `businesses/one/${name}/forged`), { ownerUid: 'customer', businessId: 'one' }));
      }
    }
  });
  it('keeps waitlist offer heads and receipts private from every browser principal', async () => {
    await environment.withSecurityRulesDisabled(async context => {
      for (const child of ['waitlistOfferHeads', 'waitlistOffers']) await setDoc(doc(context.firestore(), `businesses/one/${child}/record`), { businessId: 'one', clientUid: 'customer', ownerActorUid: 'owner-one', waitlistRecordId: 'record', state: 'offered' });
    });
    for (const context of [environment.unauthenticatedContext(), environment.authenticatedContext('customer'), environment.authenticatedContext('owner-one'), environment.authenticatedContext('other'), environment.authenticatedContext('stale-admin', { isSuperadmin: true })]) {
      for (const child of ['waitlistOfferHeads', 'waitlistOffers']) {
        const db = context.firestore(), ref = doc(db, `businesses/one/${child}/record`);
        await assertFails(getDoc(ref));
        await assertFails(getDocs(collection(db, `businesses/one/${child}`)));
        await assertFails(getDocs(query(collection(db, `businesses/one/${child}`), where('clientUid', '==', 'customer'))));
        await assertFails(setDoc(doc(db, `businesses/one/${child}/forged`), { clientUid: 'customer' }));
        await assertFails(updateDoc(ref, { state: 'booked' }));
        await assertFails(deleteDoc(ref));
      }
    }
  });
  it('keeps owner waitlist reviews private from every browser principal', async () => {
    await environment.withSecurityRulesDisabled(async context => { await setDoc(doc(context.firestore(), 'businesses/one/waitlistOwnerReviews/entry'), { businessId: 'one', waitlistRecordId: 'private-record', entryId: 'entry', reviewed: true }); });
    for (const context of [environment.unauthenticatedContext(), environment.authenticatedContext('customer'), environment.authenticatedContext('owner-one'), environment.authenticatedContext('other'), environment.authenticatedContext('stale-admin', { isSuperadmin: true })]) {
      const db = context.firestore();
      await assertFails(getDoc(doc(db, 'businesses/one/waitlistOwnerReviews/entry')));
      await assertFails(getDocs(collection(db, 'businesses/one/waitlistOwnerReviews')));
      await assertFails(setDoc(doc(db, 'businesses/one/waitlistOwnerReviews/entry'), { reviewed: false }));
    }
  });
  it('keeps active waitlist selections and cancellation tombstones private from browsers', async () => {
    await environment.withSecurityRulesDisabled(async context => {
      await setDoc(doc(context.firestore(), 'businesses/one/waitlistRequests/current'), { ownerUid: 'customer', businessId: 'one', revision: 1, request: { serviceId: 'private-service' } });
      await setDoc(doc(context.firestore(), 'businesses/one/waitlistRequests/empty'), { ownerUid: 'customer', businessId: 'one', revision: 2, request: null });
    });
    for (const context of [environment.unauthenticatedContext(), environment.authenticatedContext('customer'), environment.authenticatedContext('owner-one'), environment.authenticatedContext('stale-admin', { isSuperadmin: true })]) {
      const db = context.firestore();
      for (const id of ['current', 'empty']) await assertFails(getDoc(doc(db, `businesses/one/waitlistRequests/${id}`)));
      await assertFails(getDocs(query(collection(db, 'businesses/one/waitlistRequests'), where('ownerUid', '==', 'customer'))));
      await assertFails(setDoc(doc(db, 'businesses/one/waitlistRequests/forged'), { ownerUid: 'customer', businessId: 'one', request: null }));
    }
  });
  it('protects receipts and ignores a stale or forged superadmin profile flag', async () => {
    const owner = environment.authenticatedContext('owner-one').firestore();
    const stranger = environment.authenticatedContext('stale-admin').firestore();
    await assertSucceeds(getDoc(doc(owner,'paymentImages','payment')));
    await assertFails(getDoc(doc(stranger,'paymentImages','payment')));
    await assertFails(getDoc(doc(stranger,'paymentReceipts','payment')));
    await assertFails(getDoc(doc(stranger,'businesses','one')));
    const customer = environment.authenticatedContext('customer').firestore();
    await assertFails(updateDoc(doc(customer,'users','customer'),{isSuperadmin:true}));
    await assertFails(setDoc(doc(customer,'unknownPrivate','secret'),{content:'not accessible to clients'}));
  });
  it('keeps the global AI selection private and rejects direct browser changes, including forged admin claims', async () => {
    const contexts = [
      environment.unauthenticatedContext(),
      environment.authenticatedContext('owner-one'),
      environment.authenticatedContext('stale-admin', { role:'superadmin', isSuperadmin:true }),
    ];
    for (const context of contexts) {
      const db = context.firestore();
      await assertFails(getDoc(doc(db,'serverSettings','ai')));
      await assertFails(getDocs(collection(db,'serverSettings')));
      await assertFails(updateDoc(doc(db,'serverSettings','ai'),{provider:'deepseek'}));
      await assertFails(setDoc(doc(db,'serverSettings','other'),{provider:'deepseek'}));
    }
  });
  it('keeps usage records and aggregates private even from the business owner and forged admin claims', async () => {
    for (const context of [environment.unauthenticatedContext(), environment.authenticatedContext('owner-one'), environment.authenticatedContext('stale-admin', { role:'superadmin', isSuperadmin:true })]) {
      const db = context.firestore();
      for (const path of ['aiUsageCalls/synthetic-call', 'aiUsageMonths/2026-10', 'aiUsageMonths/2026-10/businesses/one', 'aiUsageMeta/main', 'aiUsageCalls/gemini_synthetic-call', 'aiUsageMonths/gemini_2026-10', 'aiUsageMonths/gemini_2026-10/businesses/one', 'aiUsageMeta/gemini']) {
        await assertFails(getDoc(doc(db, path)));
        await assertFails(setDoc(doc(db, path), { calls:0 }));
      }
      await assertFails(getDocs(collection(db, 'aiUsageCalls')));
      await assertFails(getDocs(collection(db, 'aiUsageMonths/2026-10/businesses')));
      await assertFails(getDocs(collection(db, 'aiUsageMonths/gemini_2026-10/businesses')));
    }
  });
  it('denies direct quota and WhatsApp configuration access even to owners and forged administrators', async () => {
    for (const context of [environment.unauthenticatedContext(), environment.authenticatedContext('owner-one'), environment.authenticatedContext('stale-admin', { role: 'superadmin', isSuperadmin: true })]) {
      const db = context.firestore();
      for (const path of ['responseQuotaScopes/business_one', 'responseQuotaScopes/business_one/periods/initial', 'responseQuotaTurns/synthetic-turn', 'whatsappNumbers/synthetic-number', 'whatsappBusinesses/one', 'whatsappInbox/synthetic', 'whatsappOutbox/synthetic', 'whatsappConversations/synthetic', 'whatsappMessageIds/synthetic', 'whatsappUsage/2026-10', 'whatsappUsage/2026-10/businesses/one']) {
        await assertFails(getDoc(doc(db, path)));
        await assertFails(setDoc(doc(db, path), { enabled: true, includedResponses: 999999 }));
      }
      await assertFails(getDocs(collection(db, 'responseQuotaScopes')));
      await assertFails(getDocs(collection(db, 'responseQuotaTurns')));
      await assertFails(getDocs(collection(db, 'whatsappNumbers')));
    }
  });
  it('keeps factual FAQ state and receipts private from every browser identity', async () => {
    await environment.withSecurityRulesDisabled(async context => {
      await setDoc(doc(context.firestore(), 'businesses/one/factualFaq/current'), { revision: 1, items: [{ topic: 'parking', answer: 'Synthetic' }] });
      await setDoc(doc(context.firestore(), 'businesses/one/factualFaqOperations/synthetic'), { actorUid: 'owner-one', commandFingerprint: 'a'.repeat(64) });
    });
    for (const context of [environment.unauthenticatedContext(), environment.authenticatedContext('owner-one'), environment.authenticatedContext('customer'), environment.authenticatedContext('other-account'), environment.authenticatedContext('stale-admin', { role: 'superadmin' })]) {
      for (const child of ['factualFaq', 'factualFaqOperations']) {
        const db = context.firestore(), ref = doc(db, `businesses/one/${child}/${child === 'factualFaq' ? 'current' : 'synthetic'}`);
        await assertFails(getDoc(ref)); await assertFails(setDoc(ref, { revision: 2 })); await assertFails(deleteDoc(ref));
        await assertFails(getDocs(collection(db, `businesses/one/${child}`)));
      }
    }
  });});
