import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Real Workerd/D1/R2 with synthetic SDK identity, fixed clock and no network. */
export async function createRecoveryTestRuntime() {
  const require=createRequire(import.meta.url), wrangler=createRequire(require.resolve('wrangler/package.json'));
  const {build}=wrangler('esbuild'), {Miniflare,convertV4MiniflareOptions}=wrangler('miniflare');
  const bundle=await build({stdin:{resolveDir:fileURLToPath(new URL('../',import.meta.url)),contents:`
    import {claimRecoveryBackup,handleRecoveryOutbound,cleanupRecoveryBackups} from './src/recovery-backup.ts';
    export default {async fetch(request,env){
      env.SARIN_APP={idFromName:()=>({toString:()=> 'demo-singleton'})};
      const now=Number(request.headers.get('x-demo-now'));
      if(new URL(request.url).pathname==='/claim')return Response.json(await claimRecoveryBackup(env,{backupId:crypto.randomUUID(),attempt:0,now}));
      if(new URL(request.url).pathname==='/cleanup')return Response.json(await cleanupRecoveryBackups(env,now,false));
      return handleRecoveryOutbound(new Request('http://sarin-backup.internal/execute',request),env,{className:'SarinApp',containerId:'demo-singleton'},request.headers.get('x-demo-realtime')==='true'?undefined:now);
    }};`},bundle:true,write:false,format:'esm',platform:'browser'});
  const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-10-13',d1Databases:{SARIN_RECOVERY_DB:'demo-control'},r2Buckets:{SARIN_BACKUPS:'demo-archives',SARIN_FILES:'demo-source'},bindings:{SARIN_BACKUP_ENABLED:'true',SARIN_BACKUP_CLEANUP_ENABLED:'true',SARIN_BACKUP_HMAC_KEY:'demo-'.repeat(10)}}));
  try{
    const db=await mf.getD1Database('SARIN_RECOVERY_DB');
    await db.exec(readFileSync(new URL('../recovery-migrations/0001_recovery_control.sql',import.meta.url),'utf8').replace(/^--.*$/gm,'').replace(/\r?\n/g,' '));
    const bucket=await mf.getR2Bucket('SARIN_BACKUPS');
    return {db,bucket,dispose:()=>mf.dispose(),claim:async now=>{const r=await mf.dispatchFetch('http://demo.test/claim',{headers:{'x-demo-now':String(now)}});return r.json();},call:async(work,op,value={},bytes,now=Date.now())=>{
      const command={work,op,...value};
      return mf.dispatchFetch('http://demo.test/execute',{method:'POST',headers:{'x-demo-now':String(now),'x-demo-realtime':String(now===null),...(bytes?{'x-sarin-backup-command':JSON.stringify(command)}:{})},body:bytes??JSON.stringify(command)});
    }};
  }catch(error){await mf.dispose();throw error;}
}
