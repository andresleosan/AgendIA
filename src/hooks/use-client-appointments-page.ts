"use client";

import { useEffect, useRef, useState } from 'react';
import type { Appointment } from '@/types/firestore';
import { apiFetch, ApiError, errorMessage } from '@/lib/client/api';
import { startApiPolling } from '@/lib/client/api-polling';
import { clientAppointmentSchema, compareClientAppointments, clientAppointmentDateKey, clientAppointmentsQuerySchema, clientAppointmentsPageSchema, type ClientAppointmentsCursor, type ClientAppointmentsPage, type ClientAppointmentsView } from '@/lib/client-appointments-pagination';

type Scope = { businessId: string; userId: string; authEpoch: number; isCurrentSession: (uid: string, epoch: number) => boolean };
type Navigation = { base: string; view: ClientAppointmentsView; dateKey: string; stack: (ClientAppointmentsCursor | undefined)[]; incoming?: ClientAppointmentsCursor; revision: number; chain: number };
type Snapshot = { key: string; page: ClientAppointmentsPage | null; loading: boolean; error: string | null; changed: boolean };
const message = 'Tus citas cambiaron. Usa Actualizar citas para volver al inicio.';

export function useClientAppointmentsPage(input: Scope) {
  const base = JSON.stringify([input.businessId, input.userId, input.authEpoch]);
  const initial = (): Navigation => ({ base, view: 'upcoming', dateKey: clientAppointmentDateKey(Date.now()), stack: [], revision: 0, chain: 0 });
  const [navigation, setNavigation] = useState<Navigation>(initial);
  const active = navigation.base === base ? navigation : initial();
  const key = JSON.stringify([base, active.view, active.dateKey, active.incoming, active.revision]);
  const [snapshot, setSnapshot] = useState<Snapshot>({ key: '', page: null, loading: true, error: null, changed: false });
  const saved = useRef(snapshot);
  const observed = useRef<{ key: string; rows: Appointment[] }>({ key: "", rows: [] });
  const visited = useRef<{ chain: string; ids: Map<number, Set<string>> }>({ chain: "", ids: new Map() });
  const retained = useRef<{ context: string; page: ClientAppointmentsPage } | null>(null);
  const mounted = useRef(true);
  const context = JSON.stringify([base, active.view, active.dateKey]);
  const chain = JSON.stringify([context, active.chain]);
  const blocked = useRef<string | null>(null);
  const polling = useRef<ReturnType<typeof startApiPolling<ClientAppointmentsPage>> | null>(null);
  const points = useRef(new Set<AbortController>());
  const transitionLock = useRef(false);
  const current = useRef({ ...input, base, key, navigation: active });
  current.current = { ...input, base, key, navigation: active };
  const authorized = () => mounted.current && blocked.current !== current.current.base && current.current.isCurrentSession(current.current.userId, current.current.authEpoch);
  function publish(value: Snapshot) { saved.current = value; setSnapshot(value); }
  function loseAccess() {
    blocked.current = current.current.base;
    retained.current = null;
    publish({ key: current.current.key, page: null, loading: false, error: 'Tu sesión dejó de ser válida. Vuelve a iniciar sesión.', changed: false });
  }
  async function deadline<T>(job: (signal: AbortSignal) => Promise<T>, controller: AbortController): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([job(controller.signal), new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new ApiError('La lectura superó el tiempo de espera. Inténtalo de nuevo.', 503)); }, 10000);
      })]);
    } finally { if (timer !== undefined) clearTimeout(timer); }
  }

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    transitionLock.current = false;
    const scope = current.current;
    const owns = () => current.current.key === key && authorized();
    let firstResult = true;
    publish({ key, page: retained.current?.context === context ? retained.current.page : null, loading: true, error: null, changed: false });
    if (!owns()) return;
    const parsed = clientAppointmentsQuerySchema.safeParse({ version: 1, view: active.view, ...(active.view === 'calendar' ? { dateKey: active.dateKey } : {}), ...(active.incoming ? { cursor: active.incoming } : {}) });
    if (!parsed.success) {
      publish({ key, page: null, loading: false, error: active.dateKey ? 'Elige una fecha válida.' : null, changed: false });
      return;
    }
    const read = async (signal: AbortSignal) => {
      const abort = new AbortController();
      const cancel = () => abort.abort(); signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) abort.abort();
      try {
        const raw = await deadline(child => apiFetch<unknown>(`/api/businesses/${encodeURIComponent(scope.businessId)}/appointments/query`, {
          method: 'POST', body: JSON.stringify(parsed.data), signal: child,
        }, scope.userId, owns, status => {
          if (!owns()) return;
          if (status === 401 || status === 403) { loseAccess(); abort.abort(); throw new ApiError('La sesión cambió.', status); }
          if (status === 409) { abort.abort(); throw new ApiError(message, 409, 'CLIENT_APPOINTMENTS_CHANGED'); }
        }), abort);
        if (!owns() || abort.signal.aborted) throw new ApiError('La consulta cambió.', 409);
        const result = clientAppointmentsPageSchema.safeParse(raw);
        if (!result.success) throw new ApiError('No se pudo comprobar la página de citas.', 503);
        const page = result.data;
        if (page.scope.businessId !== scope.businessId || page.scope.clientUid !== scope.userId || page.view !== parsed.data.view
          || page.dateKey !== (parsed.data.dateKey ?? null) || parsed.data.cursor && page.asOf !== parsed.data.cursor.asOf) throw new ApiError('La página pertenece a otra consulta.', 503);
        const cursor = parsed.data.cursor;
        if (cursor && page.rows.some(row => compareClientAppointments(page.view, { id: cursor.appointmentId, startAt: cursor.startAt }, row) >= 0)) throw new ApiError(message, 409, 'CLIENT_APPOINTMENTS_CHANGED');
        if (visited.current.chain === chain && page.rows.some(row => [...visited.current.ids].some(([index, ids]) => index !== active.stack.length && ids.has(row.id)))) throw new ApiError(message, 409, 'CLIENT_APPOINTMENTS_CHANGED');
        return page;
      } finally { signal.removeEventListener('abort', cancel); }
    };
    const poll = startApiPolling(read, page => {
      if (!owns()) return;
      if (visited.current.chain !== chain) visited.current = { chain, ids: new Map() };
      visited.current.ids.set(active.stack.length, new Set(page.rows.map(row => row.id)));
      observed.current = { key, rows: page.rows };
      const previous = saved.current.key === key ? saved.current : null;
      if (!firstResult && previous?.page && (previous.changed || JSON.stringify(previous.page.rows) !== JSON.stringify(page.rows))) {
        publish({ key, page: previous.page, loading: false, error: null, changed: true });
      } else {
        retained.current = { context, page };
        publish({ key, page, loading: false, error: null, changed: false });
      }
      firstResult = false;
    }, error => {
      if (!owns()) return;
      if (error instanceof ApiError && (error.status === 401 || error.status === 403)) { loseAccess(); return; }
      const previous = saved.current.key === key ? saved.current : null;
      const changed = Boolean(previous?.changed || error instanceof ApiError && error.status === 409);
      publish({ key, page: previous?.page ?? null, loading: false, error: changed ? message : errorMessage(error), changed });
    }, { abortOnBlur: true, waitForPending: true });
    polling.current = poll;
    return () => { poll.stop(); if (polling.current === poll) polling.current = null; };
  }, [key]);

  useEffect(() => () => { for (const point of points.current) point.abort(); points.current.clear(); }, [base]);
  function transition(next: Navigation) {
    if (current.current.key !== key || !authorized() || transitionLock.current) return;
    transitionLock.current = true;
    polling.current?.stop();
    setNavigation(next);
  }
  const state = snapshot.key === key && authorized() ? snapshot : { page: null, loading: authorized(), error: snapshot.key === key ? snapshot.error : null, changed: false };
  function next() {
    if (state.loading || state.changed || state.error || !state.page?.nextCursor) return;
    transition({ ...active, stack: [...active.stack, active.incoming], incoming: state.page.nextCursor, revision: active.revision + 1 });
  }
  function previous() {
    if (state.loading || state.changed || !active.stack.length) return;
    transition({ ...active, incoming: active.stack.at(-1), stack: active.stack.slice(0, -1), revision: active.revision + 1 });
  }
  async function lookup(id: string): Promise<Appointment> {
    const scope = current.current;
    const owns = () => current.current.base === scope.base && authorized();
    if (!owns() || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new ApiError('No se pudo verificar la cita.', 403);
    const abort = new AbortController(); points.current.add(abort);
    try {
      const response = await deadline(signal => apiFetch<{ appointment: unknown }>(`/api/businesses/${encodeURIComponent(scope.businessId)}/appointments/${encodeURIComponent(id)}`, { signal }, scope.userId, owns, status => {
        if (owns() && (status === 401 || status === 403)) loseAccess();
      }), abort);
      if (!owns() || abort.signal.aborted) throw new ApiError('La sesión cambió.', 401);
      const row = clientAppointmentSchema.safeParse(response.appointment);
      if (!row.success || row.data.id !== id || row.data.tenantId !== scope.businessId || row.data.client?.uid !== scope.userId) throw new ApiError('No se pudo comprobar la cita.', 503);
      return row.data;
    } catch (error) {
      if (owns() && error instanceof ApiError && (error.status === 401 || error.status === 403)) loseAccess();
      throw error;
    } finally { points.current.delete(abort); }
  }
  function patchAppointment(appointment: Appointment) {
    if (!authorized() || appointment.tenantId !== input.businessId || appointment.client?.uid !== input.userId) return;
    if (saved.current.key === key && saved.current.page?.rows.some(row => row.id === appointment.id)) publish({ ...saved.current, changed: true });
  }
  return { ...state, accessDenied: blocked.current === base, observedRows: observed.current.key === key && authorized() ? observed.current.rows : [], view: active.view, dateKey: active.dateKey, pageIndex: active.stack.length,
    setView: (view: ClientAppointmentsView) => { if (view !== active.view) transition({ ...active, view, incoming: undefined, stack: [], revision: active.revision + 1, chain: active.chain + 1 }); },
    setDateKey: (dateKey: string) => transition({ ...active, dateKey, incoming: undefined, stack: [], revision: active.revision + 1, chain: active.chain + 1 }),
    next, previous, refresh: () => transition({ ...active, incoming: undefined, stack: [], revision: active.revision + 1, chain: active.chain + 1 }),
    retry: () => polling.current?.refresh(), lookup, patchAppointment,
  };
}
