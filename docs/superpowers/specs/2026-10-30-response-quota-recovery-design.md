# Recuperación durable de cuota de respuestas

Fecha: 30 de octubre de 2026, America/Bogota. Tarea `R0-QUOTA-D`. **Contrato propuesto v1: Q1/Q2 decididas por el propietario; pendiente de aprobación del documento exacto.** No autoriza código, liquidaciones reales ni llamadas a proveedores. Estado canónico: [tasks.json](../../implementation/fresha/tasks.json).

## Intención y alcance

Cerrar cada intento comercial una sola vez, incluso tras una caída, sin repetir una inferencia que pudo ejecutarse, descontar dos unidades ni devolver capacidad sin evidencia. Reutilizar `responseQuotaTurns`, los períodos y los adaptadores existentes. El chat privado actual y la futura bandeja S03 deben compartir el mismo contrato de liquidación; S03 conserva sus propias cercas de hilo/publicación y su retención aprobada.

Esta tarea diseña; `R0-QUOTA-P` deberá desglosar la construcción después de la aprobación. No incorpora un transcript durable al chat privado, un segundo ledger económico, nuevas reglas de pagos, una segunda réplica o cambios en los importes de los planes. Una unidad del plan no equivale a dinero cobrado por el proveedor. Recuperar la cuota no demuestra que el usuario vio una respuesta.

## Fuente actual y hechos revisados

Código: `E:/Proyectos/SarinBot-worktrees/fresha-implementation-20261030`, rama `codex/fresha-implementation-20261030`, HEAD `889017457801759e44835b723d8e0c26aa3e6baa`, con el overlay previo R0-001/D1/REUSE. No se usa src del checkout mixto de control.

- `src/lib/server/response-quota.ts`: identidad SHA-256 de negocio/actor/modo/canal/requestId, con el caso histórico onboarding que usa null en lugar de negocio. Fingerprint distinto produce conflicto. Estados actuales `reserved/completed/released`; cada nueva reserva tras released tiene otro attemptId. `completed` recupera un recibo técnico, sin texto; `reserved` solo recupera ciertas propuestas/citas y, en otro caso, responde pendiente. `settle` mueve una unidad del período guardado y valida attempt/scope/period; no consulta evidencia del proveedor.
- `response-periods.ts` y `billing.ts`: capacidad por período, inicialización legacy/trial y períodos de suscripción; una ampliación suma extras al período vigente. Liquidar usa el período original, no el que esté vigente al reintentar.
- `chat.ts`: cache de respuesta en memoria de 15 minutos; reserva antes de interpretar; el catch de interpretación/construcción intenta liberar ante cualquier excepción. Por ello un error posterior a la llamada o a una propuesta durable puede liberar la unidad. Confirmar cuota después de una respuesta conserva la reserva si falla almacenamiento. WhatsApp tiene otra liberación específica ante cambio de control sin mutación guardada. Esas ramas también necesitan consumir evidencia de ejecución.
- `chat-intent.ts`: beforeInference se invoca antes de completeChat y vuelve a pasarse como beforeDispatch. Contar callbacks no identifica el instante de salida. Falta un hook separado que publique evidencia de cuota antes de permitir transporte.
- `src/lib/sarin/engine.ts`: una petición HTTP por invocación; no se envía una clave de idempotencia externa. La ausencia de uso de esa capacidad no afirma nada sobre capacidades futuras del proveedor. `beforeDispatch` y signal se comprueban antes de fetch; no hay marca durable de despacho. Cada invocación nube crea un callId nuevo.
- `ai-budget.ts`: ledger operativo opcional, reservado antes de beforeDispatch; sin usage/modelo/tier suficientes queda incierto. Un settled tarifado no demuestra entrega ni facturación final. Su conciliación superadmin actual no concilia cuota comercial. `ai-usage.ts` es best effort: la ausencia de una observación no demuestra ausencia de llamada.
- S03 [diseño](2026-10-22-owner-web-inbox-design.md) y [Task2](../plans/2026-10-22-owner-web-inbox.md): marcador mayHaveDispatched monotónico, preparación/aplicación de cuota en la misma transacción del hilo, identidad técnica persistida antes de reservar y tombstone mínimo hasta conciliación. Tras posible despacho conserva/consume la unidad incluso si se suprime la publicación. El propietario eligió unificar ese criterio con legacy al responder Q1.

