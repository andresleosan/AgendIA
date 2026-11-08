import type { Metadata } from 'next';
import Link from 'next/link';
import { AgendiaBrand } from '@/components/agendia-brand';
import { LEGAL_VERSION, termsSections } from '@/lib/legal';
export const metadata: Metadata = { title: 'Términos y condiciones · AgendIA', description: 'Condiciones de uso, reservas, planes y soporte de AgendIA.' };
export default function TermsPage() {
  return <div className="min-h-screen bg-sarin-canvas text-sarin-ink">
    <a href="#contenido" className="sarin-skip">Saltar al contenido</a>
    <header className="mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-4 border-b border-sarin-line px-5 py-6 sm:px-8">
      <Link href="/" aria-label="AgendIA, inicio"><AgendiaBrand /></Link>
      <nav aria-label="Información de AgendIA" className="flex gap-5 text-sm text-sarin-blue"><Link href="/privacidad" className="inline-flex min-h-11 items-center underline">Privacidad</Link><Link href="/ayuda" className="inline-flex min-h-11 items-center underline">Ayuda</Link></nav>
    </header>
    <main id="contenido" className="mx-auto max-w-3xl px-5 py-8 sm:px-8 sm:py-12">
      <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Términos y condiciones de uso</h1>
      <p className="mt-3 text-sm text-sarin-muted">Versión {LEGAL_VERSION} · 16 de octubre de 2026</p>
      <div className="mt-8 space-y-8 rounded-2xl border border-sarin-line bg-sarin-paper p-5 text-sm leading-7 sm:p-8">{termsSections.map(section => <section key={section.title}><h2 className="text-lg font-semibold">{section.title}</h2>{section.paragraphs.map(text => <p key={text} className="mt-3">{text}</p>)}</section>)}</div>
      <p className="mt-6 text-sm"><a href="mailto:alsdevstudio@alsdevstudio.com" className="inline-flex min-h-11 items-center text-sarin-blue underline">alsdevstudio@alsdevstudio.com</a></p>
    </main>
  </div>;
}
