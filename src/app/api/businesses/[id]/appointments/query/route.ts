import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/server/auth';
import { apiError, HttpError, readJson } from '@/lib/server/http';
import { documentIdSchema } from '@/lib/server/schemas';
import { clientAppointmentsQuerySchema } from '@/lib/client-appointments-pagination';
import { readClientAppointmentsPage } from '@/lib/server/client-appointments-pagination';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireUser(request);
    if (new URL(request.url).search) throw new HttpError(400, 'Consulta de citas inválida.');
    const id = documentIdSchema.parse((await context.params).id);
    const input = await readJson(request, clientAppointmentsQuerySchema, 4096);
    return NextResponse.json(await readClientAppointmentsPage(actor, id, input), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return apiError(error); }
}
