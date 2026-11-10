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

## 6. Five designated Jason-review watches — keep open

These are the five records the user specifically asked to keep prepared for Jason. **Do not close them.** The latest Slack inventory shows that some still have evidence gaps, so “prepared for review” does not mean “acceptance-ready” or “complete”.

| Watch | Latest known requirement / remaining condition |
|---|---|
| `DW-1793289606909-UUCT` | Entry 393/399 review. The decision record is committed at `932521d9b8a491e5372f29ed2928a0e660a43ea8`, but its status is PARTIAL; check entry backlinks, named/dated loops and submission history. |
| `DW-1794242269028-F1RH` | Verify Monitoring alert route, capture the two required test-message permalinks and document the route. |
| `DW-1793381880209-HWB8` | Sensor-filter diagnostic is committed, but the historical after-example uses `/readings?limit=1` while the watch requested `/readings/latest`. CI/live trace or reviewer scope disposition is still needed. |
| `DW-1792559119184-3A8Q` | Confirm vFarm user exists, verify CST phone binding and confirm/correct farm assignment. |
| `DW-1793621652529-3PQN` | Link the agreed Voice 1 spec, CS Twin brain API contract and architecture decision to IWKX. |

Source: [Ahad's 18-watch inventory](https://bayshorizonnetwork.slack.com/archives/C0ASMPYQLG3/p1794263023853129) and [Bays's 10 Nov reconciliation](https://bayshorizonnetwork.slack.com/archives/C0ASMPYQLG3/p1794263874993589).

## 7. Operator actions — exact steps, no action executed

### 7DRA — CST-to-vFarm service key (newer watch)

Watch: `DW-1794318655094-7DRA`. The watch opened on 10 Nov at 18:51 PKT. Its explicit owed items are (1) mint `cst-help` from the Bitwarden superadmin login and post the first real call in the originating thread with its request ID and matching service-key audit line; and (2) record the `bha_cst` switch. CST remains “not shipped” until both are evidenced.

1. The authorized Bitwarden superadmin/vFarm owner mints the dedicated `cst-help` service key; do not paste the secret into chat or GitHub.
2. Make the first real, authorized service call from the intended CST integration. Capture the request ID and the matching service-key audit record in the 7DRA originating thread.
3. **Before switching the app**, reconcile the contract: deployed `main` currently reads `VFARM_API_JWT` and/or `VFARM_API_FARM_KEY`; it does not read `VFARM_SERVICE_KEY`. Confirm with vFarm which issued credential maps to which supported header/config variable, or have the code owner implement and review the intended variable.
4. Only after the variable/credential contract is agreed, an authorized Render operator configures the matching key name securely and records the change (never its value).
5. Capture the post-switch production request ID and audit line. Reply in the original 7DRA thread; a reply restarts the reminder wait but does not itself close the watch.

[7DRA opening and exact acceptance condition](https://bayshorizonnetwork.slack.com/archives/C0AFEAEHWR2/p1794318675107719).

### F20Q — BHARAG read-only key and query contract

Watch: `DW-1793623465895-F20Q`.

1. BHARAG owner confirms the `cst-help-read` credential identity and read/ask scope.
2. Restore the expired BHARAG admin login through its owner; do not bypass account controls or use a personal credential.
3. Owner retrieves the secret from the approved secret manager; authorized Render operator checks for `BHARAG_CLUSTER_KEY` on `bha-cst` and configures it securely if absent.
4. Verify the deployed request to the cluster ask endpoint carries only `{ query }`, without `workspaceKey` or `workspace`.
5. Capture one successful permitted query and one denied/out-of-scope test with request IDs, response codes and sanitized logs. Confirm no secret value is logged.

**Important:** Current source declares and consumes `BHARAG_CLUSTER_KEY`, but Render's read metadata in this session does not reveal whether the production variable is set. The last observed admin login was reported as expired; access restoration remains unverified.

### 50LF — real SMS acceptance

Watch: `DW-1793405840064-50LF`.

1. Confirm explicit handset consent and Twilio permission for the Pakistan destination.
2. Use recipient `+923082113844` and CST sender `+19715885823` only after the operator reconfirms these are still the approved numbers.
3. Record UTC start time, operator, tenant/project, correlation ID and message SID.
4. Send one harmless, clearly identified test message through the approved CST production flow.
5. Verify Twilio's final carrier delivery status/callback **and** the corresponding CST persisted/dashboard record. HTTP 2xx alone is not delivery proof.
6. Save redacted logs and record the message SID, callback result and persisted record reference in the originating 50LF thread.

The earlier committed preflight report explicitly records SMS as `NOT_TESTED`; it is not proof of a real SMS.

### PDQ2 — live PSTN voice acceptance

Watch: `DW-1793626498819-PDQ2`.

1. Retrieve Jason's canonical five decision items and A–F next-step wording from the original PDQ2 thread before testing; the latest inventory explicitly asks for that verbatim checklist.
2. Confirm handset authorization and Twilio voice geo-permissions.
3. From the authorized recipient handset `+923082113844`, call CST's Twilio number `+19715885823`, after reconfirming both numbers.
4. Verify caller authorization, vFarm identity resolution and that the spoken farm summary reflects current authoritative vFarm data.
5. Capture Call SID, UTC timestamps, answer/duration/outcome, correlation ID, callback events and persisted conversation/delivery record.
6. Distinguish answered, failed, busy, no-answer and caller-hung-up outcomes; link redacted proof in the PDQ2 thread.

No live SMS or PSTN call was made during this audit.

## 8. Other outstanding watches from the authoritative 18-watch inventory

Ahad's 10 Nov 03:23 PKT message explicitly says the following 18 watches/reminder groups come from the current inventory. It splits them into 12 overdue and 6 scheduled; it does not say they are all accepted or closed.

| # | Watch | Inventory grouping | Remaining requirement from the inventory / follow-up |
|---:|---|---|---|
| 1 | `DW-1793621652529-3PQN` | Overdue | Link Voice 1 spec, CS Twin brain API contract and architecture decision to IWKX. |
| 2 | `DW-1793380167011-MDWV` | Overdue | Before/after readings evidence and relay device IDs; historical trace still needs reviewer scope decision given later CST v1 scope. |
| 3 | `DW-1793373034142-26J5` | Overdue | Entry 399's seven requirements mapped to evidence or explicit gaps; original checklist/backlinks still need review. |
| 4 | `DW-1794…-FQ0V` | Overdue | Verify signing-secret configuration by name, deployed verification code, and one accepted plus one rejected signed-webhook test with request IDs. Exact full ID must be copied from the authoritative watch record before any update. |
| 5 | `DW-1793393849183-DN1D` | Overdue | Migration evidence submitted as partial progress; production callback trace and separate production verification remain outstanding. |
| 6 | `DW-1792559119184-3A8Q` | Overdue | Confirm vFarm user, CST phone binding and farm assignment. |
| 7 | `DW-1793381880209-HWB8` | Overdue | Link deployed device-to-readings mapping; reconcile historical `/readings/latest` requirement with current v1 scope. |
| 8 | `DW-1793405840064-50LF` | Overdue | Healthy DB-backed deployment, real end-to-end SMS evidence and integration-point documentation. |
| 9 | `DW-1793406530806-QJY3` | Overdue | Four loop-to-log/evidence mappings; Ahad says submitted in the originating DM, but they still need to be checked against the watch. |
| 10 | `DW-1793450974729-Q64Y` | Overdue | Migration evidence submitted as partial progress; production SMS tenancy/delivery trace and farm-summary scope decision remain open. |
| 11 | `DW-1793639588507-0P6K` | Overdue | Five Codex submissions must be identified. Rows 467, 399, 393, 451 and 178 are candidates only, not confirmed IDs. |
| 12 | `DW-1793626498819-PDQ2` | Overdue | Five-part CST/Monitoring review and A–F evidence; exact canonical wording requested from Jason's original thread. |
| 13 | `DW-1794242269028-F1RH` | Scheduled | Monitoring alert route and two test-message permalinks. |
| 14 | `DW-1794058961107-CE01` | Scheduled | Ahad's three PBT5 builder deliverables were accepted by Jason for builder review; Destiny still owns the append-only GPMM field and Bays the XXHH label. Retain Jason's administrative hold; do not ask Ahad to repeat the 7 Nov drill. |
| 15 | `DW-1793623465895-F20Q` | Scheduled | Confirm `cst-help-read` scope, query-only body and successful request; BHARAG admin access restoration was unverified. |
| 16 | `DW-1792496727676-IQB3` | Scheduled | Security, consent and verification blocker report with evidence and owner for each blocker. |
| 17 | `DW-1793289606909-UUCT` | Scheduled | Entries 393/399: committed record credited, but actual backlinks, dated/owned open loops and submission history remain to be checked. |
| 18 | `DW-1792712806772-JLRL` | Scheduled | PR #2 merge condition is met; KMG9 acceptance, regression CI with SHAs, dependent CST v1 entry and success/failure voice evidence remain open. |

**FQ0V caution:** The Slack inventory provides only the suffix FQ0V, not the full watch ID. Do not invent the missing numeric portion; retrieve the full ID from the canonical watch record.

Sources: [18-watch inventory](https://bayshorizonnetwork.slack.com/archives/C0ASMPYQLG3/p1794263023853129), [four corrections](https://bayshorizonnetwork.slack.com/archives/C0ASMPYQLG3/p1794263381556109), [follow-up mappings and open conditions](https://bayshorizonnetwork.slack.com/archives/C0ASMPYQLG3/p1794263815413179), and [Bays reconciliation (no watch status changes)](https://bayshorizonnetwork.slack.com/archives/C0ASMPYQLG3/p1794263874993589).

### 7DRA is an additional, newer watch

The 18-watch inventory was posted at 03:23 PKT on 10 Nov. A separate 7DRA watch was opened later at 18:51 PKT on 10 Nov. Therefore the currently identified set is **18 inventory watches + the newer 7DRA watch = 19 named watch records**, not 13. This is a count reconciliation, not a claim that all 19 have the same status or owner.

## 9. Final status

### Completed
- Confirmed GitHub main SHA, PR #25 and PR #51 merge state.
- Confirmed current Render live deployment and its source SHA.
- Inspected deployed source for vFarm/BHARAG environment-variable names.
- Prepared operator runbooks for 7DRA, F20Q, 50LF and PDQ2.
- Retrieved the authoritative 18-watch Slack inventory, the four corrections, the follow-up mapping note, Bays's no-write reconciliation and the newer 7DRA opening.

### Awaiting human action
- Jason's review/decisions on the five designated records; none is to be closed by this audit.
- vFarm/BHARAG owners and authorized Render operator to resolve credential contract/access and verify configuration by key name only.
- Authorized handset operator to run SMS and PSTN acceptance and attach provider + CST persistence evidence.
- Destiny and Bays to complete CE01's append-only GPMM field and XXHH label.
- Jason to identify the five actual Codex submissions for 0P6K and supply PDQ2's canonical five-part/A–F checklist.
- Owners/reviewers to supply FQ0V, F1RH, IQB3, QJY3, DN1D and Q64Y remaining proof.

### Blocked
- JLRL acceptance remains blocked despite PR #2 being merged; the PR-opening condition alone is not acceptance.
- CE01 remains open for Destiny/Bays system steps despite Jason accepting Ahad's three builder deliverables for review.
- 0P6K remains open pending five confirmed submission IDs.
- 7DRA remains open pending the first real `cst-help` call + audit line and recorded `bha_cst` switch.
- Local `git status` and complete working-tree diff pending access to the agent's actual checkout.
- Full FQ0V watch ID pending authoritative record lookup.

### Deployed but unverified
- Production presence/scope of the vFarm credential and `BHARAG_CLUSTER_KEY` (Render read metadata does not expose configured secret values or key names).
- Real SMS delivery and end-to-end PSTN acceptance for this task.
- Individual person-to-unit authorization and the vFarm mapping API acceptance.
- Monitoring alert test delivery and signed-webhook accepted/rejected live traces.

## 10. Change-control statement

This report was prepared from read-only GitHub, Render and public Slack evidence. A documentation-only commit was created on a review branch and a draft PR was opened; it has not been merged or deployed. No Render environment settings were changed, no credentials were injected, no production deploy or PR merge was triggered, no SMS/call was sent, and no Decision Watch was closed.
