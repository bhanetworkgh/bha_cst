# CST Entries 393/399 — Jason Acceptance Evidence Report

**Report date:** 29 October 2026  
**Overall status:** PARTIAL — acceptance not yet demonstrated  
**Decision Watch:** `DW-1792187689082-B0M2` — OPEN  
**Purpose:** Single review package for Entry 393 (mission fit and identity/authorization) and Entry 399 (database/endpoint decision and evidence). This report does not claim live end-to-end acceptance.

## 1. Executive summary

The supplied final acceptance report records substantial local implementation and test work, plus read-only Render and vFarm observations. It does **not** establish all acceptance gates.

Reported local validation:
- Vitest: **1006 passed, 6 skipped, 0 failed** across 97 files.
- TypeScript typecheck: clean.
- Production build: successful.
- `git diff --check`: clean.
- Backup verification: one valid archive (80,365 bytes) and two zero-byte files.
- Historical restore drill: 20/20 tables, 22/22 migrations, and 17 foreign keys restored into isolated PostgreSQL 16.14.

The report says no commit, push, merge, deployment, production data mutation, external account change, or credential rotation was performed during that task. These results are source-reported, not independently re-run for this document.

**Still open:** live voice E2E acceptance; endpoint/performance follow-up; authoritative KMG9/BHARAG boundary proof; Postgres continuity decision before the reported 14 November 2026 free-plan expiry; callback attribution investigation; stale customer-reference ownership; and GitHub push access.

## 2. Important source discrepancies to resolve before Jason sign-off

The supplied report contains conflicting production facts. Do not silently choose one value; verify them against the live Render dashboard/CLI and record the timestamp of the check.

| Field | Conflicting statements in supplied report | Required action |
|---|---|---|
| Deployed SHA | Section 2 says `78075b19757f`; Section 11 says `f546a61070b9939318a68a0b68aa12fcf12b1b3e`, both associated with the 28 October 2026 deployment | Re-check current live service deploy and quote its exact SHA and deploy time |
| Postgres IP allowlist | Section 2 says one allowlist entry, `103.120.71.129/32`; Section 11 says `0.0.0.0/0` | Re-check the live database access-control page; treat as a security-sensitive unresolved discrepancy until confirmed |
| Render service / DB state | Report provides resource IDs and health observations, but they are time-bound snapshots | Capture fresh read-only evidence before presenting as current |
| Endpoint contract | Report says the latest-readings endpoint requires `sensor_id`, while earlier incident evidence contains a 404 for `VFARM-CAB-001`; it also says the properties endpoint was not tested | Preserve the 404 as historical evidence; validate identifier semantics and endpoint contract using authoritative vFarm docs or API-owner confirmation |
| Database continuity | Historical restore drill is reported as passed, but account owner has not chosen upgrade versus verified backup/export/restore plan | Obtain explicit owner decision and current backup/restore evidence |

## 3. Entry 393 — mission fit and identity/authorization evidence

### Proposed mission-fit wording

CST owns channel handling, conversation orchestration, conversation state, and its administration surface. vFarm is authoritative for identity, membership and authorization, farm/unit associations, and live farm/device state. BHARAG owns knowledge and incident records; CST retains incident references rather than becoming the source of truth for BHARAG incidents or vFarm live state.

CST must use the authoritative vFarm identity and authorization path and fail closed when required identity, tenant, membership, or farm-access evidence is missing. Local tests demonstrate implementation behavior but do not by themselves establish production identity provenance for a specific caller.

### Evidence required for Entry 393

Attach a record-level, correlated evidence bundle showing:
- Call SID/correlation ID and UTC timestamps.
- Caller reference and its authoritative provenance (redact personal data).
- Tenant/system/project context resolved for that request.
- vFarm identity-resolution response and membership/authorization decision.
- Authorized farm IDs and the request they authorize.
- Upstream request path, response status, and relevant response fields.
- CST's resulting decision and corresponding audit/security record.

**Current classification: PARTIAL.** The supplied report says the authorized farm IDs were observed in prior logs, but a complete correlated upstream identity-resolution record is still required for acceptance. Do not use general test counts as a substitute.

## 4. Entry 399 — database and endpoint decision

### Render/Postgres details reported in the source

