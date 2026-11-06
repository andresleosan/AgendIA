# Admisión por clasificación explícita Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans, native, task-by-task. Steps use checkbox (`- [ ]`) syntax. Una tarea por invocación de `/avanzar`; `tasks.json` del control es la única autoridad de progreso.

**Goal:** Exigir clasificación vigente para nuevas reservas e IA, con declaración general/adultos del dueño, transición segura y acceso independiente a hechos existentes.

**Architecture:** Extender la política privada existente con estados y constancias versionadas; compartir admisión transaccional entre dominios y una barrera de despacho por negocio en la única réplica. Preparar lectores, escritores y recuperación antes del corte conjunto de UI/admisión. Un marcador durable impide degradar el protocolo después del corte; las políticas administrativas v1 válidas siguen vigentes.

**Tech Stack:** Node 24.22.1, pnpm 11.23.0, TypeScript estricto, Next/React, Zod, Database/Transaction sobre D1 y Firestore, Vitest, Workerd y emulador oficial con Java 21+. Sin dependencias nuevas.

**Spec:** [Contrato aprobado R0-POLICY-D](../specs/2026-10-30-booking-policy-admission-design.md), SHA-256 `f828ff1ad95e7c02cbed837f36d1143399eaeaf5cab54d9f43a86c5dcf7c4ac9`. Aprobación expresa del propietario del 5 de noviembre de 2026 registrada en `contractApproval`. Fuente inspeccionada: `d8105889d51bcbfbf6cb63e7b225ddf22ab205e9`.

## Global Constraints

- Producto en `E:/Proyectos/SarinBot-worktrees/fresha-implementation-20261030`; control en `E:/Proyectos/Sarin Bot`. Preservar el checkout mixto, cambios ajenos y lockfile. No copiar `tasks.json` al worktree.
- General/adultos por declaración expresa del dueño; salud/menores solo por autoridad administrativa existente. No preseleccionar aceptación ni inferir clasificación de pago, publicación, configuración o antigüedad.
- Exigencia desde la entrega completa para todos, sin excepción comercial. Entregar declaración, recuperación y control de admisión conjuntamente. Los hijos preparatorios no activan el bloqueo de ausencia ni escritores v2.
- Conservar lectura, cancelación, recuperación durable, configuración manual correctiva, consulta/retirada de consentimiento y derechos. Una propuesta pendiente no es una cita confirmada.
- Una réplica; motor solo bajo `alsdevstudio.com`. No enviar mensajes reales, ejecutar inferencia pagada, clasificar negocios por lote ni activar salud, menores o canales. El despliegue habitual de código a main está autorizado; los efectos externos restantes conservan sus gates.
- Privacidad: sesión/propiedad comprobadas por servidor, no-store, constancias/notas privadas, sin cuerpos de conversación en logs. Fixtures `demo-*`, sin datos clínicos ni familiares.
- Agenda clara de `DESIGN.md`: DM Sans, tokens y componentes existentes; edición de configuración y navegación actuales. Antislop durante según preferencia guardada; QA integral MCP después de BUILD-FREEZE, sin atribuirla a pruebas focales.
- TDD por hijo de comportamiento: observar RED, implementar, GREEN focal y tipos; ejecutar backends reales cuando se nombran. Un archivo omitido por falta de emulador no cuenta como aprobado.

## Review Focus

1. Transferencia externa de `ownerUid` durante un guardado: se revalida en transacción y una declaración del dueño anterior no abre nuevas operaciones; B1/B3.
2. Política ilegible con cita/recibo confirmado: consulta, cancelación y revocación usan evidencia independiente sin fabricar una aceptación nueva; B4.
3. Timeout entre marca durable y transporte, seguido de reinicio: no liberar cuota ni repetir proveedor/outbox ante posible envío; B2/B4.
4. Respuesta tardía con el mismo UID y otra época de sesión: no mostrar constancia privada ni reintentar escritura desde el contexto anterior; B5.
5. Rollback de código con documentos ausentes o snapshot anterior al corte: la ausencia no desactiva el protocolo ni borra restricciones; B1/B5/I.

## Inventario contrastado y reparto

