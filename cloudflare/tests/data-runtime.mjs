import { createRequire } from 'node:module';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Test-only Workerd + real local D1/R2, without network or account credentials. */
export async function createDataTestRuntime({ previousBusinessChildren = false, previousOwnerRescheduleChildren = false, previousFactualFaqChildren = false, previousOwnerWaitlistChildren = false, previousQuotaRecords = false, captureSql = false, quotaRecovery = false } = {}) {
  const require = createRequire(import.meta.url);
  const wranglerRequire = createRequire(require.resolve('wrangler/package.json'));
  const { build } = wranglerRequire('esbuild');
  const { Miniflare, convertV4MiniflareOptions } = wranglerRequire('miniflare');
  const bundle = await build({
    stdin: { resolveDir: fileURLToPath(new URL('../', import.meta.url)), contents: `
      import {executeDataCommand, DataError${captureSql ? ', captureSqlReadForTest' : ''}} from './src/data.ts';
      ${quotaRecovery ? "import {recoverWorkerResponseQuota} from './src/response-quota-recovery.ts';" : ''}
      export default { async fetch(request, env) {
        ${captureSql ? "if (new URL(request.url).pathname === '/capture-sql') return Response.json(captureSqlReadForTest(await request.json()));" : ''}
        try { ${quotaRecovery ? "if (new URL(request.url).pathname === '/quota-recovery') return Response.json(await recoverWorkerResponseQuota(env, (await request.json()).now));" : ''} return Response.json(await executeDataCommand(await request.json(), env)); }
        catch (error) { return Response.json({code:error instanceof DataError ? error.code : 'DATA_UNAVAILABLE', error:'Storage unavailable'}, {status:error instanceof DataError ? error.status : 503}); }
      }};
    ` }, bundle: true, write: false, format: 'esm', platform: 'browser',
    // Compatibility fixture: b7e9a28's businesses allowlist. Execute the actual
    // Worker with only this literal changed; keep all other protocol validation.
    plugins: [...(previousQuotaRecords ? [{ name: 'receipt-unaware-allowlist', setup(build) {
      build.onLoad({ filter: /[\\/]shared[\\/]data-protocol\.ts$/ }, ({ path }) => {
        const source = readFileSync(path, 'utf8');
        if (!source.includes("'responseQuotaReceipts'") || !source.includes("responseQuotaTurns: ['reviews']")) throw new Error('Quota allowlist fixture no longer matches');
        return { contents: source.replace("'responseQuotaReceipts',", '').replace("responseQuotaTurns: ['reviews'],", ''), loader: 'ts' };
      });
    } }] : []), ...(previousBusinessChildren || previousOwnerRescheduleChildren || previousFactualFaqChildren || previousOwnerWaitlistChildren ? [{ name: 'previous-business-children', setup(build) {
      build.onLoad({ filter: /[\\/]shared[\\/]data-protocol\.ts$/ }, ({ path }) => {
        const source = readFileSync(path, 'utf8');
        const beforeTeam = "businesses: ['appointments', 'attendanceEvents', 'ownerRescheduleProposals', 'bookingLocks', 'clientPolicies', 'reminderPreferences', 'reminderReceipts', 'waitlistRequests', 'waitlistOwnerReviews', 'waitlistOfferHeads', 'waitlistOffers', 'resourceSchedulePolicies', 'resourceScheduleOperations', 'factualFaq', 'factualFaqOperations']";
        const current = beforeTeam.replace("'factualFaqOperations']", "'factualFaqOperations', 'teamAccessEvents']");
        const beforeOffers = beforeTeam.replace(", 'waitlistOfferHeads', 'waitlistOffers'", '');
        const beforeWaitlist = beforeOffers.replace(", 'waitlistOwnerReviews'", '');
        const beforeFaq = beforeWaitlist.replace(", 'factualFaq', 'factualFaqOperations'", '');
        const previous = previousOwnerWaitlistChildren ? beforeWaitlist : previousBusinessChildren ? "businesses: ['appointments', 'bookingLocks', 'clientPolicies', 'reminderPreferences', 'reminderReceipts', 'waitlistRequests']" : previousOwnerRescheduleChildren ? beforeFaq.replace("'ownerRescheduleProposals', ", '') : beforeFaq;
        if (source.split(current).length !== 2) throw new Error('Previous businesses allowlist fixture must replace exactly one literal');
        return { contents: source.replace(current, previous), loader: 'ts' };
      });
    } }] : []), ...(captureSql ? [{ name: 'capture-generated-sql', setup(build) {
      build.onLoad({ filter: /[\\/]src[\\/]data\.ts$/ }, ({ path }) => ({
        // Observe private sqlRead from the actual source. This capture-only
        // prepare/bind adapter never executes data; EXPLAIN below uses real D1.
        contents: readFileSync(path, 'utf8') + `
          export function captureSqlReadForTest(read: DataRead) {
            validate({action:'read',read});
            return sqlRead(read, {prepare(sql: string) {
              return {bind(...bindings: unknown[]) {return {sql,bindings};}};
            }} as unknown as D1Database);
          }
        `, loader: 'ts',
      }));
    } }] : [])],
  });
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundle.outputFiles[0].text,
    compatibilityDate: '2026-10-13', d1Databases: { SARIN_DB: 'sarin-data-test' }, r2Buckets: { SARIN_FILES: 'sarin-files-test' } }));
  try {
    const db = await mf.getD1Database('SARIN_DB');
    const bucket = await mf.getR2Bucket('SARIN_FILES');
    const directory = new URL('../migrations/', import.meta.url);
    for (const migration of readdirSync(directory).filter(name => /^\d+.*\.sql$/.test(name)).sort()) {
      const schema = readFileSync(new URL(migration, directory), 'utf8');
      await db.exec(schema.replace(/^--.*$/gm, '').replace(/\r?\n/g, ' '));
    }
    return { db, bucket, dispose: () => mf.dispose(), fetch: command => mf.dispatchFetch('http://sarin-data.test/execute', { method: 'POST', body: JSON.stringify(command) }),
      ...(quotaRecovery ? { recoverQuota: now => mf.dispatchFetch('http://sarin-data.test/quota-recovery', { method: 'POST', body: JSON.stringify({ now }) }) } : {}),
      ...(captureSql ? { explain: async read => {
        const response = await mf.dispatchFetch('http://sarin-data.test/capture-sql', { method: 'POST', body: JSON.stringify(read) });
        if (!response.ok) throw new Error('Generated SQL capture failed');
        const captured = await response.json();
        const { results: plan } = await db.prepare(`EXPLAIN QUERY PLAN ${captured.sql}`).bind(...captured.bindings).all();
        return { ...captured, plan };
      } } : {}),
    };
  } catch (error) { await mf.dispose(); throw error; }
}
