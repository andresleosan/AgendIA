import { clientAppointmentsFixture } from './client-appointments-page-fixtures';
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(), usePathname: () => '/dashboard', useRouter: () => ({ replace: vi.fn() }) }));
vi.mock('@/hooks/use-resource-schedules', () => ({ useResourceSchedules: vi.fn(() => ({ view: null, phase: 'loading' })) }));
import { act, createElement, Suspense, useEffect, type ReactNode } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigurationAssistant } from "@/components/configuration-assistant";
import { createOwnerConfigurationDraft } from "@/lib/owner-configuration";
import ClientPage from "@/app/b/[slug]/page";
import DashboardPage from "@/app/dashboard/page";
vi.mock('@/components/client-policy-controls', () => ({ ClientPolicyControls: () => null }));
import { apiFetch } from "@/lib/client/api";
import type { Appointment, Business } from "@/types/firestore";
import type { ChatResponse } from '@/types/chat';

const state = vi.hoisted(() => ({
  user: { uid: "fixture-client", displayName: "Fixture" },
  accountConsent: true, businessConsent: true,
  policyReady: true, policyKnown: true, minors: true, dataMode: 'general' as 'general' | 'health', chatMount: vi.fn(), engineMount: vi.fn(), structuredMount: vi.fn(), structuredUnmount: vi.fn(),
  structuredProps: null as { onLockedChange: (locked: boolean) => void; initialSubjectKind?: string } | null,
  send: vi.fn(), retry: vi.fn(),
  proposal: undefined as ChatResponse['proposal'], confirmProposal: vi.fn(async () => {}),
  business: null as Business | null,
  publicSubscription: { status: "active", currentPeriodEndsAt: 2200000000000 } as Business["subscription"],
  chat: { messages: [], isWaitingBatch: false, isGenerating: false, confirming: false, confirmationUncertain: false, error: null as string | null, quotaExhausted: false, requestAlreadyCompleted: false },
}));
vi.mock("@/hooks/useDebouncedChat", () => ({ useDebouncedChat: () => { state.chatMount(); return { ...state.chat, proposal: state.proposal, confirmProposal: state.confirmProposal, sendMessage: state.send, retry: state.retry }; } }));
vi.mock('@/hooks/useBookingDataPolicy', () => ({ useBookingDataPolicy: () => ({ ready: state.policyReady, loading: !state.policyReady, error: !state.policyReady && state.policyKnown ? 'Error temporal' : null, refresh: vi.fn(), capability: state.policyKnown ? { configured: true, revision: 1, dataMode: state.dataMode, representedMinorsEnabled: state.minors } : null }) }));
vi.mock('@/components/structured-booking', () => ({ StructuredBooking: (props: { enabled: boolean; initialSubjectKind?: string; onLockedChange: (locked: boolean) => void }) => { state.structuredProps = props; useEffect(() => { state.structuredMount(); return () => { state.structuredUnmount(); }; }, []); return createElement('div', { 'data-enabled': props.enabled, 'data-kind': props.initialSubjectKind }, 'Reserva sin IA'); } }));
vi.mock('@/components/consent-panel', () => ({ useAccountConsent: () => ({ active: state.accountConsent }), ConsentPanel: () => null }));
vi.mock('@/hooks/useConsent', () => ({ useConsent: () => ({ active: state.businessConsent }) }));
vi.mock("@/hooks/useBusiness", () => ({ useBusiness: () => ({ business: state.business, loading: false, error: null }) }));
vi.mock("@/hooks/useEngineHealth", () => ({ useEngineHealth: () => { state.engineMount(); return { health: { status: "online" }, checking: false, refresh: vi.fn() }; } }));
vi.mock("@/components/auth-provider", () => ({ AuthGate: ({ children }: { children: ReactNode }) => children, useAuth: () => ({ user: state.user, authEpoch: 0, isCurrentSession: (uid: string, epoch: number) => uid === state.user.uid && epoch === 0, invalidateSession: vi.fn(), signOut: vi.fn() }) }));
vi.mock("@/components/app-shell", () => ({ AppShell: ({ children }: { children: ReactNode }) => children, Notice: ({ children }: { children: ReactNode }) => children, buttonClass: "button", fieldClass: "field" }));
vi.mock("@/lib/client/api", () => ({ apiFetch: vi.fn(), errorMessage: (error: Error) => error.message }));
vi.mock("next/link", () => ({ default: ({ children, href }: { children: ReactNode; href: string }) => createElement("a", { href }, children) }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const text = (node: ReactTestInstance | string): string => typeof node === "string" ? node : node.children.map(text).join("");

describe("chat pause surfaces", () => {
  let renderer: ReactTestRenderer;
  beforeEach(() => { state.user = { uid: 'fixture-client', displayName: 'Fixture' }; state.proposal = undefined; state.confirmProposal.mockClear(); state.policyReady = true; state.policyKnown = true; state.minors = true; state.dataMode = 'general'; state.chatMount.mockClear(); state.engineMount.mockClear(); state.structuredMount.mockClear(); state.structuredUnmount.mockClear(); state.structuredProps = null; });
  beforeEach(() => { state.accountConsent = true; state.businessConsent = true; state.chat = { messages: [], isWaitingBatch: false, isGenerating: false, confirming: false, confirmationUncertain: false, error: null, quotaExhausted: false, requestAlreadyCompleted: false }; state.send.mockReset(); state.retry.mockReset(); state.publicSubscription = { status: "active", trialEndsAt: 0, currentPeriodEndsAt: 2200000000000 }; state.business = { id: "fixture-business", ownerUid: state.user.uid, name: "Negocio", slug: "negocio", subscription: state.publicSubscription, category: "Servicios", phoneWhatsApp: "", resources: [], services: [], sarinConfig: { onboardingCompleted: true, tone: "Claro", customRules: "", intakeFields: [] }, weeklySchedule: {} } as unknown as Business; vi.mocked(apiFetch).mockReset();
    vi.mocked(apiFetch).mockImplementation(async (path, init, uid) => {
      const appointment = { id: "appointment", tenantId: "fixture-business", resourceId: "fixture-resource", serviceId: "fixture-service", serviceName: "Cita conservada", type: "appointment", status: "confirmed", dateKey: new URL(path, "https://example.invalid").searchParams.get("date") ?? new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(Date.now()), startAt: 2177485200000, endAt: 2177487000000, reservedUntilAt: 2177487000000, startTimeStr: "09:00", endTimeStr: "09:30", createdBy: 'sarin_client', createdAt: 2177400000000, client: { uid: state.user.uid, name: "Fixture", email: "fixture@example.invalid", intakeAnswers: {} } };
      if (path.endsWith('/appointments/query') || /\/appointments\/[^/]+$/.test(path)) return clientAppointmentsFixture([appointment as Appointment], path, init, uid);
      return init?.method ? { appointment: { ...appointment, status: 'cancelled_by_owner' } } : { appointments: [appointment] };
    });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ business: { id: "fixture-business", name: "Negocio sintetico", phoneWhatsApp: "", services: [], subscription: state.publicSubscription } })));
  });
  afterEach(async () => { await act(async () => renderer?.unmount()); vi.unstubAllGlobals(); });
  const modeButton = (label: string) => renderer.root.findAllByType('button').find(button => text(button) === label);
  async function chooseChat() { const button = modeButton('Hablar con SarinBot'); expect(button).toBeDefined(); await act(async () => button!.props.onClick()); }
  it('explains started-response consumption next to the client chat input', async () => {
    await act(async () => { renderer = create(createElement(Suspense, { fallback: null }, createElement(ClientPage, { params: Promise.resolve({ slug: 'fixture' }) }))); });
    await chooseChat();
    expect(text(renderer.root)).toContain('Una respuesta de IA ya iniciada puede consumir una respuesta del plan aunque no llegue a mostrarse');
  });
  it('explains started-response consumption in configuration assistance', async () => {
    const business = { ...state.business!, weeklySchedule: Object.fromEntries(Array.from({ length: 7 }, (_, day) => [day, { isOpen: false, intervals: [] }])) };
    await act(async () => { renderer = create(createElement(ConfigurationAssistant, { uid: state.user.uid, business, enabled: true, busy: false, draft: createOwnerConfigurationDraft(business), onDraft: vi.fn() })); });
    expect(text(renderer.root)).toContain('Una respuesta de IA ya iniciada puede consumir una respuesta del plan aunque no llegue a mostrarse');
  });
  it.each(['+12345678', '12345678', '1234-5678'])('publishes only exact business phone links in the signed-in booking screen: %s', async phoneWhatsApp => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ business: { id: 'fixture-business', name: 'Negocio sintético', phoneWhatsApp, services: [], subscription: state.publicSubscription } })));
    await act(async () => { renderer = create(createElement(Suspense, { fallback: null }, createElement(ClientPage, { params: Promise.resolve({ slug: 'fixture' }) }))); });
    const contact = renderer.root.findByProps({ 'aria-label': 'Contacto del negocio' });
    const links = contact.findAllByType('a');
    expect(links.map(link => link.props.href)).toEqual(phoneWhatsApp === '1234-5678' ? [] : ['tel:+12345678', 'https://wa.me/12345678']);
    if (links.length) expect(links[1].props).toMatchObject({ target: '_blank', rel: 'noopener noreferrer', referrerPolicy: 'no-referrer' });
  });
  it.each([false, true])('starts with the self calendar without chat or engine calls when minors=%s', async minors => {
    state.minors = minors;
    await act(async () => { renderer = create(createElement(Suspense, { fallback: null }, createElement(ClientPage, { params: Promise.resolve({ slug: 'fixture' }) }))); });
    expect(renderer.root.findAllByProps({ 'data-kind': 'self', 'data-enabled': true })).toHaveLength(1);
    expect(modeButton('Reservar con calendario')?.props['aria-pressed']).toBe(true);
    expect(modeButton('Hablar con SarinBot')?.props['aria-pressed']).toBe(false);
    expect(state.chatMount).not.toHaveBeenCalled(); expect(state.engineMount).not.toHaveBeenCalled();
    expect(text(renderer.root)).toContain('Cita conservada');
  });
  it('offers chat explicitly and allows returning to the self calendar', async () => {
    await act(async () => { renderer = create(createElement(Suspense, { fallback: null }, createElement(ClientPage, { params: Promise.resolve({ slug: 'fixture' }) }))); });
    await chooseChat(); expect(state.chatMount).toHaveBeenCalled();
    expect(renderer.root.findAllByProps({ 'aria-label': 'Mensaje para SarinBot' })).toHaveLength(1);
    await act(async () => modeButton('Reservar con calendario')!.props.onClick());
    expect(renderer.root.findAllByProps({ 'data-kind': 'self' })).toHaveLength(1);
    expect(renderer.root.findAllByProps({ 'aria-label': 'Mensaje para SarinBot' })).toHaveLength(0);
  });
  it.each(['isWaitingBatch', 'isGenerating', 'confirming', 'confirmationUncertain'] as const)('locks route and subject changes while chat %s', async flag => {
    const params = Promise.resolve({ slug: 'fixture' }); const view = () => createElement(Suspense, { fallback: null }, createElement(ClientPage, { params }));
    await act(async () => { renderer = create(view()); }); await chooseChat();
    state.chat[flag] = true; await act(async () => renderer.update(view()));
    expect(modeButton('Reservar con calendario')?.props.disabled).toBe(true);
    expect(modeButton('Para un menor a quien represento')?.props.disabled).toBe(true);
    if (flag === 'confirmationUncertain') expect(renderer.root.findByProps({ 'aria-label': 'Mensaje para SarinBot' }).props.disabled).toBe(true);
  });
  it('preserves the calendar controller and locks route changes while confirmation needs recovery', async () => {
    const params = Promise.resolve({ slug: 'fixture' }); const view = () => createElement(Suspense, { fallback: null }, createElement(ClientPage, { params }));
    await act(async () => { renderer = create(view()); });
    expect(state.structuredProps?.initialSubjectKind).toBe('self');
    await act(async () => state.structuredProps!.onLockedChange(true));
    expect(modeButton('Hablar con SarinBot')?.props.disabled).toBe(true);
    state.businessConsent = false; await act(async () => renderer.update(view()));
    expect(state.structuredUnmount).not.toHaveBeenCalled();
    expect(renderer.root.findAllByProps({ 'data-kind': 'self', 'data-enabled': false })).toHaveLength(1);
  });
  it('selects a represented case explicitly and returns to the self calendar', async () => {
    await act(async () => { renderer = create(createElement(Suspense, { fallback: null }, createElement(ClientPage, { params: Promise.resolve({ slug: 'fixture' }) }))); });
    await act(async () => modeButton('Para un menor a quien represento')!.props.onClick());
    expect(renderer.root.findAllByProps({ 'data-kind': 'represented_minor' })).toHaveLength(1);
    expect(modeButton('Hablar con SarinBot')).toBeUndefined();
    await act(async () => modeButton('Para mí')!.props.onClick());
    expect(renderer.root.findAllByProps({ 'data-kind': 'self' })).toHaveLength(1);
  });
  it('keeps calendar unavailable before consent and never mounts chat for health', async () => {
    state.businessConsent = false;
    const params = Promise.resolve({ slug: 'fixture' }); const view = () => createElement(Suspense, { fallback: null }, createElement(ClientPage, { params }));
    await act(async () => { renderer = create(view()); });
    expect(modeButton('Hablar con SarinBot')?.props.disabled).toBe(true);
    expect(state.structuredMount).not.toHaveBeenCalled(); expect(state.chatMount).not.toHaveBeenCalled();
    state.dataMode = 'health'; await act(async () => renderer.update(view()));
    expect(modeButton('Hablar con SarinBot')).toBeUndefined(); expect(state.chatMount).not.toHaveBeenCalled();
  });
  it('keeps appointments and cancellation visible while new chat and booking contact require consent', async () => {
    state.businessConsent = false;
    await act(async () => { renderer = create(createElement(Suspense, { fallback: null }, createElement(ClientPage, { params: Promise.resolve({ slug: 'fixture' }) }))); });
    expect(renderer.root.findAllByProps({ 'aria-label': 'Mensaje para SarinBot' })).toHaveLength(0);
    expect(modeButton('Hablar con SarinBot')?.props.disabled).toBe(true);
    expect(text(renderer.root)).toContain('Cita conservada');
    state.businessConsent = true;
  });
  it('never mounts chat while policy is loading or in a restricted booking flow', async () => {
    state.policyReady = false; state.policyKnown = false; state.chatMount.mockClear();
    const params = Promise.resolve({ slug: 'fixture' });
    await act(async () => { renderer = create(createElement(Suspense, { fallback: null }, createElement(ClientPage, { params }))); });
    expect(state.chatMount).not.toHaveBeenCalled(); expect(text(renderer.root)).toContain('Cita conservada');
    state.policyReady = true; state.policyKnown = true; state.dataMode = 'health';
    await act(async () => renderer.update(createElement(Suspense, { fallback: null }, createElement(ClientPage, { params }))));
    expect(state.chatMount).not.toHaveBeenCalled(); expect(text(renderer.root)).toContain('Reserva sin IA'); state.dataMode = 'general';
  });
  it('keeps the restricted controller mounted across outer withdrawals and policy errors', async () => {
    state.dataMode = 'health';
    const params = Promise.resolve({ slug: 'fixture' }), render = () => createElement(Suspense, { fallback: null }, createElement(ClientPage, { params }));
    await act(async () => { renderer = create(render()); });
    for (const change of [() => { state.accountConsent = false; }, () => { state.businessConsent = false; }, () => { state.policyReady = false; }, () => { state.minors = false; }]) {
      change(); await act(async () => renderer.update(render()));
      expect(state.structuredUnmount).not.toHaveBeenCalled();
      expect(renderer.root.findByProps({ 'data-enabled': false })).toBeTruthy();
    }
    expect(state.structuredMount).toHaveBeenCalledTimes(1); expect(state.chatMount).not.toHaveBeenCalled();
  });
  it.each(['consent', 'policy', 'health'])('keeps the original chat recovery mounted after %s changes', async change => {
    const params = Promise.resolve({ slug: 'fixture' });
    const render = () => createElement(Suspense, { fallback: null }, createElement(ClientPage, { params }));
    await act(async () => { renderer = create(render()); }); await chooseChat();
    state.proposal = { id: 'pending', businessId: 'fixture-business', serviceName: 'Corte', resourceName: 'Uno', dateKey: '2030-01-07', startTimeStr: '09:00', endTimeStr: '09:30', priceCOP: 10000, expiresAt: 2200000000000, intakeFields: [] };
    state.chat.confirmationUncertain = true;
    await act(async () => renderer.update(render()));
    state.structuredMount.mockClear();
    if (change === 'consent') state.businessConsent = false;
    if (change === 'policy') state.policyReady = false;
    if (change === 'health') state.dataMode = 'health';
    await act(async () => renderer.update(render()));
    expect(renderer.root.findAllByProps({ 'aria-label': 'Asistente de reservas' })).toHaveLength(1);
    expect(renderer.root.findByProps({ 'aria-label': 'Mensaje para SarinBot' }).props.disabled).toBe(true);
    expect(renderer.root.findByProps({ 'aria-label': 'Teléfono para la cita' }).props.disabled).toBe(true);
    const recovery = renderer.root.findAllByType('button').find(node => text(node) === 'Recuperar confirmación')!;
    expect(recovery.props.disabled).toBe(false);
    expect(state.structuredMount).not.toHaveBeenCalled();
    state.chat.confirmationUncertain = false; state.proposal = undefined;
    await act(async () => renderer.update(render()));
    if (change === 'health') expect(state.structuredMount).toHaveBeenCalledTimes(1);
  });
  it('does not return a browser scrolling promise as an effect cleanup', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await act(async () => { renderer = create(createElement(Suspense, { fallback: null }, createElement(ClientPage, { params: Promise.resolve({ slug: 'fixture' }) })), { createNodeMock: element => element.type === 'div' ? { scrollIntoView: () => Promise.resolve() } : null }); });
      await chooseChat();
      expect(errors.mock.calls.some(call => String(call[0]).includes('useEffect must not return'))).toBe(false);
    } finally { errors.mockRestore(); }
  });
  it("allows a new configuration message after the server reports the earlier turn completed", async () => {
    state.chat.error = "Solicitud ya atendida";
    state.chat.requestAlreadyCompleted = true;
    const business = { ...state.business!, weeklySchedule: Object.fromEntries(Array.from({ length: 7 }, (_, day) => [day, { isOpen: false, intervals: [] }])) };
    await act(async () => { renderer = create(createElement(ConfigurationAssistant, {
      uid: state.user.uid, business, enabled: true, busy: false,
      draft: createOwnerConfigurationDraft(business), onDraft: vi.fn(),
    })); });
    const input = renderer.root.findAllByType("input").find((node) => node.props["aria-label"] === "Mensaje para SarinBot")!;
    await act(async () => input.props.onChange({ target: { value: "Nueva consulta" } }));
    const send = renderer.root.findAllByType("button").find((node) => node.props["aria-label"] === "Enviar mensaje")!;
    expect(send.props.disabled).toBe(false);
    expect(renderer.root.findAllByType("button").filter((node) => text(node).includes("Reintentar mensaje"))).toHaveLength(0);
    await act(async () => renderer.root.findByProps({ 'aria-label': 'Conversación de configuración' }).props.onSubmit({ preventDefault: vi.fn() }));
    expect(state.send).toHaveBeenCalledExactlyOnceWith("Nueva consulta");
    expect(state.retry).not.toHaveBeenCalled();
  });
  it("pauses public chat without removing confirmed appointments or offering a subscription to the customer", async () => {
    state.chat.error = "Quota details are private";
    state.chat.quotaExhausted = true;
    const params = Promise.resolve({ slug: "fixture" });
    await act(async () => { renderer = create(createElement(Suspense, { fallback: null }, createElement(ClientPage, { params }))); });
    await chooseChat();
    const input = renderer.root.findAllByType("input").find((node) => node.props["aria-label"] === "Mensaje para SarinBot")!;
    expect(input.props.disabled).toBe(true);
    expect(text(renderer.root)).toContain("Cita conservada");
    expect(renderer.root.findAllByType("a").some(node => node.props.href === "#mis-citas" && text(node) === "Mis citas")).toBe(true);
    expect(text(renderer.root)).not.toContain("Quota details are private");
    expect(renderer.root.findAllByType("a").some((node) => node.props.href === "/dashboard/billing")).toBe(false);
    expect(renderer.root.findAllByType("a").some((node) => node.props.href === "/privacidad")).toBe(true);
    expect(renderer.root.findAllByType("a").some((node) => node.props.href === "/ayuda")).toBe(true);
    const check = renderer.root.findAllByType("button").find((node) => text(node) === "Comprobar disponibilidad")!;
    await act(async () => check.props.onClick());
    expect(state.retry).toHaveBeenCalledTimes(1);
  });

  it("keeps owner cancellation available after the tenth appointment and offers a plan", async () => {
    state.business!.subscription = { status: "trial", trialEndsAt: 0, currentPeriodEndsAt: 0, paidTrial: { paymentId: "intro", activatedAt: 1800000000000, appointmentLimit: 10, appointmentsUsed: 10 } };
    await act(async () => { renderer = create(createElement(DashboardPage)); });
    expect(text(renderer.root)).toContain("10 de 10 citas utilizadas");
    expect(text(renderer.root)).toContain("Elige un plan para continuar");
    const cancel = renderer.root.findAllByType("button").find(node => text(node).includes("Cancelar cita"))!;
    expect(cancel.props.disabled).toBe(false);
    await act(async () => cancel.props.onClick());
    expect(vi.mocked(apiFetch)).toHaveBeenCalledWith("/api/businesses/fixture-business/appointments", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ appointmentId: 'appointment' }) }), state.user.uid, expect.any(Function), expect.any(Function));
  });

  it("pauses new public messages after ten introductory appointments while preserving the confirmed appointment", async () => {
    state.publicSubscription = { status: "trial", trialEndsAt: 0, currentPeriodEndsAt: 0, paidTrial: { paymentId: "intro", activatedAt: 1800000000000, appointmentLimit: 10, appointmentsUsed: 10 } };
    await act(async () => { renderer = create(createElement(Suspense, { fallback: null }, createElement(ClientPage, { params: Promise.resolve({ slug: "fixture" }) }))); });
    await chooseChat();
    expect(renderer.root.findByProps({ "aria-label": "Mensaje para SarinBot" }).props.disabled).toBe(true);
    expect(text(renderer.root)).toContain("Cita conservada");
    expect(text(renderer.root)).not.toContain("Elige un plan");
    expect(state.send).not.toHaveBeenCalled();
  });

  it("lets the customer retry the saved tenth appointment after a network failure without sending a new message", async () => {
    state.publicSubscription = { status: "trial", trialEndsAt: 0, currentPeriodEndsAt: 0, paidTrial: { paymentId: "intro", activatedAt: 1800000000000, appointmentLimit: 10, appointmentsUsed: 10 } };
    state.chat.error = "Conexión interrumpida";
    await act(async () => { renderer = create(createElement(Suspense, { fallback: null }, createElement(ClientPage, { params: Promise.resolve({ slug: "fixture" }) }))); });
    await chooseChat();
    const retry = renderer.root.findAllByType("button").find(node => text(node) === "Reintentar mensaje")!;
    expect(retry.props.disabled).toBe(false);
    expect(renderer.root.findByProps({ "aria-label": "Mensaje para SarinBot" }).props.disabled).toBe(true);
    expect(renderer.root.findByProps({ "aria-label": "Enviar mensaje" }).props.disabled).toBe(true);
    await act(async () => retry.props.onClick());
    expect(state.retry).toHaveBeenCalledTimes(1);
    expect(state.send).not.toHaveBeenCalled();
  });

  it("does not display an old agenda read after changing business", async () => {
    const reads: { path: string; signal: AbortSignal; resolve: (value: unknown) => void }[] = [];
    vi.mocked(apiFetch).mockImplementation((path, init) => new Promise(resolve => reads.push({ path, signal: init!.signal as AbortSignal, resolve })));
    await act(async () => { renderer = create(createElement(DashboardPage)); });
    state.business = { ...state.business!, id: "new-business" };
    await act(async () => renderer.update(createElement(DashboardPage)));
    expect(reads[0].signal.aborted).toBe(true);
    const date = new URL(reads[0].path, "https://example.invalid").searchParams.get("date");
    await act(async () => reads[0].resolve({ appointments: [{ id: "private-old", tenantId: "fixture-business", dateKey: date, serviceName: "Private previous agenda", status: "confirmed", startAt: 2177485200000 }] }));
    expect(text(renderer.root)).not.toContain("Private previous agenda");
  });

  it("does not show an old cancellation error in another business", async () => {
    let reject!: (error: Error) => void;
    const read = vi.mocked(apiFetch).getMockImplementation()!;
    vi.mocked(apiFetch).mockImplementation((path, init) => init?.method ? new Promise((_resolve, fail) => { reject = fail; }) : read(path, init));
    await act(async () => { renderer = create(createElement(DashboardPage)); });
    const cancel = renderer.root.findAllByType("button").find(node => text(node).includes("Cancelar cita"))!;
    await act(async () => cancel.props.onClick());
    state.business = { ...state.business!, id: "new-business" };
    await act(async () => renderer.update(createElement(DashboardPage)));
    await act(async () => reject(new Error("Private previous mutation error")));
    expect(text(renderer.root)).not.toContain("Private previous mutation error");
  });
});
