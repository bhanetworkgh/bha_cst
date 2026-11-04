# ADR-0002 — Alert Events Audit Contract & Schema Specification

**ADR Identifier:** `ADR-0002-alert-events-audit-contract`  
**Loop Reference:** [`LOOP-1788044070645-018M`](https://dashboard.bhanetwork.org/open-loops/LOOP-1788044070645-018M)  
**Decision Watch:** `DW-1793621770574-1G7A`  
**Preceding ADR:** [`ADR-alert-audit-rendered-body-vs-replay.md`](ADR-alert-audit-rendered-body-vs-replay.md) (ADR-0001)  
**Owners / Participants:** Ahad (CST Engineering), Kavin (Audit & Platform Lead)  
**Date:** 2026-11-03  
**Status:** PROPOSED_PENDING_KAVIN_APPROVAL  

---

## 1. Context & Background

The Customer Service Twin (CST) generates, delivers, audits, and escalates critical operational notifications across multiple channels (SMS, Voice, Slack, Webhooks) when farm anomalies occur. Migration 008 introduced the initial `alert_audit_log` table, and Migration 022 introduced durable `escalations`. 

Under **`LOOP-1788044070645-018M`**, CST requires a formalized, end-to-end **Alert Events Audit Contract** that establishes strict regulatory compliance, immutable audit reproducibility, write-time secret masking, and deterministic lifecycle tracking across CST and Kavin's platform components.

---

## 2. Decision Brief for Kavin (13 Core Architectural Dimensions)

Below is the structured technical brief defining the contract parameters and highlighting unresolved decisions requiring Kavin's formal sign-off.

### 1. What Constitutes an Alert Event
An Alert Event is defined as any system-initiated or anomaly-driven outbound communication conveying urgent operational status, regulatory warnings, physical threshold breaches, or human escalation requests. It is distinct from routine conversational turns (`cst.turn`) in that alert events carry commercial, biological, or life-safety liability.

### 2. Event Identity & Uniqueness
- **Format:** `UUIDv4` string prefixed by `alrt_` (e.g. `alrt_7c8d9e0f-1234-5678-abcd-ef0123456789`).
- **Uniqueness Guarantee:** Enforced at database level via `PRIMARY KEY` on `alert_audit_log(id)`.

### 3. Tenant/System & Project Attribution
- All alert events are strictly attributed to server-resolved `tenant_id` and `project_id`.
- Alert generation must never infer tenancy from recipient phone numbers or arbitrary client payloads.
- *Open Decision for Kavin (KD-1):* Should cross-organization multi-tenant alert rollups be permitted under an optional `organization_id` column, or must tenant isolation remain strictly single-tenant partitioned? *(Recommended: Dual-scoped with required `tenant_id` and nullable `organization_id`).*

### 4. Source & Actor Identity
- Source system identifier: `bha-cst-engine`.
- Actor: Identifies the trigger component (`vfarm_anomaly_watcher`, `research_twin_evaluator`, `system_tripwire`, or authenticated operator).
- Role: Role of the initiating actor or `system_service`.

### 5. Event Timestamps
- `occurred_at`: Instant when the physical condition or incident trigger was detected (ISO 8601 UTC).
- `rendered_at`: Instant when the template was interpolated into the delivered message body.
- `created_at`: Database commit timestamp (default `CURRENT_TIMESTAMP`).
- Clock drift tolerance: Monotonically ordered; alert timestamps lagging more than 300 seconds are flagged as delayed.

### 6. Event Type & Severity Hierarchy
- **Standard Event Types:**
  - `alert.telemetry.threshold_breach` (e.g., pH, CO2, temperature excursion)
  - `alert.device.connectivity_loss` (gateway or sensor disconnect)
  - `alert.farm.critical_health_downgrade` (farm status degraded)
  - `alert.escalation.human_requested` (operator assistance requested)
  - `alert.security.unauthorized_attempt` (tamper/tripwire trigger)
- **Severity Levels:** `INFO` | `WARN` | `CRITICAL` | `LIFE_SAFETY`.

### 7. Payload Schema & Versioning
- Follows CloudEvents / CST Event Specification v1:
  - `specversion`: `"cst.event.v1"`
  - `type`: String matching event type taxonomy
  - `data`: Typed alert payload with mandatory rendered body hash (`sha256(rendered_body)`)
- Schema evolution: Non-breaking additions only. Version bump required if fields are removed.

### 8. Correlation & Causation IDs
- `correlation_id`: Root trace identifier (e.g., originating Twilio Call SID, Web turn ID, or vFarm incident UUID).
- `causation_id`: Direct upstream message or trigger ID that provoked the alert.
- Persisted across all joined tables (`messages_out`, `alert_audit_log`, `escalations`).

### 9. Idempotency & De-duplication
- Natural de-duplication key: `sha256(tenant_id + incident_id + alert_type + recipient_phone)`.
- Re-transmissions within a configurable suppression window (default 15 minutes) do not send duplicate SMS/calls, but append an audit de-duplication event.

### 10. Audit Immutability & Retention
- **Immutability:** No `UPDATE` or `DELETE` grants on `alert_audit_log` in production runtime. Records are write-once, append-only.
- **Rendered Body Retention:** Hybrid pattern per ADR-0001:
  - Rendered body is stored at write time, capped at 65,536 bytes (`ALERT_AUDIT_MAX_BYTES`).
  - Standard retention TTL: 90 days (`expires_at = created_at + 90 days`).
  - *Open Decision for Kavin (KD-2):* Should compliance/regulatory alerts retain rendered bodies for 1 year (365 days) while operational warnings expire after 90 days? *(Recommended: Variable TTL based on severity: 90 days for WARN, 365 days for CRITICAL/LIFE_SAFETY).*

### 11. Delivery & Retry Semantics
- Delivery states: `pending` -> `dispatched` -> `delivered` | `failed` | `undelivered`.
- Exponential backoff with jitter: 10s, 30s, 90s (max 3 attempts).
- Retries must never re-render a new body; they must replay the identical rendered body to prevent transcript drift.

### 12. Escalation Lifecycle
- When severity is `CRITICAL` or `LIFE_SAFETY`, an escalation record is durably written to `escalations` table before initiating external notifications.
- Slack channel notification is dispatched asynchronously with non-sensitive metadata (phone masked).

### 13. Privacy & Sensitive-Field Handling (Write-Time Masking)
- **Write-Time Masking Invariant:** Sensitive fields (`token`, `authorization`, `api_key`, `secret`, `password`, `webhook_url`) are stripped recursively *before* database insertion.
- `masked_at` is set to current timestamp if secrets were detected and stripped.
- Recipient phone numbers in logs and notifications are masked (`+9230****3844`), while raw E.164 numbers are stored exclusively in restricted DB columns with RBAC protection.

---

## 3. Decision

1. **Adopt the Hybrid Rendered-Body Audit Pattern:** Store full rendered bodies up to 64 KiB with write-time secret masking and variable TTL retention.
2. **Standardize Schema on `cst.event.v1`:** All alert audit events will conform to the unified envelope contract.
3. **Pending Kavin Approval:** Finalize decisions KD-1 (multi-tenant rollup) and KD-2 (severity-tiered retention) during the upcoming architecture sync.

---

## 4. Alternatives Considered

- **Alternative A: Template Replay Only (Store only template_id + params):**
  - *Rejected:* Template wording changes over time. Regulatory audits require proof of what was *actually* sent to the human operator at 02:00 AM, not what today's template produces.
- **Alternative B: Indefinite Raw Storage:**
  - *Rejected:* PII exposure risk and database bloat.

---

## 5. Security & Migration Implications

- **Security:** Write-time masking protects against SQL dump leaks and unauthorized database inspections.
- **Migration:** Schema already matches `alert_audit_log` in Migration 008. No database downtime or schema migration needed.
- **Compatibility:** Backwards-compatible with existing `AlertAuditLog.write(...)` implementation in `engine/src/audit/alert_audit.ts`.

---

## 6. Acceptance Tests

1. `AlertAuditLog.write` strips secrets at write time and populates `masked_at`.
2. Oversized message bodies (>64 KiB) are cleanly truncated and set `truncated = true`.
3. Alerts carrying mismatched `tenant_id` fail closed with security audit tripwires.
4. Retention pruner prunes only rows where `expires_at <= NOW()`.

---

## 7. Sign-Off & Status

- **Proposed By:** Ahad (CST Engineering) — 2026-11-03
- **Reviewed By:** Pending Kavin Review
- **Final Classification:** `PROPOSED_PENDING_KAVIN_APPROVAL`

