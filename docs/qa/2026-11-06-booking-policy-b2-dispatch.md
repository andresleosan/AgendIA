# R0-POLICY-B2: barrera de despacho y transición recuperable

Fecha: 6 de noviembre de 2026, America/Bogota. Hijo preparatorio del contrato aprobado de admisión, sin activar el corte `enforce`.

## Identidad y alcance

- Base de producto: `a2bd140d3670b5d9a6f319f936bd6820cea67c4c`.
- Worktree: `E:/Proyectos/SarinBot-worktrees/fresha-implementation-20261030`; estado canónico exclusivamente en `E:/Proyectos/Sarin Bot/docs/implementation/fresha/tasks.json`.
- Diff de los 13 archivos de código/pruebas, antes de añadir este informe: SHA-256 `80900d05c17907a604de75a616332e9d67147be1df9e4034a652b3247ea1c479`; copia local `.tmp-checks/policy-b2-code.diff`. Este hash no incluye el propio informe ni archivos ajenos.
- Contrato: `docs/superpowers/specs/2026-10-30-booking-policy-admission-design.md`, SHA-256 `f828ff1ad95e7c02cbed837f36d1143399eaeaf5cab54d9f43a86c5dcf7c4ac9`.

La barrera compartida por negocio cubre autorización, registro durable y comienzo del transporte. Un latch corto evita que el cambio de política se intercale entre el registro y el `fetch`; se libera sin un `await` antes de llamar al proveedor. El comando cierra nuevos participantes inmediatamente, espera solo esa sección previa al transporte y persiste transición/constancia antes de esperar una respuesta ya iniciada. La barrera y sus participantes se conservan en el singleton de proceso, incluidos distintos handles de almacenamiento.

Cuota y outbox registran su referencia en el head en la misma transacción que comprueba la política y marca posible despacho. Las escrituras se preparan tras completar las lecturas para respetar Firestore. El head admite 64 referencias y rechaza la siguiente antes del marcador dependiente. En `prepare`, la ausencia legada conserva revisión cero y no genera una referencia que solo tendría sentido tras clasificación; los comandos v2 siguen cerrados y no se crea el marcador de admisión.

Una referencia solo se retira con prueba explícita de transporte resuelto o de cancelación local posterior a un registro confirmado y anterior al `fetch`. Un retorno normal sin reclamar outbox no es prueba. Respuesta completa inválida y rechazo explícito 4xx resuelven transporte sin afirmar éxito de aplicación. Timeout, 5xx y pérdida de ACK conservan incertidumbre; no repiten proveedor. Cuota `completed`, TTL y tiempo transcurrido no resuelven el head. El tratamiento de cuota `mayHaveDispatched` se conserva incluso ante cancelación local probada, sin inventar reembolso ni replay.

La transición captura las identidades existentes y se reanuda por negocio/actor/requestId, sin escaneo global. Revisión y autoridad se revalidan; suspensión administrativa puede reemplazar una retirada pendiente y un finalizador antiguo no pisa la revisión nueva. Un head perdido cuando la transición capturó referencias falla cerrado. Se añadieron controles transaccionales antes de publicar efectos de IA y crear outbox; los guards integrales de reservas siguen en B4.

## Verificación

- `pnpm run typecheck`: exit 0 sobre el código final. Log `.tmp-checks/policy-b2-types-verified.log`.
- `pnpm test --maxWorkers=6`: **4965 pruebas pasan**, 332 archivos; **103 pruebas/10 archivos omitidos** por sus gates de entorno, sin contarlos como pase. Exit 0 sobre el código final tras las correcciones de revisión. Log `.tmp-checks/policy-b2-suite-verified.log`.
- Focal contractual: `pnpm exec vitest run tests/booking-policy-transition.test.ts tests/booking-policy-transition-d1.test.ts tests/engine.test.ts tests/engine-budget.test.ts tests/chat.test.ts tests/response-quota-dispatch.test.ts tests/response-quota-effects-d1.test.ts tests/response-quota-chat.test.ts tests/whatsapp-queue.test.ts`: **94/94**, 9 archivos, exit 0. Log `.tmp-checks/policy-b2-focal-verified.log`.
- `pnpm run test:rules`: **105/105**, 9 archivos, exit 0. Log `.tmp-checks/policy-b2-rules-verified.log`. Incluye contrato compartido en Firestore oficial, accesos directos denegados, handles independientes, transición, reinicio, head completo y carrera exacta previa al fetch. Java 21 portable, PSModulePath de Windows y temporal corto `C:/sarin-b2-tmp`, solo en el proceso.
- D1 usa Workerd/SQLite local real y dos handles; Firestore usa proyectos `demo-*`. Todos los proveedores están controlados; ninguna prueba hace inferencia pagada ni envíos reales.
- RED/GREEN registrado para wrapper ignorado, cuota bajo retirada, publicación tardía D1, outbox tras retirada, suspensión concurrente, rechazo explícito/JSON inválido, callback sin claim y aborto tras registro. Logs `.tmp-checks/policy-b2-*-red.log` y `*-green.log`. El caso exacto previo al fetch ejercita que la transición espera su comienzo sin esperar la respuesta.
- Fallos locales iniciales de `test:rules`: el temporal en E: provoca `MIGRATION_BACKUP_PERMISSIONS` en la captura sintética; un temporal largo rompe sockets locales Java. Se reprodujo el fallo de ACL independientemente y se usó temporal corto en C:, sin cambiar producto ni omitir casos. Esos intentos fallidos no se cuentan como pases.

## Revisión independiente y límites

Revisor `/root/policy_b2_review`, lectura independiente del diff: sin Critical, Important ni Minor pendientes. Se corrigieron la carrera registro/fetch, fuga de referencias ante respuesta resuelta y aborto local, y retirada indebida por callback sin claim; sus regresiones pasan. No hubo cambios ajenos incluidos en la revisión ni aceptación visual atribuida a estos tests.

Decisiones de alcance revisadas, conforme al plan:

1. Declaración/API/texto/proyecciones y aceptación completa de cambio de dueño quedan en B3; aceptarlas aquí certificaría API aún no construida.
2. Guards integrales de reservas/intake/espera, recuperación independiente con política ilegible, replay cacheado y vínculo de revisión de outbox quedan en B4; aceptarlos aquí certificaría admisión/recuperación incompletas.
3. UI, épocas de sesión, corte conjunto y preflight quedan en B5; tratar B2 como `enforce` bloquearía negocios sin su vía de declaración.
4. Aceptación integral de rollback/restore/protocolo queda en B1/B5/I; esta revisión no acredita toda la recuperación.
5. Entrega ordinaria a main/CI se verifica aparte por SHA. Clasificación de negocios, activaciones, inferencias/envíos reales y QA integral conservan sus gates; anticiparlos causaría efectos no autorizados o aceptación falsa.
6. Los archivos locales ajenos se preservan y excluyen; publicarlos incidentalmente mezclaría trabajo de procedencia no revisada.

La entrega remota y sus identificadores se registran en la evidencia canónica de B2 tras comprobar main, CI y release del mismo SHA. Este informe no afirma por sí solo publicación ni aceptación global Fresha.
