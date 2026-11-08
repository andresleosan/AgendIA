# AgendIA infrastructure validation — 2026-11-07

Scope: local validation of the independent AgendIA UI, before its release commit. This record does not claim a production deployment or authenticated acceptance.

The user confirmed `https://agendia-app.pages.dev` after the initial Pages name received a generated suffix. The final Pages project is `agendia-app`; the UI Worker remains `agendia-web`. Gateway, deployment guards, build/verification scripts, workflow URL and documentation use the confirmed origin. All 18 gateway/Worker tests, Worker typecheck/dry-run and deployment scope validation were rerun successfully after this change; prior hostnames are explicitly rejected. The local image evidence below predates this domain-only change and is not a release image.

## Architecture verified

- Pages `agendia-app` routes permitted commercial APIs through `SARIN_API` to existing `sarin-bot-app`; UI requests go through `AGENDIA_WEB` to independent `agendia-web`.
- The gateway preserves Firebase bearer authentication and the real Origin, replaces untrusted forwarding headers, rejects unauthorized paths and methods, permits only reviewed redirects, does not retry mutations, and returns `no-store`.
- The UI host has only `AGENDIA_UI`, one `basic` Container, two-minute idle sleep, no internet access or observability, and no data, identity, inference, cron or WhatsApp bindings.
- The Docker context excludes API/admin routes and instrumentation. The runtime starts `node server.js` as UID 1000.
- Dependencies remain pinned to the inherited lockfile. No central Sarin source or remote resource was changed by this infrastructure task.

## Executed checks

- `pnpm install --frozen-lockfile`: passed.
- `node --test pages-gateway/tests/*.test.mjs`: 13 passed, including inherited commercial API method inventory, encoded bypasses, encoded Next static chunks, manifest, local image optimization and streaming/abort handling.
- `pnpm --filter agendia-cloudflare-host run check`: 5 tests passed, TypeScript passed, Wrangler dry-run passed. Only `AGENDIA_UI` and `agendia-web-agendiaweb` appear in the dry-run resource inventory.
- `tests/agendia-proxy.test.ts`: 2 passed; direct Next API/admin requests and server actions are rejected.
- The inherited installed-Wrangler migration test was isolated with a temporary synthetic D1 config and `--local`; its targeted execution passed. AgendIA has no D1 binding.
- `node scripts/deploy-agendia.mjs`: passed read-only scope validation; syntax and diff checks passed.
- The generated snapshot configuration was also dry-run separately. Wrangler 4.150.0 resolved a config-file `tsconfig` path incorrectly on Windows; passing the archived absolute path through the CLI `--tsconfig` option fixed it. The final generated configuration bundled successfully with only the UI resource inventory.
- Docker rebuild `agendia-ui:local-check`: passed. Local manifest-list digest `sha256:ab40b8a16081a54e04aee30c40b5e7ee515d8c07d0e328df06716feaaff0725e`; OCI revision is deliberately `local`, not a release SHA.
- Real container with `--network none`: root, dashboard, FAQ, public business page, manifest, three AgendIA icons and local Next image optimization returned 200. Direct session/admin/internal/WhatsApp/issuer and encoded API paths returned 404. The runtime manifest contained 20 UI/error/manifest entries and no API/admin routes; instrumentation was absent and UID was 1000.

The branding task separately records the full application suite, typecheck, static export and browser QA. The temporary smoke container was stopped after validation.

## Release boundaries

`scripts/deploy-agendia.mjs --deploy` requires clean published `main`, exact resource configurations and public Firebase values from the existing project. It exports the commit with `git archive`, builds from that snapshot, labels the image with its SHA, rechecks source before each publication, and deploys only the independent UI Worker/Container and Pages project. The reviewed Pages export is copied into the snapshot and receives the exact committed gateway bytes.

Wrangler 4.150.0 can delegate a new Pages project to Workers in an agent session. Initial creation therefore uses explicit `--force` to retain the requested Pages architecture. Subsequent deployments use the established Pages project and the advanced-mode `_worker.js`/`_routes.json` artifact, both of which exclude automatic delegation; they omit that flag. The workflow's automatic deploy stays disabled until `AGENDIA_DEPLOY_ENABLED=true` and a dedicated scoped token plus public variables are configured. Local deployment can use the existing Wrangler login without saving its temporary OAuth token in GitHub.

Final production acceptance still requires inspecting the actual Container rollout and image/source identity, live HTTP boundary checks, and authenticated business journeys against the central API. The deployment script does not imply an automatic rollback after a partial publication.
