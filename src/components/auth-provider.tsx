"use client";

import { AgendiaBrand, BrandCredits } from "@/components/agendia-brand";
import { AccountConsentProvider, PreauthorizationChoices } from '@/components/consent-panel';
import type { ConsentStatus } from '@/lib/legal';
import { createContext, useCallback, useContext, useEffect, useState, useRef, type ReactNode } from "react";
import { GoogleAuthProvider, onIdTokenChanged, signInWithPopup, signOut as firebaseSignOut, type User } from "firebase/auth";
import { getFirebaseClient } from "@/lib/firebase/client";
import { apiFetch, errorMessage } from "@/lib/client/api";
import { signInLocalAccount, type LocalAccountRole } from "@/lib/firebase/local-auth";

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  isSuperadmin: boolean;
  error: string | null;
  authEpoch: number;
  signingOut: boolean;
  isCurrentSession: (expectedUid: string, expectedEpoch: number) => boolean;
  invalidateSession: (expectedUid: string, expectedEpoch: number) => void;
  signIn: (preauthorization?: string) => Promise<void>;
  signInLocal: (account: LocalAccountRole) => Promise<void>;
  signOut: () => Promise<void>;
}
const AuthContext = createContext<AuthContextValue | null>(null);
const localEmulators = process.env.NODE_ENV === "development" && process.env.NEXT_PUBLIC_FIREBASE_EMULATORS === "true";
const SESSION_VALIDATION_DEADLINE_MS = 10_000;

