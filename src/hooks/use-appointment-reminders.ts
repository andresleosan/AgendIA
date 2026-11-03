"use client";

import { useEffect, useRef, useState } from 'react';
import { apiFetch, ApiError, errorMessage } from '@/lib/client/api';
import { startApiPolling } from '@/lib/client/api-polling';
import type { AppointmentReminder, AppointmentReminders, ReminderOccurrence } from '@/types/appointment-reminders';

const day = 86_400_000;
function reminderError(cause: unknown): string {
  const message = errorMessage(cause);
  return /^(?:Failed to fetch|NetworkError when attempting to fetch resource\.?|Load failed|fetch failed)$/i.test(message)
    ? 'No pudimos conectar con SarinBot. Revisa tu conexión e inténtalo de nuevo.' : message;
}
export function sameReminderOccurrence(a: ReminderOccurrence, b: ReminderOccurrence): boolean {
  return a.appointmentId === b.appointmentId && a.sourceRevision === b.sourceRevision && a.sourceStartAt === b.sourceStartAt && a.offsetMinutes === b.offsetMinutes;
}
function validReminder(value: AppointmentReminder): boolean {
  return Boolean(value && typeof value.appointmentId === 'string' && value.appointmentId && Number.isSafeInteger(value.sourceRevision) && value.sourceRevision >= 0
    && Number.isSafeInteger(value.sourceStartAt) && value.sourceStartAt > 0 && value.offsetMinutes === 1440 && value.availableAt === value.sourceStartAt - day
    && (value.seenAt === null || (Number.isSafeInteger(value.seenAt) && value.seenAt > 0)));
}
function validResponse(value: AppointmentReminders, businessId: string, userId: string): boolean {
  const preference = value?.preference;
  return Boolean(value && value.businessId === businessId && value.ownerUid === userId && Number.isSafeInteger(value.serverNow) && value.serverNow > 0
    && preference && Number.isSafeInteger(preference.revision) && preference.revision >= 0 && preference.offsetMinutes === 1440
    && ((preference.enabled === false && preference.status === 'disabled') || (preference.enabled === true && ['active', 'suspended'].includes(preference.status)))
    && Array.isArray(value.reminders) && value.reminders.every(validReminder) && new Set(value.reminders.map(item => item.appointmentId)).size === value.reminders.length
    && (preference.status === 'active' || value.reminders.length === 0));
}

