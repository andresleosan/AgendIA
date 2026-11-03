# Continuar Sarin en otra sesión

Abre una sesión nueva en el proyecto **E:/Proyectos/Sarin Bot** y escribe:

```text
/avanzar
```

La skill del proyecto es [avanzar](../../../.agents/skills/avanzar/SKILL.md). Si la interfaz no reconoce el alias, escribe:

```text
Lee .agents/skills/avanzar/SKILL.md y continúa el plan de Fresha: reanuda la tarea actual o ejecuta únicamente la siguiente elegible. Una tarea por sesión. Conserva el progreso y las aprobaciones de docs/implementation/fresha/tasks.json.
```

`/avanzar` es una instrucción conversacional del proyecto; no se registra como comando nativo ni requiere instalar otra skill. No hace falta copiar la conversación anterior: contratos, decisiones, evidencia y puntos de continuación se conservan en el control.

## Lo que hará cada sesión

1. Leer AGENTS.md, el [plan maestro](PLAN.md), preferencias/estado y el contrato de la tarea. Antes de cambiar UI, leer [DESIGN.md](../../../DESIGN.md).
2. Comprobar desde controlRoot:

   ```powershell
   node .agents/skills/avanzar/scripts/check-plan.mjs --next
   ```

3. Reanudar `currentTaskId` y su `resume`, o seleccionar exactamente la siguiente tarea elegible. Trabajar el producto en `workspace.codeRoot`, aislado del checkout mixto; el estado continúa solo en `workspace.controlRoot`.
4. Resolver hechos en código/docs/herramientas; usar brainstorming/grilling para decisiones materiales y writing-plans para el desglose aprobado. Aplicar Superpowers al ejecutar, depurar, revisar y verificar según la tarea.
5. Tras validar, hacer commit enfocado y push al remoto/rama de trabajo registrados en `preferences.gitDelivery`, sin pedir de nuevo esa autorización. Comprobar el SHA remoto y los checks aplicables. Guardar resultado, evidencia, limitaciones y continuación con revisión atómica del JSON; despejar la tarea actual solo al completar la entrega. Un fallo de commit/push conserva el mismo ID y su paso pendiente para otra sesión. No copiar el tasks.json mutable al worktree.

## Tareas y herramientas ya incluidas

La lista completa y sus dependencias están en [tasks.json](tasks.json); los módulos se explican en [PLAN.md](PLAN.md). No crear otro archivo de progreso. La cantidad aumenta cuando un desglose aprobado inserta construcción e integración reales; un diseño terminado no equivale a funcionalidad implementada.

| Trabajo | Skills y reglas |
| --- | --- |
| Decisiones y plan | brainstorming, `/grill-me` → grilling y writing-plans; preservar contratos aprobados. |
| Interfaz | Impeccable; `/taste-skill` → design-taste-frontend, recorrido app-screens; `/redesign-skil` o `/redesign-skill` → referencia redesign-existing-projects. DESIGN.md conserva Agenda clara, paleta, DM Sans, estados, navegación y alcance. |
| Seguridad | security-best-practices y frontend-security-coder cuando correspondan; autorización de servidor, aislamiento y manejo seguro de contenido/URLs/archivos. |
| Código y textos | Ponytail: mínimo cambio completo; antislop **durante la edición**, según la decisión ya recibida. |
| Rendimiento | web-performance-optimization con medidas comparables; conservar no-store y privacidad de datos privados. |
| Pruebas | Pruebas focales durante construcción. Campaña integral Playwright MCP después de BUILD-FREEZE, con defectos corregidos y casos repetidos. |

El [catálogo](../../tooling/sarin-skills.md) contiene nombres reales, fuentes fijadas y disponibilidad MCP. Tener una skill instalada no acredita una revisión. Los alias anteriores no sustituyen sus instrucciones ni registran comandos nuevos.

## Cierre de la sesión

El propietario autorizó commit y push al terminar cada tarea validada el 3 de noviembre de 2026. El destino persistente es `origin`, repositorio `andresleosan/SarinBotSAAS`, rama de trabajo `codex/fresha-implementation-20261030`; main dispara producción y conserva su aprobación específica. Esta instrucción sustituye el «sin push» de subplanes anteriores. Diseños y documentación también se versionan sin atribuirles funcionalidad. Sin cambios versionables no se crea un commit vacío.

El cierre informa tarea/resultado, SHA y destino del push comprobado, checks reales, limitaciones y siguiente ID. Si terminó una entrega de implementación con commit, push y validación del candidato, debe incluir:

> Ya podemos iniciar otra sesión y usar /avanzar.

Si queda CI, aprobación, integración, publicación o una comprobación requerida pendiente, se especifica lo que falta. Si el contrato necesita respuesta, `/avanzar` reanuda esa misma tarea; no la sustituye por otra. Un diseño/desglose cerrado se identifica como documentación, sin afirmar código publicado.

La preferencia de cerrar con ese aviso no aprueba despliegues, cambios operativos ni envíos futuros. Los efectos externos mantienen su autorización concreta. Las comprobaciones acotadas de una entrega tampoco cierran la QA integral de los165 requisitos: el zoom nativo200% pendiente permanece visible en la evidencia y se comprueba cuando corresponda.
