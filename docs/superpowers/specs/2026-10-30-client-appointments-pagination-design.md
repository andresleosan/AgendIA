# Paginación de Mis citas sin romper recuperación

Documento preparado el 2 de noviembre de 2026 para R0-PAGE-D. Estado: **propuesta pendiente de aprobación**. Fuente de producto revisada: `f2f76121b412be284fc7f08d76b8c8e71b56a00a`, actualmente publicada. Este documento no implementa paginación ni autoriza un despliegue.

## Objetivo y alcance

Permitir consultar las citas propias de un negocio aunque el historial supere 1.000 registros, con páginas acotadas, orden estable y errores verificables. Conservar próximas, historial, calendario por fecha, cancelación, reprogramación, volver a reservar, PNG, ICS, recordatorios y recuperación de confirmaciones inciertas.

Se mantiene Agenda clara y sus componentes, tipografía y tokens. No se crea una agenda de dueño alternativa, un historial clínico, una búsqueda global, una lista entre negocios, otra regla de cuota ni una nueva fuente de autoridad para reservas. Ninguna ausencia en una página significa que una cita no existe o que una operación no se confirmó.

## Hechos de la base actual

| Superficie | Comportamiento observado en código |
| --- | --- |
| GET `/api/businesses/:id/appointments?view=mine` | Autentica, valida negocio y parámetros únicos, consulta todas las filas con `client.uid == actor.uid`, luego filtra tenant/tipo/UID y ordena por startAt/ID. Devuelve el ID canónico del documento y no-store. No tiene cursor. |
| `ClientAppointments` | Recibe un array completo, lo filtra por vista y lo vuelve a consultar cada 15 s, al recuperar foco y al volver a estar visible. El scope actual usa negocio/UID; el nuevo contrato debe añadir época de autenticación. |
| Próximas | `confirmed && endAt > now`: incluye citas en curso; orden ascendente por inicio. Las acciones de cambio y exportación requieren además `startAt > Date.now()`. |
| Historial | Estados conocidos distintos de confirmed, incluso cancelaciones futuras, más confirmed con `endAt <= now`; orden descendente por inicio. Pasado no equivale a asistencia completada. |
| Calendario | Fecha de `startAt` en America/Bogota, no un filtro por el `dateKey` guardado; orden ascendente. No cambia citas. |
| Recuperación y acciones | Cancelar devuelve una cita y pasa a historial; reprogramar transfiere un mutex al workspace; volver a reservar selecciona un servicio vigente; PNG/ICS son copias locales con guardas frente a cambios. Las confirmaciones tienen sus requests/propuestas propios. |
| Dependencias de la lista completa | `onAppointmentsRead` comprueba por pertenencia y comparación completa la fuente de una reprogramación. Los recordatorios reciben ocurrencias de todas las citas conocidas. Entregarles una sola página sin adaptar el contrato causaría falsos negativos. |
| Chat | `own_appointments` hace otra consulta global por UID y renderiza todas las filas, sin aviso de continuación. No debe seguir dependiendo del array completo. |
| Driver D1 | Una consulta sin límite intenta hasta 1.001 filas y devuelve 413 DATA_LIMIT si supera 1.000; también tiene límite de respuesta de 8 MiB. No trunca con éxito. El filtro posterior del endpoint no evita este error. Firestore no hereda automáticamente ese límite de D1. |
| Patrón del dueño | `owner-client-record` ya usa 20+1, desempate por ID guardado, ancla revalidada y 409 ante cambio. Ese fingerprint no es autorización ni snapshot retenido entre páginas. Su hook reemplaza la página visible, no acumula todas las anteriores. |

Fuentes: `src/app/api/businesses/[id]/appointments/route.ts`, `src/components/client-appointments.tsx`, `src/app/b/[slug]/page.tsx`, `src/lib/client/use-api-poll.ts`, `src/lib/client/api-polling.ts`, `src/lib/server/chat.ts`, `src/lib/server/chat-replies.ts`, `src/lib/server/owner-client-record.ts`, `src/hooks/use-owner-client-record.ts` y `cloudflare/src/data.ts` del SHA indicado. Inspección estática, no ensayo nuevo del producto.

Lectura agregada de producción, sin recuperar documentos o identidades: cinco documentos de tipo appointment, cero IDs guardados distintos del ID canónico y cero fechas startAt/endAt ausentes o de tipo incorrecto. Es una observación puntual del 2 de noviembre, no una garantía de todos los datos futuros ni una certificación de integridad completa.

