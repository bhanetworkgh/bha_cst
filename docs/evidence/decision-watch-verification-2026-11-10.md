# CST Decision Watch Verification — 2026-11-10

**Purpose:** Verification-only reconciliation of the agent's Decision Watch execution report.  
**Repository:** `bhanetworkgh/bha_cst`  
**Production service:** `bha-cst` — https://bha-cst-7u9e.onrender.com  
**Render service ID:** `srv-db8hepqvcj2c73adpus0`  
**Verification date:** 2026-11-10  
**Scope:** GitHub remote state and Render service/deploy/log metadata. No local checkout, secret values, Postgres query, or Decision Watch mutation was available/performed.

## Executive result

The production baseline is confirmed, but the agent's claimed six-file change set is **not independently verified**. The SHA it cited, `c4c219f68b0d972d4b7f75eaac964ea97e52e858`, is a real commit in merged PR #25 (PBT5 ElevenLabs observability), not evidence that the six files listed in the agent's report were changed together.

- GitHub `main`: `f08e3570d19aafa55f0066e8bdb5040ea02e3438`.
- Render live deploy: `dep-dbo7qjdg1s2s7387df2g`, status `live`, branch `main`, commit `f08e3570d19aafa55f0066e8bdb5040ea02e3438`.
- PR #25: merged 2026-11-04; merge commit `f8aea9ec93e1ba272f817d2013d7942e0a38a5d9`; its PBT5 commit `c4c219f...` is an ancestor of current `main`.
- PR #51: merged 2026-11-08; current production commit `f08e357...`.

## 1. Git status and diff — limits and findings

The connected GitHub integration reads remote repository state. It does not expose the agent's local working tree. Therefore these cannot be reported from this session:

- `git status --short`
- `git diff`
- `git diff --cached`
- untracked files, staged files, or unstaged local edits

The six files claimed by the agent were:

1. `engine/src/config/env.ts`
2. `engine/src/core/registry.ts`
3. `tests/connectors/bharag_rag.test.ts`
4. `docs/release/cst-decision-record-2026-10-30.md`
5. `docs/evidence/decision-watch-audit-2026-11-10.md`
6. `docs/evidence/decision-watch-remaining-13-execution-report-2026-11-10.md`

Remote checks at `main` found:

- `env.ts` exists and declares `BHARAG_CLUSTER_KEY`; it does **not** declare `VFARM_SERVICE_KEY`. The vFarm API configuration instead uses the documented JWT/farm-key variables.
- `registry.ts` exists and wires vFarm through `VFARM_API_BASE_URL`, `VFARM_API_FARM_KEY`, and `VFARM_API_JWT`; no `VFARM_SERVICE_KEY` use was found.
- `tests/connectors/bharag_rag.test.ts` exists and tests use of `BHARAG_CLUSTER_KEY`.
- The release decision record exists but its header remains the earlier 2026-11-02 decision-record state.
- The two new 2026-11-10 evidence paths named above were not found on `main` at verification time.