Esta inspección es estática. No se ejecutaron tests nuevos ni se acreditó un fallo remoto en esta tarea de diseño. Las suites relevantes ya existen: `response-quota.test.ts`, `chat-route.test.ts`, `engine-budget.test.ts`, `ai-budget.test.ts`, `appointment-reschedule.integration.test.ts` y contratos D1 de reserva/propuesta. Sus resultados históricos no se presentan como una nueva ejecución.

## Alternativas y decisiones recibidas

| Alternativa | Efecto | Coste / compatibilidad |
| --- | --- | --- |
| A, recomendada: consumir tras posible inicio | Antes de admitir salida, fallo cercado demuestra no ejecución y permite liberar. Una vez que pudo iniciarse, una unidad se conserva y liquida aunque la respuesta se pierda, sea inválida o deje de poder publicarse. | Se alinea con S03; cambia las devoluciones genéricas del chat actual. El aviso debe explicar que puede consumirse una respuesta que no llegue a mostrarse. No afirma gasto real. |
| B: conservar pendiente hasta aclarar resultado | Ninguna llamada incierta se repite ni se libera; la unidad permanece retenida hasta obtener evidencia suficiente. | Puede inmovilizar capacidad indefinidamente y requiere revisar el criterio ya previsto para S03. Hay que acordar qué resultado permite consumir; no basta sustituir un timeout por otro. |

Liberar automáticamente por edad, timeout, cancelación del navegador, HTTP negativo o falta de usage se descarta: ninguno prueba que no hubo llamada. Reintentar automáticamente una incertidumbre se descarta porque el cliente actual no usa idempotencia externa.

**Q1 decidida:** el propietario seleccionó «Consumir si pudo iniciarse (recomendado)» en respuesta a la pregunta explícita sobre llamada fallida o respuesta perdida y su extensión al chat actual. Se elige A para los consumidores de cuota comercial. Las reglas posteriores desarrollan esa decisión; la revisión del documento completo sigue pendiente.

**Q2 decidida:** el propietario seleccionó «Sí, conciliación por superadministrador (recomendado)» en respuesta a la pregunta explícita sobre reservas antiguas irresolubles, auditoría y evidencia. Se habilitará ese permiso exclusivamente al superadministrador. Esta decisión no autoriza ajustar reservas reales. Una eventual devolución comercial de cortesía requiere otro contrato; no falsifica evidencia de no despacho ni modifica recibos terminales.

## Modelo técnico propuesto

Conservar `ResponseQuotaInput` y los campos de `ResponseQuotaReservation`: reservationId, scopeId, periodId y attemptId. Preservar exactamente la identidad/fingerprint de turnos legacy y onboarding. El fingerprint nuevo de S03 sigue siendo HMAC del comando con sus dominios existentes; no sustituir hashes históricos ni solicitar contenido para conciliar.

Extender el turno de forma aditiva y validada con versión de protocolo de ejecución, fase `prepared | may_have_dispatched | result_recorded | interrupted`, marca monotónica de posible despacho, enlace opaco opcional al callId operativo y resultado técnico. Ausencia de versión/fase significa `legacy_unknown`, nunca prepared. `status` continúa expresando contabilidad: reserved, completed o released. `completed` significa unidad liquidada; un campo de resultado distingue respuesta recuperable, solo recibo, suprimida, fallida o incierta. No implica entrega.

