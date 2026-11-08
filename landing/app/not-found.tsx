import Link from "next/link";
import { AgendiaBrand } from "../../src/components/agendia-brand";

export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col items-start justify-center gap-6 px-6">
      <AgendiaBrand compact />
      <h1 className="text-4xl font-medium tracking-tight">Esta página no está disponible.</h1>
      <p className="text-sarin-muted">Revisa el enlace o vuelve a la portada de AgendIA para continuar.</p>
      <Link href="/" className="inline-flex min-h-11 items-center rounded-[10px] bg-sarin-blue px-6 py-3 font-semibold text-white hover:bg-[#244dd0]">Volver a la portada</Link>
    </main>
  );
}
