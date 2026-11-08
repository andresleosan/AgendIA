# AgendIA repository guidelines

AgendIA is the independent commercial appointment UI. Read `DESIGN.md` before changing interfaces. Preserve Agenda clara, the approved AgendIA name and slogan, Sarin Bot assistant attribution, and ALS Development Studio credits.

- Use Node 24.22.1 and pnpm 11.23.0; preserve the existing lockfile and pinned dependencies.
- `src/app/`, `src/components/`, `src/hooks/` and `src/lib/client/` contain the UI. `pages-gateway/worker.mjs` is the public trust boundary.
- Deploy only Pages `agendia-app` and Worker/Container `agendia-web`. The API binding may reference existing `sarin-bot-app`; no deployment command here may modify it.
- The API, D1/R2, Firebase Admin, inference queue, provider settings, WhatsApp and webhooks remain in Sarin Hub. Never create a second commercial database, inference queue or WhatsApp worker.
- The AgendIA image must exclude `src/app/api`, `src/app/admin` and instrumentation. Start only `node server.js`; never use the inherited Sarin container startup or WIF helpers.
- Inherited server sources and tests are contract references, not a deployment target. Do not reactivate their routes to make local tests or development convenient.
- The sole Fresha implementation progress authority is `E:/Proyectos/Sarin Bot/docs/implementation/fresha/tasks.json`. Do not copy it or create a second mutable progress file in AgendIA; inherited implementation documents are reference only.
- Keep API authentication and the real Origin header. Reject administrative/internal/webhook/issuer paths, encoded bypasses and arbitrary redirects at the gateway and UI host.
- No Admin credentials, tokens, private exports or runtime secrets in Git, build arguments or frontend bundles. Only the four reviewed public Firebase values enter the UI build.
- Use strict TypeScript, two spaces and semicolons, following adjacent quote style.
- Validate with `pnpm run typecheck`, `pnpm test`, gateway tests, `pnpm --filter agendia-cloudflare-host run check`, `pnpm run build:pages`, and a real UI-only Docker build/smoke when changing infrastructure.
- `scripts/deploy-agendia.mjs` without arguments validates scope only. Deployment, remote configuration and real sends must stay within explicit session authorization; prepare concrete changes and checks first.
- Preserve old browser data; removing a surface never authorizes purging previous personal chat or Vault data.
- Sarin engine hostnames are only under `alsdevstudio.com`. Never use the other projects' domains.

## Cierre obligatorio: dónde continuar

Al terminar cualquier tarea, también fuera de `/avanzar`, cerrar la respuesta en español con **«Continuar en: <Sarin Bot o AgendIA> — <carpeta absoluta>. Acción: <seguir en este proyecto o cambiar al proyecto indicado>. Motivo: <siguiente trabajo concreto>.»** Esta indicación va al final, después del resultado, comprobaciones y recomendaciones aplicables.

Elegir el destino por el trabajo pendiente, no por el nombre de este chat, el editor, el modelo ni el repositorio recién modificado:

- **Sarin Bot — `E:/Proyectos/Sarin Bot`:** motor compartido, API, datos, inferencia, WhatsApp, Hub administrativo y landing del servicio de chatbot.
- **AgendIA — `E:/Proyectos/AgendIA`:** pantallas y experiencia de citas, marca comercial, gateway y despliegue de su interfaz.
- **Trabajo mixto:** indicar primero el proyecto del siguiente paso ejecutable y después el cambio al otro proyecto, con el orden y la dependencia concreta. Evitar un cierre ambiguo como «seguir en ambos».

Para `/avanzar`, consultar el selector y el estado vigente en el único controlRoot de Sarin Bot antes de indicar la siguiente tarea; no fijar un ID histórico ni deducir el repositorio solo de `workspace.codeRoot`. Distinguir dónde se coordina el plan de dónde se implementa su interfaz. Si falta adaptar el coordinador para una tarea mixta, indicar esa adaptación como paso previo en Sarin Bot. Una tarea incompleta retoma su pendiente en el repositorio correspondiente; no anunciar otra tarea como lista. Si no hay siguiente tarea elegible o no se conoce su alcance, decirlo y señalar Sarin Bot como lugar de revisión del plan, sin inventar una selección ni marcar progreso.

En un cambio de proyecto, incluir un mensaje breve para pegar en la nueva sesión con el objetivo pendiente, tarea/ID si existe, repositorio/carpeta y referencias a contratos, commits o verificaciones relevantes. Referenciar el estado canónico en Sarin Bot; conservar una sola autoridad de progreso.