Crear recibos técnicos inmutables por `reservationId + attemptId` en una colección privada `responseQuotaReceipts`, con ID derivado y campos estrictos: versión, identidad de reserva, fingerprint, decisión completed/released, fundamento enumerado, fases/evidencia técnica, fecha y origen automático/administrativo. Una conciliación manual añade identidad opaca del administrador, motivo acotado y referencia de evidencia; nunca prompts, respuestas, argumentos de herramientas, teléfonos, tokens o archivos. El recibo permite conservar historia aunque un released seguro reciba un nuevo attemptId. No duplicar contadores ni registrar texto de usuario en esta colección.

Las referencias de resultado solo apuntan a pruebas ya existentes y autorizadas (propuesta/cita o recibo S03). No se reconstruye una respuesta libre desde el ledger. El callId operativo se asigna/vincula antes de la salida; su recibo ausente no justifica liberar y su conciliación no cambia automáticamente la cuota comercial.

### Invariantes

1. Una reserva suma exactamente uno a reservedResponses; completed resta uno a reserved y suma uno a used; released resta uno a reserved. El recibo terminal y ambos documentos se confirman en una sola transacción.
2. Contadores enteros seguros no negativos. Reservar verifica used + reserved < included + extra; liquidar no aumenta capacidad incluida ni cambia el plan. Un estado/counter corrupto falla cerrado y queda para diagnóstico, nunca se corrige inventando cero.
3. Repetir una liquidación compatible del mismo attemptId no escribe otra vez; decisión terminal distinta o un handle viejo contra un nuevo intento produce conflicto. Un retry no adopta un attempt de otro turno, fingerprint o scope.
4. mayHaveDispatched solo puede cambiar de false a true para el mismo intento; ninguna operación que lo encuentre true permite otro despacho de ese intento. La antigüedad solo sirve para descubrir pendientes, nunca como prueba de liberación.
5. El retry del navegador/cron lee estado. Solo el camino que gana el cambio prepared→may_have_dispatched puede iniciar una llamada HTTP. Si pierde el ACK de ese cambio, relee el turno y se trata como incierto; no inicia el HTTP por asumir que ganó. Esto puede consumir una unidad aunque el proceso finalmente no haya enviado: es el coste conservador explícito de A.
6. Cerrar un prepared mediante release cerca al ejecutor antiguo: su transición posterior debe releer status/attempt y fallar antes de HTTP. Esta exclusión requiere el mismo readset; no se obtiene mirando un bool fuera de la transacción.
7. Cuota, presupuesto del proveedor, resultado de aplicación y entrega tienen evidencias separadas. Un HTTP 4xx/5xx, AbortError, respuesta no parseable o coste cero en un registro best effort no se convierten en prueba de no despacho.
8. El cierre técnico interrupted/incierto cerca también los efectos tardíos del ejecutor legacy: no crea propuestas, no actualiza chatState, no guarda cache ni prepara/publica una respuesta después de perder esa carrera. La transacción que crea una propuesta o guarda estado debe releer el intento/cerca y registrar su prueba técnica junto al resultado; una consulta previa fuera de esa transacción no basta. Si el resultado ya ganó y quedó durable, el cierre conserva esa prueba y permite solo su recuperación autorizada, sin cambiar un recibo terminal ni repetir la mutación.

## Matriz de caída y recuperación (alternativa A elegida)

