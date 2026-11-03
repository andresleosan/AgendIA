# Mis citas: paginación e integración

Fecha: 2 de noviembre de 2026, America/Bogota. Base reconciliada: `f2f76121b412be284fc7f08d76b8c8e71b56a00a`. El candidato es el commit que contiene este informe; su SHA y las identidades remotas se registran al entregar en el estado canónico del checkout de control y en el paquete privado de evidencia.

## Alcance y aprobación

El propietario aprobó el contrato y pidió completar desglose, implementación, validación, commit y push para probar en producción. Se ejecutaron R0-PAGE-P, B1–B4 e I en el worktree aislado existente. `docs/implementation/fresha/tasks.json` del control sigue siendo la única autoridad de progreso; no se copió al worktree.

El contrato aprobado conserva SHA256 `eab913c85e06b78ef648031f8cb4ade1b7dbbf070278d6e697da5d0eee7a6064`. Sus checkboxes/prosa histórica no son otro estado mutable. Esta entrega no acepta los 165 requisitos Fresha ni ejecuta la tarea siguiente de copias.

## Resultado

- POST privado `/api/businesses/:id/appointments/query`: páginas de20 y centinela21, vistas Próximas/Historial/Calendario, orden por inicio e ID, fecha colombiana, cursor de15min, ancla comprobada y autorización por UID.
- GET privado por ID propio para fuente activa, resultado, recordatorio y acciones; no depende de pertenecer a la página. El GET antiguo `view=mine` devuelve409 `CLIENT_APPOINTMENTS_UPGRADE_REQUIRED` y pide recargar.
- Próximas filtra en almacenamiento `confirmed/endAt>asOf`, incluyendo citas en curso; Historial combina cinco streams disjuntos con máximo105 candidatos. Calendario usa el rango de inicio del día colombiano. No hay consulta global auxiliar ni truncado silencioso a1.000.
- Una página visible, pila de cursores y metadatos de IDs visitados. Cambios de fondo/409 conservan lectura y ofrecen Actualizar citas; una continuación fallida conserva la página anterior y puede reintentarse. Se detectan orden invertido, scope ajeno y repeticiones observadas.
- Fuente de reprogramación y una selección/resultado se comprueban por ID, con polling independiente acotado. La falta de una fila parcial no invalida operaciones inciertas ni su identidad.
- Los recordatorios mantienen su consulta propia de24h/máximo100; Ver cita comprueba el ID. Conocimiento canónico nuevo invalida una ocurrencia anterior, y desconocido no significa cancelado.
- Cancelar/reprogramar comprueban la cita antes de la mutación existente. PNG/ICS comprueban por ID antes de generar y antes de descargar; una navegación posterior descarta el resultado pendiente. Se conserva el mutex propio y se excluyen contactos/respuestas privadas de los archivos.
- El chat resume máximo20 próximas y remite a Mis citas cuando hay continuación, sin una inferencia adicional.

No hay snapshot retenido entre páginas. Una modificación no observada puede dejar huecos; los metadatos visitados no detectan todo cambio. Las cotas anteriores limitan documentos/candidatos devueltos, no prueban un coste constante de entradas de índice. Ningún fingerprint es autenticación.

## Validación observada

- Tipos: `pnpm run typecheck`, salida0.
- Suite completa final: `pnpm test --maxWorkers=2 --reporter=verbose`,4849/4849 aprobadas,87 omitidas,321 archivos aprobados/8 omitidos,654,31s, salida0. Las85 pruebas de emulador y el recorrido local se ejecutaron por separado; la prueba opcional live de IA no se ejecutó. Un caso local previo del propietario no se incluye en el commit, por lo que CI limpio puede contar un caso menos.
- Firestore oficial/Admin: `pnpm run test:rules`,85/85 en6 archivos, incluidos seis casos nuevos sobre dos handles. D1 real/Workerd: siete casos de paginación con999/1000/1001, empates, estados mezclados, muchos históricos y una próxima, in-progress, medianoche, ancla, ID canónico y EXPLAIN de consultas emitidas.
- Interfaz/controlador/exportaciones/recordatorios/mutex:154/154 en9 archivos tras las correcciones de revisión. Otros consumidores públicos y entrada de reprogramación:45/45 en3 archivos. Integración real del handoff tras espera y revocación:38/38 en4 archivos. No se suman estos recuentos: hay solapamiento.
- Migración de datos: snapshot de citas/ancla a SQL D1 vacío; el cursor continúa y el lookup propio funciona sin documentos de estado de paginación.
- Worker:169/169, tipos y dry-run. Gateway:25/25. Builds Next, landing, validación landing y Pages completados. Auditoría con umbral high: salida0; dos avisos moderados existentes.
- Recorrido HTTP real local con Auth/Firestore oficiales:129 comprobaciones, limpieza de su espacio sintético verificada; sin inferencia ni transporte externo.

