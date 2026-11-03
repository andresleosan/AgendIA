import 'server-only';
import { createHash } from 'node:crypto';
import { getAdminDb } from '@/lib/firebase/admin';
import type { Database, Query, Transaction } from '@/lib/storage/types';
import type { Appointment } from '@/types/firestore';
import type { ChatActor } from '@/types/chat';
import { clientAppointmentSchema, clientAppointmentsQuerySchema, clientAppointmentsPageSchema, clientAppointmentInView, compareClientAppointments, type ClientAppointmentsQuery, type ClientAppointmentsPage } from '@/lib/client-appointments-pagination';
import { HttpError } from './http';
import { documentIdSchema } from './schemas';
import { appointmentRescheduleRevision } from './appointment-rescheduling';
import { readAttendanceMetadata } from '@/lib/appointment-attendance';

const changed=()=>new HttpError(409,'Tus citas cambiaron. Usa Actualizar citas para continuar.','CLIENT_APPOINTMENTS_CHANGED');
const invalid=()=>new HttpError(503,'No se pudieron verificar tus citas.','CLIENT_APPOINTMENTS_UNVERIFIABLE');
function verify(raw:unknown,id:string,businessId:string,uid:string):Appointment {
  const parsed=clientAppointmentSchema.safeParse(raw);
  if(!parsed.success || parsed.data.id!==id || parsed.data.tenantId!==businessId || parsed.data.client?.uid!==uid)throw invalid();
  try { appointmentRescheduleRevision(parsed.data); readAttendanceMetadata(parsed.data); } catch { throw invalid(); }
  return parsed.data;
}
function revision(row:Appointment) { return createHash('sha256').update(JSON.stringify([row.id,row.startAt,row.endAt,row.status,appointmentRescheduleRevision(row),readAttendanceMetadata(row)?.revision??0])).digest('hex'); }
async function business(tx:Transaction,db:Database,id:string) { const ref=db.collection('businesses').doc(documentIdSchema.parse(id));const row=await tx.get(ref);if(!row.exists)throw new HttpError(404,'El negocio no existe.');if(row.data()?.id!==id)throw invalid();return ref.collection('appointments'); }
export async function readClientAppointment(actor:ChatActor,businessId:string,id:string,db:Database=getAdminDb()):Promise<Appointment> {
  documentIdSchema.parse(id);
  return db.runTransaction(async tx=>{const root=await business(tx,db,businessId),doc=await tx.get(root.doc(id)),row=doc.data();if(!doc.exists||row?.client?.uid!==actor.uid||row?.tenantId!==businessId||row?.type!=='appointment')throw new HttpError(404,'La cita no existe.');return verify(row,doc.id,businessId,actor.uid);});
}
export async function readClientAppointmentsPage(actor:ChatActor,businessId:string,supplied:ClientAppointmentsQuery,db:Database=getAdminDb(),now=Date.now()):Promise<ClientAppointmentsPage> {
  const input=clientAppointmentsQuerySchema.parse(supplied),cursor=input.cursor,dateKey=input.dateKey??null,asOf=cursor?.asOf??now;
  if(cursor&&(cursor.businessId!==businessId||cursor.clientUid!==actor.uid||cursor.view!==input.view||cursor.dateKey!==dateKey||asOf>now||now-asOf>900000))throw changed();
  return db.runTransaction(async tx=>{
    const root=await business(tx,db,businessId),base=root.where('client.uid','==',actor.uid).where('type','==','appointment');
    if(cursor){const anchor=await tx.get(root.doc(cursor.appointmentId)),raw=anchor.data();if(!anchor.exists||raw?.client?.uid!==actor.uid||raw?.tenantId!==businessId||raw?.type!=='appointment')throw changed();const row=verify(raw,anchor.id,businessId,actor.uid);if(row.startAt!==cursor.startAt||revision(row)!==cursor.revision||!clientAppointmentInView(row,input.view,asOf,dateKey))throw changed();}
    const direction=input.view==='history'?'desc':'asc';
    let lower:number|undefined,upper:number|undefined;
    if(dateKey){lower=Date.parse(dateKey+'T00:00:00-05:00');upper=lower+86400000;}
    const statuses=input.view==='history'?['confirmed','completed','no_show','cancelled_by_client','cancelled_by_owner']:input.view==='upcoming'?['confirmed']:[null];
    const candidates:Appointment[]=[];
    for(const status of statuses){
      let filtered:Query=status?base.where('status','==',status):base;
      const endFilter=status==='confirmed'&&input.view!=='calendar';
      if(endFilter)filtered=filtered.where('endAt',input.view==='upcoming'?'>':'<=',asOf);
      const stream:Appointment[]=[];
      const collect=async(query:Query,limit:number)=>{if(limit<=0)return;const result=await tx.get(query.limit(limit));for(const doc of result.docs){const row=verify(doc.data(),doc.id,businessId,actor.uid);if(!clientAppointmentInView(row,input.view,asOf,dateKey)||stream.length>0&&compareClientAppointments(input.view,stream.at(-1)!,row)>=0||cursor&&compareClientAppointments(input.view,{id:cursor.appointmentId,startAt:cursor.startAt},row)>=0)throw invalid();stream.push(row);}if(result.docs.length>limit)throw invalid();};
      const order=(query:Query,tie=false)=>{let result=tie?query.orderBy('id','asc'):query.orderBy('startAt',direction).orderBy('id','asc');if(endFilter)result=result.orderBy('endAt','asc');return result;};
      if(cursor){
        await collect(order(filtered.where('startAt','==',cursor.startAt).where('id','>',cursor.appointmentId),true),21);
        if(stream.length<21){let tail=filtered.where('startAt',direction==='asc'?'>':'<',cursor.startAt);if(lower!==undefined)tail=tail.where('startAt','>=',lower).where('startAt','<',upper!);await collect(order(tail),21-stream.length);}
      }else{
        let first=filtered;if(lower!==undefined)first=first.where('startAt','>=',lower).where('startAt','<',upper!);else if(endFilter)first=first.where('startAt','>=',0);
        await collect(order(first),21);
      }
      candidates.push(...stream);
    }
    candidates.sort((a,b)=>compareClientAppointments(input.view,a,b));if(new Set(candidates.map(row=>row.id)).size!==candidates.length)throw invalid();
    const rows=candidates.slice(0,20),last=rows.at(-1);
    const page={scope:{businessId,clientUid:actor.uid},view:input.view,dateKey,asOf,checkedAt:now,rows,nextCursor:candidates.length>20&&last?{version:1 as const,businessId,clientUid:actor.uid,view:input.view,dateKey,asOf,appointmentId:last.id,startAt:last.startAt,revision:revision(last)}:null,coverage:{mode:'indexed_appointments' as const,completeness:'not_guaranteed' as const}};
    const parsed=clientAppointmentsPageSchema.safeParse(page);if(!parsed.success)throw invalid();return parsed.data;
  });
}