| Punto de caída | Evidencia durable exigida | Recuperación |
| --- | --- | --- |
| Antes de confirmar reserva | Ningún turno, o ACK incierto de reserve | Releer ID exacto. Si falta, solo una transacción que cerca al ejecutor puede concluir none; lectura aislada no basta. |
| Reserva confirmada, antes de admitir transporte | Protocolo nuevo, prepared, intento exacto y marcador false | Finalización transaccional cerca ejecución y libera la unidad; un nuevo intento solo tras autorización vigente y release confirmado. |
| ACK de marcador perdido | Turno puede mostrar may_have_dispatched aunque el fetch no ocurrió | No ejecutar otro fetch ni liberar; conservar y liquidar conforme A. |
| Durante HTTP, timeout, desconexión o reinicio | may_have_dispatched verdadero | No volver a inferir ni devolver por edad; finalizar/interrumpir y consumir una vez. Gasto operativo permanece incierto si carece de recibo. |
| Proveedor contestó; falla parseo/guard/render | Marcador y resultado técnico, si alcanzó a persistirse | Consumir una unidad, sin publicar contenido inválido/revocado; no llamar otra vez. |
| Propuesta/cita quedó durable; falla estado/cache | Prueba exacta de aplicación y turno correspondiente | Recuperar estado actual por los lectores autorizados; consumir una vez sin recrear operación. Ausencia de cache no invalida la prueba. |
| Respuesta informativa generada, cache perdida | Recibo de intento sin texto recuperable | Mostrar solo estado técnico; no reconstruir texto ni reejecutar. Otro mensaje explícito crea otro turno sujeto a permiso/capacidad. |
| Resultado guardado; falla settlement/ACK | Turno/recibo/periodo, más prueba del consumidor | Releer y repetir solo settlement idéntico; no repetir motor, propuesta o envío. S03 combina publicación y settlement en su misma transacción. |
| Turno viejo sin protocolo | legacy_unknown; pruebas heredadas si existen | Una prueba de propuesta/cita permite consumir/recuperar. Sin evidencia, conservar pendiente hasta la decisión manual de Q2; no inventar no despacho. |

Las cercas/deadlines del consumidor determinan cuándo cerrar una operación activa; este contrato no crea un timeout económico universal. S03 conserva su acceptedAt + 300s y su política de supresión. El desglose debe identificar los deadlines reales de cada caller antes de conectar su recuperación.

## Interfaces y composición

Reutilizar las interfaces previstas por Task2 de S03, con una revisión expresa de su `completion:boolean`: para protocolo nuevo el booleano no puede contradecir la evidencia. Un caller no puede pedir release de may_have_dispatched simplemente por timeout o cambio de control.

- `readResponseQuotaReservation(input, db)` continúa siendo lectura validada sin reservar ni hacer booking recovery. Un lector interno por identidad técnica permite reparar ACK perdido sin UID ni contenido, como requiere `InboxQuotaIdentity`.
- `markResponseQuotaDispatch(reservation, expectedFingerprint, executionBinding, db)` es la transición CAS que valida intento, estado y cercas del consumidor antes de permitir HTTP. La clave/binding se deriva en servidor; el navegador no aporta pruebas de ejecución. No aceptar un callback aislado como prueba de persistencia.
- `planResponseQuotaSettlement(...)` compartido valida turno/periodo/identidad/evidencia y produce escrituras puras o no-op terminal compatible. Preserva campos existentes y exige recibo en el protocolo nuevo. El wrapper legacy y el Worker usan el mismo plan.
- Preparación transaccional lee turno, período, recibo y cercas antes de cualquier escritura; aplicación solo hace staging. El wrapper independiente commit/release no abre una segunda transacción dentro de la transacción S03.
- `interpretChat` recibe beforeDispatch separado de beforeInference. `completeChat` conserva un único punto de salida para Ollama y nube. Todos los consumidores de cuota comercial deben pasar por la marca; otros callers del motor conservan sus contratos y no adquieren cuota comercial por accidente.
- Legacy añade la cerca del intento al readset de creación de propuesta y guardado de chatState; esos helpers necesitan una autorización transaccional compatible o staging reutilizable, que el desglose precisará. Después de registrar el resultado, la publicación/callback/outbox/cache exige todavía el outcome correspondiente: un resultado marcado interrupted no se entrega por llegar tarde. WhatsApp valida esa cerca en la transacción de outbox, además de su epoch vigente. Para HTTP se hace el chequeo final antes de devolver; no se promete retirar bytes ya enviados ni impedir una carrera física entre el chequeo final y el transporte.
- `reconcileResponseQuota`, conforme a Q2, acepta identidad opaca, fingerprint/attempt esperado, decisión/motivo/evidencia y requestId administrativo. Autenticación y superadmin se comprueban en servidor; misma operación replays, otra decisión terminal conflictúa. No permite editar contadores directamente.