| Superficie actual | Hecho que gobierna la modificación | Hijo |
| --- | --- | --- |
| `src/lib/booking-subject.ts`; `src/lib/server/booking-data-policy.ts` | Lector estricto v1; ausencia devuelve general/configured=false; único escritor administrativo | B1/B3 |
| `src/app/api/admin/booking-data-policy/route.ts`; `src/app/api/businesses/[id]/booking-policy/route.ts` | Política completa solo admin; capacidad mínima para usuario autenticado | B3 |
| `src/lib/server/businesses.ts` | Propiedad leída en transacción al guardar configuración; no existe transferencia productiva de dueño | B1/B3/B4 |
| `chat.ts`, `chat-intent.ts`, `src/lib/sarin/engine.ts` | Hay relecturas, pero queda un await entre el hook y fetch; no hay barrera común con el cambio | B2/B4 |
| `src/lib/server/whatsapp-store.ts`, `whatsapp-worker.ts` | Persistir respuesta y enviar outbox carecen de guard de política propio | B2/B4 |
| `bookings.ts`, `booking-proposals.ts`, `structured-booking.ts` | Recuperación durable precede creación; propuestas generales también necesitan vínculo de revisión | B4 |
| `appointment-rescheduling.ts`, `owner-rescheduling.ts`, `waitlist.ts`, `waitlist-offers.ts` | Reprogramaciones, altas de espera y ofertas son entradas reales, con recuperaciones terminales propias | B4 |
| `booking-subject-consent.ts` | `load` consulta política también al leer/revocar; hay que separar evidencia previa y aceptación nueva | B4 |
| `business-team.ts`, `team-agenda.ts`, `business-factual-faq.ts`, `src/lib/waitlist-offers.ts` | Algunos consumidores solo miran dataMode/configured; no representan estado restrictivo | B1/B4 |
| `scripts/lib/recovery-classification.mjs` | Valida booking_policy_* con v1 estricto; registros nuevos deben clasificarse sin perder restricciones | B1/I |
| `cloudflare/scripts/release-core.mjs`, `release.mjs`, `cloudflare/src/data.ts` | Release exige main exacto/una réplica; cuota tiene patrón de marcador inmutable, admisión aún no | B1/B5 |
| `useBookingDataPolicy.ts`, configuración, página `/b/[slug]`, chat y admin existentes | Capacidad cliente carece de estados; configuración manual no debe depender de IA | B5 |

Rutas del servidor de la tabla son relativas a `src/lib/server/` salvo indicación. `publicBusinessProfile().bookingAvailable` sigue siendo información comercial, nunca autoridad para escribir. Un bloqueo manual de agenda sin datos de cliente no es un alta de cita y conserva su permiso vigente. No construir transferencia, nuevos canales ni un transporte de recuperación inexistente.

## Contratos compartidos que fija este desglose

### Modelo y capacidad

En `src/lib/booking-admission.ts`, definir esquemas estrictos y exportar:

- `BookingAdmissionState = 'active' | 'classification_required' | 'withdrawn' | 'administrative_review' | 'transitioning'`. Una lectura inválida lanza `BOOKING_POLICY_UNAVAILABLE`/503, no devuelve un estado vacío.
- `BookingAdmissionOperation = 'inference' | 'proposal' | 'appointment' | 'reschedule' | 'intake' | 'waitlist' | 'offer' | 'subject_acceptance' | 'channel_reply'`.
- `BookingAdmissionCapability = BookingCapability & { admission: BookingAdmissionState; canStartBooking: boolean; canUseInference: boolean }`. `configured` sigue significando documento explícito, nunca permiso. Salud activa permite estructurado, no IA; general con menores permite adulto para sí, con límites existentes.
- `BookingPolicyV2`: versión 2, businessId, revision entera positiva, dataMode, representedMinorsEnabled, status `active|withdrawn|suspended|transitioning`, origin `owner|admin`, updatedBy/updatedAt del servidor, reason privado y declaration nullable `{ownerUid,textVersion,receiptId}`. Un estado owner activo solo admite general/adultos y dueño vigente. Un estado admin conserva la autoridad y no puede degradarse por comandos del dueño.
- `transition` solo con status transitioning: `{requestId, targetRevision, target, startedAt, dispatchRefs}`; target es estado final estricto sin transición anidada y dispatchRefs conserva las identidades del head. revision aumenta al comenzar el cambio; finalizar ese mismo cambio no genera otra revisión. Una finalización debe comprobar revisión/identidad y no pisa una suspensión posterior.
- `BookingPolicyOperation`: constancia privada en `serverSettings`, clave hash de businessId/actorUid/requestId, version 1, action, operationHash, actorUid, occurredAt, previousRevision, targetRevision y phase `transitioning|applied`. Guarda textVersion cuando corresponda; no cuerpos ni notas en proyecciones cliente.
- `BookingDispatchHead`: documento privado `serverSettings/booking_dispatch_<hash businessId>`, version 1, businessId, revision y refs `{kind:'quota'|'whatsapp',id,policyRevision,startedAt}`. Máximo 64 refs; si está lleno, denegar un nuevo despacho antes de consumir cuota o enviar y liberar una reserva probadamente no despachada. No expirar refs por tiempo ni eliminar por cuota consumida: un transporte incierto sigue pendiente. El clasificador de backup conoce este formato desde B1.
- `bookingAdmissionProtocol` en `serverSettings`: `{version:1, minimumReader:2, introducedBySha:<40 hex>}` inmutable, no borrable por la API de almacenamiento. No reutilizar ni modificar `responseQuotaProtocol`.

Normalizar política v1 válida como administrativa vigente, sin reescribirla. Política ausente mantiene el dato legado general/configured=false pero en modo enforce produce classification_required. La declaración owner con dueño cambiado produce classification_required; conservar las restricciones admin, nunca autolimpiar estado. Todo esquema desconocido/corrupto cierra nuevas operaciones. `assertBookingIntakePolicy` sigue comprobando compatibilidad de campos, separado de la admisión general.

