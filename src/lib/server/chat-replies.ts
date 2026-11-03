import 'server-only';
import type { ChatResponse } from '@/types/chat';
import type { Appointment, Business } from '@/types/firestore';
import type { ChatIntent } from './chat-intent';
import { renderBusinessLocationInformation, renderBusinessServiceInformation } from './business-receptionist-info';
export const OUT_OF_SCOPE_REPLY = 'Puedo ayudarte con los servicios, horarios y citas de este negocio. ¿Qué necesitas reservar o consultar?';
export const appointmentStatusLabel = (status: Appointment['status']) => ({ confirmed: 'Activa', completed: 'Completada', no_show: 'No asistió', cancelled_by_client: 'Cancelada por el cliente', cancelled_by_owner: 'Cancelada por el negocio' })[status];
export function renderChatReply({ intent, business, data }: { intent: ChatIntent; business: Business; data: Record<string, unknown> }): ChatResponse {
  let reply: string;
  switch (intent) {
    case 'out_of_scope': reply = OUT_OF_SCOPE_REPLY; break;
    case 'services': case 'service_details': case 'price': reply = renderBusinessServiceInformation({ business, intent, serviceId: typeof data.serviceId === 'string' ? data.serviceId : undefined }); break;
    case 'contact': reply = business.phoneWhatsApp ? `Puedes contactar a ${business.name} en ${business.phoneWhatsApp}.` : 'El negocio todavía no ha publicado un teléfono de contacto.'; break;
    case 'location': reply = renderBusinessLocationInformation(business); break;
    case 'hours': reply = `Horario de Colombia:\n${Object.entries(business.weeklySchedule).map(([day, schedule]) => `${['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'][Number(day)]}: ${schedule.isOpen ? schedule.intervals.map(interval => `${interval.start}–${interval.end}`).join(', ') : 'Cerrado'}`).join('\n')}`; break;
    case 'availability': {
      const availability = data.availability as { resourceName: string; slots: string[] }[] | undefined;
      reply = availability?.some(item => item.slots.length) ? `Disponibilidad para ${String(data.dateKey)} (Colombia):\n${availability.map(item => `${item.resourceName}: ${item.slots.join(', ') || 'Sin horas libres'}`).join('\n')}\nElige una hora para preparar la reserva.` : data.dateKey ? 'No hay horas libres para esa selección. Prueba otra fecha o profesional.' : 'Indica el servicio y la fecha que quieres consultar.';
      break;
    }
    case 'booking': reply = data.proposal ? 'Preparé esta propuesta. Revisa el resumen y tus datos antes de pulsar Confirmar cita.' : 'Para preparar tu reserva necesito servicio, profesional, fecha y hora. La cita se agenda al revisar el resumen y pulsar Confirmar cita.'; break;
    case 'own_appointments': {
      const appointments = data.appointments as Appointment[] | undefined;
      const time = new Intl.DateTimeFormat('es-CO', { timeZone: 'America/Bogota', hour:'2-digit', minute:'2-digit', hourCycle:'h23' });
      reply = appointments?.length ? 'Tus próximas citas (Colombia):\n' + appointments.slice(0,20).map(item => `${item.serviceName} · ${new Intl.DateTimeFormat('es-CO',{timeZone:'America/Bogota',day:'numeric',month:'long',year:'numeric'}).format(item.startAt)} ${time.format(item.startAt)}–${time.format(item.endAt)} · ${appointmentStatusLabel(item.status)}`).join('\n') : 'No tienes próximas citas. Puedes consultar tu historial en Mis citas.';
      if (data.moreAppointments) reply += '\nHay más citas. Abre Mis citas para continuar por páginas.';
      break;
    }
    case 'owner_agenda': {
      const appointments = data.appointments as Appointment[] | undefined;
      reply = appointments?.length ? appointments.map(item => `${item.serviceName} · ${item.dateKey} ${item.startTimeStr}–${item.endTimeStr} · ${appointmentStatusLabel(item.status)}`).join('\n') : 'No hay citas para esta consulta. Puedes revisar próximas e historial en la agenda.';
      break;
    }
    case 'owner_usage': reply = typeof data.remainingResponses === 'number' ? `Respuestas de IA disponibles: ${data.remainingResponses}. Revisa Suscripción para ver tu consumo y vigencia.` : 'Consulta tu consumo y vigencia en Suscripción.'; break;
    case 'owner_block': reply = 'Para bloquear horarios o cancelar citas, utiliza los controles de Mi agenda. Revisa fecha, profesional y horario antes de guardar.'; break;
    case 'configure_business': reply = data.hasDraft ? 'Preparé una propuesta para el formulario. Pulsa Usar propuesta, revisa todos los datos y luego Guarda la configuración.' : 'Describe los datos completos de tu negocio o completa el formulario. Los cambios se guardan únicamente con Guardar configuración.'; break;
    default: reply = OUT_OF_SCOPE_REPLY;
  }
  return { reply };
}
