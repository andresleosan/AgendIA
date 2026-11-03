import type { Appointment } from '@/types/firestore';
import { clientAppointmentSchema, clientAppointmentInView, compareClientAppointments, type ClientAppointmentsQuery } from '@/lib/client-appointments-pagination';
// UI fixtures model the new wire contract; cross-backend correctness is tested with the real reader.
export function clientAppointmentsFixture(rows: Appointment[], path: string, init?: RequestInit, uid?: string) {
  const businessId = path.split('/')[3], clientUid = uid ?? rows.find(row => row.tenantId === businessId)?.client?.uid ?? 'synthetic-client';
  const own = rows.filter(row => clientAppointmentSchema.safeParse(row).success && row.tenantId === businessId && row.type === 'appointment' && row.client?.uid === clientUid);
  if (!path.endsWith('/query')) return { appointment: own.find(row => row.id === decodeURIComponent(path.split('/').at(-1)!)) };
  const query: ClientAppointmentsQuery = JSON.parse(String(init?.body ?? '{"version":1,"view":"upcoming"}'));
  const asOf = query.cursor?.asOf ?? Date.now(), dateKey = query.dateKey ?? null;
  const matches = own.filter(row => clientAppointmentInView(row, query.view, asOf, dateKey)).sort((a, b) => compareClientAppointments(query.view, a, b))
    .filter(row => !query.cursor || compareClientAppointments(query.view, { id: query.cursor.appointmentId, startAt: query.cursor.startAt }, row) < 0);
  const visible = matches.slice(0, 20), last = visible.at(-1);
  return { scope: { businessId, clientUid }, view: query.view, dateKey, asOf, checkedAt: Date.now(), rows: visible,
    nextCursor: matches.length > 20 && last ? { version: 1, businessId, clientUid, view: query.view, dateKey, asOf, appointmentId: last.id, startAt: last.startAt, revision: 'a'.repeat(64) } : null,
    coverage: { mode: 'indexed_appointments', completeness: 'not_guaranteed' } };
}
