import { after } from 'next/server';
import { authenticateRecoveryTrigger, recoveryBridge, createRecoveryAdapters, runRecoveryBackup } from '@/lib/server/recovery-backup';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function POST(request: Request): Promise<Response> {
  const work = await authenticateRecoveryTrigger(request, process.env);
  if (!work) return Response.json({ code: 'DENIED' }, { status: 404, headers: { 'Cache-Control': 'no-store' } });
  const bridge = recoveryBridge(work);
  try { await bridge('consume'); }
  catch { return Response.json({ code: 'DENIED' }, { status: 409, headers: { 'Cache-Control': 'no-store' } }); }
  after(async () => {
    try { await runRecoveryBackup(work, await createRecoveryAdapters(work)); }
    catch { await bridge('fail', { code: 'EXECUTION_FAILED' }).catch(() => {}); }
  });
  return new Response(null, { status: 202, headers: { 'Cache-Control': 'no-store' } });
}
