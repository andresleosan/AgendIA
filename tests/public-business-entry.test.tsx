import { act, createElement, Suspense, type ReactNode } from 'react';
import { create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import ClientPage from '@/app/b/[slug]/page';

const state = vi.hoisted(() => ({ loading: false, user: null as { uid: string } | null }));
vi.mock('@/components/auth-provider', () => ({ useAuth: () => ({ user: state.user, loading: state.loading }), AuthGate: () => createElement('p', null, 'Acceso con Google') }));
vi.mock('@/lib/client/api', () => ({ apiFetch: () => { throw new Error('An anonymous profile must not request authenticated data'); }, errorMessage: (error: Error) => error.message }));
vi.mock('next/link', () => ({ default: ({ children, href }: { children: ReactNode; href: string }) => createElement('a', { href }, children) }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const text = (node: ReactTestInstance | string): string => typeof node === 'string' ? node : node.children.map(text).join('');
const profile = { slug: 'shop', name: 'Barbería Norte', category: 'Barbería', phoneWhatsApp: '+573000000000', timezone: 'America/Bogota', services: [{ id: 'haircut', name: 'Corte clásico', price: 25000, durationMinutes: 30 }], weeklySchedule: { 1: { isOpen: true, intervals: [{ start: '09:00', end: '17:00' }] } }, bookingAvailable: true };
let renderer: ReactTestRenderer;
beforeEach(() => { state.loading = false; state.user = null; vi.stubGlobal('fetch', vi.fn(async () => Response.json({ business: profile }))); });
afterEach(async () => { await act(async () => renderer?.unmount()); vi.unstubAllGlobals(); });
async function render(slug = 'shop') { await act(async () => { renderer = create(createElement(Suspense, { fallback: null }, createElement(ClientPage, { params: Promise.resolve({ slug }) }))); }); }

it('shows the real business and services anonymously, even while Google session detection is pending', async () => {
  state.loading = true;
  await render();
  expect(text(renderer.root)).toContain('Barbería Norte');
  expect(text(renderer.root)).toContain('Corte clásico');
  expect(text(renderer.root)).not.toContain('Acceso con Google');
  expect(vi.mocked(fetch).mock.calls.every(([path]) => path === '/api/public/businesses/shop?view=profile')).toBe(true);
});
it('requests Google only after choosing to reserve and allows returning to the public profile', async () => {
  await render();
  await act(async () => renderer.root.findAllByType('button').find(button => text(button) === 'Reservar')!.props.onClick());
  expect(text(renderer.root)).toContain('Acceso con Google');
  await act(async () => renderer.root.findAllByType('button').find(button => text(button) === 'Volver al negocio')!.props.onClick());
  expect(text(renderer.root)).toContain('Corte clásico');
  expect(text(renderer.root)).not.toContain('Acceso con Google');
});
it('reports a missing business without first asking for Google', async () => {
  vi.mocked(fetch).mockResolvedValue(Response.json({ business: null }));
  await render('missing');
  expect(text(renderer.root)).toContain('No encontramos este negocio');
  expect(text(renderer.root)).not.toContain('Acceso con Google');
});
it('can retry an unavailable public profile without requesting a Google session', async () => {
  vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 503 }));
  await render();
  expect(text(renderer.root)).toContain('No pudimos consultar el negocio');
  await act(async () => renderer.root.findByType('button').props.onClick());
  expect(text(renderer.root)).toContain('Corte clásico');
  expect(text(renderer.root)).not.toContain('Acceso con Google');
});
it('keeps the existing authenticated gate and returns to the profile after sign out', async () => {
  await render();
  await act(async () => renderer.root.findAllByType('button').find(button => text(button) === 'Reservar')!.props.onClick());
  state.user = { uid: 'client' };
  await act(async () => renderer.update(createElement(Suspense, { fallback: null }, createElement(ClientPage, { params: Promise.resolve({ slug: 'shop' }) }))));
  expect(text(renderer.root)).toContain('Acceso con Google');
  expect(text(renderer.root)).not.toContain('Corte clásico');
  expect(text(renderer.root.findByType('footer'))).toContain('Asistente virtual: Sarin Bot');
  state.user = null;
  await act(async () => renderer.update(createElement(Suspense, { fallback: null }, createElement(ClientPage, { params: Promise.resolve({ slug: 'shop' }) }))));
  expect(text(renderer.root)).toContain('Corte clásico');
  expect(text(renderer.root)).not.toContain('Acceso con Google');
});
it('resets the login choice when the business link changes', async () => {
  await render();
  await act(async () => renderer.root.findAllByType('button').find(button => text(button) === 'Reservar')!.props.onClick());
  vi.mocked(fetch).mockResolvedValue(Response.json({ business: { ...profile, slug: 'other', name: 'Otro negocio' } }));
  await act(async () => renderer.update(createElement(Suspense, { fallback: null }, createElement(ClientPage, { params: Promise.resolve({ slug: 'other' }) }))));
  expect(text(renderer.root)).toContain('Otro negocio');
  expect(text(renderer.root)).not.toContain('Acceso con Google');
});
