# Recuperación de cuota de respuestas — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Una tarea por invocación de avanzar; tasks.json conserva el estado, los checkboxes no constituyen otra autoridad.

**Goal:** Construir recuperación durable de intentos comerciales sin segunda inferencia incierta, doble consumo o devolución sin prueba de no despacho.

**Architecture:** Un modelo puro compartido decide transiciones y liquidación; los adaptadores D1/Firestore aplican sus escrituras atómicamente. Legacy añade cercas en las transacciones de resultado y publicación; S03 reutiliza el mismo modelo cuando se construya, con sus propias cercas de hilo. La recuperación y la conciliación operan sobre metadatos técnicos, sin transcript ni acceso al proveedor.

**Tech Stack:** Node 24.22.1, pnpm 11.23.0, TypeScript estricto, Next App Router, Zod, Vitest, Firebase Admin/emulador Java 21+, Worker/Miniflare/D1 existentes. Sin dependencias nuevas.

**Spec:** [Contrato aprobado R0-QUOTA-D](../specs/2026-10-30-response-quota-recovery-design.md), SHA-256 `b7d9192b7b351e60689b8c592b8a92c32e9baca497ede5a27214a2b2e74c90ad`. Aprobación del propietario: «si aprobado», después de Q1/Q2. Verificar este hash antes de cada hijo. Este subplan requiere revisión del propietario antes de ejecutar sus hijos; no hereda aprobación del documento de diseño.

## Global Constraints

- Control: `E:/Proyectos/Sarin Bot`; código: `E:/Proyectos/SarinBot-worktrees/fresha-implementation-20261030`. Mantener el checkout mixto y el único tasks.json del control. Base `889017457801759e44835b723d8e0c26aa3e6baa` más overlay R0-001/D1/REUSE, no un SHA publicado de los cambios locales.
- Una réplica y cola proceso-local; solo alsdevstudio.com para el motor. Proveedores simulados y datos demo-* en comprobaciones.
- Q1: consumir una unidad si pudo iniciarse, aunque no se muestre respuesta. Solo liberar con no despacho demostrado y ejecutor cercado. Cuota comercial y gasto operativo no se concilian mutuamente.
- Q2: solo superadministrador con decisión auditada. No cobrar retroactivamente released antiguos; no reintentar el mismo requestId legacy sin prueba. Nunca liberar por edad, error HTTP, falta de usage o petición del navegador.
- Conservar identidad/fingerprint onboarding y legacy, scopeId/periodId/attemptId, pruebas de propuesta/cita y estados posteriores. No introducir cuerpos en cuota/recibos/logs.
- Sin implementación en esta tarea P. Las pruebas RED/GREEN siguientes son contratos futuros, no resultados observados. Despliegue, corte de escritor, activación del protocolo y ajustes reales requieren sus tareas RELEASE y aprobación de sus efectos concretos.
- No campaña Playwright antes de BUILD-FREEZE. Para el aviso reutilizar DESIGN.md, copy aprobado y componentes existentes; no inventar un panel administrativo ni rediseñar chat.

## Review Focus

1. ACK de la marca que confirma en almacenamiento pero termina con error para el ejecutor: nunca habilita HTTP al releer. Prueba `markerAckLostNeverDispatches` en B3.
2. Proveedor lento que vuelve tras conciliación/cierre: no crea propuesta, estado, cache ni outbox. Ambos órdenes de carrera en `closeWinsAgainstLateEffects` / `effectWinsRetainsProof`, B4.
3. released histórico de un motor que sí pudo ejecutar: no cobrarlo ni volver a inferir al repetir su requestId, aun después de drenar la réplica. `legacyReleasedIsFrozenWithoutRetrocharge`, B2/B4.
4. Respuesta completa sin entrega visible y sin usage durable: consumir una sola unidad sin afirmar entrega o cobro del proveedor. `invalidOrUnpublishedResultStillConsumesOne`, B4.
5. Más de 1000 pendientes, empates de fecha e inserciones durante barrido: recorrido acotado sin truncamiento oculto ni starvation de casos nuevos. `recoveryScans1001WithTiesAndRestart`, B5/I.

## Mapa de archivos y responsabilidades