### Funciones y resultados

`src/lib/server/booking-admission.ts` produce `readBookingAdmission(businessId, db?, tx?): Promise<BookingAdmissionCapability>` y `assertBookingAdmission(tx, business, operation, db): Promise<BookingAdmissionCapability>`; relee negocio/política en la transacción, no confía en el objeto aportado como autoridad. Conserva `readBookingDataPolicy` para lecturas privadas y extiende su capacidad normalizada. Errores: ausencia 409 `BOOKING_CLASSIFICATION_REQUIRED`, retirada 409 `BOOKING_DECLARATION_WITHDRAWN`, suspensión 409 `BOOKING_ADMIN_REVIEW_REQUIRED`, transición 409 `BOOKING_POLICY_TRANSITIONING`, revisión 409 `BOOKING_POLICY_CONFLICT`, IA en salud 409 `STRUCTURED_BOOKING_REQUIRED`. No sustituir errores propios de identidad, datos o consentimiento.

`src/lib/server/booking-policy-commands.ts` produce `executeOwnerBookingDeclaration(actor, businessId, input, db?)`, `executeAdminBookingPolicy(actor, input, db?)` y `readOwnerBookingDeclaration(actor, businessId, db?)`. Actor de `requireUser`/`requireSuperadmin`; `assertOwner` y propiedad vigentes dentro del dominio/transacción. Input dueño estricto `{action:'declare'|'withdraw',requestId,expectedRevision,textVersion?}`; declare exige versión vigente del texto y withdraw no exige intake compatible. Ningún UID, rol, dataMode o campo administrativo aceptado del navegador. Admin conserva clasificación explícita e incorpora acciones suspend/resume con razón privada, requestId y expectedRevision. Resultado `{outcome:'applied'|'pending',capability,declaration,operation}` de proyección dueño; admin puede leer política completa. Reintento idéntico devuelve el estado ACTUAL y constancia, sin repetir revisión; distinto hash con mismo requestId da conflicto. Revisar autoridad también en replay.

`src/lib/server/booking-policy-transition.ts` produce `withBookingDispatch<T>({businessId,operation,identity,db}, dispatch:()=>Promise<T>):Promise<T>`, `beginBookingPolicyTransition(actor, command, db?)` y `resumeBookingPolicyTransition(actor,businessId,requestId,db?)`. Es módulo server-only, no otra cola global. Mantiene una barrera por negocio compartida por comandos y transportes en el singleton de proceso. El callback comprende la marca durable de posible envío, fetch y su resolución; sin liberar la barrera entre autorización y transporte. `prepareBookingDispatchRegistration(tx,db,businessId,ref)` prepara una escritura del head dentro de la misma transacción que revalida política y marca cuota/outbox; `finishBookingDispatch(tx,db,businessId,ref,resolution)` la retira únicamente con prueba de resolución del transporte. Admisión/cuota/persistencia permanecen en sus módulos actuales.

### Transición durable y reinicio

1. El comando restrictivo cierra inmediatamente nuevas entradas a la barrera local; valida actor, revisión e input y persiste transición/constancia atómicamente, capturando las refs del head en `transition.dispatchRefs`, antes de esperar despachos activos. Un comando inválido no cambia política ni revisión. Un error incierto mantiene el cierre local hasta releer su identidad durable; no responder éxito ni volver a general por optimismo.
2. Un despacho admitido tiene identidad durable antes del transporte (turn de cuota para IA, outbox para WhatsApp). La transición no responde applied mientras exista uno concurrente sin resolver. Puede responder pending/202 con identidad recuperable; el dueño puede consultar estado, sin repetir efecto.
3. Resultados de un despacho anterior al corte se liquidan según protocolo de cuota; pueden haber sido transmitidos. Revalidación impide publicar contenido, crear propuesta/reserva o nueva outbox incompatibles. El cambio no promete retirar lo ya enviado.
4. Al reiniciar no hay locks fiables en memoria: la política transitioning permanece cerrada; consultar por identidad las refs del head/transición, conservando uncertain/mayHaveDispatched y sin replay ni escaneo global. El head también descubre envíos pendientes si el reinicio precedió al inicio de la transición. Cuota completed por dispatch_possible no prueba transporte resuelto. Finalizar solo después de acreditar resolución del transporte; si no se acredita, permanece pending para revisión, sin desbloqueo por TTL. La recuperación de citas sigue disponible.
5. Toda persistencia posterior vuelve a comprobar transición/revisión y autoridad transaccionalmente. Suspensión concurrente prevalece: el finalizador anterior no reemplaza su revisión.

### Entrega preparatoria y corte conjunto

Una constante de build `BOOKING_ADMISSION_RELEASE: 'prepare'|'enforce'` y descriptor compartido de compatibilidad identifican el candidato. B1–B4 quedan prepare: no escriben v2/marcador ni habilitan endpoints de declaración; mantienen comportamiento v1 actual para negocios sin política. Los tests ejercitan enforce con fixtures inyectados. Una política v2 restrictiva, corrupta o marcador existente nunca se interpreta como apertura por estar en prepare. Prepare con marcador bloquea nuevas operaciones y mantiene recuperación; no es candidato permitido de rollback.

