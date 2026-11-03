import { createElement,act } from 'react';
import { create,type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach,afterEach,it,expect,vi } from 'vitest';
import { memoryFirestore } from './memoryFirestore';
import { seedPagination,paginationAppointment,paginationBusiness,paginationActor,paginationNow } from './client-appointments-pagination-storage-contract';
import { readClientAppointmentsPage,readClientAppointment } from '@/lib/server/client-appointments-pagination';
import { apiFetch,ApiError } from '@/lib/client/api';
import { useClientAppointmentsPage } from '@/hooks/use-client-appointments-page';
vi.mock('@/lib/client/api',async original=>({...await original<typeof import('@/lib/client/api')>(),apiFetch:vi.fn()}));
(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let renderer:ReactTestRenderer|undefined,db:ReturnType<typeof memoryFirestore>['db'],events:EventTarget;
let uid:string,epoch:number,live:boolean,fail:number|null,delayed:((value:unknown)=>void)|null,delayNext:boolean;
let controller:ReturnType<typeof useClientAppointmentsPage>;
type Props=Parameters<typeof useClientAppointmentsPage>[0];let props:Props;
function Harness(p:Props){controller=useClientAppointmentsPage(p);return null;}
async function mount(){await act(async()=>{renderer=create(createElement(Harness,props));});}
async function update(change:Partial<Props>){props={...props,...change};await act(async()=>renderer!.update(createElement(Harness,props)));}
async function focus(){await act(async()=>{events.dispatchEvent(new Event('focus'));});}
beforeEach(async()=>{
 vi.useFakeTimers();vi.setSystemTime(paginationNow);events=new EventTarget();vi.stubGlobal('window',events);uid=paginationActor.uid;epoch=1;live=true;fail=null;delayed=null;delayNext=false;
 db=memoryFirestore().db;await seedPagination(db,Array.from({length:45},(_,i)=>paginationAppointment(`demo-${String(i).padStart(3,'0')}`,{startAt:paginationNow+3600000+i*1000,endAt:paginationNow+5400000+i*1000})));
 props={businessId:paginationBusiness,userId:uid,authEpoch:epoch,isCurrentSession:(expected,current)=>live&&uid===expected&&epoch===current};
 vi.mocked(apiFetch).mockReset().mockImplementation(async(path,init,expected)=>{
  if(fail)throw new ApiError('Synthetic read error',fail);
  if(delayNext){delayNext=false;return new Promise(resolve=>{delayed=resolve;});}
  try{return path.endsWith('/query')?await readClientAppointmentsPage({uid:expected!},paginationBusiness,JSON.parse(String(init?.body)),db,Date.now()):{appointment:await readClientAppointment({uid:expected!},paginationBusiness,path.split('/').at(-1)!,db)};}catch(error){const e=error as {status:number;code:string;message:string};throw new ApiError(e.message,e.status,e.code);}
 });
});
afterEach(async()=>{await act(async()=>renderer?.unmount());renderer=undefined;vi.useRealTimers();vi.unstubAllGlobals();});
it('navigates twenty-row pages forward and back with real incoming cursors',async()=>{
 await mount();expect(controller.page?.rows).toHaveLength(20);await act(async()=>controller.next());expect(controller.page?.rows[0].id).toBe('demo-020');await act(async()=>controller.next());expect(controller.page?.rows).toHaveLength(5);await act(async()=>controller.previous());expect(controller.page?.rows[0].id).toBe('demo-020');
});
it('keeps the current page and position on background changes until explicit update',async()=>{
 await mount();await act(async()=>controller.next());await focus();expect(controller.changed).toBe(false);expect(controller.page?.rows[0].id).toBe('demo-020');
 const ref=db.collection('businesses').doc(paginationBusiness).collection('appointments').doc('demo-020');await ref.set({...(await ref.get()).data(),serviceName:'Changed service'});await focus();
 expect(controller.changed).toBe(true);expect(controller.page?.rows[0].serviceName).not.toBe('Changed service');const calls=vi.mocked(apiFetch).mock.calls.length;await act(async()=>controller.next());expect(vi.mocked(apiFetch)).toHaveBeenCalledTimes(calls);
 await act(async()=>controller.refresh());expect(controller.changed).toBe(false);expect(controller.page?.rows[0].id).toBe('demo-000');
});
it('an invalidated anchor retains the visible page but prevents continuation',async()=>{
 await mount();const anchor=controller.page!.nextCursor!.appointmentId;await act(async()=>controller.next());const ref=db.collection('businesses').doc(paginationBusiness).collection('appointments').doc(anchor);await ref.set({...(await ref.get()).data(),status:'cancelled_by_owner'});await focus();expect(controller.changed).toBe(true);expect(controller.page?.rows[0].id).toBe('demo-020');
});
it('late next-page responses cannot cross a new epoch with the same UID',async()=>{
 await mount();const old=controller.page!;delayNext=true;await act(async()=>controller.next());expect(delayed).not.toBeNull();epoch=2;await update({authEpoch:epoch});await act(async()=>{delayed!({...old,rows:old.rows.map(r=>({...r,serviceName:'STALE PRIVATE'}))});});expect(controller.page?.rows[0].id).toBe('demo-000');expect(JSON.stringify(controller.page)).not.toContain('STALE PRIVATE');
});
it('read failures do not produce a false empty and authorization loss clears the page',async()=>{
 await mount();fail=503;await focus();expect(controller.error).toBeTruthy();expect(controller.page?.rows).toHaveLength(20);fail=401;await focus();expect(controller.page).toBeNull();
});
it('a failed next page retains the preceding rows while retrying the requested continuation',async()=>{
 await mount();fail=503;await act(async()=>controller.next());expect(controller.error).toBeTruthy();expect(controller.page?.rows[0].id).toBe('demo-000');fail=null;await act(async()=>controller.retry());expect(controller.page?.rows[0].id).toBe('demo-020');
});
it('rejects a well-shaped own response that goes backwards across the incoming cursor',async()=>{
 await mount();const old=controller.page!;vi.mocked(apiFetch).mockResolvedValueOnce(old);await act(async()=>controller.next());expect(controller.changed).toBe(true);expect(controller.page?.rows[0].id).toBe('demo-000');
});
it('point lookup verifies an own appointment outside the page without navigating the list',async()=>{
 await mount();let row;await act(async()=>{row=await controller.lookup('demo-044');});expect(row).toMatchObject({id:'demo-044'});expect(controller.page?.rows[0].id).toBe('demo-000');
});

it('detects a previously read ID moved beyond an unchanged anchor rather than repeating it',async()=>{
 await mount();const ref=db.collection('businesses').doc(paginationBusiness).collection('appointments').doc('demo-000');const row=(await ref.get()).data()!;await ref.set({...row,startAt:paginationNow+3600000+19500,endAt:paginationNow+5400000+19500});await act(async()=>controller.next());expect(controller.changed).toBe(true);expect(controller.page?.rows[0].id).toBe('demo-000');
});
