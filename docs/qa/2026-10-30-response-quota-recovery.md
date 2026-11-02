# Recuperación de cuota: evidencia de implementación

Implementación y validación realizadas el 2 de noviembre de 2026. Alcance: R0-QUOTA-B1, B2, B3, B4, B5 e I. Base: `889017457801759e44835b723d8e0c26aa3e6baa`. El estado canónico continúa exclusivamente en el checkout de control; este documento no es una segunda lista mutable de tareas.

El usuario aprobó consumir una unidad si la llamada pudo iniciarse y permitir conciliación auditada de históricos exclusivamente al superadministrador. Después solicitó implementar las cinco construcciones y la integración continuamente, validar y hacer commit/push para probar en producción. Esa instrucción sustituye el límite de una tarea por invocación para este lote. No autoriza conciliar reservas reales, reenviar WhatsApp ni afirmar aceptación de todo Fresha.

Contrato aprobado: `docs/superpowers/specs/2026-10-30-response-quota-recovery-design.md`, SHA-256 `b7d9192b7b351e60689b8c592b8a92c32e9baca497ede5a27214a2b2e74c90ad`. Subplan aprobado: `docs/superpowers/plans/2026-10-30-response-quota-recovery.md`, SHA-256 `5fa46e82c656f1d0a01228f267b7421fad3f689d92a62c6938629b876baacbb8`. Se conservaron sus bytes, incluidos sus textos históricos de aprobación pendiente; la aprobación efectiva está vinculada por hash en el control.

## Resultado y cobertura

La reserva persiste su deadline de admisión y su intento. El transporte solo puede empezar después de ganar una marca durable. La liquidación usa el período original y un recibo inmutable; la repetición valida identidad, fingerprint, decisión y cerca. Propuestas, selección y outbox preparan y aplican la cerca en sus transacciones. Node y Worker usan las mismas reglas puras; el mantenimiento no infiere ni envía.

| Caso del contrato | Evidencia ejecutable |
| --- | --- |
| 1. Crash y ACK perdido | dispatch/store/D1/chat tests; contrato común pierde el ACK después de confirmar la marca y obtiene cero llamadas al proveedor en el reintento. |
| 2. Concurrencia y último cupo | dos handles reales D1 y Firestore; un solo ganador de despacho, liquidación concurrente, handle de intento anterior rechazado; pruebas previas de último cupo conservadas. |
| 3. Marca incierta | recibo y consumo único aun con cero fetch; prepared vencido devuelve y bloquea al ejecutor anterior. |
| 4. Fallo y revocación | chat tests de error posterior a despacho y revocación antes/después del estado; contrato común niega el efecto compuesto tras revocación y permite cierre técnico. |
| 5. Cache perdida y prueba original | texto perdido no reanuda inferencia; propuesta confirmada después de fallo de settlement y reinicio conserva su prueba original y muestra la cita actual autorizada. |
| 6. Períodos, restore y rollback | extras concurrentes conservados; restore sintético real D1, reverse roundtrip, identidad/marca/recibo/review; allowlist anterior rechaza todo el batch sin escribir parcialmente. |
| 7. Conciliación | cliente/dueño/staff denegados; superadmin no puede inventar no despacho; histórico retenido por edad y consumo auditado idempotente sobre ambos backends. |
| 8. Contrato S03 | identidad nullable adopta intento original; ausencia devuelve pending; preparación sin writes y aplicación sin reads; consumidor sintético compuesto. No implementa la bandeja futura. |
| 9. Privacidad y acceso | schemas strict, límites/no-store en ruta, SDK real deniega attempts/receipts/reviews incluso con claim de admin; contabilidad sin cuerpos. |
| 10. Proveedor lento | cierre gana contra propuesta/estado tardíos; efecto ganador conserva su prueba; guard final impide publicación tras revocación posterior a guardar estado. |

El contrato común registra diez casos para D1 y los mismos diez para Firestore Admin. La prueba de rollback ejecuta el Worker actual con la allowlist anterior que desconocía recibos/reviews; no se presenta como ensayo de la imagen binaria antigua completa. El restore es sintético, local y en destino vacío; no prueba una restauración de producción.

## Verificación

Resultado final antes del commit, con el código congelado tras las correcciones:

| Comando | Resultado observado |
| --- | --- |
| `pnpm test --maxWorkers=2` | Exit 0; 316 archivos pasan, 7 omitidos; 4.817 pruebas pasan y 81 omitidas. 336,58 s. Las optativas omitidas no cuentan como pase; Firestore se ejecutó aparte. |
| `pnpm run test:rules` | Exit 0; 79/79, cinco archivos; incluye los diez casos nuevos sobre Firestore Admin y denegaciones SDK. 157,69 s. |
| `pnpm --filter sarin-cloudflare-host run check` | Exit 0; 169/169, tipos y dry-run Worker aprobados. |
| `pnpm run typecheck` | Exit 0. |
| `pnpm run build` | Exit 0, Next 16.4.3. |
| `pnpm run build:pages` | Exit 0; landing validada, 41 archivos, gateway preparado. |
| `node --test pages-gateway/tests/*.test.mjs` | Exit 0; 25/25. |
| `pnpm audit --audit-level=high --json` | Exit 0. |
| Contrato común D1 focal | 10/10; forma parte de la suite general, no se suma a su total. |
| Integración y restore focal | 28/28 antes de ampliar el contrato común; restore real D1 y roundtrip sin pérdidas. |