| Unidad | Archivos de código | Responsabilidad |
| --- | --- | --- |
| B1 | Crear `shared/response-quota-records.ts`, `shared/response-quota-settlement.ts`; modificar `src/lib/server/response-periods.ts` | Esquemas, identidad técnica de reserva, períodos puros, recibo terminal y decisión sin I/O. Reexportar parser/tipo por ruta histórica. |
| B2 | Crear `src/lib/server/response-quota-store.ts`, `cloudflare/migrations/0014_response_quota_recovery.sql`; modificar `src/lib/server/response-quota.ts`, `shared/data-protocol.ts`, `cloudflare/src/data.ts`, `firestore.indexes.json` | Reserva/lectura, CAS de ejecución, staging de resultado/liquidación, protocolos y validación Worker. |
| B3 | Modificar `src/lib/sarin/engine.ts`, `src/lib/server/chat-intent.ts` | beforeDispatch separado, callId operativo vinculado y permiso de transporte único. |
| B4 | Modificar `src/lib/server/chat.ts`, `chat-state.ts`, `booking-proposals.ts`, `whatsapp-store.ts`, `whatsapp-worker.ts`, `src/types/chat.ts`, `src/components/response-quota.tsx`, `src/components/configuration-assistant.tsx`, `src/app/b/[slug]/page.tsx` | Integración legacy de ejecución/efectos/entrega, errores técnicos honestos y aviso de consumo. |
| B5 | Crear `shared/response-quota-recovery.ts`, `src/lib/server/response-quota-recovery.ts`, `src/lib/server/response-quota-admin.ts`, `src/app/api/admin/response-quota/route.ts`, `cloudflare/src/response-quota-recovery.ts`; modificar `cloudflare/src/index.ts` | Decisión de recuperación compartida, barrido acotado, consulta/conciliación superadmin y cron técnico sin motor. |
| I | Crear `tests/response-quota-recovery.integration.test.ts`, `tests/response-quota-recovery-firestore.test.ts`, `docs/qa/2026-10-30-response-quota-recovery.md`, `docs/runbooks/response-quota-recovery.md`; modificar `tests/data-migration.test.ts`, `tests/firestore.rules.test.ts`, `scripts/firestore-emulator-tests.mjs` | Integración/restauración/rollback, reglas reales y runbook de corte para RELEASE. |

