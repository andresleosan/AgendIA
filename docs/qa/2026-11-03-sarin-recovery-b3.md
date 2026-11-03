# R0-BACKUP-B3: cifrado e integridad del archivo

Base revisada: `5a6d9e4ab0a9598514591f2fa0ae0e50a70f8e43`. Contrato aprobado: SHA-256 `0adec33452d4634d0befc66b730b1ee78330a2107b62aa04ce714462cc1d4f3d`. El estado y la evidencia final de entrega pertenecen exclusivamente al tasks.json del checkout de control.

## Resultado de construcción

Se cifra cada archivo privado en fragmentos independientes de hasta 8 MiB con age 1.3.2. Cada ciphertext admite hasta 8 MiB + 64 KiB; el conjunto admite como máximo 1 GiB de entrada y tiene plazo de 30 minutos, cancelación y contrapresión. El índice interno cifrado vincula archivos, orden, hashes, tamaños y componentes. El sobre público solo contiene versión, UUID, fechas, estado, huella pública y descriptores opacos de ciphertext.

El adaptador exige creación exclusiva y lectura posterior de cada objeto antes de devolver `sealed`. Un reintento recibe UUID nuevos. El descifrado solo crea un directorio privado nuevo fuera del checkout, valida el índice y los objetos, y elimina su salida parcial si falla. El verificador SQL existente acepta ese conjunto validado; recuperar bytes no concede autoridad ni habilita efectos.

La captura B2 expone adicionalmente metadatos de lotes ya validados. B3 consume esos metadatos sin cargar nuevamente Auth/configuración completos. Se comprueba cobertura exacta de objetos R2 y del lote de contraseñas antes de escribir ciphertext, además de hashes y tamaños durante el cifrado.

## Procedencia de age

Los archivos oficiales Windows amd64 y Linux amd64 se descargaron una vez fuera de Git, se compararon con los pins del subplan antes de extraerlos y se verificaron con `sigsum.org/sigsum-go/cmd/sigsum-verify@v0.13.1`, política `sigsum-generic-2025-1` y las claves publicadas por age. Los hashes de archivos, pruebas, ejecutables y keygen están en `scripts/lib/recovery-age.lock.json`. Arquitecturas sin pin se rechazan.

Fuentes primarias: [release oficial 1.3.2](https://github.com/FiloSottile/age/releases/tag/v1.3.2), [procedimiento Sigsum de esa versión](https://github.com/FiloSottile/age/blob/v1.3.2/SIGSUM.md).

El instalador adicional es exclusivamente de construcción. Docker y CI reutilizan la etapa `recovery-age`; vuelve a verificar archivo, proof y ejecutables antes de copiarlos. El runtime final recibe solo age, sin keygen, verificador Sigsum ni identidad privada. CI prepara herramientas públicas para las pruebas sintéticas; una copia de producción nunca descarga un ejecutable.

## Verificación y revisión

- RED inicial: interfaz ausente; después, fallos de permisos observados y corregidos usando .NET en lugar de depender de Get-Acl en un PowerShell secundario.
- Revisión independiente `review_b3`: dos hallazgos importantes reproducidos en RED, por inventario R2/contraseñas incompleto y límite oculto de 16 MiB. Ambos corregidos; 39/39 pruebas focales de age y captura pasan. El fixture grande conserva la estructura Auth válida de B2.
- Casos: recuperación exacta de SQL/Auth/config/R2/contraseñas; clave equivocada o ausente; fragmento ausente, truncado, reordenado, duplicado o de otro conjunto; readback corrupto; colisión; cancelación de lectura detenida; plaintext cambiado; symlink; ACL pública; ejecutable alterado; path traversal y límite del conjunto antes de subir datos.
- `pnpm run typecheck`: exit 0. `pnpm run build`: exit 0. Coordinador: 20/20 pruebas, 175 tareas y 165 requisitos válidos.
- `docker build --target recovery-age -t sarin-recovery-age-b3 .`: exit 0, incluyendo Sigsum y checksums. Vector real en ese Linux: cifrado/descifrado exacto y hash del binario `eb7dd1b518f0a307c99cd97782623c5321da049154b04acd2d98d21aa7bc9b2c`.
- La primera suite completa bajo carga tuvo tres timeouts de pruebas nuevas y un fallo ambiental previo de Get-Acl. Una ejecución focal posterior agotó memoria al comparar un Buffer de 17 MiB mediante igualdad recursiva; se sustituyó por comparación binaria nativa exacta. La ejecución completa definitiva y su resultado se registran en el cierre de esta evidencia y en el control, sin ocultar esos intentos.
- Suite definitiva: `pnpm test --maxWorkers=2`, exit 0; 4911 pruebas aprobadas, 88 omitidas; 325 archivos aprobados y 9 omitidos, duración 416,71 s. El proceso recibió PSModulePath de Windows PowerShell para la prueba histórica de ACL. Esta cifra local incluye una prueba previa ajena sin versionar; el checkout limpio de CI será la autoridad para el candidato publicado.

## Decisiones y límites

La etapa Docker y la preparación en CI son adicionales a la lista original de archivos para que las pruebas con age real sean reproducibles en un checkout limpio. El metadato aditivo en captura B2 elimina el límite no aprobado y conserva el formato de manifiesto B1; el índice cifrado lleva la referencia requerida al lote de contraseñas. No se cambió el contrato aprobado ni se crearon dependencias npm.

Mejora menor diferida de la revisión: age reabre el pathname de la identidad después de validar archivo y ACL. Un operador que ya controla ese directorio privado podría sustituirlo en esa ventana; vincular el proceso al descriptor verificado reduciría esa carrera local. Se conserva la guarda de propietario, permisos, symlinks y hardlinks; no se afirma haber eliminado esa carrera.

La validación usa datos demo y una identidad descartable fuera de Git. No acredita RPO/RTO de producción, recuperación de credenciales reales, autenticidad ante compromiso total de la cuenta, QA integral Fresha ni un simulacro operativo. No se activan backups, cron, recursos, exportaciones/restauraciones reales, cobros, inferencias o mensajes. B4-B6 e integración siguen pendientes; CI y producción de este candidato solo se afirman con su evidencia remota posterior.
