# Mis citas paginadas Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans inline, task-by-task. Steps use checkbox (`- [ ]`) syntax. El propietario autorizó expresamente desglose, implementación completa, validación, commit y push el 2 de noviembre de 2026; no requiere otra aprobación del mismo alcance.

**Goal:** Consultar Mis citas por páginas de 20, preservando acciones, recuperación, recordatorios y privacidad, incluso con más de 1.000 registros.

**Architecture:** Modelo cliente seguro y lector transaccional por UID/vista, continuaciones por empate e inicio y hasta cinco streams para Historial. Una página visible, cursor stack y polling conservan posición ante cambios; las fuentes operativas y el foco se comprueban por ID fuera de la página. El chat consume el mismo lector y el GET antiguo pide actualizar explícitamente.

**Tech Stack:** Node24.22.1, pnpm11.23.0, TypeScript/Next16.4.3/React19.3.1, Zod4.6.7, Firestore Admin y D1; Vitest/Workerd/emulador oficial Java21. Sin dependencias nuevas.

**Spec:** `docs/superpowers/specs/2026-10-30-client-appointments-pagination-design.md`, SHA256 `eab913c85e06b78ef648031f8cb4ade1b7dbbf070278d6e697da5d0eee7a6064`, aprobado por el propietario en esta sesión.

## Global Constraints

- Conservar Agenda clara, páginas de20, centinela21, UID derivado de sesión, no-store, asOf fijado por servidor y cursor de15min. Sin OR/startAfter/offset, ni lecturas globales auxiliares.
- Upcoming=confirmed/endAt>asOf; history=nonconfirmed o confirmed/endAt<=asOf; calendar=rango colombiano por startAt. Start/id asc salvo history start desc/id asc. Validar ID guardado contra canónico.
- Un fingerprint no otorga permisos ni prueba snapshot entre páginas. Nuevo scope/época oculta datos y descarta resultados tardíos.
- Mantener requests/propuestas/mutex y recuperación independientes de la página. PNG/ICS revalidan por ID antes de preparar y descargar. Recordatorio fuera de página no equivale a ausente/cancelado.
- Producto en codeRoot aislado desde f2f7612; estado solo tasks.json del control. Preservar cambios previos, lockfile, una réplica y hostname de motor alsdevstudio.com.
- Commit/push al terminar la validación del lote; antes del release verificar índices y dato canónico. No ejecutar envíos, inferencia pagada o ajustes de cuota reales como prueba.

## Review Focus

1. Muchos históricos y una próxima: no filtrar una página vieja para concluir vacío; B1 prueba rangos reales y 1.001.
2. Empates y cinco estados mezclados: ancla global/centinela sin omitir ni repetir con datos estáticos; B1 e I.
3. Confirmación/reprogramación fuera de página: ausencia parcial no invalida fuente ni elimina recuperación; B4.
4. Sesión con mismo UID pero nueva época y cuerpos/tokens tardíos: máscara durante render y guards después de cada await; B3/B4.
5. Cancelación/reprogramación mientras se prepara PNG/ICS: relectura antes de descargar y liberación solo del mutex propio; B4.

## Files and ownership

| Child | Create | Modify |
| --- | --- | --- |
| B1 | src/lib/client-appointments-pagination.ts; src/lib/server/client-appointments-pagination.ts; cloudflare/migrations/0015_client_appointments_pagination.sql; tests/client-appointments-pagination-model.test.ts; tests/client-appointments-pagination-storage-contract.ts; tests/client-appointments-pagination-d1.test.ts; tests/client-appointments-pagination-firestore.test.ts | cloudflare/src/data.ts; firestore.indexes.json; scripts/firestore-emulator-tests.mjs |
| B2 | src/app/api/businesses/[id]/appointments/query/route.ts; src/app/api/businesses/[id]/appointments/[appointmentId]/route.ts; tests/client-appointments-pagination-route.test.ts | appointments/route.ts; src/lib/server/chat.ts; src/lib/server/chat-replies.ts; tests/chat-route.test.ts; route fixtures depending on view=mine |
| B3 | src/hooks/use-client-appointments-page.ts; tests/client-appointments-page.test.tsx | none |
| B4 | tests/client-appointments-page-integration.test.tsx; tests/client-appointments-page-fixtures.ts | client-appointments.tsx; client-appointment-reminders.tsx; use-appointment-reminders.ts; src/app/b/[slug]/page.tsx; six client-appointments UI suites and relevant page/reminder tests |
| I | docs/qa/2026-11-02-client-appointments-pagination.md | data-migration.test.ts; firestore.rules.test.ts if new private data needs denial; caller fixtures affected by migration |

