# AgendIA: identidad y navegación pública

Fecha local: 7 de noviembre de 2026, America/Bogota. Base de trabajo: main `57cf586fd458ab0a5b5839acd8707328c1da684c`; cambios de esta revisión aún sin commit al registrar la evidencia.

## Resultado

AgendIA identifica la plataforma; Sarin Bot conserva su nombre y sus imágenes como asistente. El wordmark muestra `Agend` blanco y `IA` sky-400 a teal-400 sobre navy. El eslogan es «Tus clientes agendan, la IA trabaja». Footer, acceso/onboarding y burbuja muestran «Asistente virtual: Sarin Bot» y «Desarrollado por ALS Dev Studio», enlazado a `https://www.alsdevstudio.com`.

Se conserva Agenda clara, DM Sans local, la navegación del negocio y la oferta de citas. La portada y la navegación del negocio ya no incluyen acceso a `/admin`, tampoco para una cuenta superadmin. La protección de servidor/gateway pertenece a la revisión de infraestructura; esta evidencia no presenta ocultar enlaces como autorización de servidor.

El dominio público confirmado por el usuario es **`https://agendia-app.pages.dev`**, correspondiente al proyecto Pages `agendia-app`. Enlaces, metadatos, robots y sitemap usan ese origen exacto. El origen inicial `agendia.pages.dev` pertenece a otro proyecto; tanto ese destino como el temporal `agendia-l75.pages.dev` se rechazan explícitamente en las pruebas de enlaces. La petición del QR usa `/api/businesses/qr-kit?application=agendia` y sigue utilizando sin modificación el `bookingUrl` recibido del servidor. No se modificaron contratos de IA, autorización de API, documentos legales ni huellas de consentimiento.

Los iconos de plataforma son `public/brand/agendia-icon.svg`, `agendia-192.png` y `agendia-512.png`. El SVG incorpora el DM Sans existente, con la misma palabra y colores; los PNG se obtuvieron de su renderizado con fuente cargada y se exportaron con Sharp. No se creó un símbolo pictórico. Las imágenes originales de Sarin permanecen intactas. El nombre completo pierde detalle a tamaños de favicon muy pequeños; se mantiene la identidad tipográfica solicitada.

## Comprobaciones

- Tras confirmar `agendia-app.pages.dev`: se observaron los dos fallos esperados al cambiar primero las pruebas (aceptación del origen nuevo y rechazo del anterior); la validación posterior quedó en **54/54 pruebas focales, TypeScript exit 0 y `build:pages` exit 0 con 45 archivos públicos**. Se añadió también el rechazo explícito del hostname temporal. No se repitió la suite general ni las capturas, porque el cambio de origen no altera la composición visible.
- TDD focal: cinco fallos esperados antes de implementar (marca, origen nuevo, rechazo del origen anterior, enlace administrativo y parámetro del QR). Después: 52/52 pruebas en `marketing-home`, `workspace-navigation`, `qr-kit`, `service-information`, `sarin-contact-ui` y `public-business-entry`.
- La prueba de entrada pública conserva la comprobación del gate de autenticación y ausencia de contenido del negocio al mostrarlo; incorpora el footer nuevo sin exigir que toda la página sea únicamente el texto del gate.
- `pnpm run typecheck`: exit 0, repetido tras los últimos cambios de metadatos.
- `pnpm run build:pages`: exit 0. Landing compilada, 45 archivos estáticos verificados, iconos/metadatos presentes y gateway empaquetado. La generación local no constituye un despliegue ni valida el backend real. Aviso informativo existente de Node sobre `MODULE_TYPELESS_PACKAGE_JSON` al leer `sarin-contact.ts`.
- `git diff --check` del alcance: sin errores.
- Suite general de la implementación de marca, anterior al ajuste final de hostname: **335 archivos aprobados y 10 omitidos; 4.998 pruebas aprobadas y 114 omitidas, cero fallos**, exit 0, 265,03 s. Se ejecutó `pnpm test` con `PSModulePath=C:/Windows/System32/WindowsPowerShell/v1.0/Modules` para que el subproceso Windows PowerShell 5 encuentre su módulo ACL nativo.
- El primer pase registró tres fallos: la expectativa de texto completo en `public-business-entry`, el módulo ACL del entorno y el fixture Wrangler/D1 heredado. El primero conserva ahora la comprobación del gate y acepta el footer; el segundo no requirió cambios de código. Infraestructura aisló el tercero con una configuración temporal de D1 y el Wrangler instalado en modo local, sin restaurar un binding de producción en el frontend ni alterar el script del motor. Los tres están cubiertos por la suite final aprobada.

