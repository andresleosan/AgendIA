# Host de interfaz AgendIA

`wrangler.jsonc` publica exclusivamente `agendia-web`, con entrypoint `src/agendia-ui.ts`, binding `AGENDIA_UI` y Container `AgendiaWeb`. Usa una instancia `basic`, duerme tras dos minutos y mantiene observabilidad desactivada. No hay D1, R2, WIF, AI, cron ni secretos de aplicación en este host.

Pages `agendia-app` tiene dos service bindings: `AGENDIA_WEB` para esta interfaz y `SARIN_API` para el backend central existente. La interfaz rechaza todas las API, la administración y el issuer antes de iniciar el contenedor. El gateway conserva el ID token Firebase y el origen real; las decisiones de autorización y negocio siguen en la API central.

Los archivos Sarin heredados fuera de `agendia-ui.ts` y `agendia-router.ts` se conservan como referencia de las pruebas de contrato. No son el entrypoint desplegado ni reciben recursos. `scripts/release.mjs` está deshabilitado en esta aplicación.

```sh
pnpm --filter agendia-cloudflare-host run types
pnpm --filter agendia-cloudflare-host run check
node scripts/deploy-agendia.mjs
```

El último comando valida sin publicar. El despliegue concreto usa `--deploy` desde un `main` limpio de AgendIA y requiere las cuatro variables públicas Firebase. No ejecutar despliegues de recuperación o migraciones heredadas desde este repositorio. La [guía principal](../README.md) detalla los destinos y la activación.
