# MPMD Part A — CST/Genie Source Field Mapping

**Owners:** Ahad (CST/Genie), Jegan (remaining systems)  
**Loop:** LOOP-1791317275796-MPMD  
**Evidence:** EV-1793600858856-PT9J  
**Watch:** DW-1793619895309-KUQN

## Status
Repository inspected. CST/Genie source-of-truth for transition/approval fields is not fully present in this repo; many fields require Jegan's system confirmation (`EXTERNAL_SCHEMA_CONFIRMATION_REQUIRED`).

## Transition fields

| Field | Source (CST) | Exact field | Type | Nullability | Producer | Consumer | Evidence | Gap |
|---|---|---|---|---|---|---|---|---|
| from_state | conversations/messages state machine (not verified in repo) | TBD | string | required | CST turn handler | Genie | NOT FOUND in codebase | EXTERNAL_SCHEMA_CONFIRMATION_REQUIRED (Jegan) |
| to_state | same | TBD | string | required | CST turn handler | Genie | NOT FOUND | EXTERNAL_SCHEMA_CONFIRMATION_REQUIRED |
| run_id | correlation_id (existing) | correlation_id | string (uuid) | required | CST request handler | Genie/audit | engine/src/core/envelope.ts | none |
| incident_id | BHARAG incident ref | incident_id | string | optional | BHARAG | CST/Genie | engine/src/connectors/bharag_rag.ts | contract unverified |
| lane_id | TBD | TBD | string | optional | RT | CST/Genie | NOT FOUND | EXTERNAL_SCHEMA_CONFIRMATION_REQUIRED |
| handler_id | speaker_ref / user_id | speaker_ref | string | required | CST identity | Genie | engine/src/core/types.ts | none |

## Approval fields

| Field | Source | Exact field | Type | Nullability | Producer | Consumer | Gap |
|---|---|---|---|---|---|---|---|
| approver_id | vFarm org member user_id | user_id | string | required for approval | human approver | CST/Genie | contract unverified |
| approved_at | vFarm grant granted_at | granted_at | timestamptz | required for approval | vFarm | CST/Genie | contract unverified |

## Approval invariants
- named human approval only
- Jason approval for pay-eligible changes
- lane-owner approval for lane closure
- no self-approval
- machines never write human approval decisions
- autopay_enabled stays false
- pay remains recommendation until human approval exists

## Handoff to Jegan
Provide: remaining per-system mappings (RT, Logstream, loops, incidents), exact table/column names, types, nullability, writers/readers. CST/Genie will consume existing source; no duplicate source of truth.