## Revisión con Playwright MCP

Aplicación local `http://127.0.0.1:3049`, configuración pública de Firebase, sin credenciales Admin ni envíos reales:

- Portada a 320, 390 y 1280 px: `document.documentElement.scrollWidth` coincide con el ancho visible; no elementos desbordados en la revisión móvil.
- Nombre completo visible en móvil y escritorio; el sufijo IA no se oculta.
- Nombre accesible del wordmark: AgendIA. Slogan y créditos exactos presentes; cero enlaces a `/admin` en portada y acceso.
- Selector ilustrativo de agenda: cambiar de 10:30 a 09:00 actualiza el texto y `aria-pressed`; no crea reservas.
- Tab alcanza «Saltar al contenido» con outline sólido. El enlace de crédito tiene 44 px de alto. Al enfocar el enlace dentro de la burbuja, la burbuja conserva opacidad 1 y detiene su propia animación para mantener visible el foco.
- Entrada de onboarding a 390 px: marca, eslogan, controles y créditos visibles, sin desbordamiento. No se inició sesión ni se enviaron consentimientos.
- Colores calculados del wordmark: navy `rgb(15,23,42)`, blanco `rgb(255,255,255)` y gradiente `rgb(56,189,248)` a `rgb(45,212,191)`. Contrastes contra navy: blanco 17,85:1, sky 8,33:1 y teal 9,59:1.
- Se corrigió durante QA una política de infraestructura que rechazaba chunks codificados válidos de Next; tras recargar, la interacción de agenda funcionó. En el servidor local quedan respuestas 404 deliberadas para la API compartida (tarifas y preautorización), con sus estados de indisponibilidad; no son una prueba de las conexiones de producción.

Capturas:

- [Escritorio 1280](agendia-brand-20261107/desktop-1280.png)
- [Móvil 320](agendia-brand-20261107/mobile-320.png)
- [Móvil 390](agendia-brand-20261107/mobile-390.png)
- [Burbuja y foco 320](agendia-brand-20261107/bot-mobile-320.png)
- [Entrada de onboarding 390](agendia-brand-20261107/onboarding-entry-390.png)

Los overlays de desarrollo y el aviso de API local en la captura de onboarding se registran como contexto del ensayo, no como resultado de autenticación de producción. Los atajos Ctrl+= no alteraron devicePixelRatio ni el viewport en MCP: **zoom nativo 200 % no verificado**. No se sustituyó por zoom CSS ni por una captura estrecha.

## Revisión visual del alcance

- Hard Gate: PASS para textos, navegación, estados y desbordamiento de los cambios comprobados; se conserva la excepción de movimiento previamente aprobada. No se atribuye aceptación integral al zoom pendiente.
- Purpose Gate: PASS. El único degradado nuevo distingue IA en el nombre por petición expresa; no hay neón, halos ni nueva ornamentación. El detector notificó ese degradado y tonos ya existentes de hover, agenda y borde de burbuja; no son cambios accidentales de paleta.
- Liveliness: PASS. ENERGY 1, RHYTHM 2, MOTION 1; foco principal en eslogan y acceso, marca localizada, ritmo y agenda ilustrativa conservados.
- Craftsmanship: PASS dentro del alcance validado. Controles conservados, créditos con enlace real, foco visible y límites declarados. Las cinco escenas originales de 8,8 s no se extendieron; la revisión integral de accesibilidad y de los flujos autenticados sigue siendo una comprobación separada.
