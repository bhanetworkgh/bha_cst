# Commissary Ops Twin Client 2 Intake & Site Specification Evidence Package

**Loop ID:** `LOOP-1791922936305-VU6R`  
**Status:** In Progress  
**Lane:** CST  
**Assignee:** Ahad (`U0AC6RFNP3P`)  
**Raised By:** Jason Bays  
**Date of Evidence:** 16 November 2026  
**Repository:** `bhanetworkgh/bha_cst`  
**Working Branch:** `fix/3nbe-burn-in-cabinet-sensor-diagnostic`  
**Related Client Card:** `CARD-1791918264578-MTUW` (Audits 2015, 2016, 2017)  
**Related Research Jobs:**  
- `JOB-1791920562929-V1R8` (Resolved 13 October 2026 — General industry research)  
- `JOB-1791920840073-BKPU` (Active — Utica/Oneida County Log Format Requirement)  
**Related Decision Watches:**  
- `DW-1793290384075-UDZG` (Destiny Arupi — Outcome owner: Commissary Form 2 & Link)  
- `DW-1793342080834-M7GY` (Jeganathan — Technical review: Section 1 site/survey schema)  
**Build Pattern Name:** `Form 2 — Commissary Ops Twin Site Spec v1`  
**Hardik's Draft Google Doc:** [Form 2 Commissary Ops Twin — Site Specification Questionnaire v1.0 (30 Oct 2026)](https://docs.google.com/document/d/1Np44B_OikY0oGDuftZYjgX9pHoR3Qg4W/edit)  

---

## 1. Executive Summary & Directive Reconciliation

### 1.1 Original Loop vs. Updated Jason Directive
- **Original Loop Scope:** Proposed a 45–60 minute unstructured working session with Client 2 to validate the v0 Commissary Ops Twin design assumptions.
- **Updated Jason Directive:** Shifted execution away from an unstructured working session to an institutionalized, reusable **Form 2 / Site Specification questionnaire** modeled directly on the proven vFarm Form 2 pattern.
- **Reconciliation Outcome:** CST engineering has implemented the reusable contract, schema validation, append-only cryptographic event ledger, and configuration mapping in code (`engine/src/contracts/commissary_ops_twin.ts`), verified via 11 automated unit/integration tests (`tests/contracts/commissary_ops_twin.test.ts`), while preserving Client 2's confirmed workflow without requiring repetitive client meetings.

### 1.2 Status Distinction Matrix (Anti-Fabrication Boundary)
To ensure absolute truth in reporting, every aspect of this delivery is classified by its actual state:

| Component | Status | Owner | Evidence Reference |
|---|---|---|---|
| **CST Contract & Schema** | **Implemented & Tested** | Ahad (CST) | `engine/src/contracts/commissary_ops_twin.ts`, 11/11 tests passing |
| **Questionnaire Specification** | **Drafted & Formalized** | Hardik / CST | 5-section specification in this report & Hardik Google Doc |
| **Section 1 Technical Review** | **Pending Review** | Jegan | `DW-1793342080834-M7GY` |
| **Build Pattern v1 Formalization** | **Specified & Ready** | Destiny | `DW-1793290384075-UDZG` |
| **Private Dashboard Form** | **Specified / Handoff Ready** | Destiny | Section 4 of this report (Handoff package) |
| **Live Intake Link for Client 2** | **Pending Publication** | Destiny | URL awaiting dashboard deployment; **NOT SENT TO CLIENT** |
| **Client 2 Confirmed Answers** | **Recorded & Preserved** | Client 2 / Jason | `CARD-1791918264578-MTUW` (Audits 2015, 2016, 2017) |
| **Utica/Oneida County Log Format** | **Verification Required** | Research Twin | `JOB-1791920840073-BKPU` (`VERIFICATION REQUIRED`) |
| **Loop VU6R Overall Status** | **IN PROGRESS** | Ahad | External approvals and form publication pending |

---

## 2. Client 2 Confirmed Workflow & Card Reconciliation

Per `CARD-1791918264578-MTUW` (Audits 2015, 2016, and 2017), the following client answers are established facts and must not be re-queried:

1. **Bookings:** Online bookings only; hourly office-share style.
2. **Access Control:** Personal card-swipe access, programmed through the same online registration/onboarding flow.
3. **Cleaning & Exit:** Tenants must use the mobile application and complete an exit checklist before checkout.
4. **Health Department:** Client has not yet formally met with the county and will align with its operational requirements.
5. **Core Evidence Requirement:** The client's verbatim demand is:  
   > *"I need time stamped photo evidence of everything."*

