import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createDataTestRuntime } from '../cloudflare/tests/data-runtime.mjs';
import { createCloudflareDatabase, StorageError } from '@/lib/storage/database';
import type { Database } from '@/lib/storage/types';
import type { DataCommand, DataCommitResult, DataReadResult } from '../shared/data-protocol';
import type { AttendanceCommand } from '@/lib/appointment-attendance';
import { readAppointmentAttendanceHistory, updateAppointmentAttendance } from '@/lib/server/appointment-attendance';
import { cancelAppointment } from '@/lib/server/bookings';
import { updateRepresentationReview } from '@/lib/server/representation-review';
import { clientPolicyKey } from '@/lib/server/client-policy';
import { createBookingProposal, confirmBookingProposalDetailed } from '@/lib/server/booking-proposals';
import { attendanceCorrectionCommand, attendanceFixture, attendanceNow } from './appointment-attendance-contract';
import { rescheduleActor, rescheduleBusiness, rescheduleContact, rescheduleNow, rescheduleSelection, rescheduleSource, seedRescheduleScenario } from './appointment-reschedule-contract';

let runtime: Awaited<ReturnType<typeof createDataTestRuntime>>, db: Database, secondDb: Database;
let before: ((command: DataCommand) => Promise<void> | void) | undefined;
let after: ((command: DataCommand) => Promise<void> | void) | undefined;
const connect = () => createCloudflareDatabase(async command => {
  await before?.(command);
  const response = await runtime.fetch(command), value = await response.json() as DataReadResult | DataCommitResult;
  if (!response.ok) throw new StorageError(response.status, (value as unknown as { code: string }).code);
  await after?.(command);
  return value;
});
beforeEach(async () => {
  vi.spyOn(Date, 'now').mockReturnValue(attendanceNow);
  before = undefined; after = undefined;
  runtime = await createDataTestRuntime(); db = connect(); secondDb = connect();
}, 30000);
afterEach(async () => { await runtime?.dispose(); vi.restoreAllMocks(); });
const snapshot = async () => (await runtime.db.prepare('SELECT * FROM app_documents ORDER BY path').all()).results;
const attendanceCommit = (command: DataCommand) => command.action === 'commit' && command.writes.some(write => write.path.includes('/attendanceEvents/'));
async function scenario() { return attendanceFixture(db); }
type Fixture = Awaited<ReturnType<typeof scenario>>;
const save = (f: Fixture, command: AttendanceCommand = f.command, handle = db) => updateAppointmentAttendance(f.owner, f.business.id, f.appointment.id, command, handle);
async function invariant(f: Fixture, events: number, lockVersion: number) {
  expect((await f.businessRef.collection('appointments').get()).size).toBe(1);
  expect((await f.businessRef.collection('attendanceEvents').get()).size).toBe(events);
  expect((await f.businessRef.get()).data()).toEqual(f.business);
  const locks = await f.businessRef.collection('bookingLocks').get();
  expect(locks.size).toBe(2);
  expect(locks.docs.map(row => row.id).sort()).toEqual(['2030-01-07_demo-chair', `client_${clientPolicyKey(f.appointment.client!.uid)}`].sort());
  for (const lock of locks.docs) expect(lock.data()?.version).toBe(lockVersion);
}

it('d1SerializesResultsAndCorrections', async () => {
  const f = await scenario();
  const outcomes = await Promise.allSettled([save(f), save(f, { ...f.command, requestId: 'demo-competitor', status: 'no_show' }, secondDb)]);
  expect(outcomes.filter(row => row.status === 'fulfilled')).toHaveLength(1);
  expect(outcomes.find(row => row.status === 'rejected')).toMatchObject({ reason: { code: 'ATTENDANCE_SOURCE_CHANGED' } });
  await invariant(f, 1, 1);
  const status = (await f.appointmentRef.get()).data()!.status as 'completed' | 'no_show';
  const command = { ...attendanceCorrectionCommand, expectedStatus: status, status: status === 'completed' ? 'no_show' as const : 'completed' as const };
  const corrections = await Promise.allSettled([save(f, command), save(f, { ...command, requestId: 'demo-correction-competitor' }, secondDb)]);
  expect(corrections.filter(row => row.status === 'fulfilled')).toHaveLength(1);
  expect(corrections.find(row => row.status === 'rejected')).toMatchObject({ reason: { code: 'ATTENDANCE_SOURCE_CHANGED' } });
  expect((await f.businessRef.collection('attendanceEvents').orderBy('sequence').get()).docs.map(row => row.data()?.sequence)).toEqual([1, 2]);
  await invariant(f, 2, 2);
}, 60000);