The commit `c4c219f...` is associated with [PR #25](https://github.com/bhanetworkgh/bha_cst/pull/25), titled “feat(observability): implement PBT5 ElevenLabs voice observability…”. Its commit diff is a broad PBT5/ElevenLabs observability change set. It is not a six-file Decision Watch reconciliation commit. It is merged and its ancestry is included in current production, but that does not establish the agent's claimed local edits.

## 2. Commit, PR, merge and deployment state

| Item | State | Evidence |
|---|---|---|
| `c4c219f68b0d972d4b7f75eaac964ea97e52e858` | Committed and pushed; merged via PR #25 | [Commit](https://github.com/bhanetworkgh/bha_cst/commit/c4c219f68b0d972d4b7f75eaac964ea97e52e858) · [PR #25](https://github.com/bhanetworkgh/bha_cst/pull/25) |
| PR #25 merge | Merged | Merge SHA `f8aea9ec93e1ba272f817d2013d7942e0a38a5d9` |
| Current `main` | `f08e3570d19aafa55f0066e8bdb5040ea02e3438` | [Commit](https://github.com/bhanetworkgh/bha_cst/commit/f08e3570d19aafa55f0066e8bdb5040ea02e3438) |
| PR #51 | Merged 2026-11-08 | [PR #51](https://github.com/bhanetworkgh/bha_cst/pull/51) |
| Render deploy | Live on `main` | `dep-dbo7qjdg1s2s7387df2g`; [Render service](https://dashboard.render.com/web/srv-db8hepqvcj2c73adpus0) |
| Agent's six-file local patch | Unknown | No local Git status/diff or matching PR supplied |

The deployed commit is the current main SHA. Do not attribute unrelated or uncommitted agent changes to this deployment.

## 3. Environment-variable state

### Source-code verification

- `VFARM_SERVICE_KEY`: absent from the deployed `main` source inspected. Current vFarm API code declares `VFARM_API_JWT` and `VFARM_API_FARM_KEY` (plus the API base URL and timeout).
- `BHARAG_CLUSTER_KEY`: declared in the deployed source and consumed by the BHARAG RAG test/connector path.

### Render secret-value verification

The available Render read endpoint returns service/deploy metadata but not the service's environment-variable names or values. The logs searched for the literal variable names returned no matching log lines; that is not proof that either variable is configured or absent.

**Verdict:** Neither production secret value nor its configured/not-configured state is independently confirmed. Do not print, request in chat, or commit secret values. An authorized Render operator must inspect the Environment page and confirm presence by key name only (never disclose the value).

## 4. Render production observations

- Service: `bha-cst`, `srv-db8hepqvcj2c73adpus0`.
- Latest deploy: `dep-dbo7qjdg1s2s7387df2g`, `live`, `main`, SHA `f08e357...`.
- Render service metadata currently reports web-service ingress allow-list `0.0.0.0/0`. This is the public web-service ingress, not the PostgreSQL allow-list. Do not describe it as proof that the database is publicly exposed.
- 2026-11-10 application logs include periodic outbound-worker heartbeats with `pending=0`, `queued=0`, `sending=0`, `failed=2`, `outcome_unknown=0`.
- Health-monitor HEAD requests to `/health` returned HTTP 200 in the sampled logs.
- No SMS or PSTN voice acceptance event was initiated as part of this verification.

## 5. Operator instructions — no action executed

### 7DRA — vFarm service credential

1. vFarm owner/Jegan confirms the supported service-to-service credential mechanism and grants the minimum approved access needed for CST's assigned vFarm operations.
2. Create/rotate the dedicated `cst-help` service credential in the approved secret manager. Do not invent permissions or reuse a personal token.
3. An authorized Render operator adds the exact variable expected by the deployed code. **Current deployed code does not read `VFARM_SERVICE_KEY`; it reads `VFARM_API_JWT` and/or `VFARM_API_FARM_KEY`.** Confirm with the vFarm owner which credential maps to which header before configuring anything.
4. Record only the key name, owner, scope, configuration timestamp and rotation reference. Never record the secret value.
5. After an separately authorized deployment/restart, run a read-only farm/device/reading check and retain request IDs and response status.

**Stop condition:** Do not add `VFARM_SERVICE_KEY` to Render until the code/config contract is reconciled. A variable not consumed by the deployed app will not fix authentication.

### F20Q — BHARAG read-only cluster key

1. BHARAG owner confirms that `cst-help-read` is the approved credential identity and that it is scoped to the intended read/ask operation.
2. Authorized owner retrieves the secret from the approved secret manager.
3. Authorized Render operator checks whether `BHARAG_CLUSTER_KEY` exists on `bha-cst`; if absent, configure it through Render's secure Environment UI.
4. Verify the deployed code sends only the `{ query }` request body to the approved cluster ask endpoint and does not send workspace overrides.
5. Test a permitted query and a denied/out-of-scope query. Confirm no credential value is logged.

### 50LF — real SMS acceptance

1. Confirm the handset owner has explicitly consented to receive the test and that Twilio has permission to message the Pakistan destination.
2. Use the authorized recipient handset `+923082113844` and CST sender `+19715885823` only if those are still the approved test numbers.
3. Record test start time (UTC), test operator, tenant/project, correlation ID and message SID.
4. Send one harmless, clearly identified test message through the approved CST production flow.
5. Verify the carrier/Twilio final delivery callback and the corresponding CST dashboard/database record. A successful HTTP request alone is not proof of delivery.
6. Save redacted evidence. Do not publish full phone numbers or message contents containing personal data.

### PDQ2 — live PSTN voice acceptance

1. Confirm the handset owner has authorized the call and that Twilio voice geo-permissions allow the destination.
2. From the authorized recipient handset `+923082113844`, call the CST Twilio number `+19715885823` (confirm both numbers are still approved before execution).
3. Verify the call reaches CST, the caller resolves to the authorized vFarm identity, and the spoken farm summary is grounded in current vFarm data.
4. Capture Call SID, UTC timestamps, answer/duration/result, correlation ID and the related persisted conversation/delivery record.
5. Verify status callbacks and final attribution. Distinguish answered, failed, busy, no-answer and caller-hung-up outcomes.
6. Redact personal data in the evidence package.

## 6. Human sign-off watches — retain open

The five records identified for Jason remain **ready for review, not accepted/closed**:

- `DW-1793289606909-UUCT` — Entry 393/399 reconciliation.
- `DW-1794242269028-F1RH` — Monitoring alert routing.
- `DW-1793381880209-HWB8` — state-versus-metric contract.
- `DW-1792559119184-3A8Q` — phone binding to vFarm user.
- `DW-1793621652529-3PQN` — CS Twin v1 architecture.

Jason's acceptance must be explicit and recorded against each watch.

## 7. External blockers — keep blocked

- `DW-1794058961107-CE01`: Destiny and Bays complete the external bookkeeping and provide the recorded evidence.
- `DW-1793639588507-0P6K`: Jason supplies/validates the five confirmed Codex submission IDs.
- `DW-1792712806772-JLRL`: vFarm team provides the person-to-unit mapping API contract and authorization semantics.

Do not mark any as complete based solely on local code or draft documentation.

## 8. Watch-count reconciliation

The execution summary referenced “13” remaining watches, but the specific categorized lists supplied for this verification identify 5 Jason sign-offs + 4 operator actions + 3 external blockers = **12 distinct watch IDs**. The thirteenth ID was not present in the supplied list and must be identified from the authoritative Decision Watch source before claiming a complete 13-watch reconciliation.

A historical repository document, `Open_decision_watches_for_Ahad_3_Nov_2026.md`, lists 20 earlier watches and contains older/conflicting statuses. It is not a substitute for the current 13-watch source of truth.

## 9. Final status

### Completed
- Confirmed GitHub main SHA, PR #25 and PR #51 merge state.
- Confirmed current Render live deployment and its source SHA.
- Inspected deployed source for vFarm/BHARAG environment-variable names.
- Prepared exact operator runbooks for 7DRA, F20Q, 50LF and PDQ2.

### Awaiting human action
- Jason's five explicit sign-offs.
- Authorized vFarm/BHARAG owners and Render operator to verify/configure credentials after contract alignment.
- Authorized handset operators to execute SMS and PSTN acceptance.

### Blocked
- CE01, 0P6K and JLRL pending their named owners.
- The thirteenth watch ID pending authoritative source retrieval.
- Local `git status` and complete working-tree diff pending access to the agent's actual checkout.

### Deployed but unverified
- Production presence and scope of `VFARM_SERVICE_KEY` / `VFARM_API_JWT` / `VFARM_API_FARM_KEY` and `BHARAG_CLUSTER_KEY` (Render secret values are not exposed by the read metadata endpoint).
- Real SMS delivery and end-to-end PSTN acceptance for this task.
- Individual person-to-unit authorization and full operator completion.

## 10. Change-control statement

This report was prepared from read-only GitHub and Render metadata plus deployed source/log inspection. No Render environment settings were changed, no credentials were injected, no deploy or merge was triggered, no SMS/call was sent, and no Decision Watch was closed. This report is on a review branch and must be reviewed before merge.
