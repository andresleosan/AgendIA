# R0-BACKUP-I: integración de recuperación

Comprobación del 5 de noviembre de 2026, America/Bogota. La fecha del nombre conserva la ruta del subplan. El progreso y la entrega remota exacta se registran exclusivamente en `tasks.json` del control; este informe no es otro estado mutable.

## Identidad y alcance

Contrato aprobado SHA-256 `0adec33452d4634d0befc66b730b1ee78330a2107b62aa04ce714462cc1d4f3d`; subplan SHA-256 `05af95415d6931babaeec837e6d209ede6f7c05dab1c781940ba2e3759d45f33`. Ambos coinciden con la autoridad de control. Base de esta integración: `933f078d7fa8abf27dec8428f0d6a5961c6c8899`, tree `7a1b70cdb2fc62593e4673510285ceeda7864920`.

Se integran B1 a B6 existentes, todos ancestros de esa base: clasificación/formato, captura, age, coordinación/retención, testigo/admisión y ensayo/runbook. No se usa el formato JSON de migración como SQL de recuperación. Las 13 migraciones conservan sus hashes; no se crean ni aplican migraciones de datos o control. Los 165 mappings permanecen intactos y ningún requisito Axx se resuelve por este soporte.

El diff de las cuatro fuentes/pruebas propias tiene SHA-256 `47f0d6128c5aa5399f1ecc0bc2cc1b2c0cab3f85839dfdebabe6f9e5263c572f`. El SHA base no incluye ese diff: el commit de entrega y su CI deben consultarse en la evidencia final del control. Cambios previos en AGENTS, next-env, cuatro tests, DESIGN y temporales quedan fuera de la entrega. La suite local incluye esos tests previos; CI valida el árbol limpio que se publique.

El manifiesto privado `candidate-files.json` inventaría las 33 fuentes de producto/tooling afectadas desde e20d602, con SHA-256 de cada archivo: hash del manifiesto `5ab28ff1407c5eeea7781643434bcbc4d3d9cccb2c4b963cb651a02befc58daa`. El hash del arreglo completo requirements es `854673e925889ebd0a3db70f80100a5f86b9e4ccbeedc66426743261f7c09821`; graph-audit verifica estados y ascendencia de toda la evidencia de B1 a B6.

## Revisión y correcciones

Revisión independiente de `e20d602..933f078`, agente `review_recovery_integration`: tres Important, sin Critical. Se corrigieron con RED observado y GREEN focal:

- Consentimientos: categorías `scope`, `dataMode` y acciones desconocidas se rechazaban de forma incompleta. Se enumeran las categorías vigentes en estados, recibos y documentos anidados, manteniendo recibos históricos válidos con IDs no canónicos.
- Retención: antes de borrar conjuntos sellados, la limpieza exige un conjunto conservado con sobre válido, referencias completas y ciphertext legible cuyo hash y tamaño coincidan. Si falta, está corrupto o R2 no responde, devuelve dry-run bloqueado sin borrar. El nombre `latest-sealed` describe la selección temporal; no afirma recuperabilidad. No descifra ni acredita custodia real.
- WhatsApp: el límite genérico de 12.000 caracteres impedía sanear historiales cifrados válidos. Se usan los límites del sobre vigente, hasta 400.000 caracteres, sin admitir campos nuevos ni retener cuerpos.

Clasificación: 14/14; prueba con cifrado real local y campos desconocidos. Retención: 22/22 en el archivo completo; las cuatro regresiones nuevas construyen/sellan mediante el protocolo real y prueban supervivientes ausentes, corruptos, no disponibles y sanos. El RED de limpieza inicial por fixture incompleto no se cuenta como reproducción; el RED válido posterior mostró tres borrados indebidos y el caso sano aprobado.

Decisión técnica: los notification_intents de soporte conservan su forma, pero no tienen dispatcher independiente y sus jobs/outboxes referenciados son controles no ejecutables rechazados por los parsers vivos. La revisión no encontró una vía de reenvío. No se cambia ese formato por una hipótesis; si aparece un consumidor independiente, deberá mantener el mismo cierre. Riesgo: ningún sello sustituye conciliación ni permiso de apertura.

## Matriz de los ocho criterios

| Criterio aprobado | Evidencia del candidato y límite |
| --- | --- |
| Esquema, journal, cuota, índices 0014/0015 | CLI nativa y `recovery-drill.test.ts`: 13 migraciones, revisión 7, journal de un commit, índices de cuota/paginación e integridad SQLite; formato y protocolo preservados. |
| SQL/manifiesto/R2/evento privado | Rechazo de SQL/manifiesto alterados, evento perdido aun recalculando hash exterior, objeto ausente/alterado. Formato/componentes comprueban también tamaño, tipo, lote e inventario. |
| Baja/revocación y falta de evidencia | Testigo independiente, huecos/pending y modo recuperación cierran acceso; lectura comercial permitida antes de la baja y denegada tras aplicar conciliación con dominio/almacenamiento reales. |
| Consentimiento, borrado, expiración, propuesta/oferta | CLI verifica retirada de consentimiento, supresión/expiración y oferta/propuesta cerradas; regresiones rechazan discriminadores sensibles nuevos. No se recrea autorización desde una copia. |
| Incierto, recibo posterior, cero efectos | Recibo ausente del snapshot añadido con create inmutable y replay único; legacy_unknown conserva reserva/revisión. Tripwire positivo valida contadores antes de comprobar cero inferencias, envíos, pagos y liberaciones automáticas de cuota. No hay API de reembolso financiero: se declara no medido. |
| Auth/disabled/configuración | Auth emulado, UID/provider, disabled, token antiguo revocado, login nuevo sin rol y configuración incompleta. Reglas/emuladores ejecutan 91 casos, incluidos los dos de Auth de recuperación. |
| Claves/ciphertext/R2 local | age 1.3.2 con pins de age y keygen en Windows; CLI cifra/descifra desde almacenamiento local, falla con clave ausente/incorrecta y ciphertext truncado. Vector Linux offline con hashes fijados, 38 bytes exactos recuperados; no prueba recuperación del gestor del propietario. |
| Tamaños/tiempos/límites | Ensayo corregido: 25.081 s, 85.425 bytes de componentes, 102.530 bytes cifrados; edad máxima 26.081 s incluyendo ejecución. safeOpenRtoMs=null, recovery=partial_closed, admission=false; no extrapola a RPO/RTO de producción. |

