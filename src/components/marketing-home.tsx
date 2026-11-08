import Link from "next/link";
import { ArrowDown, ArrowRight, ArrowUpRight } from "lucide-react";
import { AgendaPreview } from "./agenda-preview";
import { SarinArrival } from "./sarin-arrival";
import { AgendiaBrand, BrandCredits } from "./agendia-brand";
import { MarketingPricing } from "./marketing-pricing";
import { PAID_TRIAL_APPOINTMENT_LIMIT, PAID_TRIAL_INCLUDED_RESPONSES, PAID_TRIAL_PRICE_COP } from "@/lib/paid-trial";
import { publicApplicationOrigin } from "@/lib/marketing-links";
import { sarinWhatsAppUrl } from "@/lib/sarin-contact";
import "./marketing-home.css";

const steps = [
  { title: "Prepara tu espacio", text: "Paga $5.000 COP y, tras aprobar tu comprobante, configura tus servicios, profesionales y horarios. Incluye hasta 10 citas, sin caducidad." },
  { title: "Comparte tu enlace", text: "En tu perfil, por mensaje o con un QR en tu local. Tus clientes llegan a tu propio espacio." },
  { title: "Organiza tu agenda", text: "Consulta las citas confirmadas, bloquea tus horas ocupadas y cancela reservas desde el panel de tu negocio." },
];

const price = (value: number) => value.toLocaleString("es-CO");

