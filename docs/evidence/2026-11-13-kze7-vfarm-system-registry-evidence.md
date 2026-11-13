# KZE7 — vFarm System Registry Evidence

Loop: `LOOP-1789573914064-KZE7` · Date: 2026-11-13 · Repo: `bhanetworkgh/bha_cst`
Branch `feature/pbt5-elevenlabs-voice-observability`, HEAD `f5951a3c43da5187ef5f0f70c9fbf013cc09bde6`.
Working tree was already dirty (15 modified, ~30 untracked files from other loops). Nothing was reset, stashed, committed, or switched. Only the files listed below were touched by KZE7.

## 1. Existing implementation (before this change)

| Step | Source | Behaviour |
|---|---|---|
| Config | `engine/src/config/env.ts` | `VFARM_SYSTEM_ID`, `VFARM_TENANT_ID`, `VFARM_SYSTEM_NAME`, `VFARM_PHONE_NUMBERS`, `BHARAG_WORKSPACE_KEY` are required (`min(1)`). It falls back to `.env.example` if `VFARM_SYSTEM_ID` is unset, and that file holds placeholders (`+1XXXXXXXXXX`, `your_bharag_workspace_key_here`). Those pass `min(1)`. |
| System registry | `engine/src/systems/registry.ts` `SystemsRegistry` | `buildDefaultSystems()` builds the vFarm system from env. `workspace_id` = `VFARM_WORKSPACE_ID` or the tenant id. `registerSystem()` filled a missing workspace with the fabricated `'ws-default-main'`. It accepted a duplicate number across systems, last writer winning. It did not check that `system_id` or tenant was present. |
| Phone → binding (tenancy authority) | `engine/src/core/registry.ts` `CoreRegistry.resolveServiceNumber(To)` | Returns the `service_number_binding` (tenant, project, capability) or null. `bindServiceNumber` already refuses collisions and cross-tenant projects. |
| Voice ingress | `engine/src/transport/voice/voice_lane.ts` `processVoiceTurn` | No binding → refused. No `SystemsRegistry` entry for the number → refused. `system.tenant_id !== binding.tenant_id` → refused (conflict). The binding is authoritative. |
| SMS outbound | `engine/src/transport/twilio/outbound.ts` | Binding-based sender. `SystemsRegistry` used as a deny-only cross-tenant probe. |
| BHARAG context | `engine/src/router/index.ts:418` passes `systemConfig.bharag_workspace_key` to `bharag_rag.ts`, which falls back to `env.BHARAG_WORKSPACE_KEY` and logs only a masked key. |
| Production tenancy | `CoreRegistry.initFromDb()` loads tenants, projects and bindings from Postgres. Dev fixtures are seeded only when `NODE_ENV !== 'production'` and the DB is empty. |
| Startup / health | `server.ts` awaited `initFromDb` and `whenPersisted`. There was **no** registry consistency validation. `/health` is static `ok`. |

Existing tests that already cover parts of this: `tests/isolation/test3_unknown_number`, `test8_outbound_cross_tenant`, `test9_org_workspace_isolation`, `tests/tenancy/*`.

## 2. Gaps found

1. `'ws-default-main'` fabricated workspace fallback.
2. No refusal of duplicate number ownership across systems.
3. No refusal of a missing `system_id` or tenant.
4. No check that the registered numbers, tenant and workspace agree with the DB-backed bindings and tenants.
5. No detection of placeholder BHARAG key or phone values in production.

## 3. Files changed (KZE7 only)

- `engine/src/systems/registry_validation.ts` (new): pure validator and key classifier. It reports the BHARAG key as `configured` / `placeholder` / `missing` plus a masked form, and masks numbers.
- `engine/src/systems/registry.ts`: `registerSystem` now throws on a missing system id, tenant or workspace, and on a number already owned by another system (the original owner is kept). The `ws-default-main` fallback is removed. Added `SystemsRegistry.validateConfiguration()`.
- `engine/src/app.ts`: new `GET /health/registry` returns 200 when valid and 503 otherwise. In production it returns only the verdict and issue codes.
- `engine/src/server.ts`: logs the validation result at startup. It logs error codes only and does not exit.
- `tests/systems/kze7_vfarm_system_registry.test.ts` (new, 17 tests).

Note: `engine/src/core/registry.ts` and `engine/src/config/env.ts` were already modified by other work and were not touched.

## 4. Verified identifiers (safe values)

Local validation of the env-built registry (`/health/registry` logic, run against `.env` + dev fixtures):

| Field | Value | Result |
|---|---|---|
| system_id | `system-vfarm-01` | present; matches `.env.example` and `voice_router.ts` |
| tenant_id | `tenant-vfarm-01` | registered in CoreRegistry; equals binding tenant |
| workspace_id | `tenant-vfarm-01` | **derived from the tenant** (`VFARM_WORKSPACE_ID` unset, warning). The project (`proj-vfarm-main`) is the real security boundary. |
| phone_numbers | `+19***23` (1 number) | bound `sms_voice` → `tenant-vfarm-01` / `proj-vfarm-main` |
| BHARAG workspace key | classified `configured`, masked | present and not a placeholder pattern. This is **not** proof that BHARAG accepts it. |

Local state is a dev/test fixture, so it does not prove production state.

