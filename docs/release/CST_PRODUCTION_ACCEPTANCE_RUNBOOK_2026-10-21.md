# CST — Production Acceptance Runbook

**Date:** 2026-10-21
**Service:** `bha-cst` (`srv-db8hepqvcj2c73adpus0`) — `https://bha-cst-7u9e.onrender.com`
**Live release at the time of writing:** `9b3b1ba76f7764c9d7d3cb9affac9229b21edeaf` (`live`, deployed 2026-10-21T18:30:18Z)
**Scope:** the operator procedures required to close the remaining production-acceptance gaps. Everything here is read-only or a documented manual action. **Nothing in this document was executed against production.**

---

## 1. Confirming the live `DRY_RUN` setting

`DRY_RUN` decides whether CST events are actually delivered to the Dashboard. When it is on, every
event is validated and written to the local publish-outcome table, but **no remote Dashboard
request is made** — so the Dashboard shows nothing while CST reports success.

**The correct surface is the admin-authenticated readiness endpoint, not a log line and not the
host shell.**

```
GET https://bha-cst-7u9e.onrender.com/api/v1/admin/health/verification
x-admin-token: <admin session token>
```

Look at `dashboard_publisher`:

```json
"dashboard_publisher": { "configured": true, "dry_run": false }
```

| Field | Meaning |
|---|---|
| `dry_run: false` | **Events ARE being sent to the Dashboard.** This is the expected production state. |
| `dry_run: true` | Events are being validated and stored locally but **not** sent. The Dashboard is stale. |
| `configured: false` | `ENGINE_DASHBOARD_URL` / `ENGINE_DASHBOARD_KEY` are not set — nothing can be published at all. |

This is deliberately **not** printed in the general log stream. A retained, widely-read log is the
wrong surface for a configuration fact, and the value is not a secret but it does not belong in a
log that operators, auditors and reviewers read. The admin session token is obtained through the
normal admin sign-in flow at `/admin`; it is never pasted into a report, a ticket or a chat.

**Cross-check without the admin API.** A `DRY_RUN=true` deployment emits, for every publication
attempt:

```
[CstDashboardPublisher] Dry-run: event <id> (cst.delivery) validated against cst.event.v1; no remote request made.
```

and never a `publish` success line for the Dashboard. The presence of that line in the log stream
confirms dry-run mode; its **absence** is not proof of anything (see §6).

---

## 2. Free-tier reliability and idle sleep

Both production dependencies are on Render's **free** plan. This is a reliability fact the
operator needs, not a recommendation to change anything immediately.

### 2.1 `bha-cst` (web service, `plan: free`, 1 instance, region `oregon`)

* A free web service is **destroyed after ~15 minutes without traffic** and is cold-started by the
  next request. Observed cold start on 2026-10-21: build-to-listen **4.5 s** end to end, and a
  **20–22 s** proxy wait when the request arrived during a cold start (this is what produced the
  Twilio error `11203` in the earlier incident — the provider gave up on a callback that arrived
  while the instance did not yet exist).
* **The outbound queue worker is an in-process `setInterval`.** It only runs while the process is
  alive. While the instance is asleep, queued messages wait in Postgres until something wakes the
  instance. **The queue is durable; its consumer is not.**
* `autoDeploy` is on (`commit` → `main`), so any push to `main` restarts the instance and briefly
  stops the worker.

### 2.2 `bha-cst-postgres` (Postgres 16, `plan: free`)

* `ipAllowList: []` — no network restriction beyond credential knowledge.
* `highAvailabilityEnabled: false`, `readReplicas: []`, `diskAutoscalingEnabled: false` — a single
  node with no replica and no disk headroom.
* **`expiresAt: 2026-11-14T18:10:20Z`** — Render's free Postgres instances carry an expiry and are
  **deleted** when it passes. The production CST database (`bha_cst_1sh0`, user `bha_cst_user`)
  holds every tenant, project, service-number binding, customer record, consent record, outbound
  message row and alert-audit row. **If this instance is deleted, that data goes with it.**
  This is the single highest-impact item in this document.
* A free Postgres also hibernates when idle, so the first query after a quiet period pays a
  wake-up cost.

### 2.3 What an operator should do (no action taken here)

1. **Before 2026-11-14**, either move `bha-cst-postgres` off the free plan, or export and have an
   approved restore path ready. Confirm the intended treatment with the workspace owner.
