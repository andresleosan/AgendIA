"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { CalendarPlus, Download } from "lucide-react";
import { Notice, buttonClass, fieldClass } from "@/components/app-shell";
import { ClientAppointmentReminders } from "@/components/client-appointment-reminders";
import { ClientWaitlist } from "@/components/client-waitlist";
import type { WaitlistController } from "@/hooks/use-waitlist";
import type { WaitlistRequestView } from "@/types/waitlist";
import { apiFetch, errorMessage } from "@/lib/client/api";
import { useClientAppointmentsPage } from "@/hooks/use-client-appointments-page";
import { useAuth } from "@/components/auth-provider";
import { startApiPolling } from "@/lib/client/api-polling";
import { createAppointmentImage, type AppointmentImageDetails } from "@/lib/client/appointment-image";
import { createAppointmentCalendar, type AppointmentCalendarDetails } from "@/lib/client/appointment-calendar";
import { downloadICSFile } from "@/lib/utils/icsGenerator";
import type { Appointment, TenantResource, TenantService } from "@/types/firestore";
import type { ReminderOccurrence } from "@/types/appointment-reminders";

type View = "upcoming" | "history" | "calendar";
type ExportAction = { id: string; kind: "image" | "calendar" };
const views: { id: View; label: string }[] = [
  { id: "upcoming", label: "Próximas" },
  { id: "history", label: "Historial" },
  { id: "calendar", label: "Calendario" },
];
const knownStatuses: Appointment["status"][] = ["confirmed", "cancelled_by_client", "cancelled_by_owner", "completed", "no_show"];
const dateFormat = new Intl.DateTimeFormat("es-CO", { timeZone: "America/Bogota", day: "numeric", month: "long", year: "numeric" });
const timeFormat = new Intl.DateTimeFormat("es-CO", { timeZone: "America/Bogota", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const dateKeyFormat = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Bogota", year: "numeric", month: "2-digit", day: "2-digit" });
function dateKey(timestamp: number): string {
  const parts = dateKeyFormat.formatToParts(timestamp);
  return ["year", "month", "day"].map(type => parts.find(part => part.type === type)?.value).join("-");
}
function canChange(appointment: Appointment, now: number): boolean {
  return appointment.status === "confirmed" && appointment.startAt > now;
}
function isHistorical(appointment: Appointment, now: number): boolean {
  return appointment.status !== "confirmed" || appointment.endAt <= now;
}
function statusLabel(appointment: Appointment, now: number): string {
  switch (appointment.status) {
    case "cancelled_by_client": return "Cancelada por ti";
    case "cancelled_by_owner": return "Cancelada por el negocio";
    case "completed": return "Completada por el negocio";
    case "no_show": return "Inasistencia registrada";
    default: return appointment.endAt <= now ? "Horario finalizado" : appointment.startAt <= now ? "En curso" : "Confirmada";
  }
}

export function ClientAppointments({ businessId, businessName, resources = [], services = [], userId, now, onRebook, rebookingEnabled = false, onReschedule, reschedulingEnabled = false, actionsLocked = false, onActionLockChange, watchedAppointmentId, selectedAppointmentId, onAppointmentVerified, waitlist, waitlistResumeEnabled = false, onWaitlistChoose, waitlistOfferContent, acquireAction }: { businessId: string; businessName: string; resources?: TenantResource[]; services?: TenantService[]; userId: string; now: number; onRebook?: (serviceId: string) => void; rebookingEnabled?: boolean; onReschedule?: (appointment: Appointment) => boolean | void; reschedulingEnabled?: boolean; actionsLocked?: boolean; onActionLockChange?: (locked: boolean) => boolean | void; acquireAction?: () => false | (() => void); waitlistOfferContent?: ReactNode; waitlist?: WaitlistController; waitlistResumeEnabled?: boolean; onWaitlistChoose?: (request: WaitlistRequestView, revision: number) => void; watchedAppointmentId?: string; selectedAppointmentId?: string; onAppointmentVerified?: (id: string, appointment: Appointment | null) => void }) {
  const { authEpoch, isCurrentSession } = useAuth();
  const scope = JSON.stringify([businessId, userId, authEpoch]);
  const currentScope = useRef({ key: scope });
  if (currentScope.current.key !== scope) currentScope.current = { key: scope };
  const actionScope = currentScope.current;
  const access = useRef(true);
  const sessionCurrent = () => access.current && currentScope.current === actionScope && isCurrentSession(userId, authEpoch);
  const appointmentRead = useClientAppointmentsPage({ businessId, userId, authEpoch, isCurrentSession });
  access.current = !appointmentRead.accessDenied;
  const loading = appointmentRead.loading, readError = appointmentRead.error;
  const view = appointmentRead.view, setView = appointmentRead.setView;
  const selectedDate = appointmentRead.dateKey, setSelectedDate = appointmentRead.setDateKey;
  const interaction = useRef(0);
  const [selectedError, setSelectedError] = useState<string | null>(null);
  const [selected, setSelected] = useState<{ scope: object; row: Appointment } | null>(null);
  const selectedRow = selected?.scope === actionScope && sessionCurrent() ? selected.row : null;
  const appointments = sessionCurrent() ? [...(appointmentRead.page?.rows.map(row => row.id === selectedRow?.id ? selectedRow : row) ?? []), ...(selectedRow && !appointmentRead.page?.rows.some(row => row.id === selectedRow.id) ? [selectedRow] : [])] : [];
  const [confirmationId, setConfirmationId] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const pending = useRef<string | null>(null);
  const handingOff = useRef(false);
  const exporting = useRef<ExportAction | null>(null);
  const [exportAction, setExportAction] = useState<ExportAction | null>(null);
  const exportingId = exportAction?.id ?? null;
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reminderFocus, setReminderFocus] = useState<ReminderOccurrence | null>(null);
  const appointmentElements = useRef(new Map<string, HTMLElement>());

  useEffect(() => {
    currentScope.current = actionScope;
    interaction.current++; setSelectedError(null);
    setConfirmationId(null); setPendingId(null); pending.current = null;
    exporting.current = null; setExportAction(null);
    setActionError(null); setNotice(null);
    setReminderFocus(null);
    handingOff.current = false;
    return () => { if (currentScope.current === actionScope) currentScope.current = { key: '' }; };
  }, [scope]);
  useEffect(() => { if (!actionsLocked) handingOff.current = false; }, [actionsLocked]);

  // The query is scoped by the authenticated UID; recheck it before displaying or acting.
  const ownAppointments = appointments.filter(item => item.tenantId === businessId && item.type === "appointment" && item.client?.uid === userId && knownStatuses.includes(item.status)
    && Number.isFinite(item.startAt) && Number.isFinite(item.endAt) && item.endAt > item.startAt);
  const latest = useRef({ appointments: ownAppointments, businessName, resources, services, onRebook, rebookingEnabled, onReschedule, reschedulingEnabled, actionsLocked, onActionLockChange, acquireAction, view, loading, readError, changed: appointmentRead.changed });
  latest.current = { appointments: ownAppointments, businessName, resources, services, onRebook, rebookingEnabled, onReschedule, reschedulingEnabled, actionsLocked, onActionLockChange, acquireAction, view, loading, readError, changed: appointmentRead.changed };
  const ownedAction = useRef<{ scope: object; release: () => void } | null>(null);
  function acquireLocalAction() {
    const value = latest.current;
    let release: (() => void) | false;
    if (value.acquireAction) release = value.acquireAction();
    else {
      const callback = value.onActionLockChange;
      if (callback?.(true) === false) return false;
      release = () => { callback?.(false); };
    }
    if (!release) return false;
    const lease = { scope: actionScope, release }; ownedAction.current = lease;
    return () => { if (ownedAction.current !== lease) return; ownedAction.current = null; lease.release(); };
  }
  useEffect(() => () => {
    const own = ownedAction.current;
    if (own?.scope === actionScope) { ownedAction.current = null; own.release(); }
  }, [scope]);
  const visible = ownAppointments;
  const verifyCallback = useRef(onAppointmentVerified); verifyCallback.current = onAppointmentVerified;
  const pointReader = useRef(appointmentRead.lookup); pointReader.current = appointmentRead.lookup;
  useEffect(() => {
    if (!watchedAppointmentId) return;
    let active = true;
    const poll = startApiPolling(async () => pointReader.current(watchedAppointmentId), row => {
      if (active && sessionCurrent()) verifyCallback.current?.(watchedAppointmentId, row);
    }, () => { if (active && sessionCurrent()) verifyCallback.current?.(watchedAppointmentId, null); }, { abortOnBlur: true, waitForPending: true });
    return () => { active = false; poll.stop(); };
  }, [scope, watchedAppointmentId]);
  useEffect(() => {
    if (!selectedAppointmentId) return;
    let active = true; const generation = interaction.current;
    void pointReader.current(selectedAppointmentId).then(row => {
      if (active && sessionCurrent() && interaction.current === generation) setSelected({ scope: actionScope, row });
    }, cause => { if (active && sessionCurrent() && interaction.current === generation) setSelectedError(errorMessage(cause)); });
    return () => { active = false; };
  }, [scope, selectedAppointmentId]);
  const selectedId = selectedRow?.id;
  useEffect(() => {
    if (!selectedId) return;
    let active = true; const generation = interaction.current;
    const owns = () => active && sessionCurrent() && interaction.current === generation;
    const poll = startApiPolling(async () => pointReader.current(selectedId), row => {
      if (owns()) { setSelected({ scope: actionScope, row }); setSelectedError(null); }
    }, cause => { if (owns()) setSelectedError(`No pudimos verificar la cita seleccionada. ${errorMessage(cause)}`); }, { abortOnBlur: true, waitForPending: true });
    return () => { active = false; poll.stop(); };
  }, [scope, selectedId]);
  const knownAppointments = [...appointmentRead.observedRows, ...(selectedRow ? [selectedRow] : [])];
  const currentOccurrences: ReminderOccurrence[] | null = loading || readError ? null : knownAppointments.flatMap(item => {
    const revision = item.rescheduleRevision === undefined ? 0 : item.rescheduleRevision;
    return item.status === "confirmed" && item.startAt > now && Number.isSafeInteger(revision) && revision >= 0
      ? [{ appointmentId: item.id, sourceRevision: revision, sourceStartAt: item.startAt, offsetMinutes: 1440 as const }] : [];
  });
  function currentReminderAppointment(occurrence: ReminderOccurrence) {
    const current = latest.current;
    if (!sessionCurrent() || current.actionsLocked || handingOff.current || pending.current || exporting.current || current.loading || current.readError) return undefined;
    return current.appointments.find(item => item.id === occurrence.appointmentId && canChange(item, Date.now()) && item.startAt === occurrence.sourceStartAt
      && (item.rescheduleRevision === undefined ? 0 : item.rescheduleRevision) === occurrence.sourceRevision && occurrence.offsetMinutes === 1440);
  }
  async function viewReminder(occurrence: ReminderOccurrence) {
    if (!sessionCurrent() || latest.current.actionsLocked || pending.current || exporting.current || handingOff.current) return;
    const release = acquireLocalAction(); if (!release) return;
    const generation = interaction.current;
    pending.current = occurrence.appointmentId; setPendingId(occurrence.appointmentId);
    try {
      const row = await appointmentRead.lookup(occurrence.appointmentId);
      if (!sessionCurrent() || interaction.current !== generation) return;
      if (!canChange(row, Date.now()) || row.startAt !== occurrence.sourceStartAt || (row.rescheduleRevision ?? 0) !== occurrence.sourceRevision) throw new Error('La cita cambió. Actualiza los recordatorios.');
      setView("upcoming"); setSelected({ scope: actionScope, row }); setReminderFocus(occurrence);
    } catch (cause) { if (sessionCurrent()) setActionError(errorMessage(cause)); }
    finally { if (sessionCurrent()) { pending.current = null; setPendingId(null); } release(); }
  }
  useEffect(() => {
    if (!reminderFocus || loading) return;
    if (currentReminderAppointment(reminderFocus)) {
      const element = appointmentElements.current.get(reminderFocus.appointmentId);
      element?.focus({ preventScroll: true });
      element?.scrollIntoView({ block: "center", behavior: "auto" });
    }
    setReminderFocus(null);
  }, [reminderFocus, view, appointmentRead.page, selectedRow, loading, actionsLocked, scope]);

  function navigate(change: () => void) {
    if (!sessionCurrent()) return;
    interaction.current++; setSelected(null); setSelectedError(null); setReminderFocus(null); setConfirmationId(null); setActionError(null);
    change();
  }
  function changeView(next: View) { navigate(() => setView(next)); }
  function rebook(appointment: Appointment) {
    if (!sessionCurrent() || latest.current.actionsLocked || handingOff.current || pending.current || exporting.current) return;
    const current = latest.current;
    if (current.view !== "history" || !current.onRebook || !current.rebookingEnabled || current.loading || current.readError || current.changed) return;
    const saved = current.appointments.find(item => item.id === appointment.id);
    if (!saved || saved.serviceId !== appointment.serviceId || !isHistorical(saved, Date.now())) return;
    const service = current.services.find(item => item.id === saved.serviceId);
    if (service) current.onRebook(service.id);
  }
  async function reschedule(appointment: Appointment) {
    if (!sessionCurrent() || handingOff.current || pending.current || exporting.current) return;
    const current = latest.current;
    if (current.actionsLocked || !current.onReschedule || !current.reschedulingEnabled || current.loading || current.readError || appointmentRead.changed) return;
    const saved = current.appointments.find(item => item.id === appointment.id);
    if (!saved || !canChange(saved, Date.now()) || JSON.stringify(saved) !== JSON.stringify(appointment)) return;
    const release = acquireLocalAction(); if (!release) return;
    const generation = interaction.current;
    pending.current = saved.id; setPendingId(saved.id);
    try {
      const actual = await appointmentRead.lookup(saved.id);
      if (!sessionCurrent() || interaction.current !== generation) return;
      if (!canChange(actual, Date.now()) || JSON.stringify(saved) !== JSON.stringify(actual)) throw new Error('La cita cambió. Usa Actualizar citas antes de cambiar el horario.');
      // Release and transfer synchronously: no second handler can enter during the point read.
      release(); pending.current = null; setPendingId(null);
      handingOff.current = latest.current.onReschedule?.(actual) === true;
    } catch (cause) { if (sessionCurrent()) setActionError(errorMessage(cause)); }
    finally { if (sessionCurrent()) { pending.current = null; setPendingId(null); } release(); }
  }
  async function cancel(appointment: Appointment) {
    if (!sessionCurrent() || latest.current.actionsLocked || handingOff.current || pending.current || exporting.current || appointment.client?.uid !== userId || !canChange(appointment, Date.now())) return;
    const releaseAction = acquireLocalAction(); if (!releaseAction) return;
    const generation = interaction.current;
    pending.current = appointment.id;
    setPendingId(appointment.id);
    setActionError(null);
    setNotice(null);
    try {
      const canonical = await appointmentRead.lookup(appointment.id);
      if (!sessionCurrent() || interaction.current !== generation) return;
      if (!canChange(canonical, Date.now()) || JSON.stringify(canonical) !== JSON.stringify(appointment)) throw new Error('La cita cambió. Usa Actualizar citas antes de cancelarla.');
      const result = await apiFetch<{ appointment: Appointment }>(`/api/businesses/${encodeURIComponent(businessId)}/appointments`, {
        method: "PATCH", body: JSON.stringify({ appointmentId: appointment.id }),
      }, userId, sessionCurrent);
      if (!sessionCurrent()) return;
      const saved = result.appointment;
      if (saved?.id !== appointment.id || saved.tenantId !== businessId || saved.client?.uid !== userId || !["cancelled_by_client", "cancelled_by_owner"].includes(saved.status)) {
        throw new Error("No se pudo confirmar la cancelación. Revisa el estado de tu cita antes de intentarlo de nuevo.");
      }
      appointmentRead.patchAppointment(saved);
      if (interaction.current === generation) { setSelected({ scope: actionScope, row: saved }); setConfirmationId(null); setView("history"); }
      setNotice("Cita cancelada.");
    } catch (cause) { if (currentScope.current === actionScope) setActionError(errorMessage(cause)); }
    finally { if (currentScope.current === actionScope) { pending.current = null; setPendingId(null); } releaseAction(); }
  }
  async function download(appointment: Appointment) {
    if (latest.current.loading || latest.current.readError || latest.current.changed) return;
    if (!sessionCurrent() || latest.current.actionsLocked || handingOff.current || pending.current || exporting.current || appointment.client?.uid !== userId || !canChange(appointment, Date.now())) return;
    const releaseAction = acquireLocalAction(); if (!releaseAction) return;
    const generation = interaction.current;
    exporting.current = { id: appointment.id, kind: "image" };
    setExportAction(exporting.current); setActionError(null); setNotice(null);
    const generatedAt = Date.now();
    function details(item: Appointment): AppointmentImageDetails {
      return { businessName: latest.current.businessName, serviceName: item.serviceName || "Cita",
        resourceName: latest.current.resources.find(resource => resource.id === item.resourceId)?.name,
        startAt: item.startAt, endAt: item.endAt, generatedAt };
    }
    try {
      const canonical = await appointmentRead.lookup(appointment.id);
      if (!sessionCurrent() || interaction.current !== generation) return;
      if (!canChange(canonical, Date.now()) || JSON.stringify(canonical) !== JSON.stringify(appointment)) throw new Error('La cita cambió. Usa Actualizar citas antes de descargarla.');
      const snapshot = details(canonical);
      const image = await createAppointmentImage(snapshot);
      if (!sessionCurrent() || interaction.current !== generation) return;
      const current = await appointmentRead.lookup(appointment.id);
      if (!sessionCurrent() || interaction.current !== generation) return;
      if (latest.current.loading || latest.current.readError || !current || !canChange(current, Date.now()) || JSON.stringify(details(current)) !== JSON.stringify(snapshot)) {
        setActionError("La cita cambió mientras preparábamos la imagen. Revisa Mis citas antes de intentarlo de nuevo.");
        return;
      }
      const url = URL.createObjectURL(image);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `cita-${dateKey(current.startAt)}.png`;
      try { document.body.appendChild(anchor); anchor.click(); }
      finally { anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000); }
      setNotice("Imagen de la cita descargada. Consulta Mis citas para ver cambios o cancelaciones.");
    } catch (cause) { if (currentScope.current === actionScope) setActionError(errorMessage(cause)); }
    finally { if (currentScope.current === actionScope) { exporting.current = null; setExportAction(null); } releaseAction(); }
  }
  async function downloadCalendar(appointment: Appointment) {
    if (!sessionCurrent() || latest.current.actionsLocked || handingOff.current || pending.current || exporting.current) return;
    const current = latest.current;
    if (current.loading || current.readError || current.changed) return;
    const saved = current.appointments.find(item => item.id === appointment.id);
    if (!saved || !canChange(saved, Date.now())) return;
    // A retained handler must still describe the current appointment and card metadata.
    if (saved.startAt !== appointment.startAt || saved.endAt !== appointment.endAt || saved.serviceId !== appointment.serviceId
      || saved.serviceName !== appointment.serviceName || saved.resourceId !== appointment.resourceId || current.businessName !== businessName
      || current.resources.find(item => item.id === saved.resourceId)?.name !== resources.find(item => item.id === appointment.resourceId)?.name) return;
    function details(item: Appointment): AppointmentCalendarDetails {
      return { businessId, appointmentId: item.id, businessName: latest.current.businessName, serviceName: item.serviceName || "Cita",
        resourceName: latest.current.resources.find(resource => resource.id === item.resourceId)?.name,
        startAt: item.startAt, endAt: item.endAt };
    }
    const serviceId = saved.serviceId, resourceId = saved.resourceId;
    const releaseAction = acquireLocalAction(); if (!releaseAction) return;
    const generation = interaction.current;
    exporting.current = { id: saved.id, kind: "calendar" };
    setExportAction(exporting.current); setActionError(null); setNotice(null);
    try {
      const canonical = await appointmentRead.lookup(saved.id);
      if (!sessionCurrent() || interaction.current !== generation) return;
      if (!canChange(canonical, Date.now()) || JSON.stringify(canonical) !== JSON.stringify(saved)) throw new Error('La cita cambió. Usa Actualizar citas antes de descargarla.');
      const snapshot = details(canonical);
      const content = await createAppointmentCalendar(snapshot);
      if (!sessionCurrent() || interaction.current !== generation) return;
      const actual = await appointmentRead.lookup(saved.id);
      if (!sessionCurrent() || interaction.current !== generation) return;
      const latestRead = latest.current;
      if (latestRead.loading || latestRead.readError || !actual || !canChange(actual, Date.now())
        || actual.serviceId !== serviceId || actual.resourceId !== resourceId || JSON.stringify(details(actual)) !== JSON.stringify(snapshot)) {
        setActionError("La cita cambió mientras preparábamos el calendario. Revisa Mis citas antes de intentarlo de nuevo.");
        return;
      }
      downloadICSFile(content, `cita-${dateKey(actual.startAt)}.ics`);
      setNotice("Archivo de calendario descargado. Los cambios y cancelaciones se consultan en Mis citas.");
    } catch (cause) { if (currentScope.current === actionScope) setActionError(errorMessage(cause)); }
    finally { if (currentScope.current === actionScope) { exporting.current = null; setExportAction(null); } releaseAction(); }
  }

  return (
    <section id="mis-citas" aria-labelledby="my-appointments-title" className="min-w-0 scroll-mt-40 space-y-4 rounded-2xl border border-sarin-line bg-sarin-paper p-4 sm:p-5">
      <div>
        <h2 id="my-appointments-title" className="font-semibold text-sarin-ink">Mis citas</h2>
        <p className="mt-1 text-xs text-sarin-muted">Tus reservas en este negocio. Horarios de Colombia.</p>
      </div>
      {!appointmentRead.accessDenied && <ClientAppointmentReminders key={scope} businessId={businessId} userId={userId} now={now} currentOccurrences={currentOccurrences} partial knownAppointmentIds={knownAppointments.map(row => row.id)}
        actionsLocked={actionsLocked || Boolean(pendingId || exportingId)} onViewAppointment={viewReminder} />}
      {waitlist && onWaitlistChoose && <ClientWaitlist controller={waitlist} services={services} resources={resources} actionsLocked={actionsLocked || Boolean(pendingId || exportingId)} canResume={waitlistResumeEnabled} onChoose={onWaitlistChoose} offerContent={waitlistOfferContent} />}
      <div role="group" aria-label="Ver mis citas" className="grid grid-cols-3 gap-1 rounded-xl bg-sarin-canvas p-1">
        {views.map(item => <button key={item.id} type="button" aria-pressed={view === item.id} onClick={() => changeView(item.id)}
          className={`min-h-11 min-w-0 rounded-lg px-1 text-xs font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sarin-blue sm:text-sm ${view === item.id ? "bg-sarin-blue text-white" : "text-sarin-muted hover:bg-sarin-soft"}`}>{item.label}</button>)}
      </div>
      {view === "calendar" && <label className="block space-y-2 text-sm font-medium text-sarin-ink">
        <span>Consultar mis citas por fecha</span>
        <input type="date" aria-label="Fecha de mis citas" className={`${fieldClass} min-w-0 max-w-full`} value={selectedDate} onChange={event => navigate(() => setSelectedDate(event.target.value))} />
      </label>}
      {readError && <div className="space-y-2"><Notice error>No pudimos cargar tus citas. {readError}</Notice>
        <button type="button" className="min-h-11 text-sm text-sarin-blue underline" onClick={appointmentRead.retry}>Reintentar cargar citas</button></div>}
      {appointmentRead.changed && <p role="status" className="text-sm text-sarin-muted">Tus citas cambiaron. Conservamos esta página mientras lees. Usa Actualizar citas para consultar la lista actual.</p>}
      <nav aria-label="Páginas de mis citas" className="flex flex-wrap gap-2">
        <button type="button" className="min-h-11 rounded-[10px] border border-sarin-line px-3 text-sm text-sarin-blue disabled:opacity-50" disabled={loading || appointmentRead.changed || appointmentRead.pageIndex === 0} onClick={() => navigate(appointmentRead.previous)}>Anterior</button>
        <button type="button" className="min-h-11 rounded-[10px] border border-sarin-line px-3 text-sm text-sarin-blue disabled:opacity-50" disabled={loading || appointmentRead.changed || Boolean(readError) || !appointmentRead.page?.nextCursor} onClick={() => navigate(appointmentRead.next)}>Siguiente</button>
        <button type="button" className="min-h-11 rounded-[10px] px-3 text-sm font-semibold text-sarin-blue underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-sarin-blue disabled:opacity-50" disabled={loading} onClick={() => navigate(appointmentRead.refresh)}>Actualizar citas</button>
      </nav>
      {selectedError && <Notice error>{selectedError} Usa Actualizar citas para volver a consultar.</Notice>}
      {actionError && <Notice error>{actionError}</Notice>}
      {notice && <p role="status" className="text-sm text-sarin-blue">{notice}</p>}
      {loading && <p role="status" className="text-sm text-sarin-muted">Cargando tus citas…</p>}
      {!loading && !readError && !appointmentRead.changed && visible.length === 0 && <p className="py-3 text-sm text-sarin-muted">
        {view === "upcoming" ? "No tienes próximas citas en este negocio." : view === "history" ? "Aún no tienes citas en tu historial." : selectedDate ? "No tienes citas para esta fecha." : "Elige una fecha para consultar tus citas."}
      </p>}
      <div className="space-y-3">
        {visible.map(appointment => {
          const currentService = services.find(service => service.id === appointment.serviceId);
          return <article key={appointment.id} tabIndex={-1} ref={element => { if (element) appointmentElements.current.set(appointment.id, element); else appointmentElements.current.delete(appointment.id); }} className="min-w-0 scroll-mt-40 space-y-3 rounded-xl border border-sarin-line bg-sarin-canvas p-3 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-sarin-blue sm:p-4">
          <div className="space-y-1">
            <h3 className="break-words font-semibold [overflow-wrap:anywhere]">{appointment.serviceName || "Cita"}</h3>
            <p className="break-words text-sm [overflow-wrap:anywhere]">{appointment.beneficiary?.kind === 'represented_minor' ? <>Para: {appointment.beneficiary.displayName} · Gestionada por {appointment.client?.name || 'tu cuenta'}</> : appointment.beneficiary?.kind === 'self' ? 'Reserva para ti' : 'Registro anterior sin beneficiario declarado'}</p>
            <p className="text-sm text-sarin-ink">{dateFormat.format(appointment.startAt)}</p>
            <p className="text-sm tabular-nums text-sarin-muted">{timeFormat.format(appointment.startAt)}–{timeFormat.format(appointment.endAt)} (Colombia)</p>
            <p className="text-xs font-semibold text-sarin-blue">{statusLabel(appointment, now)}</p>
          </div>
          {view === "history" && onRebook && currentService && <button type="button" aria-label={`Volver a reservar: ${currentService.name}`} disabled={actionsLocked || !rebookingEnabled || loading || Boolean(readError || pendingId || exportingId)} onClick={() => rebook(appointment)} className="min-h-11 max-w-full rounded-[10px] border border-sarin-line px-3 py-2 text-left text-sm font-semibold text-sarin-blue hover:border-sarin-blue hover:bg-sarin-soft focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-sarin-blue disabled:cursor-not-allowed disabled:opacity-50">Volver a reservar</button>}
          {canChange(appointment, now) && <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-x-5 gap-y-1">
              {onReschedule && <button type="button" disabled={actionsLocked || !reschedulingEnabled || loading || Boolean(readError || pendingId || exportingId)} className="min-h-11 rounded text-left text-sm font-semibold text-sarin-blue focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-sarin-blue disabled:opacity-50" onClick={() => reschedule(appointment)}>Cambiar horario</button>}
              <button type="button" disabled={actionsLocked || Boolean(pendingId || exportingId)} className="flex min-h-11 max-w-full items-center gap-2 rounded text-left text-sm font-medium text-sarin-blue focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-sarin-blue disabled:opacity-50" onClick={() => download(appointment)}><Download className="h-4 w-4 shrink-0" />{exportAction?.id === appointment.id && exportAction.kind === "image" ? "Preparando imagen…" : "Guardar imagen de la cita"}</button>
              <button type="button" disabled={actionsLocked || loading || Boolean(readError || pendingId || exportingId)} className="flex min-h-11 max-w-full items-center gap-2 rounded text-left text-sm font-medium text-sarin-blue focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-sarin-blue disabled:opacity-50" onClick={() => downloadCalendar(appointment)}><CalendarPlus className="h-4 w-4 shrink-0" />{exportAction?.id === appointment.id && exportAction.kind === "calendar" ? "Preparando calendario…" : "Añadir al calendario"}</button>
              {confirmationId !== appointment.id && <button type="button" disabled={actionsLocked || Boolean(pendingId || exportingId)} className="min-h-11 rounded text-sm text-sarin-muted underline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-sarin-blue disabled:opacity-50" onClick={() => { if (!sessionCurrent() || latest.current.actionsLocked || handingOff.current || pending.current || exporting.current) return; setConfirmationId(appointment.id); setActionError(null); setNotice(null); }}>Cancelar cita</button>}
            </div>
            <p className="text-xs text-sarin-muted">Se descarga un archivo para importar. No se actualiza automáticamente: consulta Mis citas para ver cambios o cancelaciones.</p>
          </div>}
          {confirmationId === appointment.id && canChange(appointment, now) && <div role="group" aria-label={`Confirmar cancelación de ${appointment.serviceName || "cita"}`} className="space-y-3 border-t border-sarin-line pt-3">
            <p className="text-sm text-sarin-ink">¿Quieres cancelar esta cita? El horario quedará libre.</p>
            <div className="flex flex-wrap gap-2">
              <button type="button" className={buttonClass} disabled={actionsLocked || Boolean(pendingId || exportingId)} onClick={() => cancel(appointment)}>{pendingId === appointment.id ? "Cancelando…" : "Sí, cancelar cita"}</button>
              <button type="button" className="min-h-11 rounded-xl border border-sarin-line px-3 text-sm text-sarin-ink disabled:opacity-50" disabled={actionsLocked || Boolean(pendingId)} onClick={() => { setConfirmationId(null); setActionError(null); }}>Conservar cita</button>
            </div>
          </div>}
        </article>;
        })}
      </div>
    </section>
  );
}
