import type { Metadata } from "next";
import Link from "next/link";
import { AgendiaBrand, BrandCredits } from "@/components/agendia-brand";
import { sarinContact, sarinWhatsAppUrl } from "@/lib/sarin-contact";
import { PlatformWhatsAppLink } from "@/components/platform-whatsapp-link";

export const metadata: Metadata = {
  title: "Ayuda · AgendIA",
  description: "Cómo reservar y gestionar citas, pagar la prueba de AgendIA y solicitar soporte.",
};

const linkClass = "text-sarin-blue underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-sarin-blue";

export default function HelpPage() {
  return (
    <div className="min-h-screen bg-sarin-canvas text-sarin-ink">
      <a href="#contenido" className="sarin-skip">Saltar al contenido</a>
      <header className="mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-4 border-b border-sarin-line px-5 py-6 sm:px-8">
        <Link href="/" aria-label="AgendIA, inicio"><AgendiaBrand /></Link>
        <nav aria-label="Información de AgendIA" className="flex flex-wrap gap-5 text-sm">
          <Link href="/ayuda" aria-current="page" className="inline-flex min-h-11 items-center font-semibold">Ayuda</Link>
          <Link href="/privacidad" className={`inline-flex min-h-11 items-center ${linkClass}`}>Privacidad</Link>
        </nav>
      </header>
      <main id="contenido" className="mx-auto max-w-3xl px-5 py-8 sm:px-8 sm:py-12">
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Ayuda con AgendIA</h1>
        <p className="mt-3 text-sm leading-7 text-sarin-muted">Citas de clientes, acceso del negocio y pagos. Última actualización: 18 de octubre de 2026.</p>
        <div className="mt-8 space-y-8 rounded-2xl border border-sarin-line bg-sarin-paper p-5 text-sm leading-7 sm:p-8">
          <section aria-labelledby="citas">
            <h2 id="citas" className="text-lg font-semibold">Reservar y consultar una cita</h2>
            <p className="mt-2">Abre el enlace o QR del negocio e inicia sesión con Google. Indica a SarinBot el servicio y cuándo quieres acudir. Revisa servicio, profesional, fecha y hora antes de confirmar. La cita debe quedar guardada para considerarse confirmada.</p>
            <p className="mt-3">En «Mis citas», dentro del mismo negocio, puedes ver tus próximas reservas, el historial y las citas de una fecha. Usa la misma cuenta de Google con la que reservaste. Puedes cancelar una cita antes de su inicio; cancelar cambia su estado y conserva el registro.</p>
            <p className="mt-3">Si la atención de IA está en pausa o el motor no responde, tus citas existentes siguen disponibles. Contacta al establecimiento para acordar una nueva reserva o resolver dudas sobre el servicio.</p>
          </section>
          <section aria-labelledby="imagen">
            <h2 id="imagen" className="text-lg font-semibold">Guardar imagen de la cita</h2>
            <p className="mt-2">En una cita futura confirmada, usa «Guardar imagen de la cita» para descargar una tarjeta PNG. Se genera en tu navegador e incluye el negocio, el servicio, la fecha y la hora de Colombia, y el profesional o recurso asignado si corresponde. No incluye tu correo, teléfono ni respuestas del formulario de reserva.</p>
            <p className="mt-3">La imagen es una copia estática: no se actualiza si la cita cambia o se cancela. Consulta «Mis citas» para comprobar el estado actual. Guardarla no añade un evento al calendario ni activa recordatorios automáticos por correo o WhatsApp.</p>
          </section>
          <section aria-labelledby="prueba">
            <h2 id="prueba" className="text-lg font-semibold">Prueba pagada para el negocio</h2>
            <p className="mt-2">La prueba cuesta $5.000 COP una sola vez. Incluye configurar un negocio, hasta 10 citas creadas y un límite independiente de 700 respuestas de IA en total, sin vencimiento por días.</p>
            <p className="mt-3">La configuración asistida y la atención al cliente comparten esas respuestas. Cada cita creada correctamente consume un cupo; cancelarla no lo devuelve. Los fallos y los reintentos de una misma reserva no consumen cupos adicionales.</p>
            <p className="mt-3">Al agotar las 10 citas o la capacidad de IA correspondiente, elige un plan para continuar con la atención de IA y las nuevas reservas. La agenda y las citas existentes siguen disponibles para consulta y cancelación.</p>
          </section>
          <section aria-labelledby="pagos">
            <h2 id="pagos" className="text-lg font-semibold">Transferencias y revisión de pagos</h2>
            <p className="mt-2">En «Suscripción», elige la prueba o un plan, utiliza una de las cuentas de transferencia mostradas y envía tu comprobante desde el formulario. Revisa allí el precio, la vigencia y las respuestas incluidas antes de pagar. Si no aparecen cuentas de pago, contacta a SarinBot antes de hacer una transferencia.</p>
            <p className="mt-3">Andrés Santiago revisa los comprobantes manualmente en la bandeja de administración de SarinBot. Actualmente no se envían avisos automáticos por correo: los pendientes se consultan en esa consola. Subir el comprobante no equivale a tener el pago aprobado ni habilita el acceso inicial por sí solo.</p>
            <p className="mt-3">El estado de revisión aparece en «Suscripción». Si se rechaza, consulta el motivo mostrado antes de enviar otro comprobante. No se promete un horario ni un plazo automático de aprobación. Para consultar un pago pendiente, escribe al contacto de soporte.</p>
            <p className="mt-3">No hay cobros recurrentes automáticos. Los pagos a SarinBot contratan el uso de la plataforma para el negocio; no pagan el corte, consulta u otro servicio que un cliente reserve en el establecimiento.</p>
          </section>
          <section aria-labelledby="whatsapp">
            <h2 id="whatsapp" className="text-lg font-semibold">WhatsApp</h2>
            <p className="mt-2">La atención automatizada por WhatsApp todavía no está activa ni disponible para contratar. Que un negocio muestre un teléfono o un enlace de contacto no significa que tenga un bot conectado a WhatsApp.</p>
          </section>
          <section aria-labelledby="soporte">
            <h2 id="soporte" className="text-lg font-semibold">Soporte y consultas sobre datos</h2><p><Link href="/soporte" className={linkClass}>Abrir soporte privado de SarinBot</Link></p>
            <p className="mt-2">Contacta a Andrés Santiago · SarinBot en:</p>
            <p><a href={sarinWhatsAppUrl} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" className={`inline-flex min-h-11 max-w-full items-center py-2 ${linkClass}`}>WhatsApp de SarinBot: {sarinContact.displayPhone}</a></p>
            <a href="mailto:alsdevstudio@alsdevstudio.com" className={`inline-block min-h-11 break-all py-2 ${linkClass}`}>alsdevstudio@alsdevstudio.com</a>
            <p className="mt-2">Indica el negocio y el problema que necesitas resolver. No envíes contraseñas ni códigos de acceso. Para cambios en el servicio reservado, contacta al establecimiento.</p>
            <p className="mt-3">Puedes consultar qué datos utiliza SarinBot y cómo solicitar su revisión en <Link href="/privacidad" className={linkClass}>Privacidad y datos</Link>.</p>
          </section>
        </div>
        <div className="mt-8"><PlatformWhatsAppLink /></div>
        <footer className="mt-6 flex flex-wrap gap-x-6 gap-y-2 text-sm">
          <BrandCredits />
          <Link href="/privacidad" className={`inline-flex min-h-11 items-center ${linkClass}`}>Privacidad y datos</Link>
          <Link href="/" className={`inline-flex min-h-11 items-center ${linkClass}`}>Volver al inicio</Link>
        </footer>
      </main>
    </div>
  );
}
