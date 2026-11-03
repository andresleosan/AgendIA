vi.mock('@/components/auth-provider', () => ({ useAuth: () => ({ authEpoch: 1, isCurrentSession: () => true }) }));
import { clientAppointmentsFixture } from './client-appointments-page-fixtures';
import { act, createElement } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClientAppointments } from "@/components/client-appointments";
import { apiFetch } from "@/lib/client/api";
import type { Appointment } from "@/types/firestore";

const state = vi.hoisted(() => ({
  rows: [] as Appointment[],
  emitImmediately: true,
  resolve: null as null | ((value: unknown) => void),
  reject: null as null | ((error: Error) => void),
  signals: [] as AbortSignal[],
  reads: [] as string[],
  createImage: vi.fn(),
}));
vi.mock('@/lib/client/api', async original => ({ ...await original<typeof import('@/lib/client/api')>(), apiFetch: vi.fn() }));
vi.mock("@/lib/client/appointment-image", () => ({ createAppointmentImage: state.createImage }));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const now = Date.parse("2026-10-16T01:00:00Z"); // Todavía es 15 de octubre en Colombia.
const props = { businessId: "business-fixture", businessName: "Barbería de prueba", userId: "client-fixture", now };
const text = (node: ReactTestInstance | string): string => typeof node === "string" ? node : node.children.map(text).join("");
function appointment(id: string, start: string, status: Appointment["status"] = "confirmed", extra: Partial<Appointment> = {}): Appointment {
  const startAt = Date.parse(start);
  return { id: id.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9_-]/g, '-'), tenantId: props.businessId, type: "appointment", status, dateKey: "2026-10-16", startAt, endAt: startAt + 30 * 60000, reservedUntilAt: startAt + 40 * 60000, startTimeStr: "10:00", endTimeStr: "10:30", serviceName: id, resourceId: "chair", serviceId: "haircut", client: { uid: props.userId, name: "Cliente", email: "cliente@example.invalid", intakeAnswers: {} }, createdBy: "sarin_client", createdAt: now - 86400000, ...extra };
}
const button = (renderer: ReactTestRenderer, label: string) => renderer.root.findAllByType("button").find(node => text(node) === label)!;
const cards = (renderer: ReactTestRenderer) => renderer.root.findAllByType("article");

