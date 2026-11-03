import { act, createElement } from 'react';
import { create, type ReactTestRenderer, type ReactTestInstance } from 'react-test-renderer';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { ClientAppointments } from '@/components/client-appointments';
import { apiFetch } from '@/lib/client/api';
import { readClientAppointmentsPage, readClientAppointment } from '@/lib/server/client-appointments-pagination';
import { memoryFirestore } from './memoryFirestore';
import { seedPagination, paginationAppointment, paginationBusiness, paginationActor, paginationNow } from './client-appointments-pagination-storage-contract';
vi.mock('@/components/auth-provider', () => ({ useAuth: () => ({ authEpoch: 1, isCurrentSession: () => true }) }));
vi.mock('@/lib/client/api', async original => ({ ...await original<typeof import('@/lib/client/api')>(), apiFetch: vi.fn() }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let tree: ReactTestRenderer | undefined, db: ReturnType<typeof memoryFirestore>['db'], events: EventTarget;
const text = (node: ReactTestInstance | string): string => typeof node === 'string' ? node : node.children.map(text).join('');
const button = (label: string) => tree!.root.findAllByType('button').find(node => text(node) === label)!;
const cards = () => tree!.root.findAllByType('article');
const rows = () => Array.from({ length: 45 }, (_, i) => paginationAppointment(`demo-${String(i).padStart(3, '0')}`, { serviceName: `Synthetic visit ${i}`, startAt: paginationNow + 3600000 + i * 1000, endAt: paginationNow + 5400000 + i * 1000 }));
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(paginationNow); events = new EventTarget(); vi.stubGlobal('window', events);
  db = memoryFirestore().db; await seedPagination(db, rows());
  vi.mocked(apiFetch).mockReset().mockImplementation(async (path, init) => {
    if (path.endsWith('/reminders')) return { businessId: paginationBusiness, ownerUid: paginationActor.uid, serverNow: paginationNow, preference: { enabled: true, revision: 1, status: 'active', offsetMinutes: 1440 }, reminders: [{ appointmentId: 'demo-044', sourceRevision: 0, sourceStartAt: rows()[44].startAt, offsetMinutes: 1440, availableAt: rows()[44].startAt - 86400000, seenAt: null }] };
    if (path.endsWith('/query')) return readClientAppointmentsPage(paginationActor, paginationBusiness, JSON.parse(String(init?.body)), db, Date.now());
    return { appointment: await readClientAppointment(paginationActor, paginationBusiness, path.split('/').at(-1)!, db) };
  });
});
afterEach(async () => { await act(async () => tree?.unmount()); tree = undefined; vi.useRealTimers(); vi.unstubAllGlobals(); });
async function mount(extra: Record<string, unknown> = {}) { await act(async () => { tree = create(createElement(ClientAppointments, { businessId: paginationBusiness, businessName: 'Synthetic business', userId: paginationActor.uid, now: paginationNow, ...extra })); }); }
it('reads twenty cards, navigates and retains position until an explicit update', async () => {
  await mount(); expect(cards()).toHaveLength(20); await act(async () => button('Siguiente').props.onClick()); expect(text(cards()[0])).toContain('Synthetic visit 20');
  const ref = db.collection('businesses').doc(paginationBusiness).collection('appointments').doc('demo-020'); await ref.set({ ...(await ref.get()).data(), serviceName: 'Changed visit' });
  await act(async () => events.dispatchEvent(new Event('focus'))); expect(text(cards()[0])).toContain('Synthetic visit 20'); expect(text(tree!.root)).toContain('Actualizar citas');
  await act(async () => button('Actualizar citas').props.onClick()); expect(text(cards()[0])).toContain('Synthetic visit 0');
});
it('a reminder outside the page point-reads and focuses one canonical card without traversing history', async () => {
  await mount(); expect(button('Ver cita')).toBeDefined(); vi.mocked(apiFetch).mockClear(); await act(async () => button('Ver cita').props.onClick());
  expect(cards()).toHaveLength(21); expect(text(cards().at(-1)!)).toContain('Synthetic visit 44'); expect(vi.mocked(apiFetch).mock.calls.map(([path]) => path)).toContain(`/api/businesses/${paginationBusiness}/appointments/demo-044`);
  expect(vi.mocked(apiFetch).mock.calls.some(([path]) => path.endsWith('/query'))).toBe(false);
});
it('verifies an active source by ID independently of the twenty visible appointments', async () => {
  const verified = vi.fn(); await mount({ watchedAppointmentId: 'demo-044', onAppointmentVerified: verified }); expect(verified).toHaveBeenLastCalledWith('demo-044', expect.objectContaining({ id: 'demo-044' }));
  await act(async () => button('Siguiente').props.onClick()); expect(verified).not.toHaveBeenLastCalledWith('demo-044', null);
});

it('authorization loss masks a point-selected card and reminder data immediately', async () => {
  await mount(); await act(async () => button('Ver cita').props.onClick()); expect(cards()).toHaveLength(21);
  const { ApiError } = await import('@/lib/client/api'); vi.mocked(apiFetch).mockRejectedValue(new ApiError('Expired', 401));
  await act(async () => events.dispatchEvent(new Event('focus'))); expect(cards()).toHaveLength(0); expect(text(tree!.root)).not.toContain('Tu cita se acerca');
});

it('polls the single selected result independently when it is outside the current page', async () => {
  await mount({ selectedAppointmentId: 'demo-044' }); expect(cards()).toHaveLength(21);
  const ref = db.collection('businesses').doc(paginationBusiness).collection('appointments').doc('demo-044'); await ref.set({ ...(await ref.get()).data(), status: 'cancelled_by_owner' });
  await act(async () => events.dispatchEvent(new Event('focus'))); expect(text(cards().at(-1)!)).toContain('Cancelada por el negocio');
});
it('a late reminder lookup cannot undo a newer page navigation', async () => {
  await mount(); let finish!: (value: unknown) => void; const actual = await readClientAppointment(paginationActor, paginationBusiness, 'demo-044', db);
  vi.mocked(apiFetch).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  let opening!: Promise<void>; await act(async () => { opening = button('Ver cita').props.onClick(); });
  await act(async () => button('Siguiente').props.onClick()); expect(text(cards()[0])).toContain('Synthetic visit 20');
  await act(async () => { finish({ appointment: actual }); await opening; }); expect(cards()).toHaveLength(20); expect(text(cards()[0])).toContain('Synthetic visit 20');
});
