vi.mock('@/components/auth-provider', () => ({ useAuth: () => ({ authEpoch: 1, isCurrentSession: () => true }) }));
import { clientAppointmentsFixture } from './client-appointments-page-fixtures';
import { act, createElement, StrictMode } from 'react';
import { create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ClientAppointments } from '@/components/client-appointments';
import { apiFetch } from '@/lib/client/api';
import type { Appointment, TenantService } from '@/types/firestore';

const state = vi.hoisted(() => ({ rows: [] as Appointment[], failRead: false, image: vi.fn(), calendar: vi.fn() }));
vi.mock('@/lib/client/api', async original => ({ ...await original<typeof import('@/lib/client/api')>(), apiFetch: vi.fn() }));
vi.mock('@/lib/client/appointment-image', () => ({ createAppointmentImage: state.image }));
vi.mock('@/lib/client/appointment-calendar', () => ({ createAppointmentCalendar: state.calendar }));
vi.mock('@/lib/utils/icsGenerator', () => ({ downloadICSFile: vi.fn() }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const now = Date.parse('2030-01-01T15:00:00Z');
const service: TenantService = { id: 'cut', name: 'Corte vigente', price: 40000, durationMinutes: 40, bufferMinutes: 5, resourceIds: ['chair'] };
const source: Appointment = { id: 'demo-visit', tenantId: 'demo-shop', type: 'appointment', status: 'confirmed', serviceId: 'cut', serviceName: 'Corte anterior', resourceId: 'chair', dateKey: '2030-01-02', startTimeStr: '09:00', endTimeStr: '09:30', startAt: now + 86400000, endAt: now + 88200000, reservedUntilAt: now + 88200000, price: 30000, client: { uid: 'demo-client', name: 'Adulto', email: '', phone: '573000000000', intakeAnswers: { old: 'original' } }, beneficiary: { kind: 'self' }, createdAt: now - 86400000, createdBy: 'sarin_client' };
let renderer: ReactTestRenderer | undefined, events: EventTarget;
type Props = Parameters<typeof ClientAppointments>[0];
let props: Props;
const text = (node: ReactTestInstance | string): string => typeof node === 'string' ? node : node.children.map(text).join('');
const button = (label: string) => renderer!.root.findAllByType('button').find(node => text(node) === label)!;
async function mount() { await act(async () => { renderer = create(createElement(StrictMode, null, createElement(ClientAppointments, props))); }); }
async function update(change: Partial<Props> = {}) { props = { ...props, ...change }; await act(async () => renderer!.update(createElement(StrictMode, null, createElement(ClientAppointments, props)))); }
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(now); events = new EventTarget(); vi.stubGlobal('window', events);
  state.rows = [source]; state.failRead = false; state.image.mockReset(); state.calendar.mockReset();
  props = { businessId: 'demo-shop', businessName: 'Negocio', userId: 'demo-client', now, services: [service], onReschedule: vi.fn(), reschedulingEnabled: true };
  vi.mocked(apiFetch).mockReset().mockImplementation(async (path, init, uid) => {
    if (path.endsWith('/reminders')) return { businessId: path.split('/')[3], ownerUid: uid, serverNow: now, preference: { enabled: false, revision: 0, status: 'disabled', offsetMinutes: 1440 }, reminders: [] };
    if (state.failRead) throw new Error('Lectura fallida'); return clientAppointmentsFixture(state.rows, path, init, uid);
  });
});
afterEach(async () => { await act(async () => renderer?.unmount()); renderer = undefined; vi.unstubAllGlobals(); vi.useRealTimers(); });
it('captures its acquired release so a late export cannot release a later action', async () => {
  const ownRelease = vi.fn(), laterRelease = vi.fn(), legacy = vi.fn();
  props = { ...props, acquireAction: () => ownRelease, onActionLockChange: legacy } as Props;
  await mount(); let finish!: (value: Blob) => void; state.image.mockReturnValue(new Promise<Blob>(resolve => { finish = resolve; }));
  let operation!: Promise<void>; await act(async () => { operation = button('Guardar imagen de la cita').props.onClick(); });
  await update({ userId: 'other', acquireAction: () => laterRelease } as Partial<Props>);
  expect(ownRelease).toHaveBeenCalledTimes(1); expect(laterRelease).not.toHaveBeenCalled();
  await act(async () => { finish(new Blob()); await operation; });
  expect(ownRelease).toHaveBeenCalledTimes(1); expect(laterRelease).not.toHaveBeenCalled(); expect(legacy).not.toHaveBeenCalled();
});

