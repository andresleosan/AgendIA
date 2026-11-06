import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { claimRecoveryBackup, scheduleRecoveryBackup, recoveryStatus, handleRecoveryOutbound, planRecoveryRetention, cleanupRecoveryBackups, sourceObjectsPinned } from '../src/recovery-backup.ts';
import { signRecoveryWork } from '../../shared/recovery-backup.ts';
import { recoveryDigest } from '../../shared/recovery-backup.ts';
import { createRecoveryTestRuntime } from './recovery-runtime.mjs';

const at = Date.parse('2026-11-03T07:00:00Z');
function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../recovery-migrations/0001_recovery_control.sql', import.meta.url), 'utf8'));
  const db = { prepare(sql) { let values = []; return { bind(...v) { values = v; return this; }, async first() { return sqlite.prepare(sql).get(...values) ?? null; }, async all() { return { results: sqlite.prepare(sql).all(...values) }; }, async run() { const r = sqlite.prepare(sql).run(...values); return { meta: { changes: Number(r.changes) } }; } }; }, async batch(statements) { sqlite.exec('BEGIN'); try { const r = []; for (const s of statements) r.push(await s.run()); sqlite.exec('COMMIT'); return r; } catch(e) { sqlite.exec('ROLLBACK'); throw e; } } };
  const objects = new Map();
  const bucket = { async put(key, bytes, options) { if (options?.onlyIf && objects.has(key)) return null; objects.set(key, new Uint8Array(bytes)); return { key }; }, async get(key) { const b = objects.get(key); return b ? { size: b.length, body: new Response(b).body, async arrayBuffer() { return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); } } : null; }, async delete(key) { objects.delete(key); } };
  const env = { SARIN_BACKUP_ENABLED: 'true', SARIN_BACKUP_CLEANUP_ENABLED: 'false', SARIN_BACKUP_HMAC_KEY: 'demo-'.repeat(10), SARIN_RECOVERY_DB: db, SARIN_BACKUPS: bucket, SARIN_FILES: bucket, SARIN_DATA_BACKEND: 'd1', SARIN_BACKUP_EXPORT_TOKEN: 'demo-token', SARIN_BACKUP_ACCOUNT_ID: 'a'.repeat(32), SARIN_BACKUP_DATABASE_ID: '00000000-0000-4000-8000-000000000001', SARIN_BACKUP_DOWNLOAD_ORIGIN: 'https://demo.r2.cloudflarestorage.com', SARIN_BACKUP_RECIPIENT: 'age1' + 'a'.repeat(58), SARIN_APP: { idFromName: () => ({ toString: () => 'demo-singleton' }) } };
  env.SARIN_FILES = { ...bucket };
  env.SARIN_WITNESS_ENABLED = 'true'; env.SARIN_RECOVERY_RESOURCE_ID = 'a'.repeat(64);
  env.SARIN_DB = { prepare() { return { async first() { return { revision: 0 }; } }; } };
  sqlite.prepare('INSERT INTO recovery_witness_start VALUES(1,?,0,?)').run(env.SARIN_RECOVERY_RESOURCE_ID, at - 1000);
  return { env, db, sqlite, objects };
}
const ctx = { className: 'SarinApp', containerId: 'demo-singleton' };
async function work(f, now = at, attempt = 0) { return claimRecoveryBackup(f.env, { backupId: crypto.randomUUID(), attempt, now }); }
function call(f, lease, op, payload = {}, now = at) { return handleRecoveryOutbound(new Request('http://sarin-backup.internal/execute', { method: 'POST', body: JSON.stringify({ work: lease, op, ...(op === 'seal' ? { d1Revision: 0 } : {}), ...payload }) }), f.env, ctx, now); }