Under Audit ID 2017, the `missing_research_questions` field was narrowed strictly to the remaining county log-format requirement tracked under `JOB-1791920840073-BKPU`.

---

## 3. Five-Section Questionnaire Specification

The reusable questionnaire adapts the vFarm Form 2 pattern to commercial kitchens across 5 modular sections:

### Section 1 — Kitchen Layout and Site Requirements
- **Facility Identification:** `facility_address` (string), `site_id` (string), `square_footage` (number, sq ft).
- **Kitchen Layout & Zones:** `layout_zones` (array of `{ zone_id, name, food_grade_certified, max_occupancy }`).
- **Prep Areas:** `prep_areas` (array of strings, e.g. Cold Prep, Hot Line, Baking, Wash Station).
- **Equipment Placement Map:** `equipment_placement_map_url` (optional URL to CAD/PDF layout).
- **Power & Electrical:** `electrical_specs` (`voltage`, `phase` ['single_phase' | 'three_phase'], `total_amps`, `generator_backup` [boolean]).
- **Water Supply & Drainage:** `water_drainage_specs` (`potable_water_psi`, `grease_trap_capacity_gallons`, `floor_drains_count`, `backflow_preventer_certified`).
- **Network & Connectivity:** `network_connectivity` (`primary_uplink` ['fiber' | 'cable' | 'dsl' | 'fixed_wireless'], `wifi_ssid`, `cellular_backup_available`, `local_lan_subnet`).
- **Environmental Baseline:** `environmental_specs` (`ambient_temp_target_c`, `relative_humidity_target_percent`, `hvac_air_turnover_per_hr`, `pest_control_contract_active`).
- **Hardware/Installation Requirements:** `hardware_installation_reqs` (e.g. wall-mount RFID readers, environmental sensor nodes).

*Technical Alignment Note:* Section 1 schema is submitted to Jeganathan under `DW-1793342080834-M7GY` to ensure 100% field, unit, and ID compatibility with the vFarm Site Survey standard.

### Section 2 — Booking, Handover, and Cleaning Operations
- **Online Hourly Booking:** `booking_mode` (`online_hourly_share`), `booking_system_url`, `min_booking_hours`, `max_booking_hours`, `booking_buffer_minutes` (turnaround buffer).
- **Card-Swipe Access & Onboarding:** `access_method` (`card_swipe_onboarding_tied`), `card_swipe_system_provider`, `checkin_grace_minutes`, `checkout_grace_minutes`.
- **Tenant Exit Checklist:** `tenant_app_exit_checklist_required` (`true`), `exit_checklist_template_id`.
- **Late Departure & Overlap Policies:** `late_departure_penalty_rate_cents_per_minute`, `dispute_handling_procedure`.
- **Operator Intervention:** `operator_override_rules` (conditions under which an operator can manually unlock doors or override station state).

### Section 3 — Equipment, Staffing, and Responsibilities
- **Equipment Inventory & Ownership:** `equipment_inventory` (array of `{ equipment_id, name, serial_number, owner ['operator' | 'tenant'], sanitation_frequency }`).
- **Division of Responsibilities:**
  - `operator_responsibilities`: Preventive equipment maintenance, deep grease-trap pumping, access credential management.
  - `tenant_responsibilities`: Active session food-contact surface sanitation, trash removal, mandatory timestamped photo exit logging.
  - `sanitation_duties`: Food-contact surfaces (`tenant_mandatory`), deep cleaning common drains (`operator_managed`), waste disposal (`tenant_mandatory`).
- **Access Administration & Escalation:** `access_administrators` (authorized keycards/provisioners), `incident_escalation_contacts` (role, name, emergency phone), `staff_roles_authorized`.

### Section 4 — Health Inspection and Operational Records
- **Health Authority Jurisdiction:** `health_department_jurisdiction`, `local_authority_name` (`Utica / Oneida County Health Department`).
- **County Log-Format Determination Status:**  
  `county_log_format_determination`: **`VERIFICATION REQUIRED — NOT AN OFFICIALLY CONFIRMED REGULATORY DETERMINATION`**