Reporte privado del simulacro corregido SHA-256 `7f5c744eb86244adda40dfae76bff62789b0023bfb5ea7be19778c5ee327a5a6`, bajo `%LOCALAPPDATA%/SarinBot/qa/recovery-integration-20261105`. El reporte identifica la base Git; el diff y los hashes de archivos identifican las correcciones ensayadas antes del commit. No se versionan SQL, exportaciones, claves o identidades demo.

## Comprobaciones acumuladas

Todos los comandos de producto corren en el worktree aislado `E:/Proyectos/SarinBot-worktrees/fresha-implementation-20261030` con Node 24.22.1 y pnpm 11.23.0. Los logs privados y sus hashes se conservan en el área anterior.

| Check | Resultado |
| --- | --- |
| `pnpm run typecheck` | Exit 0 sobre fuentes finales. |
| `pnpm test --maxWorkers=2` | 4.932 pass, 89 omitidas; 328 archivos pass, nueve omitidos; exit 0 en 443.80 s. Las omisiones no se cuentan como prueba. El intento inicial interrumpido durante las correcciones no es aceptación. |
| `pnpm run test:rules` | 91/91, ocho archivos, cero omitidos, exit 0, 197.53 s. Primera ejecución: 90 pass y un timeout de transacción en reserva simultánea; repetición con VITEST_MAX_WORKERS=2, sin cambiar pruebas ni timeout. |
| `pnpm --filter sarin-cloudflare-host run check` | 200/200, tipos estrictos y Wrangler dry-run, exit 0. Archivo focal de retención repetido tras usar uploads reales: 22/22. |
| `pnpm run build` / `pnpm run build:pages` | Ambos exit 0; Pages construye y valida landing/gateway. |
| CLI `recovery-drill.mjs --synthetic` | 20/20 casos, cero efectos, exit 0; mediciones arriba. |
| Docker | Imagen final compilada con configuración Firebase pública demo; módulos importados offline, 13 migraciones, binario age verificado, POST falsificado al endpoint apagado=404, un servidor Node. |
| age Linux | Etapa Docker recovery-age construida, Sigsum/pins verificados; vector offline exacto con age y keygen fijados. |
| Coordinador | 20/20, 175 tareas/165 requisitos válidos; R0-BACKUP-I es la única activa. |

Entorno local: PSModulePath de WindowsPowerShell solo en procesos de pruebas de ACL; TEMP/TMP del check Worker en E para su fixture existente; Java 21.0.12+8 externo ya instalado, con ruta temporal UnixDomainSockets en E e IPv4 solo en el proceso. No hay cambios globales de entorno. Docker Desktop se inició para estas comprobaciones.

## Apagado y bloqueos operativos

La configuración efectiva emitida por Wrangler no añade SARIN_RECOVERY_DB ni SARIN_BACKUPS. runtimeEnvironment mantiene SARIN_BACKUP_ENABLED=false por defecto, no pasa export token/cleanup/testigo al Node y deshabilita capacidades en recuperación. Las pruebas comprueban rechazo de headers públicos de backup/recovery y cron cerrado. El Docker runtime contiene age, sin keygen ni clave privada; sigue siendo un único servidor. La plantilla de recursos no se aplicó. No se inventaría aquí si existen recursos externos no vinculados.

Antes de operar siguen pendientes: recursos D1/R2 dedicados y permisos, custodia/recuperación del gestor y 2FA desde otro equipo, destinatario y configuración privada vigentes, inventario/export Auth y password/hash config con su refresco diario, inicio del testigo tras corte drenado, primer conjunto privado y ensayo autorizado, conciliación y apertura concretas. El productor no obtiene claves privadas ni permisos Auth/IAM para suplirlos.

RPO 24 h y RTO 8 h son objetivos. La diaria a las 02:00 Bogotá, dos reintentos de 15 minutos, alerta 20 h/incumplimiento 24 h, pre-change, mensual y retención 7/4/3 constan en el runbook. Coste total máximo USD 15/mes: almacenamiento/operaciones/tiempo reales y margen del horario deben medirse con tamaño autorizado antes de activar. Este fixture no acredita ese coste ni esos plazos.

No se activan flags, cron, limpieza, testigo, recursos, transporte o apertura; no exportación/restore real, inferencias pagadas, mensajes o cobros. sealed/restore_verified operativo y QA integral Fresha siguen pendientes de sus tareas finales. La entrega de código ordinaria a main/CI se comprueba por el SHA exacto antes de cerrar esta tarea. La continuación prevista es R0-POLICY-D, exclusivamente en otra invocación.
