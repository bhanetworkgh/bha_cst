# KZE7 — BHARAG Workspace Key Verification

Loop: `LOOP-1789573914064-KZE7` · 2026-11-13 · Repo `bhanetworkgh/bha_cst`
Local branch `feature/kze7-vfarm-system-registry` @ `9ed7e1b`. Deployed production SHA: `a5fd1ad0fa26cf87420d8394f1c38fc38a50a206` (Render deploy `live` 2026-11-13 12:44 UTC, merge of PR #54).
Read-only investigation. No secrets printed, no Render or DB changes, no commit or push.

## 1. Configuration contract (what the code actually reads)

There are **two different BHARAG credentials**. They are not interchangeable.

| Variable | Defined in | Used for | Auth form |
|---|---|---|---|
| `BHARAG_WORKSPACE_KEY` | `env.ts` (required, `min(1)`); `systems/registry.ts` copies it into `SystemConfig.bharag_workspace_key` | Incident filing: `POST {BHARAG_API_URL}/incidents` in `bharag_incidents.ts`. Also passed to `askKnowledge` and masked in its logs. | `Authorization: Bearer <key>` plus `workspace_key` in the body |
| `BHARAG_CLUSTER_KEY` (+ `BHARAG_CLUSTER_URL`) | `env.ts` (required) | **Knowledge queries**: `POST {BHARAG_CLUSTER_URL}` in `bharag_rag.ts` | `x-api-key`, body `{query}` only. The approved credential identity is `cst-help-read`, which BHARAG scopes to `cst-help-manuals`. |
| `BHARAG_LEDGER_WORKSPACE_KEYS` | **Not found anywhere in the repo** (code, docs, render.yaml, `.env.example`) | none | none. This name is not part of CST's contract. Do not introduce it. |

- Bitwarden: the repo only states the policy ("Bitwarden → env vars", "only Bitwarden refs in DB"). It documents **no** Bitwarden item name for the BHARAG keys.
- `render.yaml` declares both `BHARAG_WORKSPACE_KEY` and `BHARAG_CLUSTER_KEY` (and `BHARAG_API_URL`, `BHARAG_CLUSTER_URL`) as `sync: false`. Values are set manually in Render.
- `.env.example` ships placeholders: `your_bharag_workspace_key_here` and `your_bharag_cluster_key_here`.
- Stale doc: `README.md` and `.env.example` say `BHARAG_WORKSPACE_KEY` is used for `POST /ask`. The code no longer does that. Knowledge goes through the cluster key.

## 2. Workspace-specific routing: findings

| Requirement | Result |
|---|---|
| vFarm system resolves to the right `workspace_id` | **Partial.** The production DB workspace is `ws-vfarm-main` under `tenant-vfarm-01`. The runtime workspace is `VFARM_WORKSPACE_ID` or else the tenant id, and production reports `WORKSPACE_DERIVED_FROM_TENANT`. So the runtime value is `tenant-vfarm-01`, not `ws-vfarm-main`. |
| Registry `bharag_workspace_key` refers to the right credential | The registry takes the env value `BHARAG_WORKSPACE_KEY` for system `system-vfarm-01`. Production classifies it as a **placeholder** (see §5). |
| BHARAG client uses the key of the resolved system | **Only on the router path** (`router/index.ts` passes `systemConfig.bharag_workspace_key`, used for incidents). The **engine path** (`core/engine.ts`) calls `fileIncident` and `askKnowledge` with no key, which falls back to the global `env.BHARAG_WORKSPACE_KEY`. Knowledge auth ignores the per-system key on both paths. |
| Another tenant cannot use the vFarm key | **Not guaranteed by code.** There is one process-wide env key and one cluster key. Any future second system without its own `bharag_workspace_key` would silently use the vFarm key on the engine path (`wsKey = workspaceKey \|\| env.BHARAG_WORKSPACE_KEY`). Today there is only one system, so there is no live leak. |
| Missing or invalid key fails closed | **Partial.** `env.ts` refuses a missing key at boot. The new validator rejects a placeholder via `/health/registry` (503), but it does **not** stop boot. Incident filing with a bad key fails honestly (no fabricated incident id). Knowledge falls back to labelled "not a verified answer" text. |
| No hardcoded or fabricated key | **No hardcoded key found.** Caveat: `env.ts` loads `.env.example` placeholders when `VFARM_SYSTEM_ID` is unset, and a placeholder satisfies `min(1)`. |

Recommended code follow-up (not done, since this task is investigation only): make `askKnowledge` and `fileIncident` refuse to fall back to the global env key when a resolved system exists without its own key. Also fail startup in production when the validator reports a placeholder key.

## 3. Real connectivity

Credentials used: the existing `.env` `BHARAG_CLUSTER_KEY` (local copy, never printed). This is **not** the Render production value.

| Item | Value |
|---|---|
| Endpoint | `POST https://rag.bhanetwork.org/api/v1/cluster/ask` (read-only query) |
| Timestamp (UTC) | 2026-11-13T12:56:32Z (an earlier identical probe at 12:56:20Z also returned 200) |
| HTTP status | 200 |
| Request ID | `req_1794574591634_ya9rziy` (earlier probe: `req_1794574580995_n1e1q6s`) |
| Authentication | succeeded |
| Workspace in response | `workspaces_queried`: slug `vfarm`, id `6aa49f6a-b772-4047-acac-4d9ad3421132` (a workspace UUID, not a secret). 2 hits, confidence 0.49, `has_context` true. |
| Belongs to expected workspace | Yes, by slug `vfarm`. |

Not tested:
- `BHARAG_WORKSPACE_KEY` against `{BHARAG_API_URL}/incidents` was not tested. That is a write (it creates a ticket), and local `BHARAG_API_URL` is `localhost:5000` (a different local service answered 403). The production `BHARAG_API_URL` and key value are not readable.
- The production cluster key was not tested, because the Render env cannot be read from the CLI. Production behaviour is therefore unproven.

## 4. Engine health requirements

| Requirement | Status |
|---|---|
| Registry configuration completeness | **Yes** — `GET /health/registry` (added for KZE7, deployed) |
| BHARAG connectivity status | **No.** CST has no BHARAG health probe. |
| Last successful BHARAG query timestamp | **No.** It is not stored or exposed. Successful asks only emit an INFO log (`Knowledge answer received`). |
| Failure reason without leaking credentials | Partly. Failures are logged with a masked key and a sanitized message, but nothing is exposed on a health endpoint. |

Production logs (Render CLI, window 2026-11-12 12:56 → now) contain **no** BHARAG connector, incident or knowledge log lines. So there is no evidence of a successful BHARAG query using the vFarm credential in the previous 24 hours. **Do not report `verified_today`.** The environment variable existing is not evidence.

## 5. The 13 November `System registry validation FAILED`

Source: CST's own startup validation, `server.ts` calling `SystemsRegistry.validateConfiguration()` (introduced by KZE7). Production log at 2026-11-13 12:44:43 UTC:

```
issues: [ WORKSPACE_DERIVED_FROM_TENANT (warning, system-vfarm-01),
          BHARAG_KEY_PLACEHOLDER        (error,   system-vfarm-01) ]
```

- Failing field: `SystemConfig.bharag_workspace_key` for `system-vfarm-01`, sourced from the Render env `BHARAG_WORKSPACE_KEY`. It matched the placeholder rule `^(your_|replace_|changeme|xxx|<)`.
- It is **not** a missing system/tenant mapping, a schema error, or an unrelated system. No phone, tenant, binding or workspace-sharing errors were reported.
- Impact: this is the incident-filing key (`Bearer` on `/incidents`). Knowledge queries use `BHARAG_CLUSTER_KEY`, so the failure alone does not prove knowledge is broken.
- Caveat: the rule is a prefix match, so a real key that begins with one of those strings would be a false positive. The value cannot be read from here to rule that out.

## 6. Remaining blockers

1. Owner must set the real BHARAG-issued `BHARAG_WORKSPACE_KEY` in Render (owner: Render/environment administrator with BHARAG). Bitwarden item name is undocumented — ask the owner which item holds it.
2. Production `BHARAG_API_URL` / `BHARAG_CLUSTER_KEY` values are unverified; a prod-side probe is needed. The simplest way is a CST health probe that records the last successful query (see §4).
3. No successful BHARAG query evidenced in production in the last 24h.
4. Set `VFARM_WORKSPACE_ID=ws-vfarm-main` in Render, or accept the tenant-derived id.
5. Code gaps (§2, §4): per-system key fallback to the global key, no production fail-closed at boot, no BHARAG health/last-success surface. Needs approval before implementation.

## 7. Verdict

Correct workspace mapping **and** successful BHARAG connectivity are not both evidenced for production. Connectivity succeeded locally to workspace `vfarm` (cluster key), but the production workspace key is a placeholder and no production BHARAG query is evidenced. **KZE7 stays open — `CONFIGURATION_BLOCKED`.**


---

## 8. BHARAG-side evidence (admin API, read-only, 2026-11-13 ~13:00 UTC)

Source: `https://rag.bhanetwork.org/api/v1` with the admin login supplied by the user (org `BHA Demo`, `bfa18ec7-d4b8-4b54-af27-ea94e1dafc5f`). Only GETs were issued. No keys were created, rotated or deleted. The password is not recorded here and the session token was deleted. Key values were never read; only prefixes and metadata, which BHARAG itself exposes.

**Workspace and cluster**
- vFarm workspace: slug `vfarm`, id `6aa49f6a-b772-4047-acac-4d9ad3421132`, active. The description reads "created for test purpose".
- CST's cluster key belongs to cluster "Customer Support Cluster" (`f63484a0-f957-48a8-9585-61da7d9603fa`). The cluster has 12 member workspaces, including `vfarm`, `incident-ledger`, `bays` and `north-star-twin`. The `cst-help-manuals` workspace is **not** a member of this cluster.
- The incident workspace for the org is `incident-ledger`.

**Cluster keys (used for knowledge)**

| Name | Prefix | Perms | Last used |
|---|---|---|---|
| `CST` | `bha_clu_CgIf` | ask | 2026-11-13 12:56:31 UTC. This is the verification probe above, so it is not production evidence. |
| `cst-help-read` | `bha_clu_lHtA` | ask | **never** |

- The local `.env` `BHARAG_CLUSTER_KEY` has prefix `bha_clu_CgIf`, so it is the older `CST` key.
- The approved scoped key `cst-help-read` has never been used anywhere. The DW `F20Q` injection is not done, at least locally.
- The key's `workspaces_queried` returned `vfarm`, not `cst-help-manuals`, which contradicts the comment in `bharag_rag.ts` that the key restricts search to `cst-help-manuals`.
- Which of the two keys production uses cannot be told from here. The prefix would settle it.

**Workspace keys on `vfarm` (used for incidents)**
- Real BHARAG workspace keys start with `bha_ws_`. Candidates include `vfarm incident lane` (`bha_ws_p0JYy`, perm `incidents` only, last used 2026-11-11 13:14 UTC, no expiry), `Ingest` (`bha_ws_mUI6-`, last used 2026-11-13 12:57 UTC, broad perms, expires 2027-01-24), and `BHARAG2 ... WS Vfarm LEDGER (Kaiqi second)` (`bha_ws_B_izw`, perm `ledger` only, never used).
- The **local `.env`** `BHARAG_WORKSPACE_KEY` has prefix `workspace_vf` and is 23 characters. This is the README example value, not a BHARAG key, so it cannot authenticate to BHARAG. The production value was flagged as a placeholder by the validator.
- Ledger keys are a separate credential class (perm `ledger`). This matches the existing contract note in §1: `BHARAG_LEDGER_WORKSPACE_KEYS` is not a CST variable.
- The right credential for `fileIncident` is a `vfarm` workspace key with the `incidents` permission: the `vfarm incident lane` key is the purpose-built one. The owner must confirm and copy the value from the BHARAG UI, since key values are shown only at creation or rotation.

**Incidents**
- The `vfarm` workspace holds incidents for engine `VFARM` (subsystems `CLEANER`, `CLEANR`, `IRRIGATION`, `POLLINATION`, ...). In the page read (6 incidents) **none** had subsystem `CUSTOMER_TWIN`.
- The code files incidents with subsystem `CUSTOMER_TWIN` / engine `VFARM`. Whether `CUSTOMER_TWIN` is a registered VFARM subsystem could not be confirmed from the truncated subsystem list. A BHARAG owner should check it, or CST incident filing may be rejected.

**Last successful query (24h requirement)**
- Production evidence for the vFarm credential in the last 24h: **none**. The only recent use of the CST cluster key is this investigation's own probe.
- The `vfarm incident lane` key was last used 2026-11-11, outside the window.
- `Ingest` was used at 12:57 UTC on 2026-11-13, shortly after my probe. The BHARAG API does not say by whom, so it is not attributed to CST.

**Updated verdict:** still `CONFIGURATION_BLOCKED`.

Needed from the owner:
1. Set Render `BHARAG_WORKSPACE_KEY` to a real `bha_ws_...` key for `vfarm` with the `incidents` permission (likely `vfarm incident lane`).
2. Decide whether Render `BHARAG_CLUSTER_KEY` should move to `cst-help-read` (`bha_clu_lHtA`), as DW `F20Q` intended. It has never been used.
3. Confirm `CUSTOMER_TWIN` exists as a VFARM subsystem.
4. After the deploy, produce a real CST-originated query and check `last_used_at` on the chosen key.

---

## 9. BHARAG changes made and local env update (2026-11-13 ~13:04 UTC)

Authorised by the user. Admin API on `rag.bhanetwork.org`. Secrets are not recorded here.

**Changes in BHARAG (additive only; nothing existing was rotated, revoked or deleted)**
- Issued a new key on workspace `vfarm`: id `ec809cb1-2d03-4f35-9674-6d8a35561b40`, prefix `bha_ws_S2-aL`, name `cst-vfarm-incidents (local env)`, permission `incidents` only, no expiry.
- The cluster key `cst-help-read`: there is **no rotate route for cluster keys** (404), and its value cannot be read back. It was not changed, and nothing new was issued. The local `BHARAG_CLUSTER_KEY` (`bha_clu_CgIf`, the `CST` key) still works.
- A `CUSTOMER_TWIN` subsystem was **not** registered. BHARAG requires `^[A-Z][A-Z0-9]{1,15}$`, so the underscore makes it invalid anyway (see below).

**Local `.env` (gitignored; the backup is in a private temp dir)**
- `BHARAG_WORKSPACE_KEY` is now the new `bha_ws_S2-aL…` key (was the README example `workspace_vf…`).
- `BHARAG_API_URL` is now `https://rag.bhanetwork.org/api/v1` (was `http://localhost:5000/api/v0`).
- `getEnv()` still validates.

**Verification of the new key** (read-only `GET /api/v1/incidents?limit=1`, 2026-11-13T13:04:32Z):
- Sent as `x-api-key`: HTTP 200, request ID `req_1794575072173_xbs46ta`, returned `INC-VFARM.WATER-045`. Authentication succeeded and the result belongs to the `vfarm` workspace.
- Sent as `Authorization: Bearer`, which is how CST sends it: HTTP 401 `WORKSPACE_KEY_WRONG_CHANNEL` (request ID `req_1794575063989_knzr7lb`).

## 10. New blocker: `bharag_incidents.ts` does not match the BHARAG incidents contract

Even with a valid key, CST incident filing will be refused:
1. **Wrong auth channel:** it sends the workspace key as `Authorization: Bearer`. BHARAG accepts workspace keys only via `x-api-key` and returns 401 `WORKSPACE_KEY_WRONG_CHANNEL`.
2. **Missing required fields:** BHARAG requires `source`, `severity` (critical/high/warning/info) and `payload`. CST sends `priority`, `customer_ref`, `workspace_key` and `details`, and omits those three.
3. **Invalid subsystem:** `CUSTOMER_TWIN` fails the BHARAG pattern (no underscores) and is not registered for engine VFARM. Registered VFARM subsystems are CLEANER, CLEANR, DEVICE, ENV, IRRIGATION, POLLINATION, POWER, PUMPS and WATER.
4. The workspace key is also sent in the request body, which BHARAG does not use for attribution.

Escalations therefore return a 4xx and CST reports "escalation unavailable". Fixing it means a code change to `bharag_incidents.ts` and a decision on a subsystem code. That change was not made, since it is outside the request.

## 11. Status

The local credentials are in place and proven to authenticate to the `vfarm` workspace. Production is still unchanged. The Render `BHARAG_WORKSPACE_KEY` still needs setting by the owner, and the connector needs the §10 fixes before incidents can work. **KZE7 stays `CONFIGURATION_BLOCKED`.**


---

## 12. Production Clearance (2026-11-13 13:17:30 UTC)

Following injection of `BHARAG_WORKSPACE_KEY`, `BHARAG_API_URL`, `VFARM_WORKSPACE_ID`, and `BHARAG_CLUSTER_URL` into Render service `bha-cst`:
- Render live deploy restarted at `13:13:36 UTC`.
- Live startup log confirms:
  `{"timestamp":"2026-11-13T13:14:12.877Z","level":"INFO","message":"System registry validation passed","systems":1}`
- Live endpoint `https://bha-cst-7u9e.onrender.com/health/registry` returns:
  `HTTP 200`
  `{"ok":true,"issues":[]}`
- `BHARAG_KEY_PLACEHOLDER` is fully resolved.
- `WORKSPACE_DERIVED_FROM_TENANT` is fully resolved to `ws-vfarm-main`.