- **Recordkeeping Boundaries:**
  - `onsite_waterproof_log_required`: boolean (unconfirmed pending county verification).
  - `digital_ledger_accepted_provisionally`: boolean (`true`).
  - `food_contact_surface_sanitation_mandatory`: boolean (`true`).
  - `photo_evidence_requirement`: string (`timestamped_photos_every_visit`).
  - `photo_sampling_policy`: string (`every_visit_mandatory` — no sampling; 100% of visits require photos).
  - `timestamp_drift_tolerance_seconds`: integer (`300` seconds / 5 minutes maximum allowable drift between client device clock and server clock).
  - `retention_period_days`: integer (`730` days / 2 years minimum audit retention).
  - `regulatory_research_job_ref`: `JOB-1791920840073-BKPU`.

### Section 5 — Ownership, Commercial Model, and Pilot Goals
- **Entities & Operating Structure:** `facility_owner` (Oneida Commercial Holdings LLC), `facility_operator` (Utica Kitchen Collective).
- **Commercial & Billing Model:** `tenant_customer_model` (`hourly_office_share`), `ops_twin_fee_payer` (`operator_pays` | `bha_bundled` | `hybrid_cost_share`).
- **Deposits & Disputes:** `cleaning_deposit_cents`, `cleaning_dispute_fee_cents`.
- **Pilot Scope & Success Criteria:**
  - `pilot_start_date`, `pilot_end_date`.
  - `success_criteria`: Zero unresolved sanitation disputes in 90 days; 100% compliance with exit photo timestamps; clean regulatory audit with digital ledger export.
  - `contract_assumptions_approved`: boolean (retains explicit separation between draft assumptions and final executed legal terms).

---

## 4. Reusable Build Pattern Specification

**Build Pattern Identifier:** `Form 2 — Commissary Ops Twin Site Spec v1`  
**Purpose:** Standardizes commercial kitchen intake across all BHA Commissary Ops Twin deployments.  
**Relationship to Intake-2:** Serves as the mandatory site-specification questionnaire under the non-optional Intake-2 lifecycle.  
**Runtime Configuration Mapping:** Implemented in `mapForm2ToOpsTwinConfig()`:
- Maps intake answers directly into Ops Twin state machine parameters, zone configurations, equipment IDs, and verification thresholds.
- Tracks **Data Provenance**:
  - `client_confirmed_fields`: Flags facts confirmed by Client 2 on `CARD-MTUW`.
  - `independently_verified_fields`: Flags cryptographically enforced mechanisms (e.g. SHA-256 chaining, fail-closed READY gate).
  - `pending_approvals`: Explicitly tracks open gates for Jegan's review (`M7GY`), Destiny's pattern sign-off (`UDZG`), and County regulatory determination (`BKPU`).

---

## 5. State Machine Lifecycle & Cryptographic Ledger Engine

### 5.1 Confirmed State Transitions
```
[BOOKED] ──(access.check_in)──> [IN_USE] ──(cleaning.claim_submitted)──> [CLEANED_CLAIMED]
   │                                                                           │
   │                                                         ┌─────────────────┴─────────────────┐
   │                                                         ▼                                   ▼
   │                                                (verification.passed)               (verification.failed)
   │                                                         │                                   │
   ▼                                                         ▼                                   ▼
[NOT_READY] <────────────(incident / dispute / failure)─────── [READY]                        [NOT_READY]
```

### 5.2 Strict Verification Gates (CLEANED_CLAIMED Never Auto-Grants READY)
Under `transitionOpsTwinState()`, moving to `READY` requires passing every one of the following gates:
1. **Checklist Completeness:** All checklist items must be marked completed.
2. **Food-Contact Sanitation Gate:** All items flagged `is_food_contact_surface: true` must be specifically completed and verified.
3. **Mandatory Photo Count:** At least one valid photo evidence item must be attached.
4. **Photo Timestamp Drift Check:** Photo `captured_at` timestamp must be within 300 seconds (5 minutes) of the transition occurrence time. Drifts > 300s fail closed to `NOT_READY`.
5. **No Active Incidents:** If damage or equipment left running is reported, transition routes immediately to `NOT_READY`.

### 5.3 Cryptographic SHA-256 Event Chaining
Every event is appended to an immutable, cryptographically chained event ledger:
$$\text{event\_hash} = \text{SHA256}(\text{event\_id} \parallel \text{sequence} \parallel \text{tenant\_id} \parallel \text{booking\_id} \parallel \text{actor\_id} \parallel \dots \parallel \text{previous\_event\_hash})$$
- Historical events cannot be overwritten or deleted.
- Corrections and failed verifications are appended as new distinct events with incremented sequence numbers.

---

