# BHA CST — Evidence Context for Jason

**Date:** 29 October 2026  
**Prepared by:** Ahad  
**Purpose:** Evidence-led summary of the CST production voice incident, returned Codex reviews, and remaining acceptance work.

## 1. Executive Summary

Render logs confirm that the standard voice greeting was selected and synthesized successfully, and that speech reached CST and was classified as a status request.

However, the recorded call did not complete successfully. Multiple vFarm readings requests returned HTTP 404, some upstream requests timed out, and the voice turn exceeded the 7,000 ms response deadline. The system recorded that the turn was abandoned and not persisted.

**Current assessment:**
- **Greeting:** Selected and synthesized in production for the recorded call.
- **Speech intake:** Speech received and classified as a status request.
- **Live readings:** Per-device retrieval failed during the recorded call.
- **404 root cause:** Unconfirmed; device-ID versus sensor-ID mismatch remains a hypothesis.
- **End-to-end production acceptance:** Still open.
- **Codex reviews:** Evidence and documentation updates are required. Neither submission should be treated as accepted until the reviewer confirms it.

## 2. Production Incident Evidence

### Incident details

| Field | Value |
|---|---|
| Render service | `bha-cst` |
| Service ID | `srv-db8hepqvcj2c73adpus0` |
| Instance noted in logs | `srv-db8hepqvcj2c73adpus0-gxvch` |
| Voice-call correlation ID | `CA1decc8a2aead3400c684327ec30ff44d` |
| Approximate time | 28 October 2026, 21:08–21:09 UTC |
| Tenant | `tenant-vfarm-01` |
| Project | `proj-vfarm-main` |

### Exact Render log evidence

**vFarm readings request returned 404:**

```json
{"timestamp":"2026-10-28T21:08:54.110Z","level":"WARN","message":"vFarm HTTP 404 from /api/v1/readings/latest?sensor_id=VFARM-CAB-001"}
```

**Voice turn exceeded the deadline and was not persisted:**

```json
{"timestamp":"2026-10-28T21:09:00.577Z","type":"SECURITY_LEDGER","tenant_id":null,"actor":"voice_webhook","role":"system","entry_point":"webhook","tool_or_route":"VoiceInterface.processVoiceTurnWithDeadline","outcome":"error","reason":"Voice turn exceeded the 7000ms response deadline; turn abandoned and no turn was persisted","correlation_id":"CA1decc8a2aead3400c684327ec30ff44d","tripwire":true,"deadline_ms":7000,"level":"ERROR"}
```

Other identifiers, including `relay_module_03`, `vfarm-pi2-cam`, and `water_pump_01`, also returned 404. A request for `rack1_mq7` timed out after 5,000 ms, with additional five-second timeouts observed.

The inbound webhook returned HTTP 200, but that does not establish that the caller received a successful answer.

### Observed call sequence

1. CST selected the standard greeting: `greeting_source=standard`, `greeting_version=v2`, hash `9f2d81e9`.
2. Greeting synthesis succeeded, and an audio ID was generated. The response type was `Play`.
3. Twilio speech input was received: `has_speech=true`, `speech_chars=39`, confidence `0.8661064`.
4. CST classified the intent as `status`; the call context included authorized farm IDs.
5. Farm-level status was logged for one farm: total 27, online 22, offline 3, not reported 2, unhealthy 10.
6. Per-device reading requests encountered 404s and timeouts.
7. The voice turn exceeded the 7,000 ms deadline and was abandoned without persistence.

**Conclusion:** The greeting path worked for this call, but the available evidence does not show that CST successfully spoke the requested live readings.

## 3. Code Changes and Local Verification

These changes and test results were reported for local code. They do not, by themselves, prove that the full production flow passes.

### Voice greeting

- Replaced the project onboarding reply as the initial greeting with:

  > Hi, thanks for calling vFarm Support. I'm here to help. What would you like to check today?

- Added diagnostics for greeting source/version, text hash, synthesis success, audio ID, and response type.
- The audio cache uses UUIDs, a five-minute TTL, and a maximum of 200 entries with LRU eviction. The cache is in-memory and is not shared across instances.

### vFarm readings

- Changed retrieval to list devices by farm and then request latest readings for each device using a `sensor_id` query parameter.
- Added concurrency bounded to five requests, schema validation, and normalized output.
- The code checks farm authorization before upstream calls and is intended to fail closed when authorization is missing or invalid.
- The response mapper reads nested values such as temperature, humidity, pH, CO, and soil moisture.

### Local test results reported

- **1,006 passed**
- **6 skipped**
- **0 failed**
- **97 test files**
- Typecheck, build, and diff-check reported clean.

These local results are useful evidence of code-level verification, but authorized staging or production acceptance is still required.

## 4. Evidence and Acceptance Matrix

| Area | Evidence | Status |
|---|---|---|
| Greeting selection and synthesis | Render logs for the recorded call | Observed working for this call |
| Speech intake and intent classification | Speech and intent logs | Observed |
| Farm-level status | Farm status counts in logs | Observed; cross-check against live vFarm source |
| Per-device readings | Multiple 404s and timeouts | Failed in the recorded call |
| Voice response deadline | Explicit 7,000 ms deadline exceeded | Failed in the recorded call |
| 404 root cause | No definitive API-contract and identifier-mapping evidence attached | Unconfirmed |
| Full production voice acceptance | No successful complete-call evidence for this incident | Still open |
| Production identity correlation | Speaker/farm IDs logged, but no complete record-level correlation pack attached | Still open |
| Database/endpoint decision | No written decision record attached | Still open |

## 5. Codex Review Follow-ups

### Entry 399

