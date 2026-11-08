"use client";
import type { ReactNode } from 'react';
import { useAuth } from '@/components/auth-provider';
import { UserAvatar } from '@/components/user-avatar';
import { AgendiaBrand, BrandCredits } from '@/components/agendia-brand';
import { ConsentPanel, useAccountConsent } from '@/components/consent-panel';
export function TeamWorkspaceShell({ children }: { children: ReactNode }) {
  const { user, signOut } = useAuth(), consent = useAccountConsent();
  return <div className="sarin-backdrop min-h-screen text-sarin-ink"><a href="#team-content" className="sr-only focus:not-sr-only focus:block focus:p-3">Saltar al contenido</a><header className="border-b border-sarin-line bg-sarin-paper"><div className="mx-auto flex max-w-4xl flex-wrap items-center justify-between gap-3 p-4"><a href="/team" aria-label="AgendIA, mis espacios"><AgendiaBrand compact /></a><div className="flex items-center gap-3"><UserAvatar name={user?.displayName ?? 'Mi cuenta'} photoURL={user?.photoURL} /><button className="min-h-11 text-sm text-sarin-blue underline" onClick={() => void signOut()}>Salir</button></div></div><nav aria-label="Equipo" className="mx-auto flex max-w-4xl gap-4 px-4"><a className="inline-flex min-h-11 items-center text-sm text-sarin-blue underline" href="/team">Mis espacios</a></nav></header><main id="team-content" className="mx-auto max-w-4xl min-w-0 space-y-6 px-4 py-6"><ConsentPanel controller={consent} title="Permisos de mi cuenta" />{children}</main><footer className="mx-auto max-w-4xl px-4 py-6"><BrandCredits /></footer></div>;
}