Logs privados de la sesión fuera de Git: `%TEMP%/quota-*.log` y `E:/Proyectos/.quota-java-tmp/quota-worker-check.log`. Node 24.22.1, pnpm 11.23.0; lockfile conservado. Los siete archivos protegidos anteriores permanecen byte a byte: AGENTS, DESIGN, lockfile y cuatro tests previos; no se incluyen sus cambios ajenos en este commit. El build genera next-env.d.ts; se conserva su versión anterior fuera del commit.

La primera ejecución de reglas reveló que congelar Date.now interfiere con locks/reintentos del SDK real. El contrato Firestore usa reloj real y deadlines sintéticos explícitos. El JRE 21 existente necesitó una ruta temporal corta mediante `JAVA_TOOL_OPTIONS` para el socket loopback de Java en Windows. La comprobación de ACL de backups necesitó el PSModulePath de Windows PowerShell; el test no se omitió. El check Worker necesitó TEMP/TMP en el mismo volumen E: para su prueba preexistente de ruta relativa de Wrangler. Son ajustes del proceso de prueba, sin cambios globales ni reducción de garantías.

La revisión independiente encontró dos P2: usar la cita recuperada en lugar de la prueba original de propuesta, y dejar que un fallo de recuperación de cuota impidiera otro mantenimiento. Ambos tuvieron regresión RED/GREEN; la revisión posterior confirmó las correcciones. La suite Worker descubrió además la incompatibilidad de parameter properties con Node strip-only y la distinción entre revisión de datos ausente y revisión concurrente; ambas se corrigieron conservando los tests existentes. La integración añadió RED/GREEN para impedir replay/re-reserva si falta o cambia el recibo terminal restaurado.

Ruling: el barrido de vencidos vuelve a la cabeza indexada en cada tick, en lugar de guardar dos rangos y otro cursor. Los terminales desaparecen y los históricos se retienen fuera de vencidos; así no se pierden llegadas anteriores al cursor. El cursor de descubrimiento sí es durable. La prueba de 1.001 empates conserva el presupuesto de 50 visitas.

## Aviso de consumo y filtro antislop

Modo during por elección explícita de sesión. Dirección: Agenda clara, DESIGN.md; solo cambia el aviso aprobado, sin recursos gráficos, navegación ni controles nuevos. Diales del alcance: ENERGY 1, RHYTHM 1, MOTION 1; texto informativo estático, jerarquía y acento existentes. Propósito: explicar el consumo ante interrupciones antes de usar IA.

Gate limitado al diff del aviso, no a toda la interfaz histórica:

- PASS R-02: texto aprobado sin raya larga.
- PASS R-03: párrafo en flujo normal, sin ancho fijo ni truncamiento. Playwright MCP comprobó el texto aislado con los tokens existentes a 320, 390 y 1.280 px: cero overflow, alturas 48/32/16 px. Es un smoke de ajuste, no una visita a la aplicación autenticada.
- PASS R-17/R-18/R-23/R-36/R-38: no estadísticas, testimonios, assets ni afirmaciones nuevas sin fuente; copy vinculado a la regla aprobada y probada.
- PASS R-24/R-26/R-32/R-35/R-39: cero elementos interactivos añadidos; no hay click-through nuevo que ejecutar. Renders en cuota, configuración y recepción; build Next ejecutado.
- PASS R-25: token existente `sarin-muted` (#52617d) sobre paper/canvas (#ffffff/#f7f9ff), ratios calculados 6,24:1 y 5,93:1, AA para texto normal.
- PASS R-27/R-28/R-34/R-40: no FAQs, temas, medios ni scripts nuevos; estados existentes de pendientes/interrupción probados; rendimiento de campo no medido.
- PASS R-33: cambios escritos directamente en los componentes fuente.
- PASS R-01/R-04/R-06/R-07/R-08/R-09/R-10/R-12/R-13/R-14/R-19/R-22: ninguna técnica decorativa añadida.
- PASS liveliness/R-37: dirección declarada; el aviso queda subordinado a la tarea principal con el espaciado, acento y voz existentes; no crea una pantalla.
- PASS C-1/C-2/C-3/C-4/C-5 y R-05/R-11/R-15/R-16/R-20/R-21/R-29/R-30/R-31: se conserva el sistema existente y se añade únicamente información necesaria para el consumo; no hay CTA, plantilla, paleta o diseño nuevo.

La campaña integral Playwright MCP de Fresha sigue después de BUILD-FREEZE. Los tests de render y la comprobación acotada del aviso no la sustituyen.

## Publicación y límites

El marcador no se crea con la migración ni con el build. Se aplica el [runbook](../runbooks/response-quota-recovery.md) después de verificar la barrera del escritor anterior. Mantener una sola réplica. No usar el binario v1 como rollback después de habilitar v2. No se presenta un push como prueba de producción hasta verificar el SHA remoto y el resultado del release.

Preflight remoto de lectura: main/Worker en `8890174`, Container v45 con una sola instancia activa y sin rollout; 12 turnos históricos, cero reservados, marcador aún ausente. Se exportó D1 a directorio privado fuera de Git y se reabrió en SQLite: integridad ok, 371 documentos, 438.570 bytes, SHA-256 `aa2df86a8e06bdb2b2b46a5999ce8ba503c1f3f7c98d6fb4a1a39b97fc9bbac0`. R2 no cambia en este incremento. La solicitud de activación preparada modifica únicamente el marcador privado y el journal/revisión transaccional; no ajusta contadores reales ni concilia históricos. La evidencia remota posterior, con SHA, versión e instante de corte, se agrega al control canónico tras el release.
