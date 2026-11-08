"use client";

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { QRCodeSVG } from 'qrcode.react';
import { AuthGate, useAuth } from '@/components/auth-provider';
import { AppShell, Notice, buttonClass } from '@/components/app-shell';
import { BookingCardPreview } from '@/components/booking-card-preview';
import { apiFetch, errorMessage } from '@/lib/client/api';
import { useApiPoll } from '@/lib/client/use-api-poll';
import { buildBookingCardAssets } from '@/lib/client/booking-card-assets';
import { businessSocialLabel, businessSocialPlatformLabels } from '@/lib/business-branding';
import { DEVELOPER_WEBSITE_URL, type BookingCardDetails } from '@/lib/booking-card';
import type { Business } from '@/types/firestore';

type Kit = { business: Business; bookingUrl: string };
type Assets = Awaited<ReturnType<typeof buildBookingCardAssets>>;
function QRKit({ uid }: { uid: string }) {
  const result = useApiPoll<Kit>(uid, async signal => {
    const value = await apiFetch<Kit>('/api/businesses/qr-kit?application=agendia', { signal });
    if (value.business.ownerUid !== uid) throw new Error('No tienes acceso a este negocio.');
    return value;
  });
  const kit = result.value;
  const details: BookingCardDetails | null = kit ? { businessId: kit.business.id, slug: kit.business.slug, businessName: kit.business.name, phoneWhatsApp: kit.business.phoneWhatsApp, socialLinks: kit.business.socialLinks ?? [], logoSha256: kit.business.logo?.sha256 ?? null, bookingUrl: kit.bookingUrl } : null;
  const snapshotKey = details && !result.error ? JSON.stringify(details) : '';
  const [prepared, setPrepared] = useState<{ key: string; assets: Assets } | null>(null);
  const [building, setBuilding] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const currentKey = useRef(snapshotKey); currentKey.current = snapshotKey;
  const controller = useRef<AbortController | null>(null);
  const qr = useRef<HTMLDivElement>(null);
  const developerQr = useRef<HTMLDivElement>(null);
  useEffect(() => {
    generation.current++; controller.current?.abort(); setPrepared(null); setBuilding(false); setError(null);
  }, [snapshotKey]);
  useEffect(() => () => { generation.current++; controller.current?.abort(); }, []);
  async function prepare() {
    if (!details || !snapshotKey || building) return;
    const svg = qr.current?.querySelector('svg');
    const developerSvg = developerQr.current?.querySelector('svg');
    if (!svg || svg.getAttribute('data-booking-url') !== details.bookingUrl) { setError('No pudimos preparar el QR. Actualiza y reintenta.'); return; }
    if (!developerSvg || developerSvg.getAttribute('data-booking-url') !== DEVELOPER_WEBSITE_URL) { setError('No pudimos preparar el QR del desarrollador. Actualiza y reintenta.'); return; }
    controller.current?.abort();
    const request = controller.current = new AbortController();
    const version = ++generation.current, key = snapshotKey;
    const snapshot = structuredClone(details);
    setBuilding(true); setError(null); setPrepared(null);
    try {
      const assets = await buildBookingCardAssets({ details: snapshot, qrSvg: new XMLSerializer().serializeToString(svg), developerQrSvg: new XMLSerializer().serializeToString(developerSvg), signal: request.signal });
      if (!request.signal.aborted && version === generation.current && currentKey.current === key) setPrepared({ key, assets });
    } catch (cause) { if (!request.signal.aborted && version === generation.current) setError(errorMessage(cause)); }
    finally { if (!request.signal.aborted && version === generation.current) setBuilding(false); }
  }
  async function copy() {
    if (!kit) return;
    const key = snapshotKey;
    try { await navigator.clipboard.writeText(kit.bookingUrl); if (key === currentKey.current) setNotice('Enlace copiado.'); }
    catch { if (key === currentKey.current) setNotice('No pudimos copiarlo. Selecciona el enlace y cópialo manualmente.'); }
  }
  if (result.loading) return <Notice>Cargando tarjeta de tu negocio…</Notice>;
  if (result.error || !details || !kit) return <section className="space-y-3"><Notice error>{result.error ?? 'Completa primero los datos de tu negocio.'}</Notice><button type="button" onClick={result.refresh} className={buttonClass}>Actualizar tarjeta</button><Link href="/dashboard/onboarding" className="ml-4 inline-flex min-h-11 items-center text-sarin-blue underline">Configurar negocio</Link></section>;
  const assets = prepared?.key === snapshotKey ? prepared.assets : null;
  return <section className="mx-auto max-w-3xl space-y-5 rounded-2xl border border-sarin-line bg-sarin-paper p-4 sm:p-8">
    <h1 className="break-words text-3xl font-semibold">Tarjeta de {details.businessName}</h1>
    <p className="text-sm text-sarin-muted">Agenda clara · formato A6, 105 × 148 mm. Se prepara con el logo, teléfono y enlaces que guardaste en la configuración.</p>
    <p className="text-sm text-sarin-muted">Revisa el enlace antes de imprimir y prueba el QR con tu teléfono. Imprime el PDF al 100%, sin ajustar a página y sin recortar el margen blanco del QR.</p>
    <p className="text-sm text-sarin-muted">El QR principal abre tus reservas. El QR pequeño del pie acompaña el crédito «Desarrollado por www.alsdevstudio.com» y abre la web de ALS Dev Studio.</p>
    <div className="mx-auto w-full max-w-64 border border-sarin-line bg-white p-3" ref={qr}><QRCodeSVG value={details.bookingUrl} size={591} level="M" marginSize={4} bgColor="#ffffff" fgColor="#000000" data-booking-url={details.bookingUrl} title={`Agenda de ${details.businessName}`} className="h-auto w-full" /></div>
    <div hidden aria-hidden="true" data-card-qr="developer" ref={developerQr}><QRCodeSVG value={DEVELOPER_WEBSITE_URL} size={213} level="M" marginSize={4} bgColor="#ffffff" fgColor="#000000" data-booking-url={DEVELOPER_WEBSITE_URL} title="ALS Dev Studio, desarrollador" /></div>
    <p className="break-all text-sm">{details.bookingUrl}</p>
    <div className="flex flex-wrap gap-4"><button type="button" className={buttonClass} disabled={building} onClick={() => void prepare()}>{building ? 'Preparando tarjeta…' : 'Preparar tarjeta'}</button><button type="button" onClick={() => void copy()} className="min-h-11 font-semibold text-sarin-blue">Copiar enlace</button><a href={details.bookingUrl} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center font-semibold text-sarin-blue underline">Abrir reservas</a><button type="button" onClick={result.refresh} disabled={building} className="min-h-11 text-sm text-sarin-blue">Actualizar datos</button></div>
    {notice && <Notice>{notice}</Notice>}{error && <Notice error>{error}</Notice>}
    <BookingCardPreview assets={assets} businessName={details.businessName} filenameStem={`tarjeta-${details.slug}`} qrFilename={`qr-${details.slug}.svg`} />
    {details.socialLinks.length > 0 && <nav aria-label="Contactos incluidos en la tarjeta" className="flex flex-wrap gap-x-4">{details.socialLinks.map(link => <a key={link.platform} href={link.url} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 max-w-full items-center break-all text-sm text-sarin-blue underline">{businessSocialPlatformLabels[link.platform]} · {businessSocialLabel(link)}</a>)}</nav>}
    <Link href="/dashboard/onboarding" className="inline-flex min-h-11 items-center text-sm font-semibold text-sarin-blue underline">Editar logo y contactos</Link>
  </section>;
}
export default function QRKitPage() {
  const { user } = useAuth();
  return <AuthGate><AppShell>{user && <QRKit key={user.uid} uid={user.uid} />}</AppShell></AuthGate>;
}