`0012_external_appointment_reminders.sql` y `0013_business_inbox.sql` están reservados por contratos previos aún no construidos. Se reserva **0014** para estos índices independientes sobre app_documents, sin renumerar archivos aplicados o futuros. Los helpers locales cargan migraciones por nombre; D1 registra migraciones versionadas ([documentación oficial](https://developers.cloudflare.com/d1/reference/migrations/)). No ejecutar migraciones remotas aquí. Probar base 0001–0011 + 0014 y, al integrar después R1, el conjunto con 0012/0013; 0014 no depende de sus colecciones.

## Interfaces comunes fijadas por este subplan

Los tipos siguientes residen en `shared/response-quota-records.ts`; usar sus exports, sin redefinirlos en Node/Worker/S03:

```ts
type ResponseQuotaReservation = { reservationId: string; scopeId: string; periodId: string; attemptId: string };
type QuotaIdentity = { quotaTurnId: string; expectedFingerprint: string; expectedScopeId: string; reservation: ResponseQuotaReservation | null };
type QuotaResultRef = { kind: 'proposal' | 'appointment' | 'chat_state' | 'whatsapp_outbox' | 'inbox_operation'; id: string };
type QuotaExecution = { protocol: 2; origin: 'v2' | 'legacy_unknown'; phase: 'prepared' | 'may_have_dispatched' | 'result_recorded' | 'interrupted'; mayHaveDispatched: boolean; fenceRevision: number; deadlineAt: number; providerCallId: string | null; result: QuotaResultRef | null };
type QuotaStage = { state: 'none' | 'pending' | 'committed' | 'released'; writes: readonly { op: 'set' | 'create'; path: string; data: Record<string, unknown> }[] };
type QuotaEvidence = { kind: 'prepared_fenced'; expectedFenceRevision: number } | { kind: 'dispatch_possible' } | { kind: 'application_proof'; result: QuotaResultRef } | { kind: 'legacy_admin'; reviewId: string };
```

Los documentos v2 conservan los campos actuales, añaden `execution`, `nextAttemptAt` y resultado técnico enumerado `recoverable | receipt_only | suppressed | failed | unknown`. Un registro sin execution es legacy_unknown, no prepared. Cada intento tiene recibo terminal inmutable `responseQuotaReceipts/{sha256([reservationId,attemptId])}` con identidad/fingerprint, decisión/fundamento, fecha, fases y origen. No guardar textos ni selección de herramientas. La auditoría no terminal de `keep_pending` usa `responseQuotaTurns/{id}/reviews/{sha256([attemptId,adminRequestId])}`, con decisión, administrador opaco, motivo≤300 y digest SHA-256 de evidencia; no constituye otro contador.

Al descubrir un reserved v1, el nuevo adaptador puede añadir execution con origin=legacy_unknown, phase=interrupted, mayHaveDispatched=true conservador y nextAttemptAt=Number.MAX_SAFE_INTEGER, sin tocar counters ni afirmar despacho demostrado. Ese origen sigue necesitando prueba de aplicación o revisión administrativa: el barrido nunca lo consume automáticamente por encontrar el bool verdadero. La promoción terminal legacy también conserva origin=legacy_unknown en su recibo. Worker admite esta escritura v2 validada; la prohibición de escritura v1 no impide conservar o conciliar datos heredados.

`serverSettings/responseQuotaProtocol` es el marcador operativo privado `{version:2,minimumWriterProtocol:2,sourceSha:string,oldWriterStoppedAt:number,reviewArtifactSha256:string}`. No se crea automáticamente. Antes del corte, el nuevo código permite lecturas/recuperación y rechaza iniciar nuevos intentos v2 con `AI_QUOTA_PROTOCOL_NOT_READY`/503; no deriva ejecución de una fila v1 released. Tras el corte, Worker rechaza escrituras legacy de cuota; Node exige el mismo marcador en la reserva. El marcador documenta el corte, no detiene físicamente un proceso: RELEASE debe comprobar que el escritor anterior está parado antes de crearlo. D1 y Firestore prueban este gate; rollback soportado conserva lectores/escritores v2.

El lector `readResponseQuotaReservation(input, db?)` devuelve estado validado, reserva y metadatos técnicos; nunca reserva. `readQuotaIdentity(tx, db, identity)` valida ID/fingerprint/scope y adopta attempt/period solo si reservation era null; una identidad completa nunca adopta otro intento.

El plan puro compartido conserva el nombre de S03:

```ts
planResponseQuotaSettlement(input: { turn: unknown; period: unknown; receipt: unknown; reservation: ResponseQuotaReservation; completion: boolean; evidence: QuotaEvidence; now: number }): { turn: Record<string, unknown>; period: StoredResponsePeriod; receipt: Record<string, unknown> } | null;
```

`null` solo significa terminal compatible ya confirmado. Mismo intento con decisión/fingerprint/periodo distinto es conflicto; recibo/counter corrupto es error 503. `completion:false` está prohibido si mayHaveDispatched; `legacy_admin` solo permite consume/keep_pending, nunca convierte texto administrativo en prueba de no despacho. No eliminar campos legacy al liquidar; si no pueden validarse, fallar sin reescribirlos.

En `response-quota-store.ts` fijar:

- `markResponseQuotaDispatch(reservation, expectedFingerprint, context:{providerCallId:string|null}, db?):Promise<'dispatch_allowed'|'already_marked'>`; solo la transición confirmada de esta invocación permite HTTP, nunca una lectura posterior o un replay. Releer deadline, estado e intento con reloj final después de las lecturas; origin legacy_unknown nunca gana el permiso.
- `prepareResponseQuotaSettlement(tx, db, identity, completion, evidence, now):Promise<QuotaStage>` y `applyResponseQuotaStage(tx,db,stage):void`. Preparación realiza todas las lecturas; apply no lee ni abre otra transacción. `none` exige ausencia confirmada en la misma transacción que cerca al consumidor; una lectura absent aislada produce pending, no none.
- `prepareQuotaResult(tx,db,identity,result,now):Promise<QuotaStage>` valida intento y cerca antes de escribir el resultado; primera prueba durable se conserva. `assertQuotaPublication(identity,kind:'initial'|'replay',db?):Promise<void>` permite replay autorizado de resultado ganado; initial exige deadline vigente y cerca abierta. Nunca revive interrupted.
- `QuotaEffectHooks={prepare:(tx:Transaction,result:QuotaResultRef)=>Promise<()=>void>}`: callback de servidor que prepara el guard y devuelve solo staging. Añadirlo como último argumento opcional a createBookingProposal (octavo) y saveChatState (sexto), sin alterar sus argumentos actuales ni permitir recibirlo desde HTTP.

Errores públicos mínimos: `AI_REQUEST_CONFLICT`/409, `AI_RESPONSE_PENDING`/409, `AI_RESPONSE_INTERRUPTED`/409, `REQUEST_ALREADY_COMPLETED`/409, `AI_QUOTA_PROTOCOL_NOT_READY`/503. No incluir tokens/periodos internos o detalles de proveedor en el mensaje de error. La recuperación estructurada de citas/propuestas mantiene sus rutas y permisos.

---

<a id="r0-quota-b1"></a>
### Task 1 — R0-QUOTA-B1: modelo puro y recibos

**Files:** primera fila del mapa; crear `tests/response-quota-model.test.ts`. **Depends:** R0-QUOTA-P.

**Interfaces:** produce tipos/esquemas anteriores y planResponseQuotaSettlement; mueve SOLO StoredResponsePeriod/parseResponsePeriod al shared y reexporta en response-periods. Errores puros llevan status/code, sin importar getAdminDb, process.env ni módulos server-only en shared.

- [ ] Escribir casos `sameAttemptSettlesOnce` (reserved 1→0, used 0→1; replay null), `changedAttemptOrFingerprintConflicts`, `preparedReleaseRequiresFence`, `dispatchCannotRelease` (true + completion:false falla), `terminalDecisionCannotFlip`, `periodCorruptionNeverBecomesZero`, `receiptHasNoConversationFields`, `legacyMissingPhaseIsUnknown`. Usar valores literales y tablas de turnos, no calcular expected con el mismo plan.

```ts
expect(result.period).toMatchObject({ reservedResponses: 0, usedResponses: 1 });
expect(result.receipt).toMatchObject({ decision: 'completed' });
expect(replayedSettlement).toBeNull();
```
- [ ] RED: `pnpm exec vitest run tests/response-quota-model.test.ts`; esperado fallo por exports/modelo ausentes, no por infraestructura.
- [ ] Implementar esquemas strict v2/recibo/review, parser legacy explícito, fundamentos `undispatched_fenced | dispatch_possible | application_proof | legacy_admin_consume` y transiciones con contadores seguros. Conservar los valores de período originales y ausencia de contenido; incluir el receipt existente en la decisión de replay.
- [ ] GREEN: mismo comando y `pnpm exec vitest run tests/response-quota.test.ts tests/billing.test.ts tests/billing-paid-trial.test.ts`; esperado exit 0 sin omisiones focales. El cambio de ubicación del parser no cambia cuotas/planes.
- [ ] Revisar diff y guardar evidencia; commit focal `feat: model durable response quota settlement` cuando el trabajo de esta tarea esté verificado. No añadir otros archivos del overlay previo.

<a id="r0-quota-b2"></a>
### Task 2 — R0-QUOTA-B2: persistencia transaccional y protocolo

**Files:** segunda fila del mapa; crear `tests/response-quota-store.test.ts`, `tests/response-quota-d1.test.ts`, `cloudflare/tests/response-quota-data.test.mjs`; ampliar `tests/response-quota.test.ts`, `tests/cloudflare-data.integration.test.ts`, `tests/firestore.integration.test.ts`. **Depends:** B1.

**Interfaces:** produce los helpers de store anteriores, reserva v2 y lector técnico. Los wrappers commit/release siguen existiendo pero usan el plan puro; ninguna ruta pública obtiene un permiso de dispatch al leer una reserva. La reserva v2 toma deadlineAt del consumidor y valida el marcador dentro de la misma transacción. Las pruebas existentes que siembran reservas directamente deben marcar despacho o proporcionar prueba prepared explícita según lo que pretenden verificar; no introducir un modo de producción que omita el protocolo para hacerlas pasar.

Extender reserveResponseQuota con un cuarto argumento `execution?:{deadlineAt:number}` después de authorize; omitirlo para una reserva nueva no habilita un intento v1 de fallback. Los callers de B4 lo suministran; las fixtures de reserva se actualizan explícitamente con marcador demo y deadline, sin un mock global que oculte el gate de producción. getResponseQuota y los replays no necesitan iniciar una ejecución ni cambiar esa identidad.

- [ ] Escribir `lostReserveAckAdoptsExactAttempt`, `twoHandlesDispatchOnlyOneWinner`, `releasedSafeRetryRejectsOldHandle`, `legacyReleasedIsFrozenWithoutRetrocharge`, `periodChangeSettlesOriginalPeriod`, `extraCapacityRaceKeepsBothChanges`, `missingPeriodFailsWithoutNewAllowance`, `markerRejectsOldWriter`, `cutoverMarkerCannotDowngradeOrDelete`, `receiptMutationAndBrowserFieldsReject`. Simular ACK perdido después del commit real y verificar filas/contadores, no solo llamadas de mocks.

```ts
expect(recovered.reservation).toEqual(originalReservation);
expect(dispatchResults.filter(value => value === 'dispatch_allowed')).toHaveLength(1);
expect(savedPeriod).toMatchObject({ usedResponses: 1, reservedResponses: 0 });
```
- [ ] RED: `pnpm exec vitest run tests/response-quota-store.test.ts tests/response-quota-d1.test.ts`; esperado imports/modelo de persistencia ausentes. Para Worker: `pnpm --filter sarin-cloudflare-host exec node --test tests/response-quota-data.test.mjs`, esperado rechazo/allowlist incorrecta antes del cambio.
- [ ] Implementar reserve/read/CAS/staging y liquidación en una transacción con turn/period/receipt. Extender DATA_COLLECTIONS con responseQuotaReceipts y DATA_CHILDREN responseQuotaTurns con reviews. Worker valida turnos v2 y reviews; recibos/reviews solo admiten create, nunca set/merge/delete; con marcador2 rechaza cambios v1 y no permite borrar/degradar/mergear el marcador. Lecturas antiguas siguen soportadas y no re-clasifican legacy como prepared. Las transacciones de efectos validan su reloj final después de todas las lecturas y antes de cualquier write.
- [ ] Añadir índices D1 `app_response_quota_pending(parent,status,nextAttemptAt,document_id,path)` y `app_response_quota_discovery(parent,status,document_id,path)` usando json_extract para campos JSON; equivalentes Firestore status+nextAttemptAt+__name__ y status+__name__. nextAttemptAt ya está en la allowlist. No añadir campos de texto consultables. Probar EXPLAIN sobre query real, no solo presencia del índice.
- [ ] GREEN: repetir ambos comandos RED y `pnpm exec vitest run tests/response-quota.test.ts tests/cloudflare-data.integration.test.ts`; esperado exit 0 y todos los casos focales ejecutados. Las pruebas SDK se ejecutarán por el runner ampliado en I.
- [ ] Guardar diff/hashes/resultados y commit focal `feat: persist fenced response quota attempts` tras revisión. Ningún marcador o migración remoto se crea aquí.

<a id="r0-quota-b3"></a>
### Task 3 — R0-QUOTA-B3: permiso de salida y vínculo operativo

**Files:** tercera fila del mapa; crear `tests/response-quota-dispatch.test.ts`; ampliar `tests/chat-intent.test.ts`, `tests/engine-budget.test.ts`, `tests/engine-gemini.test.ts`. **Depends:** B2.

**Interfaces:** `EngineDispatchContext={provider:EngineProvider;providerCallId:string|null}`. completeChat.beforeDispatch recibe ese contexto; callbacks antiguos sin argumentos siguen siendo válidos. Cada llamada nube asigna un UUID interno antes de la marca y reutiliza ese mismo UUID en observation/budget; Ollama usa null. interpretChat añade beforeDispatch separado y conserva sus revalidaciones beforeInference, sin interpretar el número de callbacks como evidencia. El hook cuota lo instala B4.

- [ ] Escribir `markerAckLostNeverDispatches` (commit de marca confirmado, helper devuelve error por ACK perdido: fetch 0, reserva retenida/consumible), `duplicateMarkerNeverGrantsTransport`, `guardDenialBeforeMarkReleasesOnlyUndispatchedBudget`, `providerCallIdMatchesBudgetAndObservation`, `ollamaAlsoRequiresDispatchFence`, `cloudWithoutBudgetFlagStillMarksQuota`. Cubrir DeepSeek y Gemini con respuestas sintéticas, sin API real.

```ts
expect(fetchSpy).not.toHaveBeenCalled(); // ACK final de marca incierto.
expect(savedTurn.execution.mayHaveDispatched).toBe(true);
expect(savedPeriod).toMatchObject({ usedResponses: 0, reservedResponses: 1 });
```
- [ ] RED: `pnpm exec vitest run tests/response-quota-dispatch.test.ts tests/chat-intent.test.ts tests/engine-budget.test.ts`; esperado hook/contexto faltante o aserción de frontera, no timeout aumentado.
- [ ] Implementar contexto/hook en el punto real inmediatamente anterior al transporte, después de validación de request y guards. Solo dispatch_allowed habilita HTTP. Error o already_marked nunca se convierte en un segundo fetch; onUsage best effort no decide cuota. Conservar el máximo operativo ante incertidumbre, sin liberar presupuesto por una regla comercial.
- [ ] GREEN: comando anterior y `pnpm exec vitest run tests/engine-gemini.test.ts tests/ai-budget.test.ts`; esperado exit 0, sin cambiar tarifas, límites, proveedor por defecto ni reintentos HTTP.
- [ ] Evidencia y commit `feat: fence commercial inference dispatch` tras revisión focal.

<a id="r0-quota-b4"></a>
### Task 4 — R0-QUOTA-B4: chat legacy, efectos y publicación cercados

**Files:** cuarta fila del mapa; crear `tests/response-quota-chat.test.ts`, `tests/response-quota-effects-d1.test.ts`; ampliar `tests/chat-route.test.ts`, `tests/chat-state.test.ts`, `tests/booking-proposals.test.ts`, `tests/whatsapp-queue.test.ts`, `tests/whatsapp-maintenance.test.ts`, `tests/chat-surfaces.test.tsx`, `tests/response-quota.test.ts`. **Depends:** B3.

**Interfaces:** runSarinChat conserva sus argumentos, añade opcional `executionDeadlineAt:number`; por defecto web usa tiempo de admisión al inicio de la petición +300000, sin extender al entrar en cola. WhatsApp pasa el deadline del registerWhatsAppOperation existente (180000 desde ese registro), no el plazo de envío de Graph. onResponse añade tercer argumento técnico opcional QuotaIdentity para su adaptador; persistWhatsAppReply recibe la identidad como sexto argumento opcional y la valida dentro de su transacción. El caller actual de WhatsApp la pasa siempre para v2.

- [ ] Escribir `closeWinsAgainstLateEffects` y `effectWinsRetainsProof` con dos handles D1: pausar tras HTTP, cerrar y reanudar; comprobar propuesta/chatState/cache/outbox ausentes cuando gana cierre, y prueba original conservada cuando gana efecto. `invalidOrUnpublishedResultStillConsumesOne`: HTTP negativo, JSON inválido, guard revocado y WHATSAPP_CONTROL_CHANGED tras despacho consumen una sola unidad, sin texto tardío. Probar antes de marca con fetch 0 y release comprobado.
- [ ] Añadir `plainResponseLostReturnsReceiptWithoutInference`, `bookingProofSurvivesStateFailure`, `completedCacheReplayStillChecksAuthority`, `legacyReleasedIsFrozenWithoutRetrocharge`, `onboardingAndChannelIdentitiesRemainDistinct`, `initialDeadlineDoesNotBlockAuthorizedCompletedProofReplay`. Simular reinicio vaciando solo el cache propio de tests, sin limpiar datos persistidos.

```ts
expect((await db.collection('bookingProposals').get()).size).toBe(0); // Gana cierre.
expect((await db.collection('chatStates').get()).size).toBe(0);
expect((await db.collection('whatsappOutbox').get()).size).toBe(0);
expect(savedPeriod).toMatchObject({ usedResponses: 1, reservedResponses: 0 });
```
- [ ] RED: `pnpm exec vitest run tests/response-quota-chat.test.ts tests/response-quota-effects-d1.test.ts tests/chat-route.test.ts`; esperado comportamiento viejo que libera/permite efectos tardíos. Conservar la observación RED y sustituir la expectativa vieja de devolución genérica solo cuando la nueva prueba demuestra el contrato aprobado.
- [ ] Integrar el hook de B3, deadline y resultado técnico. En createBookingProposal/saveChatState preparar los hooks tras lecturas y aplicar su stage en la misma tx de efecto; conservar el primer proof aun si falla el efecto siguiente. Leer la cerca en tx de outbox/history; interrupted bloquea cache/onResponse/retorno tardío. Diferenciar publicación inicial de replay estructurado autorizado. No volver a ejecutar interpretación para recuperar texto perdido ni enviar Graph desde reconciliación.
- [ ] Corregir el copy que hoy promete «Cada respuesta completa cuenta una vez». Usar la frase ya prevista por S03: «Una respuesta de IA ya iniciada puede consumir una respuesta del plan aunque no llegue a mostrarse». Mostrarla en cuota no compacta, junto a la entrada de recepción y configuración asistida; conservar layout/tokens/semántica de DESIGN.md. No añadir pantalla, fuente ni iconografía nueva. Tests de render comprueban el aviso en esos contextos y errores pendientes/interrumpidos, no solo una constante aislada.
- [ ] GREEN: repetir comando RED y `pnpm exec vitest run tests/chat-state.test.ts tests/booking-proposals.test.ts tests/whatsapp-queue.test.ts tests/whatsapp-maintenance.test.ts tests/chat-surfaces.test.tsx tests/response-quota.test.ts`; esperado exit 0 sin omisiones focales. `pnpm run typecheck` exit 0.
- [ ] Guardar evidencia y commit `fix: preserve quota and fence late chat effects`. No presentar estas pruebas de render como QA Playwright.

<a id="r0-quota-b5"></a>
### Task 5 — R0-QUOTA-B5: recuperación acotada y conciliación auditada

**Files:** quinta fila del mapa; crear `tests/response-quota-recovery.test.ts`, `tests/response-quota-admin.test.ts`, `tests/response-quota-admin-route.test.ts`, `cloudflare/tests/response-quota-recovery.test.mjs`. **Depends:** B4.

**Interfaces:** shared exporta `planQuotaRecovery(input:{turn:unknown;receipt:unknown;now:number}):{action:'skip'|'release_prepared'|'consume'|'needs_review';evidence:QuotaEvidence|null}`. Node y Worker consumen el mismo plan de settlement; no duplicar reglas. `recoverResponseQuotaBatch(db,now=Date.now()):Promise<{visited:number;settled:number;needsReview:number;morePending:boolean}>` procesa máximo50; Worker usa adapter D1 del patrón existente de mantenimiento, no importa Node/getAdminDb.

`reconcileResponseQuota(actor,input,db?)` tiene input strict `{requestId,reservation:ResponseQuotaReservation,expectedFingerprint,resolution:'consume'|'keep_pending'|'release_undispatched',reason:string,evidenceSha256:string}` con reason1–300 y digest64hex. Un request administrativo distinto no reescribe el review del mismo request; cuerpo distinto con el mismo ID produce409. consume de legacy_unknown exige marcador de corte válido y review administrativo; release_undispatched solo acepta prepared v2 validado/cercado, no texto/digest que afirme por sí solo no despacho.

GET `/api/admin/response-quota?after=<id>` devuelve20+lookahead con metadata/identidad de pendientes y cursor; PATCH usa readJson≤4096 y requireSuperadmin. Sin otras querys/duplicados, respuestas y errores no-store. El endpoint permite preparar/consultar sin un panel nuevo; los ajustes reales siguen requiriendo su autorización operativa en el flujo de trabajo.

- [ ] Escribir `preparedClosedBeforeDispatchFencesOldWorker`, `dispatchedInterruptedConsumesWithoutPublishing`, `legacyUnknownNeedsHumanReview`, `noProviderOrOutboxCallFromRecovery`, `adminCannotInventNoDispatch`, `adminReplayAndConflictingBody`, `anonymousClientOwnerStaffDenied`, `corruptCounterReturnsErrorNotEmpty`. Incluir lectura de permisos en servidor, incluso si un cliente declara ser admin.
- [ ] Escribir `recoveryScans1001WithTiesAndRestart`: descubrimiento legacy por status+__name__, páginas≤50 con cursor técnico durable en `serverSettings/responseQuotaRecoveryCursor`, sin cambiar counters; unknown pasa a revisión sin bloquear nuevos v2. Procesamiento v2 por status+nextAttemptAt+__name__, con dos rangos (empates primero, fechas posteriores después), sin OR que el driver no soporta. El presupuesto total es50 visitas entre todos los rangos: mientras coexistan descubrimiento y casos vencidos, reservar hasta25 para cada clase y usar el sobrante en la otra. Si una página completa no acredita final, morePending=true; no truncar en1000. La edad descubre, pero solo CAS de prepared +cierre permite devolver.

```ts
expect(firstBatch.visited).toBeLessThanOrEqual(50);
expect(new Set(visitedIds).size).toBe(1001);
expect(providerSpy).not.toHaveBeenCalled();
expect(deniedOwnerResponse.status).toBe(403);
```
- [ ] RED: `pnpm exec vitest run tests/response-quota-recovery.test.ts tests/response-quota-admin.test.ts tests/response-quota-admin-route.test.ts`; y `pnpm --filter sarin-cloudflare-host exec node --test tests/response-quota-recovery.test.mjs`. Esperado módulos/ruta ausentes o casos fallidos, nunca declarar pase de 0 tests.
- [ ] Implementar helpers/ruta/cron. `shared` decide y adapters preparan/apply en tx; conservar legacy_unknown retenido salvo prueba o decisión administrativa. Review y recibo terminal se escriben atómicamente con counters cuando corresponde. Worker cron ejecuta una página aun con canales/escritores apagados, salvo SARIN_MAINTENANCE que protege el corte/restore. No borra recibos, no llama proveedor, no despierta otro proceso para inferir y no reenvía WhatsApp. Métricas solo conteos y más pendientes; sin errores crudos, actor o cuerpos.
- [ ] GREEN: repetir RED y `pnpm run typecheck`; esperado exit 0. Probar pérdida de ACK de admin/tick y rerun con las mismas identidades: ningún segundo consumo/review distinto.
- [ ] Evidencia y commit `feat: recover and audit pending response quota`. No invocar PATCH con datos reales ni activar cron remoto en esta tarea.

<a id="r0-quota-i"></a>
### Task 6 — R0-QUOTA-I: integración, restore y compatibilidad

**Files:** sexta fila del mapa; actualizar los contratos futuros de consumo S03 en el control mediante este subplan, sin editar el hash aprobado de su spec. **Depends:** B1, B2, B3, B4, B5.

**Interfaces:** consume todos los exports anteriores; acredita la unión en runtime local, no crea un segundo reconciliador. `R1-S03-02` reutiliza shared/parser/store y solo construye su adaptador InboxQuotaIdentity=QuotaIdentity. Su completion:boolean se valida contra evidencia; sus operaciones/claims continúan pendientes de R1. No se simula una bandeja S03 construida para cerrar R0.

- [ ] Crear harness compartido mínimo con fixture demo-* y dos handles para los mismos casos de memoria/D1/Admin: crash antes/después de reserve/marca/resultado/settlement; request distinto/handle viejo; propuesta y estado de cita posterior; revocación; cambio de plan/extras; contador corrupto. Añadir archivo Firestore al runner oficial scripts/firestore-emulator-tests.mjs, sin saltarse reglas existentes ni usar proyecto real.
- [ ] Escribir `sdkCannotReadOrMutateQuotaOrReviews`, `restorePreservesAttemptReceiptAndOriginalPeriod`, `restoreCannotResurrectDispatch`, `oldWorkerRejectsReceiptWithoutPartialSettlement`, `markerPreventsLegacyWriterAfterCutover`, `maintenanceStillWorksWithChannelsOff`. Exportar/restaurar filas sintéticas con scripts/lib/data-migration.mjs en un runtime vacío; no sobrescribir un destino vivo ni omitir revisiones, reviews o recibos. Backend destino debe validar estado, no crear un período nuevo si falta.

```ts
expect(restoredReceipt).toEqual(originalReceipt);
expect(restoredReservation).toEqual(originalReservation);
expect(restoredPeriod).toMatchObject({ usedResponses: 1, reservedResponses: 0 });
expect(providerSpy).not.toHaveBeenCalled(); // Recuperar/restore no infiere.
```
- [ ] RED focal: `pnpm exec vitest run tests/response-quota-recovery.integration.test.ts tests/data-migration.test.ts`; esperado falta de contrato integrado, sin aumentar timeouts o bajar1001. Firestore RED con `pnpm run test:rules` ejecuta de verdad el archivo agregado y reglas; si falta Java, preparar el entorno o guardar bloqueo, no contar skip como pase.
- [ ] Completar solo defectos demostrados de integración y asegurar staging S03 con pruebas `quotaIdentityNullableUsesOriginalAttempt`, `absentReadAloneIsNotSettlementNone`, `prepareHasNoWritesApplyHasNoReads`; son pruebas del contrato común contra consumidor sintético cercado, no implementación del hilo ni sustituto de R1-S03-02.
- [ ] GREEN: comando focal anterior; `pnpm run test:rules`; `pnpm --filter sarin-cloudflare-host run check`; `pnpm run typecheck`; `pnpm test`; `pnpm run build`, secuencialmente. Esperado exit0; separar suites optativas/omitidas de los casos efectivamente ejecutados y no sumar reportes focales al total general. Las herramientas/remotos ausentes quedan como límite abierto, no una aceptación fabricada.
- [ ] Documentar resultados/SHA/diff y límites en QA. Runbook: reserva exacta del marcador y migración, pausa SARIN_MAINTENANCE, detener/drenar réplica vieja, comprobar identidad/escritor compatible, aprobar efecto en RELEASE-PREP/DEPLOY/FLAGS, crear marcador2, reanudar y recuperar; rollback solo a escritor v2. No incluir valores secretos ni comandos que se ejecuten automáticamente en remoto.
- [ ] Revisar cobertura de los10 casos del contrato, hash aprobado, compatibilidad y requisito de ninguna segunda llamada. Guardar evidencia; código integrado pasa a implemented, no verified QA. Commit focal `test: verify durable quota recovery across backends` si corresponde. Despejar currentTaskId y detenerse; la siguiente invocación será R0-PAGE-D.

## Cobertura y revisión del subplan

| Sección del contrato aprobado | Hijo responsable | Evidencia exigida al implementarlo |
| --- | --- | --- |
| Invariantes1–3: contadores/recibos/identidad | B1, B2, I | Tablas puras + dos handles + restore; terminal único y período original. |
| Invariantes4–7 y matriz de caída | B2, B3, B4, I | ACK perdido, marcador, proveedor sintético, fallos y cuota/gasto separados. |
| Invariante8: efectos tardíos | B4, I | Ambos órdenes de carrera; ningún efecto nuevo después de cierre. |
| Casos aceptación1–3 | B1–B3, I | Casos nominales y fallo en cada frontera, sin segundo fetch ni devolución arbitraria. |
| Casos4–5 | B4, I | Guard/HTTP/JSON/WhatsApp, cache perdida y pruebas estructuradas actuales. |
| Caso6 | B2, I | Cambio de período/extra, binario antiguo, restauración con recibos y marker. |
| Caso7/Q2 | B5, I | Auth, cuerpo acotado, review idempotente, datos corruptos y no ajuste de presupuesto. |
| Caso8/S03 | B1, B2, I; adaptador futuro R1-S03-02 | API transaccional reutilizable; ni otra reserva ni otro reconciliador, sin afirmar hilo construido. |
| Caso9: privacidad/logs | B1, B2, B5, I | Esquemas/Worker/SDK/no-store, sin cuerpos ni argumentos en contabilidad. |
| Caso10 | B4, I | Cierre frente a proveedor lento y prueba durable ganadora conservada. |

**Autorrevisión writing-plans:** firmas/tipos compartidos coherentes; todos los exports tienen dueño, los cinco Review Focus tienen prueba asignada, ninguna dependencia usa un consumidor S03 aún no construido, y las dos migraciones previas conservan sus nombres. La revisión futura del implementador verifica comportamiento sobre diff y comandos; esta tabla no acredita producto.

**Grafo:** P → B1 → B2 → B3 → B4 → B5; I depende explícitamente de los cinco builds. R0-PAGE-D y R0-READY dependen de I; R1-S03-02 también consume I. Cada hijo lleva moduleKey R0-QUOTA y requiresCodeWorkspace=true. Los 165 mappings se conservan: este módulo de fiabilidad no tiene requirementIds propios y cerrar P no implementa ningún Axx.

**Handoff:** revisar este documento antes de construir. La modalidad sigue siendo la ejecución del flujo avanzar, una tarea por invocación en el worktree registrado. Al aprobar esta versión se cerrará P; la siguiente tarea será R0-QUOTA-B1. No ejecutar código de B1 ni iniciar paginación al entregar este subplan.