2. Move `bha-cst` off the free plan, or run the outbound worker as a separate always-on service,
   so the queue's consumer does not depend on inbound traffic keeping the instance awake.
3. Re-check `expiresAt` after every free-plan change — it is a moving target, not a one-off.

---

## 3. Read-only production SQL — the exact access requirement

**Production SQL is NOT reachable from the current working environment.** The configured
`DATABASE_URL` points at a local development database (`localhost:5432`), and the production
instance is only addressable from Render's network. No access control was bypassed to determine
this, and none should be.

To run the read-only checks below, an operator needs **one** of:

| Option | Requirement |
|---|---|
| **A (recommended)** | A read-only role on `bha_cst_1sh0` with `CONNECT` on the database and `SELECT` on the tables below, plus the connection string for `dpg-db8he2qvcj2c73ado3s0-a` from the Render dashboard, delivered through the workspace's secret store — **never** pasted into chat, a ticket or a report. |
| **B** | A `psql` session on the Render shell / a bastion inside the workspace network, using the workspace's own credentials. |
| **C** | An approved one-off read-only query run by the workspace owner, with the result pasted back. |

The queries themselves (aggregate only — no message bodies, no recipient numbers, no provider
message ids):

```sql
-- Queue shape, and whether anything is stranded in a claimed state.
SELECT status, COUNT(*) FROM messages_out GROUP BY status ORDER BY status;

-- Messages older than the 5-minute claim lease that are still marked as claimed.
SELECT id, tenant_id, status, updated_at
  FROM messages_out
 WHERE status = 'sending' AND updated_at < NOW() - INTERVAL '5 minutes';

-- Messages waiting for a retry, with their scheduled time.
SELECT id, status, retry_count, next_retry_at
  FROM messages_out
 WHERE status = 'queued' AND next_retry_at IS NOT NULL
 ORDER BY next_retry_at LIMIT 50;

-- Messages whose provider outcome could not be established. These are NEVER
-- re-dispatched automatically and need operator reconciliation.
SELECT id, tenant_id, created_at, error_message
  FROM messages_out
 WHERE status = 'outcome_unknown' ORDER BY created_at;

-- Dashboard events that were never ingested (the dead-letter queue).
SELECT status, COUNT(*) FROM dashboard_publish_outcomes
 WHERE status <> 'published' AND replayed_at IS NULL GROUP BY status;

-- The foreign-key target of the alert audit trail.
SELECT COUNT(*) FROM alert_audit_log;
```

Every query above is a `SELECT` of aggregate or administrative columns. **No `UPDATE`, `DELETE` or
`INSERT` is required or authorised.**

---

## 4. Staging-only test plan — signed Twilio callbacks and SMS delivery

Nothing in this section may be executed against production. It is a plan for an approved staging
account and an approved test number.

### 4.1 Prerequisites

* A **staging** Render service built from the release under test, with its own database, its own
  Twilio account (or a dedicated test subaccount), and a **test MSISDN** that is not a customer
  number.
* Test credentials held in the workspace secret store: the Twilio account SID, auth token, a
  messaging service SID or an owned test sender, the vFarm test credentials, and the Dashboard
  test key.
* A dedicated test phone number, registered for SMS only, with consent recorded for it.

### 4.2 Valid signature generation (never in production)

The Twilio signature is `base64(HMAC-SHA1(authToken, url + sortedBodyParams))` over the exact
request URL and the sorted form-encoded body. The repository already contains the reference
implementation used by the test suite:

* `engine/src/transport/twilio/signature.ts` — verification (production code path).
* `tests/transport/signature.test.ts` and the webhook suites — the matching generator.

A staging harness should reuse that generator rather than re-implement it, and it must read the
auth token from the environment. **Never place a live auth token in a command-line argument, a
shell history entry, a test fixture checked into the repository, or a report.**

### 4.3 Test sequence

