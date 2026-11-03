"use client";

import { Bell } from 'lucide-react';
import { Notice } from '@/components/app-shell';
import { sameReminderOccurrence, useAppointmentReminders } from '@/hooks/use-appointment-reminders';
import type { AppointmentReminder, ReminderOccurrence } from '@/types/appointment-reminders';

const dateFormat = new Intl.DateTimeFormat('es-CO', { timeZone: 'America/Bogota', day: 'numeric', month: 'long', year: 'numeric' });
const timeFormat = new Intl.DateTimeFormat('es-CO', { timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const actionClass = 'min-h-11 rounded text-left text-sm font-semibold text-sarin-blue underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-sarin-blue disabled:cursor-not-allowed disabled:opacity-50';

export function ClientAppointmentReminders({ businessId, userId, now, currentOccurrences, actionsLocked, onViewAppointment, partial = false, knownAppointmentIds }: {
  partial?: boolean; knownAppointmentIds?: string[]; businessId: string; userId: string; now: number; currentOccurrences: ReminderOccurrence[] | null; actionsLocked: boolean; onViewAppointment: (occurrence: ReminderOccurrence) => void;
}) {
  const reminders = useAppointmentReminders(businessId, userId, { now, currentOccurrences, actionsLocked, partial, knownAppointmentIds });
  const preference = reminders.preference;
  const busy = reminders.savingPreference || reminders.marking !== null || reminders.reconciling;
  const pending = reminders.reminders.filter(item => item.seenAt === null), seen = reminders.reminders.filter(item => item.seenAt !== null);
  const titleId = 'appointment-reminders-title';
  function view(occurrence: ReminderOccurrence) { if (reminders.canView(occurrence)) onViewAppointment(occurrence); }
  function row(item: AppointmentReminder) {
    const marking = reminders.marking && sameReminderOccurrence(reminders.marking, item);
    return <li key={`${item.appointmentId}:${item.sourceRevision}:${item.sourceStartAt}`} className="min-w-0 rounded-xl border border-sarin-line bg-sarin-paper px-3 py-2">
      <p className="text-sm font-semibold text-sarin-ink">Tu cita se acerca</p>
      <p className="mt-1 text-sm text-sarin-muted">{dateFormat.format(item.sourceStartAt)} · <span className="tabular-nums">{timeFormat.format(item.sourceStartAt)}</span> (Colombia)</p>
      <div className="flex flex-wrap gap-x-5 gap-y-1">
        <button type="button" className={actionClass} disabled={actionsLocked || busy} onClick={() => view(item)}>Ver cita</button>
        {item.seenAt === null && <button type="button" className={actionClass} disabled={actionsLocked || busy} onClick={() => reminders.markSeen(item)}>{marking ? 'Guardando visto…' : 'Marcar como visto'}</button>}
      </div>
    </li>;
  }
  return <section aria-labelledby={titleId} className="min-w-0 space-y-3 rounded-xl border border-sarin-line bg-sarin-canvas p-3 sm:p-4">
    <div className="flex items-center gap-2 text-sarin-ink"><Bell aria-hidden="true" className="h-4 w-4 shrink-0" /><h3 id={titleId} className="text-sm font-semibold">Recordatorios</h3></div>
    <p className="text-xs leading-relaxed text-sarin-muted">Ver avisos de mis próximas citas en SarinBot desde 24 horas antes de cada cita. Los avisos aparecen al abrir esta pantalla; no se envían con la app cerrada.</p>
    {preference && <div className="flex flex-wrap gap-x-5 gap-y-1">
      <button type="button" role="switch" aria-checked={preference.enabled} className={actionClass}
        disabled={busy || (!preference.enabled && actionsLocked)} onClick={() => reminders.setEnabled(!preference.enabled)}>{preference.enabled ? 'Desactivar recordatorios' : 'Activar recordatorios'}</button>
      {preference.status === 'suspended' && <button type="button" className={actionClass} disabled={busy || actionsLocked} onClick={() => reminders.setEnabled(true)}>Reactivar recordatorios</button>}
    </div>}
    {reminders.loading && <p role="status" className="text-sm text-sarin-muted">Cargando recordatorios…</p>}
    {reminders.savingPreference && <p role="status" className="text-sm text-sarin-muted">Guardando preferencia…</p>}
    {reminders.reconciling && <p role="status" className="text-sm text-sarin-muted">Comprobando si se guardó tu preferencia…</p>}
    {reminders.actionError && <Notice error>{reminders.actionError}</Notice>}
    {reminders.readError && <div className="space-y-1"><Notice error>No pudimos cargar tus recordatorios. {reminders.readError}</Notice><button type="button" className={actionClass} disabled={reminders.savingPreference || reminders.marking !== null} onClick={reminders.refresh}>Reintentar cargar recordatorios</button></div>}
    {reminders.retryOccurrence && reminders.reminders.some(item => sameReminderOccurrence(item, reminders.retryOccurrence!) && item.seenAt === null) && <button type="button" className={actionClass} disabled={busy || actionsLocked} onClick={reminders.retrySeen}>Reintentar marcar como visto</button>}
    {!reminders.loading && !reminders.readError && !reminders.savingPreference && !reminders.reconciling && <>
      {preference?.status === 'disabled' && <p className="text-xs text-sarin-muted">Desactivados para este negocio. Puedes activarlos cuando quieras.</p>}
      {preference?.status === 'suspended' && <p className="text-sm text-sarin-muted">Los recordatorios están en pausa. Revisa tus permisos y vuelve a activarlos si quieres recibir estos avisos dentro de SarinBot.</p>}
      {preference?.status === 'active' && (!partial && currentOccurrences === null ? <p role="status" className="text-sm text-sarin-muted">Comprobando tus citas antes de mostrar los avisos…</p> : <>
        {pending.length > 0 ? <ul aria-label="Recordatorios pendientes" className="space-y-2">{pending.map(row)}</ul> : <p className="text-sm text-sarin-muted">No tienes recordatorios pendientes. Los avisos aparecen desde 24 horas antes de cada cita.</p>}
        {seen.length > 0 && <details className="space-y-2"><summary className="min-h-11 cursor-pointer rounded py-3 text-sm font-medium text-sarin-muted focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-sarin-blue">Vistos ({seen.length})</summary><ul aria-label="Recordatorios vistos" className="space-y-2">{seen.map(row)}</ul></details>}
      </>)}
    </>}
  </section>;
}