## Experiencia propuesta y decisiones

La recomendación técnica del implementador es una página visible de **20 citas**, con **Anterior**, **Siguiente** y **Actualizar citas**. Solo se muestra Siguiente cuando existe un resultado adicional comprobado; no se inventan totales ni una última página numerada. Anterior conserva la cadena de cursores de esta sesión, no usa offsets. Una actualización explícita empieza en la primera página con un nuevo corte temporal. Cambiar vista, fecha, negocio o sesión inicia otra cadena.

La alternativa de acumular bloques con Cargar más evita reemplazar tarjetas, pero hace crecer indefinidamente la lista y complica mantenerlas vigentes. Se recomienda la página visible acotada por reutilización y coste predecible del navegador. Es una propuesta técnica, no una preferencia del propietario ya aprobada.

**Q1 decidida:** el propietario eligió «Conservar posición y ofrecer Actualizar (recomendado)» el 2 de noviembre de 2026, en respuesta a la pregunta explícita sobre cambios mientras lee varias páginas. Se conserva la posición y se ofrece Actualizar citas. Esta decisión concreta no se presenta como aprobación del resto del documento.

Con la opción recomendada, el refresco visible cada 15 s verifica la página actual y las referencias activas. Si no cambia su contenido, actualiza la comprobación sin mover foco. Si cambia la composición, invalida el ancla o caduca el cursor, conserva temporalmente el contenido identificado como desactualizado, bloquea la continuación y muestra un aviso con Actualizar citas. No promete detectar inmediatamente todos los cambios de páginas que no están visibles. El servidor vuelve a autorizar y comprobar las operaciones seleccionadas; una tarjeta desactualizada nunca es su prueba de vigencia.

Una lectura fallida muestra error y Reintentar; no se presenta como cero citas. Una continuación fallida no borra la página anterior ni sus referencias activas. Al perder autorización, cambiar cuenta/época/negocio o desmontar, se ocultan datos anteriores en el propio render y se abortan peticiones; una respuesta, token, cuerpo o descarga tardía no se publica ni roba foco.

El corte `asOf` lo fija el servidor al abrir una cadena y permanece estable para clasificar sus páginas. `checkedAt/serverNow` indica la comprobación actual. La vigencia de acciones usa el reloj actual y el estado canónico, no `asOf`. En particular, una cita que ya empezó no puede cancelarse, reprogramarse o exportarse como futura por mantener una página antigua. La interfaz no atribuye asistencia ni pago al paso del tiempo.

## Lectura privada y cursor

Se propone una ruta separada de consulta: POST `/api/businesses/:id/appointments/query`, cuerpo JSON estricto de hasta 4.096 bytes, sin query string y no-store tanto en éxito como error. Solo admite versión de contrato, vista, fecha obligatoria exclusivamente en Calendario y cursor opcional. El tamaño de página es fijo en servidor; no se acepta UID, rol, límites, offsets, campos ni operadores del navegador.

Cada página deriva UID de `requireUser`, verifica que el negocio canónico existe y consulta únicamente `businesses/:id/appointments` con `client.uid == actor.uid` y `type == appointment`. Ser dueño no amplía esta consulta personal a otras cuentas. Consultar/cancelar citas propias ya existentes conserva la política actual tras revocación de consentimiento o vencimiento; iniciar una nueva reserva o reprogramación conserva sus guardas actuales. No añadir un permiso nuevo por el mero hecho de paginar.

Respuesta: ámbito verificable, vista/fecha, `asOf`, `checkedAt`, hasta 20 filas propias, cursor siguiente o null y declaración de cobertura. Las filas conservan los datos que necesitan los consumidores actuales autorizados, sin añadir otros datos privados. No registrar filas, UID, cursores ni cuerpos en logs. No convertir el array recibido a otro tenant por un cast TypeScript.

El cursor versionado contiene el ámbito de consulta, el corte temporal, `startAt`, ID de la última fila devuelta y fingerprint de su revisión. Este fingerprint incluye al menos ID, inicio/fin, estado, revisión de reprogramación y revisión de asistencia. El scope compara UID autenticado, negocio, vista y fecha; no obtiene permisos del cursor. Todos los campos tienen esquema, límites y validación de cadena completa. Vigencia recomendada: 15 minutos desde el corte; caducidad o cambio verificable produce 409 y requiere Actualizar citas.

