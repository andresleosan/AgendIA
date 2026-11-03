import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import { createDataTestRuntime } from '../cloudflare/tests/data-runtime.mjs';
import { createCloudflareDatabase, StorageError } from '@/lib/storage/database';
import type { DataReadResult, DataCommitResult, DataCommand } from '../shared/data-protocol';
import type { Database } from '@/lib/storage/types';
import { registerClientPaginationCases,seedPagination,paginationAppointment,paginationActor,paginationBusiness,paginationNow } from './client-appointments-pagination-storage-contract';
import { readClientAppointmentsPage } from '@/lib/server/client-appointments-pagination';
describe('client pagination real D1',()=>{
  let runtime:Awaited<ReturnType<typeof createDataTestRuntime>>,db:Database,second:Database;
  beforeEach(async()=>{runtime=await createDataTestRuntime({captureSql:true});const connect=()=>createCloudflareDatabase(async command=>{const response=await runtime.fetch(command),data=await response.json() as DataReadResult|DataCommitResult;if(!response.ok)throw new StorageError(response.status,(data as unknown as {code:string}).code);return data;});db=connect();second=connect();},30000);
  afterEach(async()=>{await runtime?.dispose();});registerClientPaginationCases(()=>({db,second}));
  it('captures actual bounded queries and uses additive indexes without writes or temporary sorting',async()=>{
    await seedPagination(db,Array.from({length:25},(_,i)=>paginationAppointment(`demo-${i}`)));
    const observations:DataCommand[]=[];const inspected=createCloudflareDatabase(async command=>{observations.push(command);const response=await runtime.fetch(command),data=await response.json() as DataReadResult|DataCommitResult;if(!response.ok)throw new StorageError(response.status,(data as unknown as {code:string}).code);return data;});
    const first=await readClientAppointmentsPage(paginationActor,paginationBusiness,{version:1,view:'upcoming'},inspected,paginationNow);
    await readClientAppointmentsPage(paginationActor,paginationBusiness,{version:1,view:'upcoming',cursor:first.nextCursor!},inspected,paginationNow);
    expect(observations.some(command=>command.action==='commit')).toBe(false);
    const queries=observations.flatMap(command=>command.action==='read'&&command.read.kind==='query'?[command.read]:[]);
    expect(queries.length).toBeGreaterThan(0);
    for(const query of queries){expect(query.limit).toBeLessThanOrEqual(21);const explain=await runtime.explain!(query);expect(JSON.stringify(explain.plan)).toMatch(/app_client_page_status_(ascending|descending)/);expect(JSON.stringify(explain.plan)).not.toContain('TEMP B-TREE');}
  });
});