type Context = { now: number; currentOccurrences: ReminderOccurrence[] | null; actionsLocked: boolean; partial?: boolean; knownAppointmentIds?: string[] };
export function useAppointmentReminders(businessId: string, userId: string, context: Context) {
  const key = JSON.stringify([businessId, userId]), identity = useRef({ key });
  if (identity.current.key !== key) identity.current = { key };
  const current = identity.current, mounted = useRef<object | null>(null);
  const initial = () => ({ identity: current, data: null as AppointmentReminders | null, receivedAt: 0, loading: true, readError: null as string | null,
    actionError: null as string | null, uncertainPreference: false, savingPreference: false, marking: null as ReminderOccurrence | null, retryOccurrence: null as ReminderOccurrence | null, reconciling: false, hideReminders: false });
  const [stored, setStored] = useState(initial), state = stored.identity === current ? stored : initial();
  const latest = useRef(state); latest.current = state;
  const conditions = useRef(context); conditions.current = context;
  const polling = useRef<ReturnType<typeof startApiPolling<AppointmentReminders>> | null>(null);
  const mutation = useRef<AbortController | null>(null);
  const live = () => identity.current === current && mounted.current === current;
  function update(patch: Partial<ReturnType<typeof initial>>) {
    if (!live()) return;
    const next = { ...latest.current, ...patch, identity: current }; latest.current = next; setStored(next);
  }
  function clock() {
    const value = latest.current;
    return value.data ? value.data.serverNow + Math.max(0, conditions.current.now - value.receivedAt, Date.now() - value.receivedAt) : Date.now();
  }
  function canonical(occurrence: ReminderOccurrence) { const knowledge = conditions.current; return knowledge.partial && !knowledge.knownAppointmentIds?.includes(occurrence.appointmentId) || knowledge.currentOccurrences?.some(item => sameReminderOccurrence(item, occurrence)) === true; }
  function eligible(occurrence: ReminderOccurrence) {
    const value = latest.current, time = clock();
    return Boolean(live() && !value.loading && !value.readError && !value.reconciling && !value.hideReminders && value.data?.preference.status === 'active'
      && occurrence.sourceStartAt > time && occurrence.sourceStartAt - day <= time && canonical(occurrence)
      && value.data.reminders.some(item => sameReminderOccurrence(item, occurrence)));
  }
  function startRead() {
    if (!live() || mutation.current) return;
    polling.current?.stop();
    polling.current = startApiPolling(async signal => {
      const result = await apiFetch<AppointmentReminders>(`/api/businesses/${encodeURIComponent(businessId)}/reminders`, { signal }, userId);
      if (!validResponse(result, businessId, userId)) throw new Error('No pudimos comprobar tus recordatorios. Vuelve a intentarlo.');
      return result;
    }, result => {
      if (!live()) return;
      const retry = latest.current.retryOccurrence;
      update({ data: result, receivedAt: Date.now(), loading: false, readError: null, reconciling: false, hideReminders: false,
        ...(latest.current.reconciling && latest.current.uncertainPreference ? { actionError: null } : {}), uncertainPreference: false,
        retryOccurrence: retry && result.preference.status === 'active' && result.reminders.some(item => sameReminderOccurrence(item, retry) && item.seenAt === null) ? retry : null });
    }, cause => update({ loading: false, readError: reminderError(cause) }));
  }
  useEffect(() => {
    mounted.current = current;
    startRead();
    return () => { if (mounted.current === current) mounted.current = null; polling.current?.stop(); polling.current = null; mutation.current?.abort(); mutation.current = null; };
  }, [key]);

  // A retained toggle cannot apply a decision based on an older preference revision.
  const observedRevision = state.data?.preference.revision;
  async function setEnabled(enabled: boolean) {
    const preference = latest.current.data?.preference;
    if (!live() || mutation.current || latest.current.reconciling || !preference || observedRevision !== preference.revision
      || (enabled && conditions.current.actionsLocked) || (preference.status === 'active' && enabled) || (!preference.enabled && !enabled)) return;
    const abort = mutation.current = new AbortController(); polling.current?.stop();
    update({ savingPreference: true, actionError: null, uncertainPreference: false, hideReminders: true, retryOccurrence: null });
    try {
      const result = await apiFetch<AppointmentReminders>(`/api/businesses/${encodeURIComponent(businessId)}/reminders/preference`, {
        method: 'PATCH', signal: abort.signal, body: JSON.stringify({ enabled, expectedRevision: preference.revision }),
      }, userId);
      if (!live() || abort.signal.aborted) return;
      if (!validResponse(result, businessId, userId) || result.preference.enabled !== enabled || result.preference.revision <= preference.revision) throw new Error('No pudimos confirmar el cambio de recordatorios.');
      update({ data: result, receivedAt: Date.now(), readError: null, hideReminders: false });
    } catch (cause) {
      if (live() && !abort.signal.aborted) update({ actionError: reminderError(cause), uncertainPreference: !(cause instanceof ApiError), reconciling: true, hideReminders: true });
    } finally {
      if (live() && mutation.current === abort) { mutation.current = null; update({ savingPreference: false }); startRead(); }
    }
  }
  async function markSeen(occurrence: ReminderOccurrence) {
    if (!live() || mutation.current || conditions.current.actionsLocked || !eligible(occurrence)) return;
    const item = latest.current.data?.reminders.find(candidate => sameReminderOccurrence(candidate, occurrence));
    if (!item || item.seenAt !== null) return;
    // Keep an immutable body: a retry must never adopt a newly rescheduled occurrence.
    const exact: ReminderOccurrence = { appointmentId: occurrence.appointmentId, sourceRevision: occurrence.sourceRevision, sourceStartAt: occurrence.sourceStartAt, offsetMinutes: 1440 };
    const abort = mutation.current = new AbortController(); polling.current?.stop(); update({ marking: exact, actionError: null });
    try {
      const result = await apiFetch<{ reminder: AppointmentReminder }>(`/api/businesses/${encodeURIComponent(businessId)}/reminders/seen`, { method: 'POST', signal: abort.signal, body: JSON.stringify(exact) }, userId);
      if (!live() || abort.signal.aborted) return;
      if (!validReminder(result?.reminder) || !sameReminderOccurrence(result.reminder, exact) || result.reminder.seenAt === null) throw new Error('No pudimos confirmar el visto del recordatorio.');
      const data = latest.current.data;
      if (data && eligible(exact)) update({ data: { ...data, reminders: data.reminders.map(item => sameReminderOccurrence(item, exact) ? result.reminder : item) } });
      update({ retryOccurrence: null });
    } catch (cause) {
      if (live() && !abort.signal.aborted) update({ actionError: reminderError(cause), retryOccurrence: cause instanceof ApiError && [400, 401, 403, 404, 409, 428].includes(cause.status) ? null : exact });
    } finally {
      if (live() && mutation.current === abort) { mutation.current = null; update({ marking: null }); startRead(); }
    }
  }
  async function retrySeen() {
    const occurrence = latest.current.retryOccurrence;
    if (live() && occurrence && eligible(occurrence)) await markSeen(occurrence);
  }
  const time = state.data ? state.data.serverNow + Math.max(0, context.now - state.receivedAt, Date.now() - state.receivedAt) : context.now;
  const reminders = !state.loading && !state.readError && !state.hideReminders && !state.reconciling && state.data?.preference.status === 'active'
    ? state.data.reminders.filter(item => item.sourceStartAt > time && item.availableAt <= time && canonical(item)) : [];
  const nextExpiry = reminders.length ? Math.min(...reminders.map(item => item.sourceStartAt)) : null;
  useEffect(() => {
    if (nextExpiry === null) return;
    const page = typeof document === 'undefined' ? undefined : document;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const clear = () => { if (timer !== undefined) clearTimeout(timer); timer = undefined; };
    function schedule() {
      clear();
      if (!live() || page?.visibilityState === 'hidden') return;
      const delay = nextExpiry! - clock();
      if (delay <= 0) { update({}); return; }
      // Only redraw at the start boundary; no request, receipt or background alarm.
      timer = setTimeout(() => { timer = undefined; update({}); if (nextExpiry! > clock()) schedule(); }, delay);
    }
    const visibility = () => { if (page?.visibilityState !== 'hidden') update({}); schedule(); };
    page?.addEventListener?.('visibilitychange', visibility);
    schedule();
    return () => { clear(); page?.removeEventListener?.('visibilitychange', visibility); };
  }, [key, nextExpiry, state.data, state.receivedAt]);
  return { preference: state.data?.preference ?? null, reminders, loading: state.loading, readError: state.readError, actionError: state.actionError,
    savingPreference: state.savingPreference, marking: state.marking, retryOccurrence: state.retryOccurrence, reconciling: state.reconciling,
    setEnabled, markSeen, retrySeen, canView: (occurrence: ReminderOccurrence) => !mutation.current && !conditions.current.actionsLocked && eligible(occurrence),
    refresh: () => { if (live() && !mutation.current) { update({ readError: null, loading: true }); polling.current?.refresh(); } } };
}
