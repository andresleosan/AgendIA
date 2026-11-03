vi.mock('@/components/auth-provider', () => ({ useAuth: () => ({ authEpoch: 1, isCurrentSession: () => true }) }));
import { clientAppointmentsFixture } from './client-appointments-page-fixtures';
import { act, createElement, StrictMode } from 'react';
import { create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClientAppointments } from '@/components/client-appointments';
import { apiFetch } from '@/lib/client/api';
import type { Appointment, TenantService } from '@/types/firestore';

const state = vi.hoisted(() => ({ rows: [] as Appointment[], readMode: 'ready', resolveRead: null as null | ((value: unknown) => void), resolveMutation: null as null | ((value: unknown) => void), image: vi.fn() }));
vi.mock('@/lib/client/api', async original => ({ ...await original<typeof import('@/lib/client/api')>(), apiFetch: vi.fn() }));
vi.mock('@/lib/client/appointment-image', () => ({ createAppointmentImage: state.image }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const now = Date.parse('2026-10-17T15:00:00Z');
const service: TenantService = { id: 'haircut', name: 'Corte actual del catálogo', price: 32000, durationMinutes: 45, bufferMinutes: 5, resourceIds: ['new-chair'] };
type RebookProps = Parameters<typeof ClientAppointments>[0] & { services?: TenantService[]; onRebook?: (serviceId: string) => void; rebookingEnabled?: boolean };
const base = { businessId: 'demo-rebook-business', businessName: 'Negocio sintético', userId: 'demo-rebook-client', now };
function appointment(id = 'past', extra: Partial<Appointment> = {}): Appointment {
  const startAt = Date.parse('2026-10-16T14:00:00Z');
  return { id, tenantId: base.businessId, type: 'appointment', status: 'completed', dateKey: '2026-10-16', startAt, endAt: startAt + 30 * 60000, reservedUntilAt: startAt + 35 * 60000, startTimeStr: '09:00', endTimeStr: '09:30', resourceId: 'old-chair', serviceId: 'haircut', serviceName: 'Nombre anterior', price: 10000,
    client: { uid: base.userId, name: 'Cliente sintético', email: 'synthetic@example.test', phone: '573000000000', intakeAnswers: { old_answer: 'Datos sintéticos anteriores' } },
    beneficiary: { kind: 'represented_minor', displayName: 'Nombre sintético anterior', representativeRole: 'legal_guardian' }, createdBy: 'sarin_client', createdAt: startAt - 86400000, ...extra };
}
const text = (node: ReactTestInstance | string): string => typeof node === 'string' ? node : node.children.map(text).join('');

describe('rebooking from the own appointment history', () => {
  let renderer: ReactTestRenderer | undefined;
  let props: RebookProps;
  let onRebook = vi.fn<(serviceId: string) => void>();
  let events: EventTarget;
  const button = (label: string) => renderer!.root.findAllByType('button').find(node => text(node) === label)!;
  const rebookButtons = () => renderer!.root.findAllByType('button').filter(node => text(node) === 'Volver a reservar');
  async function mount(overrides: Partial<RebookProps> = {}) { props = { ...props, ...overrides }; await act(async () => { renderer = create(createElement(ClientAppointments, props)); }); vi.mocked(apiFetch).mockClear(); }
  async function update(overrides: Partial<RebookProps>) { props = { ...props, ...overrides }; await act(async () => renderer!.update(createElement(ClientAppointments, props))); }
  async function history() { await act(async () => button('Historial').props.onClick()); }
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(now);
    onRebook = vi.fn<(serviceId: string) => void>(); props = { ...base, services: [service], onRebook, rebookingEnabled: true };
    state.rows = [appointment()]; state.readMode = 'ready'; state.resolveRead = null; state.resolveMutation = null;
    state.image.mockReset().mockResolvedValue(new Blob(['synthetic'], { type: 'image/png' }));
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

  it('uses the current catalog name and emits only its service ID without copying or submitting the old appointment', async () => {
    await mount(); await history();
    const action = rebookButtons()[0];
    expect(action).toBeDefined();
    expect(action.props['aria-label']).toBe('Volver a reservar: Corte actual del catálogo');
    expect(action.props['aria-label']).toContain(text(action));
    expect(action.props.disabled).toBe(false);
    await act(async () => action.props.onClick({ type: 'click' }));
    expect(onRebook.mock.calls).toEqual([['haircut']]);
    expect(vi.mocked(apiFetch).mock.calls.filter(([path, init]) => init?.method && !path.endsWith('/query'))).toHaveLength(0);
  });

  it('offers only valid own historical appointments whose service still exists', async () => {
    const future = { startAt: now + 86400000, endAt: now + 86400000 + 1800000 };
    state.rows = [appointment('completed'), appointment('past-confirmed', { status: 'confirmed' }), appointment('cancelled-client', { ...future, status: 'cancelled_by_client' }), appointment('cancelled-owner', { status: 'cancelled_by_owner' }), appointment('no-show', { status: 'no_show' }),
      appointment('retired-service', { serviceId: 'retired' }), appointment('without-service', { serviceId: undefined }), appointment('another-client', { client: { uid: 'demo-other-client', name: '', email: '', intakeAnswers: {} } }),
      appointment('another-business', { tenantId: 'demo-other-business' }), appointment('manual', { type: 'manual_block' }), appointment('unknown-status', { status: 'unknown' as Appointment['status'] }), appointment('invalid-time', { endAt: Number.NaN }), appointment('upcoming', { ...future, status: 'confirmed' })];
    await mount(); await history();
    expect(rebookButtons()).toHaveLength(5);
    for (const action of rebookButtons()) await act(async () => action.props.onClick());
    expect(onRebook.mock.calls).toEqual([['haircut'], ['haircut'], ['haircut'], ['haircut'], ['haircut']]);
    expect(vi.mocked(apiFetch).mock.calls.filter(([path, init]) => init?.method && !path.endsWith('/query'))).toHaveLength(0);
  });

  it.each([{ onRebook: undefined }, { services: undefined }, { services: [] }, { services: [{ ...service, id: 'other-service' }] }])('omits the action when callback or current service is absent: %j', async overrides => {
    await mount(overrides); await history(); expect(rebookButtons()).toHaveLength(0);
  });

  it.each([false, undefined])('keeps an unavailable affordance disabled when rebookingEnabled=%s', async rebookingEnabled => {
    await mount({ rebookingEnabled }); await history();
    expect(rebookButtons()).toHaveLength(1);
    expect(rebookButtons()[0].props.disabled).toBe(true);
    await act(async () => rebookButtons()[0].props.onClick());
    expect(onRebook).not.toHaveBeenCalled(); expect(vi.mocked(apiFetch).mock.calls.filter(([path, init]) => init?.method && !path.endsWith('/query'))).toHaveLength(0);
  });

  it('limits rebooking to History even when a historical visit is visible in Calendar', async () => {
    state.rows.push(appointment('future', { status: 'confirmed', startAt: now + 86400000, endAt: now + 86400000 + 1800000 }));
    await mount(); expect(rebookButtons()).toHaveLength(0);
    await history(); expect(rebookButtons()).toHaveLength(1);
    await act(async () => button('Calendario').props.onClick());
    await act(async () => renderer!.root.findByProps({ 'aria-label': 'Fecha de mis citas' }).props.onChange({ target: { value: '2026-10-16' } }));
    expect(renderer!.root.findAllByType('article')).toHaveLength(1);
    expect(rebookButtons()).toHaveLength(0);
  });

  it.each(['unmount', 'remount'])('keeps current StrictMode actions usable and invalidates retained actions after %s', async change => {
    const workspace = (version: number) => createElement(StrictMode, null, createElement(ClientAppointments, { ...props, key: version }));
    await act(async () => { renderer = create(workspace(0)); });
    expect(vi.mocked(apiFetch).mock.calls.filter(([path]) => path.endsWith('/appointments/query'))).toHaveLength(2);
    await history();
    const staleClick = rebookButtons()[0].props.onClick;
    await act(async () => staleClick());
    expect(onRebook.mock.calls).toEqual([['haircut']]);
    onRebook.mockClear();

    if (change === 'unmount') { await act(async () => renderer!.unmount()); renderer = undefined; }
    else {
      await act(async () => renderer!.update(workspace(1)));
      await history();
      await act(async () => rebookButtons()[0].props.onClick());
      expect(onRebook.mock.calls).toEqual([['haircut']]);
      onRebook.mockClear();
    }
    vi.mocked(apiFetch).mockClear();
    await act(async () => staleClick());
    expect(onRebook).not.toHaveBeenCalled();
    expect(vi.mocked(apiFetch).mock.calls.filter(([path, init]) => init?.method && !path.endsWith('/query'))).toHaveLength(0);
  });

  it.each(['permission', 'catalog', 'callback', 'view', 'user', 'business', 'unmount'])('rejects a retained handler after its current context changes: %s', async change => {
    await mount(); await history(); const staleClick = rebookButtons()[0]?.props.onClick;
    expect(staleClick).toBeTypeOf('function');
    if (change === 'permission') await update({ rebookingEnabled: false });
    if (change === 'catalog') await update({ services: [] });
    if (change === 'callback') await update({ onRebook: undefined });
    if (change === 'view') await act(async () => button('Próximas').props.onClick());
    if (change === 'user') await update({ userId: 'demo-other-client' });
    if (change === 'business') await update({ businessId: 'demo-other-business' });
    if (change === 'unmount') { await act(async () => renderer!.unmount()); renderer = undefined; }
    vi.mocked(apiFetch).mockClear();
    await act(async () => staleClick());
    expect(onRebook).not.toHaveBeenCalled(); expect(vi.mocked(apiFetch).mock.calls.filter(([path, init]) => init?.method && !path.endsWith('/query'))).toHaveLength(0);
  });

  it.each(['removed', 'changed-service', 'no-longer-history'])('revalidates the current appointment before invoking an old handler: %s', async change => {
    await mount({ services: [service, { ...service, id: 'other-service', name: 'Otro servicio' }] }); await history();
    const staleClick = rebookButtons()[0]?.props.onClick; expect(staleClick).toBeTypeOf('function');
    state.rows = change === 'removed' ? [] : [appointment('past', change === 'changed-service' ? { serviceId: 'other-service' } : { status: 'confirmed', startAt: now + 86400000, endAt: now + 86400000 + 1800000 })];
    await act(async () => events.dispatchEvent(new Event('focus')));
    vi.mocked(apiFetch).mockClear();
    await act(async () => staleClick());
    expect(onRebook).not.toHaveBeenCalled(); expect(vi.mocked(apiFetch).mock.calls.filter(([path, init]) => init?.method && !path.endsWith('/query'))).toHaveLength(0);
  });

  it('blocks retained actions on read failure and while retrying the appointment read', async () => {
    await mount(); await history(); const staleClick = rebookButtons()[0]?.props.onClick; expect(staleClick).toBeTypeOf('function');
    state.readMode = 'error'; await act(async () => events.dispatchEvent(new Event('focus')));
    expect(rebookButtons()[0].props.disabled).toBe(true);
    vi.mocked(apiFetch).mockClear(); await act(async () => staleClick()); expect(onRebook).not.toHaveBeenCalled(); expect(vi.mocked(apiFetch).mock.calls.filter(([path, init]) => init?.method && !path.endsWith('/query'))).toHaveLength(0);
    state.readMode = 'deferred'; await act(async () => button('Reintentar cargar citas').props.onClick());
    expect(rebookButtons()[0].props.disabled).toBe(true);
    vi.mocked(apiFetch).mockClear(); await act(async () => staleClick()); expect(onRebook).not.toHaveBeenCalled(); expect(vi.mocked(apiFetch).mock.calls.filter(([path, init]) => init?.method && !path.endsWith('/query'))).toHaveLength(0);
  });

  it.each(['cancel', 'export'])('blocks rebooking while an existing appointment action is pending: %s', async operation => {
    state.rows.push(appointment('future', { status: 'confirmed', startAt: now + 86400000, endAt: now + 86400000 + 1800000 }));
    let finishImage!: (value: Blob) => void;
    if (operation === 'export') state.image.mockImplementation(() => new Promise(resolve => { finishImage = resolve; }));
    await mount(); await history(); const staleClick = rebookButtons()[0]?.props.onClick; expect(staleClick).toBeTypeOf('function');
    await act(async () => button('Próximas').props.onClick());
    let pendingAction!: Promise<void>;
    if (operation === 'cancel') { await act(async () => button('Cancelar cita').props.onClick()); await act(async () => { pendingAction = button('Sí, cancelar cita').props.onClick(); }); }
    else await act(async () => { pendingAction = button('Guardar imagen de la cita').props.onClick(); });
    await history(); expect(rebookButtons()[0].props.disabled).toBe(true);
    vi.mocked(apiFetch).mockClear(); await act(async () => { rebookButtons()[0].props.onClick(); staleClick(); });
    expect(onRebook).not.toHaveBeenCalled(); expect(vi.mocked(apiFetch).mock.calls.filter(([path, init]) => init?.method && !path.endsWith('/query'))).toHaveLength(0);
    await update({ userId: 'demo-other-client' });
    await act(async () => { if (operation === 'cancel') state.resolveMutation!({ appointment: { ...state.rows[1], status: 'cancelled_by_client' } }); else finishImage(new Blob(['synthetic'], { type: 'image/png' })); await pendingAction; });
  });
});