B5 entrega UI, declaración, guards y recuperación en un mismo candidato enforce. El release crea/verifica el marcador de forma idempotente antes de la primera mutación de despliegue enforce, aunque aún no exista ninguna política v2; si falla, no despliega. La preparación queda registrada incluso si el despliegue posterior falla y solo se reanuda hacia candidato compatible. El runtime exige marcador válido antes de admitir operaciones nuevas o escritores v2; no depende del primer negocio que declare. Crear ese control de compatibilidad no clasifica negocios ni activa salud/canales. El preflight de release lee solo ese documento en D1 y descriptor del candidato antes de build y justo antes de deploy: marcador existente rechaza prepare, lectores <2, valores desconocidos o candidato sin recuperación compatible. Incluir pruebas negativas de enforce→prepare antes de toda escritura v2 y de un revert parcial que quite enforcement.

El marcador es monotónico, no se borra al restaurar datos. El clasificador/witness/drill deben reconocerlo y conservarlo fuera del retroceso del snapshot. Para una restauración a entorno vacío, la reconciliación exige el protocolo enforce del candidato y establece el suelo antes de abrir escrituras; no tomar su ausencia en un backup antiguo como autorización. No realizar restauración real en estas tareas.

Solo B5 o posteriores que satisfagan el contrato completo son versiones permitidas para rollback. Pre-B1 queda excluido explícitamente; la comprobación de main exacto impide ejecutar un workflow histórico como entrega admitida. No se promete impedir que un operador privilegiado eluda el procedimiento y despliegue manualmente código antiguo. El runbook prohíbe downgrade de datos o eliminación del marcador y conserva pruebas de lectura/cancelación/recuperación del candidato mínimo.

## Construcción

<a id="task1"></a>
### Task 1: R0-POLICY-B1, modelo, lectores y compatibilidad de almacenamiento

**Files:** crear `src/lib/booking-admission.ts`, `src/lib/booking-admission-release.ts`, `src/lib/server/booking-admission.ts`, `tests/booking-admission-model.test.ts`, `tests/booking-admission-storage-contract.ts`, `tests/booking-admission-d1.test.ts`, `tests/booking-admission-firestore.test.ts`; modificar `src/lib/booking-subject.ts`, `src/lib/server/booking-data-policy.ts`, `cloudflare/src/data.ts`, `scripts/lib/recovery-classification.mjs`, `scripts/lib/recovery-reconcile.mjs`, `scripts/firestore-emulator-tests.mjs`; ampliar `tests/booking-data-policy.test.ts`, `tests/recovery-backup-classification.test.ts`, `tests/recovery-drill.test.ts`, `cloudflare/tests/data.test.mjs`.

**Interfaces:** produce los modelos, lectores, errores y descriptor de compatibilidad definidos arriba. Exporta parser del marcador sin dependencia server-only para Worker/release. Capacidad cliente no incluye actor, constancia ni razón. Introduce `ensureBookingAdmissionProtocol(db, candidateSha)` solo para enforce; ningún caller productivo lo activa todavía.

- [ ] RED: casos `legacy_admin_remains_active`, `missing_is_required_only_after_cutover`, `withdrawn_suspended_unknown_never_open`, `owner_binding_changes`, `private_fields_never_project`, `protocol_cannot_delete_or_downgrade`. Afirmar v1 sin escritura y v2 sin fallback; lectura fallida devuelve 503. Ejecutar suite focal de este bloque y observar fallos de comportamiento.
- [ ] Implementar parseo/normalización estricta y lectura de propietario/política en la misma transacción. El helper de admisión devuelve revisión efectiva sin consumir cuota ni escribir. En prepare no exponer escritores nuevos.
- [ ] Clasificar política v2, constancias, head de despachos, transición y marcador en recuperación; preservar restricciones y marcador al reconciliar snapshot previo. Probar documentos malformados, hash/negocio incorrectos y restauración sintética sin reabrir.
- [ ] GREEN: `pnpm exec vitest run tests/booking-admission-model.test.ts tests/booking-admission-d1.test.ts tests/booking-data-policy.test.ts tests/recovery-backup-classification.test.ts tests/recovery-drill.test.ts`; `node --test cloudflare/tests/data.test.mjs`; `pnpm run test:rules`; `pnpm run typecheck`. Registrar ejecución efectiva del contrato Firestore nuevo, permisos directos denegados y D1 real con dos handles.
- [ ] Revisar y entregar solo este hijo en main, prepare; comprobar CI/despliegue del SHA. No presentar ausencia como ya restringida en producción.

<a id="task2"></a>
### Task 2: R0-POLICY-B2, barrera de despacho y transición recuperable

