---
name: avanzar
description: Use when the user invokes /avanzar or explicitly resumes the persistent Fresha implementation plan in the Sarin repository.
---

# Avanzar

Completar una tarea por sesión como norma, conservando una tarea por invocación de `/avanzar`. Esta entrada del proyecto remite al plan y a su verificador; no es un comando nativo de la aplicación ni una autorización para efectos reales.

El propietario autorizó de forma persistente hacer commit y push al terminar cada tarea validada y aclaró el 3 de noviembre de 2026: «todo debe ser dentro de main», con integración del PR actual para desplegar a producción. Aplicar `preferences.gitDelivery`: destino main y despliegue del código mediante su CI habitual, sin volver a pedir esa autorización. Esto sustituye el «commit local, sin push» y la entrega solo a rama de trabajo de instrucciones anteriores. Activar capacidades, exportar/restaurar datos reales, cobrar o enviar mensajes conserva su aprobación específica.

## Autoridad y lectura inicial

Leer AGENTS.md, `docs/implementation/fresha/PLAN.md` y `docs/implementation/fresha/tasks.json` desde `workspace.controlRoot`. Ese JSON es la única autoridad de progreso. El trabajo de producto ocurre en `workspace.codeRoot`; el checkout de control contiene cambios históricos y se preserva. R0-001 crea la base aislada. Un worktree nuevo recibe la referencia al control, nunca otra copia mutable del estado.

Una copia versionada de esta skill en codeRoot no cambia esa autoridad: resolver controlRoot mediante AGENTS.md y usar allí la skill, sus scripts y el estado vigente. No inicializar tasks.json en el worktree para hacer funcionar una copia distribuida.

Parsear el JSON y consultar aprobación/workspace, preferencias vigentes, tarea elegida, dependencias y requisitos afectados; no volcar la cola completa al contexto. Una solicitud de ejecución histórica con todos sus IDs cerrados no autoriza continuar otro módulo. El verificador revisa el grafo entero sin necesitar ese volcado.

Desde controlRoot ejecutar:

```powershell
node .agents/skills/avanzar/scripts/check-plan.mjs --next
```

El verificador valida y selecciona; no ejecuta `checks[].command`. Leer esos comandos como contratos revisables, identificando CWD y simulaciones antes de ejecutarlos.

## Modelo y esfuerzo por tarea

El propietario pidió recomendar modelo/esfuerzo para ahorrar tokens, **solo al finalizar una tarea completamente validada y entregada**. No anunciar esa recomendación al iniciar `/avanzar`. Aplicar la [guía de selección](../../../docs/tooling/sarin-model-selection.md) al siguiente ID real, sin volver a analizar la cola completa ni cambiar configuración global.

Después de comunicar tarea completada, comprobaciones, commit/push y despliegue verificados, añadir **«Ya puedes iniciar otra sesión y usar /avanzar para ID con modelo nombre y esfuerzo nivel. Motivo: una frase.»** Si queda trabajo, CI o entrega pendiente, informar el estado sin dar ese cierre ni recomendar la próxima tarea; sin tarea elegible, explicar el bloqueo. Revaluar con el contrato real, sin rebajar pruebas, permisos ni evidencia. La preferencia se conserva en `preferences.modelSelection`.

## Selección y revisión

1. Si el plan v1 sigue `pending_review`, el primer `/avanzar` posterior a su entrega registra la revisión aprobada de esa versión con referencia al mensaje. Si el mensaje pide cambios, revisarlos en vez de aprobar. No reutilizar esta aprobación para un nuevo contrato, versión o efecto externo.
2. Si hay `currentTaskId`, reanudar exclusivamente esa tarea con su `resume`. Con `needs_input`, contrastar la respuesta recibida con la pregunta guardada. Una respuesta no es automáticamente aprobación de todas las decisiones restantes.
3. Sin tarea actual, elegir exactamente el ID devuelto por el verificador. Leer su ancla, spec y archivos actuales; cargar solo las skills pertinentes. Usar executing-plans para trabajo de ejecución; brainstorming/grilling para decisiones y writing-plans para desglosar. Los nombres/alias instalados están en `docs/tooling/sarin-skills.md`.
4. Si el verificador rechaza el estado, reparar la inconsistencia como único trabajo de esta invocación, conservando evidencia. No ejecutar a continuación otro diseño o cambio de producto. Un P con hijos vacíos no permite saltar al módulo siguiente.
5. Si no hay tarea elegible, explicar el bloqueo concreto. Si la primera tarea con dependencias satisfechas espera `authorizationKey`, preparar/mostrar la operación y pedir solo su autorización pendiente, conservando `needs_input`. No saltar la tarea ni fabricar una aprobación.

