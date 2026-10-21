# CST — Production Outbound Queue Delay Audit & Remediation

**Date:** 2026-10-21
**Service:** `bha-cst` (`srv-db8hepqvcj2c73adpus0`) on Render, `https://bha-cst-7u9e.onrender.com`
**Deployed release at the time of the investigation:** `b50588ccdef0a1ebc29ad655e9052d2560b75ffb`
**Repository:** `bhanetworkgh/bha_cst`, branch `main`, HEAD `a4324de26e5ab554d0c6686025683e4e1fc582b4`
**Mode:** Local implementation + verification only. Nothing was deployed, committed, or changed in production.

---

## 1. Executive summary

The reported "outbound SMS delivered hours late" symptom has **two separate causes**, and only one
of them is a CST queue delay:

1. **CST was not the sender for the messages Twilio reported on.** In the observed production
   window CST made **no outbound send attempt at all** and received **no authenticated inbound
   SMS**. The delivery-status callbacks Twilio delivered carried Message SIDs for which CST has
   no `messages_out` row, so CST correctly refused to attribute them and correctly published no
   Dashboard event. The one-to-two-hour delay belongs to whatever *did* send those messages.

2. **CST's own queue had four latent code-owned defects** that would produce exactly the reported
   symptoms the moment CST does send: a provider status mis-mapped to `delivered`, a claim without
   a lease (messages stranded in `sending` forever), a retry schedule that was never persisted,
   and a boot path that could leave the worker never running at all.

Separately, the **21–22 second callback response times were not CST handler latency**. They are
Render cold-start proxy waits, proven from the log timestamps (see §3.1).

**The `PAUSE_OUTBOUND_QUEUE` flag does not exist in this codebase.** `DRY_RUN` exists but gates
only the Dashboard publisher — it cannot delay an SMS.

---

## 2. Baseline

| Item | Value |
|------|-------|
| Branch | `main` |
| HEAD | `a4324de26e5ab554d0c6686025683e4e1fc582b4` |
| Upstream | `origin/main` — HEAD is 1 commit ahead (`a4324de` is not pushed) |
| Working tree at start | 19 modified tracked files, 4 untracked files — **all pre-existing, all preserved** |
| Baseline test run | **51 failing tests across 8 files** (voice lane), rest passing |

The pre-existing uncommitted work already contained: the real vFarm health probe, the
"stored outbound row is authoritative" attribution change, and the `advanced` publication gate.
**This audit preserved all of it** and built on top of it.

---

## 3. Production evidence (read-only, via the Render API/CLI)

All facts below are read-only observations. No production write, config change, or deployment was
performed.

### 3.1 The 21–22 s responses are Render cold starts, not CST latency

Instance restart times on 2026-10-21 (from `render logs`, resource `srv-db8hepqvcj2c73adpus0`):

| Boot | `listening on port 10000` |
|------|----------------------------|
| #1 | 11:16:49 |
| #2 | 11:58:01 |
| #3 | 14:23:12 |
| #4 | 14:47:40 |
| #5 | 14:55:20 |