describe("the customer's appointments within one business", () => {
  let renderer: ReactTestRenderer;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    vi.mocked(apiFetch).mockReset();
    state.createImage.mockReset().mockResolvedValue(new Blob(["png-fixture"], { type: "image/png" }));
    state.signals = []; state.reads = [];
    state.emitImmediately = true;
    state.rows = [appointment("Más tarde", "2026-10-17T15:00:00Z"), appointment("Primera cita", "2026-10-16T15:00:00Z")];
    vi.mocked(apiFetch).mockImplementation((path, init, uid) => {
      if (path.endsWith('/reminders')) return Promise.resolve({ businessId: path.split('/')[3], ownerUid: uid, serverNow: now, preference: { enabled: false, revision: 0, status: 'disabled', offsetMinutes: 1440 }, reminders: [] });
      if (init?.method && !path.endsWith('/query')) return Promise.resolve({});
      state.reads.push(path); state.signals.push(init!.signal as AbortSignal);
      if (state.emitImmediately) return Promise.resolve(clientAppointmentsFixture(state.rows, path, init, uid));
      return new Promise((resolve, reject) => { state.resolve = resolve; state.reject = reject; });
    });
  });
  afterEach(async () => { await act(async () => renderer?.unmount()); vi.useRealTimers(); vi.unstubAllGlobals(); });
  async function render() { await act(async () => { renderer = create(createElement(ClientAppointments, props)); }); vi.mocked(apiFetch).mockClear(); }

  it("shows only the authenticated customer's appointments and sorts upcoming visits by start time", async () => {
    state.rows.push(appointment("Privada de otra persona", "2026-10-16T16:00:00Z", "confirmed", { client: { uid: "other", name: "Otra persona", email: "other@example.invalid", intakeAnswers: {} } }), appointment("Bloqueo privado", "2026-10-16T16:00:00Z", "confirmed", { type: "manual_block" }), appointment("Sin identidad", "2026-10-16T16:00:00Z", "confirmed", { client: undefined }));
    await render();
    expect(cards(renderer).map(text)).toEqual([expect.stringContaining("Primera cita"), expect.stringContaining("Más tarde")]);
    expect(text(renderer.root)).not.toMatch(/Privada de otra persona|Bloqueo privado|Sin identidad/);
    expect(state.reads).toEqual(["/api/businesses/business-fixture/appointments/query"]);
  });
  it('shows beneficiary only for its own booking and keeps legacy identity unspecified', async () => {
    state.rows[0].beneficiary = { kind: 'represented_minor', displayName: 'SYNTHETIC_PRIVATE_SUBJECT', representativeRole: 'parent' };
    state.rows.push(appointment('Otra cita', '2026-10-16T16:00:00Z', 'confirmed', { client: { uid: 'other', name: 'Otra persona', email: '', intakeAnswers: {} }, beneficiary: { kind: 'represented_minor', displayName: 'OTHER_PRIVATE_SUBJECT', representativeRole: 'parent' } }));
    await render(); expect(text(renderer.root)).toContain('SYNTHETIC_PRIVATE_SUBJECT'); expect(text(renderer.root)).toContain('Gestionada por Cliente'); expect(text(renderer.root)).not.toContain('OTHER_PRIVATE_SUBJECT'); expect(text(renderer.root)).toContain('Registro anterior sin beneficiario declarado');
  });

  it("retains cancelled and past visits in descending history with honest status labels", async () => {
    state.rows.push(appointment("Pasada sin asistencia verificada", "2026-10-14T15:00:00Z"), appointment("Cancelada propia", "2026-10-18T15:00:00Z", "cancelled_by_client"), appointment("Cancelada negocio", "2026-10-13T15:00:00Z", "cancelled_by_owner"), appointment("Completada", "2026-10-12T15:00:00Z", "completed"), appointment("Inasistencia", "2026-10-11T15:00:00Z", "no_show"));
    await render();
    await act(async () => button(renderer, "Historial").props.onClick());
    expect(cards(renderer).map(node => node.findByType("h3").children.join(""))).toEqual(["Cancelada propia", "Pasada sin asistencia verificada", "Cancelada negocio", "Completada", "Inasistencia"]);
    expect(text(renderer.root)).toContain("Cancelada por ti");
    expect(text(renderer.root)).toContain("Cancelada por el negocio");
    expect(text(renderer.root)).toContain("Horario finalizado");
    expect(text(renderer.root)).toContain("Completada por el negocio");
    expect(text(renderer.root)).toContain("Inasistencia registrada");
    expect(renderer.root.findAllByType("button").some(node => text(node) === "Cancelar cita")).toBe(false);
    expect(renderer.root.findAllByType("button").some(node => text(node) === "Guardar imagen de la cita")).toBe(false);
  });

  it("uses the Colombian day for its calendar and filters a selected date without showing another customer's visit", async () => {
    state.rows = [appointment("Hoy en Colombia", "2026-10-16T02:00:00Z"), appointment("Mañana cancelada", "2026-10-16T15:00:00Z", "cancelled_by_client")];
    await render();
    await act(async () => button(renderer, "Calendario").props.onClick());
    const date = renderer.root.findByProps({ "aria-label": "Fecha de mis citas" });
    expect(date.props.value).toBe("2026-10-15");
    expect(cards(renderer).map(text)).toEqual([expect.stringContaining("Hoy en Colombia")]);
    await act(async () => date.props.onChange({ target: { value: "2026-10-16" } }));
    expect(cards(renderer).map(text)).toEqual([expect.stringContaining("Mañana cancelada")]);
    expect(text(renderer.root)).toContain("Cancelada por ti");
    await act(async () => date.props.onChange({ target: { value: "2026-10-19" } }));
    expect(text(renderer.root)).toContain("No tienes citas para esta fecha");
  });

  it("requires confirmation, blocks duplicate submissions, and moves the saved cancellation into history", async () => {
    let resolve!: (response: unknown) => void;
    vi.mocked(apiFetch).mockImplementation((path, init, uid) => init?.method && !path.endsWith('/query') ? new Promise(done => { resolve = done; }) : Promise.resolve(clientAppointmentsFixture(state.rows, path, init, uid)));
    state.rows = [appointment("Corte confirmado", "2026-10-16T15:00:00Z")];
    await render();
    await act(async () => button(renderer, "Cancelar cita").props.onClick());
    expect(vi.mocked(apiFetch).mock.calls.filter(([path, init]) => init?.method && !path.endsWith('/query'))).toHaveLength(0);
    const confirm = button(renderer, "Sí, cancelar cita");
    let cancellation!: Promise<void>;
    await act(async () => { cancellation = confirm.props.onClick(); });
    expect(vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(1);
    expect(apiFetch).toHaveBeenCalledWith("/api/businesses/business-fixture/appointments", { method: "PATCH", body: JSON.stringify({ appointmentId: "Corte-confirmado" }) }, props.userId, expect.any(Function));
    expect(button(renderer, "Cancelando…").props.disabled).toBe(true);
    await act(async () => { confirm.props.onClick(); });
    expect(vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(1);
    await act(async () => { state.rows = [{ ...state.rows[0], status: "cancelled_by_client" }]; resolve({ appointment: state.rows[0] }); await cancellation; });
    expect(text(renderer.root)).toContain("Cita cancelada");
    expect(text(renderer.root)).toContain("Cancelada por ti");
    expect(button(renderer, "Historial").props["aria-pressed"]).toBe(true);
    expect(button(renderer, "Cancelar cita")).toBeUndefined();
  });

  it("lets the customer keep the appointment and preserves it when cancellation is rejected", async () => {
    state.rows = [appointment("Cita que se conserva", "2026-10-16T15:00:00Z")];
    vi.mocked(apiFetch).mockImplementation(async (path, init, uid) => { if (init?.method && !path.endsWith('/query')) throw new Error("No se pudo cancelar; vuelve a intentarlo."); return clientAppointmentsFixture(state.rows, path, init, uid); });
    await render();
    await act(async () => button(renderer, "Cancelar cita").props.onClick());
    await act(async () => button(renderer, "Conservar cita").props.onClick());
    expect(vi.mocked(apiFetch).mock.calls.filter(([path, init]) => init?.method && !path.endsWith('/query'))).toHaveLength(0);
    expect(button(renderer, "Sí, cancelar cita")).toBeUndefined();
    await act(async () => button(renderer, "Cancelar cita").props.onClick());
    await act(async () => button(renderer, "Sí, cancelar cita").props.onClick());
    expect(text(renderer.root)).toContain("No se pudo cancelar; vuelve a intentarlo.");
    expect(cards(renderer).map(text)).toEqual([expect.stringContaining("Cita que se conserva")]);
    expect(text(renderer.root)).not.toContain("Cita cancelada.");
  });

  it("keeps read failures separate from the chat and retries its own appointment subscription", async () => {
    state.emitImmediately = false;
    await render();
    expect(text(renderer.root)).toContain("Cargando tus citas");
    await act(async () => state.reject!(new Error("Sin conexión para leer citas")));
    expect(text(renderer.root)).toContain("Sin conexión para leer citas");
    await act(async () => button(renderer, "Reintentar cargar citas").props.onClick());
    expect(state.signals).toHaveLength(2);
    await act(async () => state.resolve!(clientAppointmentsFixture(state.rows, `/api/businesses/${props.businessId}/appointments/query`, undefined, props.userId)));
    expect(text(renderer.root)).toContain("Primera cita");
    expect(text(renderer.root)).not.toContain("Sin conexión para leer citas");
  });

  it("never offers cancellation or calendar export once an appointment has started", async () => {
    state.rows = [appointment("En curso", "2026-10-16T00:45:00Z", "confirmed", { endAt: now + 15 * 60000 })];
    await render();
    expect(text(renderer.root)).toContain("En curso");
    expect(button(renderer, "Cancelar cita")).toBeUndefined();
    expect(button(renderer, "Guardar imagen de la cita")).toBeUndefined();
  });

  it("rechecks the start time when confirming after the screen's clock has become stale", async () => {
    state.rows = [appointment("Comienza pronto", "2026-10-16T01:01:00Z")];
    await render();
    await act(async () => button(renderer, "Cancelar cita").props.onClick());
    vi.setSystemTime(Date.parse("2026-10-16T01:02:00Z"));
    await act(async () => button(renderer, "Sí, cancelar cita").props.onClick());
    expect(vi.mocked(apiFetch).mock.calls.filter(([path, init]) => init?.method && !path.endsWith('/query'))).toHaveLength(0);
  });

  it("does not claim a cancellation succeeded if the server returns a different customer's appointment", async () => {
    state.rows = [appointment("Cita original", "2026-10-16T15:00:00Z")];
    vi.mocked(apiFetch).mockImplementation(async (path, init, uid) => init?.method && !path.endsWith('/query') ? { appointment: { ...state.rows[0], status: "cancelled_by_client", client: { uid: "other" } } } : clientAppointmentsFixture(state.rows, path, init, uid));
    await render();
    await act(async () => button(renderer, "Cancelar cita").props.onClick());
    await act(async () => button(renderer, "Sí, cancelar cita").props.onClick());
    expect(text(renderer.root)).toContain("No se pudo confirmar la cancelación");
    expect(button(renderer, "Próximas").props["aria-pressed"]).toBe(true);
    expect(text(renderer.root)).not.toContain("Cita cancelada.");
  });

  it("ignores stale subscriptions after a change of authenticated account", async () => {
    state.emitImmediately = false;
    await render();
    const staleResolve = state.resolve!;
    await act(async () => renderer.update(createElement(ClientAppointments, { ...props, userId: "new-client" })));
    expect(text(renderer.root)).not.toContain("Primera cita");
    await act(async () => staleResolve(clientAppointmentsFixture(state.rows, `/api/businesses/${props.businessId}/appointments/query`, undefined, props.userId)));
    expect(text(renderer.root)).not.toContain("Primera cita");
    expect(state.signals[0].aborted).toBe(true);
  });

  it("does not present an unknown persisted status as a confirmed appointment", async () => {
    state.rows = [appointment("Estado no reconocido", "2026-10-16T15:00:00Z", "unknown" as Appointment["status"])];
    await render();
    await act(async () => button(renderer, "Historial").props.onClick());
    expect(cards(renderer)).toHaveLength(0);
    expect(text(renderer.root)).not.toContain("Estado no reconocido");
  });

  it("ignores a late cancellation result after switching accounts and businesses", async () => {
    let finish!: (response: unknown) => void;
    vi.mocked(apiFetch).mockImplementation((path, init, uid) => init?.method && !path.endsWith('/query') ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(clientAppointmentsFixture(state.rows, path, init, uid)));
    await render();
    await act(async () => button(renderer, "Cancelar cita").props.onClick());
    let cancellation!: Promise<void>;
    await act(async () => { cancellation = button(renderer, "Sí, cancelar cita").props.onClick(); });
    await act(async () => renderer.update(createElement(ClientAppointments, { ...props, businessId: "another-business", userId: "another-client" })));
    await act(async () => { finish({ appointment: { ...state.rows[0], status: "cancelled_by_client" } }); await cancellation; });
    expect(text(renderer.root)).not.toContain("Cita cancelada.");
    expect(cards(renderer)).toHaveLength(0);
  });

  it("does not let an in-flight pre-cancellation read restore a cancelled appointment", async () => {
    const events = new EventTarget();
    vi.stubGlobal("window", events);
    let reads = 0, oldRead!: (response: unknown) => void;
    vi.mocked(apiFetch).mockImplementation((path, init, uid) => {
      if (path.endsWith('/reminders')) return Promise.resolve({ businessId: path.split('/')[3], ownerUid: uid, serverNow: now, preference: { enabled: false, revision: 0, status: 'disabled', offsetMinutes: 1440 }, reminders: [] });
      if (init?.method && !path.endsWith('/query')) { state.rows = [{ ...state.rows[0], status: "cancelled_by_client" }]; return Promise.resolve({ appointment: state.rows[0] }); }
      if (!path.endsWith('/query')) return Promise.resolve(clientAppointmentsFixture(state.rows, path, init, uid));
      if (++reads === 1) return Promise.resolve(clientAppointmentsFixture(state.rows, path, init, uid));
      return new Promise(resolve => { oldRead = resolve; });
    });
    state.rows = [appointment("Cita original", "2026-10-16T15:00:00Z")];
    await render();
    events.dispatchEvent(new Event("focus"));
    const staleResolve = oldRead;
    const stalePage = clientAppointmentsFixture(state.rows, `/api/businesses/${props.businessId}/appointments/query`, undefined, props.userId);
    await act(async () => button(renderer, "Cancelar cita").props.onClick());
    await act(async () => button(renderer, "Sí, cancelar cita").props.onClick());
    await act(async () => staleResolve(stalePage));
    expect(cards(renderer).map(text)).toEqual([expect.stringContaining("Cancelada por ti")]);
  });

  it("downloads a PNG reminder without exporting contact details or intake answers", async () => {
    state.rows = [appointment("Corte exportado", "2026-10-16T15:00:00Z", 'confirmed', { beneficiary: { kind: 'represented_minor', displayName: 'SYNTHETIC_PRIVATE_SUBJECT', representativeRole: 'parent' }, subjectAuthorization: { receiptId: 'demo-private-receipt', bookingRequestId: 'demo-private-case', policyRevision: 1 }, representationReview: { revision: 0, status: 'declared', reviewedBy: null, reviewedAt: null } })];
    const anchor = { href: "", download: "", click: vi.fn(), remove: vi.fn() };
    vi.stubGlobal("document", { createElement: () => anchor, body: { appendChild: vi.fn() } });
    const createUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:test-image");
    await render();
    expect(button(renderer, "Guardar imagen de la cita")).toBeDefined();
    expect(button(renderer, "Guardar en mi calendario")).toBeUndefined();
    await act(async () => button(renderer, "Guardar imagen de la cita").props.onClick());
    expect(anchor.click).toHaveBeenCalledOnce();
    expect(anchor.download).toMatch(/^cita-.+\.png$/);
    expect(anchor.download + JSON.stringify(state.createImage.mock.calls)).not.toMatch(/SYNTHETIC_PRIVATE_SUBJECT|demo-private|representativeRole|receiptId/);
    expect((createUrl.mock.calls[0][0] as Blob).type).toBe("image/png");
    expect(state.createImage.mock.calls[0][0]).toEqual({ businessName: props.businessName, serviceName: "Corte exportado", resourceName: undefined,
      startAt: state.rows[0].startAt, endAt: state.rows[0].endAt, generatedAt: now });
    expect(text(renderer.root)).toContain("Imagen de la cita descargada");
    createUrl.mockRestore();
  });

  it("prevents duplicate downloads and cancellation while preparing the image", async () => {
    let finish!: (blob: Blob) => void;
    state.createImage.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    await render();
    const exportButton = button(renderer, "Guardar imagen de la cita");
    let saving!: Promise<void>;
    await act(async () => { saving = exportButton.props.onClick(); });
    await act(async () => { exportButton.props.onClick(); });
    expect(state.createImage).toHaveBeenCalledOnce();
    expect(button(renderer, "Preparando imagen…").props.disabled).toBe(true);
    expect(button(renderer, "Cancelar cita").props.disabled).toBe(true);
    await act(async () => renderer.update(createElement(ClientAppointments, { ...props, userId: "another-client" })));
    const createUrl = vi.spyOn(URL, "createObjectURL");
    await act(async () => { finish(new Blob(["png"], { type: "image/png" })); await saving; });
    expect(createUrl).not.toHaveBeenCalled();
    expect(text(renderer.root)).not.toContain("Imagen de la cita descargada");
    createUrl.mockRestore();
  });

  it("discards an image if a fresh read says the appointment was cancelled", async () => {
    const events = new EventTarget();
    vi.stubGlobal("window", events);
    let finish!: (blob: Blob) => void;
    state.createImage.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    await render();
    let saving!: Promise<void>;
    await act(async () => { saving = button(renderer, "Guardar imagen de la cita").props.onClick(); });
    state.rows = state.rows.map(item => ({ ...item, status: "cancelled_by_owner" }));
    await act(async () => events.dispatchEvent(new Event("focus")));
    const createUrl = vi.spyOn(URL, "createObjectURL");
    await act(async () => { finish(new Blob(["png"], { type: "image/png" })); await saving; });
    expect(createUrl).not.toHaveBeenCalled();
    createUrl.mockRestore();
  });

  it("shows an image error and allows retry without changing the appointment", async () => {
    state.createImage.mockRejectedValue(new Error("No pudimos generar la imagen. Inténtalo de nuevo."));
    await render();
    await act(async () => button(renderer, "Guardar imagen de la cita").props.onClick());
    expect(text(renderer.root)).toContain("No pudimos generar la imagen");
    expect(button(renderer, "Guardar imagen de la cita").props.disabled).toBe(false);
    expect(button(renderer, "Cancelar cita")).toBeDefined();
    expect(vi.mocked(apiFetch).mock.calls.filter(([path, init]) => init?.method && !path.endsWith('/query'))).toHaveLength(0);
  });
});
