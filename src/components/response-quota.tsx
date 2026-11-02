import type { ResponseAllowance } from "@/types/firestore";

const number = (value: number) => value.toLocaleString("es-CO");
export function ResponseQuotaNotice() {
  return <p className="text-xs leading-4 text-sarin-muted">Una respuesta de IA ya iniciada puede consumir una respuesta del plan aunque no llegue a mostrarse.</p>;
}
export const quotaDate = (value: number) => new Date(value).toLocaleDateString("es-CO", { timeZone: "America/Bogota" });

export function ResponseQuota({ allowance, compact = false, introductorySource }: { allowance: ResponseAllowance | null | undefined; compact?: boolean; introductorySource?: 'payment' | 'invitation' }) {
  const trialLabel = introductorySource === 'invitation' ? 'Prueba de cortesía' : 'Prueba pagada';
  const period = allowance?.currentPeriod;
  if (!period) return <p className="text-sm text-sarin-muted">{allowance ? "No hay una bolsa de respuestas vigente." : "Consumo no disponible. Actualiza para consultar tu vigencia."}</p>;
  const capacity = period.includedResponses + period.extraResponses;
  const percent = capacity > 0 ? Math.min(100, Math.floor(period.usedResponses / capacity * 100)) : 0;
  const trialEnded = period.source === "trial" && allowance.state === "expired";
  const label = trialEnded ? "Prueba finalizada" : allowance.state === "exhausted" ? "Agotada" : allowance.state === "warning" ? "Uso alto" : allowance.state === "expired" ? "Vencida" : allowance.state === "suspended" ? "Suspendida" : "Disponible";
  if (compact) return (
    <div className="min-w-44 space-y-0.5 text-xs">
      <p className="font-medium text-sarin-ink">{number(period.usedResponses)} de {number(capacity)} respuestas · {label}</p>
      <p className="text-sarin-muted">{number(period.remainingResponses)} {trialEnded ? "sin utilizar" : "disponibles"} · {period.source === "trial" ? `${trialLabel.toLowerCase()} sin caducidad` : `hasta ${quotaDate(period.endsAt)}`}</p>
      {allowance.nextPeriod && <p className="text-sarin-muted">Renovación desde {quotaDate(allowance.nextPeriod.startsAt)}</p>}
    </div>
  );
  return (
    <section aria-label="Respuestas de IA" className="space-y-2 rounded-2xl border border-sarin-line bg-sarin-paper p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="font-semibold">Respuestas de IA</h2>
          <p className="mt-1 text-xs text-sarin-muted">{period.source === "trial" ? `${trialLabel} · límite total independiente de tus 10 citas · sin caducidad` : `Vigencia actual · ${quotaDate(period.startsAt)}–${quotaDate(period.endsAt)}`}</p>
        </div>
        <span className={`text-xs font-semibold ${allowance.state === "warning" || allowance.state === "exhausted" ? "text-amber-800" : "text-sarin-blue"}`}>{label}</span>
      </div>
      <p className="text-lg font-semibold tabular-nums">{number(period.remainingResponses)} respuestas {trialEnded ? "sin utilizar" : "disponibles"}</p>
      <div role="progressbar" aria-label="Respuestas utilizadas" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-valuetext={`${number(period.usedResponses)} de ${number(capacity)} respuestas utilizadas`} className="h-2 overflow-hidden rounded-full bg-sarin-canvas">
        <div className={`h-full ${allowance.state === "warning" || allowance.state === "exhausted" ? "bg-amber-600" : "bg-sarin-blue"}`} style={{ width: `${percent}%` }} />
      </div>
      <p className="text-sm text-sarin-muted">{number(period.usedResponses)} de {number(capacity)} utilizadas · {number(period.includedResponses)} incluidas{period.extraResponses > 0 ? ` + ${number(period.extraResponses)} adicionales` : ""}.</p>
      {period.reservedResponses > 0 && <p className="text-xs text-sarin-muted">{number(period.reservedResponses)} respuestas reservadas o pendientes de confirmación, ya descontadas de las disponibles.</p>}
      {allowance.state === "warning" && <p role="status" className="text-sm text-amber-800">Has alcanzado el 80% de tu capacidad. {period.source === "trial" ? "Elige un plan para continuar cuando se agote." : "Puedes ampliar antes de agotarla."}</p>}
      {allowance.state === "exhausted" && <p role="status" className="text-sm text-amber-800">La atención de IA está pausada: no quedan respuestas disponibles. Tu agenda sigue disponible.</p>}
      {allowance.state === "expired" && <p className="text-sm text-sarin-muted">{trialEnded ? "Las respuestas sin utilizar no amplían las 10 citas de la prueba. Elige un plan para continuar." : "Esta vigencia terminó. Revisa las opciones de renovación."}</p>}
      {allowance.state === "suspended" && <p className="text-sm text-sarin-muted">La suscripción está suspendida. Contacta al administrador.</p>}
      <p className="text-xs leading-4 text-sarin-muted">{period.source === "trial" ? "La configuración y la atención al cliente comparten este límite total de respuestas. Las ampliaciones requieren un plan vigente." : "La configuración asistida y la atención al cliente utilizan esta bolsa."} Cada intento iniciado cuenta una vez; tus mensajes no son respuestas adicionales.</p>
      <ResponseQuotaNotice />
      {allowance.nextPeriod && <p className="border-t border-sarin-line pt-2 text-sm text-sarin-muted">Renovación programada: {number(allowance.nextPeriod.includedResponses + allowance.nextPeriod.extraResponses)} respuestas del {quotaDate(allowance.nextPeriod.startsAt)} al {quotaDate(allowance.nextPeriod.endsAt)}.</p>}
    </section>
  );
}