Con las decisiones A y Q2, un reserved legacy realmente irresoluble puede conservarse pendiente o cerrarse consumiendo una unidad por decisión administrativa conservadora. Su evidencia registra que se aplicó esa política a un intento desconocido, sin afirmar un envío o cobro demostrado. Liberarlo exige evidencia verificable de no despacho y exclusión del ejecutor antiguo; un motivo escrito, desconocer el coste, tener permiso superadmin o superar cierta edad no bastan. No se modifica retroactivamente un released/completed histórico ni el presupuesto del proveedor.

Las firmas exactas, esquemas, enum de fundamentos y ubicación de migraciones/índices se fijan en R0-QUOTA-P contra la base acumulada. Son decisiones técnicas del implementador; no pueden alterar las reglas económicas de Q1/Q2. El recibo nuevo exige allowlist Worker y denegación SDK; no asumir que basta un tipo TypeScript.

## Autoridad, períodos y privacidad

Nuevas reservas y nuevos intentos released revalidan actor, negocio, modo/canal, permiso comercial, consentimientos y política de admisión en servidor. Un recibo nunca concede lectura de conversación, acceso tras transferencia de dueño ni permiso para inferir nuevamente. Recuperar datos de propuesta/cita pasa por sus lectores actuales, con sus controles vigentes.

La finalización técnica de un intento ya admitido puede reparar contadores tras revocación, vencimiento o cambio de dueño, validando identidad/pruebas; no publica texto ni requiere recuperar el consentimiento para cerrar un trabajo revocado. Liquidar no autoriza al actor anterior a consultar el estado del negocio nuevo. APIs privadas no-store, cuerpo estricto/acotado, autorización independiente del cliente y auditoría sanitizada. No hay endpoint público para reservar, marcar despacho o editar cuota directamente.

Conservar scopeId/periodId/attemptId desde reserve. Cambio de plan, ampliación, gracia o creación de próximo período no trasladan el consumo a otra vigencia. Actualizaciones concurrentes sobre extras y settlement reintentan desde el estado actual del mismo período. Período ausente/corrupto tras restore no se sustituye por el período de hoy: error honesto y conciliación. Restore tampoco resetea marcadores ni recibos.

S03 mantiene exactamente su tombstone técnico y sus 24h/30d: no añadir cuerpos, UID/anclas ni ampliar permisos para recuperar cuota. El recibo de cuota se conserva mientras sea necesario para impedir reaplicación, junto al turno y su período; no se promete purga temporal nueva sin contrato de retención/backup. Una futura purga debe preservar el fence terminal o cerrar definitivamente el namespace del request, nunca habilitar un replay como nuevo.

## Compatibilidad y operación

Despliegue aditivo con lectores primero: legacy sin fase se interpreta incierto. No reescribir todas las reservas como prepared. Los released históricos conservan sus contadores, pero sin prueba durable de no despacho su mismo requestId queda cerrado para otra inferencia: drenar el proceso no demuestra que la llamada anterior no ocurrió. No se cobra retroactivamente una unidad que el contrato viejo ya devolvió; el estado técnico informa que ese intento no puede repetirse y otro mensaje explícito usa otro requestId. Solo un released del protocolo nuevo con recibo de no despacho puede re-reservarse con otro attemptId. En el corte de escritor se drena/para la única réplica y se conservan sus pendientes como unknown; sin esa barrera, un binario viejo podría seguir enviando sin consultar el marcador. No autoriza aquí reiniciar producción.

El binario viejo ignora fases y podría liberar indebidamente: rollback a ese escritor después de activar el protocolo nuevo no es compatible. Preparar rollback lector compatible, gates de versión y prueba de Worker anterior antes de habilitar el nuevo escritor. Flags apagados no suspenden lectura técnica, reconciliación o conservación de cercas. Se mantiene una réplica por cola local y solo alsdevstudio.com para motor remoto.