export function MarketingHome({ standalone = false, publicAppUrl }: { standalone?: boolean; publicAppUrl?: string }) {
  const publicOrigin = publicApplicationOrigin(publicAppUrl);
  const accessEnabled = !standalone || Boolean(publicOrigin);
  const dashboard = standalone ? publicOrigin ? `${publicOrigin}/dashboard` : "#empezar" : "/dashboard";
  const onboarding = standalone ? publicOrigin ? `${publicOrigin}/dashboard/onboarding` : "#planes" : "/dashboard/onboarding";
  return (
    <div className="agenda-home">
      <a href="#main-content" className="sarin-skip">Saltar al contenido</a>
      <header className="agenda-header agenda-container">
        <Link href="/" aria-label="AgendIA, inicio"><AgendiaBrand compact /></Link>
        <nav aria-label="Navegación principal" className="agenda-nav">
          <a href="#como-funciona">El asistente</a>
          <a href="#tu-agenda">Tu agenda</a>
          <a href="#planes">Planes</a>
        </nav>
        <Link href={dashboard} className="agenda-button agenda-button-small">
          {accessEnabled ? "Mi negocio" : "Cómo empezar"}<ArrowUpRight aria-hidden="true" />
        </Link>
      </header>
      <main id="main-content">
        <section className="agenda-hero agenda-container" aria-labelledby="agenda-heading">
          <h1 id="agenda-heading">Tus clientes agendan, <span>la IA trabaja</span></h1>
          <p className="agenda-intro">AgendIA reúne tus reservas y tu agenda.<br className="agenda-desktop-break" /> Sarin Bot consulta tus servicios y horarios, confirma reservas y las organiza en tu agenda.</p>
          <div className="agenda-hero-actions">
            <Link href={onboarding} className="agenda-button">
              {accessEnabled ? `Empezar por $${price(PAID_TRIAL_PRICE_COP)} COP` : "Ver planes y prueba"}<ArrowRight aria-hidden="true" />
            </Link>
            <a href="#tu-agenda" className="agenda-text-link">Explorar la agenda<ArrowDown aria-hidden="true" /></a>
          </div>
          <p className="agenda-launch-note">{!accessEnabled && "Acceso coordinado con ALS Dev Studio. "}Prueba pagada: configuración y {PAID_TRIAL_APPOINTMENT_LIMIT} citas, sin caducidad por días. Se activa al aprobar tu comprobante.</p>
          <AgendaPreview />
          <SarinArrival />
        </section>
        <section id="como-funciona" className="agenda-how agenda-container" aria-labelledby="how-heading">
          <div className="agenda-section-heading">
            <h2 id="how-heading">De la conversación<br />a una cita confirmada.</h2>
            <p>Configura servicios, profesionales, precios y horarios. Sarin Bot consulta esa información antes de reservar.</p>
          </div>
          <ol className="agenda-steps">
            {steps.map(({ title, text }) => <li key={title}>
              <h3>{title}</h3><p>{text}</p>
            </li>)}
          </ol>
        </section>
        <section id="tu-espacio" className="agenda-details agenda-container" aria-labelledby="space-heading">
          <h2 id="space-heading" className="agenda-sr-only">Tu espacio en AgendIA</h2>
          <div className="agenda-detail"><h3>Reservas vinculadas al cliente</h3><p>Tu cliente entra con Google, consulta disponibilidad y revisa el resumen antes de confirmar. La cita queda vinculada a su cuenta.</p></div>
          <div className="agenda-detail"><h3>Sus citas, dentro de tu negocio</h3><p>En «Mis citas», el cliente consulta sus próximas reservas, el historial y las citas de una fecha. Puede cancelar una cita antes de que empiece y usar «Guardar imagen de la cita» para descargar un PNG de una reserva futura confirmada. La imagen es estática; los cambios se consultan en «Mis citas».</p></div>
        </section>
        <section id="planes" className="agenda-how agenda-container" aria-labelledby="plans-heading">
          <div className="agenda-section-heading">
            <h2 id="plans-heading">Prueba con {PAID_TRIAL_APPOINTMENT_LIMIT} citas.<br />Continúa con un plan de AgendIA.</h2>
            <p>La prueba cuesta ${price(PAID_TRIAL_PRICE_COP)} COP una sola vez e incluye la configuración y {PAID_TRIAL_INCLUDED_RESPONSES} respuestas de IA en total, sin vencimiento por días.</p>
          </div>
          <p className="agenda-launch-note">Cada cita creada consume un cupo de la prueba; cancelarla no lo devuelve. Las {PAID_TRIAL_INCLUDED_RESPONSES} respuestas son un límite independiente y también incluyen la configuración. Al agotarse las citas o las respuestas, se necesita un plan para continuar con la atención de IA.</p>
          <MarketingPricing endpoint={standalone ? publicOrigin ? `${publicOrigin}/api/public/commercial-offer` : null : "/api/public/commercial-offer"} />
        </section>
        <section id="empezar" className="agenda-launch agenda-container" aria-labelledby="launch-heading">
          <h2 id="launch-heading">Prepara la agenda<br /><span>de tu negocio.</span></h2>
          <p>{accessEnabled ? "Entra con Google, elige la prueba pagada o un plan y envía tu comprobante. Después de su aprobación puedes configurar tu negocio y compartir tu enlace." : "Coordina el acceso con ALS Dev Studio para configurar tu negocio. La prueba pagada y los planes se activan después de revisar el comprobante de transferencia."}</p>
          {accessEnabled ? <Link href={onboarding} className="agenda-button">Configurar mi negocio<ArrowRight aria-hidden="true" /></Link> : <a href="https://www.alsdevstudio.com/" className="agenda-button">Conocer ALS Dev Studio<ArrowUpRight aria-hidden="true" /></a>}
        </section>
      </main>
      <footer className="agenda-footer agenda-container">
        <Link href="/" aria-label="AgendIA, inicio"><AgendiaBrand compact /></Link>
        <BrandCredits />
        <a href={sarinWhatsAppUrl} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" className="agenda-text-link">Contactar a Sarin Bot por WhatsApp<ArrowUpRight aria-hidden="true" /></a>
        {accessEnabled && <nav aria-label="Información del servicio" className="flex flex-wrap gap-x-5">
          <Link href={standalone ? `${publicOrigin}/ayuda` : "/ayuda"} className="agenda-text-link">Ayuda</Link>
          <Link href={standalone ? `${publicOrigin}/privacidad` : "/privacidad"} className="agenda-text-link">Privacidad</Link>
        </nav>}
        <a href="#planes" className="agenda-text-link">Ver planes<ArrowRight aria-hidden="true" /></a>
      </footer>
    </div>
  );
}