| # | Step | Expected evidence |
|---|---|---|
| 1 | Start the staging service; confirm `Outbound background worker starting` and the first `Outbound worker heartbeat` | Both log lines present; heartbeat reports aggregate counts only |
| 2 | Record consent for the test number | A consent row exists for the test number and project |
| 3 | Send an inbound SMS **from** the test number to the staging receiving number, with a valid signature | The inbound webhook is accepted; the message is persisted |
| 4 | Watch the outbound worker | A `messages_out` row appears with a `provider_sid` |
| 5 | Watch the Twilio delivery-status callback arrive | The stored status advances `sent` → `delivered`, and exactly **one** `cst.delivery` event is published |
| 6 | Replay the same delivery callback (identical body, valid signature) | **No** second `cst.delivery` event; the stored state does not move |
| 7 | Send a callback with `MessageStatus=queued`, then `sent`, then `delivered` | The stored state advances in that order; `queued` is never recorded as `delivered` |
| 8 | Send a callback for an unknown MessageSid | The request is acknowledged (204) and **no** event is published and no tenant is invented |
| 9 | Send a callback with an invalid signature | 403, the message state is unchanged, and a tripwire ledger entry is written |
| 10 | Force a provider timeout in the staging harness | The message ends in `outcome_unknown`, is **not** re-dispatched, and no `cst.delivery` is published |
| 11 | Inspect `dashboard_publish_outcomes` | Every event is `published`, or is a dead letter with a payload for replay |

**No step may use a real customer number, and no step may run against the production service.**

### 4.4 Voice

Voice stays **degraded** until steps 3–5 have been repeated for a voice call with a verified
identity AND a successful end-to-end delivery. `GET /health/voice` already reports the lane as
degraded (HTTP 503, `can_route_voice: false`) whenever there is no successful delivery in the
last 24 hours, and the admin readiness view now derives the same answer instead of asserting
health. **Do not force the voice lane to report healthy.**

---

## 5. npm audit findings — assessment and remediation options

`npm audit` reports **13 vulnerabilities: 3 critical, 4 high, 6 moderate**. The production and
development trees have to be separated before any of them is actioned, because the severity list
mixes a build toolchain with the runtime.

### 5.1 What is in the production dependency tree

| Package | Severity | Via | Advisory | Production reachability |
|---|---|---|---|---|
| `proxy-addr@2.0.7` | **critical** | `express@4.22.2` | IP spoofing via IPv4-mapped IPv6 trust subnet (`<2.0.8`) | **In the runtime.** `app.set('trust proxy', true)` means `proxy-addr` computes `req.ip`, which the webhook rate limiter uses as its key. See §5.3. |
| `follow-redirects@1.16.0` | **high** | `twilio@5.13.1 → axios@1.20.0` | Array-form headers bypass cross-origin credential stripping (`<1.16.1`) | **In the runtime.** Only used by the Twilio SDK's HTTP client. |
| `fast-uri@3.1.7` | moderate | `ajv@8.20.0` (via `swagger-jsdoc`) | Inconsistent host case normalisation via percent-encoded octets (`<3.1.8`) | In the runtime, but only on the schema-validation path. |
| `qs@6.15.3`, `body-parser@1.20.6`, `express@4.22.2` | moderate | direct / `body-parser` | `qs` array-limit bypass and `isBuffer` DoS (`>=6.14.2 <=6.15.3`) | In the runtime. `qs` parses the query string. |

### 5.2 What is dev-toolchain only (not in `npm ls --omit=dev`)

`vitest@1.6.x` (direct dev dependency, **critical** — "when the Vitest UI server is listening,
arbitrary file can be read and executed"), and via it `tinypool` (**critical** — prototype
pollution → RCE in worker options), `vite`, `vite-node`, `esbuild`, `source-map-js` and
`brace-expansion`.

**None of these are in the production runtime.** The Vitest advisory additionally requires the
Vitest **UI server to be listening**, which CST never starts — CI runs `vitest run`, not
`vitest --ui`. The dev dependencies are installed during the Render build
(`npm ci --include=dev && npm run build`) but nothing in `dist/` loads them.

### 5.3 The finding that matters most, and it is not the advisory headline

`engine/src/app.ts:27` sets `app.set('trust proxy', true)` — "trust **all** proxies". With that
setting Express takes the **left-most** `X-Forwarded-For` entry as `req.ip`, and that entry is
**supplied by the caller**. `req.ip` is used in exactly one place: the webhook rate limiter
(`app.ts:57`).

Two consequences, both worse than the advisory it is bundled with:

1. **The webhook rate limit can be evaded** by varying the `X-Forwarded-For` header.
2. **The limiter can be poisoned**: an unauthenticated caller can exhaust another IP's bucket,
   and every legitimate Twilio callback for that IP is then answered `429` and **dropped**. The
   code's own commercial-impact note already says this: *"Legitimate Twilio deliveries may be
   delayed or dropped if Twilio is retrying from the same IP range."*

**Recommended change (not applied here):** set `trust proxy` to the exact number of proxies in
front of the app — `app.set('trust proxy', 1)` for Render's single edge hop — so `req.ip` becomes
the address Render itself appended, which the caller cannot forge.

