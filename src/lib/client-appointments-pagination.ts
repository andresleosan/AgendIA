import { z } from 'zod';
import { isDateKey } from '@/lib/sarin/availability';
import type { Appointment } from '@/types/firestore';

const id = z.string().min(1).max(128).refine(value => !/[^A-Za-z0-9_-]/.test(value));
const uid = z.string().min(1).max(128).refine(value => !/[\x00-\x1f\x7f]/.test(value));
const time = z.number().int().positive().safe().refine(value => Number.isFinite(new Date(value).getTime()));
const view = z.enum(['upcoming', 'history', 'calendar']);
const date = z.string().refine(isDateKey);
export type ClientAppointmentsView = z.infer<typeof view>;
export const clientAppointmentSchema = z.object({
  id, tenantId: id, type: z.literal('appointment'), status: z.enum(['confirmed', 'completed', 'no_show', 'cancelled_by_client', 'cancelled_by_owner']),
  startAt: time, endAt: time, client: z.object({ uid }).passthrough(),
  serviceId: id, serviceName: z.string(), resourceId: id,
  rescheduleRevision: z.number().int().nonnegative().safe().optional(),
}).passthrough().refine(row => row.endAt > row.startAt) as unknown as z.ZodType<Appointment>;
const cursor = z.object({ version: z.literal(1), businessId: id, clientUid: uid, view, dateKey: date.nullable(), asOf: time, appointmentId: id, startAt: time, revision: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export type ClientAppointmentsCursor = z.infer<typeof cursor>;
export const clientAppointmentsQuerySchema = z.object({ version: z.literal(1), view, dateKey: date.optional(), cursor: cursor.optional() }).strict().refine(value => (value.view === 'calendar') === (value.dateKey !== undefined), 'La fecha solo corresponde al calendario.');
export type ClientAppointmentsQuery = z.infer<typeof clientAppointmentsQuerySchema>;
export const clientAppointmentsPageSchema = z.object({
  scope: z.object({ businessId: id, clientUid: uid }).strict(), view, dateKey: date.nullable(), asOf: time, checkedAt: time,
  rows: z.array(clientAppointmentSchema).max(20), nextCursor: cursor.nullable(),
  coverage: z.object({ mode: z.literal('indexed_appointments'), completeness: z.literal('not_guaranteed') }).strict(),
}).strict().superRefine((page, context) => {
  if ((page.view === 'calendar') !== (page.dateKey !== null) || page.checkedAt < page.asOf) context.addIssue({ code:'custom',message:'Invalid temporal scope' });
  for (let i=0;i<page.rows.length;i++) {
    const row=page.rows[i];
    if (row.tenantId!==page.scope.businessId || row.client?.uid!==page.scope.clientUid || !clientAppointmentInView(row,page.view,page.asOf,page.dateKey) || i>0 && compareClientAppointments(page.view,page.rows[i-1],row)>=0) context.addIssue({code:'custom',message:'Invalid page rows'});
  }
  if (page.nextCursor) {
    const c=page.nextCursor,last=page.rows.at(-1);
    if (page.rows.length!==20 || !last || c.businessId!==page.scope.businessId || c.clientUid!==page.scope.clientUid || c.view!==page.view || c.dateKey!==page.dateKey || c.asOf!==page.asOf || c.appointmentId!==last.id || c.startAt!==last.startAt) context.addIssue({code:'custom',message:'Invalid continuation'});
  }
});
export type ClientAppointmentsPage = z.infer<typeof clientAppointmentsPageSchema>;
const colombia = new Intl.DateTimeFormat('en-CA',{timeZone:'America/Bogota',year:'numeric',month:'2-digit',day:'2-digit'});
export function clientAppointmentDateKey(value:number) { const parts=colombia.formatToParts(value);return ['year','month','day'].map(key=>parts.find(part=>part.type===key)?.value).join('-'); }
export function clientAppointmentInView(row:Appointment,selected:ClientAppointmentsView,asOf:number,dateKey:string|null=null) { return selected==='calendar'?clientAppointmentDateKey(row.startAt)===dateKey:selected==='upcoming'?row.status==='confirmed'&&row.endAt>asOf:row.status!=='confirmed'||row.endAt<=asOf; }
export function compareClientAppointments(selected:ClientAppointmentsView,a:{id:string;startAt:number},b:{id:string;startAt:number}) { return a.startAt===b.startAt?(a.id<b.id?-1:a.id>b.id?1:0):(selected==='history'?b.startAt-a.startAt:a.startAt-b.startAt); }
