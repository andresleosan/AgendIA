vi.mock('@/components/auth-provider', () => ({ useAuth: () => ({ authEpoch: 1, isCurrentSession: () => true }) }));
import { clientAppointmentsFixture } from './client-appointments-page-fixtures';
import { act, createElement, StrictMode } from 'react';
import { create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClientAppointments } from '@/components/client-appointments';
import { apiFetch } from '@/lib/client/api';
import type { Appointment, TenantResource, TenantService } from '@/types/firestore';

const state = vi.hoisted(() => ({ rows: [] as Appointment[], readMode: 'ready', resolveRead: null as null | ((value: unknown) => void), resolveMutation: null as null | ((value: unknown) => void), calendar: vi.fn(), image: vi.fn(), download: vi.fn() }));
vi.mock('@/lib/client/api', async original => ({ ...await original<typeof import('@/lib/client/api')>(), apiFetch: vi.fn() }));
vi.mock('@/lib/client/appointment-calendar', () => ({ createAppointmentCalendar: state.calendar }));
vi.mock('@/lib/client/appointment-image', () => ({ createAppointmentImage: state.image }));
vi.mock('@/lib/utils/icsGenerator', () => ({ downloadICSFile: state.download }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const now = Date.parse('2026-10-17T15:00:00Z');
const base = { businessId: 'demo-calendar-business', businessName: 'Negocio sintético', userId: 'demo-private-client', now };
const resource: TenantResource = { id: 'chair', name: 'Silla de prueba', active: true };
const service: TenantService = { id: 'haircut', name: 'Corte', price: 30000, durationMinutes: 30, bufferMinutes: 0, resourceIds: ['chair'] };
type Props = Parameters<typeof ClientAppointments>[0];
const text = (node: ReactTestInstance | string): string => typeof node === 'string' ? node : node.children.map(text).join('');
function appointment(id = 'demo-private-appointment', extra: Partial<Appointment> = {}): Appointment {
  const startAt = Date.parse('2026-10-18T02:00:00Z');
  const item: Appointment & { notes: string } = { id, tenantId: base.businessId, type: 'appointment', status: 'confirmed', dateKey: '2026-10-17', startAt, endAt: startAt + 1800000, reservedUntilAt: startAt + 2100000, startTimeStr: '21:00', endTimeStr: '21:30', serviceId: 'haircut', serviceName: 'Corte de prueba', resourceId: 'chair', price: 30000,
    client: { uid: base.userId, name: 'PRIVATE_NAME', email: 'private@example.invalid', phone: '573000000000', intakeAnswers: { question: 'PRIVATE_ANSWER' } }, beneficiary: { kind: 'represented_minor', displayName: 'PRIVATE_BENEFICIARY', representativeRole: 'parent' }, notes: 'PRIVATE_NOTES', createdBy: 'sarin_client', createdAt: now - 86400000, ...extra };
  return item;
}

describe('explicit calendar file export from own appointments', () => {
  let renderer: ReactTestRenderer | undefined;
  let props: Props;
  let events: EventTarget;
  let onRebook = vi.fn<(id: string) => void>();
  const button = (label: string) => renderer!.root.findAllByType('button').find(node => text(node) === label)!;
  const calendarButtons = () => renderer!.root.findAllByType('button').filter(node => text(node) === 'Añadir al calendario');
  async function mount(overrides: Partial<Props> = {}) { props = { ...props, ...overrides }; await act(async () => { renderer = create(createElement(ClientAppointments, props)); }); vi.mocked(apiFetch).mockClear(); }
  async function update(overrides: Partial<Props> = {}) { props = { ...props, ...overrides }; await act(async () => renderer!.update(createElement(ClientAppointments, props))); }
  async function refresh() { await act(async () => events.dispatchEvent(new Event('focus'))); vi.mocked(apiFetch).mockClear(); }
  async function begin() {
    const action = calendarButtons()[0]; expect(action).toBeDefined();
    let finish!: (content: string) => void;
    state.calendar.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    let task!: Promise<void>;
    await act(async () => { task = action.props.onClick(); });
    expect(state.calendar).toHaveBeenCalledOnce();
    return { finish: async () => { await act(async () => { finish('BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n'); await task; }); } };
  }
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(now);
    onRebook = vi.fn<(id: string) => void>(); props = { ...base, resources: [resource], services: [service], onRebook, rebookingEnabled: true };
    state.rows = [appointment()]; state.readMode = 'ready'; state.resolveRead = null; state.resolveMutation = null;
    state.calendar.mockReset().mockResolvedValue('BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n');
    state.image.mockReset().mockResolvedValue(new Blob(['synthetic'], { type: 'image/png' })); state.download.mockReset();
    events = new EventTarget(); vi.stubGlobal('window', events);
    vi.mocked(apiFetch).mockReset().mockImplementation((path, init, uid) => {
      if (path.endsWith('/reminders')) return Promise.resolve({ businessId: path.split('/')[3], ownerUid: uid, serverNow: now, preference: { enabled: false, revision: 0, status: 'disabled', offsetMinutes: 1440 }, reminders: [] });
      if (!path.endsWith('/query') && !init?.method) return Promise.resolve(clientAppointmentsFixture(state.rows, path, init, uid));
      if (init?.method && !path.endsWith('/query')) return new Promise(resolve => { state.resolveMutation = resolve; });
      if (state.readMode === 'error') return Promise.reject(new Error('Lectura sintética no disponible'));
      if (state.readMode === 'deferred') return new Promise(resolve => { state.resolveRead = resolve; });
      return Promise.resolve(clientAppointmentsFixture(state.rows, path, init, uid));
    });
  });
  afterEach(async () => { await act(async () => renderer?.unmount()); renderer = undefined; vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('downloads only the calendar allowlist, uses the Colombian filename and explains manual updates without a write', async () => {
    await mount();
    expect(state.calendar).not.toHaveBeenCalled(); expect(state.download).not.toHaveBeenCalled();
    expect(text(renderer!.root)).toContain('Se descarga un archivo para importar. No se actualiza automáticamente: consulta Mis citas para ver cambios o cancelaciones.');
    await act(async () => calendarButtons()[0].props.onClick());
    expect(state.calendar.mock.calls).toEqual([[{ businessId: 'demo-calendar-business', appointmentId: 'demo-private-appointment', businessName: 'Negocio sintético', serviceName: 'Corte de prueba', resourceName: 'Silla de prueba', startAt: Date.parse('2026-10-18T02:00:00Z'), endAt: Date.parse('2026-10-18T02:30:00Z') }]]);
    expect(JSON.stringify(state.calendar.mock.calls)).not.toMatch(/demo-private-client|PRIVATE_|private@example|573000000000|intake|beneficiary|notes/);
    expect(state.download.mock.calls).toEqual([['BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n', 'cita-2026-10-17.ics']]);
    expect(text(renderer!.root)).toContain('Archivo de calendario descargado. Los cambios y cancelaciones se consultan en Mis citas.');
    expect(vi.mocked(apiFetch).mock.calls.filter(([path, init]) => init?.method && !path.endsWith('/query'))).toHaveLength(0); expect(state.image).not.toHaveBeenCalled();
  });
  it.each(['calendar', 'image', 'cancel'])('honors a synchronous workspace mutex rejection before %s begins', async kind => {
    await mount({ onActionLockChange: locked => !locked });
    if (kind === 'cancel') await act(async () => button('Cancelar cita').props.onClick());
    await act(async () => { void button(kind === 'calendar' ? 'Añadir al calendario' : kind === 'image' ? 'Guardar imagen de la cita' : 'Sí, cancelar cita').props.onClick(); });
    expect(state.calendar).not.toHaveBeenCalled(); expect(state.image).not.toHaveBeenCalled(); expect(vi.mocked(apiFetch).mock.calls.filter(([path, init]) => init?.method && !path.endsWith('/query'))).toHaveLength(0);
  });

  it('offers export only for valid own future confirmed appointments and keeps the PNG action', async () => {
    state.rows.push(appointment('cancelled', { status: 'cancelled_by_owner' }), appointment('completed', { status: 'completed' }), appointment('ongoing', { startAt: now - 1000, endAt: now + 10000 }), appointment('past', { startAt: now - 10000, endAt: now - 1000 }), appointment('another-client', { client: { uid: 'other', name: '', email: '', intakeAnswers: {} } }), appointment('another-business', { tenantId: 'other' }), appointment('manual', { type: 'manual_block' }), appointment('invalid', { endAt: Number.NaN }));
    await mount(); expect(calendarButtons()).toHaveLength(1); expect(button('Guardar imagen de la cita')).toBeDefined();
    await act(async () => button('Historial').props.onClick()); expect(calendarButtons()).toHaveLength(0);
    await act(async () => button('Calendario').props.onClick()); expect(calendarButtons()).toHaveLength(1);
  });

  it.each(['generator', 'download'])('shows %s failure and permits an explicit retry without changing the booking', async failure => {
    if (failure === 'generator') state.calendar.mockRejectedValueOnce(new Error('No se pudo preparar el calendario.'));
    else state.download.mockImplementationOnce(() => { throw new Error('No se pudo descargar el calendario.'); });
    await mount(); await act(async () => calendarButtons()[0].props.onClick());
    expect(text(renderer!.root)).toContain(failure === 'generator' ? 'No se pudo preparar el calendario.' : 'No se pudo descargar el calendario.');
    expect(text(renderer!.root)).not.toContain('Archivo de calendario descargado.');
    expect(calendarButtons()[0].props.disabled).toBe(false); expect(button('Cancelar cita')).toBeDefined();
    const attempts = state.calendar.mock.calls.length; await refresh(); expect(state.calendar).toHaveBeenCalledTimes(attempts);
    await act(async () => calendarButtons()[0].props.onClick());
    expect(text(renderer!.root)).toContain('Archivo de calendario descargado.'); expect(vi.mocked(apiFetch).mock.calls.filter(([path, init]) => init?.method && !path.endsWith('/query'))).toHaveLength(0);
  });

  it('blocks duplicate calendar exports, PNG, cancellation and rebooking while calendar preparation is pending', async () => {
    state.rows.push(appointment('past', { status: 'completed', startAt: now - 86400000, endAt: now - 84600000 }));
    await mount(); await act(async () => button('Historial').props.onClick()); const retainedRebook = button('Volver a reservar').props.onClick;
    await act(async () => button('Próximas').props.onClick());
    const retainedCalendar = calendarButtons()[0].props.onClick; const retainedImage = button('Guardar imagen de la cita').props.onClick;
    await act(async () => button('Cancelar cita').props.onClick()); const retainedCancel = button('Sí, cancelar cita').props.onClick;
    const pending = await begin();
    expect(button('Preparando calendario…').props.disabled).toBe(true); expect(button('Guardar imagen de la cita').props.disabled).toBe(true); expect(button('Sí, cancelar cita').props.disabled).toBe(true);
    await act(async () => { retainedCalendar(); retainedImage(); retainedCancel(); });
    await act(async () => button('Historial').props.onClick()); expect(button('Volver a reservar').props.disabled).toBe(true);
    await act(async () => { button('Volver a reservar').props.onClick(); retainedRebook(); });
    expect(state.calendar).toHaveBeenCalledOnce(); expect(state.image).not.toHaveBeenCalled(); expect(onRebook).not.toHaveBeenCalled(); expect(vi.mocked(apiFetch).mock.calls.filter(([path, init]) => init?.method && !path.endsWith('/query'))).toHaveLength(0);
    await pending.finish(); expect(state.download).not.toHaveBeenCalled();
  });

  it.each(['cancel', 'image'])('blocks a retained calendar action while %s is pending', async operation => {
    await mount(); const retainedCalendar = calendarButtons()[0].props.onClick;
    let finishImage!: (blob: Blob) => void; state.image.mockImplementation(() => new Promise(resolve => { finishImage = resolve; }));
    let action!: Promise<void>;
    if (operation === 'cancel') { await act(async () => button('Cancelar cita').props.onClick()); await act(async () => { action = button('Sí, cancelar cita').props.onClick(); }); }
    else await act(async () => { action = button('Guardar imagen de la cita').props.onClick(); });
    expect(calendarButtons()[0].props.disabled).toBe(true);
    await act(async () => retainedCalendar()); expect(state.calendar).not.toHaveBeenCalled(); expect(state.download).not.toHaveBeenCalled();
    await update({ userId: 'other' });
    await act(async () => { if (operation === 'cancel') state.resolveMutation!({ appointment: { ...state.rows[0], status: 'cancelled_by_client' } }); else finishImage(new Blob(['synthetic'], { type: 'image/png' })); await action; });
  });

  it.each(['image', 'cancel'])('rejects a retained %s handler from another account before it can lock the current calendar action', async operation => {
    await mount();
    let retained = button('Guardar imagen de la cita').props.onClick;
    if (operation === 'cancel') { await act(async () => button('Cancelar cita').props.onClick()); retained = button('Sí, cancelar cita').props.onClick; }
    state.rows = [appointment(undefined, { client: { uid: 'other', name: '', email: '', intakeAnswers: {} } })];
    await update({ userId: 'other' }); vi.mocked(apiFetch).mockClear();
    await act(async () => { retained(); });
    expect(state.image).not.toHaveBeenCalled(); expect(vi.mocked(apiFetch).mock.calls.filter(([path, init]) => init?.method && !path.endsWith('/query'))).toHaveLength(0);
    expect(calendarButtons()[0].props.disabled).toBe(false);
    await act(async () => calendarButtons()[0].props.onClick()); expect(state.download).toHaveBeenCalledOnce();
  });

  it.each(['cancelled_by_client', 'cancelled_by_owner', 'completed', 'no_show', 'removed', 'time', 'end', 'service', 'resource', 'resource-name', 'business-name', 'owner', 'tenant', 'type', 'clock', 'read-error'])('discards prepared content after the current appointment or metadata changes: %s', async change => {
    await mount(); const pending = await begin();
    if (change === 'removed') state.rows = [];
    else if (['cancelled_by_client', 'cancelled_by_owner', 'completed', 'no_show'].includes(change)) state.rows = [appointment(undefined, { status: change as Appointment['status'] })];
    else if (change === 'time') state.rows = [appointment(undefined, { startAt: state.rows[0].startAt + 1000 })];
    else if (change === 'end') state.rows = [appointment(undefined, { endAt: state.rows[0].endAt + 1000 })];
    else if (change === 'service') state.rows = [appointment(undefined, { serviceName: 'Otro servicio' })];
    else if (change === 'resource') state.rows = [appointment(undefined, { resourceId: 'other-chair' })];
    else if (change === 'owner') state.rows = [appointment(undefined, { client: { uid: 'other', name: '', email: '', intakeAnswers: {} } })];
    else if (change === 'tenant') state.rows = [appointment(undefined, { tenantId: 'other' })];
    else if (change === 'type') state.rows = [appointment(undefined, { type: 'manual_block' })];
    else if (change === 'resource-name') await update({ resources: [{ ...resource, name: 'Otra silla' }] });
    else if (change === 'business-name') await update({ businessName: 'Otro nombre' });
    else if (change === 'clock') vi.setSystemTime(state.rows[0].startAt);
    else if (change === 'read-error') state.readMode = 'error';
    await refresh(); await pending.finish();
    expect(state.download).not.toHaveBeenCalled(); expect(text(renderer!.root)).not.toContain('Archivo de calendario descargado.'); expect(vi.mocked(apiFetch).mock.calls.filter(([path, init]) => init?.method && !path.endsWith('/query'))).toHaveLength(0);
    await update(); expect(state.download).not.toHaveBeenCalled();
  });

  it.each(['user', 'business', 'round-trip', 'unmount'])('discards an in-flight export after %s without replaying it', async change => {
    await mount(); const pending = await begin();
    if (change === 'user' || change === 'round-trip') await update({ userId: 'other' });
    if (change === 'business') await update({ businessId: 'other' });
    if (change === 'round-trip') await update({ userId: base.userId });
    if (change === 'unmount') { await act(async () => renderer!.unmount()); renderer = undefined; }
    await pending.finish(); expect(state.download).not.toHaveBeenCalled();
    if (renderer) expect(text(renderer.root)).not.toContain('Archivo de calendario descargado.');
  });

  it.each(['user', 'business', 'unmount', 'removed', 'cancelled', 'clock', 'read-error', 'retry'])('rejects retained calendar handlers before generation after %s', async change => {
    await mount(); const retained = calendarButtons()[0].props.onClick;
    if (change === 'user') await update({ userId: 'other' });
    if (change === 'business') await update({ businessId: 'other' });
    if (change === 'unmount') { await act(async () => renderer!.unmount()); renderer = undefined; }
    if (change === 'removed' || change === 'cancelled') { state.rows = change === 'removed' ? [] : [appointment(undefined, { status: 'cancelled_by_owner' })]; await refresh(); }
    if (change === 'clock') vi.setSystemTime(state.rows[0].startAt);
    if (change === 'read-error' || change === 'retry') { state.readMode = 'error'; await refresh(); if (change === 'read-error') expect(calendarButtons()[0].props.disabled).toBe(true); }
    if (change === 'retry') { state.readMode = 'deferred'; await act(async () => button('Reintentar cargar citas').props.onClick()); }
    vi.mocked(apiFetch).mockClear(); await act(async () => retained());
    expect(state.calendar).not.toHaveBeenCalled(); expect(state.download).not.toHaveBeenCalled(); expect(vi.mocked(apiFetch).mock.calls.filter(([path, init]) => init?.method && !path.endsWith('/query'))).toHaveLength(0);
  });

  it('allows the current StrictMode handler and rejects its retained action after unmount', async () => {
    await act(async () => { renderer = create(createElement(StrictMode, null, createElement(ClientAppointments, props))); });
    const retained = calendarButtons()[0]?.props.onClick; expect(retained).toBeTypeOf('function');
    await act(async () => retained()); expect(state.download).toHaveBeenCalledOnce();
    await act(async () => renderer!.unmount()); renderer = undefined; state.calendar.mockClear(); state.download.mockClear();
    await act(async () => retained()); expect(state.calendar).not.toHaveBeenCalled(); expect(state.download).not.toHaveBeenCalled();
  });
});