## 5. Configuration dependencies (not invented; owner action)

- Production `service_number_binding` rows and tenant/project rows in Postgres (owner: CST admin / Jason).
- `VFARM_SYSTEM_ID`, `VFARM_TENANT_ID`, `VFARM_PHONE_NUMBERS`, `BHARAG_WORKSPACE_KEY` in the Render env (owner: CST ops).
- `VFARM_WORKSPACE_ID`: **no authoritative workspace id is documented.** Owner decision required: set it explicitly or formally accept the tenant-derived value. `render.yaml` declares the key.
- A BHARAG-issued, workspace-scoped key (owner: BHARAG). Live acceptance can only be proven by BHARAG or a read-only authenticated call.
- Risk: `env.ts` loads `.env.example` placeholders if `VFARM_SYSTEM_ID` is unset. The new validator flags placeholders as errors via `/health/registry`.

## 6. Tests and results

- New suite: 17/17 pass. It covers system, tenant and workspace resolution, phone routing, unknown number rejection, duplicate number, missing system id, missing tenant/workspace, missing and placeholder BHARAG key, cross-tenant and cross-workspace isolation, multiple systems, and config validation.
- Full suite: `npx vitest run` → **134 files passed, 1419 tests passed, 6 skipped, 0 failed.**
- `npm run typecheck`: clean. `npm run build`: succeeded.

## 7. Production evidence (Render CLI v2.30.0, read-only, 2026-11-13 ~17:37 PKT)

Account `admin@bhanetwork.org`. Service `bha-cst` (`srv-db8hepqvcj2c73adpus0`, `https://bha-cst-7u9e.onrender.com`). Only list, GET and SELECT calls were made. No env vars, deploys or rows were modified. No secret was printed.

- **Deployed SHA:** latest deploy `live`, commit `f5951a3c43da5187ef5f0f70c9fbf013cc09bde6` (2026-11-11 16:11 UTC, PR #53). This is the same SHA as local HEAD, so it **does not contain the KZE7 changes**. `GET /health` → 200. `GET /health/registry` → 404 (confirms the change is not deployed).
- **Production DB** (`bha_cst_1sh0`, read-only SELECTs, numbers masked):

| Table | Result |
|---|---|
| organizations | `tenant-vfarm-01`, active |
| workspaces | `ws-vfarm-main` → `tenant-vfarm-01` ("vFarm Main Workspace") |
| projects | `proj-vfarm-main` (active, voice true), `proj-vfarm-dallas` (active, voice false), both under `tenant-vfarm-01` |
| service_number_bindings | `+19***23` → `tenant-vfarm-01/proj-vfarm-main`, `sms_voice`, **bound**. `+19***24` → `proj-vfarm-dallas`, `sms`, **unbound**. |
| systems | `system-vfarm-01`, tenant `tenant-vfarm-01`, active, **workspace_id NULL, 0 phone numbers, BHARAG key empty (len 0)** |

- **Findings:**
  - The tenant, project, binding and workspace chain is consistent in the DB.
  - The authoritative workspace id is `ws-vfarm-main`.
  - The persisted `systems` row is stale. Its insert is `ON CONFLICT DO UPDATE` for voice fields only, so the row was never refreshed. It is not used for routing (the runtime registry is built from env), but it is wrong.
  - The runtime `workspace_id` is `VFARM_WORKSPACE_ID` if set. Otherwise it is the tenant id, not `ws-vfarm-main`. Whether the Render env sets it is **unverified**, because the CLI cannot read env vars and the dashboard was not used.
- **Logs:** recent refusals are Twilio signature failures and outbound blocks. The log filter returned nothing about unknown-number routing.

### Still unverified in production
- Live registry output (needs the KZE7 deploy and `/health/registry`).
- Whether the Render env has `VFARM_WORKSPACE_ID`, `VFARM_PHONE_NUMBERS` and `BHARAG_WORKSPACE_KEY` set and non-placeholder.
- BHARAG acceptance of the key.
- A live unknown-number routing test. This was not attempted because Twilio-signed traffic would be needed.

## 8. Blockers

- KZE7 code not deployed; `/health/registry` returns 404 in production.
- Persisted `systems` row is stale (workspace NULL, no phones, no key); a one-time owner fix is needed.
- `workspace_id` is defined in the DB (`ws-vfarm-main`) but the runtime does not use it unless `VFARM_WORKSPACE_ID=ws-vfarm-main` is set in Render (owner decision).
- Changes are uncommitted and undeployed, as required by this task.

## 9. Acceptance checklist

- [x] System ID: `system-vfarm-01` (local and production DB)
- [x] Tenant ID: `tenant-vfarm-01` (local and production DB)
- [~] Workspace ID: `ws-vfarm-main` in the production DB; runtime value depends on `VFARM_WORKSPACE_ID` (unverified)
- [x] Phone bindings: verified locally and in production DB (masked)
- [~] BHARAG key: configured and non-placeholder locally; live acceptance unverified
- [x] Unknown numbers fail closed (tests)
- [x] Cross-tenant isolation passes (tests)
- [x] Relevant tests pass (1419 passed)
- [~] Production registration: DB chain verified; runtime registry and env unverified (not deployed)

KZE7 is **not** complete.