Delivery-status callback `responseTimeMS` (Render's proxy measurement):

| Time | `responseTimeMS` | Instance state |
|------|------------------|----------------|
| 11:58:05 | **20088**, **14011**, **22093** | immediately after boot #2 (11:58:01) |
| 12:14:17 | 9 | warm |
| 12:16:45 | 9 | warm |
| 12:32:35 | 9 | warm |
| 14:47:47 | **22298**, **21114** | immediately after boot #4 (14:47:40) |
| 15:25:10 | 101, 48 | warm |
| 15:25:57 | 10, 7 | warm |
| 15:26:02 | 10, 6 | warm |

The application's own log lines for the two slow requests are stamped **14:47:47.046** and
**14:47:47.484** — i.e. the handler ran ~6 s after the listener came up, and the proxy's
`responseTimeMS=22298` started ~15 s *before* the instance existed. The handler itself is
milliseconds. **Twilio's error 11203 is the provider giving up on a callback that arrived while
the instance was cold.** CST's handler is not the cause of the 21–22 s figure.

### 3.2 CST was not sending during the window

Between 2026-10-21T00:00Z and 15:30Z (400+ log records inspected):

* **Zero** `Outbound message segmentation` log lines (emitted by the worker for every send attempt).
* **Zero** `Executing Twilio Messages API call` log lines (emitted by the Twilio client per send).
* **Zero** `Twilio send succeeded` audit entries.
* The only inbound-SMS webhook hits were at 15:09:59 and 15:10:59, both **refused** with
  `Missing X-Twilio-Signature` — unauthenticated probes, not customer traffic.

So CST's outbound worker had nothing to send in that window. The worker itself is *not* proven
broken by this — it is only proven to have had no work.

### 3.3 The attribution refusals, exactly

For one of the six distinct Message SIDs observed in the 14:47:47Z window (the SIDs are
not reproduced here — they are resolvable handles for one customer message each; retrieve
them from the log window in the Twilio console):

```
14:47:47.046  outcome=ok      reason="Twilio delivery status update: sent (duplicate/regressing callback — stored state unchanged)"
14:47:47.046  outcome=refused reason="cst.delivery not published for SM******:
                                   tenancy unresolved (To=+9230****3844 binding=none, stored project_id=none)"
```

`tenant_id` was `null` in the ledger entry. `stored project_id=none` **and** a null tenant mean
**no `messages_out` row was found for that MessageSid** — CST had never sent it. The recipient
(`+9230****3844`, masked) is a Pakistan number and was never a bound service number.

The deployed handler (`b50588c`) read:

```js
const binding = To ? CoreRegistry.resolveServiceNumber(To.trim()) : null;   // To = the RECIPIENT
const tenantId = binding?.tenant_id || updateResult.tenant_id || null;
const projectId = binding?.project_id || updateResult.project_id || '';
```

In a Twilio status callback `To` is the **recipient** and `From` is the **sending** number. The
deployed handler therefore used the **recipient's** binding as its PRIMARY attribution source —
which both mis-attributes (a delivery filed against the recipient's project) and drops deliveries
outright (a recipient who is not a bound service number). This is fixed locally in §4.3.

### 3.4 Service plan (why the queue's consumer is not guaranteed to exist)

From `render services`:

* `bha-cst` — `plan: free`, `numInstances: 1`, `healthCheckPath: /health`,
  `startCommand: node scripts/migrate.js && npm start`
* `bha-cst-postgres` — `plan: free`, `ipAllowList: []`

A free-tier web service is destroyed when idle and cold-started on the next request. The outbound
queue is durable in Postgres, but its **only** consumer is an in-process `setInterval`. When the
instance is asleep, the queue does not drain. This is an architecture fact, not a code defect, and
it is the single most likely explanation for a *genuine* multi-hour CST queue delay.

### 3.5 The two reported flags

| Flag | Where it exists | What it does |
|------|------------------|--------------|
| `PAUSE_OUTBOUND_QUEUE` | **Nowhere.** Not in `engine/src`, not in `render.yaml`, not in the service's env var list, not in `.env`. | Nothing. Any belief that the queue is paused is unfounded. |
| `DRY_RUN` | `engine/src/publishers/dashboard.ts` only (`this.dryRun = options.dryRun ?? process.env.DRY_RUN === 'true'`). | Gates **Dashboard event publication only**. It has no effect on the outbound queue, on Twilio submission, or on delivery latency. It is not in `render.yaml` either. |

`quiet_hours` exists only as a type field and a `system_config.routing_rules` column. **It is never
read by any code path.** There is no quiet-hours or business-hours deferral in the outbound queue.

---

## 4. Root-cause analysis, hypothesis by hypothesis

### A. Worker lifecycle and polling — **DEFECTS FOUND**

The worker is started in `engine/src/server.ts` as `setInterval(processOutboundQueue, 5000)`, placed
**after** `app.listen()`. Two real defects:

* **A1 — the boot could block forever before the port bound.** `server.ts` awaited
  `CoreRegistry.initFromDb()` and `SystemsRegistry.whenPersisted()` *before* `app.listen()`, and
  `pg.Pool` was created with **no `connectionTimeoutMillis`** — `pg` defaults to `0`, i.e. *wait
  forever* for a connection. A slow, restarting or unreachable database therefore stalled the boot
  indefinitely: no port, no `/health`, no Twilio callback answer (→ 11203), and **no worker at
  all** — the queue was completely starved, not merely delayed.
* **A2 — the worker was invisible.** A successful deployment produced no log evidence that the
  worker was alive, so "the deploy succeeded" could not be distinguished from "the worker is
  running". This is exactly the risk the evidence calls out.

Fixed: bounded boot + `connectionTimeoutMillis` + `statement_timeout` + worker start/heartbeat logs
(§5.1, §5.3).

### B. Pause and dry-run gates — **NOT REPRODUCED**

`PAUSE_OUTBOUND_QUEUE` does not exist (§3.5). `DRY_RUN` gates only the Dashboard publisher and
cannot delay an SMS. **Neither flag can explain the delay.** No code change was made, and neither
flag was touched.

### C. Scheduling and quiet hours — **NOT REPRODUCED**

* There is no `scheduled_at` / `send_after` column and no business-hours logic anywhere in the
  outbound path.
* `quiet_hours` is never read (§3.5).
* `next_retry_at` **is** the only time-based deferral, and it is a *retry* deferral, not a
  scheduled-send deferral.
* The only timezone-adjacent code is `new Date(...)` comparisons against `NOW()` in SQL, which is
  timezone-safe.

**However**, `next_retry_at` was never actually persisted (§5.2), so the one deferral that does
exist behaved incorrectly — see D3.

### D. Queue claim, locks and database — **DEFECTS FOUND**

* **D1 — no claim lease.** `claimOutboundMessage` flips the row to `sending`. `getPendingOutboundMessages`
  only selects `pending`/`queued`, and the claim only accepts `pending`/`queued`. If the process
  died between the claim and the completion — a deploy, a crash, an OOM kill, a free-tier instance
  being destroyed — the row stayed in `sending` **forever**: not selected, not claimable, never
  failed, never dead-lettered. The customer message was silently lost. This is the mechanism by
  which a message "never arrives" rather than "arrives late".
* **D2 — the batch is processed serially with an unbounded provider call.** `processOutboundQueue`
  awaits each `TwilioClientWrapper.sendSms()` in a `for` loop, and the Twilio client had **no
  request timeout** of its own (it inherited the SDK's default). One slow provider call held the
  whole batch — and with it every other customer's reply behind it.
* **D3 — the retry schedule was never persisted.** `updateOutboundStatus` accepted `nextRetryAt`
  and applied it to the in-memory store only; the SQL `UPDATE` never mentioned the column. In
  production the row was stored as `queued` with `next_retry_at = NULL`, and
  `getPendingOutboundMessages` treats NULL as *due now*. The documented exponential backoff
  (2s, 4s, 8s) therefore never applied: all three attempts fired within ~15 seconds and a
  transient failure became a permanent one.
* **D4 — no pool timeouts.** `pg.Pool` with `max: 10` and no `connectionTimeoutMillis` and no
  `statement_timeout`. A stalled connection blocked the delivery-status webhook handler (the
  direct cause of a 11203 on a warm instance) and starved the worker.

### E. Provider status handling — **DEFECT FOUND** (this is the Dashboard-event defect)

The deployed mapping was:

```js
let mappedStatus = 'delivered';
if (normalizedStatus === 'failed') mappedStatus = 'failed';
else if (normalizedStatus === 'undelivered') mappedStatus = 'undelivered';
else if (normalizedStatus === 'sent') mappedStatus = 'sent';
```

**Every unrecognised status became `delivered`** — including Twilio's `queued` and `accepted`,
which mean "in the carrier queue", not "delivered". Two consequences, both real:

1. CST published a `cst.delivery` event claiming **delivered** the moment the message was only
   queued — a false delivery report.
2. Delivery state is monotonic and `delivered` (rank 4) outranks `sent` (rank 3), so the genuine
   `sent` and `delivered` callbacks that followed could no longer advance the stored state. They
   were treated as duplicates and **no event was published for them**. The real outcome was never
   reported.

The deployed handler also had **no `advanced` idempotency gate**, so it published an event on
*every* callback — a duplicate callback produced a duplicate `cst.delivery`.

---

## 5. Changes implemented (local only)

### 5.1 `engine/src/bootstrap/bounded.ts` (new) + `engine/src/server.ts`

* `runBounded(label, work, timeoutMs)` — a hard time bound around a boot step; a rejection is
  handled, never allowed to escape, and never allowed to hang the boot.
* `RetryableBootstrap` — runs the registry bootstrap steps in order, joins an in-flight attempt
  instead of starting a second one, and clears the in-flight marker after a failed or timed-out
  attempt so it can be retried.
* `server.ts` now boots with `BOOT_DB_TIMEOUT_MS = 15_000`, retries the durable registry bootstrap
  in the background every 30 s until it succeeds, and **starts the outbound worker regardless**.
* The worker now logs `Outbound background worker starting` and a 5-minute
  `Outbound worker heartbeat` carrying the queue depth by status, so "the worker is alive and the
  queue is empty" is distinguishable from "the worker is not running".

### 5.2 `engine/src/db/client.ts`

* Pool: `connectionTimeoutMillis = 10_000`, `statement_timeout = 15_000`.
* `updateOutboundStatus` now **persists `next_retry_at`** (`COALESCE($5, next_retry_at)`).
* `getPendingOutboundMessages` now maps `next_retry_at` from the row into the in-memory view.
* New `reclaimStaleOutboundMessages(leaseMs)` — reclaims rows stuck in `sending` whose
  `updated_at` is older than `OUTBOUND_CLAIM_LEASE_MS` (5 min) and returns them to `queued` with a
  fresh `next_retry_at`. The lease is longer than the worst-case in-flight send, so a live worker
  is never interrupted and no duplicate send is created. **No migration is required** —
  `messages_out.updated_at` already exists and `sending` is already a valid status.
* New `getOutboundQueueDepth()` — read-only counts by status, for the heartbeat.
* `updateDeliveryStatusByProviderSid` now accepts the full ranked vocabulary
  (`queued | sent | delivered | failed | undelivered`); `sending` is deliberately excluded because
  in CST `sending` means "claimed by a worker" and a provider callback must never be able to move
  a row into that state.

### 5.3 `engine/src/transport/twilio/outbound.ts`

* New `mapProviderDeliveryStatus()` — an explicit mapping with an honest `null` for
  "no CST equivalent". An unknown status is **never** `delivered`.
* The delivery-status handler now reads `From` (the sending number) and uses it for the event's
  `from` field. The previous code fell back to `To` — the **recipient** — as the sender.
* Attribution is the persisted outbound row only. The recipient's number is never used.

### 5.4 `engine/src/transport/twilio/client.ts`

* `TWILIO_SEND_TIMEOUT_MS = 15_000` and a `withTimeout` wrapper, so a hanging provider call
  cannot hold the serial batch. A timeout is a **retriable** error, so the message is re-queued
  with backoff rather than lost.

### 5.5 `engine/src/adapters/vfarm/*` + `engine/src/interfaces/voice/index.ts` (from the
pre-existing work, completed here)

* The vFarm health probe is a real, bounded, read-only upstream request reporting **measured**
  latency, with a strict probe timeout (`min(configured, 3s)`), no credential/response-body
  leakage, and no tenant-state mutation.
* New `getHealth(tenantId, { probe: false })` — **operational readiness with no network I/O**.
* The voice lane's authorization gate now uses `{ probe: false }`. Previously it used the active
  probe, which meant every voice turn made an upstream round trip and **any** upstream hiccup
  refused **every** call — a total voice outage triggered by a health endpoint. The fail-closed
  guarantee is unchanged: the authoritative membership and farm-grant checks still run inside
  identity resolution.

### 5.6 Documentation

* `engine/src/docs/swagger.ts` — corrected the delivery-status status mapping table and the
  attribution description; corrected the "Tenant scope is resolved from `To`" statement.
* `docs/cst-v1-operations-runbook.md` — documented the vFarm health status vocabulary and why the
  voice lane does not use the live probe.

---

## 6. Second-round verification (2026-10-21, later)

A second pass re-inspected the code the first pass had left alone, against the same read-only
production evidence. It found **six further code-owned defects**, all of which are now fixed
locally.

### 6.1 A provider timeout was retried into a possible duplicate SMS

`processOutboundQueue` retried any send failure up to `max_retries`. But a timeout — or a
connection reset after the request was dispatched — does **not** prove Twilio failed to create the
message. The retry could therefore deliver a **second copy** to the customer. Now a failure is
classified as `ambiguous` and the retry loop stops; the message is preserved as
`messages_out.status = 'outcome_unknown'` and is never re-dispatched automatically. A definitive
provider answer (a 4xx/5xx from Twilio) is still retried, because there the message provably does
not exist.

### 6.2 The lease reaper re-queued messages the provider had already accepted

The first-pass reaper moved a stale claim back to `queued`, which re-sent it. A stale claim has
two very different meanings: `provider_sid` set means the provider **did** create the message (the
status write is what failed), and `provider_sid` null means the dispatch outcome is unknown. The
reaper now marks the first as `sent` (truthful) and parks the second as `outcome_unknown`. Neither
is re-dispatched.

### 6.3 A failed `saveOutboundMessage` was reported as success

The Postgres error was swallowed and the caller received an id for a row that did not exist. Two
consequences: the customer reply was never queued (it vanished silently), and any child write
against that id violated a foreign key — which is the
`alert_audit_log.outbound_message_id -> messages_out(id)` violation reported from live voice
turns. The failure is now raised as `OutboundPersistenceError`. The foreign key is correct and is
deliberately left in place.

### 6.4 A failed `updateOutboundStatus` was swallowed

The durable state and the in-memory state silently diverged: the row stayed `sending` in the
database while the worker believed it had moved on. The write now reports success or failure and
emits an infra event.

### 6.5 A single delivery callback could mutate several messages

`messages_out.provider_sid` carries a **non-unique** index and the `correlation_id` fallback is a
wildcard, so the callback's `UPDATE` predicate could match more than one row. It is now narrowed
to a single, most-recent match. The rank map in SQL also did not mirror the in-memory
`deliveryStatusRank`: `pending` and `outcome_unknown` folded into the terminal rank, so a callback
could never advance such a row. The two maps are now identical.

### 6.6 The Dashboard dead-letter replay was never invoked

`replayUnpublishedDashboardEvents` existed, was tested, and was **never called by anything**. The
dead-letter view it reads (`getUnpublishedDashboardOutcomes`) was also in-memory only, and the
"replayed" mark was never persisted. So a failed Dashboard publish was unrecoverable after a
restart, and a replayed event could be published twice. The read is now database-backed, the mark
is now persisted, and the replay runs on a 5-minute interval plus once shortly after boot.

### 6.7 Customer identifiers were reaching the log stream

The transport paths masked the CALLER number (`maskPhone(from_e164)`) but three other customer
identifiers were written to logs in the clear:

* the **recipient** number in every outbound-worker diagnostic (tenancy refusals, consent
  refusals, permanent failures, the ambiguous-outcome error);
* the **provider MessageSid** in the delivery-status callback audit entries (including as the
  audit `correlation_id`), in the worker's "send succeeded" audit entry, and in five
  `DeliveryPublisher` log lines;
* the **entire dry-run event payload** in `CstDashboardPublisher`, which carries the customer
  phone number and the provider MessageSid.

A regression test that captures the real log stream now drives the real handlers and fails on any
raw recipient number or raw MessageSid. Recipient numbers and provider Message SIDs are now masked
in log output; the exact values stay in `messages_out` (`.to_e164`, `.provider_sid`), which is
where reconciliation belongs. A masked MessageSid keeps a six-character prefix, so an operator can
still group the log lines for one message and search the provider console by prefix. Service
numbers CST owns remain unmasked: they are not customer identifiers and must stay legible for
triage.

---

## 7. Verification

See the final report for the exact commands and results.

New regression tests:

* `tests/transport/log_privacy.test.ts` (5 tests) — the privacy helpers, and a log-stream capture
  that proves no raw recipient number and no raw provider MessageSid reaches the log output of the
  delivery-status callback or the outbound worker.
* `tests/db/outbound_durability_invariants.test.ts` (17 tests) — failed persistence is raised, the
  alert-audit foreign key stays intact, the lease recovery never re-queues, a claim is atomic and
  two concurrent claims cannot both win, the callback updates exactly one row, the SQL rank map
  mirrors the in-memory one, the dead-letter read and the replay mark are durable, and the
  queue-depth payload carries aggregate counts only.
* `tests/transport/delivery_callback_security.test.ts` (12 tests) — attribution from the persisted
  row, fail-closed on a missing row/project, `To`/`From` not confused, a callback cannot update
  another tenant's message, an out-of-order callback cannot downgrade the state, signature rejection
  before any database access, duplicate callbacks publish one event, publication failure keeps the
  message state correct, unknown provider statuses change nothing.
* `tests/transport/outbound_queue_delay.test.ts` (15 tests) — provider status mapping, claim lease
  semantics, retry-schedule persistence, ambiguous-outcome handling, worker error resilience.
* `tests/bootstrap/bounded_bootstrap.test.ts` (8 tests) — bounded boot and retryable bootstrap.
* `tests/adapters/vfarm_health_operational.test.ts` (8 tests) — operational mode makes no
  upstream request, measured latency, credential rejection, no body/credential leakage, strict
  timeout, no tenant-state mutation, and the voice gate uses `probe: false`.
* `tests/db/outbound_durability_invariants.test.ts` (11 tests) — failed persistence is raised, the
  alert-audit foreign key stays intact, the lease recovery never re-queues, the callback updates
  exactly one row, the SQL rank map mirrors the in-memory one, the dead-letter read and the replay
  mark are durable.
* `tests/transport/delivery_callback_security.test.ts` (9 tests) — attribution from the persisted
  row, fail-closed on a missing row/project, `To`/`From` not confused, signature rejection before
  any database access, duplicate callbacks publish one event, publication failure keeps the
  message state correct, unknown provider statuses change nothing.

---

## 8. Production acceptance checklist

| # | Action | Access required | Expected evidence | Owner |
|---|--------|-----------------|-------------------|-------|
| 1 | Deploy the fix branch and confirm the worker log line `Outbound background worker starting` appears | Render deploy | Log line present within 60 s of boot | Engineering |
| 2 | Confirm the 5-minute `Outbound worker heartbeat` appears and reports a non-null depth | Render logs | Heartbeat every 5 min | Engineering |
| 3 | Query the stranded-`sending` backlog | Read-only SQL on `bha-cst-postgres` | `SELECT status, COUNT(*) FROM messages_out GROUP BY status;` — a non-zero `sending` count older than 5 minutes is the stranded-claim population the lease reaper will recover | Engineering / DBA |
| 4 | Confirm the deployed status mapping | Render deploy + one signed test callback | A `queued` callback yields `queued`, never `delivered` | Engineering |
| 5 | Confirm attribution | One validly signed live callback for a CST-sent message | A `cst.delivery` event with the correct `tenant_id`/`project_id`/`turn_id` reaches the Dashboard | Engineering |
| 6 | **Decide the free-tier plan** | Render dashboard | `bha-cst` and `bha-cst-postgres` moved off `plan: free`, or a separate always-on worker service is provisioned | Bays / operator |
| 7 | Confirm the `DRY_RUN` value for `bha-cst` | Render dashboard | `DRY_RUN` is not `true`, otherwise Dashboard publication is suppressed | Bays / operator |
| 8 | Re-issue a signed delivery callback with `MessageStatus=queued` and confirm 11203 does not recur | Twilio console | Callback answered in < 1 s on a warm instance | Engineering |
| 9 | Identify the actor that sent the six Message SIDs observed in the 14:47:47Z window (§3.3) | Twilio console | The sending source of each of the six SIDs. Retrieve them from the production log window for `2026-10-21T14:47:47Z`; they are not reproduced in this document because each one resolves to a single customer message | Bays / operator |
| 10 | Confirm the lease recovery is not re-sending | Read-only SQL after a deploy | `SELECT status, COUNT(*) FROM messages_out GROUP BY status;` — `outcome_unknown` is non-zero only where a dispatch outcome is genuinely unknown, and no message is ever re-dispatched from that state | Engineering |
| 11 | Confirm the ambiguous-outcome path | One deliberately timed-out provider call in a staging account | The message ends in `outcome_unknown`, is NOT re-dispatched, and no `cst.delivery` event is published for it | Engineering |
| 12 | Confirm the Dashboard dead-letter replay | Read-only SQL | `SELECT status, COUNT(*) FROM dashboard_publish_outcomes WHERE status <> 'published' AND replayed_at IS NULL GROUP BY status;` decreases over successive replay passes, and `replayed_at` is populated | Engineering |
| 13 | Confirm the failed-persistence path | A staging database with the `messages_out` write denied | The turn fails closed with `OutboundPersistenceError`; no `alert_audit_log` row is written against a non-existent `messages_out` parent | Engineering |

**No production write, config change, deployment, or flag change was made as part of this audit.**

---

## 9. What is NOT established

* The **one-to-two-hour delay itself is not established** for the messages in §3.3, because CST did
  not send them. Their sending source is item 9 in the checklist.
* Whether a genuine CST-originated delay occurred at any point is **not established** from the
  available logs: the observation window contains no CST send attempt at all.
* `DRY_RUN`'s live value is not observable through the Render API (env var values are not
  exposed). It is reported as an operator action, not as a fact.