**Files:** crear `src/lib/server/booking-policy-transition.ts`, `tests/booking-policy-transition.test.ts`, `tests/booking-policy-transition-d1.test.ts`; modificar `src/lib/sarin/engine.ts`, `src/lib/server/chat-intent.ts`, `src/lib/server/chat.ts`, `src/lib/server/response-quota-store.ts`, `src/lib/server/whatsapp-store.ts`, `src/lib/server/whatsapp-worker.ts`; ampliar `tests/engine.test.ts`, `tests/engine-budget.test.ts`, `tests/chat.test.ts`, `tests/response-quota-dispatch.test.ts`, `tests/response-quota-effects-d1.test.ts`, `tests/response-quota-chat.test.ts`, `tests/whatsapp-queue.test.ts`, contrato storage B1 para Firestore.

**Interfaces:** consume B1; produce withBookingDispatch/begin/resume. Extender `completeChat`/`interpretChat` con wrapper `dispatch?: <T>(context:EngineDispatchContext,send:()=>Promise<T>)=>Promise<T>` que abarque la llamada y no solo beforeDispatch. Conservar hooks de cuota existentes dentro del wrapper. Compartir barrera con WhatsApp sin mezclar identidades de proveedores.

- [ ] RED: barreras controladas por promesas, sin sleeps: transición mientras espera cola, corte exacto antes de fetch, llamada ya iniciada, timeout/respuesta perdida, reinicio después de persistir transición, suspensión durante finalización. Después del corte, contador fake de nuevos fetch=0; transición pendiente hasta resolución acreditada.
- [ ] Implementar protocolo de cinco pasos. Usar marca de cuota existente antes de fetch; un error después de mayHaveDispatched no libera/repite. No almacenar prompts/respuestas en la transición. Revalidar antes de publicar efecto aunque el modelo termine bien.
- [ ] Probar reinicio con módulo nuevo y mismos datos D1/Firestore antes y después de comenzar la transición; head y transición conservan refs, incluidas cuota consumed/envío incierto. La ref se registra atómicamente antes de fetch, no se omite por crash ni se borra por TTL. Reintento por identidad consulta estado; conflicto no pisa política. Readers sin transición mantienen comportamiento preparatorio.
- [ ] GREEN: `pnpm exec vitest run tests/booking-policy-transition.test.ts tests/booking-policy-transition-d1.test.ts tests/engine.test.ts tests/engine-budget.test.ts tests/chat.test.ts tests/response-quota-dispatch.test.ts tests/response-quota-effects-d1.test.ts tests/response-quota-chat.test.ts tests/whatsapp-queue.test.ts`; `pnpm run test:rules`; `pnpm run typecheck`. Todo transporte usa fake, sin coste real.
- [ ] Entregar main/CI/despliegue prepare; una prueba de barrera no acredita todavía el corte completo.

<a id="task3"></a>
### Task 3: R0-POLICY-B3, comandos y API de declaración y administración

**Files:** crear `src/lib/server/booking-policy-commands.ts`, `src/app/api/businesses/[id]/booking-declaration/route.ts`, `tests/booking-policy-commands.test.ts`, `tests/booking-declaration-routes.test.ts`; modificar `src/lib/server/booking-data-policy.ts`, `src/app/api/admin/booking-data-policy/route.ts`, `src/app/api/businesses/[id]/booking-policy/route.ts`, contrato storage B1; ampliar `tests/booking-data-policy-routes.test.ts`, `tests/booking-admission-d1.test.ts`, `tests/booking-admission-firestore.test.ts`.

**Interfaces:** consume B1/B2; produce los tres comandos definidos arriba. GET declaración solo dueño; PATCH body estricto máximo 4096 bytes y sin query, respuestas no-store, 200 applied/202 pending; sesión/origen conservan patrón existente. GET capacidad conserva proyección mínima. La ruta administrativa conserva acceso exclusivo y usa transición para cambios restrictivos.

- [ ] RED: `owner_can_declare_general_adults`, `no_session_employee_foreign_owner_denied`, `injected_admin_fields_rejected`, `ownership_changed_before_commit`, `declare_races_admin_suspend`, `same_request_after_withdraw_does_not_reopen`, `same_id_different_body_conflicts`, `uncertain_commit_recovers_current`, `withdraw_with_incompatible_intake`. Afirmar atomicidad de política/constancia y revisión única.
- [ ] Implementar propiedad dentro de transacción y texto versionado explícito. Dueño no cambia salud, menores, suspensión ni transición administrativa. Re-declaración tras retirada exige nueva identidad/revisión; solo admin levanta suspensión. V1 válida no exige redeclaración y no se sobrescribe una política corrupta.
- [ ] Mantener endpoints nuevos cerrados en prepare y writer administrativo legado sin emitir v2; enforce activa el escritor nuevo común. No publicar una vía de retirada que lectores todavía no interpreten. GET no filtra notas o actor privado hacia cliente/empleado.
- [ ] GREEN: `pnpm exec vitest run tests/booking-policy-commands.test.ts tests/booking-declaration-routes.test.ts tests/booking-data-policy-routes.test.ts tests/booking-admission-d1.test.ts`; `pnpm run test:rules`; `pnpm run typecheck`. Contrato compartido prueba CAS y commit incierto en ambos backends.
- [ ] Entregar main/CI/despliegue prepare, sin clasificar ningún negocio real.

