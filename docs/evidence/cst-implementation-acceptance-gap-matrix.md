# CST Implementation-to-Acceptance Gap Matrix

**Repository:** `bhanetworkgh/bha_cst`  
**Branch:** `fix/monitoring-pay-gate-closure`  
**Baseline HEAD:** `97e905561e45efbce3470cbb7686a1272e9c5381`  
**Inspection date:** 2026-11-02  
**Baseline working tree:** pre-existing modifications in `package.json`, `package-lock.json`, and `tests/health/health_route.test.ts`; pre-existing untracked CI, browser, Playwright, and acceptance-evidence files.

Statuses describe evidence, not intentions. Local implementation, local verification, GitHub CI, deployed production verification, and external-owner confirmation are separate gates.

| Acceptance area | Implementation and test map | Observed gap | Owner | Status |
|---|---|---|---|---|
| Interim sensor endpoint | `VfarmLiveClient.getLatestReading()`, `getReadings()`, `listLatestReadings()`; `vfarm_per_sensor_classification.test.ts`; `vfarm_telemetry_mapping.test.ts` | `/api/v1/readings?sensor_id=X&limit=1` is called, but the local response schema does not match checked-in vFarm OpenAPI and conversion fabricates a value wrapper/status. Focused baseline: 25 tests, 20 passed, 5 failed. | CST | PARTIAL |
| Four-sensor hierarchy | `deviceResponseSchema`, `layoutResponseSchema`, `listAllDevices()`, `getFarmLayout()` | `parent_device_id`, zone/location/sublocation fields are available, but no cabinet resolution or independent verification exists for `rack1_soil`, `rack1_ph`, `rack2_dht`, and `rack1_mq7`. | CST; vFarm confirmation for live semantics | PARTIAL |
| Health normalization | `mapFarmHealthStatus()`, `/api/health`; `health_contract.test.ts`, `health_route.test.ts` | Mapping exists. Current working-tree health tests and rendered-output assertions require verification; no production conclusion is inferred. | CST | PARTIAL |
| Health freshness | `FarmHealthResponseSchema`, `/api/health` staleness metadata | No confirmed authoritative health timestamp or timestamp semantics. | Jeganathan / vFarm | BLOCKED |
| Presence and help copy | vFarm `fleet_status` consumption; `p1-vfarm-status-and-monitoring-help-copy.md`; fleet-status tests | Five-minute presence and never-heard correction are upstream-owned and not independently verified. | CST for copy; Jeganathan for behavior | PARTIAL |
| Monitoring/Engine surfacing | `monitoring-research-twin-field-contract.md`; health, vFarm, publisher, and recovery modules | Requested consolidated `cst-monitoring-engine-surfacing-contract.md` is absent and existing claims need code/evidence reconciliation. | CST / BHA Engine boundary | PARTIAL |
| Research Twin lifecycle | Existing escalation and operational-incident logging only | No approved n8n/Research Twin contract, genuine card ID, assignment/update/resolution synchronization, or approved callback signature contract. | CST adapter; Destiny and Jeganathan for contract | BLOCKED |
| Text pending feedback | `web/app.js`; `chat_pending_feedback.test.ts`; `pending_feedback.spec.ts` | Implementation/state tests exist, but real browser acceptance and captured evidence are not complete. | CST | PARTIAL |
| Voice routing and persistence | `interfaces/voice`, `transport/voice`, conversation/turn persistence; `tests/voice/*` | Local pipeline exists. Authorized real call, playback, persistence, retry, and no-unexpected-termination evidence are absent. | CST; authorized human tester | PARTIAL |
| SMS attribution and Dashboard | outbound queue, delivery callback, Dashboard publishers/outcomes; `tests/transport/*`, `tests/publishers/*` | Complete authorized production SMS lifecycle and matched-row/Dashboard evidence are absent. | CST; authorized human tester | PARTIAL |
| Migration reconciliation | 23 files in `db/migrations`; `scripts/migrate.js`; migration tests | Duplicate `003` identity and reported drift for `006`/`010` are not reconciled against production history. No production changes authorized. | CST; production DB owner for read-only confirmation | PARTIAL |
| Dependency vulnerabilities | `package.json`, lockfile, overrides | Current lockfile audit and exposure/disposition evidence not yet run; older seven-finding report is stale. | CST | PARTIAL |
| Deterministic CI | `.github/workflows/ci.yml` | Workflow is untracked; dependency audit uses `|| true`; browser acceptance is not included; no remote run is evidenced. | CST | PARTIAL |
| Central evidence | `cst-monitoring-pay-gate-acceptance.md` | Existing document says the tree is clean and no CST code work remains, contradicted by repository state and failing focused tests. | CST | PARTIAL |
| Production deployment and PDQ2 | Render service `bha-cst`; production URL supplied in mission | Current deployment SHA, environment checks, and PDQ2 A–F production evidence are not independently verified. No deployment or production mutation is authorized. | CST / Jason / external owners | NOT VERIFIED |

## Immediate baseline verification

Command:

```sh
npm test -- --run tests/adapters/vfarm_per_sensor_classification.test.ts tests/connectors/vfarm_telemetry_mapping.test.ts
```

Result: **2 test files failed; 5 tests failed and 20 passed**. This is local evidence only.

## External dependencies that must remain open

1. Jeganathan: authoritative farm-health timestamp, five-minute presence semantics, never-heard correction, and permanent `/readings/latest` deployment/performance evidence.
2. Destiny Arupi and Jeganathan: approved Research Twin request, auth, response, idempotency, callback, signature, event, status, and priority contracts.
3. Authorized human testers: real voice call and real SMS lifecycle. The engineering agent must not initiate either.
4. Production owners: read-only deployment/database/network evidence and explicit authorization before any production mutation.