it('offers a manual schedule change only for own future confirmed appointments and emits the exact source without writing', async () => {
  state.rows.push({ ...source, id: 'past', startAt: now - 1000 }, { ...source, id: 'cancelled', status: 'cancelled_by_client' }, { ...source, id: 'other', client: { ...source.client!, uid: 'other' } }, { ...source, id: 'manual', type: 'manual_block' });
  await mount(); const actions = renderer!.root.findAllByType('button').filter(node => text(node) === 'Cambiar horario'); expect(actions).toHaveLength(1);
  vi.mocked(apiFetch).mockClear(); await act(async () => actions[0].props.onClick());
  expect(props.onReschedule).toHaveBeenCalledExactlyOnceWith(source); expect(vi.mocked(apiFetch).mock.calls.filter(([path, init]) => init?.method && !path.endsWith('/query'))).toHaveLength(0);
});

it.each(['source', 'permission', 'read', 'clock', 'account', 'unmount'])('rejects retained change handlers after %s changes', async change => {
  await mount(); const retained = button('Cambiar horario').props.onClick;
  if (change === 'source') { state.rows = [{ ...source, price: 1 }]; await act(async () => events.dispatchEvent(new Event('focus'))); }
  if (change === 'permission') await update({ reschedulingEnabled: false });
  if (change === 'read') { state.failRead = true; await act(async () => events.dispatchEvent(new Event('focus'))); }
  if (change === 'clock') vi.setSystemTime(source.startAt);
  if (change === 'account') await update({ userId: 'other' });
  if (change === 'unmount') { await act(async () => renderer!.unmount()); renderer = undefined; }
  vi.mocked(apiFetch).mockClear(); await act(async () => retained()); expect(props.onReschedule).not.toHaveBeenCalled(); expect(vi.mocked(apiFetch).mock.calls.filter(([path, init]) => init?.method && !path.endsWith('/query'))).toHaveLength(0);
});

it('locks change, PNG, ICS and cancellation while the workspace owns an operation, including retained handlers', async () => {
  await mount(); const retained = ['Cambiar horario', 'Guardar imagen de la cita', 'Añadir al calendario'].map(label => button(label).props.onClick);
  await act(async () => button('Cancelar cita').props.onClick()); const cancel = button('Sí, cancelar cita').props.onClick;
  await update({ actionsLocked: true }); vi.mocked(apiFetch).mockClear();
  expect(button('Cambiar horario').props.disabled).toBe(true); expect(button('Sí, cancelar cita').props.disabled).toBe(true);
  await act(async () => { retained.forEach(handler => handler()); cancel(); });
  expect(props.onReschedule).not.toHaveBeenCalled(); expect(state.image).not.toHaveBeenCalled(); expect(state.calendar).not.toHaveBeenCalled(); expect(vi.mocked(apiFetch).mock.calls.filter(([path, init]) => init?.method && !path.endsWith('/query'))).toHaveLength(0);
});

it('hands the action lock to a reschedule workspace before another retained handler can run in the same event', async () => {
  props.onReschedule = vi.fn(() => true); await mount();
  const change = button('Cambiar horario').props.onClick, image = button('Guardar imagen de la cita').props.onClick, calendar = button('Añadir al calendario').props.onClick;
  await act(async () => { change(); change(); image(); calendar(); });
  expect(props.onReschedule).toHaveBeenCalledOnce(); expect(state.image).not.toHaveBeenCalled(); expect(state.calendar).not.toHaveBeenCalled();
  await update({ actionsLocked: true }); await update({ actionsLocked: false });
  await act(async () => button('Cambiar horario').props.onClick()); expect(props.onReschedule).toHaveBeenCalledTimes(2);
});

it.each(['image', 'calendar', 'cancel'])('blocks a retained change while %s is pending and reports the local action lock', async operation => {
  const onActionLockChange = vi.fn(); props.onActionLockChange = onActionLockChange;
  await mount(); const retained = button('Cambiar horario').props.onClick;
  let finish!: (value: unknown) => void; const pending = new Promise(resolve => { finish = resolve; });
  state.image.mockReturnValue(pending); state.calendar.mockReturnValue(pending);
  if (operation === 'cancel') vi.mocked(apiFetch).mockImplementation(() => pending);
  let action!: Promise<void>;
  await act(async () => { if (operation === 'cancel') { button('Cancelar cita').props.onClick(); } });
  await act(async () => { action = button(operation === 'image' ? 'Guardar imagen de la cita' : operation === 'calendar' ? 'Añadir al calendario' : 'Sí, cancelar cita').props.onClick(); });
  expect(onActionLockChange).toHaveBeenLastCalledWith(true); await act(async () => retained()); expect(props.onReschedule).not.toHaveBeenCalled();
  await update({ userId: 'other' }); await act(async () => { finish(operation === 'cancel' ? { appointment: { ...source, status: 'cancelled_by_client' } } : new Blob()); await action; });
});
