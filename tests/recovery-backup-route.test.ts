import { describe, it, expect } from 'vitest';
import { authenticateRecoveryTrigger, runRecoveryBackup, cleanupRecoveryDirectory } from '../src/lib/server/recovery-backup';
import { signRecoveryWork } from '../shared/recovery-backup';
import { createRecoveryTestRuntime } from '../cloudflare/tests/recovery-runtime.mjs';
import { captureRecoveryComponents } from '../scripts/lib/recovery-components.mjs';
import { encryptBackupComponents } from '../scripts/lib/recovery-age.mjs';
import { recoveryMigrations,recoverySha,recoverySql } from './recovery-backup-fixtures';
import { mkdtemp,rm,access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,dirname,resolve } from 'node:path';
import { Readable } from 'node:stream';
import { execFileSync } from 'node:child_process';
const now=Date.now(), key='demo-'.repeat(10);
const work={backupId:'00000000-0000-4000-8000-000000000001',fence:1,nonce:'00000000-0000-4000-8000-000000000002',expiresAt:now+40*60000,deadlineAt:now+30*60000,attempt:0};
describe('private backup trigger',()=>{
  it('public_header_cannot_start_backup and signature is bound to exact work and deadline',async()=>{
    const request=(body:object,signature:string)=>new Request('http://localhost/api/internal/recovery-backup',{method:'POST',body:JSON.stringify(body),headers:{'x-sarin-backup-signature':signature}});
    expect(await authenticateRecoveryTrigger(request(work,'true'),{SARIN_BACKUP_ENABLED:'true',SARIN_BACKUP_HMAC_KEY:key},now)).toBeNull();
    const signature=await signRecoveryWork(work,key);
    expect(await authenticateRecoveryTrigger(request(work,signature),{SARIN_BACKUP_HMAC_KEY:key},now)).toBeNull();
    expect(await authenticateRecoveryTrigger(request(work,signature),{SARIN_BACKUP_ENABLED:'true',SARIN_BACKUP_HMAC_KEY:key,SARIN_MAINTENANCE:'true'},now)).toBeNull();
    expect(await authenticateRecoveryTrigger(request({...work,fence:2},signature),{SARIN_BACKUP_ENABLED:'true',SARIN_BACKUP_HMAC_KEY:key},now)).toBeNull();
    expect(await authenticateRecoveryTrigger(request(work,signature),{SARIN_BACKUP_ENABLED:'true',SARIN_BACKUP_HMAC_KEY:key},now)).toEqual(work);
    expect(await authenticateRecoveryTrigger(request(work,signature),{SARIN_BACKUP_ENABLED:'true',SARIN_BACKUP_HMAC_KEY:key},work.deadlineAt)).toBeNull();
  });
  it('a capture blocker cannot seal and singleton admits no second job',async()=>{
    let seals=0, failures=0;
    const status={phase:'failed',health:'missing'};
    const adapters:any={capture:async()=>({complete:false,blockers:['CONFIG_SECRET_MISSING']}),encrypt:async()=>{throw Error('must not encrypt');},bridge:async(op:string)=>{if(op==='seal')seals++;if(op==='fail')failures++;return status;},cleanup:async()=>{},now:()=>now};
    expect((await runRecoveryBackup(work,adapters)).phase).toBe('failed'); expect(seals).toBe(0); expect(failures).toBe(1);
  });
  it('timeout_after_seal_reads_outcome without repeating ciphertext or seal',async()=>{
    let seals=0, reads=0, uploads=0;
    const adapters:any={capture:async()=>({complete:true,blockers:[],snapshotTimes:{}}),encrypt:async()=>{uploads++;return {envelope:{backupId:work.backupId},manifest:{}};},bridge:async(op:string)=>{if(op==='seal'){seals++;throw Error('timeout');}if(op==='status'){reads++;return {phase:'sealed',health:'ok'};}return {};},cleanup:async()=>{},now:()=>now};
    expect((await runRecoveryBackup(work,adapters)).phase).toBe('sealed');expect(seals).toBe(1);expect(uploads).toBe(1);expect(reads).toBe(1);
  });
  it('captures and encrypts B1-B3 through real local Worker D1/R2, seals the claim ID and cleans plaintext',async()=>{
    const runtime=await createRecoveryTestRuntime(), root=await mkdtemp(join(tmpdir(),'sarin-recovery-')); let failure:unknown;
    const agePath=process.env.SARIN_TEST_AGE_PATH??(process.platform==='win32'?join(process.env.LOCALAPPDATA!,'SarinBot/tooling/age-1.3.2/windows/age/age.exe'):'/usr/local/bin/age');
    const keygen=join(dirname(agePath),process.platform==='win32'?'age-keygen.exe':'age-keygen');
    execFileSync(keygen,['-o',join(root,'identity.txt')],{stdio:'pipe',windowsHide:true});
    const recipient=execFileSync(keygen,['-y',join(root,'identity.txt')],{encoding:'utf8',windowsHide:true}).trim();
    const clock=Date.now(), w=await runtime.claim(clock), reference={version:'demo',sha256:'a'.repeat(64),privateSource:'operator/demo',observedAt:clock};
    const config={formatVersion:1,batchId:'demo',observedAt:clock,sourceSha:recoverySha,imageDigest:'sha256:'+'a'.repeat(64),migrations:recoveryMigrations,protocols:{quota:2},sections:Object.fromEntries(['providers','domains','indexes','rules','wif','access','bindings','flags'].map(k=>[k,reference])),requiredSecrets:[],secrets:[],passwordBatch:null};
    const bridge=async(op:string,value:any={},bytes?:Uint8Array)=>{const r=await runtime.call(w,op,value,bytes);if(!r.ok)throw Error('bridge '+op+' '+await r.text());return ['archive-get'].includes(op)?r:await r.json();};
    try{
      await bridge('consume');
      const result=await runRecoveryBackup(w,{
        bridge,
        capture:async signal=>{const c=await captureRecoveryComponents({directory:root,signal,source:{sourceSha:recoverySha,migrations:recoveryMigrations,exportSql:async()=>({stream:new Response(recoverySql()).body,bookmark:'demo',startedAt:clock,recoverableAt:clock,completedAt:clock}),readObject:async()=>{throw Error('no refs');}},auth:{listUsers:async()=>({users:[]})},config:{readInventory:async()=>config}}); failure=c.blockers;return c;},
        encrypt:async(capture,signal)=>{try{return await encryptBackupComponents(capture,{backupId:w.backupId,signal,recipient,agePath,destination:{async putIfAbsent(id:string,stream:any){const chunks:Buffer[]=[];for await(const b of stream)chunks.push(Buffer.from(b));const bytes=Buffer.concat(chunks);const {sha256}=await import('../scripts/lib/data-migration.mjs');await bridge('archive-put',{entry:{id,bytes:bytes.length,sha256:sha256(bytes)}},bytes);},async get(id:string){const response:Response=await bridge('archive-get',{id});return Readable.fromWeb(response.body as any);}}});}catch(e){failure=String(e);throw e;}},
        cleanup:()=>cleanupRecoveryDirectory(root),
      });
      expect(result.phase,JSON.stringify(failure)).toBe('sealed');
      await expect(access(root)).rejects.toThrow();
      const catalog=await runtime.db.prepare('SELECT envelope FROM backup_catalog').first();expect(JSON.parse(catalog!.envelope).backupId).toBe(w.backupId);
      expect((await runtime.db.prepare('SELECT count(*) AS n FROM backup_objects WHERE verified=0').first())!.n).toBe(0);
    }finally{await runtime.dispose();expect(dirname(resolve(root))).toBe(resolve(tmpdir()));await rm(root,{recursive:true,force:true});}
  },30000);
  it('a second local job stays closed until the first cleanup has finished',async()=>{
    let release!:()=>void, entered!:()=>void;
    const ready=new Promise<void>(r=>{entered=r;}), waiting=new Promise<void>(r=>{release=r;});
    const adapters:any={capture:async()=>{entered();await waiting;return {complete:false};},encrypt:async()=>{throw Error('no encrypt');},bridge:async()=>({phase:'failed'}),cleanup:async()=>{},now:()=>now};
    const first=runRecoveryBackup(work,adapters);await ready;
    await expect(runRecoveryBackup(work,adapters)).rejects.toThrow('RECOVERY_BUSY');release();await first;
    await expect(runRecoveryBackup(work,adapters)).resolves.toMatchObject({phase:'failed'});
    await expect(cleanupRecoveryDirectory(tmpdir())).rejects.toThrow('RECOVERY_CLEANUP');
  });
});