Mantenimiento acotado por páginas de hasta 50 intentos; cursor estable y reconciliación idempotente, sin buscar cuerpos/usuarios. Los campos/indexes de siguiente revisión se precisan en el desglose para D1 y Firestore; no usar un scan global oculto ni el límite de consulta como prueba de backlog vacío. La conciliación técnica no llama proveedores ni dispara outboxes. Métricas sanitizadas de pendientes/unknown/errores y edad, sin prometer alertas que aún no están implementadas.

## Aceptación que deberá construir el desglose

1. Crash/ACK perdido en cada frontera de la matriz; cero segundo fetch tras marca incierta y cero doble movimiento de contadores/recibo.
2. Dos handles D1 y Firestore: reserva vs cierre prepared, marcador vs liberación, último cupo, mismo request/fingerprint distinto y handle viejo contra intento nuevo.
3. Marcador guardado pero ACK perdido: se consume conforme A aunque fetch sea cero; no falsear evidencia de gasto ni usar callback count. Antes de la marca, cancelación probada libera; después no.
4. Respuesta inválida, error HTTP, timeout, revocación o cambio humano después de iniciar: reglas Q1 y no publicación indebida. Prueba explícita para la rama de WhatsApp y errores después de propuesta durable.
5. Cache informativa perdida/reinicio: recibo técnico recuperable sin texto ni nueva inferencia. Propuesta/cita conservan ID, estado posterior y su prueba original.
6. Settlement perdido/concurrente, cambio de plan/extras/período, rollback y restore: mismo intento/período, contadores válidos o error honesto; nunca reset ni segunda capacidad.
7. Conciliación de Q2: anónimo/cliente/dueño/staff denegados; superadmin con prueba acotada, replay administrativo, conflicto de decisión, sin release arbitrario de marcador verdadero ni ajuste de gasto operativo implícito.
8. S03: publicación/settlement atómicos, reserve.authorize cerca operación, ACK perdido con reservation nullable, tombstone sin contenido ni clave, guards y cleanup aun escritor apagado. Cambiar `existingChatQuotaSemanticsUnchanged` por una prueba de compatibilidad que distinga identidad histórica preservada de la devolución genérica modificada por Q1.
9. Contabilidad y logs no contienen prompts/respuestas/argumentos/credenciales; rutas no-store y validación estricta. Pase focal no sustituye QA integral ni autoriza operaciones reales.
10. Cierre técnico legacy mientras el HTTP del motor sigue activo: al resolver la promesa HTTP del proveedor no se crea propuesta/estado/cache/outbox tardío. En el orden inverso, el resultado durable gana y la recuperación lo conserva. Probar ambos órdenes con dos handles y pérdida de ACK; ningún recibo terminal se reescribe para simular el orden contrario.

## Revisión pendiente

Q1/Q2 están decididas mediante las respuestas estructuradas del propietario a las dos preguntas de esta tarea. Las demás decisiones técnicas siguen siendo propuestas del agente, no declaraciones del propietario. La revisión independiente de constructor identificó una cuestión adicional: efectos legacy que llegan después del cierre técnico. Se resolvió como decisión técnica conservadora del agente mediante la invariante 8, la composición transaccional y el caso 10: el cierre cerca efectos tardíos; un resultado que ya ganó conserva su prueba. No se trata de otra decisión económica ni se construyó esa solución en esta tarea.

Esta versión incorpora ambas respuestas y se presenta para aprobación del documento completo. Solo después de esa aprobación registrar contractApproval con su hash exacto y cerrar R0-QUOTA-D como verified; R0-QUOTA-P seguirá siendo la siguiente tarea, sin ejecutarla en la misma invocación. Las respuestas a Q1/Q2 no se registran como aprobación automática de la versión completa.