<a id="task4"></a>
### Task 4: R0-POLICY-B4, admisión de entradas y recuperación independiente

**Files:** crear `tests/booking-admission-domain.test.ts`, `tests/booking-admission-recovery.test.ts`, `tests/booking-admission-channels.test.ts`; modificar `src/lib/server/bookings.ts`, `booking-proposals.ts`, `structured-booking.ts`, `appointment-rescheduling.ts`, `owner-rescheduling.ts`, `waitlist.ts`, `waitlist-offers.ts`, `booking-subject-consent.ts`, `businesses.ts`, `booking-data-policy.ts`, `business-factual-faq.ts`, `business-team.ts`, `team-agenda.ts`, `chat.ts`, `whatsapp-store.ts`, `whatsapp-worker.ts` y `src/lib/waitlist-offers.ts`, `src/lib/booking-subject-legal.ts`, `scripts/lib/recovery-classification.mjs`; ampliar `tests/recovery-backup-classification.test.ts`, contrato storage B1 y suites de propuestas/consentimiento/espera/ofertas/chat. Todos los nombres abreviados de servidor en este bloque pertenecen a `src/lib/server/`.

**Interfaces:** usa assertBookingAdmission en transacciones de nueva operación, después del replay durable autorizado y antes de cuota/intake/escrituras. Propuestas generales nuevas guardan revisión de política igual que las estructuradas; una propuesta antigua pendiente debe revalidarse, nunca tratarse como cita guardada. Separar `readStoredBookingSubjectEvidence(actor,businessId,case,db,tx?)` de construcción de documentos para nueva aceptación. Estado de consentimiento distingue evidencia histórica y elegibilidad actual; no generar documentos de aceptación cuando política está indisponible.

- [ ] RED: tabla por entrada web, dominio directo, WhatsApp fake, cita, reprogramación, aceptación, espera y oferta: negocio pagado/publicado sin política rechaza antes de cuota; transición durante commit rechaza sin escritura parcial. Afirmar cero inferencia, cero respuesta/cita consumida y cero outbox para denegación previa; no confundir bloqueo manual con cita de cliente.
- [ ] Incorporar guards a todos los puntos inventariados. Adaptar consumidores dataMode/configured a capacidad efectiva según su permiso: no cerrar lectura de agenda de equipo por una denegación de nuevas reservas ni ampliar acceso de salud. Mantener catálogo/configuración correctiva independientes de IA; incompatibilidad de intake sigue su regla específica.
- [ ] Configuración correctiva con política ilegible: `createBusiness` entrega a `assertBookingIntakePolicy` los campos anteriores leídos en la misma transacción. Permitir eliminar todos los campos de intake o conservarlos exactamente mientras corrige otros datos; añadir/modificar campos exige política legible y compatible. No inventar capacidad general ni permitir recoger respuestas nuevas mientras persista la denegación. Probar corrección manual y rechazo de añadir intake con política corrupta.
- [ ] Separar consulta/revoke de consentimiento de la lectura de política actual; verificar recibo/caso/UID antes de devolverlo o retirar. Nueva aceptación exige política vigente. Error del propio recibo falla, no simula historial vacío ni autorización.
- [ ] Recuperar cita confirmada por misma operación/actor/negocio, mostrando estado actual después de cancelar/reprogramar; sin cuota, modelo ni nueva confirmación. Chat denegado no devuelve texto cacheado ni propuesta pendiente; recupera únicamente hechos durables. Vínculo de contenido distinto con mismo requestId falla.
- [ ] Outbox: guardar revisión de admisión en persistWhatsAppReply dentro de su transacción; revalidar antes de envío dentro de B2. `ready` incompatible se cancela sin enviar; `sending/unknown` conserva incertidumbre y no se reenvía. Actualizar el esquema estricto de outbox en recovery-classification y probar sanitizeBackupSql de filas nuevas/legadas. No añadir recuperación por mensaje inexistente; conservar la vía web/contacto disponible.
- [ ] GREEN: `pnpm exec vitest run tests/booking-admission-domain.test.ts tests/booking-admission-recovery.test.ts tests/booking-admission-channels.test.ts tests/booking-admission-d1.test.ts tests/booking-subject-consent.test.ts tests/booking-proposals.test.ts tests/represented-booking.integration.test.ts tests/waitlist-offers-d1.test.ts tests/owner-rescheduling-d1.test.ts tests/chat.test.ts tests/chat-route.test.ts tests/whatsapp-queue.test.ts tests/recovery-backup-classification.test.ts`; `pnpm run test:rules`; `pnpm run typecheck`. Registrar adultos, salud, menor general y pediatría sintéticos.
- [ ] Entregar main/CI/despliegue prepare; no habilitar la exigencia global hasta B5.

<a id="task5"></a>
### Task 5: R0-POLICY-B5, declaración visible, recuperación y corte conjunto

