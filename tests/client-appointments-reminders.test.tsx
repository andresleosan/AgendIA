vi.mock('@/components/auth-provider', () => ({ useAuth: () => ({ authEpoch: 1, isCurrentSession: () => true }) }));
import { clientAppointmentsFixture } from './client-appointments-page-fixtures';
import { act, createElement, StrictMode } from 'react';
import { create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ClientAppointments } from '@/components/client-appointments';
import { apiFetch } from '@/lib/client/api';
import type { Appointment } from '@/types/firestore';
import type { AppointmentReminders } from '@/types/appointment-reminders';

vi.mock('@/lib/client/api', async original => ({ ...await original<typeof import('@/lib/client/api')>(), apiFetch: vi.fn() }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const now = Date.parse('2030-01-01T15:00:00Z');
const source: Appointment = { id: 'visit', tenantId: 'shop', type: 'appointment', status: 'confirmed', serviceId: 'service', serviceName: 'Cita privada', resourceId: 'chair', dateKey: '2030-01-01', startTimeStr: '11:00', endTimeStr: '11:30', startAt: now + 3600000, endAt: now + 5400000, reservedUntilAt: now + 5400000, price: 30000, client: { uid: 'customer', name: 'Nombre privado', email: '', phone: '573000000000', intakeAnswers: { private: 'Respuesta privada' } }, createdAt: now - 86400000, createdBy: 'sarin_client' };
const response: AppointmentReminders = { businessId: 'shop', ownerUid: 'customer', serverNow: now, preference: { enabled: true, revision: 1, status: 'active', offsetMinutes: 1440 }, reminders: [{ appointmentId: source.id, sourceRevision: 0, sourceStartAt: source.startAt, offsetMinutes: 1440, availableAt: source.startAt - 86400000, seenAt: null }] };
type Props = Parameters<typeof ClientAppointments>[0];
let renderer: ReactTestRenderer | undefined, props: Props, rows: Appointment[], browser: EventTarget, focus: ReturnType<typeof vi.fn>, scroll: ReturnType<typeof vi.fn>;
const text = (node: ReactTestInstance | string): string => typeof node === 'string' ? node : node.children.map(text).join('');
const button = (label: string) => renderer!.root.findAllByType('button').find(node => text(node) === label)!;
async function mount() { await act(async () => { renderer = create(createElement(StrictMode, null, createElement(ClientAppointments, props)), { createNodeMock: element => element.type === 'article' ? { focus, scrollIntoView: scroll } : null }); }); }
async function update(change: Partial<Props>) { props = { ...props, ...change }; await act(async () => renderer!.update(createElement(StrictMode, null, createElement(ClientAppointments, props)))); }
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(now); rows = [source]; browser = new EventTarget(); vi.stubGlobal('window', browser); focus = vi.fn(); scroll = vi.fn();
  props = { businessId: 'shop', businessName: 'Negocio', userId: 'customer', now };
  vi.mocked(apiFetch).mockReset().mockImplementation(async (path, init, uid) => path.endsWith('/reminders') ? { ...response, reminders: response.reminders.filter(reminder => rows.some(row => row.id === reminder.appointmentId && row.status === 'confirmed' && row.startAt === reminder.sourceStartAt && (row.rescheduleRevision ?? 0) === reminder.sourceRevision)) } : clientAppointmentsFixture(rows, path, init, uid));
});
afterEach(async () => { await act(async () => renderer?.unmount()); renderer = undefined; vi.unstubAllGlobals(); vi.useRealTimers(); });

it('returns from history to the current upcoming card and focuses it without a write', async () => {
  await mount(); await act(async () => button('Historial').props.onClick()); expect(renderer!.root.findAllByType('article')).toHaveLength(0); vi.mocked(apiFetch).mockClear();
  await act(async () => button('Ver cita').props.onClick()); expect(button('Próximas').props['aria-pressed']).toBe(true); expect(focus).toHaveBeenCalled(); expect(scroll).toHaveBeenCalled(); expect(vi.mocked(apiFetch).mock.calls.filter(([path, init]) => init?.method && !path.endsWith('/query'))).toHaveLength(0);
  const card = renderer!.root.findByType('article'); expect(card.props.tabIndex).toBe(-1); expect(text(card)).toContain('Cita privada');
});

it.each(['cancel', 'reschedule', 'revision', 'corrupt-revision'])('hides a stale reminder after canonical %s without waiting for the reminders poll', async change => {
  await mount(); const retained = button('Ver cita').props.onClick;
  rows = [{ ...source, ...(change === 'cancel' ? { status: 'cancelled_by_client' as const } : change === 'reschedule' ? { startAt: source.startAt + 1000 } : { rescheduleRevision: change === 'revision' ? 2 : -1 }) }];
  await act(async () => browser.dispatchEvent(new Event('focus'))); expect(button('Ver cita')).toBeUndefined(); vi.mocked(apiFetch).mockClear(); await act(async () => retained()); expect(focus).not.toHaveBeenCalled(); expect(vi.mocked(apiFetch).mock.calls.filter(([path, init]) => init?.method && !path.endsWith('/query'))).toHaveLength(0);
});

it('uses the parent action mutex even when a retained reminder callback runs before React renders the lock', async () => {
  props.onReschedule = vi.fn(() => true); props.reschedulingEnabled = true; await mount(); const view = button('Ver cita').props.onClick;
  await act(async () => { button('Cambiar horario').props.onClick(); view(); }); expect(props.onReschedule).toHaveBeenCalledOnce(); expect(focus).not.toHaveBeenCalled();
  await update({ actionsLocked: true }); expect(button('Ver cita').props.disabled).toBe(true);
});

it('keeps private appointment details outside the reminder summary', async () => {
  await mount(); const reminders = renderer!.root.findAllByType('section').find(node => node.props['aria-labelledby'] === 'appointment-reminders-title')!;
  expect(text(reminders)).toContain('Tu cita se acerca'); expect(text(reminders)).not.toMatch(/Cita privada|Nombre privado|573000000000|Respuesta privada|30[.,]?000/);
});
