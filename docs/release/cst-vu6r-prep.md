# VU6R - Client 2 Commissary Ops Twin Working Session Prep

**Loop:** `LOOP-1791922936305-VU6R`  
**Assignee:** Ahad (`U0AC6RFNP3P`)  
**Related Card:** `CARD-1791918264578-MTUW` (Positive client interest recorded)  
**Research Job:** `JOB-1791920562929-V1R8` (Resolved — industry research supports initial design)  
**Decision Watch:** `DW-1792414988891-UJJ2`  
**SOP Reference:** `b248bd76-efc0-4f32-9c3d-b6f4997fbbca`  
**Target Due Date:** 20 October 2026 (Supplied context reminder: 14:03 Lagos time)  
**Status:** OPEN — LOCAL PREPARATION COMPLETE; CLIENT SOURCE-CHECK & WORKING-SESSION VALIDATION PENDING

---

## 1. Actionable Outreach Message for Jason Bays

Copy-paste this message to Jason in Slack `#cst-ops` or direct message:

```text
Hi Jason,
Regarding LOOP-1791922936305-VU6R (Client 2 Commissary Ops Twin Working Session) due tomorrow (Oct 20):
We have finalized the 45-60 min working session agenda and validation table template covering:
1. Kitchen workflow state machine (BOOKED → IN_USE → CLEANED_CLAIMED → READY / NOT_READY)
2. Append-only cryptographically chained event ledger and dispute/override mechanics
3. The three open design questions:
   - Photo sampling (every visit vs sampled)
   - Billing model (operator pays, BHA bundles, or hybrid)
   - Health-inspector record retention and signature requirements

Could you please confirm:
- Who is the designated point of contact for Client 2?
- Is this working session already scheduled or completed, or do we need to coordinate a slot today?
- Would you like Ahad or Syed to join the session to capture the technical validation criteria?

Full agenda & validation table template ready in docs/release/cst-vu6r-prep.md.
```

---

## 2. Proposed Working Session Agenda (45–60 Minutes)

1. **Bookings (5 min)**:
   - Creation, modification, cancellation triggers.
   - Who can book, required metadata (operator, station ID, expected hours).
2. **Handover (5 min)**:
   - What happens when kitchen responsibility changes between shifts or operators.
   - Evidence required upon handover.
3. **Cleaning Protocol & Photo Sampling (10 min)**:
   - How cleaning is claimed, checked, and challenged.
   - Mandatory evidence: timestamped photos, chemical checklist, operator signature.
   - *Design Question*: Are photos required for every visit or sampled periodically?
4. **State Machine Transitions (10 min)**:
   - Permissions to transition: `BOOKED → IN_USE → CLEANED_CLAIMED → READY / NOT_READY`.
   - Automatic vs manual transitions.
5. **Operational Definitions of READY vs NOT_READY (5 min)**:
   - Concrete criteria making a station ready for the next booking.
   - Defined evidence threshold required before granting `READY`.
   - Fail-safe blocking: does `NOT_READY` physically lock out new bookings?
6. **Health Inspector Compliance & Regulatory Events (10 min)**:
   - Mandatory records for local health authority review.
   - Temperature logs, sanitation records, digital signature verification.
   - *Design Question*: Which applicable municipal licensing/inspection rules affect the ledger's event schema?
7. **Append-Only Signed Ledger (5 min)**:
   - Cryptographically chained event ledger recording actors and timestamps.
   - Dispute resolution, correction records, audit history export.
8. **Commercial Model & Exceptions (5 min)**:
   - *Design Question*: Operator-pays vs BHA-bundled vs hybrid commercial structure.
   - Missed cleaning windows, overlapping bookings, equipment failures, emergency overrides.

---

## 3. Validation Table Template