it('d1AttendanceAgainstCancel', async () => {
  const f = await scenario(); let interrupted = false;
  before = async command => {
    if (!interrupted && attendanceCommit(command)) { interrupted = true; before = undefined; await cancelAppointment(f.owner, f.business.id, f.appointment.id, secondDb); }
  };
  await expect(save(f)).rejects.toMatchObject({ status: 409 });
  expect((await f.appointmentRef.get()).data()).toMatchObject({ status: 'cancelled_by_owner', beneficiary: f.appointment.beneficiary, subjectAuthorization: f.appointment.subjectAuthorization });
  await invariant(f, 0, 1);
}, 60000);

it('d1AttendanceAgainstRepresentation', async () => {
  const f = await scenario(); let interrupted = false;
  before = async command => {
    if (!interrupted && attendanceCommit(command)) { interrupted = true; before = undefined; await updateRepresentationReview(f.owner, f.business.id, f.appointment.id, { expectedRevision: 1, status: 'needs_contact' }, secondDb); }
  };
  await save(f);
  expect((await f.appointmentRef.get()).data()).toMatchObject({ status: 'completed', attendance: { revision: 1 }, representationReview: { revision: 2, status: 'needs_contact' }, beneficiary: f.appointment.beneficiary, client: f.appointment.client, subjectAuthorization: f.appointment.subjectAuthorization });
  // Representation review updates only its appointment field; attendance alone
  // advances the resource/client locks.
  await invariant(f, 1, 1);
}, 60000);

it.each(['confirmation-first', 'attendance-first'] as const)('d1AttendanceAgainstDelayedReschedule: %s', async order => {
  const business = { ...rescheduleBusiness, services: [{ ...rescheduleBusiness.services[0], durationMinutes: 5, bufferMinutes: 0 }] };
  const source = { ...rescheduleSource, endTimeStr: '09:05', endAt: rescheduleSource.startAt + 300000, reservedUntilAt: rescheduleSource.startAt + 300000 };
  // A still-live ten-minute proposal crosses the saved source start and end.
  // An expired proposal would only test expiry, not the source-start guard.
  vi.mocked(Date.now).mockReturnValue(source.startAt - 60000);
  await seedRescheduleScenario(db, business);
  await db.collection('businesses').doc(business.id).collection('appointments').doc(source.id).set(source);
  const proposal = await createBookingProposal(rescheduleActor, rescheduleBusiness.id, rescheduleSelection, 'demo-delayed-reschedule', db, undefined, { appointmentId: rescheduleSource.id, sourceRevision: 0 });
  const businessRef = db.collection('businesses').doc(rescheduleBusiness.id);
  vi.mocked(Date.now).mockReturnValue(source.reservedUntilAt);
  expect(proposal.expiresAt).toBeGreaterThan(Date.now());
  const command = { requestId: 'demo-delayed-attendance', expectedRevision: 0, expectedRescheduleRevision: 0, expectedStatus: 'confirmed' as const, status: 'completed' as const };
  // Launch order alone does not order D1 reads. Exercise both serializations:
  // confirmed-but-started source, then already-completed source.
  let release!: () => void;
  const firstFinished = new Promise<void>(resolve => { release = resolve; });
  before = async command => {
    if (order === 'confirmation-first' && attendanceCommit(command)) await firstFinished;
    if (order === 'attendance-first' && command.action === 'read' && command.read.kind === 'document' && command.read.path === `bookingProposals/${proposal.id}`) await firstFinished;
  };
  const results = await Promise.allSettled([
    confirmBookingProposalDetailed(rescheduleActor, rescheduleBusiness.id, proposal.id, rescheduleContact, secondDb).finally(() => { if (order === 'confirmation-first') release(); }),
    updateAppointmentAttendance({ uid: rescheduleBusiness.ownerUid }, rescheduleBusiness.id, rescheduleSource.id, command, db).finally(() => { if (order === 'attendance-first') release(); }),
  ]);
  if (order === 'confirmation-first') expect(results[0]).toMatchObject({ status: 'rejected', reason: { code: 'RESCHEDULE_SOURCE_STARTED' } });
  else expect(results[0]).toMatchObject({ status: 'rejected', reason: { code: 'RESCHEDULE_SOURCE_CHANGED' } });
  expect(results[1]).toMatchObject({ status: 'fulfilled', value: { appointment: { status: 'completed', startAt: rescheduleSource.startAt } } });
  expect((await businessRef.collection('appointments').get()).size).toBe(1);
  expect((await businessRef.collection('attendanceEvents').get()).size).toBe(1);
  expect((await businessRef.get()).data()).toEqual(business);
  expect((await businessRef.collection('bookingLocks').get()).docs.map(row => row.data()?.version)).toEqual([1, 1]);
}, 60000);

