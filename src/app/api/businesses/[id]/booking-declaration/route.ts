import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/server/auth';
import { apiError, HttpError, readJson } from '@/lib/server/http';
import { executeOwnerBookingDeclaration, readOwnerBookingDeclaration, ownerBookingDeclarationInputSchema } from '@/lib/server/booking-policy-commands';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'no-store' };
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(request);
    if (new URL(request.url).search) throw new HttpError(400, 'Consulta inválida.');
    const { id } = await context.params;
    return NextResponse.json(await readOwnerBookingDeclaration(user, id), { headers });
  } catch (error) { return apiError(error); }
}
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(request);
    if (new URL(request.url).search) throw new HttpError(400, 'Consulta inválida.');
    const { id } = await context.params, input = await readJson(request, ownerBookingDeclarationInputSchema, 4096);
    const result = await executeOwnerBookingDeclaration(user, id, input);
    return NextResponse.json(result, { status: result.outcome === 'pending' ? 202 : 200, headers });
  } catch (error) { return apiError(error); }
}