**Files:** crear `src/components/owner-booking-declaration.tsx`, `src/hooks/use-owner-booking-declaration.ts`, `tests/owner-booking-declaration.test.tsx`, `tests/booking-admission-ui.test.tsx`, `cloudflare/scripts/booking-admission-preflight.mjs`, `docs/product/booking-admission-operation.md`; modificar `src/hooks/useBookingDataPolicy.ts`, `src/hooks/use-owner-configuration.ts`, `src/components/owner-configuration-provider.tsx`, `src/components/owner-configuration-workspace.tsx`, `src/components/admin-booking-data-policy.tsx`, `src/app/dashboard/onboarding/page.tsx`, `src/app/b/[slug]/page.tsx`, `src/lib/booking-admission-release.ts`, `src/lib/server/booking-admission.ts`, `cloudflare/scripts/release-core.mjs`, `cloudflare/scripts/release.mjs`, `cloudflare/tests/release.test.mjs`; ampliar `tests/owner-configuration-workspace.test.tsx`, `tests/owner-configuration-provider.test.tsx`, `tests/chat-surfaces.test.tsx`, `tests/admin-booking-data-policy.test.tsx`.

**Interfaces:** hook devuelve `{view,loading,error,pending,declare,withdraw,refresh}` con UID/época/negocio, requestId conservado y sin reintento automático. Componente integrado en configuración existente: declaración explícita, texto vigente completo, procedencia real, retirada y resultado incierto. No crear navegación competidora. Preflight `assertBookingAdmissionRelease({candidate,liveProtocol})` devuelve void o error cerrado; runRelease lo exige antes de build y deploy.

- [ ] RED UI: declaración sin checkbox preseleccionado, etiquetas distintas para cinco estados/error/salud; declarar/retirar/consultar resultado, doble clic, cambio UID/mismo UID otra época, respuesta tardía y conflicto con admin. Sin sesión/dueño adecuado no mostrar constancia. Configuración manual accesible sin IA ni clasificación; retirada no atrapada por intake incompatible.
- [ ] Integrar componente/hook con B3, capacidad ampliada con validación estricta y errores no vacíos. En cliente conservar consultar/cancelar cita y contacto, incluso si política falla. Salud ofrece formulario estructurado, no llama al modelo; admisión denegada no oculta historial ni cancela identidad de una escritura incierta. Admin ve razón privada y suspensión/reanudación con revisión.
- [ ] El hook/proveedor/onboarding no usan `policy.ready` como bloqueo total: ofrecen edición correctiva de B4 con capacidad desconocida explícita, ocultando nuevas opciones de intake/IA. Una capacidad desconocida no se sustituye por general. Probar política ilegible → retirar intake/guardar otros datos → recuperar lectura, sin desbloquear reservas por optimismo.
- [ ] RED release: prepare con marcador, reader viejo, corrupción, revert de enforcement y restauración anterior al marcador son rechazados. Probar primer enforce completo, inicialización idempotente del marcador y no borrado/downgrade. Verificar que rollback mínimo mantiene consulta/cancelación/revoke, no solo parser restrictivo.
- [ ] Implementar preflight y runbook descritos; cambiar a enforce solo con todos los guards/UI presentes y tests acumulados verdes. La única variable de corte no puede habilitar escritores sin declaración/recuperación. Mantener main exacto, una réplica y credenciales/redacted snapshots del release vigente. Ninguna migración masiva de políticas.
- [ ] GREEN: `pnpm exec vitest run tests/owner-booking-declaration.test.tsx tests/booking-admission-ui.test.tsx tests/owner-configuration-workspace.test.tsx tests/owner-configuration-provider.test.tsx tests/chat-surfaces.test.tsx tests/admin-booking-data-policy.test.tsx tests/booking-admission-d1.test.ts`; `node --test cloudflare/tests/release.test.mjs`; `pnpm run test:rules`; `pnpm run typecheck`; `pnpm test`; `pnpm run build`; `pnpm --filter sarin-cloudflare-host run check`.
- [ ] Revisar interfaz focal con estados reales sintéticos, teclado, 320/390/1280 y zoom nativo 200%, dejando evidencia y cualquier límite sin atribuir QA integral. Publicar candidato conjunto en main y verificar CI/Worker/Container/Pages por mismo SHA. No verificar mediante mensajes ni inferencia reales. Un fallo conserva este mismo ID y resume, no adelanta I.

<a id="task6"></a>
### Task 6: R0-POLICY-I, integración de admisión y compatibilidad

**Files:** crear `docs/qa/2026-11-05-booking-policy-admission-integration.md`; ampliar `tests/booking-admission-storage-contract.ts`, `tests/booking-admission-d1.test.ts`, `tests/booking-admission-firestore.test.ts`, `tests/recovery-drill.test.ts`, `cloudflare/tests/release.test.mjs` solo si la integración revela casos faltantes.

**Interfaces:** consume los cinco hijos construidos, contrato aprobado y candidato enforce; produce evidencia integrada. No diseña otro contrato ni activa capacidades externas.