test('concurrent_cron_one_claim and expired fence cannot consume or seal', async () => {
  const f = fixture(); try {
    const claims = await Promise.all([work(f), work(f)]); assert.equal(claims.filter(Boolean).length, 1);
    const old = claims.find(Boolean); assert.equal(await sourceObjectsPinned(f.env, at), true);
    const newer = await work(f, at + 41*60000,1); assert.ok(newer); assert.ok(newer.fence > old.fence);
    assert.equal((await call(f, old, 'seal', {}, at + 41*60000)).status, 409);
    assert.equal(await sourceObjectsPinned(f.env, at + 82*60000), false);
  } finally { f.sqlite.close(); }
});
test('daily_0700utc_and_two_retries survives duplicate cron and restarts', async () => {
  const f = fixture(); let dispatches = 0;
  const dispatch = async () => { dispatches++; return new Response(null, {status: 503}); };
  try {
    await scheduleRecoveryBackup(f.env, at-1, dispatch); assert.equal(dispatches, 0);
    await scheduleRecoveryBackup(f.env, at, dispatch); assert.equal(dispatches, 1);
    await scheduleRecoveryBackup(f.env, at+14*60000, dispatch); assert.equal(dispatches, 1);
    await scheduleRecoveryBackup(f.env, at+15*60000, dispatch); assert.equal(dispatches, 2);
    await scheduleRecoveryBackup(f.env, at+30*60000, dispatch); assert.equal(dispatches, 3);
    await scheduleRecoveryBackup(f.env, at+60*60000, dispatch); assert.equal(dispatches, 3);
    assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM backup_runs').get().n, 3);
  } finally { f.sqlite.close(); }
});
test('maintenance and default flags disable work without touching missing bindings', async () => {
  assert.equal((await scheduleRecoveryBackup({}, at)).phase, 'disabled');
  assert.equal((await scheduleRecoveryBackup({ SARIN_BACKUP_ENABLED:'true', SARIN_MAINTENANCE:'true' }, at)).phase, 'disabled');
  const f=fixture(); try { f.env.SARIN_BACKUP_ENABLED='false'; assert.equal(await work(f), null); } finally { f.sqlite.close(); }
});
test('bridge checks singleton before body, consumes trigger once, restricts operations and bytes', async () => {
  const f=fixture(); try {
    const w=await work(f); assert.ok(w); assert.match(await signRecoveryWork(w, f.env.SARIN_BACKUP_HMAC_KEY), /^[a-f0-9]{64}$/);
    assert.equal((await handleRecoveryOutbound(new Request('http://sarin-backup.internal/execute', {method:'POST',body:'private'}), f.env, {...ctx,containerId:'other'}, at)).status,403);
    assert.equal((await call(f,w,'consume')).status,200); assert.equal((await call(f,w,'consume')).status,409);
    assert.equal((await call(f,w,'arbitrary-fetch',{url:'https://example.invalid'})).status,400);
    assert.equal((await call(f,w,'archive-put',{id:'../../private'})).status,400);
    assert.equal((await call(f,{...w,nonce:crypto.randomUUID()},'heartbeat')).status,409);
    assert.equal((await call(f,w,'seal')).status,400);
  } finally { f.sqlite.close(); }
});
test('status uses oldest component for 20h warning and >24h breach without leaking identifiers', async () => {
  const f=fixture(); try {
    const w=await work(f);
    f.sqlite.prepare(`INSERT INTO backup_catalog(backup_id,sealed_at,recoverable_at,envelope,snapshot_times,prechange) VALUES(?,?,?,?,?,0)`).run(w.backupId,at,at-20*3600000,'{}',JSON.stringify({d1:at-20*3600000,auth:at-10*3600000,r2:at,config:at}));
    const s=await recoveryStatus(f.env,at); assert.equal(s.health,'warning'); assert.equal(s.ages.auth,10*3600000);
    assert.equal((await recoveryStatus(f.env,at+4*3600000)).health,'warning');
    assert.equal((await recoveryStatus(f.env,at+4*3600000+1)).health,'breached');
    assert.doesNotMatch(JSON.stringify(s),/backup_id|demo-token|r2.cloud/);
  } finally {f.sqlite.close();}
});
const set=(id,iso,more={})=>({ backupId:id,sealedAt:Date.parse(iso),recoverableAt:Date.parse(iso),prechange:false,objects:[{id:'shared',bytes:10}],...more });
test('retention keeps shared refs and last usable set, Bogota boundaries, gaps and prechange 7d',()=>{
  const now=Date.parse('2027-01-05T08:00:00Z');
  const sets=[set('monday','2027-01-04T07:00:00Z'),set('sunday','2027-01-04T03:00:00Z'),set('dec','2026-12-01T07:00:00Z'),set('nov','2026-11-01T07:00:00Z'),set('old','2026-01-01T07:00:00Z'),set('pre','2026-12-30T07:00:00Z',{prechange:true})];
  const p=planRecoveryRetention(sets,[],now); assert.equal(p.dryRun,true); assert.ok(p.keep.includes('monday')); assert.ok(p.keep.includes('pre')); assert.equal(p.objects.length,0); assert.ok(p.gaps.weeks.includes('2026-W52')); assert.ok(p.categories.monday.includes('weekly')); assert.ok(!p.categories.sunday.includes('weekly'));
  assert.equal(planRecoveryRetention([set('last','2020-01-01T07:00:00Z')],[],now).remove.length,0);
});
test('failed artifacts expire after 48h but summaries last 30d; cleanup defaults dry-run',async()=>{
  const f=fixture(); try {
    const w=await work(f); await call(f,w,'consume'); await call(f,w,'fail',{code:'CAPTURE_FAILED'});
    const a=await cleanupRecoveryBackups(f.env,at+47*3600000); assert.equal(a.failed.length,0);
    const b=await cleanupRecoveryBackups(f.env,at+49*3600000); assert.equal(b.failed.length,1); assert.equal(b.dryRun,true);
    assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM backup_runs').get().n,1);
    assert.equal((await cleanupRecoveryBackups(f.env,at+31*86400000)).summaries.length,1);
  } finally {f.sqlite.close();}
});
async function put(f,w,bytes,id=crypto.randomUUID(),now=at) {
  const entry={id,bytes:bytes.length,sha256:await recoveryDigest(bytes)};
  const response=await handleRecoveryOutbound(new Request('http://sarin-backup.internal/execute',{method:'POST',body:bytes,headers:{'x-sarin-backup-command':JSON.stringify({work:w,op:'archive-put',entry})}}),f.env,ctx,now);
  return {entry,response};
}
test('seal follows readback of all ciphertext, immutable retry resolves by status, no overwrite',async()=>{
  const f=fixture();try {
    const w=await work(f);await call(f,w,'consume');
    const a=await put(f,w,new Uint8Array([1,2,3])), b=await put(f,w,new Uint8Array([4,5]));
    assert.equal(a.response.status,200);assert.equal(b.response.status,200);
    const envelope={formatVersion:1,backupId:w.backupId,createdAt:at,sealedAt:at,status:'sealed',keyId:'a'.repeat(64),objects:[a.entry],manifest:b.entry};
    const snapshotTimes=Object.fromEntries(['d1','r2','auth','config'].map(k=>[k,{startedAt:at-1,recoverableAt:at-1,completedAt:at}]));
    assert.equal((await call(f,w,'seal',{envelope,snapshotTimes})).status,200);
    assert.equal((await (await call(f,w,'status')).json()).phase,'sealed');
    assert.equal((await call(f,w,'seal',{envelope,snapshotTimes})).status,409);
    assert.equal((await put(f,w,new Uint8Array([0]),a.entry.id)).response.status,409);
    assert.deepEqual([...f.objects.get(`ciphertext/${a.entry.id}`)],[1,2,3]);
    assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM backup_catalog').get().n,1);
  }finally{f.sqlite.close();}
});
test('readback corruption, set byte limit, and unconsumed uploads cannot seal',async()=>{
  const f=fixture();try{
    const w=await work(f);assert.equal((await put(f,w,new Uint8Array([1]))).response.status,409);await call(f,w,'consume');
    f.env.SARIN_BACKUPS.get=async()=>({size:1,body:new Response(new Uint8Array([9])).body});
    assert.equal((await put(f,w,new Uint8Array([1]))).response.status,503);
    assert.equal(f.sqlite.prepare('SELECT verified FROM backup_objects').get().verified,0);
    f.sqlite.prepare('UPDATE backup_runs SET bytes=?').run(1024**3);
    assert.equal((await put(f,w,new Uint8Array([1]))).response.status,409);
    assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM backup_catalog').get().n,0);
  }finally{f.sqlite.close();}
});
test('export rejects arbitrary origins and redirects without exposing token or signed URL',async()=>{
  const f=fixture(), original=globalThis.fetch;let api=0,download=0;
  try{
    const w=await work(f);await call(f,w,'consume');
    globalThis.fetch=async(url,options)=>{
      if(String(url).startsWith('https://api.cloudflare.com/')){api++;assert.equal(options.redirect,'manual');return Response.json({success:true,result:{status:'complete',at_bookmark:'demo',result:{signed_url:'https://evil.invalid/secret'}}});}
      download++;throw Error('must not download');
    };
    const r=await call(f,w,'export-start');assert.equal(r.status,503);assert.equal(api,1);assert.equal(download,0);assert.doesNotMatch(await r.text(),/secret|demo-token/);
  }finally{globalThis.fetch=original;f.sqlite.close();}
});
test('retention removes only unreferenced bytes and actual cleanup requires both gates',async()=>{
  const now=Date.parse('2027-02-10T08:00:00Z');
  const sets=Array.from({length:10},(_,i)=>set(`s${i}`,`2027-02-${String(i+1).padStart(2,'0')}T07:00:00Z`,{objects:[{id:'shared',bytes:10},{id:`unique${i}`,bytes:5}]}));
  const p=planRecoveryRetention(sets,[],now);assert.deepEqual(p.remove,['s1','s2']);assert.equal(p.bytes,10);assert.equal(p.objects.some(o=>o.id==='shared'),false);
  const f=fixture();try{
    const w=await work(f);await call(f,w,'consume');const a=await put(f,w,new Uint8Array([1]));assert.equal(a.response.status,200);await call(f,w,'fail',{code:'CAPTURE_FAILED'});
    assert.equal((await cleanupRecoveryBackups(f.env,at+49*3600000,false)).dryRun,true);assert.equal(f.objects.size,1);
    f.env.SARIN_BACKUP_CLEANUP_ENABLED='true';assert.equal((await cleanupRecoveryBackups(f.env,at+49*3600000,false)).dryRun,false);assert.equal(f.objects.size,0);
    assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM backup_runs').get().n,1);
    await cleanupRecoveryBackups(f.env,at+31*86400000,false);assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM backup_runs').get().n,0);
  }finally{f.sqlite.close();}
});
test('real Workerd D1 CAS and private R2 readback support the same sealed protocol',async()=>{
  const at=Date.now();
  const r=await createRecoveryTestRuntime();try{
    const w=await r.claim(at);assert.ok(w);assert.equal(await r.claim(at),null);
    assert.equal((await r.call(w,'consume',{},undefined,at)).status,200);
    const entries=[];
    for(const bytes of [new Uint8Array([1,2,3]),new Uint8Array([4,5])]){
      const entry={id:crypto.randomUUID(),bytes:bytes.length,sha256:await recoveryDigest(bytes)};entries.push(entry);
      const response=await r.call(w,'archive-put',{entry},bytes,at);assert.equal(response.status,200,await response.text());
    }
    const envelope={formatVersion:1,backupId:w.backupId,createdAt:at,sealedAt:at,status:'sealed',keyId:'a'.repeat(64),objects:[entries[0]],manifest:entries[1]};
    const snapshotTimes=Object.fromEntries(['d1','r2','auth','config'].map(k=>[k,{startedAt:at,recoverableAt:at,completedAt:at}]));
    const response=await r.call(w,'seal',{envelope,snapshotTimes},undefined,null);assert.equal(response.status,200,await response.text());
    assert.equal((await r.db.prepare('SELECT count(*) AS n FROM backup_catalog').first()).n,1);
    assert.equal((await r.bucket.get(`ciphertext/${entries[0].id}`)).size,3);
  }finally{await r.dispose();}
});

