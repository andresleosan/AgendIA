import { expect, it } from 'vitest';
import type { Database } from '@/lib/storage/types';
import type { Appointment } from '@/types/firestore';
import { readClientAppointmentsPage, readClientAppointment } from '@/lib/server/client-appointments-pagination';

export const paginationNow = Date.parse('2030-01-07T15:00:00Z');
export const paginationBusiness = 'demo-page-business', paginationActor = { uid: 'demo-page-client' };
export function paginationAppointment(id: string, extra: Partial<Appointment> = {}): Appointment {
  return { id, tenantId: paginationBusiness, type: 'appointment', status: 'confirmed', client: { uid: paginationActor.uid, name: 'Demo', email: '', intakeAnswers: {} }, serviceId: 'demo-cut', serviceName: 'Demo service', resourceId: 'demo-chair', dateKey: '2030-01-07', startTimeStr: '10:00', endTimeStr: '10:30', startAt: paginationNow + 3600000, endAt: paginationNow + 5400000, reservedUntilAt: paginationNow + 5400000, createdAt: paginationNow - 86400000, createdBy: 'sarin_client', ...extra };
}
export async function seedPagination(db: Database, rows: Appointment[]) {
  await db.collection('businesses').doc(paginationBusiness).set({ id: paginationBusiness, ownerUid: 'demo-owner', resources: [] });
  for (let i = 0; i < rows.length; i += 80) await db.runTransaction(async tx => { for (const row of rows.slice(i, i + 80)) tx.set(db.collection('businesses').doc(paginationBusiness).collection('appointments').doc(row.id), row); });
}
export function registerClientPaginationCases(handles: () => { db: Database; second: Database }) {
  it.each([999, 1000, 1001])('traverses %s mixed history rows with ties exactly once and no foreign records', async count => {
    const { db, second } = handles(), statuses = ['confirmed', 'completed', 'no_show', 'cancelled_by_client', 'cancelled_by_owner'] as const;
    const rows = Array.from({ length: count }, (_, i) => paginationAppointment(`demo-${String(i).padStart(4, '0')}`, { status: statuses[i % 5], startAt: paginationNow - 86400000 - (i % 23) * 1000, endAt: paginationNow - 43200000 }));
    await seedPagination(db, [...rows, paginationAppointment('demo-foreign', { client: { uid: 'demo-other', name: '', email: '', intakeAnswers: {} } }), paginationAppointment('demo-manual', { type: 'manual_block' })]);
    const ids: string[] = []; let cursor; let pages = 0;
    do { const page = await readClientAppointmentsPage(paginationActor, paginationBusiness, { version: 1, view: 'history', ...(cursor ? { cursor } : {}) }, pages % 2 ? second : db, paginationNow); expect(page.rows.length).toBeLessThanOrEqual(20); ids.push(...page.rows.map(row => row.id)); cursor = page.nextCursor; pages++; } while (cursor && pages < 60);
    const expected = [...rows].sort((a,b) => b.startAt - a.startAt || (a.id < b.id ? -1 : 1)).map(row => row.id);
    expect(ids).toEqual(expected); expect(new Set(ids).size).toBe(count); expect(pages).toBe(Math.ceil(count / 20));
  }, 90000);
  it('server upcoming predicate finds imminent and in-progress visits beyond 1001 old confirmed records', async () => {
    const { db } = handles();
    await seedPagination(db, [...Array.from({ length: 1001 }, (_, i) => paginationAppointment(`demo-old-${i}`, { startAt: paginationNow - 86400000, endAt: paginationNow - 43200000 })), paginationAppointment('demo-future'), paginationAppointment('demo-running', { startAt: paginationNow - 1000, endAt: paginationNow + 1000 }), paginationAppointment('demo-cancelled-future', { status: 'cancelled_by_owner' })]);
    const page = await readClientAppointmentsPage(paginationActor, paginationBusiness, { version: 1, view: 'upcoming' }, db, paginationNow);
    expect(page.rows.map(row => row.id)).toEqual(['demo-running', 'demo-future']); expect(page.nextCursor).toBeNull();
  }, 30000);
  it('validates cursor scope anchor revision and TTL without authorizing a foreign lookup', async () => {
    const { db, second } = handles(); await seedPagination(db, Array.from({ length: 22 }, (_, i) => paginationAppointment(`demo-${String(i).padStart(3,'0')}`)));
    const first = await readClientAppointmentsPage(paginationActor, paginationBusiness, { version: 1, view: 'upcoming' }, db, paginationNow), cursor = first.nextCursor!;
    await expect(readClientAppointmentsPage({ uid: 'demo-other' }, paginationBusiness, { version:1,view:'upcoming',cursor }, second,paginationNow)).rejects.toMatchObject({ status:409 });
    await expect(readClientAppointmentsPage(paginationActor, paginationBusiness, { version:1,view:'history',cursor }, second,paginationNow)).rejects.toMatchObject({ status:409 });
    await expect(readClientAppointmentsPage(paginationActor,paginationBusiness,{version:1,view:'upcoming',cursor},second,paginationNow+900001)).rejects.toMatchObject({status:409});
    const ref = db.collection('businesses').doc(paginationBusiness).collection('appointments').doc(cursor.appointmentId); await ref.set({ ...(await ref.get()).data(), status:'cancelled_by_owner' });
    await expect(readClientAppointmentsPage(paginationActor,paginationBusiness,{version:1,view:'upcoming',cursor},second,paginationNow)).rejects.toMatchObject({code:'CLIENT_APPOINTMENTS_CHANGED'});
    await expect(readClientAppointment({uid:'demo-other'},paginationBusiness,'demo-000',db)).rejects.toMatchObject({status:404});
  });
  it('uses Colombian midnight rather than the stored dateKey and validates canonical rows on point reads', async () => {
    const { db }=handles(), midnight=Date.parse('2030-01-07T05:00:00Z');
    await seedPagination(db,[paginationAppointment('demo-before',{startAt:midnight-1000,endAt:midnight+1000}),paginationAppointment('demo-at',{dateKey:'wrong',startAt:midnight,endAt:midnight+1000}),paginationAppointment('demo-after',{startAt:midnight+86400000,endAt:midnight+86401000})]);
    const page=await readClientAppointmentsPage(paginationActor,paginationBusiness,{version:1,view:'calendar',dateKey:'2030-01-07'},db,paginationNow);expect(page.rows.map(r=>r.id)).toEqual(['demo-at']);
    const ref=db.collection('businesses').doc(paginationBusiness).collection('appointments').doc('demo-at');await ref.set({...(await ref.get()).data(),id:'demo-mismatch'});
    await expect(readClientAppointment(paginationActor,paginationBusiness,'demo-at',db)).rejects.toMatchObject({status:503});
  });
}