it('d1ValidEarlierRescheduleWinnerRejectsStaleAttendanceRevision', async () => {
  vi.mocked(Date.now).mockReturnValue(rescheduleNow); await seedRescheduleScenario(db);
  const proposal = await createBookingProposal(rescheduleActor, rescheduleBusiness.id, rescheduleSelection, 'demo-earlier-reschedule', db, undefined, { appointmentId: rescheduleSource.id, sourceRevision: 0 });
  await confirmBookingProposalDetailed(rescheduleActor, rescheduleBusiness.id, proposal.id, rescheduleContact, secondDb);
  vi.mocked(Date.now).mockReturnValue(rescheduleSource.reservedUntilAt + 3600000);
  const prior = await snapshot();
  await expect(updateAppointmentAttendance({ uid: rescheduleBusiness.ownerUid }, rescheduleBusiness.id, rescheduleSource.id,
    { requestId: 'demo-stale-attendance', expectedRevision: 0, expectedRescheduleRevision: 0, expectedStatus: 'confirmed', status: 'completed' }, db)).rejects.toMatchObject({ code: 'ATTENDANCE_SOURCE_CHANGED' });
  expect(await snapshot()).toEqual(prior);
  expect((await db.collection('businesses').doc(rescheduleBusiness.id).collection('appointments').get()).size).toBe(1);
}, 60000);

it('d1AttendanceWinnerForcesConcurrentCancelToRetryAsTerminalNoop', async () => {
  const f = await scenario(); let interrupted = false;
  before = async command => {
    if (!interrupted && command.action === 'commit' && command.writes.some(write => write.path === f.appointmentRef.path)) {
      interrupted = true; before = undefined; await save(f, f.command, secondDb);
    }
  };
  expect(await cancelAppointment(f.owner, f.business.id, f.appointment.id, db)).toMatchObject({ status: 'completed', attendance: { revision: 1 } });
  await invariant(f, 1, 1);
}, 60000);

it('d1AttendanceWinnerSurvivesConcurrentRepresentationRetry', async () => {
  const f = await scenario(); let interrupted = false;
  before = async command => {
    if (!interrupted && command.action === 'commit' && command.writes.some(write => write.path === f.appointmentRef.path)) {
      interrupted = true; before = undefined; await save(f, f.command, secondDb);
    }
  };
  await updateRepresentationReview(f.owner, f.business.id, f.appointment.id, { expectedRevision: 1, status: 'needs_contact' }, db);
  expect((await f.appointmentRef.get()).data()).toMatchObject({ status: 'completed', attendance: { revision: 1 }, representationReview: { revision: 2, status: 'needs_contact' }, beneficiary: f.appointment.beneficiary, client: f.appointment.client, subjectAuthorization: f.appointment.subjectAuthorization });
  await invariant(f, 1, 1);
}, 60000);

it('d1LostCommitResponseUsesIdenticalJournaledCommit', async () => {
  const f = await scenario(), journal: DataCommand[] = [];
  after = command => { if (attendanceCommit(command)) { journal.push(structuredClone(command)); if (journal.length === 1) throw new StorageError(503, 'DATA_UNAVAILABLE'); } };
  const saved = await save(f);
  expect(journal).toHaveLength(2); expect(journal[1]).toEqual(journal[0]);
  expect(saved.appointment).toMatchObject({ status: 'completed', attendance: { revision: 1 } });
  await invariant(f, 1, 1);
}, 60000);

it('d1ReplayAfterLaterCorrectionNeverReverts', async () => {
  const f = await scenario(), journal: DataCommand[] = []; let corrected = false;
  after = async command => {
    if (!attendanceCommit(command) || corrected) return;
    journal.push(structuredClone(command)); corrected = true; after = undefined;
    await save(f, attendanceCorrectionCommand, secondDb);
    after = retry => { if (attendanceCommit(retry)) journal.push(structuredClone(retry)); };
    throw new StorageError(503, 'DATA_UNAVAILABLE');
  };
  const original = await save(f);
  expect(journal).toHaveLength(2); expect(journal[1]).toEqual(journal[0]);
  const prior = await snapshot(), replay = await save(f, f.command, secondDb);
  expect(replay).toMatchObject({ appointment: { status: 'no_show', attendance: { revision: 2 } }, applied: original.applied, replayed: true });
  expect(await snapshot()).toEqual(prior); await invariant(f, 2, 2);
}, 60000);

