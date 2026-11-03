import { clientAppointmentsFixture } from './client-appointments-page-fixtures';
import { act, createElement, Suspense, type ReactNode } from 'react';
import { create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import ClientPage from '@/app/b/[slug]/page';
import { ClientAppointments } from '@/components/client-appointments';
import { ClientWaitlist } from '@/components/client-waitlist';
import { ClientWaitlistOffer } from '@/components/client-waitlist-offer';
import { StructuredBooking } from '@/components/structured-booking';
import { BookingProposal } from '@/components/booking-proposal';
import { apiFetch } from '@/lib/client/api';
import type { Appointment, PublicBusiness } from '@/types/firestore';
const access = vi.hoisted(() => ({ uid: 'demo-client', epoch: 1, consent: true }));
vi.mock('@/components/auth-provider', () => ({ useAuth: () => ({ user: { uid: access.uid }, authEpoch: access.epoch, isCurrentSession: (uid: string, epoch: number) => uid === access.uid && epoch === access.epoch, signOut: vi.fn() }), AuthGate: ({ children }: { children: ReactNode }) => children }));
vi.mock('@/components/consent-panel', () => ({ useAccountConsent: () => ({ active: access.consent }), ConsentPanel: () => null }));
vi.mock('@/hooks/useConsent', () => ({ useConsent: () => ({ active: access.consent }) }));
vi.mock('@/hooks/useBookingDataPolicy', () => ({ useBookingDataPolicy: () => ({ ready: true, capability: { configured: true, revision: 1, dataMode: 'general', representedMinorsEnabled: false } }) }));
vi.mock('@/hooks/useBookingSubjectConsent', () => ({ useBookingSubjectConsent: () => ({ active: true, status: { required: false } }) }));
vi.mock('@/components/client-appointment-reminders', () => ({ ClientAppointmentReminders: () => null }));
vi.mock('@/components/business-factual-faq-panel', () => ({ BusinessFactualFaqPanel: () => null }));
vi.mock('@/hooks/useEngineHealth', () => ({ useEngineHealth: () => ({ health: { status: 'online' } }) }));
vi.mock('@/lib/client/api', async original => ({ ...await original<typeof import('@/lib/client/api')>(), apiFetch: vi.fn() }));
vi.mock('next/link', () => ({ default: ({ children, href }: { children: ReactNode; href: string }) => createElement('a', { href }, children) }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const now = Date.parse('2030-01-06T14:00:00Z');
const target = { serviceId: 'cut', serviceName: 'Corte', resourceId: 'one', resourceName: 'Uno', dateKey: '2030-01-06', startTimeStr: '15:00', endTimeStr: '15:30', startAt: Date.parse('2030-01-06T20:00:00Z'), endAt: Date.parse('2030-01-06T20:30:00Z'), reservedUntilAt: Date.parse('2030-01-06T20:35:00Z'), durationMinutes: 30, bufferMinutes: 5, priceCOP: 20000 };
const business = { id: 'demo-business', slug: 'demo', name: 'Demo', category: 'Servicios', phoneWhatsApp: '573000000000', timezone: 'America/Bogota', services: [{ id: 'cut', name: 'Corte', price: 20000, durationMinutes: 30, bufferMinutes: 5, resourceIds: ['one'] }], resources: [{ id: 'one', name: 'Uno', active: true }], weeklySchedule: {}, sarinConfig: { onboardingCompleted: true, tone: '', customRules: '', intakeFields: [] }, subscription: { status: 'active', trialEndsAt: 0, currentPeriodEndsAt: 9999999999999 } } as PublicBusiness;
const offer = { id: 'offer-one', businessId: business.id, waitlistRecordId: 'record', entryId: 'entry', createdAt: now, expiresAt: now + 600000, persistedState: 'offered', target };
const proposal = { offerId: offer.id, entryId: offer.entryId, proposal: { id: 'proposal-one', businessId: business.id, serviceName: target.serviceName, resourceName: target.resourceName, dateKey: target.dateKey, startTimeStr: target.startTimeStr, endTimeStr: target.endTimeStr, priceCOP: target.priceCOP, expiresAt: offer.expiresAt, intakeFields: [], subjectCase: { bookingRequestId: 'demo-case', subjectKind: 'self' } } };
const recovery = () => ({ businessId: business.id, viewerUid: access.uid, serverNow: now, writesEnabled: true, offer, usability: 'ready', proposal, proof: null, appointment: null });
const proof = { appointmentId: 'appointment', proposalId: proposal.proposal.id, entryId: offer.entryId, previousWaitlistRevision: 1, resolvedWaitlistRevision: 2, confirmedAt: now + 1, source: { dateKey: target.dateKey, startAt: target.startAt, endAt: target.endAt, reservedUntilAt: target.reservedUntilAt, resourceId: target.resourceId, serviceId: target.serviceId } };
const appointment: Appointment = { id: 'appointment', tenantId: business.id, type: 'appointment', status: 'confirmed', ...target, client: { uid: 'demo-client', name: 'Demo', email: 'demo@example.invalid', intakeAnswers: {} }, createdAt: now + 1, createdBy: 'sarin_client' };
let tree: ReactTestRenderer | undefined, params: Promise<{ slug: string }>;
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
const text = (node: ReactTestInstance | string): string => typeof node === 'string' ? node : node.children.map(text).join('');
const button = (label: string) => tree!.root.findAllByType('button').find(item => text(item) === label)!;
const page = () => createElement(Suspense, { fallback: null }, createElement(ClientPage, { params }));
const controller = () => tree!.root.findByType(ClientWaitlistOffer).props.controller as Parameters<typeof ClientWaitlistOffer>[0]['controller'];
const mount = async () => { await act(async () => { tree = create(page()); }); };
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(now); access.uid = 'demo-client'; access.epoch = 1; access.consent = true; params = Promise.resolve({ slug: 'demo' }); vi.stubGlobal('fetch', vi.fn(async () => Response.json({ business }))); vi.mocked(apiFetch).mockReset().mockImplementation(async (path, init, uid) => {
  if (path.endsWith('/waitlist')) return { businessId: business.id, ownerUid: access.uid, serverNow: now, revision: 1, request: { id: 'entry', serviceId: 'cut', dateKey: target.dateKey, resourceId: 'one', subjectKind: 'self', createdAt: now - 1000, expiresAt: now + 86400000, status: 'available', checkedAt: now } };
  if (path.endsWith('/offer')) return { businessId: business.id, viewerUid: access.uid, serverNow: now, headRevision: 1, current: recovery() };
  if (path.endsWith('/appointments/query')) return clientAppointmentsFixture([], path, init, uid);
  if (path.endsWith('/availability')) return { availability: [] };
  return recovery();
}); });
afterEach(async () => { await act(async () => tree?.unmount()); tree = undefined; vi.useRealTimers(); vi.unstubAllGlobals(); });
it('passes exactly one stable controller through both slots and keeps independent booking waitlist meaning', async () => { await mount(); expect(tree!.root.findAllByType(ClientWaitlistOffer)).toHaveLength(1); expect(tree!.root.findByType(ClientAppointments).props.waitlistOfferContent).toBeTruthy(); expect(tree!.root.findByType(ClientWaitlist).props.offerContent).toBeTruthy(); expect(text(tree!.root)).toContain('incluso si reservas una cita'); expect(vi.mocked(apiFetch).mock.calls.filter(([path]) => path.endsWith('/offer'))).toHaveLength(0); });
it('pendingConfirmSurvivesOwnLockAndAppointmentsRefresh and success refreshes appointments and waitlist', async () => { await mount(); expect(tree!.root.findAllByType(ClientWaitlistOffer)).toHaveLength(1); await act(async () => controller().check()); const pending = deferred<unknown>(); vi.mocked(apiFetch).mockImplementationOnce(() => pending.promise); let operation!: Promise<void>; await act(async () => { operation = controller().confirm(proposal.proposal.id, { clientPhone: '573001234567', intakeAnswers: {} }); }); expect(controller().busy).toBe(true); const oldAppointments = tree!.root.findByType(ClientAppointments); await act(async () => tree!.root.findByType(StructuredBooking).props.onConfirmed(appointment)); expect(tree!.root.findByType(ClientAppointments)).not.toBe(oldAppointments); expect(controller().busy).toBe(true); expect(tree!.root.findByType(BookingProposal).props.confirming).toBe(true); const before = vi.mocked(apiFetch).mock.calls.length; await act(async () => { pending.resolve({ proof, appointment, replayed: false }); await operation; }); expect(controller().recovery?.proof).toEqual(proof); expect(text(tree!.root)).toContain('Esta solicitud se resolvió'); expect(vi.mocked(apiFetch).mock.calls.slice(before).map(([path]) => path)).toEqual(expect.arrayContaining([expect.stringContaining('/appointments/query'), expect.stringMatching(/\/waitlist$/)])); });
it.each(['offer-first', 'booking-first'] as const)('same-tick competing starts acquire one lease: %s', async order => { await mount(); expect(tree!.root.findAllByType(ClientWaitlistOffer)).toHaveLength(1); await act(async () => tree!.root.findByProps({ 'aria-label': 'Servicio de la reserva' }).props.onChange({ target: { value: 'cut' } })); const check = controller().check, search = button('Consultar horarios').props.onClick; const pending = deferred<unknown>(); vi.mocked(apiFetch).mockImplementationOnce(() => pending.promise); const start = vi.mocked(apiFetch).mock.calls.length; let first!: Promise<void>; await act(async () => { if (order === 'offer-first') { first = check(); search(); } else { first = search(); void check(); } }); expect(vi.mocked(apiFetch).mock.calls.slice(start)).toHaveLength(1); await act(async () => { pending.resolve(order === 'offer-first' ? { businessId: business.id, viewerUid: access.uid, serverNow: now, headRevision: 1, current: recovery() } : { availability: [] }); await first; }); });
it('actionLeaseCannotReleaseAnotherScope after old appointments cleanup and retained release', async () => { await mount(); expect(tree!.root.findAllByType(ClientWaitlistOffer)).toHaveLength(1); const old = tree!.root.findByType(ClientAppointments).props.onActionLockChange; await act(async () => old(true)); await act(async () => old(false)); await act(async () => tree!.root.findByType(StructuredBooking).props.onConfirmed(appointment)); await act(async () => controller().check()); await act(async () => old(false)); expect(tree!.root.findByType(ClientAppointments).props.rebookingEnabled).toBe(false); const before = vi.mocked(apiFetch).mock.calls.length; await act(async () => tree!.root.findByType(ClientAppointments).props.onRebook('cut')); expect(vi.mocked(apiFetch).mock.calls).toHaveLength(before); });
it('recovery remains usable when new consent is revoked, and auth epoch resets the workspace', async () => { await mount(); expect(tree!.root.findAllByType(ClientWaitlistOffer)).toHaveLength(1); await act(async () => controller().check()); access.consent = false; await act(async () => tree!.update(page())); await act(async () => controller().recover()); expect(controller().recovery?.offer.id).toBe(offer.id); access.epoch++; await act(async () => tree!.update(page())); expect(controller().recovery).toBeNull(); });

it('selects a confirmed appointment by ID so a result outside the first page remains recoverable', async () => {
  await mount(); await act(async () => tree!.root.findByType(StructuredBooking).props.onConfirmed(appointment));
  expect(tree!.root.findByType(ClientAppointments).props.selectedAppointmentId).toBe(appointment.id);
});

it.each([true, false])('transfers a verified schedule-change read lease after the parent renders its lock only while consent=%s', async consent => {
  const fallback = vi.mocked(apiFetch).getMockImplementation()!;
  let finish!: (value: unknown) => void, delayPoint = true;
  vi.mocked(apiFetch).mockImplementation(async (path, init, uid, ...guards) => {
    if (path.endsWith('/appointments/appointment') && delayPoint) { delayPoint = false; return new Promise(resolve => { finish = resolve; }); }
    if (path.endsWith('/appointments/query') || path.endsWith('/appointments/appointment')) return clientAppointmentsFixture([appointment], path, init, uid);
    return fallback(path, init, uid, ...guards);
  });
  await mount(); const change = button('Cambiar horario'); expect(change.props.disabled).toBe(false);
  let operation!: Promise<void>; await act(async () => { operation = change.props.onClick(); });
  expect(tree!.root.findByType(ClientAppointments).props.reschedulingEnabled).toBe(false);
  if (!consent) { access.consent = false; await act(async () => tree!.update(page())); }
  await act(async () => { finish({ appointment }); await operation; });
  expect(tree!.root.findAllByProps({ 'aria-label': 'Cambio de horario de mi cita' })).toHaveLength(consent ? 1 : 0);
});