- **Submission ID:** `U0AC6RFNP3P_1793226011533`
- **Review status:** Sent Back
- **Verdict:** Partially Aligned
- **Red flag:** `log_not_runbook`

Required actions:

1. Include the exact Render log lines and timestamps shown above.
2. Keep the 404 cause explicitly **unconfirmed** until the authoritative vFarm API contract and identifier mapping have been checked.
3. Record the database-platform and endpoint choice in a durable ticket or PR decision record, including the rationale, owner, and acceptance criteria. A verbal discussion is not proof that a decision was documented.

### Entry 393

- **Submission ID:** `U0AC6RFNP3P_1793130714338`
- **Review status:** Sent Back
- **Verdict:** Partially Aligned
- **Red flag:** `mission_fit_not_stated`

Required actions:

1. State the BHA Engine mission fit: evidence and confidence handling should prevent the agent from guessing when authoritative current data is unavailable.
2. Explain the CST/vFarm integration and its reliance on authoritative identity and farm grants.
3. Replace vague statements such as “CST does not resolve the required standard project identifier” and “fake numbers added to those users” with specific table, column, and record evidence.
4. Distinguish seeded local/test phone numbers and user records from authoritative production identity mappings.
5. Add a dedicated **Local vs Production Verification** section, including local queries/records and the production checks still outstanding.

**Evidence limitation:** The exact table/column/row IDs, seeded phone values, and production record-to-vFarm correlations are not established in this summary. They must be retrieved from repository, database, or API evidence before adding concrete values. Do not invent examples or claim that production identity acceptance has passed.

## 6. Pilot and Engine Acceptance Dependencies

### `LOOP-1790691898379-S6Q3` — CST v1 Pilot Execution Plan

Consolidate the plan into three tracks:

- Pilot infrastructure and deployment.
- vFarm fixtures/admin, identity, and farm authorization.
- Media, security/contracts, and end-to-end verification.

For each track, specify an owner, prerequisites, acceptance criteria, evidence location, blockers, and next action.

### `LOOP-1790695346027-MOGH` — Engine Verification Flags

Define the authoritative source, pass/fail criteria, status, and evidence reference for:

1. vFarm cabinet online/offline.
2. Fabrication P1.0.
3. Media → vFarm → Form A funnel.

### Other loops to reconcile

- `LOOP-1791991972916-G718` — CST clone-quality gate; verify KMG9 acceptance before advancing.
- `LOOP-1791922936305-VU6R` — Client 2 Commissary Ops Twin session; record outcomes and remaining decisions.
- `LOOP-1790439082267-OYP9` — DNS/TLS and nginx ownership; attach live HTTPS verification.
- `LOOP-1789824812431-IWKX` — CS Twin v1 acceptance, including voice/web, tenancy/RAG isolation, DID binding, escalation, and per-tenant verification.

Links:

- [CST v1 Pilot Execution Plan](https://dashboard.bhanetwork.org/open-loops/LOOP-1790691898379-S6Q3)
- [Engine Verification Flags](https://dashboard.bhanetwork.org/open-loops/LOOP-1790695346027-MOGH)
- [CST Clone-Quality Gate](https://dashboard.bhanetwork.org/open-loops/LOOP-1791991972916-G718)
- [Commissary Ops Twin](https://dashboard.bhanetwork.org/open-loops/LOOP-1791922936305-VU6R)
- [DNS/TLS](https://dashboard.bhanetwork.org/open-loops/LOOP-1790439082267-OYP9)
- [CS Twin v1 Acceptance](https://dashboard.bhanetwork.org/open-loops/LOOP-1789824812431-IWKX)

## 7. Immediate Next Actions

1. Confirm the authoritative vFarm readings API contract and whether `sensor_id` requires a sensor UUID rather than a device ID.
2. Retest with a verified identifier and preserve request ID, upstream status, latency, and schema-validation outcome.
3. Keep the voice path bounded and ensure slow upstream requests lead to a truthful fallback rather than a misleading success.
4. Run an authorized end-to-end call proving caller identity, farm grant, current readings, spoken answer, and persisted conversation/audit.
5. Update both returned Codex entries with evidence. Do not resubmit until record-level claims are verified.
6. Record the database/endpoint decision with rationale, owner, and acceptance criteria.
7. Complete the pilot plan and Engine verification acceptance definitions.

## 8. Still Open

- Exact cause of the vFarm readings 404s and the correct device-to-sensor mapping.
- A successful full production voice turn with current readings and a persisted outcome.
- Record-level correlation of the production caller/customer record to authoritative vFarm identity and farm-grant responses.
- Exact table/column/record evidence for Entry 393’s project-identifier blocker and seeded/test records.
- Written database-platform and endpoint decision requested by Entry 399.
- Jason’s approval of the corrected Codex submissions and pilot acceptance artifacts.

## Suggested Slack Message to Jason

Jason — I’ve consolidated the production evidence and remaining acceptance gaps here. Render logs confirm that the standard greeting was selected and synthesized, and that speech reached CST. The recorded call then hit multiple vFarm readings 404s and upstream timeouts; the voice turn exceeded the seven-second deadline and was not persisted.

I’m treating the 404 cause as unconfirmed until the authoritative vFarm API contract and identifier mapping are verified. I’m updating Entry 399 with the verbatim logs and a written endpoint/database decision record, and Entry 393 with the BHA Engine mission fit plus record-level local-versus-production identity evidence.

I won’t claim end-to-end production acceptance until a correlated caller → vFarm identity → farm grant → readings → spoken response → persisted-turn test passes.

---

**Evidence standard:** Before treating this as a final audit artifact, attach the original Render log export, local test output, exact code diff/commit reference, and authoritative vFarm API contract or a successful request/response that resolves the sensor-ID question.
