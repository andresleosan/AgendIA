import { act, createElement, Suspense, useEffect, type ReactNode } from 'react';
import { create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import ClientPage from '@/app/b/[slug]/page';
import { ClientAppointments } from '@/components/client-appointments';
import { AppointmentReschedule } from '@/components/appointment-reschedule';
import { apiFetch } from '@/lib/client/api';
import { bookingSubjectContent } from '@/lib/booking-subject-legal';
import type { Appointment, PublicBusiness } from '@/types/firestore';
import type { BookingSubjectCase } from '@/lib/booking-subject';
const state = vi.hoisted(() => ({ uid: 'demo-client', account: true, consent: true, ready: true, nullPolicy: false, chatLock: false, mounts: 0 }));
vi.mock('@/components/auth-provider', () => ({ useAuth: () => ({ user: { uid: state.uid, displayName: 'Demo' }, authEpoch: 0, isCurrentSession: (uid: string, epoch: number) => uid === state.uid && epoch === 0, signOut: vi.fn() }), AuthGate: ({ children }: { children: ReactNode }) => children }));
vi.mock('@/components/consent-panel', () => ({ useAccountConsent: () => ({ active: state.account }), ConsentPanel: () => null }));
vi.mock('@/hooks/useConsent', () => ({ useConsent: () => ({ active: state.consent }) }));
vi.mock('@/hooks/useBookingDataPolicy', () => ({ useBookingDataPolicy: () => ({ ready: state.ready, error: null, refresh: vi.fn(), capability: state.nullPolicy ? null : { configured: true, revision: 1, dataMode: 'general', representedMinorsEnabled: false } }) }));
vi.mock('@/components/client-appointments', () => ({ ClientAppointments: () => { useEffect(() => { state.mounts++; }, []); return createElement('section', { 'aria-label': 'Mis citas' }); } }));
vi.mock('@/hooks/useDebouncedChat', () => ({ useDebouncedChat: () => ({ messages: [], isWaitingBatch: false, isGenerating: state.chatLock, confirming: false, confirmationUncertain: false, quotaExhausted: false, proposal: null, error: null, sendMessage: vi.fn() }) }));
vi.mock('@/hooks/useEngineHealth', () => ({ useEngineHealth: () => ({ health: { status: 'online' }, refresh: vi.fn() }) }));
vi.mock('@/lib/client/api', async original => ({ ...await original<typeof import('@/lib/client/api')>(), apiFetch: vi.fn() }));
vi.mock('next/link', () => ({ default: ({ children, href }: { children: ReactNode; href: string }) => createElement('a', { href }, children) }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const now = Date.parse('2030-01-01T15:00:00Z');
const fixture = { id: 'demo-shop', slug: 'shop', name: 'Negocio', category: 'Servicios', phoneWhatsApp: '573000000000', timezone: 'America/Bogota', services: [{ id: 'cut', name: 'Corte actual', price: 40000, durationMinutes: 40, bufferMinutes: 5, resourceIds: ['chair'] }], resources: [{ id: 'chair', name: 'Profesional actual', active: true }], weeklySchedule: {}, sarinConfig: { onboardingCompleted: true, tone: '', customRules: '', intakeFields: [] }, subscription: { status: 'active', trialEndsAt: 0, currentPeriodEndsAt: 9999999999999 } } as PublicBusiness;
const source: Appointment = { id: 'demo-visit', tenantId: fixture.id, type: 'appointment', status: 'confirmed', serviceId: 'cut', serviceName: 'Corte anterior', resourceId: 'chair', dateKey: '2030-01-02', startTimeStr: '09:00', endTimeStr: '09:30', startAt: Date.parse('2030-01-02T14:00:00Z'), endAt: Date.parse('2030-01-02T14:30:00Z'), reservedUntilAt: Date.parse('2030-01-02T14:30:00Z'), price: 30000, client: { uid: 'demo-client', name: 'Demo', email: '', phone: '573000000000', intakeAnswers: { old: 'preserve' } }, beneficiary: { kind: 'self' }, createdBy: 'sarin_client', createdAt: 1 };
let renderer: ReactTestRenderer | undefined, business: PublicBusiness, params: Promise<{ slug: string }>;
const text = (node: ReactTestInstance | string): string => typeof node === 'string' ? node : node.children.map(text).join('');
const button = (label: string) => renderer!.root.findAllByType('button').find(node => text(node) === label)!;
const history = () => renderer!.root.findByType(ClientAppointments);
const page = () => createElement(Suspense, { fallback: null }, createElement(ClientPage, { params }));
async function mount() { await act(async () => { renderer = create(page()); }); }
async function update() { await act(async () => renderer!.update(page())); }
async function start() { expect(history().props.reschedulingEnabled).toBe(true); await act(async () => history().props.onReschedule(source)); }
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(now); state.uid = 'demo-client'; state.account = true; state.consent = true; state.ready = true; state.nullPolicy = false; state.chatLock = false; state.mounts = 0;
  business = { ...fixture }; params = Promise.resolve({ slug: 'shop' }); vi.stubGlobal('fetch', vi.fn(async () => Response.json({ business })));
  vi.mocked(apiFetch).mockReset().mockImplementation(async path => { const query = new URL(path, 'http://localhost').searchParams; const subjectCase: BookingSubjectCase = { bookingRequestId: query.get('bookingRequestId')!, subjectKind: 'self' }; return { required: false, active: true, revision: 0, receipt: null, documents: { ...bookingSubjectContent(business, subjectCase, { configured: true, revision: 1, dataMode: 'general', representedMinorsEnabled: false }), fingerprint: 'a'.repeat(64) } }; });
});
afterEach(async () => { await act(async () => renderer?.unmount()); renderer = undefined; vi.unstubAllGlobals(); vi.useRealTimers(); });

it('opens a dedicated fixed source, blocks other actions and new booking, and lets the customer return without a write', async () => {
  await mount(); const retained = history().props.onRebook; await start();
  expect(renderer!.root.findByType(AppointmentReschedule).props.source).toEqual(source); expect(history().props.actionsLocked).toBe(true); expect(history().props.reschedulingEnabled).toBe(false); expect(history().props.rebookingEnabled).toBe(false);
  const current = renderer!.root.findByType(AppointmentReschedule); await act(async () => retained('cut')); expect(renderer!.root.findByType(AppointmentReschedule)).toBe(current);
  await act(async () => button('Volver a Mis citas').props.onClick()); expect(renderer!.root.findAllByType(AppointmentReschedule)).toHaveLength(0); expect(history().props.actionsLocked).toBe(false); expect(vi.mocked(apiFetch).mock.calls.every(([, init]) => !init?.method)).toBe(true);
});

it('allows an exhausted paid trial schedule change while fresh rebooking stays paused', async () => {
  business = { ...fixture, subscription: { status: 'trial', trialEndsAt: 0, currentPeriodEndsAt: 0, paidTrial: { appointmentsUsed: 10, appointmentLimit: 10, source: 'payment' } } } as PublicBusiness;
  await mount(); expect(history().props.rebookingEnabled).toBe(false); await start(); expect(button('Consultar nuevos horarios').props.disabled).toBe(true);
  const day = renderer!.root.findByProps({ 'aria-label': 'Nuevo día de la cita' }); expect(day.props.disabled).toBe(false);
});

it.each(['account', 'consent', 'ready', 'local-action', 'chat'])('blocks a retained entry after the current %s gate closes', async gate => {
  await mount(); const retained = history().props.onReschedule;
  if (gate === 'local-action') await act(async () => history().props.onActionLockChange(true));
  else if (gate === 'chat') { await act(async () => button('Hablar con SarinBot').props.onClick()); state.chatLock = true; await update(); }
  else { state[gate as 'account' | 'consent' | 'ready'] = false; await update(); }
  await act(async () => retained(source)); expect(renderer!.root.findAllByType(AppointmentReschedule)).toHaveLength(0);
});

it('invalidates a changed current source and discards the entry across an account change', async () => {
  await mount(); await start(); await act(async () => history().props.onAppointmentVerified(source.id, { ...source, rescheduleRevision: 1 }));
  expect(renderer!.root.findByType(AppointmentReschedule).props.sourceCurrent).toBe(false);
  state.uid = 'other'; await update(); expect(renderer!.root.findAllByType(AppointmentReschedule)).toHaveLength(0);
});

it('refreshes Mis citas after immutable operation success without installing a historical appointment and explains calendar updates', async () => {
  await mount(); await start(); const mounts = state.mounts;
  await act(async () => renderer!.root.findByType(AppointmentReschedule).props.onConfirmed({ proposalId: 'demo-proof', appointmentId: source.id, revision: 1, dateKey: '2030-01-03', startTimeStr: '10:00', resourceId: 'chair', startAt: Date.parse('2030-01-03T15:00:00Z'), endAt: Date.parse('2030-01-03T15:40:00Z'), confirmedAt: now }));
  expect(renderer!.root.findAllByType(AppointmentReschedule)).toHaveLength(0); expect(state.mounts).toBe(mounts + 1); expect(text(renderer!.root)).toContain('actualizarlo manualmente'); expect(history().props).not.toHaveProperty('appointments');
});

it('keeps the same uncertain operation mounted when the booking policy becomes unavailable', async () => {
  const readSubject = vi.mocked(apiFetch).getMockImplementation()!;
  vi.mocked(apiFetch).mockImplementation(async (path, init, uid) => {
    if (path.endsWith('/reschedule/availability')) return { availability: [{ resourceId: 'chair', resourceName: 'Profesional', slots: ['10:00'] }] };
    if (path.endsWith('/reschedule/proposals')) { const body = JSON.parse(init!.body as string); return { proposal: { id: 'demo-proof', businessId: business.id, serviceName: 'Corte', resourceName: 'Profesional', dateKey: body.selection.dateKey, startTimeStr: '10:00', endTimeStr: '10:40', priceCOP: 40000, expiresAt: now + 600000, intakeFields: [], subjectCase: body.case, reschedule: { appointmentId: source.id, sourceRevision: 0, source: { dateKey: source.dateKey, startTimeStr: source.startTimeStr, endTimeStr: source.endTimeStr, resourceId: source.resourceId, priceCOP: source.price }, targetServiceId: 'cut', targetResourceId: 'chair' } } }; }
    if (path.endsWith('/confirm')) throw new Error('lost response');
    return readSubject(path, init, uid);
  });
  await mount(); await start(); const field = renderer!.root.findByProps({ 'aria-label': 'Nuevo día de la cita' });
  await act(async () => field.props.onChange({ target: { value: '2030-01-03' } })); await act(async () => button('Consultar nuevos horarios').props.onClick()); await act(async () => button('10:00').props.onClick()); await act(async () => button('Revisar cambio de horario').props.onClick()); await act(async () => button('Confirmar cambio de horario').props.onClick());
  const original = vi.mocked(apiFetch).mock.calls.at(-1)!;
  state.ready = false; state.nullPolicy = true; state.account = false; await update();
  expect(renderer!.root.findAllByType(AppointmentReschedule)).toHaveLength(1); expect(button('Recuperar cambio de horario')).toBeDefined(); expect(history().props.actionsLocked).toBe(true);
  await act(async () => button('Recuperar cambio de horario').props.onClick()); expect(vi.mocked(apiFetch).mock.calls.at(-1)![1]!.body).toBe(original[1]!.body);
});

