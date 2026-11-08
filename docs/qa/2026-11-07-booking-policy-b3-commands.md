# R0-POLICY-B3: declaración del dueño y administración

Fecha: 7 de noviembre de 2026, America/Bogota. Entrega preparatoria del contrato de admisión; el corte conjunto sigue en B5.

## Identidad y alcance

- Base: `13b2cd8e6f883b2aa4b85b821be11daa9e30c819`, main consultado en vivo antes de cambiar producto.
- Producto: `E:/Proyectos/SarinBot-worktrees/fresha-implementation-20261030`. Estado canónico solo en `E:/Proyectos/Sarin Bot/docs/implementation/fresha/tasks.json`.
- Contrato aprobado: `docs/superpowers/specs/2026-10-30-booking-policy-admission-design.md`, SHA-256 `f828ff1ad95e7c02cbed837f36d1143399eaeaf5cab54d9f43a86c5dcf7c4ac9`.
- Subplan: `docs/superpowers/plans/2026-10-30-booking-policy-admission.md`, SHA-256 `bebb9f8b3760351c954dfa9fb22391230b457ad0ea2163ac06f45d28b328a8bb`, Task 3.
- Diff de los 12 archivos propios de código/pruebas, sin este informe: SHA-256 `ee34b1ce9ea4730d7224243a10b6a2cfe6413545d0e3cbdc3124037b54c2e25c`, copia `.tmp-checks/policy-b3-code.diff`.

Los comandos aceptan solo los campos declarados. El dueño declara general/adultos con texto versionado o retira su propia declaración; propiedad, revisión y restricciones administrativas se comprueban dentro de la transacción que escribe política y constancia. El UID y la fecha proceden del servidor. Declarar no habilita salud ni menores. La retirada no depende de intake compatible y conserva la configuración del negocio.

Se reutiliza la transición durable B2. El hash de la constancia se vincula al input público normalizado para que el replay sobreviva a cambios posteriores del target, incluidas retirada, nueva declaración y suspensión. Un requestId con otro cuerpo falla. Un ACK perdido se resuelve consultando la constancia y reanudando la misma identidad; no se supone éxito ni se genera una nueva revisión. Se vuelve a comprobar propiedad también al recuperar y devolver el resultado.

GET/PATCH de declaración son exclusivos del dueño; PATCH admite hasta 4096 bytes, sin query, con 200 aplicado o 202 pendiente. GET puede mostrar la identidad segura de la transición propia. La vista del dueño omite razones, UID del actor y hash privado; la capacidad autenticada existente sigue proyectando solo capacidad. La API administrativa conserva política completa para superadministración y usa comandos classify/suspend/resume en enforce. Solo resume levanta una suspensión.

En producción continúa `BOOKING_ADMISSION_RELEASE=prepare`: los nuevos endpoints y escritores v2 están cerrados; el PATCH administrativo legado sigue escribiendo v1. Ese escritor se cierra al pasar a enforce. B3 no crea el marcador, no clasifica negocios reales ni publica todavía el requisito global. Los ocho elementos locales preexistentes se excluyen de la entrega.

## Pruebas y revisión

RED inicial de comandos: implementación vacía deniega casos que requieren declaración/retirada/replay; log `.tmp-checks/policy-b3-red.log`. RED de rutas: API administrativa aceptaba input legado en enforce y GET no mostraba la identidad pendiente; log `.tmp-checks/policy-b3-routes-red.log`.

Revisión independiente `/root/policy_b3_review`: ningún Critical ni Minor. Un Important: el dueño que coincide con SUPERADMIN_UID podía eludir límites owner por el rol global. Regresión RED en `.tmp-checks/policy-b3-review-red.log`; corrección en la barrera común para aplicar las restricciones según la acción declare/withdraw, independientemente de su rol. La regresión forma parte del contrato compartido de memoria, D1 y Firestore.

Los casos compartidos cubren declaración/recibo/revisión, actor ajeno y superadmin no dueño, reintento después de retirada y redeclaración, cuerpo distinto, retirada con intake, suspensión/reanudación, cambio de dueño entre lectura inicial y escritura, CAS concurrente, suspensión que gana a una declaración, nuevo dueño sin constancia anterior y ACK perdido. D1 utiliza Workerd/SQLite real y dos handles; Firestore usa el emulador oficial con dos handles y proyectos demo-*. Las pruebas de navegador a serverSettings siguen denegadas.

- Focal final: `pnpm exec vitest run tests/booking-policy-commands.test.ts tests/booking-declaration-routes.test.ts tests/booking-data-policy-routes.test.ts tests/booking-admission-d1.test.ts tests/booking-policy-transition.test.ts tests/booking-policy-transition-d1.test.ts`: **51/51**, 6 archivos, exit 0. Log `.tmp-checks/policy-b3-focused-verified.log`.
- `pnpm run test:rules`: **116/116**, 9 archivos, exit 0 sobre código final. Log `.tmp-checks/policy-b3-rules-verified.log`. Java 21 portable y temporal corto en C:, PSModulePath de Windows solo en el proceso; no se modifica el entorno global.
- `pnpm run typecheck`: exit 0. Log `.tmp-checks/policy-b3-types-verified.log`.
- `pnpm run build`: exit 0; incluye la nueva ruta dinámica. Log `.tmp-checks/policy-b3-build.log`.
- `pnpm test --maxWorkers=6`: **4994 aprobadas**, 334 archivos; **114 pruebas/10 archivos omitidos** por gates de entorno, sin contarlos como pase. Exit 0 sobre código final estable, log `.tmp-checks/policy-b3-suite-verified.log`.
- El primer arranque de reglas falló por Java ausente del PATH; se reutilizó el JDK existente. La primera suite general terminó con dos fallos de la regresión nueva (memoria/D1) al compilar código anterior a la corrección; logs `.tmp-checks/policy-b3-suite.log`. Esos intentos no acreditan un pase. La repetición final usa el código estable y se registra aparte.
- Las validaciones locales preservan el árbol con cambios ajenos; la CI remota comprueba por separado el árbol versionado exacto. La suite general omitida no acredita Firestore: su evidencia es la ejecución oficial de 116 casos indicada arriba.

## Límites revisados

1. Recuperar citas/consentimientos con política ilegible y guards integrales corresponde a B4; aceptarlos aquí acreditaría rutas todavía no integradas.
2. Respuestas de otra época de sesión y declaración visible corresponden a B5; esta entrega solo define la API y texto compartido.
3. Transporte incierto/reinicio conserva B2 y sus pruebas focales; el cierre B3 no sustituye integración B4 ni QA integral.
4. Rollback/snapshots y corte conjunto corresponden a B5/I; B3 permanece prepare para no bloquear negocios sin vía completa de declaración/recuperación.
5. Main, CI y despliegue se comprueban por el mismo candidato antes del cierre canónico. No hay clasificación real, inferencias pagadas, mensajes, exportación/restauración ni activación de capacidades.

La identidad del commit, main, CI y despliegue se registra en la evidencia canónica de B3 tras comprobar el mismo SHA. Este informe por sí solo no acredita publicación ni aceptación global Fresha.
