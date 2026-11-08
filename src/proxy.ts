import { NextResponse, type NextRequest } from 'next/server';
import { isUiRequest, privateHeaders } from '../pages-gateway/worker.mjs';

export function proxy(request: NextRequest) {
  if (process.env.NODE_ENV === 'development' && request.method === 'GET' && request.nextUrl.pathname === '/_next/webpack-hmr') return NextResponse.next();
  if (!isUiRequest(request)) return new NextResponse(null, { status: 404, headers: privateHeaders() });
  return NextResponse.next();
}

export const config = { matcher: '/:path*' };