- Service: `bha-cst`, resource ID `srv-db8hepqvcj2c73adpus0`.
- URL: `https://bha-cst-7u9e.onrender.com`.
- Database: `bha-cst-postgres`, resource ID `dpg-db8he2qvcj2c73ado3s0-a`.
- PostgreSQL version: 16.15.
- Plan: Free; reported expiry: `2026-11-14T18:10:20Z`.
- Database name/user in source report: `bha_cst_1sh0` / `bha_cst_user`.
- Database access posture is **unresolved due to conflicting source statements**: `103.120.71.129/32` versus `0.0.0.0/0`. Verify the live allowlist before making any access-policy decision.
- Reported historical restore drill: 20 tables, 22 migrations, 17 foreign keys restored into isolated PostgreSQL 16.14.
- Reported backup check: one valid 80,365-byte archive; two zero-byte files.

### Decision to record

The accountable account/infra owner must explicitly decide whether to:
1. Upgrade/retain the Render Postgres plan; or
2. Perform a verified backup/export and restore/migration before expiry.

Record the decision owner, rationale, selected option, restore-test evidence, retention location, recovery expectations, and deadline. A historical restore drill is useful evidence but is not proof that the latest backup is valid or that the production recovery path is ready.

### Endpoint contract — current evidence and limits

The supplied report records these observations:

| Endpoint | Method and parameters reported | Reported behavior |
|---|---|---|
| `/api/v1/devices?farm_id={farmId}` | GET, `farm_id` query parameter | Lists devices for a farm |
| `/api/v1/readings/latest?sensor_id={sensorId}` | GET, `sensor_id` query parameter | Returns latest sensor reading; reported latency ranges from about 0.7 seconds to 43 seconds |
| `/api/v1/readings/properties` | GET, optional `farm_id` and `window` | Not tested in the supplied report |
| `/api/v1/farms/{farmId}/health` | GET, farm ID in path | Reported farm health response |

The report says the CST implementation now lists devices and requests each sensor's readings. It reports 8 of 23 devices returning readings, 9 returning “no readings” 404s, and 6 timing out. The exact identifier/endpoint semantics still require authoritative documentation or vFarm API-owner confirmation. Do not claim that every 404 is a code defect: the source report classifies some as “no readings found.”

### Historical Render failure — retain as failure evidence

Call SID/correlation ID: `CA1decc8a2aead3400c684327ec30ff44d`

- `2026-10-28T21:08:54.110Z`: request reported a 404 for `/api/v1/readings/latest?sensor_id=VFARM-CAB-001`.
- `2026-10-28T21:09:00.577Z`: voice turn reported to have exceeded the 7,000 ms deadline and been abandoned without persistence.

These details are transcribed from the supplied report/context. The original raw Render log lines should be attached verbatim before formal acceptance. They show a failed attempt, not successful E2E behavior.

### Performance risk

The supplied report says several rack/gateway readings took roughly 29–43 seconds, exceeding CST's 7-second voice deadline. This is a material live-read performance risk. The implementation should not wait serially for slow sensors if the voice contract requires a response within seven seconds. Any mitigation must preserve authorization, freshness metadata, and clear handling of partial/missing readings; do not fabricate readings or fall back to BHARAG for live state.

## 5. Other material blockers from the supplied acceptance report

| Blocker | Current source classification | Required evidence/action |
|---|---|---|
| KMG9/BHARAG cluster-key boundary | BLOCKED — upstream contract | Authorized negative and positive tests proving help-only key cannot retrieve farm data but can retrieve permitted help content; confirm with BHARAG/Jegan |
| Postgres continuity | BLOCKED — owner decision | Current backup verification and explicit upgrade vs backup/restore decision before reported expiry |
| Delivery callback attribution | BLOCKED — production DB evidence | Inspect actual `messages_out` rows for failing provider SIDs; confirm tenant/project/turn attribution and monotonic status updates |
| Stale customer references | BLOCKED — owner confirmation | Confirm real owners through approved channels; never guess mappings or change records without authorization |
| GitHub push access | BLOCKED — credentials/access | Repository/org admin to restore approved push/connector authentication |
| Voice playback / Twilio | PARTIAL — live acceptance absent | Authorized staging/live test with call SID, playback evidence, callback evidence, and response timing |
| Rack sensor timeouts | BLOCKED — upstream performance | vFarm investigation and measured latency evidence against the 7-second voice deadline |
| `fast-uri` dependency findings | BLOCKED — owner triage | Review the two moderate findings reported via `ajv` and document a justified remediation decision |

