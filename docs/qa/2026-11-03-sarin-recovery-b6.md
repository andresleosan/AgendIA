# R0-BACKUP-B6: ensayo sintético de recuperación

Fecha: 3 de noviembre de 2026, America/Bogota. Fuente base: `5e5243cab125bb1b85092cd7f69523d6f3ab4fbf`; cambios B6 identificados por el commit de entrega. Contrato aprobado SHA-256 `0adec33452d4634d0befc66b730b1ee78330a2107b62aa04ce714462cc1d4f3d`. El estado y la entrega remota del candidato exacto se registran exclusivamente en tasks.json de control; este documento no es otra autoridad de progreso.

## Resultado y alcance

`scripts/recovery-drill.mjs --synthetic --directory <nuevo-directorio-privado>` combina captura/saneamiento B1/B2, age B3, D1/R2 local y conciliación B5 con un Auth emulado propio. Reutiliza `verifyD1Backup` para comparar huellas antes de los probes de dominio. Descubre las 13 migraciones actuales, incluidos índices 0014/0015; conserva revisión 7, journal y un objeto R2. No añade un importador remoto ni activa la infraestructura B4.

El reporte declara `partial_closed` y `admission=false`. Se comprobaron corrupción de SQL/manifiesto, evento privado perdido incluso con hash exterior recalculado, objeto ausente/alterado, clave incorrecta/ausente, ciphertext truncado y configuración incompleta. Consentimiento retirado, datos borrados/expirados y política de cliente bloqueada no se reabren. Propuestas cerradas, oferta retirada y trabajo incierto válido permanecen controles no ejecutables, sin desenvueltos permisivos.

Un equipo válido creado por las funciones reales del dominio permite leer antes de la baja. Las invalidaciones del plan se aplican con el adaptador de datos local y transacciones; la lectura comercial queda denegada después. El Worker real también niega lecturas en recuperación sin admisión/testigo. No se usa SQL hardcodeado para simular la decisión comercial.

La fuente demo confirma un recibo después de haber tomado el snapshot. Se verifica que el snapshot carece de ese recibo; al incorporarlo se usa la escritura inmutable `create`, con su período e intento originales. Recuperación y replay conservan exactamente un recibo y no vuelven a cambiar el período. `legacy_unknown` conserva su reserva y queda en revisión; un lease antiguo y los productores reales con capacidades apagadas no disparan un segundo efecto.

Los puntos de llamada de inferencia/audio/generación, envío, confirmación de pago y liberación de cuota se instrumentan solo en el bundle de prueba. Un tripwire positivo verifica que cuentan/rechazan antes de usar sus ceros como evidencia. Se bloquea además cualquier fetch de los probes. No hay API de reembolso financiero en el producto actual: el reporte lo marca no medido, sin inventar un contador cero.

Auth se importa también desde auth.json descifrado: UID/provider estables, usuario disabled rechazado, sesión anterior revocada, login nuevo y ausencia de rol comercial inferido de claims. Las credenciales heredadas del proceso se excluyen durante el ensayo; solo se permite el proyecto demo fijo. El entorno se restituye al finalizar. Se verifican los pins de age y age-keygen antes de ejecutarlos. Las claves sintéticas se eliminan al finalizar; no representan custodia real desde el gestor.

## Regresiones y revisión

- RED inicial: las pruebas no aceptaban el runner incompleto. RED/GREEN adicionales para `lastSignInTime=null` y propiedades SDK opcionales `undefined`; el esquema sigue rechazando campos desconocidos.
- La CLI nativa en Windows falló con `ERR_UNSUPPORTED_ESM_URL_SCHEME`: Vite ocultaba las rutas externas con letra de unidad. Se usan URLs file y se añadió una prueba de CLI con el cargador nativo de Node.
- Revisión independiente `review_recovery_b6`: tres Important sobre recibo posterior, autoridad comercial y contadores sin instrumentar. Los nuevos escenarios fallaron antes de sus correcciones; los probes verifican los efectos descritos arriba. La observación de pin de keygen se elevó a Important porque se ejecutaba un binario vecino; se añadió verificación y regresión de binario alterado. Sin hallazgos menores diferidos.
- Durante la corrección, el Worker rechazó correctamente un `set` de recibo: el fixture se corrigió a `create`, conservando la protección inmutable del producto.

## Comprobaciones locales

| Comprobación | Evidencia |
| --- | --- |
| Simulacro y captura de componentes | 36 pruebas aprobadas, incluida CLI independiente y dos regresiones SDK. |
| Migración, equipo D1, espera D1 y cuota | 60 pruebas aprobadas. El primer intento tuvo un fallo previo de carga de Microsoft.PowerShell.Security; pasó con PSModulePath de Windows PowerShell. |
| Worker | 196 pruebas aprobadas, TypeScript y Wrangler dry-run aprobados. TEMP/TMP locales en E para los fixtures de configuración existentes; no efecto remoto. |
| Tipos de aplicación y build | Aprobados. |
| Coordinador | 20 pruebas aprobadas; 175 tareas, 165 requisitos y B6 como única tarea actual. |
| Suite acumulada | 328 archivos aprobados, 9 omitidos; 4.929 pruebas aprobadas y 89 omitidas, 551,23 s con maxWorkers=2. La última ejecución focal independiente vuelve a aprobar las 7 pruebas de B6 tras el refuerzo de política de cliente. Los cambios locales previos de tests de Windows se conservaron sin incluirlos en el commit; CI valida el árbol exacto entregado. |
| Firebase rules local | Bloqueada por el Java 21 de Windows al crear sockets UnixDomainSockets/Netty, antes de ejecutar pruebas. Se requiere el job Linux de CI del candidato; no se convierte este intento en aprobado. El runner de emuladores registra explícitamente el nuevo caso Auth de B6. |

El primer CI de `c5513e8` detectó audiencia incorrecta en el nuevo test Auth: la aplicación del test usaba otro proyecto demo que el emulador compartido. Se alineó con `demo-sarin-recovery-auth` sin cambiar la validación de revocación. Un ensayo Auth-only con `firebase-tools emulators:exec`, sin necesitar Java/Firestore local, aprobó ambos casos Auth (2/2). El siguiente CI debe acreditar nuevamente el conjunto completo y el candidato de esa corrección; el CI fallido no acredita entrega.

Primera CLI nativa satisfactoria: 20 casos, 46.906 s, 85.319 bytes de componentes y 102.371 bytes de ciphertext, en un directorio nuevo bajo el área privada local de QA. Reporte SHA-256 `e6cdd28315cdb4dbf6112ccee51d4dbf86a91d0854d8d074c64a9a6815ff63c1`. Esa ejecución precede al ajuste que incluye el tiempo transcurrido en la edad observada y a la última comprobación explícita de política de cliente; las comprobaciones finales y su alcance se registran por separado. Ningún tiempo de fixture demuestra RPO/RTO de producción; safeOpenRtoMs permanece null.

## Límites operativos

El runbook documenta siete pasos de incidente, RPO 24 h/RTO 8 h desde inicio, custodia/rotación, política 7/4/3, diaria a las 02:00 Bogotá, dos reintentos, avisos 20/24 h, pre-change y ensayo privado mensual. La fuente diaria Auth/config/hash config, recursos, permisos, coste, testigo vigente, custodia desde otro equipo, primer set privado, apertura y cualquier efecto real siguen pendientes de operación explícita. La entrega normal de código a main/CI no los activa ni acredita QA integral Fresha.
