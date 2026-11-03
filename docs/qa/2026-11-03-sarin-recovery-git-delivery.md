# Entrega Git de recuperación y cierre de avanzar

El propietario pidió el 3 de noviembre de 2026 «hacer push» y que la skill avanzar hiciera commit y push al terminar cada tarea. La instrucción persistente queda en `preferences.gitDelivery` del único tasks.json de control. No se inicia R0-BACKUP-B3 ni se cambia su selección.

Se publicó el código acumulado de B1/B2 al remoto `origin`, repositorio `andresleosan/SarinBotSAAS`, rama `codex/fresha-implementation-20261030`. El primer `git push --set-upstream origin codex/fresha-implementation-20261030` salió con código 0. La lectura independiente `git ls-remote --heads origin refs/heads/codex/fresha-implementation-20261030` confirmó `dd130da094775d4a0eec27c67d1181134b27d35a`.

La actualización del flujo se entrega después como commit documental en esa misma rama. Se versionan la skill, sus dos scripts existentes de coordinación/pruebas y la guía de continuación. Las copias activas permanecen en controlRoot; los scripts deben ejecutarse allí y tasks.json nunca se copia al worktree. El commit documental no modifica la aplicación ni el lockfile; conserva las modificaciones previas ajenas del worktree.

## Cambio de comportamiento

- Después de validar una tarea con cambios versionables, commit enfocado y push al destino registrado sin repetir autorización. La instrucción nueva sustituye el «commit local, sin push» de subplanes anteriores.
- Verificar el SHA remoto y los checks aplicables antes de cerrar. Un fallo de entrega conserva el ID actual y `resume`; con resultado incierto se lee el remoto antes de reintentar.
- Tareas documentales también se versionan. Sin cambios versionables no se fabrica commit vacío; se verifica el SHA remoto existente y no se duplica el estado mutable.
- El push no incluye cambios/commits ajenos de forma incidental. No se cambia destino, fusiona o fuerza la historia por iniciativa propia.
- `main` dispara despliegue de producción según `.github/workflows/verify.yml`; conserva autorización del efecto concreto. Push a rama de trabajo no significa producto desplegado ni estado `published`.

## Validación

El escenario basal independiente `avanzar_delivery_baseline` mostró la causa del comportamiento anterior: la skill permitía cerrar código comprobado localmente, despejar currentTaskId y continuar sin push cuando el subplan decía «sin push».

El escenario independiente `avanzar_delivery_forward` aplicó la skill nueva a build probado, push rechazado, conexión perdida después de aceptación remota, main con auto-deploy, documentación y cambio solo de tasks.json. Resolvió commit/push sin nueva confirmación a la rama autorizada, retención de la tarea ante fallo, lectura antes de reintento, aprobación específica de main y ningún commit vacío. Detectó tres aclaraciones que se incorporaron: fuentes de checks requeridos, SHA remoto en tareas sin cambios versionables y commits ajenos aún no publicados; también se explicitó cómo registrar un cambio de destino aprobado.

El validador de Skill Creator comprobó formato/nombre: `Skill is valid!`. Los 20 tests existentes del coordinador pasan y el plan conserva 175 tareas/165 requisitos con siguiente ID R0-BACKUP-B3. No se añadió un test que simplemente busque texto de la skill. Las pruebas de producto de B2 siguen documentadas en `2026-11-02-sarin-recovery-b2.md`; no se repiten por este cambio de instrucciones.

El workflow existente solo se dispara automáticamente en push a main o en pull requests; esta entrega a la rama de trabajo no dispara CI. No se declara CI aprobado ni despliegue. No se creó PR, no hubo activación, exportación privada o envío real. La evidencia final del commit documental y su SHA remoto se registra en tasks.json después del push, sin modificar la aprobación del contrato de recuperación.