La primera página no acepta `asOf` libre. En continuación, el servidor verifica contexto, tiempo y ancla actual en la misma transacción que consulta la página. El cursor no se anuncia como firmado o infalsificable: igual que el patrón del dueño, un cliente puede construir una posición propia válida, pero nunca consultar otra cuenta o negocio. Su ancla debe existir, pertenecer al ámbito, conservar sus claves/revisión y seguir dentro del filtro temporal original.

| Resultado | Respuesta propuesta |
| --- | --- |
| Forma/campos/fechas/cursor malformados | 400, sin consulta amplia de fallback. |
| Falta de sesión/acceso | 401/403; borrar datos del contexto anterior. |
| Negocio inexistente | 404. |
| Ancla ajena, movida, borrada, modificada, de otra vista/fecha o cursor caducado | 409 `CLIENT_APPOINTMENTS_CHANGED`; no revelar si el ancla ajena existe. |
| Documento devuelto, orden o revisión no verificable | 503 `CLIENT_APPOINTMENTS_UNVERIFIABLE`; no tratarlo como una lista vacía. |
| Cita por ID inexistente o ajena | Mismo 404 para ambos casos. No inferir cancelación a partir del 404. |

Orden total: Próximas/Calendario por `startAt ASC, id ASC`; Historial por `startAt DESC, id ASC`. ID usa comparación ordinal, no localeCompare ni orden de llegada. Se reutiliza el ID guardado que ya usa el historial del dueño, verificando que coincide con el ID canónico. Antes de activar la nueva lectura se revisan campos/indexes y compatibilidad del dato; una irregularidad impide afirmar completitud y no autoriza reparaciones silenciosas.

## Consultas acotadas entre backends

`Database` admite comparaciones, orderBy y limit; no admite OR, startAfter ni offsets. Se conserva ese contrato y el tamaño 20+1. La ancla no necesita una colección nueva ni escrituras durante lecturas.

Próximas aplica `status == confirmed` y `endAt > asOf` **en servidor**; no filtra una página de todo el historial en el navegador. El primer bloque usa también el límite de dominio `startAt >= 0`, y ordena startAt/id/endAt; el tercero solo desempata una clave ya única. La continuación lee primero el empate de startAt con id mayor, orden id/endAt; después, si falta el centinela, inicios mayores con la capacidad restante. Máximo dos consultas y 21 candidatos por página, más autorización/ancla.

Historial combina cinco ramas disjuntas: confirmed con `endAt <= asOf`, completed, no_show, cancelled_by_client y cancelled_by_owner. Cada rama ordena inicio descendente e ID ascendente; la de confirmed añade endAt al orden y el límite de dominio startAt. Continuaciones por empate de inicio e ID mayor y después inicios menores, usando el ancla global. Cada rama obtiene como máximo 21 candidatos; se fusionan por el comparador global, se comprueba el centinela y se devuelven 20. Máximo 105 candidatos y diez consultas de continuación, más autorización/ancla; no 1.000 filas leídas sin límite para filtrar después.

Calendario consulta el rango `[medianoche de Colombia, medianoche siguiente)` de startAt, conserva estados conocidos, ordena inicio/ID y pagina con los mismos dos bloques. Las cancelaciones futuras siguen apareciendo en su fecha y en Historial. No convertir Calendario en disponibilidad ni alterar su PATCH de cancelación.

Se necesita admitir `endAt` numérico en el driver D1 y preparar índices aditivos para las formas generadas. El desglose fijará los nombres, SQL, combinaciones y límites efectivos de la migración siguiente, sin reutilizar los ordinales reservados ni alterar los índices anteriores. La paginación no debe depender del límite global de 1.000.

Estas formas aprovechan consultas Firestore con varias desigualdades y mantienen el ID de documento implícito al final; no usar startAt/__name__/endAt. La construcción/serialización offline con el SDK instalado es viable, pero **no acredita aceptación de servidor o índices**. La construcción deberá probar primera página, empates y continuación en el emulador oficial, índices configurados y D1 real. Si una forma no funciona en cualquiera de los backends, se corrige el desglose antes de aceptarla; no se degrada a un escaneo ilimitado ni cambia silenciosamente el orden aprobado.