for (const damage of ['missing', 'corrupt', 'unavailable', 'none']) test(`cleanup checks surviving ciphertext before deleting readable archives: ${damage}`, async () => {
  const f = fixture();
  try {
    const sets = [];
    for (let day = 0; day < 10; day++) {
      const now = at + day * 86400000, w = await work(f, now);
      await call(f, w, 'consume', {}, now);
      const entries = [];
      for (const value of [day + 1, day + 11]) {
        const { entry, response } = await put(f, w, new Uint8Array([value]), crypto.randomUUID(), now);
        assert.equal(response.status, 200);
        entries.push(entry);
      }
      const envelope = { formatVersion: 1, backupId: w.backupId, createdAt: now, sealedAt: now, status: 'sealed', keyId: 'a'.repeat(64), objects: [entries[0]], manifest: entries[1] };
      const snapshotTimes = Object.fromEntries(['d1', 'r2', 'auth', 'config'].map(k => [k, { startedAt: now, recoverableAt: now, completedAt: now }]));
      assert.equal((await call(f, w, 'seal', { envelope, snapshotTimes }, now)).status, 200);
      sets.push({ backupId: w.backupId, sealedAt: now, recoverableAt: now, prechange: false, objects: entries });
    }
    const now = at + 10 * 86400000, plan = planRecoveryRetention(sets, [], now);
    assert.ok(plan.remove.length > 0);
    for (const set of sets.filter(s => plan.keep.includes(s.backupId))) {
      const key = `ciphertext/${set.objects[0].id}`;
      if (damage === 'missing') f.objects.delete(key);
      if (damage === 'corrupt') f.objects.set(key, new Uint8Array([255]));
    }
    if (damage === 'unavailable') f.env.SARIN_BACKUPS.get = async () => { throw Error('storage unavailable'); };
    f.env.SARIN_BACKUP_CLEANUP_ENABLED = 'true';
    const result = await cleanupRecoveryBackups(f.env, now, false);
    assert.equal(result.dryRun, damage !== 'none');
    for (const id of plan.remove) {
      assert.equal(!!f.sqlite.prepare('SELECT backup_id FROM backup_catalog WHERE backup_id=?').get(id), damage !== 'none');
      for (const entry of sets.find(s => s.backupId === id).objects) assert.equal(f.objects.has(`ciphertext/${entry.id}`), damage !== 'none');
    }
  } finally { f.sqlite.close(); }
});
test('prechange claims are separate from the daily slot and immutable restore evidence follows the set',async()=>{
  const f=fixture();try{
    const w=await claimRecoveryBackup(f.env,{backupId:crypto.randomUUID(),attempt:0,now:at,prechange:true});assert.ok(w);await call(f,w,'consume');
    const a=await put(f,w,new Uint8Array([1])),b=await put(f,w,new Uint8Array([2]));
    const envelope={formatVersion:1,backupId:w.backupId,createdAt:at,sealedAt:at,status:'sealed',keyId:'a'.repeat(64),objects:[a.entry],manifest:b.entry};
    const snapshotTimes=Object.fromEntries(['d1','r2','auth','config'].map(k=>[k,{startedAt:at,recoverableAt:at,completedAt:at}]));
    assert.equal((await call(f,w,'seal',{envelope,snapshotTimes})).status,200);
    assert.equal(f.sqlite.prepare('SELECT prechange FROM backup_catalog').get().prechange,1);
    assert.ok(await work(f));
    f.sqlite.prepare('INSERT INTO backup_restore_evidence(backup_id,artifact_sha256,verified_at) VALUES(?,?,?)').run(w.backupId,'a'.repeat(64),at);
    assert.throws(()=>f.sqlite.prepare('UPDATE backup_restore_evidence SET verified_at=?').run(at+1));
    assert.throws(()=>f.sqlite.prepare('DELETE FROM backup_restore_evidence').run());
    assert.equal(f.sqlite.prepare('SELECT envelope FROM backup_catalog').get().envelope,JSON.stringify(envelope));
    f.sqlite.prepare('DELETE FROM backup_catalog WHERE backup_id=?').run(w.backupId);
    assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM backup_restore_evidence').get().n,0);
  }finally{f.sqlite.close();}
});
test('a non202 trigger response with consumed work preserves its uncertain execution',async()=>{
  const f=fixture();try{
    await scheduleRecoveryBackup(f.env,at,async request=>{const w=await request.json();await call(f,w,'consume');return new Response(null,{status:503});});
    assert.equal(f.sqlite.prepare('SELECT phase FROM backup_runs').get().phase,'preparing');
  }finally{f.sqlite.close();}
});
test('deadline is rechecked after delayed body and delayed object verification',async()=>{
  for(const delayAt of ['body','objects']){
    const f=fixture();try{
      const w=await work(f);await call(f,w,'consume');const a=await put(f,w,new Uint8Array([1])),b=await put(f,w,new Uint8Array([2]));
      const envelope={formatVersion:1,backupId:w.backupId,createdAt:at,sealedAt:at,status:'sealed',keyId:'a'.repeat(64),objects:[a.entry],manifest:b.entry};
      const snapshotTimes=Object.fromEntries(['d1','r2','auth','config'].map(k=>[k,{startedAt:at,recoverableAt:at,completedAt:at}]));
      const bytes=new TextEncoder().encode(JSON.stringify({work:w,op:'seal',envelope,snapshotTimes,d1Revision:0}));
      const original=f.db.prepare.bind(f.db);
      if(delayAt==='objects')f.db.prepare=sql=>{const statement=original(sql);if(sql.startsWith('SELECT o.*')){const all=statement.all.bind(statement);statement.all=async()=>{await new Promise(r=>setTimeout(r,60));return all();};}return statement;};
      const body=delayAt==='body'?new ReadableStream({async start(c){await new Promise(r=>setTimeout(r,60));c.enqueue(bytes);c.close();}}):bytes;
      const response=await handleRecoveryOutbound(new Request('http://sarin-backup.internal/execute',{method:'POST',body,duplex:'half'}),f.env,ctx,w.deadlineAt-20);
      assert.equal(response.status,409,delayAt);assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM backup_catalog').get().n,0);
    }finally{f.sqlite.close();}
  }
});
test('database-time final fence rejects a seal queued beyond its real deadline',async()=>{
  const f=fixture();try{
    const realNow=Date.now(),w=await work(f,realNow);await call(f,w,'consume',{},realNow);
    const a=await put(f,w,new Uint8Array([1])),b=await put(f,w,new Uint8Array([2]));
    w.deadlineAt=Date.now()+40;w.expiresAt=w.deadlineAt+10*60000;
    f.sqlite.prepare('UPDATE backup_runs SET deadline_at=?,expires_at=?').run(w.deadlineAt,w.expiresAt);
    const envelope={formatVersion:1,backupId:w.backupId,createdAt:realNow,sealedAt:realNow,status:'sealed',keyId:'a'.repeat(64),objects:[a.entry],manifest:b.entry};
    const snapshotTimes=Object.fromEntries(['d1','r2','auth','config'].map(k=>[k,{startedAt:realNow,recoverableAt:realNow,completedAt:realNow}]));
    const batch=f.db.batch.bind(f.db);f.db.batch=async statements=>{await new Promise(r=>setTimeout(r,80));return batch(statements);};
    const response=await handleRecoveryOutbound(new Request('http://sarin-backup.internal/execute',{method:'POST',body:JSON.stringify({work:w,op:'seal',envelope,snapshotTimes,d1Revision:0})}),f.env,ctx);
    assert.equal(response.status,409);assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM backup_catalog').get().n,0);
  }finally{f.sqlite.close();}
});

