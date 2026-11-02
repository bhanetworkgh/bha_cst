# ADR — Alert Audit: Store Rendered Body vs Reconstruct/Replay

**Loop:** LOOP-1788044070645-018M  
**Watch:** DW-1793621770574-1G7A  
**Owners:** Ahad, Kavin  
**Status:** IMPLEMENTED_PENDING_OWNER_APPROVAL

## Context
Alerts are generated from templates + source data, delivered via notification channels, retried, and audited. Question: store rendered message body, or reconstruct/replay later?

## Option A — Store rendered bodies
- Exact historical reproducibility: yes
- Audit evidence: strong
- PII exposure: higher (bodies may contain customer data)
- Retention: must define retention + redaction + deletion
- Storage cost: moderate
- Access controls: required

## Option B — Reconstruct/replay
- Template versioning required
- Input snapshot required for determinism
- Dependency changes can break replay
- Missing/changed source data breaks historical reproducibility
- Replay security: must gate access

## Option C — Hybrid (recommended)
Preserve immutable audit-critical delivery evidence (rendered body hash + delivery metadata) while retaining versioned template + input snapshot references for reconstruction. Balances reproducibility, PII exposure, and storage.

## Recommendation
Hybrid: store rendered body hash + delivery outcome + template version + input snapshot reference; store full rendered body only for a defined retention window under access controls. Kavin approval required before implementation.

## Acceptance tests
- Rendered body hash matches delivered body
- Replay produces identical hash for same template+inputs
- Retention/deletion policy enforced
- No cross-tenant body access
- Template version pinned per alert
