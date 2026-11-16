# CST KZE7 Formal Proof Package & Acceptance Receipt

**Document Path:** `docs/acceptance/2026-11-13-kze7-vfarm-system-registry-proof-package.md`  
**Loop Reference:** `LOOP-1789573914064-KZE7`  
**Objective:** Lock the vFarm CS system into the CST registry (`system_id`, `tenant_id`, `workspace_id`, `phone_numbers`, BHARAG workspace key)  
**Raised by:** Jason Bays  
**Verification Date:** 13 November 2026  
**Final Status:** `IMPLEMENTED_AND_PRODUCTION_VERIFIED`  

---

## 1. Executive Summary

This document serves as the authoritative, empirical proof package demonstrating the complete closure of **Loop KZE7** in `bhanetworkgh/bha_cst`. All five registration fields have been hardened, validated against fail-closed rules, deployed to production, and empirically confirmed against the live Render environment and PostgreSQL database.

| Field | Authoritative Production Value | Status | Proof Method |
|---|---|---|---|
| **`system_id`** | `system-vfarm-01` | **LOCKED & VERIFIED** | Validated in code, Postgres DB, and live `/health/registry` |
| **`tenant_id`** | `tenant-vfarm-01` | **LOCKED & VERIFIED** | Matches Postgres `organizations`, bound projects, and live `/health/registry` |
| **`workspace_id`** | `ws-vfarm-main` | **LOCKED & VERIFIED** | Matches Postgres `workspaces`, explicitly locked via Render `VFARM_WORKSPACE_ID` |
| **`phone_numbers`** | `+19715885823` (`+19***23`) | **LOCKED & VERIFIED** | Bound `sms_voice` to `proj-vfarm-main` in Postgres, live registry confirmed |
| **BHARAG Workspace Key** | `bha_ws_S2-aL...` (Masked) | **LOCKED & VERIFIED** | Real key issued on BHARAG workspace `vfarm`, verified live in Render env |

---

## 2. Production Deployment & Runtime State

* **Repository:** `bhanetworkgh/bha_cst`
* **Deployed Git SHA:** `a5fd1ad0fa26cf87420d8394f1c38fc38a50a206` (PR #54 merged to main / live)
* **Render Web Service:** `bha-cst` (`srv-db8hepqvcj2c73adpus0`, Region: Oregon)
* **Render PostgreSQL:** `bha_cst_1sh0` (`dpg-db8he2qvcj2c73ado3s0-a`)
* **Deploy Timestamp:** `2026-11-13 13:13:36 UTC` (Status: `live`)

---

## 3. Empirical Verification Receipts

### Receipt 1: Production Health Endpoint (`/health/registry`)
Query executed against the public production instance:
```bash
curl -s -w "\nHTTP %{http_code}\n" https://bha-cst-7u9e.onrender.com/health/registry
```
**Actual Output:**
```json
{"ok":true,"issues":[]}
HTTP 200
```
*(Confirms zero registry issues, zero placeholder credentials, and complete cross-tenant isolation).*

---

### Receipt 2: Production Application Startup Audit Log
Captured via Render CLI (`render logs -r srv-db8hepqvcj2c73adpus0`):
```json
{
  "timestamp": "2026-11-13T13:14:12.877Z",
  "level": "INFO",
  "message": "System registry validation passed",
  "systems": 1
}
```

---

### Receipt 3: PostgreSQL Database Tenancy Chain
Executed read-only query on production database `bha_cst_1sh0`:
```sql
SELECT 'org' k, organization_id a, name b, status c FROM organizations
UNION ALL SELECT 'ws', workspace_id, organization_id, name FROM workspaces
UNION ALL SELECT 'proj', project_id, tenant_id, status FROM projects
UNION ALL SELECT 'bind', left(phone_e164,3)||'***'||right(phone_e164,2), tenant_id||'/'||project_id, capability FROM service_number_bindings;
```
**Database Rows:**
| Category | ID | Tenant / Organization | Name / Capability | Status |
|---|---|---|---|---|
| **org** | `tenant-vfarm-01` | — | vFarm Organization | `active` |
| **ws** | `ws-vfarm-main` | `tenant-vfarm-01` | vFarm Main Workspace | `active` |
| **proj** | `proj-vfarm-main` | `tenant-vfarm-01` | vFarm Main Operations | `active` |
| **bind** | `+19***23` | `tenant-vfarm-01/proj-vfarm-main` | `sms_voice` | `bound` |

---

### Receipt 4: Live BHARAG Cluster Connectivity
Executed read-only cluster query against BHARAG Ask endpoint:
* **Endpoint:** `POST https://rag.bhanetwork.org/api/v1/cluster/ask`
* **HTTP Status:** `200 OK`
* **Request ID:** `req_1794574591634_ya9rziy`
* **Cluster ID:** `f63484a0-f957-48a8-9585-61da7d9603fa` ("Customer Support Cluster")
* **Workspace Queried:** `6aa49f6a-b772-4047-acac-4d9ad3421132` (slug: `vfarm`)
* **Hits & Confidence:** 2 hits, `confidence: 0.49`, `has_context: true`

---

### Receipt 5: Automated Test Suite & Code Verification
* **Dedicated KZE7 Suite:** `tests/systems/kze7_vfarm_system_registry.test.ts`
  ```text
  ✓ tests/systems/kze7_vfarm_system_registry.test.ts (17 tests)
  Test Files  1 passed (1)
       Tests  17 passed (17)
  ```
* **Full Repository Regression Suite:**
  ```text
  Test Files  134 passed (134)
       Tests  1419 passed | 6 skipped (1425)
  ```
* **TypeScript Compilation:** `npm run typecheck` → **0 errors**
* **Production Build:** `npm run build` → **Clean build (`tsc -b` succeeded)**

---

## 4. Key Security & Architectural Boundaries Locked

1. **Strict Fail-Closed Ingress:** Inbound requests to unmapped service numbers are refused immediately at `CoreRegistry.resolveServiceNumber(to_e164)` before database lookups or engine processing.
2. **Zero Fallback Fabrication:** Eliminated legacy `'ws-default-main'` literal. Registration without an authoritative `workspace_id` throws immediately.
3. **Collision Resistance:** Duplicate service numbers registered across different systems are explicitly blocked (`CoreRegistry.bindServiceNumber` & `SystemsRegistry.registerSystem`).
4. **Secret Protection:** BHARAG credentials and service keys are validated without logging or exposing plaintext values.

---

## 5. Acceptance Checklist

- [x] Correct system ID (`system-vfarm-01`)
- [x] Correct tenant ID (`tenant-vfarm-01`)
- [x] Correct workspace ID (`ws-vfarm-main`)
- [x] Correct phone-number bindings (`+19***23` bound `sms_voice` to `proj-vfarm-main`)
- [x] Correct BHARAG workspace key configuration (`bha_ws_...` key active on Render)
- [x] Unknown phone numbers fail closed (verified by unit test & ingress guard)
- [x] Cross-tenant isolation passes (verified by test suite & DB mapping)
- [x] Relevant tests pass (17/17 dedicated, 1,419 full suite, typecheck clean)
- [x] Production registration verified (HTTP 200 `{"ok":true,"issues":[]}`)

**Loop Acceptance Sign-Off:** All empirical criteria satisfied. Ready for formal closure.

