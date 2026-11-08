# AgendIA

**Tus clientes agendan, la IA trabaja.** Agenda comercial independiente, con Sarin Bot como asistente virtual.

Aplicación: https://agendia-app.pages.dev · Código: https://github.com/andresleosan/AgendIA

## Aplicación y datos

AgendIA tiene su propio repositorio, imagen Next.js, Worker `agendia-web` y proyecto Pages `agendia-app`. El gateway de Pages envía páginas y archivos a su contenedor de interfaz; las rutas comerciales `/api/*` permitidas se envían por un service binding privado al Worker existente `sarin-bot-app`.

La API central conserva Firebase Auth, D1, R2, cuotas, proveedores, WhatsApp y la única cola de inferencia. AgendIA usa el mismo proyecto Firebase y los mismos UID. Los negocios creados desde AgendIA son los mismos que administra Sarin Hub; no existe una base paralela ni sincronización de copias.

El contenedor de AgendIA no incluye rutas API ni páginas administrativas. No recibe secretos, credenciales Admin, bindings de datos ni acceso de red saliente. No ejecuta instrumentación, cron, WhatsApp, recuperación o inferencia. Next se inicia directamente con `node server.js`.

Se conservan fuentes y pruebas heredadas de la API para referencia de contratos. No forman parte de la imagen UI: `.dockerignore` excluye `src/app/api` y `src/app/admin`; el proxy Next y el Worker también bloquean esas rutas. La infraestructura antigua en `cloudflare/src/` está fuera del entrypoint y del typecheck del host UI; no debe publicarse desde este repositorio. El antiguo release central está deshabilitado.

## Desarrollo y validación

Usa Node 24.22.1 y pnpm 11.23.0, con el lockfile existente:

```sh
pnpm install --frozen-lockfile
pnpm run dev
pnpm run typecheck
pnpm test
node --test pages-gateway/tests/*.test.mjs
pnpm --filter agendia-cloudflare-host run check
pnpm run build
pnpm run build:pages
node scripts/deploy-agendia.mjs
docker build -t agendia-ui:check .
```

El servidor `dev` sirve solo interfaz. Las API comerciales deben accederse mediante un gateway separado conectado a una instancia autorizada de la API central; llamar directamente al puerto Next devuelve 404. Los runners de emuladores y journeys heredados documentan el backend original y no son el entorno integrado de AgendIA.

`DESIGN.md` conserva Agenda clara, la marca AgendIA, el slogan y el crédito a Sarin Bot. Cambiar la marca no cambia contratos, identificadores de datos ni permisos.

## Despliegue independiente

El workflow verifica tipos, la suite heredada, límites del gateway, dry-run del Worker, builds y una imagen UI sin API. El despliegue automático está desactivado por defecto; requiere la variable de repositorio `AGENDIA_DEPLOY_ENABLED=true`. Solo `main` de `andresleosan/AgendIA` puede publicar. No copies ni ejecutes el workflow de Sarin Hub desde aquí.

Para activar ese despliegue, configura en GitHub un secreto dedicado `CLOUDFLARE_API_TOKEN` con alcance suficiente para el Worker/Container UI y Pages de AgendIA, la variable `CLOUDFLARE_ACCOUNT_ID` y las cuatro variables públicas `NEXT_PUBLIC_FIREBASE_API_KEY`, `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN`, `NEXT_PUBLIC_FIREBASE_PROJECT_ID`, `NEXT_PUBLIC_FIREBASE_APP_ID` del proyecto existente `sarinbotsaas`. No guardes el OAuth temporal del CLI como secreto de Actions. El despliegue local puede usar la sesión existente de Wrangler y esas mismas variables públicas. Ninguna clave Admin, de proveedores o de WhatsApp pertenece a este repositorio o a su runtime.

Antes de activar, crear Pages `agendia-app`, autorizar `agendia-app.pages.dev` en Firebase y verificar que la API central acepte su origen y genere sus enlaces de reserva. Mantener los webhooks, el issuer WIF y los enlaces históricos de Hub en su dominio actual. No configurar un segundo autodeploy de Pages o Workers que compita con Actions.

Para crear exactamente el proyecto Pages desde este directorio, usa `node cloudflare/node_modules/wrangler/bin/wrangler.js pages project create agendia-app --production-branch main --force`. En la versión fijada de Wrangler, ese flag evita que una sesión de agente convierta la creación de Pages en un despliegue de Workers. Los despliegues posteriores usan el proyecto existente y el gateway avanzado `_worker.js`, sin ese flag.

`node scripts/deploy-agendia.mjs` solo valida los destinos y muestra el alcance. Con `--deploy` exige un `main` limpio y publicado, exporta ese commit con `git archive` para construir el Worker y la imagen desde una copia fija, etiqueta la imagen con su SHA y vuelve a comprobar el estado de Git antes de cada publicación. Usa el export de Pages revisado y verifica que su gateway coincida exactamente con el commit. Publica exclusivamente `agendia-web` y Pages `agendia-app`, y comprueba las fronteras HTTP públicas. No modifica D1/R2, secretos, flags, proveedores ni el Worker central. La verificación pública no sustituye la aceptación autenticada de los recorridos ni la comprobación del rollout del Container.

Una publicación puede quedar parcial entre Worker/Container y Pages. Ante un fallo, revisar el estado real de AgendIA antes de reintentar; el script no revierte automáticamente recursos. Mantener disponibles el commit y artefactos anteriores.

## Créditos

Marca, implementación y mantenimiento: **ALS Development Studio**. Asistente virtual: **Sarin Bot**.
