"use client";
import { useEffect, useRef, useState } from 'react';
import { useAuth } from '@/components/auth-provider';
import { apiFetch, errorMessage } from '@/lib/client/api';
import { clientWaitlistOfferCurrentSchema, clientWaitlistOfferRecoverySchema, waitlistOfferCloseResultSchema, waitlistOfferConfirmationSchema, type ClientWaitlistOfferRecovery, type WaitlistOfferBookingProof } from '@/lib/waitlist-offers';
export type ClientWaitlistOfferInput = { businessId: string; userId: string; authEpoch: number; enabled: boolean; acquireAction: () => false | (() => void); onConfirmed: (appointmentId: string) => void };
type State = { recovery: ClientWaitlistOfferRecovery | null; loading: boolean; busy: boolean; uncertain: boolean; error: string | null; notice: string | null; checked: boolean };
const blank = (): State => ({ recovery: null, loading: false, busy: false, uncertain: false, error: null, notice: null, checked: false });
function runtime(key: string) {
  return { key, mounted: false, state: blank(), release: null as (() => void) | null, read: null as (() => void) | null,
    primary: null as AbortController | null, closing: null as AbortController | null, mutations: new Set<() => void>(), generation: 0,
    proposalBody: null as string | null, confirmBody: null as string | null, notified: new Set<string>() };
}
export function useClientWaitlistOffer(input: ClientWaitlistOfferInput) {
  const auth = useAuth(), key = JSON.stringify([input.businessId, input.userId, input.authEpoch, input.enabled, auth.user?.uid, auth.authEpoch]);
  const active = useRef(runtime(key));
  if (active.current.key !== key) active.current = runtime(key);
  const r = active.current, current = useRef({ input, auth }); current.current = { input, auth };
  const [, render] = useState(0);
  const valid = () => active.current === r && r.mounted && current.current.input.enabled
    && current.current.auth.user?.uid === input.userId && current.current.auth.authEpoch === input.authEpoch
    && current.current.auth.isCurrentSession(input.userId, input.authEpoch);
  function patch(value: Partial<State>) { if (valid()) { r.state = { ...r.state, ...value }; render(value => value + 1); } }
  function release() { const own = r.release; r.release = null; own?.(); }
  function acquire() { if (r.release) return true; const own = current.current.input.acquireAction(); if (!own) return false; r.release = own; return true; }
  function scope(value: { businessId: string; viewerUid: string }) {
    if (value.businessId !== input.businessId || value.viewerUid !== input.userId) throw Error('No pudimos verificar el ámbito de la oferta.');
  }
  const base = `/api/businesses/${encodeURIComponent(input.businessId)}/waitlist`;
  function verify(raw: unknown, offerId?: string) {
    const value = clientWaitlistOfferRecoverySchema.parse(raw); scope(value);
    if (offerId && value.offer.id !== offerId) throw Error('La respuesta corresponde a otra oferta.');
    const previous = r.state.recovery?.offer;
    if (previous?.id === value.offer.id) {
      const { persistedState: _previousState, ...before } = previous, { persistedState: _nextState, ...after } = value.offer;
      if (JSON.stringify(before) !== JSON.stringify(after)) throw Error('Los datos de la oferta cambiaron. No pudimos verificar el resultado.');
      if (value.proof && !proofMatches(value.proof, r.state.recovery!)) throw Error('El comprobante no corresponde a la propuesta que revisaste.');
    }
    if (value.appointment && value.appointment.type !== 'appointment') throw Error('No pudimos verificar la cita de esta oferta.');
    return value;
  }
  function proofMatches(proof: WaitlistOfferBookingProof, recovery: ClientWaitlistOfferRecovery) {
    const { offer, proposal } = recovery, t = offer.target, p = proof.source;
    return proof.entryId === offer.entryId && (!proposal || proof.proposalId === proposal.proposal.id)
      && proof.confirmedAt >= offer.createdAt && proof.confirmedAt < offer.expiresAt
      && p.dateKey === t.dateKey && p.resourceId === t.resourceId && p.serviceId === t.serviceId
      && p.startAt === t.startAt && p.endAt === t.endAt && p.reservedUntilAt === t.reservedUntilAt;
  }
  function accept(value: ClientWaitlistOfferRecovery) {
    const previous = r.state.recovery;
    if (previous && previous.offer.id !== value.offer.id && (r.confirmBody || r.primary)) throw Error('Primero comprueba el resultado de la oferta que estabas revisando.');
    if (previous?.offer.id === value.offer.id && previous.offer.persistedState !== 'offered') {
      patch({ ...(previous.offer.persistedState === 'booked' && value.offer.persistedState === 'booked' ? { recovery: value } : {}), loading: false }); release();
      return;
    }
    if (value.offer.persistedState !== 'offered') {
      r.generation++; r.confirmBody = null; r.proposalBody = null;
      r.primary = null; r.closing = null;
      patch({ recovery: value, busy: false, uncertain: false, loading: false, error: null, checked: true }); release();
      if (value.proof && !r.notified.has(value.offer.id)) { r.notified.add(value.offer.id); current.current.input.onConfirmed(value.proof.appointmentId); }
    } else {
      const recoveredProposal = r.proposalBody !== null && value.proposal !== null && r.confirmBody === null;
      if (recoveredProposal) r.proposalBody = null;
      patch({ recovery: value, loading: false, checked: true, ...(recoveredProposal ? { uncertain: false, error: null } : {}) });
    }
  }
  useEffect(() => {
    r.mounted = true;
    return () => { r.mounted = false; r.read?.(); r.read = null; for (const cancel of r.mutations) cancel(); r.mutations.clear(); release(); };
  }, [r]);
  async function read(detail: boolean) {
    if (!valid() || !acquire()) return;
    r.read?.(); const abort = new AbortController(); let reject!: (error: Error) => void;
    const canceled = new Promise<never>((_, no) => { reject = no; });
    const cancel = () => { abort.abort(); reject(Error('La consulta superó el tiempo de espera. Inténtalo de nuevo.')); };
    r.read = cancel; const owns = () => valid() && r.read === cancel;
    patch({ loading: true, error: null }); const timer = setTimeout(cancel, 10000);
    const id = r.state.recovery?.offer.id;
    try {
      const raw = await Promise.race([apiFetch<unknown>(detail && id ? `${base}/offers/${encodeURIComponent(id)}` : `${base}/offer`, { signal: abort.signal }, input.userId, owns), canceled]);
      if (!owns() || abort.signal.aborted) return;
      if (detail && id) accept(verify(raw, id));
      else {
        const value = clientWaitlistOfferCurrentSchema.parse(raw); scope(value);
        if (value.current) accept(verify(value.current));
        else { patch({ loading: false, checked: true, ...(r.confirmBody || r.primary ? {} : { recovery: null }) }); if (!r.confirmBody && !r.primary) release(); }
      }
    } catch (cause) { if (owns()) { patch({ loading: false, error: errorMessage(cause) }); if (!r.state.recovery && !r.confirmBody && !r.primary) release(); } }
    finally { clearTimeout(timer); if (r.read === cancel) r.read = null; }
  }
  async function post(kind: 'proposal' | 'confirm' | 'decline' | 'close-expired', body: string) {
    const recovery = r.state.recovery;
    if (!valid() || !recovery || recovery.offer.persistedState !== 'offered' || !acquire()) return;
    const close = kind === 'decline' || kind === 'close-expired';
    if (close ? r.closing : r.primary || r.closing) return;
    const abort = new AbortController(), generation = r.generation, id = recovery.offer.id;
    if (close) r.closing = abort; else r.primary = abort;
    let reject!: (error: Error) => void;
    const canceled = new Promise<never>((_, no) => { reject = no; });
    const cancel = () => { abort.abort(); reject(Error('La cuenta o el negocio cambiaron.')); }; r.mutations.add(cancel);
    const owns = () => valid() && r.generation === generation && r.state.recovery?.offer.id === id && !abort.signal.aborted;
    patch({ busy: true, uncertain: kind === 'confirm' || r.state.uncertain, error: null, notice: null });
    const timer = setTimeout(() => { if (owns()) patch({ notice: 'La operación está demorando. Comprueba el resultado antes de iniciar otra reserva.' }); }, 20000);
    try {
      const raw = await Promise.race([apiFetch<unknown>(`${base}/offers/${encodeURIComponent(id)}/${kind}`, { method: 'POST', body, signal: abort.signal }, input.userId, owns), canceled]);
      if (!owns()) return;
      if (kind === 'confirm') {
        const value = waitlistOfferConfirmationSchema.parse(raw);
        if (!proofMatches(value.proof, recovery) || value.appointment.tenantId !== input.businessId || value.appointment.client?.uid !== input.userId || value.appointment.type !== 'appointment') throw Error('No pudimos verificar la confirmación. Comprueba el resultado.');
        accept(verify({ ...recovery, serverNow: Math.max(recovery.serverNow, value.proof.confirmedAt), offer: { ...recovery.offer, persistedState: 'booked' }, usability: null, proof: value.proof, appointment: value.appointment }, id));
      } else if (kind === 'close-expired') {
        const value = waitlistOfferCloseResultSchema.parse(raw); scope(value);
        if (value.offerId !== id || value.persistedState === 'offered' || value.proof && !proofMatches(value.proof, recovery)) throw Error('No pudimos verificar el cierre de esta oferta.');
        if (value.persistedState === 'booked') await read(true);
        else accept(verify({ ...recovery, offer: { ...recovery.offer, persistedState: value.persistedState }, usability: null, proof: null, appointment: null }, id));
      } else {
        const value = verify(raw, id);
        if (kind === 'decline' && value.offer.persistedState === 'offered') throw Error('No pudimos verificar el rechazo de la oferta.');
        if (kind === 'proposal' && value.offer.persistedState === 'offered' && !value.proposal) throw Error('No pudimos verificar la propuesta de esta oferta.');
        accept(value);
        if (kind === 'proposal') r.proposalBody = null;
      }
    } catch (cause) { if (owns()) patch({ error: errorMessage(cause), uncertain: true }); }
    finally {
      clearTimeout(timer); r.mutations.delete(cancel);
      if (close && r.closing === abort) r.closing = null;
      if (!close && r.primary === abort) r.primary = null;
      if (owns()) patch({ busy: Boolean(r.primary || r.closing) });
    }
  }
  async function review() {
    if (!valid() || r.confirmBody || r.primary || r.closing || !r.state.recovery?.writesEnabled || r.state.recovery.usability !== 'ready') return;
    r.proposalBody ??= JSON.stringify({ requestId: crypto.randomUUID() });
    await post('proposal', r.proposalBody);
  }
  async function confirm(id: string, contact: { clientPhone: string; intakeAnswers: Record<string, string> }) {
    const recovery = r.state.recovery;
    if (!valid() || r.primary || r.closing || !recovery?.proposal || recovery.proposal.proposal.id !== id || recovery.offer.persistedState !== 'offered') return;
    if (!r.confirmBody && (!recovery.writesEnabled || recovery.usability !== 'ready')) return;
    r.confirmBody ??= JSON.stringify({ confirm: true, clientPhone: contact.clientPhone, intakeAnswers: contact.intakeAnswers });
    await post('confirm', r.confirmBody);
  }
  function dismiss() {
    if (!valid() || r.primary || r.closing || r.confirmBody || r.state.uncertain) return;
    r.read?.(); r.read = null; patch({ ...blank(), checked: true }); release();
  }
  const observedOfferId = r.state.recovery?.offer.id;
  const sameOffer = () => valid() && r.state.recovery?.offer.id === observedOfferId;
  return { ...r.state, check: () => read(false), recover: () => sameOffer() ? read(true) : Promise.resolve(),
    review: () => sameOffer() ? review() : Promise.resolve(), confirm: (id: string, contact: { clientPhone: string; intakeAnswers: Record<string, string> }) => sameOffer() ? confirm(id, contact) : Promise.resolve(),
    decline: () => sameOffer() ? post('decline', JSON.stringify({ decline: true })) : Promise.resolve(), closeExpired: () => sameOffer() ? post('close-expired', JSON.stringify({ closeExpired: true })) : Promise.resolve(), dismiss: () => { if (sameOffer()) dismiss(); } };
}
export type ClientWaitlistOfferController = ReturnType<typeof useClientWaitlistOffer>;