Los límites anteriores son de documentos candidatos devueltos, no de entradas físicas de índice escaneadas ni una promesa de coste constante. Las desigualdades secundarias pueden filtrar después de recorrer más entradas. Exigir EXPLAIN del SQL generado y evidencias de ejecución/índices de Firestore; no prometer lecturas/coste O(20) sin medirlo. Referencias primarias: [múltiples rangos](https://firebase.google.com/docs/firestore/query-data/multiple-range-fields), [orden de StructuredQuery](https://docs.cloud.google.com/firestore/docs/reference/rest/v1/StructuredQuery), [optimización de rangos](https://firebase.google.com/docs/firestore/query-data/multiple-range-optimize-indexes).

## Cambios concurrentes y lo que demuestra una página

Una transacción hace coherente una página; no retiene un snapshot global entre peticiones. Con datos estáticos válidos, recorrer 999/1.000/1.001 registros debe devolverlos todos una sola vez, incluidos empates, sin 413 por cardinalidad. Para 1.001 y páginas de 20: 51 páginas comprobadas, sin simular una única consulta ilimitada.

Si cambia la ancla, la continuación devuelve 409. Si se inserta o mueve una fila que no es la ancla entre peticiones, puede quedar antes de la posición recorrida o reaparecer después. La respuesta declara esta cobertura no garantizada; Actualizar reinicia la lectura actual. No se promete “no hay más citas en todo el negocio” a partir de una página ni “copia exacta a las HH:mm”.

El cliente valida ámbito, estado, orden, duplicados y monotonía por página. Una repetición detectada entre páginas ya visitadas invalida la cadena y pide actualización; no se oculta para afirmar completitud. Si cambia una fila de una página que ya no se recuerda, no se garantiza detectar toda omisión/repetición. La pila de navegación conserva cursores, no un archivo creciente de todos los datos privados.

## Operaciones, recordatorios y recuperación

La lista paginada deja de ser la prueba de existencia de todas las citas. Se añade una lectura autenticada por ID para una cita propia dentro del negocio, sin pedir el historial. `BookingWorkspace` verifica su fuente activa por esa lectura y su fingerprint; se reemplaza el significado de `onAppointmentsRead`, no se le entrega una página fingiendo que es la colección entera.

Cancelar y reprogramar conservan sus mutaciones, validación de autoridad, mutex, requests y recuperación. Navegar o actualizar la lista no borra una propuesta de reprogramación, una confirmación incierta, su requestId o su estado de verificación. Se comprueba la cita seleccionada antes de iniciar una acción y otra vez en la mutación canónica. Un error de lectura puede deshabilitar una acción nueva, pero no elimina la posibilidad de recuperar el resultado de una escritura ya iniciada con la misma identidad.

Una cancelación confirmada conserva su cita devuelta como resultado propio, actualiza la consulta de Historial y permite abrir/verificar ese ID aunque no caiga en la primera página. Una confirmación o reprogramación también puede enfocar su resultado por ID sin recorrer todas las páginas. Ese foco es como máximo una tarjeta explícitamente seleccionada fuera de la página normal de 20, no una segunda lista. Foco y navegación tardíos requieren que la solicitud siga siendo la interacción activa del mismo contexto.

PNG/ICS continúan siendo copias estáticas locales de una cita futura propia. Antes de generarlos se obtiene la versión canónica por ID y, antes de descargar, se vuelve a comprobar su vigencia y los campos del archivo; ante cancelación, reprogramación, error o cambio de sesión se descarta la descarga. Nunca incluir teléfono, email ni respuestas privadas en los archivos. Volver a reservar sigue siendo selección de un servicio vigente, no clonar la cita ni confirmar sin revisión.

Los recordatorios ya tienen una lectura propia acotada por 24 horas y máximo 100 ocurrencias; esa cota no se convierte en límite de Mis citas. El estado paginado no puede suprimir un recordatorio solo porque su cita no está en la página. Su endpoint conserva la validación canónica de ocurrencia, preferencias y consentimiento. La información nueva verificada sobre una cita cancela/sustituye su ocurrencia anterior; falta de fila en una página significa desconocido, no cancelado. Ver cita obtiene el ID canónico y enfoca la tarjeta seleccionada; no recorre automáticamente todas las páginas. Marcar visto conserva la validación de ocurrencia en servidor. Un fallo o exceso de la cota de Recordatorios permanece en ese panel y no convierte Mis citas en vacío/error global.

Las referencias activas se consultan por IDs explícitos con una cota pequeña y separada: una fuente de reprogramación y una cita seleccionada/resultado. No crear un poller de todas las páginas cargadas ni una consulta global auxiliar para restaurar la ilusión del array completo. En el desglose se concretan props/hook de conocimiento parcial, punto de lookup, política de refresco y regresiones de recordatorios antes de editar el componente.

## Chat y compatibilidad

`own_appointments` reutiliza el lector autorizado de la primera página de Próximas: hasta 20 citas, orden correcto, sin otro fetch de IA ni consulta global del historial. Si hay más, el texto lo indica y remite a Mis citas para continuar; nunca dice que son todas. Para historial/fecha se utiliza la navegación existente a esas vistas, sin inventar un cursor conversacional ni ampliar el parser del modelo en este módulo. La consulta diaria del dueño permanece fuera del alcance.

La propuesta de transición es que el GET antiguo `?view=mine` responda 409 `CLIENT_APPOINTMENTS_UPGRADE_REQUIRED`, con indicación explícita de actualizar la página. No devolverle solo 20 bajo su contrato de “array completo”, ni mantener una lectura sin límite como compatibilidad oculta. Un navegador antiguo debe poder conservar y recuperar sus escrituras pendientes; esta transición afecta a lectura del listado, no a confirmar propuestas/cancelar ni a la identidad de solicitudes existentes. GET por fecha y POST/PATCH anteriores conservan sus contratos.

El despliegue de esta transición se aprobará como efecto concreto cuando exista el candidato; este documento no autoriza publicar un diseño ni forzar ahora una recarga en producción.

## Casos que debe construir y comprobar el desglose

1. 999/1.000/1.001 citas válidas de una cuenta, ruido de otras cuentas/negocios/manual blocks y datos estáticos: recorrido exacto por vista, sin omisiones, duplicados ni lectura global. Fixtures de historial antiguo abundante más una cita próxima: Próximas no puede mostrar vacío por haber leído antes registros viejos.
2. Más de 20 filas con el mismo startAt, IDs con orden ordinal, mezcla de estados, cancelaciones futuras, citas en curso y medianoche colombiana. Primera página y ambos bloques de continuación reales en D1 y Firestore.
3. Cursor malformado, de otra cuenta/negocio/vista/fecha, timestamp/fingerprint alterado, ancla borrada/reprogramada/cancelada y caducidad: error definido, sin fallback amplio ni fuga de existencia.
4. Inserciones y movimientos de filas no ancla entre páginas: límites de cobertura demostrados, detección de repetición y actualización explícita, sin prometer snapshot retenido.
5. Pérdida de sesión, época nueva con el mismo UID, cambio de negocio, respuesta/token/cuerpo tardíos y error de continuación: nada del contexto anterior se publica ni habilita acciones.
6. Fuente de reprogramación fuera de la página y confirmación incierta durante navegación/actualización: se conserva la misma operación y su recuperación. Una ausencia parcial no invalida la fuente ni prueba el resultado.
7. Cancelación propia/del dueño, inasistencia/atención, bloqueo/revocación/vencimiento y reprogramación entre lectura/acción: mantener las reglas existentes y comprobar el estado actual en servidor.
8. PNG/ICS pendientes mientras se mueve/cancela la cita, se cambia de página/cuenta o se pierde la verificación: no descargar una versión obsoleta ni liberar el mutex de otra operación.
9. Recordatorio de una cita fuera de la primera página: visible según su endpoint autorizado, Ver cita por ID sin escaneo, supresión de ocurrencia obsoleta y recuperación de visto/preferencia conservadas.
10. Chat con más de 20 resultados: resumen acotado y aviso explícito; no segunda inferencia, ni fuga de otras cuentas, ni truncamiento presentado como lista completa.
11. Navegador antiguo: error explícito de actualización, sin cambiar las rutas de recuperación; navegador nuevo: tamaños, centinela, Anterior/Siguiente/Actualizar y estados de carga/error/vacío verificables.
12. SQL generado y planes/indexes aditivos, lectura sin commits, backends reales locales y pruebas de autorización/no-store. QA integral MCP después de BUILD-FREEZE; una revisión documental o serialización offline no acredita esos casos.

## Revisión y continuación

Q1 está decidida y la aprobación de este documento sigue pendiente. El revisor independiente debe comprobar que el contrato es construible, que no oculta escaneos/límites de consistencia y que separa las referencias operativas de la paginación. Las firmas finales, archivos, migración y pruebas concretas corresponden a R0-PAGE-P después de aprobar este contrato; no se cuenta diseño como producto implementado.
