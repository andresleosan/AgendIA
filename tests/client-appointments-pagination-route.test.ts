import { beforeEach,expect,it,vi } from 'vitest';
import { memoryFirestore } from './memoryFirestore';
import { seedPagination,paginationBusiness,paginationAppointment,paginationActor } from './client-appointments-pagination-storage-contract';
const state=vi.hoisted(()=>({uid:'demo-page-client' as string|null,db:null as unknown}));
vi.mock('@/lib/firebase/admin',()=>({getAdminDb:()=>state.db}));
vi.mock('@/lib/server/auth',async()=>{const {HttpError}=await import('@/lib/server/http');return {requireUser:async()=>{if(!state.uid)throw new HttpError(401,'Login');return {uid:state.uid};}};});
import { POST } from '@/app/api/businesses/[id]/appointments/query/route';
import { GET as lookup } from '@/app/api/businesses/[id]/appointments/[appointmentId]/route';
import { GET as legacy } from '@/app/api/businesses/[id]/appointments/route';
const context={params:Promise.resolve({id:paginationBusiness})};
const request=(body:unknown,url='https://sarin.test/query')=>new Request(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
beforeEach(async()=>{state.uid=paginationActor.uid;const {db}=memoryFirestore();state.db=db;await seedPagination(db,[paginationAppointment('demo-own')]);});
it('requires authentication, keeps queries strict and errors no-store',async()=>{
 state.uid=null;let r=await POST(request({version:1,view:'upcoming'}),context);expect(r.status).toBe(401);expect(r.headers.get('cache-control')).toBe('no-store');state.uid=paginationActor.uid;
 for(const body of [{version:1,view:'upcoming',uid:'foreign'},{version:1,view:'calendar'},{version:1,view:'upcoming',limit:1000}]){r=await POST(request(body),context);expect(r.status).toBe(400);expect(r.headers.get('cache-control')).toBe('no-store');}
 expect((await POST(request({version:1,view:'upcoming'},'https://sarin.test/query?uid=foreign'),context)).status).toBe(400);
 expect((await POST(request({version:1,view:'upcoming',padding:'x'.repeat(5000)}),context)).status).toBe(413);
});
it('returns bounded metadata and private own-ID lookup, masking foreign and missing identically',async()=>{
 const r=await POST(request({version:1,view:'upcoming'}),context);expect(r.status).toBe(200);expect((await r.json()).rows).toHaveLength(1);expect(r.headers.get('cache-control')).toBe('no-store');
 const ctx={params:Promise.resolve({id:paginationBusiness,appointmentId:'demo-own'})};expect((await lookup(new Request('https://sarin.test/one'),ctx)).status).toBe(200);state.uid='demo-other';expect((await lookup(new Request('https://sarin.test/one'),ctx)).status).toBe(404);
 expect((await lookup(new Request('https://sarin.test/one'),{params:Promise.resolve({id:paginationBusiness,appointmentId:'demo-missing'})})).status).toBe(404);
});
it('requires old tabs to refresh rather than silently returning the first page as a full array',async()=>{
 const r=await legacy(new Request('https://sarin.test/appointments?view=mine'),context);expect(r.status).toBe(409);expect(await r.json()).toMatchObject({code:'CLIENT_APPOINTMENTS_UPGRADE_REQUIRED'});expect(r.headers.get('cache-control')).toBe('no-store');
});