## Ejecutar y guardar

- Registrar una sola tarea activa (`in_progress` o `in_qa`) y su `currentTaskId`. Antes de cada escritura releer `revision`; ante otro escritor, reconciliar sin sobrescribir. Incrementar `revision`, validar el documento nuevo y reemplazar atómicamente usando un archivo temporal hermano. Un solo controlador escribe el estado; los colaboradores entregan artefactos/evidencia sin modificarlo.
- Guardar `resume` con paso, artefactos, error/pregunta y efecto incierto. Si faltan decisiones materiales que no constan en fuentes o respuestas previas, marcar `needs_input` y preguntar. Seguir con investigación independiente dentro de esta tarea; no iniciar otra.
- En diseño/desglose, verificar el contrato aprobado contra la base actual. Cada P inserta hijos `build` funcionales y un `integration` que depende de todos ellos; `expansion.children`/`integrationTaskId` los identifican. Reencadenar `continuationTaskIds` y gate de fase hacia esa integración. Registrar sus archivos, interfaces, casos concretos por Axx, aceptación y checks. Una lista genérica de módulos no sustituye esos hijos.
- Al cerrar un diseño guardar `contractApproval: {status: "approved", reference: <mensaje real>, artifact: {path: <spec relativa al control>, sha256: <hash del documento aprobado>}}`. Comprobar el hash antes de ejecutar su desglose; un contrato cambiado necesita la revisión correspondiente. La aprobación global del flujo no aprueba contratos posteriores.
- Actualizar `requirements[].implementationTaskIds` con todos los hijos que completan el alcance del ID. `implementationResolved` permanece falso hasta comprobar su implementación íntegra o una capacidad existente con evidencia. No marcarlo por cerrar D/P, por un panel vacío o por una lista sin tareas.
- En cambios de comportamiento, usar TDD, pruebas focales de éxito/fallo/autoridad y backends pertinentes; ponytail conserva el cambio mínimo completo. Antes de UI leer DESIGN.md; para superficies nuevas sustanciales capturar PRODUCT.md, sin inventar identidad. Resolver el modo antislop pendiente al primer uso aplicable, sin reinstalar extensiones. Cargar seguridad/rendimiento/diseño según el alcance, no como ceremonia en toda tarea.
- Revisar el resultado y usar verification-before-completion. Cada evidencia de cierre requiere `type` (command/artifact/review/qa/remote/existingImplementation), `reference`, `sha` (40 caracteres del commit base/candidato), `cwd` y `result` con alcance/límites. Si type=command, añadir `command` y `exitCode` reales. Para un diff sin commit, conservar además su hash en la referencia/artefacto; el SHA base no afirma que ese diff esté publicado. Código focalmente comprobado pasa a `implemented`; diseño/desglose/gate revisado a `verified`. `published` y `activated` necesitan hechos remotos y aprobación del efecto exacto.
- Antes de cerrar una tarea con cambios versionables, completar la entrega Git descrita abajo. Solo después despejar `currentTaskId`; una tarea inconclusa conserva su estado/puntero/continuación. Validar tras guardar. Comunicar ID, resultado, comprobaciones, límite o pregunta pendiente y siguiente ID, y **detener la invocación**.

## Commit y push al terminar

La entrega Git forma parte del cierre, también para diseño, desglose y documentación. Tras pasar los checks aplicables:

1. Revisar `git status`, diff, rama, remoto y commits aún no subidos desde codeRoot. Versionar únicamente archivos propios de la tarea, con un commit enfocado; preservar cambios ajenos y no usar `git add .`. Si el push incluiría commits ajenos o de procedencia incierta no autorizados, no publicarlos incidentalmente: conservar la tarea y resolver su alcance/destino sin reescribir historia. Los entregables documentales propios pueden trasladarse explícitamente desde controlRoot al worktree para versionarlos; no copiar sus archivos de aplicación históricos ni el tasks.json mutable. Una tarea sin cambios versionables registra «sin cambios nuevos» y el SHA existente: no fabricar un commit vacío; comprobar igualmente su presencia remota y, si falta, entregar solo los commits propios autorizados tras validar su alcance.
2. Usar `origin` del repositorio registrado y main como destino final. Reutilizar el worktree aislado reconciliado, sincronizado con main; no crear ramas por defecto ni usar el checkout mixto como fuente de producto. Para la rama ya creada, completar el PR solicitado hacia main; si una protección exige PR en el futuro, usarlo solo como paso de integración y no cerrar dejando el código fuera de main. No pedir otra autorización para ese merge ni para el despliegue habitual de CI ya autorizado. No hacer force-push, saltar protecciones, incorporar cambios ajenos o activar capacidades al integrar.
3. Hacer commit y push/integración a main tras validar. Comprobar mediante lectura remota el SHA entregado en main, los checks y el despliegue de producción de ese mismo SHA; un push a una rama auxiliar no completa la entrega. Los checks requeridos proceden de la tarea, los workflows aplicables y las reglas consultables del repositorio. Esperar sus resultados y corregir fallos dentro del alcance autorizado. Registrar PR si lo hubo, SHA de main, ejecución CI y evidencia de Worker/Container/Pages según el pipeline. No afirmar CI ni producción comprobados mientras estén pendientes.
4. Si commit, push, merge, check requerido o despliegue falla, mantener la misma tarea actual y guardar en `resume` el paso pendiente, SHA, destino, error saneado y comprobaciones realizadas. No cerrar ni seleccionar otra tarea. Con un efecto incierto, consultar primero el remoto/estado del despliegue antes de repetirlo. La entrega ordinaria a main no acepta la QA integral Fresha ni activa capacidades externas; los estados published/activated de tareas finales conservan sus gates y evidencia.

## Cierre y nueva sesión

Seguir `preferences` y la [guía de continuación](../../../docs/implementation/fresha/CONTINUAR.md). El cierre contiene, en este orden: ID y resultado real; commit/destino del push cuando correspondan; comprobaciones y límites del mismo candidato; siguiente ID del selector y cómo retomar.

- **Entrega de implementación en main y producción comprobadas:** comprobar validaciones locales, referencia main, CI/checks y despliegue por el mismo SHA. Cerrar con: **«Ya podemos iniciar otra sesión y usar /avanzar.»**
- **Diseño/desglose/documentación:** identificar su resultado documental y commit/push comprobados, sin presentarlos como producto implementado o desplegado; indicar siguiente tarea y cómo retomar.
- **Tarea incompleta o `needs_input`:** señalar la pregunta/fallo y `resume`; explicar que en otra sesión `/avanzar` retoma esa misma tarea. No anunciarla terminada ni saltar al siguiente ID.

La evidencia de otra entrega no acredita la actual. CI pendiente/fallido, SHA discrepante o una verificación requerida bloqueada se comunican con su alcance; no se convierten en «todo validado». La autorización persistente cubre entrega a main y despliegue habitual del código, no activación, datos reales ni envíos. Tras el cierre de la tarea, detenerse; la siguiente se atiende en otra sesión salvo petición posterior explícita del propietario.

## QA y efectos externos

La campaña integral Playwright MCP empieza tras BUILD-FREEZE. Antes: `node .agents/skills/avanzar/scripts/check-plan.mjs --ready-for-qa`. Comprobar herramientas MCP expuestas y datos demo; la instalación o about:blank no acredita QA del producto.

Si QA encuentra un defecto, guardar caso/reproducción y suspender esa QA en `pending`, conservando `resume` y dejando `currentTaskId=null`. Insertar una corrección acotada con `phase: "FIX"`, `kind: "build"`, `requiresCodeWorkspace: true` y regresión que depende de los prerrequisitos anteriores de esa QA, **no de la QA fallida**. La QA pasa a depender de la corrección. La próxima invocación ejecuta esa corrección; después se repiten los casos y se actualiza la identidad del candidato. FIX no pertenece a QA ni R0–R5: evita exigir verificación integral al estado implemented de la corrección o invalidar retroactivamente BUILD-FREEZE por su inserción. Esto evita ciclos y evita reanudar indefinidamente la QA antes de corregir. Un cambio invalida aceptación afectada y los cierres posteriores que dependan de ella; reabrirlos coherentemente.

Antes de una operación real con `authorizationKey`, comprobar de nuevo `approval.external[authorizationKey]` y su correspondencia con artefacto, entorno, canal, destinatario, contenido y límites pertinentes. El commit/push a main y su despliegue habitual están autorizados por la preferencia expresa vigente; no usarla para enviar, cobrar, inferir con coste, exportar/restaurar datos o activar capacidades. Una respuesta incierta se investiga antes de repetir el efecto. El plan 07 conserva la separación entre aceptación global, capacidades y transporte.

## Comprobación del coordinador

```powershell
node --test .agents/skills/avanzar/scripts/check-plan.test.mjs
```

Estos tests verifican invariantes del coordinador, no funciones de Sarin. No ejecutar la suite de producto para una modificación meramente documental de esta entrada.
