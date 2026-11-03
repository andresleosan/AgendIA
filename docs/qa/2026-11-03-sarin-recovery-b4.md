# R0-BACKUP-B4: disabled backup coordination

Date: 2026-11-03, America/Bogota. Source base: `939b414f8e83d479045bbad1e6e9505495b93487`.
Control/progress authority: `E:/Proyectos/Sarin Bot/docs/implementation/fresha/tasks.json`.
Product checkout: `E:/Proyectos/SarinBot-worktrees/fresha-implementation-20261030`, branch `main`.
Approved contract SHA-256: `0adec33452d4634d0befc66b730b1ee78330a2107b62aa04ce714462cc1d4f3d`.

## Delivered scope

- Optional, separate `SARIN_RECOVERY_DB` tables for the active run, monotonic fence, one-use nonce consumption, ciphertext inventory/references, catalog and immutable restore evidence. The partial unique index permits only one active run. Application snapshots and rollbacks do not contain this control database.
- Daily eligibility from 07:00 UTC, two retries at least 15 minutes after failure, fresh run/object IDs, a 30-minute deadline and 40-minute claim. Pre-change runs have separate scheduling identities and preserve their seven-day retention category. Restart/repeated cron reads durable state instead of resetting attempts.
- HMAC-signed internal POST, durable consumption and a fixed private outbound host. Public internal paths are rejected before waking the singleton; public backup headers are removed. The Worker checks SDK class/container identity before parsing the body or using bindings. Its export token never enters Node.
- Fixed-account/database official D1 SQL polling, exact allowlisted HTTPS download origin with no redirects, referenced immutable source objects, bounded ciphertext uploads, R2 conditional creates and readback hashes. No caller-supplied download URL, bucket or destination. Each set is limited to 1 GiB and ciphertext chunks to 8 MiB + 64 KiB.
- B1/B2 capture and B3 age encryption feed one final catalog transaction. B3 accepts the durable claim ID while preserving its standalone default. The live fence is refreshed after asynchronous work; production publication also checks D1's clock inside the transaction. Lost seal responses resolve by reading status, without another encryption/upload/seal.
- One Node job per process, minute heartbeats, deadline cancellation and private staging cleanup. The single Next process remains alive only for an active durable backup. The image contains the pinned age binary, recovery modules, their existing Zod dependency, schemas and all 13 application migrations.
- Retention: latest seven distinct daily points, four ISO Monday weeks and three calendar months in Bogota, explicit gaps, pre-change minimum seven days, failed artifacts after 48 hours and summaries after 30 days. Shared references retain their bytes; cleanup preserves the last usable set and defaults to dry-run. Actual cleanup requires the separate cleanup flag and no active source pin.
- Sanitized status exposes phase, oldest recoverable point/component ages, 20-hour warning, breach above 24 hours, bytes, duration, failure code and retention gaps. It contains no UIDs, business IDs, plaintext paths, signed URLs or credentials. No notifications are sent.

The production Wrangler configuration has no new active D1/R2 bindings or cron. `SARIN_BACKUP_ENABLED` defaults to `false`; cleanup requires literal `true`. The example file is a template requiring resource, cost, key-custody and operation approval. Delivering this code through main does not enable it.

## Verification

Final command results and the delivered SHA are recorded in the control task evidence after completion; logs remain in the ignored task workspace. Validation is local/synthetic unless explicitly identified as ordinary CI/deployment evidence.

Final local results: product **4,916 passed / 88 skipped**, 326 passing files / nine skipped, exit 0 in 487.95 s; Worker **187/187**, strict types and Wrangler dry-run exit 0; focal Worker **16/16**, focal Node **5/5**; root typecheck and production build exit 0; coordinator **20/20**. The final Docker build and offline imports pass, and the running standalone image returns 404 for a forged disabled trigger with exactly one server process (Next renames its process title to `next-server`). None of the skipped tests is claimed as passing.

| Check | Evidence / scope |
| --- | --- |
| RED/GREEN | Initial modules absent; then regressions for pre-change classification, consumed non-202 responses, immutable evidence deletion and delayed sealing observed failing before fixes. Restoring the stale-clock implementation returned 200 after expiration; the fixed implementation returns 409 and creates no catalog row. A queued D1 batch is also rejected by the database-time fence. |
| Worker focal | `node --test cloudflare/tests/recovery-backup.test.mjs`: 16 tests, including real Workerd/D1/R2 sealing with the production database clock, corruption, duplicate uploads, missing consumption, source pins, retries, day/week/month boundaries, reference-aware cleanup and evidence lifetime. |
| Node focal | `pnpm exec vitest run tests/recovery-backup-route.test.ts`: signed body/deadline/maintenance denial; singleton exclusion; capture failure; lost-seal outcome; real B1/B2/B3 age-to-local-Worker sealing and private plaintext cleanup. |
| Product | `pnpm test --maxWorkers=2`, `pnpm run typecheck`, `pnpm run build`. Final counts/exits in task evidence. Skipped emulator/live-provider cases are not acceptance. Windows ACL subprocesses use only the Windows PowerShell module directory in this test process, preserving the ACL checks. |
| Worker accumulated | `pnpm --filter sarin-cloudflare-host run check`: tests, strict types and Worker-only Wrangler dry-run. The existing Windows release-config test requires temporary files on drive E, matching the checkout; the command sets its process-local TEMP/TMP accordingly. Its first cross-drive run was rejected, not counted as passing. |
| Docker | Build with synthetic public Firebase configuration; offline module/age/migration smoke; standalone default-disabled endpoint and single-Node check. An initial image smoke found Zod absent from the standalone trace; its pinned installed package is now explicitly copied and the smoke repeated. |

No private exports, production restore, new resource, credential, paid inference, real message, payment or backup schedule was created by validation. Ordinary deployment of this disabled code is tracked separately by matching the main SHA, CI jobs and Worker/Container/Pages release results.

## Independent review and decisions

Reviewer: `review_backup_b4`, read-only, fresh context. Verdict: with fixes; no minor findings. All four Important findings received regressions and fixes: expiration during asynchronous sealing, independent pre-change scheduling, consumed trigger uncertainty and append-only restore evidence. The executor also added the D1 execution-time guard for a delayed batch.

Rulings on scope retained by the executor:

1. Preserve the existing source adapter's absence of physical R2 deletion and expose the durable broad source pin. Logical deletion remains immediate. Risk: any future physical source GC must consult the pin before activation; this task does not add a GC implementation.
2. B5 witness/admission and B6 restore/reconciliation remain separate tasks. Risk: this coordinator alone cannot establish current authority or safely reopen a restored application.
3. Real Cloudflare backup activation, operator material and operational recovery readiness remain gated. Risk: local fixtures and a seal do not establish production RPO/RTO, key recovery, cost or a usable private operational backup.
4. The parent executor owns the full-suite and Docker evidence; the independent reviewer did not reproduce it. Risk: the review is not a second execution of those checks. Their actual results must be read before closure.

No deferred minors. No alteration of the approved contract or of unrelated dirty application/tests/design files.

Primary provider references used for the existing protocol adapters: [D1 SQL export](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/export/) and [Containers outbound identity](https://developers.cloudflare.com/containers/configuration/outbound-traffic/). The exporter retains the authenticated polling bookmark and keeps the signed download URL private in the control store.