test('a missing witness, pre-marker snapshot and an intent racing the final seal all block integral backup', async () => {
  const f = fixture();
  try {
    f.env.SARIN_WITNESS_ENABLED = 'false'; await assert.rejects(work(f), /RECOVERY_WITNESS/);
    f.env.SARIN_WITNESS_ENABLED = 'true'; const w = await work(f); await call(f, w, 'consume');
    const a = await put(f, w, new Uint8Array([1])), b = await put(f, w, new Uint8Array([2]));
    const envelope = { formatVersion: 1, backupId: w.backupId, createdAt: at, sealedAt: at, status: 'sealed', keyId: 'a'.repeat(64), objects: [a.entry], manifest: b.entry };
    const snapshotTimes = Object.fromEntries(['d1', 'r2', 'auth', 'config'].map(k => [k, { startedAt: at - 2000, recoverableAt: at - 2000, completedAt: at }]));
    assert.equal((await call(f, w, 'seal', { envelope, snapshotTimes })).status, 503);
    snapshotTimes.d1.recoverableAt = at;
    const original = f.db.prepare.bind(f.db);
    f.db.prepare = sql => {
      if (sql.startsWith('INSERT INTO backup_catalog')) f.sqlite.prepare("INSERT INTO recovery_invalidations VALUES(?,?,0,?,?,'pending',NULL)").run(crypto.randomUUID(), 'a'.repeat(64), at, '[]');
      return original(sql);
    };
    assert.equal((await call(f, w, 'seal', { envelope, snapshotTimes })).status, 409);
    assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM backup_catalog').get().n, 0);
  } finally { f.sqlite.close(); }
});

test('daily backup admission does not load every historical intent after 10001 committed revisions', async () => {
  const f = fixture();
  try {
    f.sqlite.exec('BEGIN');
    const insert = f.sqlite.prepare("INSERT INTO recovery_invalidations VALUES(?,?,?,?,?,'complete',?)");
    for (let i = 1; i <= 10001; i++) insert.run('demo-' + i, 'a'.repeat(64), i - 1, at, '[]', i);
    f.sqlite.exec('COMMIT');
    f.env.SARIN_DB = { prepare() { return { async first() { return { revision: 10001 }; } }; } };
    assert.ok(await work(f));
  } finally { f.sqlite.close(); }
});