**Why it is not applied in this change:** the correct hop count depends on the exact
`X-Forwarded-For` chain Render produces, which cannot be confirmed from a read-only environment.
Guessing wrong in the other direction is *worse* than the current state, because every legitimate
Twilio callback would then share one bucket and the 120 req/min limit would throttle real
deliveries. **This needs one staging measurement of the `X-Forwarded-For` chain and is a required
pre-acceptance action.**

### 5.4 Safe remediation options (none applied)

| Option | Change | Risk | Notes |
|---|---|---|---|
| **1 (lowest risk, recommended first)** | Add npm `overrides` for `follow-redirects: 1.16.1` and `fast-uri: 3.1.8` | **Low** — patch-level bumps of transitive packages, no direct dependency change, no API change | `follow-redirects@1.16.1` and `fast-uri@3.1.8` are both published. Run the full suite after. |
| **2** | `express@4.22.3` | Low–moderate | Pulls `qs@~6.16.0` (the patched line) but still pins `proxy-addr@~2.0.7`. |
| **3** | `overrides` for `proxy-addr: 2.0.8` | Low | `2.0.8` is published and satisfies `express@4`'s `~2.0.7` range. Combine with §5.3. |
| **4** | `qs` — no published fix on the 6.x line at the time of writing | — | `qs@6.16.1` is the latest release; the advisory range is `>=6.14.2 <=6.15.3`, so `6.16.1` is **outside** it. `body-parser@1.20.6` accepts `~6.15.0`/`^6.16.0` depending on the release, so an `overrides` entry is the way to pull it. Verify the resolved tree with `npm ls qs` after. |
| **5** | `vitest` 1.6.x → ≥3.2.6 (or 4.x) | **High** | A **major** upgrade of the test runner. It changes the worker pool, the config surface and the snapshot format. Requires a dedicated branch, a full-suite run and a review of the vitest config. **Do not bundle this with a production release.** |
| **6** | `express` 4 → 5 | **High** | Major. Changes the router, the error handling and the path syntax. Not justified by the current advisories alone. |

**Sequencing:** options 1–3 are patch-level and can ride along with the next release after the full
suite passes. Option 4 needs its resolved tree verified. Option 5 is a separate piece of work.
Option 6 is not recommended.

---

## 6. Reading the logs without over-reading them

A missing log line is **not** evidence that an operation failed. Before concluding anything from an
absence, check all four of these:

1. **Level.** CST's `Logger.info` is emitted and visible in the Render log stream (the worker
   startup and heartbeat lines are both `INFO` and both appear). `Logger.audit` and
   `Logger.infra` are also visible.
2. **Filter.** `render logs` accepts `--text`, and a filtered pull will not show what it excludes.
   Pull the window unfiltered before concluding an event did not happen.
3. **Window.** Render retains a bounded history; a pull outside the retention window returns
   nothing at all. A 1-hour window is the practical minimum for a queue beat.
4. **The operation may not have run.** The outbound worker only sends when the queue is
   non-empty. A window with `pending 0, queued 0` will contain no send logs **because there was
   nothing to send** — that is the normal, healthy state, not a failure.

**The `outcome_unknown` count is the one that will be silent until the release that carries it is
deployed.** Until then, the deployed heartbeat reports only `pending`, `queued`, `sending` and
`failed`. The absence of an `outcome_unknown` field in a heartbeat from release `9b3b1ba` is
explained by the release, and says nothing about the queue contents.

---

## 7. External dependency — vFarm user-to-location/device contract

**Owner: the vFarm team.** CST cannot resolve a caller to a device, a zone or a live unit because
the upstream contract for that mapping does not exist.

* The contract must define, at minimum: the user identity, the farm, the zone/location/device, the
  effective authorisation (which grant makes the mapping usable), and the mapping lifecycle
  (creation, expiry, revocation).
* Until it exists, CST's live telemetry stays **fail-closed**: no device or unit is claimed for a
  caller, and no farm data is returned for an unmapped caller.
* **Do not implement against an imagined endpoint.** The adapter must not guess a
  user-to-unit mapping path, and a farm grant must never be used to infer a device.
* **No proposed user-to-device interface currently exists in this repository.** If one is
  authored, it must be labelled explicitly as an unapproved proposal, kept out of the runtime
  code path, and must not be presented to the vFarm team as an agreed contract.
