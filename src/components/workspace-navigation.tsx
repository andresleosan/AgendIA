"use client";

import Link from "next/link";
import { Bot, CalendarDays, CreditCard, LayoutDashboard, Menu, QrCode, Settings2, ShieldCheck, Sparkles, Store, type LucideIcon } from "lucide-react";
import { useEffect, useId, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { type WorkspaceNavItem } from "@/lib/admin-navigation";

const icons: Record<string, LucideIcon> = {
  agenda: CalendarDays, business: Settings2, qr: QrCode, subscription: CreditCard,
  summary: LayoutDashboard, businesses: Store, access: ShieldCheck,
  intelligence: Sparkles, attention: Bot, billing: CreditCard,
};

export function WorkspaceNavigation({ context, items, activeId, isSuperadmin }: {
  context: 'business' | 'platform';
  items: WorkspaceNavItem[];
  activeId: string;
  isSuperadmin: boolean;
}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const navigationId = useId();
  useEffect(() => { setOpen(false); }, [activeId, context]);
  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key !== 'Escape' || !open) return;
    event.preventDefault();
    setOpen(false);
    button.current?.focus();
  }
  function select(event: MouseEvent<HTMLAnchorElement>, active = false) {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || (event.button != null && event.button !== 0) || (event.currentTarget?.target && event.currentTarget.target !== '_self')) return;
    setOpen(false);
    if (open && active) button.current?.focus();
  }
  const visibleItems = context === 'platform' && !isSuperadmin ? [] : items;
  return (
    <div onKeyDown={onKeyDown}>
      <div className="flex min-w-0 items-center justify-between gap-3 px-5 pb-3 lg:px-7">
        <p className="sarin-eyebrow min-w-0 text-sarin-muted">{context === 'platform' ? 'Administración de Sarin' : 'Mi negocio'}</p>
        <button ref={button} type="button" aria-expanded={open} aria-controls={navigationId} onClick={() => setOpen(value => !value)} className="flex min-h-11 shrink-0 items-center gap-2 rounded-[10px] px-3 text-sm text-sarin-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sarin-blue lg:hidden"><Menu aria-hidden="true" className="h-4 w-4" />Menú</button>
      </div>
      <nav id={navigationId} aria-label={context === 'platform' ? 'Navegación de administración' : 'Navegación del negocio'} className={`${open ? 'flex' : 'hidden'} min-w-0 flex-col gap-1 px-3 pb-3 lg:flex lg:px-4`}>
        {visibleItems.map(({ id, href, label }) => {
          const Icon = icons[id] ?? LayoutDashboard;
          const active = id === activeId;
          return <Link key={id} href={href} scroll={context === 'platform' ? false : undefined} aria-current={active ? 'page' : undefined} onClick={event => select(event, active)} className={`flex min-h-11 min-w-0 items-center gap-3 rounded-[10px] px-3 py-3 text-[13px] font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sarin-blue ${active ? 'bg-sarin-soft text-sarin-blue' : 'text-sarin-muted hover:bg-sarin-canvas hover:text-sarin-ink'}`}><Icon aria-hidden="true" className="h-[18px] w-[18px] shrink-0" strokeWidth={1.7} /><span className="min-w-0 break-words">{label}</span>{active && <span className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-sarin-blue" />}</Link>;
        })}
        {context === 'platform' && isSuperadmin && <Link href="/dashboard" onClick={select} className="mt-2 flex min-h-11 items-center gap-3 rounded-[10px] px-3 py-3 text-[13px] text-sarin-muted hover:text-sarin-blue focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sarin-blue"><CalendarDays aria-hidden="true" className="h-[18px] w-[18px] shrink-0" />Volver a mi negocio</Link>}
      </nav>
    </div>
  );
}
