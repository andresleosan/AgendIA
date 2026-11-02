"use client";

import { useState } from 'react';
import { Send } from 'lucide-react';
import { buttonClass, fieldClass, Notice } from '@/components/app-shell';
import { SarinMark } from '@/components/sarin-brand';
import { ResponseQuotaNotice } from '@/components/response-quota';
import { ConfigurationDifferences } from '@/components/owner-configuration-workspace';
import { useDebouncedChat } from '@/hooks/useDebouncedChat';
import { configurationDifferences, configurationFingerprint, mergeOwnerConfigurationProposal } from '@/lib/owner-configuration';
import { isSubscriptionAllowed } from '@/lib/sarin/subscription';
import type { BusinessConfig } from '@/lib/server/schemas';
import type { Business } from '@/types/firestore';

export function ConfigurationAssistant({ uid, business, enabled, draft, busy, onDraft }: { uid: string; business: Business; enabled: boolean; draft: BusinessConfig; busy: boolean; onDraft: (draft: BusinessConfig) => void }) {
  const chat = useDebouncedChat({ actorUid: uid, enabled, mode: 'sarin_onboarding', tenantId: business.id });
  const [input, setInput] = useState('');
  const [preview, setPreview] = useState<{ baseline: string; proposal: string; next: BusinessConfig } | null>(null);
  const [changedSinceReview, setChangedSinceReview] = useState(false);
  const prepareReview = () => {
    if (!chat.configurationDraft || busy || !enabled) return;
    setPreview({ baseline: configurationFingerprint(draft), proposal: configurationFingerprint(chat.configurationDraft), next: mergeOwnerConfigurationProposal(draft, chat.configurationDraft, business.sarinConfig.onboardingCompleted ? business.slug : null) });
  };
  const apply = () => {
    if (!preview || !chat.configurationDraft || busy || !enabled) return;
    if (preview.baseline !== configurationFingerprint(draft) || preview.proposal !== configurationFingerprint(chat.configurationDraft)) { prepareReview(); setChangedSinceReview(true); return; }
    onDraft(preview.next); setPreview(null); setChangedSinceReview(false);
  };
  return <section className="min-w-0 space-y-4 rounded-2xl border border-sarin-line bg-sarin-paper p-4" aria-label="Preparar configuración con Sarin">
    <h2 className="flex items-center gap-2 text-lg font-semibold"><SarinMark className="h-8 w-8" />Preparar con Sarin</h2>
    <p className="text-sm text-sarin-muted">Describe tus servicios, precios, personas o estaciones y horarios. Sarin prepara una propuesta que puedes revisar y copiar al borrador. Después debes guardar la configuración.</p>
    <ResponseQuotaNotice />
    <div aria-live="polite" className="max-h-[28rem] space-y-3 overflow-auto">{chat.messages.map(message => <p key={message.id} className={`whitespace-pre-wrap break-words rounded-xl p-3 text-sm ${message.role === 'user' ? 'bg-sarin-soft' : 'bg-sarin-canvas'}`}>{message.content}</p>)}{(chat.isGenerating || chat.isWaitingBatch) && <p role="status">Sarin está preparando tu configuración…</p>}{chat.error && <div className="space-y-2"><Notice error={!chat.requestAlreadyCompleted}>{chat.error}</Notice>{!chat.requestAlreadyCompleted && <button type="button" className={buttonClass} onClick={chat.retry} disabled={!enabled || chat.isGenerating}>{chat.quotaExhausted ? 'Comprobar disponibilidad' : 'Reintentar mensaje'}</button>}</div>}</div>
    {chat.configurationDraft && <button type="button" className={buttonClass} disabled={!enabled || busy || chat.isGenerating} onClick={() => { prepareReview(); setChangedSinceReview(false); }}>Revisar propuesta</button>}
    {preview && <section className="space-y-3" aria-label="Revisión de propuesta"><h3 className="font-semibold">Revisa los cambios propuestos</h3><p className="text-sm text-sarin-muted">Usar la propuesta solo cambia el borrador; todavía no publica tus datos.</p>{changedSinceReview && <p role="alert">El borrador cambió desde la revisión. Revisa las diferencias actualizadas antes de usar la propuesta.</p>}<ConfigurationDifferences differences={configurationDifferences(draft, preview.next)} /><button type="button" className={buttonClass} disabled={!enabled || busy || chat.isGenerating} onClick={apply}>Usar propuesta en el borrador</button></section>}
    <form aria-label="Conversación de configuración" onSubmit={event => { event.preventDefault(); if (enabled && input.trim() && !chat.quotaExhausted && isSubscriptionAllowed(business)) { chat.sendMessage(input); setInput(''); } }} className="flex gap-2"><input aria-label="Mensaje para SarinBot" className={fieldClass} maxLength={8000} value={input} onChange={event => setInput(event.target.value)} disabled={!enabled || chat.quotaExhausted} placeholder="Cuéntale cómo trabajas…" /><button type="submit" aria-label="Enviar mensaje" className={buttonClass} disabled={!enabled || !input.trim() || chat.quotaExhausted || (Boolean(chat.error) && !chat.requestAlreadyCompleted)}><Send className="h-4 w-4" /></button></form>
  </section>;
}
