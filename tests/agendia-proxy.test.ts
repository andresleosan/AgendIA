import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { proxy } from '../src/proxy';

describe('AgendIA UI process boundary', () => {
  it('blocks inherited API and admin routes even on the direct local UI server', () => {
    for (const path of ['/api/session', '/api/admin', '/admin', '/%61pi/session', '/api%2fadmin', '/.well-known/jwks.json', '/_next/data/build/admin.json']) {
      expect(proxy(new NextRequest('http://localhost:3000' + path)).status, path).toBe(404);
    }
  });
  it('allows dynamic UI and denies server actions', () => {
    expect(proxy(new NextRequest('http://localhost:3000/b/demo-shop')).headers.get('x-middleware-next')).toBe('1');
    expect(proxy(new NextRequest('http://localhost:3000/dashboard', { method: 'POST', headers: { 'Next-Action': 'synthetic' } })).status).toBe(404);
  });
});