## 6. Regulatory Research Handoff (`JOB-1791920840073-BKPU`)

### 6.1 Regulatory Scope & Grounding
- **Jurisdiction:** Utica / Oneida County Health Department; New York State Department of Health (NYSDOH).
- **Applicable Regulatory Code:** New York State Sanitary Code, Chapter I, Subpart 14-1 (Food Service Establishments), conforming to US FDA Food Code principles.
- **Statutory Review:** NYSDOH Subpart 14-1 does not explicitly prohibit electronic recordkeeping for daily sanitation, temperature, or cleaning checklists, provided records:
  1. Are readily retrievable during an unannounced inspection.
  2. Are tamper-evident and demonstrate reliable timestamping.
  3. Can be immediately printed or viewed by the sanitarian.
- **County Enforcement Discretion:** Local sanitarians in Oneida County hold discretionary authority regarding acceptable onsite log formats. Some jurisdictions require a physical waterproof-ink log mounted directly adjacent to dishwashing or food prep stations.
- **Authoritative Determination:** In strict adherence to anti-fabrication standards, this requirement is formally designated:
  ```
  VERIFICATION REQUIRED — NOT AN OFFICIALLY CONFIRMED REGULATORY DETERMINATION
  ```
- **Handoff Action for Research Twin:** Research Twin owner Destiny Arupi to submit a formal written inquiry to the Oneida County Environmental Health Division (Utica Office) requesting written confirmation of digital log acceptability for commissary kitchen share operations.

---

## 7. Automated Test Execution & Empirical Proof

### 7.1 Vitest Execution Proof
The Commissary Ops Twin contract, schema validation, state machine transitions, failure cases, tamper resistance, and configuration mapping were executed via Vitest:

```bash
npx vitest run tests/contracts/commissary_ops_twin.test.ts
```

**Observed Output:**
```text
 RUN  v4.1.12 /Users/HaMi/Documents/Jason/customer twin

 ✓ tests/contracts/commissary_ops_twin.test.ts (11 tests) 8ms
   ✓ Commissary Ops Twin Form 2 — Schema Validation (Build Pattern: Form 2 — Commissary Ops Twin Site Spec v1) (3)
     ✓ validates a complete, compliant 5-section Form 2 submission 4ms
     ✓ rejects invalid site data (e.g. negative square footage or missing prep areas) 1ms
     ✓ enforces mandatory photo evidence requirement and county regulatory status notice 0ms
   ✓ Commissary Ops Twin — State Machine & Strict Evidence Verification (6)
     ✓ transitions from BOOKED to IN_USE upon access check-in 1ms
     ✓ transitions from IN_USE to CLEANED_CLAIMED, NEVER straight to READY 0ms
     ✓ fails verification and transitions to NOT_READY if required photos are missing 0ms
     ✓ fails verification and transitions to NOT_READY if photo timestamp drift exceeds 300s 0ms
     ✓ fails verification if food contact surface sanitation is uncompleted 0ms
     ✓ transitions to READY when all criteria (complete checklist, food contact verified, valid photos) are met 0ms
   ✓ Cryptographic Event Ledger Chaining & Anti-Tamper Verification (1)
     ✓ computes deterministic SHA-256 event hash matching canonical representation 0ms
   ✓ Ops Twin Configuration Mapping & Provenance Tracking (1)
     ✓ maps Form 2 submission to runtime configuration while tracking provenance and pending approvals 0ms

 Test Files  1 passed (1)
      Tests  11 passed (11)
   Start at  23:32:35
   Duration  180ms
```

### 7.2 Full Repository Typecheck Proof
```bash
npm run typecheck
```

**Observed Output:**
```text
> bha-cst@1.0.0 typecheck
> tsc --noEmit -p engine/tsconfig.json
(exit code 0)
```

---

## 8. Handoffs and Next Actions

1. **Jeganathan (`DW-1793342080834-M7GY`):** Review Section 1 schema and verify field/unit compatibility with vFarm Site Survey standard.
2. **Destiny Arupi (`DW-1793290384075-UDZG`):** Deploy the private dashboard form using the 5-section schema specification, register Build Pattern `Form 2 — Commissary Ops Twin Site Spec v1`, generate the live Client 2 intake link, and advance `JOB-1791920840073-BKPU` with Oneida County.
3. **Ahad Ali (CST Assignee):** Maintain `LOOP-1791922936305-VU6R` as `In Progress` pending Jegan's review, Destiny's form deployment, and Client 2 form submission.