it('d1FailureBeforeCommitLeavesNeitherStateNorEvent', async () => {
  const f = await scenario(), prior = await snapshot();
  before = command => { if (attendanceCommit(command)) throw new StorageError(400, 'DATA_INVALID'); };
  await expect(save(f)).rejects.toMatchObject({ status: 400 });
  expect(await snapshot()).toEqual(prior);
}, 60000);

it('d1RetryReadsFreshClockAfterConflictingCommit', async () => {
  const f = await scenario(); let interrupted = false;
  before = async command => {
    if (!interrupted && attendanceCommit(command)) {
      interrupted = true; before = undefined;
      await secondDb.collection('users').doc('demo-force-conflict').set({ synthetic: true });
      vi.mocked(Date.now).mockReturnValue(attendanceNow - 1);
    }
  };
  await expect(save(f)).rejects.toMatchObject({ code: 'ATTENDANCE_TOO_EARLY' });
  expect((await f.appointmentRef.get()).data()).toEqual(f.appointment);
  expect((await f.businessRef.collection('attendanceEvents').get()).size).toBe(0);
  expect((await f.businessRef.collection('bookingLocks').get()).size).toBe(0);
}, 60000);

it('d1HistoryUsesIndexedBoundedAppointmentPagesAmong1001UnrelatedEvents', async () => {
  const f = await scenario();
  for (let sequence = 1; sequence <= 25; sequence++) {
    await save(f, { requestId: `demo-page-${sequence}`, expectedRevision: sequence - 1, expectedRescheduleRevision: 0,
      expectedStatus: sequence === 1 ? 'confirmed' : sequence % 2 ? 'no_show' : 'completed', status: sequence % 2 ? 'completed' : 'no_show',
      ...(sequence === 1 ? {} : { correctionReason: 'recording_error' }) });
  }
  const parent = `businesses/${f.business.id}/attendanceEvents`;
  const unrelated = Array.from({ length: 1001 }, (_, index) => ({ id: `demo-unrelated-${index}`, data: { appointmentId: `demo-other-${index}`, sequence: 1 } }));
  // Bound synchronous prepare/bind RPCs too, so idle sidecar sockets can close between batches.
  for (let offset = 0; offset < unrelated.length; offset += 100) await runtime.db.batch(unrelated.slice(offset, offset + 100).map(({ id, data }) => runtime.db.prepare('INSERT INTO app_documents(path,parent,document_id,data,updated_at,blob) VALUES(?,?,?,?,?,NULL)').bind(`${parent}/${id}`, parent, id, JSON.stringify(data), attendanceNow)));
  expect((await runtime.db.prepare('SELECT count(*) AS count FROM app_documents WHERE parent=?').bind(parent).first()).count).toBe(1026);
  const sql = "SELECT path,data,blob FROM app_documents WHERE parent=? AND json_type(data,'$.appointmentId') = 'text' AND json_extract(data,'$.appointmentId') = ? AND json_type(data,'$.sequence') IN ('integer','real') AND json_extract(data,'$.sequence') < ? AND json_type(data,'$.sequence') IN ('integer','real') ORDER BY json_extract(data,'$.sequence') DESC,path ASC LIMIT ?";
  const query = runtime.db.prepare(sql).bind(parent, f.appointment.id, 26, 21), result = await query.all();
  expect(result.results).toHaveLength(21);
  expect(result.meta.rows_read).toBeLessThan(50);
  const plan = await runtime.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(parent, f.appointment.id, 26, 21).all();
  expect(JSON.stringify(plan.results)).toContain('app_attendance_history');
  const first = await readAppointmentAttendanceHistory(f.owner, f.business.id, f.appointment.id, undefined, db);
  const second = await readAppointmentAttendanceHistory(f.owner, f.business.id, f.appointment.id, first.nextBeforeRevision!, secondDb);
  expect([...first.events, ...second.events].map(event => event.sequence)).toEqual(Array.from({ length: 25 }, (_, index) => 25 - index));
  expect(second.nextBeforeRevision).toBeNull();
}, 60000);
