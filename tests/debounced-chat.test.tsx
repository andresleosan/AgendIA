import { act, createElement } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDebouncedChat } from "@/hooks/useDebouncedChat";
import { apiFetch, ApiError } from "@/lib/client/api";
import type { ChatResponse } from "@/types/chat";

vi.mock("@/lib/client/api", async original => ({
  ...await original<typeof import("@/lib/client/api")>(),
  apiFetch: vi.fn(),
  errorMessage: (error: unknown) =>
    error instanceof Error ? error.message : String(error),
}));
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
type Payload = {
  tenantId: string;
  requestId: string;
  messages: Array<{ role: string; content: string }>;
};
function payload(index: number): Payload {
  return JSON.parse(
    String(vi.mocked(apiFetch).mock.calls[index][1]?.body),
  ) as Payload;
}

describe("debounced authenticated chat lifecycle", () => {
  let renderer: ReactTestRenderer | undefined;
  let chat!: ReturnType<typeof useDebouncedChat>;
  function Harness({ tenantId = "business-1", actorUid = 'client', enabled = true }: { tenantId?: string; actorUid?: string; enabled?: boolean }) {
    chat = useDebouncedChat({ mode: "sarin_client", tenantId, actorUid, enabled });
    return null;
  }
  async function mount() {
    await act(async () => {
      renderer = create(createElement(Harness));
    });
  }
  async function advance(milliseconds = 2500) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(milliseconds);
    });
  }
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(apiFetch).mockReset();
  });
  afterEach(async () => {
    await act(async () => renderer?.unmount());
    renderer = undefined;
    vi.useRealTimers();
  });

  it("sends a burst as one user turn after 2.5 seconds from its last message", async () => {
    vi.mocked(apiFetch).mockResolvedValue({ reply: "Hola" });
    await mount();
    act(() => chat.sendMessage("Buenas"));
    await advance(1000);
    act(() => chat.sendMessage("Quiero una cita"));
    await advance(2499);
    expect(apiFetch).not.toHaveBeenCalled();
    await advance(1);
    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(payload(0).messages).toEqual([
      { role: "user", content: "Buenas\nQuiero una cita" },
    ]);
    expect(chat.messages.map((message) => message.content)).toEqual([
      "Buenas",
      "Quiero una cita",
      "Hola",
    ]);
  });

  it('drops pending batches and late results when consent is withdrawn, preserving visible history', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce({ reply: 'Respuesta anterior' });
    await mount(); act(() => chat.sendMessage('Primer mensaje')); await advance();
    act(() => chat.sendMessage('Pendiente no autorizado'));
    await act(async () => renderer?.update(createElement(Harness, { enabled: false })));
    act(() => { chat.sendMessage('No debe salir'); chat.retry(); }); await advance();
    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(chat.messages.map(message => message.content)).toContain('Respuesta anterior');
    expect(chat.isWaitingBatch).toBe(false);
    await act(async () => renderer?.update(createElement(Harness, { enabled: true })));
    const pending = deferred<ChatResponse>(); vi.mocked(apiFetch).mockReturnValueOnce(pending.promise);
    act(() => chat.sendMessage('En curso')); await advance();
    const signal = vi.mocked(apiFetch).mock.calls[1][1]?.signal;
    await act(async () => renderer?.update(createElement(Harness, { enabled: false })));
    expect(signal?.aborted).toBe(true);
    await act(async () => pending.resolve({ reply: 'No aplicar respuesta tardía' }));
    expect(chat.messages.some(message => message.content === 'No aplicar respuesta tardía')).toBe(false);
  });

  it("waits for the running turn before processing a second burst", async () => {
    const first = deferred<ChatResponse>();
    vi.mocked(apiFetch)
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce({ reply: "Segundo" });
    await mount();
    act(() => chat.sendMessage("Primero"));
    await advance();
    act(() => {
      chat.sendMessage("Después");
      chat.sendMessage("Otro dato");
    });
    await advance();
    expect(apiFetch).toHaveBeenCalledTimes(1);
    await act(async () => {
      first.resolve({ reply: "Recibido" });
    });
    expect(apiFetch).toHaveBeenCalledTimes(2);
    expect(payload(1).messages).toEqual([
      { role: "user", content: "Después\nOtro dato" },
    ]);
  });

  it("retries the same request without losing a later burst", async () => {
    const first = deferred<ChatResponse>();
    vi.mocked(apiFetch)
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce({ reply: "Reintentado" })
      .mockResolvedValueOnce({ reply: "Siguiente" });
    await mount();
    act(() => chat.sendMessage("Reserva"));
    await advance();
    act(() => chat.sendMessage("Un dato adicional"));
    await advance();
    await act(async () => {
      first.reject(new Error("Sin conexión"));
    });
    expect(chat.error).toBe("Sin conexión");
    expect(apiFetch).toHaveBeenCalledTimes(1);
    await act(async () => {
      chat.retry();
    });
    expect(apiFetch).toHaveBeenCalledTimes(3);
    expect(payload(1).requestId).toBe(payload(0).requestId);
    expect(payload(1).messages).toEqual(payload(0).messages);
    expect(payload(2).messages.at(-1)).toEqual({
      role: "user",
      content: "Un dato adicional",
    });
    expect(chat.error).toBeNull();
  });

  it("aborts requests and clears conversation when switching businesses", async () => {
    const first = deferred<ChatResponse>();
    vi.mocked(apiFetch).mockImplementationOnce(() => first.promise);
    await mount();
    act(() => chat.sendMessage("Privado del primer negocio"));
    await advance();
    const signal = vi.mocked(apiFetch).mock.calls[0][1]?.signal;
    await act(async () => {
      renderer?.update(createElement(Harness, { tenantId: "business-2" }));
    });
    expect(signal?.aborted).toBe(true);
    await act(async () => {
      first.resolve({ reply: "Respuesta antigua" });
    });
    expect(chat.messages).toEqual([]);
    expect(chat.isGenerating).toBe(false);
    act(() => chat.sendMessage("Pendiente"));
    await act(async () => {
      renderer?.unmount();
      renderer = undefined;
    });
    await advance();
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it("splits oversized bursts and bounds context without limiting later turns", async () => {
    vi.mocked(apiFetch).mockResolvedValue({ reply: "Recibido" });
    await mount();
    act(() => {
      chat.sendMessage("a".repeat(8000));
      chat.sendMessage("b".repeat(8000));
    });
    await advance();
    expect(apiFetch).toHaveBeenCalledTimes(2);
    expect(payload(0).messages.at(-1)?.content).toBe("a".repeat(8000));
    expect(payload(1).messages.at(-1)?.content).toBe("b".repeat(8000));
    for (let index = 0; index < 35; index++) {
      act(() => chat.sendMessage(`Turno ${index}`));
      await advance();
    }
    expect(payload(36).messages.length).toBeLessThanOrEqual(60);
    expect(
      chat.messages.filter((message) => message.role === "user"),
    ).toHaveLength(37);
  });

  it("pauses new messages after quota exhaustion while preserving the failed request for an explicit retry", async () => {
    vi.mocked(apiFetch).mockRejectedValueOnce(Object.assign(new Error("Capacidad agotada"), { status: 402, code: "AI_QUOTA_EXHAUSTED" }));
    await mount();
    act(() => chat.sendMessage("Quiero reservar"));
    await advance();
    expect(chat.quotaExhausted).toBe(true);
    const count = chat.messages.length;
    act(() => chat.sendMessage("No debe acumularse durante la pausa"));
    await advance(10000);
    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(chat.messages).toHaveLength(count);
    vi.mocked(apiFetch).mockResolvedValueOnce({ reply: "Podemos continuar" });
    await act(async () => chat.retry());
    expect(payload(1).requestId).toBe(payload(0).requestId);
    expect(chat.quotaExhausted).toBe(false);
    expect(chat.messages.at(-1)?.content).toBe("Podemos continuar");
  });

  it("does not confuse a transport failure with quota exhaustion", async () => {
    vi.mocked(apiFetch).mockRejectedValueOnce(Object.assign(new Error("Motor temporalmente ocupado"), { status: 429 }));
    await mount();
    act(() => chat.sendMessage("Hola"));
    await advance();
    expect(chat.error).toBe("Motor temporalmente ocupado");
    expect(chat.quotaExhausted).toBe(false);
  });
  it('discards a late reply when UID changes within the same business', async () => {
    const first = deferred<ChatResponse>(); vi.mocked(apiFetch).mockReturnValueOnce(first.promise);
    await mount(); act(() => chat.sendMessage('Private first account')); await advance();
    await act(async () => renderer?.update(createElement(Harness, { actorUid: 'another-client' })));
    await act(async () => first.resolve({ reply: 'Old private answer', stateVersion: 99 }));
    expect(chat.messages).toEqual([]); expect(chat.proposal).toBeUndefined();
  });
  it('serializes explicit confirmation with chat and ignores confirmation from a previous UID', async () => {
    const proposal = { id: 'proposal', businessId: 'business-1', serviceName: 'Corte', resourceName: 'Uno', dateKey: '2030-01-07', startTimeStr: '09:00', endTimeStr: '09:30', priceCOP: 10000, expiresAt: Date.now() + 600000, intakeFields: [] };
    const confirmation = deferred<{ appointment: object }>();
    vi.mocked(apiFetch).mockResolvedValueOnce({ reply: 'Revisa el resumen', proposal, stateVersion: 1 }).mockReturnValueOnce(confirmation.promise);
    await mount(); act(() => chat.sendMessage('Prepara cita')); await advance();
    await act(async () => { void chat.confirmProposal(proposal.id, { clientPhone: '573001234567', intakeAnswers: {} }); });
    act(() => chat.sendMessage('Not admitted while confirming')); await advance();
    expect(apiFetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(vi.mocked(apiFetch).mock.calls[1][1]?.body))).toEqual({ confirm: true, clientPhone: '573001234567', intakeAnswers: {} });
    await act(async () => renderer?.update(createElement(Harness, { actorUid: 'another-client' })));
    await act(async () => confirmation.resolve({ appointment: { tenantId: 'business-1', client: { uid: 'client' }, status: 'confirmed', serviceName: 'Corte', dateKey: '2030-01-07', startTimeStr: '09:00', endTimeStr: '09:30' } }));
    expect(chat.messages).toEqual([]); expect(chat.confirming).toBe(false); expect(chat.confirmationUncertain).toBe(false);
  });
  it('locks an ambiguous confirmation until the same proposal recovers one saved appointment', async () => {
    const proposal = { id: 'proposal-uncertain', businessId: 'business-1', serviceName: 'Corte', resourceName: 'Uno', dateKey: '2030-01-07', startTimeStr: '09:00', endTimeStr: '09:30', priceCOP: 10000, expiresAt: Date.now() + 600000, intakeFields: [] };
    const appointment = { id: 'saved-appointment', tenantId: 'business-1', client: { uid: 'client' }, status: 'confirmed', serviceName: 'Corte', dateKey: '2030-01-07', startTimeStr: '09:00', endTimeStr: '09:30' };
    const confirmation = deferred<{ appointment: typeof appointment }>();
    const recovered = deferred<{ appointment: typeof appointment }>();
    vi.mocked(apiFetch).mockResolvedValueOnce({ reply: 'Revisa el resumen', proposal, stateVersion: 1 }).mockReturnValueOnce(confirmation.promise).mockReturnValueOnce(recovered.promise);
    await mount(); act(() => chat.sendMessage('Prepara cita')); await advance();
    expect(chat.confirmationUncertain).toBe(false);
    await act(async () => { void chat.confirmProposal(proposal.id, { clientPhone: '573001234567', intakeAnswers: {} }); });
    expect(chat.confirming).toBe(true); expect(chat.confirmationUncertain).toBe(true);
    await act(async () => confirmation.reject(new Error('Respuesta perdida después de enviar')));
    expect(chat.confirming).toBe(false); expect(chat.confirmationUncertain).toBe(true);
    expect(chat.proposal).toEqual(proposal);
    const messages = chat.messages;
    act(() => { chat.sendMessage('No reemplazar la propuesta incierta'); chat.retry(); }); await advance();
    expect(chat.messages).toEqual(messages); expect(apiFetch).toHaveBeenCalledTimes(2);
    await act(async () => chat.confirmProposal('another-proposal', { clientPhone: '573001234567', intakeAnswers: {} }));
    expect(apiFetch).toHaveBeenCalledTimes(2);
    await act(async () => { void chat.confirmProposal(proposal.id, { clientPhone: '573009876543', intakeAnswers: { changed: 'ignored during recovery' } }); });
    expect(vi.mocked(apiFetch).mock.calls[2][0]).toBe('/api/businesses/business-1/booking-proposals/proposal-uncertain/confirm');
    expect(vi.mocked(apiFetch).mock.calls[2][1]?.body).toBe(vi.mocked(apiFetch).mock.calls[1][1]?.body);
    await act(async () => recovered.resolve({ appointment }));
    expect(chat.confirming).toBe(false); expect(chat.confirmationUncertain).toBe(false);
    expect(chat.proposal).toBeUndefined();
    expect(chat.messages.filter(message => message.content.startsWith('Tu cita está confirmada.'))).toHaveLength(1);
  });
  it('unlocks a definitive first confirmation rejection without blocking a new turn', async () => {
    const proposal = { id: 'proposal-rejected', businessId: 'business-1', serviceName: 'Corte', resourceName: 'Uno', dateKey: '2030-01-07', startTimeStr: '09:00', endTimeStr: '09:30', priceCOP: 10000, expiresAt: Date.now() + 600000, intakeFields: [] };
    vi.mocked(apiFetch).mockResolvedValueOnce({ reply: 'Revisa el resumen', proposal }).mockRejectedValueOnce(new ApiError('El catálogo cambió', 409, 'BOOKING_PROPOSAL_CHANGED')).mockResolvedValueOnce({ reply: 'Consulta otra fecha' });
    await mount(); act(() => chat.sendMessage('Prepara cita')); await advance();
    await act(async () => chat.confirmProposal(proposal.id, { clientPhone: '573001234567', intakeAnswers: {} }));
    expect(chat.confirmationUncertain).toBe(false); expect(chat.confirming).toBe(false);
    expect(chat.error).toBe('El catálogo cambió');
    act(() => chat.sendMessage('Otra fecha')); await advance();
    expect(apiFetch).toHaveBeenCalledTimes(3); expect(chat.messages.at(-1)?.content).toBe('Consulta otra fecha');
  });
  it('keeps a server failure uncertain even if a later retry returns a definitive rejection', async () => {
    const proposal = { id: 'proposal-server-error', businessId: 'business-1', serviceName: 'Corte', resourceName: 'Uno', dateKey: '2030-01-07', startTimeStr: '09:00', endTimeStr: '09:30', priceCOP: 10000, expiresAt: Date.now() + 600000, intakeFields: [] };
    vi.mocked(apiFetch).mockResolvedValueOnce({ reply: 'Revisa el resumen', proposal }).mockRejectedValueOnce(new ApiError('Servidor sin respuesta válida', 503)).mockRejectedValueOnce(new ApiError('Permiso retirado', 428, 'CONSENT_REQUIRED'));
    await mount(); act(() => chat.sendMessage('Prepara cita')); await advance();
    for (let attempt = 0; attempt < 2; attempt++) {
      await act(async () => chat.confirmProposal(proposal.id, { clientPhone: '573001234567', intakeAnswers: {} }));
      expect(chat.confirmationUncertain).toBe(true); expect(chat.confirming).toBe(false);
    }
    expect(vi.mocked(apiFetch).mock.calls[2][0]).toBe(vi.mocked(apiFetch).mock.calls[1][0]);
  });
  it.each([{ actorUid: 'another-client' }, { tenantId: 'business-2' }])('clears ambiguous confirmation state when its privacy scope changes %j', async scope => {
    const proposal = { id: 'proposal-reset', businessId: 'business-1', serviceName: 'Corte', resourceName: 'Uno', dateKey: '2030-01-07', startTimeStr: '09:00', endTimeStr: '09:30', priceCOP: 10000, expiresAt: Date.now() + 600000, intakeFields: [] };
    vi.mocked(apiFetch).mockResolvedValueOnce({ reply: 'Revisa el resumen', proposal }).mockRejectedValueOnce(new Error('Sin respuesta'));
    await mount(); act(() => chat.sendMessage('Prepara cita')); await advance();
    await act(async () => chat.confirmProposal(proposal.id, { clientPhone: '573001234567', intakeAnswers: {} }));
    expect(chat.confirmationUncertain).toBe(true);
    await act(async () => renderer?.update(createElement(Harness, scope)));
    expect(chat.confirmationUncertain).toBe(false); expect(chat.proposal).toBeUndefined(); expect(chat.confirming).toBe(false);
  });
  it.each([false, true])('retains only the original confirmation for recovery without new permissions, in-flight=%s', async inFlight => {
    const proposal = { id: 'proposal-permission', businessId: 'business-1', serviceName: 'Corte', resourceName: 'Uno', dateKey: '2030-01-07', startTimeStr: '09:00', endTimeStr: '09:30', priceCOP: 10000, expiresAt: Date.now() + 600000, intakeFields: [] };
    const first = deferred<{ appointment: object }>();
    vi.mocked(apiFetch).mockResolvedValueOnce({ reply: 'Revisa el resumen', proposal }).mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({ appointment: { id: 'saved', tenantId: 'business-1', client: { uid: 'client' }, status: 'confirmed' } });
    await mount(); act(() => chat.sendMessage('Prepara cita')); await advance();
    await act(async () => { void chat.confirmProposal(proposal.id, { clientPhone: '573001234567', intakeAnswers: { style: 'original' } }); });
    if (!inFlight) await act(async () => first.reject(new Error('Respuesta perdida')));
    const signal = vi.mocked(apiFetch).mock.calls[1][1]?.signal;
    await act(async () => renderer?.update(createElement(Harness, { enabled: false })));
    if (inFlight) expect(signal?.aborted).toBe(true);
    expect(chat.confirmationUncertain).toBe(true); expect(chat.confirming).toBe(false); expect(chat.proposal).toEqual(proposal);
    act(() => { chat.sendMessage('No enviar'); chat.retry(); }); await advance();
    expect(apiFetch).toHaveBeenCalledTimes(2);
    await act(async () => chat.confirmProposal(proposal.id, { clientPhone: '573009876543', intakeAnswers: { style: 'changed' } }));
    expect(vi.mocked(apiFetch).mock.calls[2][1]?.body).toBe(vi.mocked(apiFetch).mock.calls[1][1]?.body);
    expect(vi.mocked(apiFetch).mock.calls[2][2]).toBe('client');
    expect(chat.confirmationUncertain).toBe(false); expect(chat.proposal).toBeUndefined();
    if (inFlight) await act(async () => first.resolve({ appointment: { id: 'late', tenantId: 'business-1', client: { uid: 'client' } } }));
    expect(chat.messages.filter(message => message.content.startsWith('Tu cita está confirmada.'))).toHaveLength(1);
  });
  it('cannot begin a confirmation after permissions are withdrawn', async () => {
    const proposal = { id: 'not-sent', businessId: 'business-1', intakeFields: [] };
    vi.mocked(apiFetch).mockResolvedValueOnce({ reply: 'Revisa el resumen', proposal });
    await mount(); act(() => chat.sendMessage('Prepara cita')); await advance();
    await act(async () => renderer?.update(createElement(Harness, { enabled: false })));
    await act(async () => chat.confirmProposal(proposal.id, { clientPhone: '573001234567', intakeAnswers: {} }));
    expect(apiFetch).toHaveBeenCalledTimes(1); expect(chat.proposal).toBeUndefined(); expect(chat.confirmationUncertain).toBe(false);
  });
  it('preserves a retry version and starts a fresh request after state conflict', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce({ reply: 'Elegido', stateVersion: 7 }).mockRejectedValueOnce(Object.assign(new Error('State changed'), { code: 'CHAT_STATE_CONFLICT' })).mockResolvedValueOnce({ reply: 'Actualizado', stateVersion: 9 });
    await mount(); act(() => chat.sendMessage('Primer turno')); await advance();
    act(() => chat.sendMessage('Segundo turno')); await advance();
    expect(JSON.parse(String(vi.mocked(apiFetch).mock.calls[1][1]?.body)).stateVersion).toBe(7);
    await act(async () => chat.retry());
    expect(payload(2).requestId).not.toBe(payload(1).requestId);
    expect(JSON.parse(String(vi.mocked(apiFetch).mock.calls[2][1]?.body)).stateVersion).toBeUndefined();
  });

  it.each(["REQUEST_ALREADY_COMPLETED", "AI_RESPONSE_INTERRUPTED"])("does not retry a terminal turn and permits a new request: %s", async code => {
    vi.mocked(apiFetch).mockRejectedValueOnce(Object.assign(new Error("Esta solicitud ya terminó"), { status: 409, code }));
    await mount();
    act(() => chat.sendMessage("Reserva original"));
    await advance();
    expect(chat.requestAlreadyCompleted).toBe(true);
    await act(async () => chat.retry());
    expect(apiFetch).toHaveBeenCalledTimes(1);
    vi.mocked(apiFetch).mockResolvedValueOnce({ reply: "Nueva respuesta" });
    act(() => chat.sendMessage("Consulta nueva"));
    await advance();
    expect(apiFetch).toHaveBeenCalledTimes(2);
    expect(payload(1).requestId).not.toBe(payload(0).requestId);
    expect(payload(1).messages.at(-1)?.content).toBe("Consulta nueva");
    expect(chat.requestAlreadyCompleted).toBe(false);
  });
});