## 6. Four-gate acceptance matrix for Entries 393/399

| Gate | Acceptance requirement | Current status | Evidence still needed |
|---|---|---|---|
| 1. Endpoint contract and 404 investigation | Authoritative endpoint/identifier contract; reproducible interpretation of 404; acceptable latency/partial-result behavior | **PARTIAL** | vFarm docs/API-owner confirmation, raw request/response evidence, and performance resolution or approved mitigation |
| 2. Database/endpoint decision | Persistent decision record with owner, rationale, database path/access posture, continuity choice and measurable criteria; direct backlink from Entry 399 | **PARTIAL** | Verify conflicting allowlist and deployed SHA; obtain account-owner decision; publish one approved record and link Entry 399 |
| 3. Entry 393 | Correct mission-fit language plus correlated record-level identity/authorization proof | **PARTIAL** | Authoritative identity-resolution and authorization evidence for the same call/request |
| 4. Entry 399 and live E2E | Verbatim incident logs plus successful authorized live call, persisted turn, security/audit evidence, deployed SHA and deadline measurement | **NOT RUN / PENDING OPERATOR E2E** | Operator's successful test evidence and original log excerpts |

Do not close `DW-1792187689082-B0M2` or mark Entries 393/399 accepted until the required evidence is reviewed and accepted.

## 7. Operator live E2E capture template

Complete this section after performing the authorized test. Do not pre-fill with assumptions.

- **Status:** `PENDING OPERATOR E2E`
- Test date/time (UTC):
- Render service and deployed commit SHA:
- Test environment:
- Call SID/correlation ID:
- Authorized caller reference (redacted):
- vFarm identity-resolution outcome:
- Tenant/system/project context:
- Authorization outcome and authorized farm IDs:
- Endpoint and identifier type:
- HTTP status and response schema:
- Relevant readings, freshness, and latency:
- Voice intent:
- Exact caller-facing result (redact personal data):
- Turn persisted? Link/record ID:
- Security/audit log evidence:
- Total response duration:
- 7-second deadline met?:
- Source links/log query references:
- Operator and reviewer:

Acceptance requires a successful authorized call, correct authoritative data path, persisted turn, corresponding security/audit evidence, and response within the agreed deadline. If a sensor times out, record the actual behavior and do not label the gate passed unless an approved partial-response policy is demonstrated.

## 8. Jason demonstration script

1. Show the mission-fit boundary: CST orchestrates conversations; vFarm is authoritative for identity/access and live state; BHARAG owns knowledge/incidents.
2. Show the endpoint contract from authoritative documentation and explain the historical 404 without guessing at its cause.
3. Show the original Render log excerpts, UTC timestamps, and call SID. Label the 404 and timeout as failure evidence.
4. Show correlated identity-resolution and authorization evidence for a single call.
5. Show the database decision, verified current IP allowlist, backup/restore evidence, and named owner decision.
6. Perform or review the operator's live E2E recording and confirm persistence, audit evidence, deployed SHA, and deadline.
7. Walk through all four gates and explicitly list any remaining blocked items.

Recommended recording length: 5–8 minutes. Keep an unedited internal copy, redact credentials/tokens/phone numbers/customer data from the shareable version, and link the recording and source logs from this report.

## 9. Evidence provenance and safety

This report is based on the user-supplied **CST — Final Acceptance Report (29 October 2026)**. It preserves that report's classifications and calls out conflicting facts rather than silently reconciling them. Reported test counts, Render state, endpoint behavior, and restore-drill results have not been independently re-run as part of creating this consolidated document.

No production change, deployment, database write, provider transaction, or live E2E call was performed to prepare this report. Do not expose secrets or full customer identifiers in the shareable copy.

## 10. Draft message to Jason

> Jason — I’ve consolidated the CST Entries 393/399 evidence into one review report: **[insert report link]**.
>
> The report separates local test evidence, historical Render failure evidence, live vFarm observations, and the E2E proof still to be supplied. It also flags two production facts that must be rechecked before sign-off: the deployed SHA and the Postgres IP allowlist are inconsistent within the supplied source report.
>
> The historical 404 and 7-second timeout remain classified as failures. The operator E2E section is pending until I attach the successful authorized call evidence, persisted turn, audit record, and measured response time.
>
> `DW-1792187689082-B0M2` and Entries 393/399 remain open pending review and acceptance of the four gates.