<a id="task1"></a>
### Task1 — R0-PAGE-B1: modelo, consulta e índices

**Interfaces:** model exports `ClientAppointmentsView`, `ClientAppointmentsCursor`, `ClientAppointmentsPage`, `clientAppointmentsQuerySchema`, `clientAppointmentsPageSchema`, `compareClientAppointments`, `clientAppointmentDateKey`, `clientAppointmentInView`. Cursor includes version1,businessId,clientUid,view,dateKey|null,asOf,appointmentId,startAt,revision. Page includes scope,view,dateKey,asOf,checkedAt,rows,nextCursor,coverage. `readClientAppointmentsPage(actor,businessId,input,db?,now?)` and `readClientAppointment(actor,businessId,id,db?)` are server-only; runtime row validation preserves authorized current Appointment fields. No client UID input.

- [ ] Tests: malformed/foreign cursor, unsafe timestamp, static comparator; 20+1, 999/1000/1001, ties, all states, cancelled future/in-progress/midnight; canonical ID and malformed returned row fail honestly; anchor revision/status move conflicts; non-anchor mutation documents snapshot limits.
- [ ] RED: `pnpm exec vitest run tests/client-appointments-pagination-model.test.ts tests/client-appointments-pagination-d1.test.ts`; missing modules/cases fail.
- [ ] Implement strict model and transacted server query/point reader. UID/type base; upcoming endAt predicate in database plus startAt domain bound; tie then later with remaining21. History five disjoint streams each max21, merge global21. Calendar valid Colombia interval, explicit known statuses. Fingerprint of start/end/status/reschedule/attendance revisions; verify anchor scope and15min TTL.
- [ ] Add endAt numeric D1 field and additive0015 indexes fitting generated first/tie/later queries. Preserve existing indexes; Firestore orders include implicit document key last and explicit stored id before endAt.
- [ ] GREEN focal and real Firestore: `pnpm run test:rules`; expected actual new file executed, no skip. D1 EXPLAIN must exercise emitted SQL, limits prove document budget and no writes; never claim index-entry cost is bounded by20.

<a id="task2"></a>
### Task2 — R0-PAGE-B2: endpoints, transición y chat

**Interfaces:** POST `/api/businesses/:id/appointments/query` body4096 strict model; GET `/api/businesses/:id/appointments/:appointmentId` returns `{appointment}` own-only. Existing `?view=mine` returns409 `CLIENT_APPOINTMENTS_UPGRADE_REQUIRED` asking page reload. No changes to GET date or POST/PATCH mutations. Chat own_appointments uses `readClientAppointmentsPage(...,{view:'upcoming',version:1})`, renders max20 as upcoming and explicit Mis citas continuation when more.

- [ ] RED route tests: anonymous, foreign own-ID, bad/duplicate query, body bound, no-store errors, legacy update response; chat bounded summary with21 rows and zero extra inference.
- [ ] Implement routes/reuse domain authorization; render own_appointments separately from owner_agenda. Update old full-array fixtures only for intentional API change.
- [ ] GREEN: `pnpm exec vitest run tests/client-appointments-pagination-route.test.ts tests/chat-route.test.ts tests/chat-replies.test.ts tests/route-authorization.test.ts` (use actual existing test filenames; record substitutions).

<a id="task3"></a>
### Task3 — R0-PAGE-B3: controlador de página y sesión

**Interfaces:** `useClientAppointmentsPage({businessId,userId,authEpoch,isCurrentSession})` returns page,loading,error,changed,view,dateKey,setView,setDateKey,next,previous,refresh,retry,lookup(id),patchAppointment(appointment). Keeps cursor stack only, current20, one selected point row where needed. Async reads have10s total deadline and generation/abort guards, apiFetch expected UID plus current-session function. Scope derives authEpoch and UID, no persistent browser cache.

