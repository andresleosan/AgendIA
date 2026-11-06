# Modelo y esfuerzo para /avanzar

Preferencia solicitada por el propietario el 5 de noviembre de 2026: recomendar una configuración proporcionada a cada tarea para evitar gasto innecesario. Es asesoría para elegir en Codex, no un cambio automático del modelo, del presupuesto ni de las aprobaciones.

## Regla de elección

Leer únicamente la tarea seleccionada por el coordinador, su aceptación, dependencias pertinentes, ancla/contrato y `resume`. Elegir por dificultad real y coste de un error, no por cantidad de archivos, longitud del plan o sufijo D/P/B/I. Ahorrar implica completar correctamente con menos trabajo total, incluyendo correcciones.

| Trabajo concreto | Modelo recomendado | Esfuerzo inicial |
| --- | --- | --- |
| Edición documental mecánica, extracción o comprobación acotada con resultado inequívoco | GPT-6-Luna | bajo (`low`) |
| Implementación acotada con contrato claro, UI local, desglose rutinario o QA guiada por casos conocidos | GPT-6.1-Sol | medio (`medium`) |
| Autoridad, transacciones, idempotencia, D1/Firestore, migraciones, recuperación o integración con interacciones conocidas | GPT-6.1-Sol | alto (`high`) |
| Arquitectura todavía ambigua, invariantes difíciles de concurrencia/efectos externos o diagnóstico que sigue sin causa con evidencia | GPT-6-Astra | alto (`high`) |
| Recorrido principalmente visual/computer-use o corrección pequeña y verificable | GPT-6.1 Terra | medio (`medium`), como alternativa a Sol |

- No usar `xhigh`, `max` o `ultra` por defecto. Proponerlos solo ante una dificultad concreta que no resolvió un intento bien dirigido, explicando qué se espera mejorar. Una espera de CI, un problema de acceso o una decisión pendiente del dueño no se resuelven subiendo esfuerzo.
- Un D/P de permisos, ledger, pagos o datos sensibles puede necesitar alto/Astra; ser documental no lo vuelve mecánico. Un B simple no necesita Astra por ser código. Una integración financiera o de resiliencia puede requerir Astra si implica reconstruir invariantes, no solo ejecutar checks.
- Escalar por evidencia: fallo reproducible sin causa, contrato contradictorio o riesgo nuevo. Conservar pruebas/estado, recomendar una configuración superior y explicar el motivo; no reinvestigar desde cero ni fingir haber cambiado el modelo. Mantener validaciones y revisiones requeridas.
- Estas son estimaciones iniciales de ingeniería, no resultados de un benchmark Sarin ni promesas de porcentajes de ahorro. Menos esfuerzo suele reducir razonamiento, pero un modelo insuficiente puede gastar más al rehacer trabajo. Precios API y consumo del plan Codex no son equivalentes.

## Aplicación al proyecto

La cola combina construcción R0/R1, contratos y desgloses R2–R5, gates, QA y entrega. Buena parte del trabajo ya tiene contratos concretos: Sol es el punto de partida, revisando los riesgos de cada tarea. Los módulos de autoridad/CRM privado, pagos/ledger, consentimientos, canales y restauración justifican más atención que una edición visual aislada.

Estimación para el módulo de admisión ya desglosado; `tasks.json` sigue siendo la única autoridad de orden/estado:

| Tarea | Modelo / esfuerzo | Motivo |
| --- | --- | --- |
| R0-POLICY-B1 | GPT-6.1-Sol / alto | Modelos y lectores compatibles en D1/Firestore; propietario, restricciones y restauración bajo contrato definido. |
| R0-POLICY-B2 | GPT-6.1-Sol / alto | El protocolo ya está detallado. Escalar a Astra/alto si barrera local, commit incierto y resolución del transporte revelan una contradicción o carrera sin causa. |
| R0-POLICY-B3 | GPT-6.1-Sol / alto | Propiedad transaccional, CAS, reintentos y API con autoridad separada. |
| R0-POLICY-B4 | GPT-6.1-Sol / alto | Varios puntos de entrada, recuperación independiente y cuota/outbox. |
| R0-POLICY-B5 | GPT-6.1-Sol / alto | UI junto al corte de admisión, compatibilidad y preflight de despliegue. |
| R0-POLICY-I | GPT-6.1-Sol / alto | Verificación cruzada de los cinco hijos y restauración; escalar si aparecen invariantes sin resolver. |
| R0-OBS-D | GPT-6.1-Sol / medio | Comparar señales y minimización sobre arquitectura existente; reevaluar si aparece una decisión técnica difícil. |

## Qué comunicar y cuándo

Al iniciar `/avanzar`, tras la selección ligera y antes de investigar extensamente, informar el ID, modelo, esfuerzo y una razón breve para esa tarea. Al cerrar, repetir el formato para el siguiente ID real del selector; si la actual queda incompleta, recomendar para retomarla. Si no hay tarea elegible, explicar el bloqueo sin inventar una siguiente tarea.

Ejemplo: **«Próxima tarea: R0-POLICY-B1. Modelo: GPT-6.1-Sol. Esfuerzo: alto (high). Motivo: compatibilidad de políticas y restricciones en dos backends.»**

La recomendación al cierre permite al propietario seleccionar modelo/esfuerzo antes de abrir la siguiente sesión. No editar `config.toml`, cambiar configuración global, abrir otra sesión ni detener automáticamente la tarea esperando una confirmación. Si el propietario pide expresamente esperar al cambio, respetarlo. No afirmar que el agente puede cambiar su propio modelo en mitad del turno.

## Contexto y consumo

- No volver a analizar la cola completa ni el repositorio entero en cada invocación. Reutilizar contrato/evidencia y leer fragmentos precisos. Evitar volcar `tasks.json`, catálogos completos, resultados extensos o skills ajenas al alcance.
- Delegar solo trabajo independiente que aporte utilidad; dar contexto mínimo y pedir resultados breves. Evitar duplicar la misma investigación o usar varias revisiones donde basta una. Conservar las revisiones independientes exigidas por el flujo.
- Consultar disponibilidad con el catálogo local de Codex cuando haya duda; usar solo modelos visibles y esfuerzos soportados. Si cambian nombres/oferta o falta el recomendado, verificar documentación oficial y proponer el equivalente disponible. No repetir búsquedas de modelos/precios en cada tarea si no hay cambios relevantes.
- No recortar tests necesarios, seguridad, persistencia ni verificación de entrega para ahorrar tokens. Informar cambios relevantes y cierre de forma breve.

Fuentes consultadas el 5 de noviembre de 2026: catálogo local de Codex (`models_cache.json`, solo metadatos de modelos visibles), [selección de modelos de OpenAI](https://developers.openai.com/api/docs/guides/model-selection) y [guía de esfuerzo de razonamiento](https://developers.openai.com/api/docs/guides/deployment-checklist). La guía oficial distingue Luna para trabajo acotado, Sol para trabajo complejo con atención al coste y Astra para problemas más exigentes; la asignación a las tareas de Sarin es juicio técnico del agente.