- [ ] Recorrer la matriz siguiente contra el SHA candidato. Ejecutar mismo contrato en D1 real y Firestore oficial, incluyendo handles reabiertos, política ausente/ilegible, autoridad/revisión concurrente, reinicio, cuota y recuperación. Comparar trazas de efectos fakes, sin cuerpos privados.
- [ ] Repetir drill sintético: snapshot anterior a retirada/suspensión/marcador no reabre; parser y preflight del rollback admitido conservan recuperación. Inspeccionar inventario de lectores/escritores de nuevo y añadir cualquier entrada real omitida antes de cerrar.
- [ ] Revisión independiente del cambio completo y regresión de hallazgos relevantes. Checks acumulados: `pnpm run typecheck`; `pnpm test`; `pnpm run test:rules`; `pnpm run build`; `pnpm run build:pages`; `pnpm --filter sarin-cloudflare-host run check`; `node --test pages-gateway/tests/*.test.mjs`; `pnpm audit --audit-level=high`. Journey sintético con `dev:local` y puerto 3040, luego `pnpm run test:local --port 3040` y `pnpm run test:journey --port 3040`; conservar logs/omitidas separados.
- [ ] Informe con SHA, backend/casos/artefactos, hash de diff si lo hay, compatibilidad, alcance UI y límites. Versionar informe/correcciones propias y completar main/CI/despliegue del mismo candidato. Sin cambios nuevos, comprobar SHA remoto existente, no fabricar commit vacío.
- [ ] Actualizar solo tasks.json del control, evidencia implemented para código/integración, sin resolver requisitos Fresha por este soporte transversal. Validar los 165 mappings y regenerar progreso.html. R0-OBS-D y R0-READY dependen de esta integración; detenerse.

## Matriz de aceptación del módulo

Estos casos POLICY-* son pruebas del contrato transversal, no requisitos Axx nuevos. R0-POLICY-D/P no tienen requirementIds: se preservan los 165 requisitos y sus mappings sin adjudicar implementación a un desglose.

| Caso | Actor y fixture sintético | Acción y resultado esperado | Hijos |
| --- | --- | --- | --- |
| POLICY-01 | cliente demo-paid-unclassified publicado | IA/alta/intake/espera denegados antes de cuota; consulta/cancelación de cita previa funcionan | B1/B4/I |
| POLICY-02 | dueño demo-general y empleado/otro dueño | solo dueño vigente declara explícitamente; inyección salud/menores/rol falla; v1 admin no se redeclara | B1/B3/B5 |
| POLICY-03 | dueño y admin demo-race | declarar contra suspensión/ownerUid/revisión perdida; ninguna escritura parcial ni bypass por replay | B2/B3/I |
| POLICY-04 | dueño demo-withdraw con intake incompatible | retirar cierra; reintento anterior no abre; nueva declaración permitida solo sin restricción admin | B2/B3/B5 |
| POLICY-05 | cliente demo-policy-corrupt con cita/recibo | error de política distinto de ausencia; consulta/cancelación/revoke/recuperación independiente y autorizada | B1/B4/I |
| POLICY-06 | cliente demo-dispatch con proveedor fake | cambio general→salud/retirada/suspensión en cola y antes de fetch; no nuevo despacho; posible envío no se repite | B2/B4/I |
| POLICY-07 | cliente demo-confirmed y propuesta pendiente | confirmar/reintentar tras cambio solo recupera cita durable actual, sin nueva cuota; pendiente no confirma | B4/I |
| POLICY-08 | adultos, menor general y pediatría demo-* | consentimiento vigente y revisión requerida; estructurado sensible fuera de modelo/proyección pública | B3/B4/I |
| POLICY-09 | dueño/cliente demo-offer | espera/oferta/reprogramación contra cambio restrictivo rechazan nueva escritura; cancelar/recuperar terminal funciona | B4/I |
| POLICY-10 | canal controlado demo-whatsapp | revisión en outbox y envío, ready incompatible cancelado; sending/unknown no replay ni liberación indebida | B2/B4/I |
| POLICY-11 | operador demo-restore, snapshot antiguo | marcador/restricciones no retroceden; candidato viejo/prepare rechazado; rollback permitido conserva recuperación | B1/B5/I |
| POLICY-12 | dueño/cliente demo-session | doble clic/timeout/sesión tardía no muestran éxito optimista ni constancia ajena; enlaces de recuperación sin IA | B5/I |

## Revisión del desglose y continuación

Dependencias: P → B1 → B2 → B3 → B4 → B5; I depende explícitamente de B1–B5. Orden deliberadamente secuencial por interfaces y corte conjunto, aunque investigación/revisión pueda delegarse. La continuación R0-OBS-D cambia de P a I; R0-READY añade I a sus dependencias existentes.

Autorrevisión: los diez puntos del contrato y su tabla de autoridad se distribuyen entre modelos/compatibilidad B1, transición B2, comandos B3, entradas/recuperación B4 y UI/corte B5; I verifica el conjunto. Los cinco riesgos de Review Focus tienen caso y dueño. Se conserva `executionMethod=native-one-task`; la siguiente invocación ejecuta únicamente B1. Este documento es un desglose, no código implementado, aceptación de QA ni aprobación de efectos externos adicionales.
