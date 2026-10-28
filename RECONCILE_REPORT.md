# CST Production Readiness — Reconciliation Report

**As of:** 2026-10-27  
**Overall verdict:** **PARTIAL — not cleared for unrestricted production rollout**

## 1. What I moved

- **Verified complete — Production deployment metadata:** Render reports live deployment `afbe6450d1d2d91c45a049875d4d4dc9787c0c0e`.
- **Verified complete — Database expiry:** Render confirms the free plan expires at `2026-11-14T18:10:20.49769Z`.
- **Verified complete — Worker heartbeat observed:** Render logs show recurring outbound-worker heartbeats with zero queue/failure counts in the observed intervals. This proves worker liveness, not successful delivery.
- **Verified complete — Health evidence:** Render logs show `/health` returned HTTP 200 and `/health/voice` returned HTTP 503 on 2026-10-27.
- **Blocked — Current source-to-production comparison:** The supplied local audit records branch `fix/dashboard-test-isolation`, HEAD `1da43a26196e88ed5bb4df328575d68cde522d1b`, and pre-existing modifications/untracked reports. These local details were not independently re-read in this reconciliation.
- **Not started — Production database row inspection:** No production SQL was executed and no database rows were changed.

## 2. Why it matters for the Engine

- **Blocked — KMG9 security boundary:** The isolated CST-help cluster must be proven before the knowledge boundary can be accepted.
- **Blocked — Delivery attribution:** Unmatched Twilio callbacks prevent reliable attribution and dashboard delivery visibility.
- **Blocked — Voice acceptance:** A healthy general endpoint does not prove that voice delivery works; `/health/voice` returned HTTP 503.
- **Blocked — Database continuity:** The free database expiry is time-bound and requires an approved continuity plan.
- **Blocked — Database network review:** The Render configuration includes `0.0.0.0/0` in the database IP allow-list. Verify private-network usage and intended access before changing it.
- **Verified complete — Worker liveness:** Heartbeats are visible in Render logs. Successful message delivery and failure recovery remain separate acceptance requirements.

## 3. Loop closure ledger

| Loop / issue | Status | Remaining acceptance criteria |
|---|---|---|
| `LOOP-1788044070647-KMG9` | **Blocked** | Isolated-cluster evidence, scoped-key confirmation, independent tests 1/1b/2, request IDs, `workspaces_queried`, `per_workspace_hits`, and SOP acceptance |
| Twilio delivery attribution | **Blocked** | Trace affected SIDs to persisted outbound rows and prove correct tenant/project attribution and dashboard publication |
| `POSTGRES-EXPIRY-2026-11-14` / `LOOP-1792104121807-XXHH` | **Blocked** | Owner-approved continuity decision and verified recovery path |
| Voice health | **Blocked** | Determine the cause of HTTP 503 and provide provider-backed voice acceptance evidence |
| `LOOP-1792186179087-EWQI` — vFarm device/location contract | **Blocked** | Authoritative binding, grants, telemetry schema/freshness, and end-to-end proof |
| `LOOP-1790985133890-XKWD` — conversation/system FK | **Blocked** | Verified creation-path analysis, migration proposal, preflight checks, impact assessment, and rollback plan |
| `LOOP-1789573914064-KZE7` — legacy `systems` row | **Blocked** | Usage trace and owner decision |
| Stale customer references | **Blocked** | Authoritative identity confirmation or explicit test/demo classification |
| Help corpus content | **Blocked** | Required approved pages and Honest Gate review |
| DB allow-list review | **Blocked** | Verify private-network connectivity and intended access before proposing a change |
| npm vulnerability triage | **Not started** | Current dependency audit and compatible remediation plan |
| Test-traffic markers | **Local fix only** | Production event-store evidence proving automated test events are marked `test: true` and real customer events are not |

**Loop closure rule:** Do not close a loop solely because code was changed, tests passed, or a Slack message was posted. Close it only when the acceptance criteria are supported by evidence.

## 4. Local code vs latest production deployment

- **Verified complete — Production SHA:** `afbe6450d1d2d91c45a049875d4d4dc9787c0c0e`.
- **Verified complete — Render deployment configuration:** The service is configured to deploy from `main`.
- **Blocked — Local-to-production comparison:** The supplied audit reports local branch `fix/dashboard-test-isolation` at `1da43a26196e88ed5bb4df328575d68cde522d1b`, with `.openapi-vfarm.json` modified and untracked reports. These details were not independently re-read in this pass.
- **Verified complete — No production mutation in this pass:** No deployment, environment-variable change, database edit, or live traffic test was performed.

## 5. KMG9 boundary evidence and blockers

**Status: Blocked — RED/OPEN.**

Before changing the production BHARAG key or removing workspace fields, require:

1. **Blocked — Dedicated cluster isolation:** Confirm `cst-help` contains only `cst-help-manuals`.
2. **Blocked — Key permissions:** Confirm `cst-help-read` has the intended `ask` permission and is scoped to the isolated cluster.
3. **Blocked — Independent tests:** Run tests 1, 1b, and 2 for a farm-specific query, a permitted help query, and the vFarm-key comparison.
4. **Blocked — Request-level evidence:** Capture request IDs, `workspaces_queried`, and `per_workspace_hits` for every test.
5. **Local fix only — Defense in depth:** The supplied audit reports hardened intent routing, removal of farm fallback, and no `farm_id`/`unit_id` in `bharag_rag` requests. Reconcile these claims with the current source before relying on them.
6. **Blocked — Payload cleanup:** Do not remove `workspaceKey` and `workspace` until the agreed boundary is verified.
7. **Blocked — Key switch/revocation:** Do not point production at `cst-help-read` or revoke the old broad key without verification and coordinated approval.
8. **Blocked — SOP:** Keep KMG9 open until SOP `86b1d684-5a4a-4824-a74e-792ce901a086` and independent boundary evidence are green.

References:
- [Ahad — KMG9 decision and acceptance evidence](https://bayshorizonnetwork.slack.com/archives/C0ASMPYQLG3/p1793021961835609?thread_ts=1792702326.928939&cid=C0ASMPYQLG3)
- [Ahad — CST farm-status fail-closed path and remaining boundary](https://bayshorizonnetwork.slack.com/archives/C0ASMPYQLG3/p1793017080831259?thread_ts=1791991206.574959&cid=C0ASMPYQLG3)

## 6. Twilio attribution and outbound worker evidence

### Production evidence

- **Verified complete — Worker heartbeat observed:** Repeated heartbeat entries show zero queue/failure counts in the observed intervals. This establishes worker liveness, not successful delivery.
- **Verified complete — Attribution failure observed:** Production logs recorded callback events with `outbound_row_found=false`, missing stored tenant/project IDs, and refusal to publish `cst.delivery`.
- **Verified complete — Callback HTTP response observed:** Relevant webhook requests returned HTTP 204. HTTP 204 alone does not prove correct attribution or successful dashboard publication.
- **Blocked — Root cause:** The available logs establish the symptom but do not establish why the outbound row was missing or why attribution failed.
- **Blocked — Matched-callback acceptance:** No complete production trace was retrieved showing a matched persisted row, correct tenant/project attribution, and the expected dashboard event.
- **Local fix only — Worker reliability:** The supplied report says bounded DB bootstrap, worker heartbeat, stale `sending` recovery, provider timeouts, retry persistence, and explicit status mapping are implemented. Current source and failure/recovery tests were not re-run in this pass.

### Required read-only investigation

1. Select specific failing callback SIDs from production logs.
2. Check whether each SID exists in the outbound-message table and whether its row has `tenant_id`, `project_id`, and provider SID.
3. Trace the send path to determine whether persistence failed, happened after the callback, or stored a different SID. Do not assume the cause.
4. For matched callbacks, prove that the persisted row—not the callback recipient number—determines attribution.
5. For unknown or unattributable callbacks, preserve fail-closed behavior and verify that no incorrectly attributed dashboard event is emitted.
6. Use an approved test before any live traffic; do not send customer-facing messages merely to generate evidence.

Relevant tests reported previously:
- `delivery_callback_security.test.ts`
- `outbound_durability_invariants.test.ts`

**Commercial impact:** Until the matched-callback path is proven, dashboard delivery-status visibility remains unreliable.

## 7. Voice health and vFarm contract

- **Verified complete — General health request:** Render logs show `/health` returned HTTP 200 at `2026-10-27T11:47:48Z`.
- **Verified complete — Voice health failure observed:** Render logs show `/health/voice` returned HTTP 503 at `2026-10-27T11:47:49Z`.
- **Blocked — Voice acceptance:** The response body and exact dependency failure were not retrieved. Do not label voice operational based on `/health` alone.
- **Local fix only — Farm-level fail-closed behavior:** The supplied audit reports that fallback to BHARAG for farm status was removed. Current source was not independently reviewed in this pass.
- **Blocked — Per-device answers:** EWQI requires authoritative vFarm confirmation of user-to-location/device binding, grants, telemetry endpoint/schema, freshness, and error behavior.
- **Blocked — End-to-end acceptance:** Require an authorized vFarm identity, verified grants, a real device/location binding, fresh telemetry, and evidence that the returned or spoken response matches authoritative data.

Reference:
- [Ahad — vFarm identity, authorization and telemetry contract request](https://bayshorizonnetwork.slack.com/archives/C0ASMPYQLG3/p1792672608221339?thread_ts=1792666429.664669&cid=C0ASMPYQLG3)

## 8. Postgres continuity decision

- **Verified complete — Current Render metadata:** `bha-cst-postgres` (`dpg-db8he2qvcj2c73ado3s0-a`) is on the free plan and uses PostgreSQL 16 in Oregon.
- **Verified complete — Expiry:** Render confirms `2026-11-14T18:10:20.49769Z`.
- **Verified complete — Network configuration observed:** The database IP allow-list includes `0.0.0.0/0`. This does not, by itself, prove public reachability or that narrowing the list is safe.
- **Blocked — Backup/recovery:** Backup existence, timestamp/location, retention, and successful restore have not been established by the available evidence.
- **Blocked — Owner decision:** The account owner/Infra must choose the continuity path before expiry and approve any purchase, upgrade, migration, or export.
- **Not started — Restore drill:** No restore was performed in this pass.

Required evidence:
1. Confirm the current plan and expiry in Render.
2. Identify the latest usable backup and retention policy.
3. Prove recoverability through an approved restore test.
4. Compare continuity options, downtime, cost, data-loss exposure, and approvals.
5. Review private-network usage before changing the allow-list.

## 9. Dependency/schema findings

- **Not started — npm vulnerability triage:** No fresh dependency audit was run. Identify affected packages, severity, exploitability, and compatible fixes; avoid blind `--force` upgrades.
- **Blocked — Conversation/system FK (`LOOP-1790985133890-XKWD`):** Trace schema and creation paths, then prepare preflight checks, impact analysis, and rollback steps. Do not apply a production migration without approval.
- **Blocked — Legacy `systems` row (`LOOP-1789573914064-KZE7`):** Trace actual usage and obtain an owner decision before changing or filling legacy fields.
- **Blocked — Stale customer references:** Confirm identity through authoritative records or explicitly mark test/demo data. Do not invent mappings or perform direct production updates.

## 10. Tests run and actual results

The following results are **reported in the supplied audit**, not freshly rerun in this reconciliation.

| Check | Reported result | Status |
|---|---|---|
| `npx vitest run` | 96 files, 967 passed, 6 skipped, exit 0 | **Local fix only** |
| `npm run typecheck` | Clean | **Local fix only** |
| `npm run build` | Clean | **Local fix only** |
| `git diff --check` | Clean | **Local fix only** |
| Production `/health` | HTTP 200 observed in Render request logs | **Verified complete** for this response only |
| Production `/health/voice` | HTTP 503 observed in Render request logs | **Blocked** |
| Outbound worker heartbeat | Repeated entries; zero queue/failure counts in observed intervals | **Verified complete** for worker liveness only |
| KMG9 tests 1/1b/2 | No request-ID/workspace-hit evidence retrieved | **Blocked** |
| Matched Twilio callback acceptance | No complete attribution-and-publish trace retrieved | **Blocked** |
| Backup restore test | No evidence retrieved | **Not started** |

### Test limitations

- No local repository shell was available to run Vitest, typecheck, build, or diff checks in this pass.
- Render logs were queried read-only; no production SQL or live traffic tests were performed.
- The live production SHA is known from Render, but the current local working tree was not independently re-read.

## 11. Blockers, owners, and next three actions

| Workstream | Owner / lane | Status | Required evidence |
|---|---|---|---|
| KMG9 isolated cluster and scoped key | BHARAG/Infra — Jegan, Jason | **Blocked** | Cluster contents, key permissions, request IDs, workspace evidence, green tests 1/1b/2, SOP acceptance |
| Help corpus | Content — Destiny, Hardik | **Blocked** | Minimum three approved pages and Honest Gate review |
| Twilio attribution | Engineering/Infra | **Blocked** | Read-only trace from failing SIDs to persisted rows, plus matched callback attribution and dashboard event evidence |
| Voice acceptance | vFarm/Twilio owners | **Blocked** | Fresh health details and approved provider-backed end-to-end test |
| vFarm device contract | vFarm owners — EWQI | **Blocked** | Authoritative binding, grants, telemetry schema/freshness, and end-to-end proof |
| Postgres continuity | Account owner/Infra | **Blocked** | Approved continuity decision and verified recovery path before expiry |
| FK and legacy schema | Engineering + data owner | **Blocked** | Tested migration proposal and usage trace, with approval before production changes |
| Dependencies | Engineering | **Not started** | Fresh dependency audit and compatible remediation plan |

### Next three actions

1. **[BHARAG/Infra — Jegan/Jason] KMG9 boundary evidence:** Confirm the isolated cluster contains only `cst-help-manuals`, verify `cst-help-read` permissions and coordinated old-key revocation, then produce evidence for tests 1/1b/2. Keep KMG9 RED/OPEN until accepted.
2. **[Infra — Account owner] Postgres continuity:** Confirm backup/restore readiness and approve the continuity plan before **2026-11-14 18:10:20 UTC**. Do not upgrade, export, migrate, or narrow the allow-list without approval.
3. **[Engineering/Infra] Twilio attribution:** Trace the failing SIDs read-only and prove matched-row attribution. Do not generate live customer traffic to obtain evidence.

### Final recommendation

**Do not deploy blindly or declare CST ready for unrestricted production use.** Render confirms deployment `afbe6450d1d2d91c45a049875d4d4dc9787c0c0e` is live and the worker is producing heartbeats, but KMG9 security acceptance, Twilio attribution, voice/vFarm acceptance, and Postgres continuity remain open. No production changes were made during this reconciliation.