| Design Assumption | Client Validation Question | Evidence / Real Kitchen Answer | Required Design Change | Owner | Status |
|---|---|---|---|---|---|
| Workflow: `BOOKED → IN_USE → CLEANED_CLAIMED → READY / NOT_READY` | Does this match the physical reality of how your staff and tenants move through the commissary? | | | Ahad | PENDING |
| Append-only signed ledger | Will health inspectors accept digital cryptographic signatures or do they require printed logs? | | | Ahad | PENDING |
| `READY` requires defined evidence threshold | Can a tenant claim cleaned without supervisor sign-off if off-hours? | | | Ahad | PENDING |
| Photo frequency: every visit vs sampled | Are kitchen operators equipped/willing to upload photos after every single shift, or should inspection be sampled? | | | Ahad | PENDING |
| Commercial model: operator vs bundled vs hybrid | Does the commissary operator pay for the Ops Twin platform, does BHA bundle it, or is cost shared? | | | Ahad | PENDING |
| `NOT_READY` blocks next booking | How do you handle emergency booking overrides when a tenant is delayed 15 minutes? | | | Ahad | PENDING |

---

## 4. Acceptance Criteria & Next Action

- **Acceptance Criteria**:
  1. Kitchen operational state machine validated with Client 2.
  2. Health inspection records format and ledger event requirements confirmed.
  3. Resolution of the 3 open design questions (photo sampling, commercial model, licensing events).
  4. Client-specific findings documented and accepted.
- **Immediate Next Action**:
  - Ahad logs source-check findings across internal records and coordinates with Jason Bays regarding Client 2 contact and session scheduling.
  - Do not mark loop closed until client-specific session findings are documented.

---

## 5. Updated Directive Reconciliation (November 2026): Reusable Form 2 / Site Specification Intake

### 5.1 Shift from Unstructured Working Session to Reusable Form 2 Pattern
Jason Bays subsequently updated the execution directive: rather than holding an unstructured working session with Client 2, execute the intake via an institutionalized, reusable **Form 2 / Site Specification questionnaire** patterned after the vFarm Form 2 standard.

### 5.2 Preservation of Client 2 Confirmed Answers (`CARD-1791918264578-MTUW`)
Per client confirmation card `CARD-1791918264578-MTUW` (Audits 2015, 2016, 2017), Client 2 has already confirmed the core workflow:
1. **Bookings:** Online bookings only; hourly office-share style.
2. **Access Control:** Personal card-swipe access, programmed through the same online registration/onboarding flow.
3. **Cleaning & Exit:** Tenants must use the mobile application and complete an exit checklist.
4. **Health Department:** Client has not yet met with the county and will align with its requirements.
5. **Core Evidence Requirement:** *"I need time stamped photo evidence of everything."*

Under Audit ID 2017, the `missing_research_questions` field was narrowed strictly to the county log-format requirement tracked under `JOB-1791920840073-BKPU` (`VERIFICATION REQUIRED — NOT AN OFFICIALLY CONFIRMED REGULATORY DETERMINATION`).

### 5.3 Technical Implementation & Evidence Status
- **Build Pattern:** `Form 2 — Commissary Ops Twin Site Spec v1` (Section 1: Site/Kitchen Layout, Section 2: Operations, Section 3: Equipment & Roles, Section 4: Regulatory Records, Section 5: Commercial Pilot).
- **CST Implementation:** `engine/src/contracts/commissary_ops_twin.ts` implements the complete Zod schema, append-only cryptographic event ledger (`previous_event_hash` -> `event_hash`), fail-closed `READY` state guardrails, and configuration mapping.
- **Verification:** 11/11 tests passing in `tests/contracts/commissary_ops_twin.test.ts`. Full evidence documented in `docs/evidence/2026-11-16-vu6r-commissary-ops-twin-intake.md`.
- **Handoffs:** Section 1 technical review tracked with Jeganathan (`DW-1793342080834-M7GY`); outcome ownership, private dashboard form deployment, and live link generation tracked with Destiny Arupi (`DW-1793290384075-UDZG`).
- **Loop Status:** Strictly **IN PROGRESS** pending external reviews and dashboard form publication.
