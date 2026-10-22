# SOP — CST/BHA Independent Work and Evidence Logging Standard

**Version:** 1.0
**Effective:** 2026-10-22
**Scope:** All independent engineering work performed on the Customer Service Twin (CST) repository (`bhanetworkgh/bha_cst`), including local code changes, read-only production verification, and upstream coordination.

---

## 1. Purpose

Ensure every material claim made about CST — local fixes, test results, production behavior, upstream dependencies — is backed by a unique, reproducible evidence reference. Prevent "status inflation" where a local test pass is reported as production acceptance.

## 2. Evidence register format

Every material completion claim must cite a unique evidence ID. Format: `E-<lane>-<seq>` (e.g. `E-vFarm-001`, `E-AskEngine-003`).

Each entry must include:
- **Evidence ID**
- **Source** (file path, command, or API call)
- **Environment** (`local`, `staging`, `production`)
- **Timestamp / SHA** (when applicable)
- **Observed result** (exact output, redacted as needed)
- **Limitations** (what this evidence does NOT prove)

## 3. Lane tags

All work must be tagged with one of:
- `[Ask Engine]` — routing, intent detection, conversation flow
- `[vFarm]` — vFarm adapter, identity resolution, farm data, telemetry
- `[BHARAG]` — knowledge connector, incident connector, BHARAG integration
- `[infra]` — build, tests, CI, dependencies, operations

## 4. Required log sections

Every engineering log must include:
1. **What I moved** — files changed, behavior before/after, lane tags.
2. **Why it matters for the Engine** — customer behavior, commercial impact.
3. **Evidence register** — unique IDs with source/command/environment/result/limitations.
4. **Exact person → form/zone/location → device → telemetry → voice-response DB path** — real names/keys/joins only when evidenced; explicitly mark missing links.
5. **SMS and CST health truth rules** — explicit allowed/not-allowed claims.
6. **Self-healing rule** — trigger, scope, deduplication, degraded behavior, bounded retries, recovery, audit fields, proof of invocation.
7. **Blockers / Where I'm stuck** — owner, impact, exact missing contract/evidence, questions for upstream.
8. **Next** — preserve P0 → CS Twin v1 → VFAM auth contract → DNS/TLS order.
9. **Release decision** — one of: `READY FOR REVIEW — LOCAL ONLY`, `BLOCKED — NEEDS JEGAN / UPSTREAM CONTRACT`, `HOLD — LOCAL ACCEPTANCE EVIDENCE MISSING`, `P0 CLOSED — UPSTREAM CONFIRMATION + AUTHORIZED END-TO-END ACCEPTANCE EVIDENCE ATTACHED`.

## 5. Truth rules

**SMS delivery:**
- May say "queued" only with evidence of durable queueing.
- May say "accepted by provider" only with a confirming provider response.
- May say "delivered" only with an authoritative provider delivery receipt/status.
- Must not equate queued or provider-accepted with handset delivery.
- Must disclose unknown, pending, failed, or unavailable delivery status honestly.

**CST health:**
- Distinguish API/process, database, vFarm identity/live data, BHARAG knowledge, outbound worker/queue, and actual provider delivery.
- A successful shallow `/health` probe proves only the checks that endpoint performs.
- Never claim full CST health or successful delivery based solely on a shallow health endpoint or local tests.

## 6. Self-healing rule (proposed default)

- Trigger: same person → form → device resolution failure ≥3 times in 10 minutes, scoped by (tenant, project, category).
- Action: emit deduplicated operational incident, mark capability degraded, stop claiming live device data.
- Safe behavior: preserve authorization boundaries; do not fabricate data, silently switch to knowledge answers, or retry indefinitely.
- Recovery: bounded recheck (max 5, 1/min); restore only after successful authorized resolution and telemetry retrieval.
- Audit: timestamps, failure category, correlation reference, retry count, incident state, recovery result — no secrets or PII.

## 7. P0 → P1 ordering

P0 (vFarm person → form → device path) must be closed before P1 work begins:
1. P0 closed with Jegan and authorized end-to-end path proven.
2. Exact database path included in the log.
3. SMS delivery and CST health allowed/not-allowed claims included.
4. Evidence-backed self-healing rule included.

A reply or report alone does not close the watch. Jason closes it manually after all four conditions are answered.
