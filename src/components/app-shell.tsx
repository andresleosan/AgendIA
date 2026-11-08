"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronRight, LogOut } from "lucide-react";
import { type ReactNode } from "react";
import { useAuth } from "@/components/auth-provider";
import { AgendiaBrand, BrandCredits } from "@/components/agendia-brand";
import { UserAvatar } from "@/components/user-avatar";
import { ConsentPanel, useAccountConsent } from './consent-panel';
import { WorkspaceNavigation } from '@/components/workspace-navigation';
import { getAdminNavigationItems, type AdminLocation, type WorkspaceNavItem } from '@/lib/admin-navigation';

const businessLinks: WorkspaceNavItem[] = [
  { id: "agenda", href: "/dashboard", label: "Mi agenda" },
  { id: "business", href: "/dashboard/onboarding", label: "Mi negocio" },
  { id: "qr", href: "/dashboard/qr-kit", label: "Enlace y QR" },
  { id: "subscription", href: "/dashboard/billing", label: "Suscripción" },
];

export function AppShell({
  children,
  admin = false,
  adminLocation,
  businessNavigationPath,
}: {
  children: ReactNode;
  admin?: boolean;
  adminLocation?: AdminLocation;
  businessNavigationPath?: '/dashboard' | '/dashboard/onboarding' | '/dashboard/qr-kit' | '/dashboard/billing';
}) {
  const { user, signOut, isSuperadmin } = useAuth();
  const accountConsent = useAccountConsent();
  const pathname = usePathname();
  const links = admin ? getAdminNavigationItems() : businessLinks;
  const activeId = admin
    ? adminLocation?.module ?? (pathname === "/admin/assistant" ? "attention" : "summary")
    : businessLinks.find(item => item.href === (businessNavigationPath ?? pathname))?.id ?? "";
  const active = links.find(item => item.id === activeId);
  const name = user?.displayName || user?.email || "Mi cuenta";
  return (
    <div className="min-h-screen bg-sarin-canvas text-sarin-ink lg:grid lg:grid-cols-[236px_minmax(0,1fr)]">
      <a href="#workspace-content" className="sarin-skip">Saltar al contenido</a>
      <aside className="border-b border-sarin-line bg-sarin-paper lg:sticky lg:top-0 lg:flex lg:h-screen lg:flex-col lg:border-r lg:border-b-0">
        <div className="flex items-center justify-between px-5 py-5 lg:px-6 lg:py-8">
          <Link href="/" aria-label="AgendIA, inicio"><AgendiaBrand /></Link>
        </div>
        <WorkspaceNavigation context={admin ? 'platform' : 'business'} items={links} activeId={activeId} isSuperadmin={isSuperadmin} />
        <div className="mt-auto hidden px-6 pb-6 pt-10 lg:block">
          <div className="border-t border-sarin-line pt-5"><p className="text-sm text-sarin-ink">Un poco más de orden.</p><p className="mt-1 text-xs leading-6 text-sarin-muted">Un poco más de tiempo para ti.</p></div>
        </div>
      </aside>
      <div className="min-w-0">
        <header className="flex min-h-16 items-center justify-between gap-3 border-b border-sarin-line bg-sarin-paper px-4 sm:px-6 lg:px-8">
          <div className="flex min-w-0 items-center gap-2 text-xs text-sarin-muted"><span className="hidden sm:inline">{admin ? "Administración" : "Mi espacio"}</span><ChevronRight aria-hidden="true" className="hidden h-3.5 w-3.5 sm:block" /><span className="truncate text-sarin-ink">{active?.label ?? "AgendIA"}</span></div>
          <div className="flex shrink-0 items-center gap-3"><UserAvatar name={name} photoURL={user?.photoURL} /><span className="hidden max-w-44 truncate text-xs text-sarin-muted sm:block">{name}</span><button onClick={() => void signOut()} aria-label="Cerrar sesión" title="Cerrar sesión" className="grid h-11 w-11 place-items-center rounded-[10px] text-sarin-muted hover:bg-sarin-soft hover:text-sarin-blue"><LogOut aria-hidden="true" className="h-4 w-4" /></button></div>
        </header>
        <main id="workspace-content" className="mx-auto max-w-[1440px] px-4 py-5 sm:px-6 lg:px-8 lg:py-6">{!admin && <ConsentPanel controller={accountConsent} title="Permisos de mi cuenta" />}{children}</main>
        <footer className="mx-auto max-w-[1440px] border-t border-sarin-line px-4 py-5 sm:px-6 lg:px-8"><BrandCredits /></footer>
      </div>
    </div>
  );
}
export function Notice({
  children,
  error = false,
}: {
  children: ReactNode;
  error?: boolean;
}) {
  return (
    <p
      role={error ? "alert" : "status"}
      className={`rounded-xl border px-4 py-3 text-sm leading-6 ${error ? "border-rose-200 bg-rose-50 text-rose-800" : "border-sarin-line bg-sarin-paper text-sarin-muted"}`}
    >
      {children}
    </p>
  );
}
export const fieldClass =
  "min-h-11 min-w-0 w-full rounded-[10px] border border-sarin-line bg-sarin-paper px-3.5 py-2.5 text-sm text-sarin-ink outline-none transition placeholder:text-sarin-muted focus:border-sarin-blue focus:ring-2 focus:ring-sarin-blue focus:ring-offset-2 focus:ring-offset-sarin-paper disabled:cursor-not-allowed disabled:bg-sarin-canvas disabled:opacity-70";
export const buttonClass =
  "min-h-11 rounded-[10px] bg-sarin-blue px-5 py-3 text-sm font-semibold text-white transition hover:bg-[#244dd0] disabled:cursor-not-allowed disabled:opacity-50";
