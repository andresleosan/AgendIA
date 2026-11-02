# Recuperación de cuota de respuestas

El protocolo 2 separa la capacidad comercial del gasto del proveedor. Una llamada que pudo iniciarse consume una unidad del plan aunque falle o no se publique. Una devolución exige el intento exacto todavía `prepared`, sin marca de despacho, cerrado mediante la misma transacción que ajusta su período. La antigüedad no demuestra que una llamada no ocurrió.

## Publicación y corte de escritor

La autorización de implementación no equivale a conciliar intentos reales. En esta entrega, el propietario solicitó expresamente el 2 de noviembre de 2026 implementar B1–B5 e integración, validar, hacer commit y push para probar en producción. Esa publicación se registra separadamente de la aceptación integral Fresha.

1. Validar el candidato exacto y guardar su revisión y SHA. Conservar un backup privado D1/R2 y las identidades de Worker, imagen, réplica y Pages antes del corte. Nunca incluir el export ni credenciales en Git.
2. Aplicar únicamente la migración aditiva `0014_response_quota_recovery.sql`. No ocupar los ordinales 0012/0013 reservados para otros contratos. En Firestore desplegar los dos índices de `responseQuotaTurns` antes de habilitar mantenimiento allí.
3. Para un restore o corte manual con escritores activos, activar `SARIN_MAINTENANCE=true`, drenar solicitudes y detener la única réplica anterior. En el release de Container con sustitución inmediata, no crear el marcador hasta comprobar que el rollout terminó, la única instancia activa corresponde a la imagen v2 aceptada y ninguna instancia de la versión anterior sigue activa. La ausencia del marcador impide nuevas reservas en el escritor v2 durante esta transición.
4. Verificar Worker, Container y Pages contra el mismo SHA de main. No inferir que un push terminado prueba el despliegue. Una respuesta incierta se investiga antes de repetir la operación.
5. Crear una sola vez el documento privado `serverSettings/responseQuotaProtocol` con este esquema, usando valores observados:

   ```json
   {
     "version": 2,
     "minimumWriterProtocol": 2,
     "sourceSha": "SHA_GIT_DE_40_HEXADECIMALES",
     "oldWriterStoppedAt": 0,
     "reviewArtifactSha256": "SHA256_DE_LA_REVISION_DE_64_HEXADECIMALES"
   }
   ```

   `oldWriterStoppedAt` es el instante UTC en milisegundos en que se comprobó la barrera del escritor anterior; cero es solo un marcador de posición de este ejemplo. El documento no es editable ni eliminable por el protocolo de datos. Si se usa SQL administrativo, hacer `INSERT` condicionado a su ausencia y actualizar `app_revision` atómicamente. Una repetición debe leer y comparar el documento existente, nunca reemplazarlo.

   Para SQL administrativo, el batch debe usar el mismo guard de `app_commits` y avance de `app_revision` que el driver, seguido del INSERT único del marcador. Un conflicto revierte el batch completo. La [API D1 documenta las consultas múltiples como batch](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/); no enviar escrituras independientes sin esa atomicidad.
6. Reanudar mantenimiento si fue pausado. Comprobar lectura del marcador, versión de la instancia, índices y respuestas HTTP privadas sin sesión. Registrar el resultado remoto y cualquier intervalo de indisponibilidad de IA. No enviar mensajes ni hacer llamadas pagadas como comprobación implícita.

La agenda conserva su operación independiente de la bolsa de IA. Si el marcador falta, las nuevas llamadas de IA reciben `AI_QUOTA_PROTOCOL_NOT_READY`; no omitir esa validación para hacer pasar una prueba.

## Recuperación y revisión

El cron procesa una página de hasta 50 visitas cada cinco minutos, aunque WhatsApp esté deshabilitado. Comparte las decisiones puras con Node. El descubrimiento histórico guarda cursor por ID; las páginas de vencidos vuelven a la cabeza del índice porque los intentos resueltos salen de la selección. Un lote lleno no prueba que terminó el backlog.

- `prepared` vencido: cerrar y devolver mediante CAS, sin permitir que el ejecutor antiguo despache o publique después.
- Posible despacho: consumir una vez, conservando el período original y un recibo mínimo.
- Resultado registrado: conservar la primera prueba aunque una propuesta posteriormente se confirme o cancele; devolver la vista actual solo con sus permisos vigentes.
- Histórico sin fase verificable: conservar la reserva como `legacy_unknown`. El descubrimiento no cambia sus contadores ni repite la llamada.
- Registro o período corrupto/ausente: error explícito. No recrear capacidad. El fallo de esta recuperación se registra con un evento fijo y no bloquea los otros mantenimientos.

Solo el superadministrador puede consultar `GET /api/admin/response-quota?after=<id>` y conciliar mediante `PATCH`. El cuerpo estricto contiene `requestId`, la reserva completa, `expectedFingerprint`, `resolution`, una razón de 1–300 caracteres y `evidenceSha256`. Las decisiones son `consume`, `keep_pending` y `release_undispatched`. El digest de evidencia o una razón escrita no demuestra por sí solo ausencia de despacho. Un request administrativo repetido devuelve el resultado original; cambiar su cuerpo produce conflicto. El permiso implementado no autoriza ajustes reales sin su decisión operativa correspondiente.

## Restore y rollback

Restaurar en destino vacío, con escritores y cron pausados mediante mantenimiento. Conservar intentos, fases, marcas, recibos, revisiones, cursor, marcador y períodos; verificar hashes y conteos antes de abrir el destino. Una marca restaurada no otorga permiso para volver a llamar al proveedor. Un período faltante se investiga, no se sustituye por el vigente.

Después de crear el marcador, rollback solo a un escritor que entienda v2 y conserve sus cercas. El binario anterior `8890174` no es un rollback compatible. Mantener la imagen v2 verificada por digest; si falla, pausar nuevas operaciones y corregir hacia delante o volver a otra imagen v2 verificada. No borrar el marcador, recibos ni fases para hacer funcionar una imagen antigua.

Los recibos y revisiones no guardan prompts, respuestas, argumentos del modelo ni credenciales. No publicar exports, cuerpos ni errores crudos en evidencia operativa.