Logs y capturas están fuera de Git, bajo `%LOCALAPPDATA%/SarinBot/qa/client-pagination-20261102` y la salida privada Playwright MCP. Los cambios previos del propietario y el lockfile se comprueban por hash y se excluyen del commit.

## Revisión y regresiones

Un revisor independiente examinó el cambio completo, sin modificarlo ni delegar:0 críticos,3 importantes,0 menores. Los tres importantes se reprodujeron en RED y pasaron en GREEN:

1. Selección fuera de página sin refresco: polling del único ID seleccionado y aviso ante pérdida de verificación.
2. Lookup tardío que deshacía la navegación: generación de interacción, sin restaurar selección/foco después de Siguiente/Actualizar/cambio de vista.
3. Archivo preparado que se descargaba después de navegar: guardas de interacción después de cada await y liberación del mutex adquirido.

Una regresión adicional del workspace real, reproducida con una lectura por ID demorada, mostró que el bloqueo de lectura volvía falso el permiso visual antes del handoff. La aceptación ahora comprueba los permisos actuales separados del estado visual de ese bloqueo y sigue comprobando el mutex sin un await entre liberar y transferir. Casos con consentimiento vigente y revocado pasaron tras el RED observado.

También se observaron y corrigieron las regresiones de continuación fallida, respuesta que retrocede, duplicación de un ID movido y tarjeta seleccionada tras401. Las pruebas antiguas se adaptaron al contrato de página/lookup, manteniendo los casos de autoridad y acciones retenidas. La fixture de cancelación ahora refleja el cambio persistido y conserva por separado la respuesta vieja que se hace llegar tarde.

El EXPLAIN del CRM del dueño ahora acepta el índice nuevo equivalente que elige SQLite para empates; sigue exigiendo consulta indexada, parámetros/cota correctos y ausencia de SCAN/TEMP B-TREE. No se retiraron índices anteriores.

## Interfaz y límites de QA

Agenda clara permanece: DM Sans local, paleta Sarin, mismos paneles y textos de tareas. Modo Operate; antislop durante la edición según la elección del propietario. No se sorteó ni sustituyó una dirección visual. El detector Impeccable sobre los tres componentes modificados devolvió `[]`.

Playwright MCP ejecutó la página real en Next local con Auth/Firestore oficiales y65 citas sintéticas:45 próximas y20 históricas. Se observaron20 tarjetas, Siguiente/Anterior con resultado correcto, activación de Siguiente con teclado, Historial y fecha de Calendario; no hubo desbordamiento horizontal a320/390/1280. Los tres controles nuevos midieron44px. Capturas inspeccionadas de las tres anchuras muestran los tokens y filas existentes.

El atajo de zoom en el navegador sin ventana no cambió DPR/viewport; no se presentó como200%. La alternativa de Windows fue detenida por la herramienta porque no pudo verificar la URL del navegador. Se detuvo ese control. Zoom nativo200% queda pendiente de la QA integral final; no se reemplazó por CSS ni por un viewport estrecho. Esta comprobación acotada no cierra la campaña Fresha posterior a BUILD-FREEZE.

## Publicación autorizada

La preparación remota es aditiva: `0015_client_appointments_pagination.sql`, tres índices sobre citas existentes; no requiere un marcador de protocolo ni cambios de cuota. Preflight agregado D1:5 citas,0 núcleos inválidos,0 escrituras. El primer intento del preflight usó una columna ID inexistente y falló sin escribir; la consulta corregida obtiene el ID canónico del path. No se imprimieron cuerpos de citas.

La autorización concreta enlaza candidato, hash SQL y entorno en `approval.external.clientPaginationProductionTest` antes de aplicar índices/publicar. El push main usa el release existente y se comprueban CI, SHA de Worker/Container/Pages y una sola réplica. La evidencia remota final se conserva en el control/paquete privado, no se anticipa en este informe de código. No se ejecutan mensajes reales, inferencias pagadas, conciliación de cuota ni aceptación global Fresha.

## Decisiones de ejecución

- La petición explícita de implementación completa hasta commit/push prevalece sobre detenerse tras un solo hijo o volver a pedir el mismo handoff. Un solo commit consolidado tras validar; el coste de equivocarse sería publicar un alcance no pedido, limitado aquí al contrato aprobado.
- Aceptar índices equivalentes en EXPLAIN conserva el requisito de ejecución indexada sin exigir un nombre del optimizador. El coste de equivocarse sería ocultar una regresión de orden/coste; siguen comprobándose plan sin SCAN/TEMP B-TREE y parámetros reales.
- La imposibilidad de comprobar zoom nativo no se convierte en éxito ni en aceptación integral. Queda documentada para la QA final del ciclo; las pruebas funcionales y la entrega solicitada continúan dentro de su alcance aprobado.