export function AuthProvider({ children }: { children: ReactNode }) {
  const [snapshot, setSnapshot] = useState({ user: null as User | null, loading: true, isSuperadmin: false, error: null as string | null, authEpoch: 0, signingOut: false });
  const [consentVersion, setConsentVersion] = useState(0);
  const state = useRef({ active: false, uid: null as string | null, epoch: 0, verified: null as User | null, admin: false, signingOut: false, blocked: false, version: 0, logoutVersion: 0 });
  const deadline = useRef<ReturnType<typeof setTimeout> | null>(null);
  const request = useRef<AbortController | null>(null);
  const validate = useRef<(user: User | null) => Promise<void>>(async () => {});
  const signingIn = useRef(false);
  const clearPending = useCallback(() => {
    if (deadline.current !== null) clearTimeout(deadline.current);
    deadline.current = null;
    request.current?.abort(); request.current = null;
  }, []);
  const invalidate = useCallback((message: string | null, blocked: boolean) => {
    const current = state.current;
    clearPending(); current.version++; current.epoch++; current.verified = null; current.admin = false; current.blocked = blocked;
    setSnapshot({ user: null, loading: false, isSuperadmin: false, error: message, authEpoch: current.epoch, signingOut: current.signingOut });
  }, [clearPending]);
  const isCurrentSession = useCallback((uid: string, epoch: number) => {
    const current = state.current;
    return current.active && !current.signingOut && !current.blocked && current.epoch === epoch && current.uid === uid && current.verified?.uid === uid && getFirebaseClient().auth.currentUser?.uid === uid;
  }, []);
  const invalidateSession = useCallback((uid: string, epoch: number) => {
    if (isCurrentSession(uid, epoch)) invalidate('Tu sesión dejó de ser válida. Vuelve a iniciar sesión.', true);
  }, [invalidate, isCurrentSession]);
  useEffect(() => {
    const current = state.current; current.active = true;
    async function onUser(nextUser: User | null) {
      if (!current.active) return;
      const uid = nextUser?.uid ?? null;
      if (uid !== current.uid) {
        invalidate(null, false); current.uid = uid;
      }
      if (current.signingOut) return;
      if (!nextUser) { setSnapshot({ user: null, loading: false, isSuperadmin: false, error: null, authEpoch: current.epoch, signingOut: false }); return; }
      if (current.blocked) return;
      const epoch = current.epoch, version = ++current.version;
      const background = current.verified?.uid === uid;
      request.current?.abort();
      const abort = request.current = new AbortController();
      const owns = () => current.active && current.version === version && current.epoch === epoch && current.uid === uid && !current.signingOut && !current.blocked && getFirebaseClient().auth.currentUser?.uid === uid;
      if (!background) setSnapshot({ user: null, loading: true, isSuperadmin: false, error: null, authEpoch: epoch, signingOut: false });
      if (deadline.current === null) deadline.current = setTimeout(() => {
        if (current.active && current.epoch === epoch && current.uid === uid && !current.signingOut) invalidate('No se pudo verificar tu sesión a tiempo. Vuelve a iniciar sesión.', true);
      }, SESSION_VALIDATION_DEADLINE_MS);
      try {
        const session = await apiFetch<{ isSuperadmin: boolean }>('/api/session', { signal: abort.signal }, nextUser.uid);
        if (!owns()) return;
        if (typeof session?.isSuperadmin !== 'boolean') throw new Error('No se pudo verificar tu sesión.');
        clearPending(); current.verified = nextUser; current.admin = session.isSuperadmin;
        setSnapshot({ user: nextUser, loading: false, isSuperadmin: session.isSuperadmin, error: null, authEpoch: epoch, signingOut: false });
      } catch (cause) {
        if (owns()) invalidate(errorMessage(cause), true);
      }
    }
    validate.current = onUser;
    let unsubscribe: (() => void) | undefined;
    try { unsubscribe = onIdTokenChanged(getFirebaseClient().auth, onUser); }
    catch (cause) { invalidate(errorMessage(cause), true); }
    return () => { current.active = false; current.version++; current.verified = null; clearPending(); unsubscribe?.(); };
  }, [clearPending, invalidate]);
  const signIn = useCallback(async (preauthorization?: string) => {
    if (signingIn.current || state.current.signingOut) return;
    signingIn.current = true;
    const logoutVersion = state.current.logoutVersion;
    let actionEpoch = state.current.epoch;
    let actionUid = getFirebaseClient().auth.currentUser?.uid ?? null;
    setSnapshot(value => ({ ...value, error: null }));
    try {
      const credential = await signInWithPopup(getFirebaseClient().auth, new GoogleAuthProvider());
      const owns = () => state.current.active && !state.current.signingOut && state.current.logoutVersion === logoutVersion && getFirebaseClient().auth.currentUser?.uid === credential.user.uid;
      if (!owns()) return;
      if (state.current.blocked) { state.current.blocked = false; void validate.current(credential.user); }
      const epoch = state.current.epoch;
      actionEpoch = epoch; actionUid = credential.user.uid;
      const current = () => owns() && state.current.epoch === epoch;
      if (preauthorization) {
        const consent = await apiFetch<ConsentStatus>('/api/consent?scope=account', {}, credential.user.uid, current);
        if (!current()) return;
        await apiFetch('/api/consent', { method: 'POST', body: JSON.stringify({ scope: 'account', action: 'accept', requestId: crypto.randomUUID(), expectedRevision: consent.revision, fingerprint: consent.documents.fingerprint, termsAccepted: true, dataAuthorized: true, preauthorization }) }, credential.user.uid, current);
        if (current()) setConsentVersion(value => value + 1);
      }
    } catch (cause) {
      if (state.current.active && state.current.logoutVersion === logoutVersion && state.current.epoch === actionEpoch && (getFirebaseClient().auth.currentUser?.uid ?? null) === actionUid && !state.current.signingOut) setSnapshot(value => ({ ...value, error: errorMessage(cause) }));
    } finally { signingIn.current = false; }
  }, []);
  const signOut = useCallback(async () => {
    const current = state.current;
    if (current.signingOut) return;
    current.signingOut = true; current.logoutVersion++;
    invalidate(null, false);
    try { await firebaseSignOut(getFirebaseClient().auth); }
    catch (cause) {
      if (current.active) setSnapshot(value => ({ ...value, error: errorMessage(cause) }));
    } finally {
      if (current.active) {
        current.signingOut = false;
        setSnapshot(value => ({ ...value, signingOut: false }));
        // Even a failed logout starts a new, code-free verified session.
        await validate.current(getFirebaseClient().auth.currentUser);
      }
    }
  }, [invalidate]);
  const signInLocal = useCallback(async (account: LocalAccountRole) => {
    const version = state.current.logoutVersion, epoch = state.current.epoch;
    try { await signInLocalAccount(account); }
    catch (cause) {
      if (state.current.active && state.current.logoutVersion === version && state.current.epoch === epoch) setSnapshot(value => ({ ...value, error: errorMessage(cause) }));
      throw cause;
    }
  }, []);
  const effectiveUser = snapshot.user && isCurrentSession(snapshot.user.uid, snapshot.authEpoch) ? snapshot.user : null;
  return <AuthContext.Provider value={{ ...snapshot, user: effectiveUser, isSuperadmin: Boolean(effectiveUser && snapshot.isSuperadmin), isCurrentSession, invalidateSession, signIn, signInLocal, signOut }}>
    {localEmulators && <div role="status" className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-center text-xs text-amber-900">Entorno local · Firebase emulado · datos de negocio temporales</div>}
    <AccountConsentProvider key={snapshot.authEpoch} uid={effectiveUser?.uid} refreshVersion={consentVersion}>{children}</AccountConsentProvider>
  </AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth debe usarse dentro de AuthProvider.");
  return value;
}

export function AuthGate({
  children,
  admin = false,
}: {
  children: ReactNode;
  admin?: boolean;
}) {
  const { user, loading, error, isSuperadmin, signIn, signInLocal, signOut } =
    useAuth();
  const [localSigningIn, setLocalSigningIn] = useState<LocalAccountRole | null>(
    null,
  );
  function enterLocal(account: LocalAccountRole) {
    setLocalSigningIn(account);
    void signInLocal(account)
      .catch(() => undefined)
      .finally(() => setLocalSigningIn(null));
  }
  if (loading)
    return (
      <main className="min-h-screen grid place-items-center bg-sarin-canvas p-6 text-sarin-ink">
        <p role="status" className="text-sarin-muted">
          Verificando tu sesión…
        </p>
      </main>
    );
  if (!user)
    return (
      <main className="sarin-backdrop grid min-h-screen place-items-center px-5 py-12">
        <section className="sarin-surface w-full max-w-md space-y-6 rounded-2xl p-7 shadow-[0_16px_48px_#233e7c09] sm:p-9">
          <a href="/" aria-label="AgendIA, inicio" className="mb-3 inline-block"><AgendiaBrand /></a>
          <div><p className="sarin-eyebrow mb-3 text-sarin-blue">Tu espacio está aquí</p><h1 className="text-3xl font-semibold leading-tight tracking-[-0.04em] text-sarin-ink">Inicia sesión para continuar</h1></div>
          <p className="text-sm leading-7 text-sarin-muted">
            {localEmulators
              ? "Usa una cuenta local de prueba para acceder a tu espacio."
              : "Usa tu cuenta de Google para acceder a tu espacio."}
          </p>
          {error && (
            <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
              {error}
            </p>
          )}
          {localEmulators && (
            <div className="space-y-2">
              {(
                [
                  ["admin", "Administrador local"],
                  ["owner", "Negocio local"],
                  ["client", "Cliente local"],
                ] as const
              ).map(([account, label]) => (
                <button
                  key={account}
                  onClick={() => enterLocal(account)}
                  disabled={localSigningIn !== null}
                  className="min-h-12 w-full rounded-[10px] border border-sarin-line bg-sarin-paper px-4 py-3 text-sm font-medium text-sarin-ink hover:border-sarin-blue hover:bg-sarin-soft disabled:opacity-50"
                >
                  {localSigningIn === account ? "Entrando…" : label}
                </button>
              ))}
            </div>
          )}
          <PreauthorizationChoices onContinue={signIn} />
          <button onClick={() => void signIn()} disabled={localSigningIn !== null} className="min-h-11 w-full text-left text-sm text-sarin-blue underline">Entrar para consultar mis citas o ejercer mis derechos</button>
          <nav aria-label="Información del servicio" className="flex flex-wrap gap-x-5 text-xs text-sarin-blue">
            <a href="/privacidad" className="inline-flex min-h-11 items-center underline underline-offset-4">Privacidad</a>
            <a href="/ayuda" className="inline-flex min-h-11 items-center underline underline-offset-4">Ayuda</a>
          </nav>
          <p className="border-t border-sarin-line pt-5 text-xs leading-6 text-sarin-muted">Tu agenda, tus servicios y tu forma de atender. Todo en un mismo espacio.</p>
          <BrandCredits />
        </section>
      </main>
    );
  if (admin && !isSuperadmin)
    return (
      <main className="min-h-screen grid place-items-center bg-sarin-canvas p-6 text-sarin-ink">
        <section className="w-full max-w-md space-y-4 rounded-2xl border border-sarin-line bg-sarin-paper p-6">
          <h1 className="text-2xl font-bold">Acceso restringido</h1>
          <p className="text-sarin-muted">
            Esta sección está reservada para el administrador.
          </p>
          {error && (
            <p role="alert" className="text-rose-800">
              {error}
            </p>
          )}
          <button
            className="min-h-11 text-sarin-blue underline"
            onClick={() => void signOut()}
          >
            Cambiar de cuenta
          </button>
        </section>
      </main>
    );
  return <>{children}</>;
}
