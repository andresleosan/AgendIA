# R0-BACKUP-B5: independent invalidation witness and recovery admission

Date: 2026-11-03, America/Bogota. Base: `0c98d13e2d7f242dde71714d7e27ccc72cfe2bb8`.
Canonical progress remains in the control checkout's `docs/implementation/fresha/tasks.json`.

## Behavior

- The existing shared D1 writer records every touched path conservatively, with a coded mutation/delete reason and request fingerprint, before the application transaction. It stores no document bodies. Direct Worker retention writers already use this writer.
- Confirmation follows the application commit. An identical replay can complete an uncertain confirmation; different content under the same request ID fails. These are two separate D1 databases, not one atomic transaction. Pending intents remain restrictive, including after an application CAS failure.
- An operator-prepared immutable start marker is mandatory. Missing storage, resource mismatch, missing pre-snapshot history, duplicate revisions, a pending intent or an uncovered revision prevents complete coverage. Witness rows and the marker have no deletion/expiry path; they outlive every retained snapshot. False positives need current independent reconciliation, not age-based dismissal.
- Backup claims validate historical coverage by aggregate plus the current interval, so 10,001 historical commits do not disable future copies. Sealing checks the actual snapshot revision/time and a final control-store SQL fence against newly pending/later intents. Recovery intervals above 10,000 returned intents fail closed; this bounded interface does not silently truncate or authorize a large restore.
- Recovery mode closes commercial public/private forwarding before obtaining the singleton, disables scheduled work and runtime producer flags, rejects application commits, and refuses legacy Firestore as an automatic recovery backend. Ordinary maintenance keeps its existing behavior.
- Admission needs a private operator record outside application SQL, tied to resource fingerprint, code SHA, validated complete manifest digest, reconciliation digest and covered revision. It expires within 15 minutes and requires current independent Auth/IAM evidence. Cookies, public headers and a fresh login cannot open it. No public endpoint writes this record. The operator must verify the restored artifact and reconciled target before recording approval; configuration alone does not prove an actual restore.
- Reconciliation validates the existing full backup manifest, hashes the manifest/witness/current authority evidence, and produces restrictive paths, invalidated UIDs and blockers. It never grants permission or repeats external effects. B6 consumes/applies that plan in the isolated synthetic restore.

## Verification before delivery

| Check | Result |
| --- | --- |
| Node witness and backup tests | 24 passed, including real Miniflare D1/R2, old SQL, unavailable witness, pending intent, replay, direct retention, candidate/manifest mismatch, pre-snapshot gap/time and final seal race. |
| Vitest admission, backup route, database adapter and quota integration | 28 passed. |
| Worker complete check | 196 passed; TypeScript and Wrangler Worker dry-run passed. No remote migration/deploy was performed by this dry-run. |
| Application TypeScript | Passed. |
| Application build | Compiled and built successfully before the final review fixes; final-candidate build is recorded in the delivery evidence. |
| Independent review | Two Important findings fixed with observed RED/GREEN: lifetime claim cap and missing concrete manifest binding. Missing freshness validation was regraded Important because operator evidence must be reliable, and fixed in the same pass. No deferred findings. |

Initial unrestricted Windows full-suite execution had resource-related timeouts and a pre-existing ACL verification failure. A focused reproduction traced the latter to Windows PowerShell loading incompatible PowerShell 7 modules; the test passed with its legacy module path. Reduced-concurrency full-suite results and exact-candidate CI are recorded separately, without treating the earlier failed run as green.

The emulator runner now includes the new admission cases. Local emulator attempts exposed missing Java on PATH, native Windows Java temporary-socket constraints and an existing Auth capture failure when staging on E:. The fresh-login Auth test passed separately using the live local Auth emulator and normal C: staging, including the added assertion that a fresh identity cannot write through the recovery adapter. Exact Linux CI emulator results remain required for delivery; local failures are not replaced with inferred success.

## Operational limits

No recovery binding, bucket, witness marker, hook, schedule or capability was activated. The separate control migration remains unapplied operationally and may therefore be extended in place. Production code delivery uses the previously authorized main pipeline; it does not authorize export, restore, real messages, payments, paid inference or Fresha global acceptance. No UI was changed, and final comprehensive browser QA remains after construction.
