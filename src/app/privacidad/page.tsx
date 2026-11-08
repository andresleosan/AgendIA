import { LEGAL_VERSION, privacySections } from "@/lib/legal";
import type { Metadata } from "next";
import Link from "next/link";
import { AgendiaBrand } from "@/components/agendia-brand";

export const metadata: Metadata = {
  title: "Privacidad y datos · AgendIA",
  description: "Datos de cuentas, reservas, pagos y del asistente Sarin Bot en AgendIA.",
};

const linkClass = "text-sarin-blue underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-sarin-blue";

export default function PrivacyPage() {
  return (
    <div className="min-h-screen bg-sarin-canvas text-sarin-ink">
      <a href="#contenido" className="sarin-skip">Saltar al contenido</a>
      <header className="mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-4 border-b border-sarin-line px-5 py-6 sm:px-8">
        <Link href="/" aria-label="AgendIA, inicio"><AgendiaBrand /></Link>
        <nav aria-label="Información de AgendIA" className="flex flex-wrap gap-5 text-sm">
          <Link href="/terminos" className={`inline-flex min-h-11 items-center ${linkClass}`}>T?rminos</Link>
          <Link href="/ayuda" className={`inline-flex min-h-11 items-center ${linkClass}`}>Ayuda</Link>
          <Link href="/privacidad" aria-current="page" className="inline-flex min-h-11 items-center font-semibold">Privacidad</Link>
        </nav>
      </header>
      <main id="contenido" className="mx-auto max-w-3xl px-5 py-8 sm:px-8 sm:py-12">
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Privacidad y datos</h1>
        <p className="mt-3 text-sm leading-7 text-sarin-muted">Esta página explica el funcionamiento actual de SarinBot. Última actualización: 18 de octubre de 2026.</p>
        <div className="mt-8 space-y-8 rounded-2xl border border-sarin-line bg-sarin-paper p-5 text-sm leading-7 sm:p-8">
          {privacySections.map(section => <section key={section.id} aria-labelledby={section.id}>
            <h2 id={section.id} className="text-lg font-semibold">{section.title}</h2>
            {section.paragraphs.map(paragraph => <p key={paragraph} className="mt-3">{paragraph}</p>)}
          </section>)}
          <section aria-labelledby="contacto">
            <h2 id="contacto" className="text-lg font-semibold">Responsable y contacto de SarinBot</h2>
            <p className="mt-2">ALS Dev Studio</p>
            <p className="mt-2">Nombre comercial de Andrés Leonardo Santiago González, persona natural que presta servicios de desarrollo web y software desde Medellín, Colombia.</p>
            <dl className="mt-3 space-y-3">
              <div><dt className="font-medium">NIT</dt><dd>7005674733</dd></div>
              <div><dt className="font-medium">Dirección de contacto y notificaciones</dt><dd><address className="not-italic">Carrera 34 Calle 38 # 38, Medellín, Colombia.</address></dd></div>
              <div><dt className="font-medium">Correo para consultas y solicitudes sobre datos</dt><dd><a href="mailto:alsdevstudio@alsdevstudio.com" className={`inline-block min-h-11 break-all py-2 ${linkClass}`}>alsdevstudio@alsdevstudio.com</a></dd></div>
              <div><dt className="font-medium">Teléfono</dt><dd><a href="tel:+573146432135" className={`inline-block min-h-11 py-2 ${linkClass}`}>+57 314 643 2135</a></dd></div>
            </dl>
            <p className="mt-2">Para cambios en el servicio reservado o en tu atención, contacta también al negocio correspondiente.</p>
          </section>
        </div>
        <footer className="mt-6 flex flex-wrap gap-x-6 gap-y-2 text-sm">
          <Link href="/ayuda" className={`inline-flex min-h-11 items-center ${linkClass}`}>Cómo funcionan las citas y los pagos</Link>
          <Link href="/" className={`inline-flex min-h-11 items-center ${linkClass}`}>Volver al inicio</Link>
        </footer>
      </main>
    </div>
  );
}