- [ ] RED hook tests: initial/next/previous, range scope and input validation; background identical refresh preserves cursor; changed composition/409 retains page+changed, prevents next until explicit refresh; error is not empty; next failure retains page; logout/sameUID epoch/late token/body discard; hidden tab pauses polling.
- [ ] Implement using existing startApiPolling/apiFetch patterns and actual session guard; no overlapping reads, full request deadline, reset on view/date/scope. Distinguish refresh (new first/asOf) from retry (same page). Current page is re-read with its incoming cursor during periodic polling; do not automatically replace changed composition.
- [ ] GREEN: `pnpm exec vitest run tests/client-appointments-page.test.tsx tests/api-polling.test.ts tests/owner-client-record-hook.test.tsx` with filenames verified in repo. Tests assert strict response and next cursor consistency.

<a id="task4"></a>
### Task4 — R0-PAGE-B4: integrar tarjetas, fuentes activas y exportación

**Interfaces:** ClientAppointments uses B3 with auth context; optional props `watchedAppointmentId` / `selectedAppointmentId` and `onAppointmentVerified(id,appointment|null)` replace whole-list proof in parent. Visible page is never passed as full canonical set. One point-selected card can appear outside normal20; change generations protect focus. `ClientAppointmentReminders` treats canonical partial knowledge as partial; its server response remains own source of valid occurrences, known updated rows suppress stale occurrences, Ver cita point-reads current ID before focus.

- [ ] RED integration/UI cases:21+ records, all three views, stable position/update, reminder outsidepage, parent reschedule source outsidepage, lookup error retains same confirmation, source canceled/changed during work; rebook current service and existing mutex.
- [ ] Integrate Anterior/Siguiente/Actualizar with existing tokens/44px buttons/focus/statuses; no total count or global loading empty. Route point lookup used for selected reschedule/cancel and before/after PNG/ICS generation. Preserve exact mutation identity, auth and recovery; no automatic repeated writes.
- [ ] Update old UI mocks to return actual new page/lookup contracts; retain adversarial authority/late handlers tests rather than deleting them. Test no duplicate clicks between lookup await and acquiring/transferring mutex.
- [ ] GREEN all six client-appointments suites, new hook/integration tests, reminder controller and public page tests. Types. Scoped responsive/keyboard visual check; global Fresha QA remains after build freeze. antislop during is the existing session choice, no new wizard.

<a id="task5"></a>
### Task5 — R0-PAGE-I: integración y entrega

- [ ] Re-run B1 common contract on real D1 and official Firestore, read-only queries/reopened handles, extra-capacity data; 1001 exact traversal and no retained snapshot claim. Add migration roundtrip for cursor-referenced appointments with no new state to back up.
- [ ] Fresh whole-change reviewer; Critical/Important findings get observed regression RED/GREEN then affected/full checks.
- [ ] Final checks: `pnpm run typecheck`, `pnpm test --maxWorkers=2`, `pnpm run test:rules`, `pnpm --filter sarin-cloudflare-host run check`, `pnpm run build`, `pnpm run build:pages`, gateway tests, high audit. Preserve logs and skipped optional suites separately.
- [ ] QA report records candidate, index/caller/behavior evidence, visual scope, old-browser migration and limits. Revalidate graph/all165 mappings and protected file hashes.
- [ ] Commit only scoped files and push main after checks; apply additive indexes/preflight under exact authorized artifact, verify CI/deployed SHA and public auth smoke. No paid inference or real messages. Keep R0-BACKUP-D next; no unrelated task execution.

## Self-review and rulings

Spec sections map to B1 predicates/cursors; B2 auth/compat/chat; B3 freshness/session; B4 operations/reminders/UI; I cross-backend/migration/release. Five review-focus cases have named assertions above. All signatures owned by a preceding task.

Ruling: user explicitly requested continuing through decomposition and implementation to validated commit/push; preserve inline execution and do not pause again for the plan handoff of the same approved scope. Commit is consolidated at the requested final validation, rather than each intermediate task. Product source remains isolated; canonical progress remains control-only.
