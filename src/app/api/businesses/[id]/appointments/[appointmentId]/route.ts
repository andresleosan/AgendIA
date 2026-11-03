import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/server/auth';
import { apiError, HttpError } from '@/lib/server/http';
import { documentIdSchema } from '@/lib/server/schemas';
import { readClientAppointment } from '@/lib/server/client-appointments-pagination';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request, context: { params: Promise<{ id: string; appointmentId: string }> }) {
  try {
    const actor = await requireUser(request);
    if (new URL(request.url).search) throw new HttpError(400, 'Consulta de cita inválida.');
    const params = await context.params;
    return NextResponse.json({ appointment: await readClientAppointment(actor, documentIdSchema.parse(params.id), documentIdSchema.parse(params.appointmentId)) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return apiError(error); }
}
