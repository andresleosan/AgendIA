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
