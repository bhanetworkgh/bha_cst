# CST Blocker Register

**Repository:** `bhanetworkgh/bha_cst`
**Branch:** `fix/monitoring-pay-gate-closure`
**HEAD SHA:** `97e905561e45efbce3470cbb7686a1272e9c5381`
**Report date:** 2026-11-02
**Pay-gate:** `DW-1793626498819-PDQ2`

Statuses: OPEN | IN PROGRESS | AWAITING AUTHORIZATION | RESOLVED

---

## Blocker Register

| ID | Blocker | Severity | Owner | Evidence Missing | Required Action | Acceptance Condition | Status |
|---|---|---|---|---|---|---|---|
| B-01 | vFarm farm-health timestamp contract | High | Jeganathan / vFarm | Authoritative timestamp field name, type, timezone, serialization format, observation-vs-calculation semantics; confirmation whether field will be added to `GET /api/v1/farms/{farm_id}/health` | Confirm timestamp contract; if added, CST implements configurable freshness thresholds; if not, freshness remains `unavailable_no_timestamp` | vFarm owner confirms timestamp field or confirms its absence permanently | OPEN |
| B-02 | Five-minute online rule confirmation | Medium | Jeganathan / vFarm | Upstream implementation evidence for five-minute presence rule; exact `last_seen_at` comparison logic; clock/timezone handling | vFarm owner confirms rule implementation and semantics | vFarm evidence confirms five-minute rule (or documents it as pending contract) | OPEN |
| B-03 | Never-heard device correction | Medium | Jeganathan / vFarm | Correction for `NEVER_HEARD_DEVICE_FALSE_ONLINE` defect; device status contract for never-heard devices | vFarm owner confirms never-heard device behavior; CST help copy updated accordingly | vFarm confirms never-heard devices are not shown as online | OPEN |
| B-04 | `/readings/latest` confirmed sensor collection endpoint | High | Jeganathan / vFarm | Confirmed by Jegan; verified across all 4 sensors (`rack1_soil`, `rack1_ph`, `rack2_dht`, `rack1_mq7`) | Jegan confirmed `GET /api/v1/readings/latest?sensor_id=...`; CST switched collection to single reading object contract and verified 100% | Single reading object parsed with unit, status, timestamps, values | RESOLVED (CST) |
| B-05 | Research Twin / BHA Engine integration contract | Critical | Destiny Arupi / Jeganathan | Approved n8n webhook contract: HTTP method, auth header, request payload, response schema, error structure, timeout, idempotency, callback URL, signature algorithm, timestamp/replay protection, event types, investigation ID, status/priority vocabulary, open→assign→resolve lifecycle, bidirectional sync | Destiny confirms contract; Jegan confirms architecture; CST implements adapter behind feature flag | Approved contract evidenced; genuine Research Twin card creation verified; lifecycle sync tested | BLOCKED |
| B-06 | Research Twin credentials rotation | High | Destiny Arupi / Jason | New `RT_ENDPOINT_URL`, `RT_SERVICE_API_KEY`, `RT_CALLBACK_SIGNING_SECRET` (previous credentials exposed and compromised) | Replace credentials through approved secret-management process before production activation | New credentials in place; old credentials revoked | OPEN |
| B-07 | DNS/TLS configuration (OYP9) | High | Jason / Platform | CNAME records at GoDaddy for `cst.bhanetwork.org` and `cst-admin.bhanetwork.org`; domains added in Render dashboard; TLS certificates provisioned | Platform adds CNAME → `bha-cst-7u9e.onrender.com`; adds domains in Render; provisions TLS | DNS resolves; TLS terminates; `cst.bhanetwork.org` reachable over HTTPS | OPEN |
| B-08 | Render Postgres upgrade | Medium | Jason / Platform | Postgres free tier expires 14 Nov 2026; upgrade needed before expiration | Platform upgrades Render Postgres from free tier | Database remains available past 14 Nov 2026 | OPEN |
| B-09 | Migration 020 approval | Medium | Jason | Explicit authorization to apply migration `020_dashboard_publish_outcomes.sql` | Jason authorizes migration application | Migration 020 applied to production | OPEN |
| B-10 | Migration reconciliation (duplicate 003, drift 006/010) | Medium | CST / production DB owner | Read-only production migration history; checksum comparison of migration files; drift disposition | Production DB owner confirms migration state; CST prepares safe forward migration if needed | Migration state documented; no production data loss | OPEN |
| B-11 | Database network access restriction | Medium | Platform / Jason | Render Postgres allowlist currently `0.0.0.0/0` (historical observation); needs re-verification | Platform verifies current allowlist; restricts to private-only if needed | Database allowlist confirmed restricted | OPEN |
| B-12 | Real voice call acceptance | High | Authorized human tester | Redacted transcript/test record; correlation ID; audio playback result; persistence result; no false success; no unauthorized outbound call | Authorized human conducts real call using test number and credentials | Voice E2E evidence captured; caller identity resolved; audio playable; conversation persisted | OPEN |
| B-13 | Real SMS acceptance | High | Authorized human tester | Outbound row; Twilio SID; matched callback; tenant/project/correlation attribution; Dashboard publication | Authorized human conducts real SMS lifecycle | SMS E2E evidence captured; callback resolves outbound row; Dashboard shows delivery | OPEN |
| B-14 | Browser acceptance screenshots | Medium | CST / authorized tester | Playwright test screenshots/traces; mobile viewport evidence | Chromium browser installed in CI; browser tests run; screenshots captured | Browser acceptance evidence available in CI artifacts | OPEN |
| B-15 | Remote CI run | Medium | CST / GitHub | GitHub Actions workflow run against exact commit SHA | CI workflow triggered on `main` or PR; successful run reported | GitHub CI shows green for commit `97e9055` | OPEN |
| B-16 | Dependency audit residual risk | Low | CST | 7 findings (5 moderate, 2 high) accepted as residual risk; all require `--force` which breaks swagger-jsdoc | Document accepted risk with owner and date; monitor for safe fix path | Risk acceptance documented; no unaddressed high-severity runtime exposure | OPEN |

---

## Blockers by Owner

### Jeganathan / vFarm
- B-01: Farm-health timestamp contract
- B-02: Five-minute online rule confirmation
- B-03: Never-heard device correction
- B-04: `/readings/latest` permanent performance fix

### Destiny Arupi / Jeganathan
- B-05: Research Twin / BHA Engine integration contract
- B-06: Research Twin credentials rotation

### Jason / Platform
- B-07: DNS/TLS configuration (OYP9)
- B-08: Render Postgres upgrade
- B-09: Migration 020 approval

### CST / Production DB owner
- B-10: Migration reconciliation
- B-11: Database network access restriction

### Authorized human tester
- B-12: Real voice call acceptance
- B-13: Real SMS acceptance

### CST
- B-14: Browser acceptance screenshots
- B-15: Remote CI run
- B-16: Dependency audit residual risk

---

## Blockers by Severity

| Severity | Count | Blockers |
|---|---|---|
| Critical | 1 | B-05 |
| High | 5 | B-01, B-04, B-06, B-07, B-12 |
| Medium | 6 | B-02, B-03, B-08, B-09, B-10, B-11 |
| Low | 3 | B-13, B-14, B-15, B-16 |
