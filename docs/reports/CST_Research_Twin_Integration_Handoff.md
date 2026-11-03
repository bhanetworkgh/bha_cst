# CST — Research Twin Integration Handoff (For Destiny Arupi)

**Date:** 2026-11-02
**From:** CST Engineering (`bha-cst`)
**To:** Destiny Arupi (Research Twin Owner) & Jeganathan
**CC:** Jason (PDQ2 Acceptance / Decision Watch `DW-1793626498819-PDQ2`)
**CST Service URL:** `https://bha-cst-7u9e.onrender.com`
**Verified Production Deployment:** `dep-dbkh3p6417fc73bffihg` (PR #23 Merge Commit `441d2b3f4a49c983f45131c229888a60116b9437`, live at `2026-11-02T22:43:32.077742Z`)
**CST Implementation Reference:** [`engine/src/research_twin/config.ts`](../../engine/src/research_twin/config.ts), [`engine/src/research_twin/lifecycle.ts`](../../engine/src/research_twin/lifecycle.ts), [`tests/research_twin/config.test.ts`](../../tests/research_twin/config.test.ts), [`tests/research_twin/lifecycle.test.ts`](../../tests/research_twin/lifecycle.test.ts)

---

## 1. Latest Production Status (`RT_*` Credentials Verified Live on Render)

Read-only inspection of the Render service environment variables (`GET /v1/services/srv-db8hepqvcj2c73adpus0/env-vars`), Render startup logs (`dep-dbkh3p6417fc73bffihg` at `2026-11-02T22:43:26.799Z`), and `GET https://bha-cst-7u9e.onrender.com/api/health` (`2026-11-02T22:48:18.788Z`) confirms that `RT_ENDPOINT_URL`, `RT_SERVICE_API_KEY`, and `RT_CALLBACK_SIGNING_SECRET` are **configured in production (`missing: []`)**:

- **Startup Log (`2026-11-02T22:43:26.799Z`):**
  ```json
  {"timestamp":"2026-11-02T22:43:26.799Z","level":"INFO","message":"Research Twin integration configuration checked","state":"blocked","operational":false,"contract":"unverified","missing":[]}
  ```
- **Live `/api/health` Response (`2026-11-02T22:48:18.788Z`):**
  ```json
  {
    "research_twin": {
      "state": "blocked",
      "operational": false,
      "contract": "unverified",
      "endpoint_configured": true,
      "service_api_key_configured": true,
      "callback_signing_secret_configured": true,
      "missing": [],
      "reason": "approved Research Twin API and callback contract is not verified"
    }
  }
  ```

---

## 2. Environment Variables Verified on Render (`bha-cst`)

Per [`engine/src/config/env.ts`](../../engine/src/config/env.ts) and [`engine/src/research_twin/config.ts`](../../engine/src/research_twin/config.ts):

| Environment Variable | Production Status on Render (`dep-dbkh3p6417fc73bffihg`) | Purpose |
|---|---|---|
| `RT_ENDPOINT_URL` | **`CONFIGURED` (`endpoint_configured: true`)** | Candidate Research Twin / n8n webhook URL for outbound investigation creation |
| `RT_SERVICE_API_KEY` | **`CONFIGURED` (`service_api_key_configured: true`)** | Service API key for authenticating outbound CST -> Research Twin requests |
| `RT_CALLBACK_SIGNING_SECRET` | **`CONFIGURED` (`callback_signing_secret_configured: true`)** | Shared signing secret for verifying inbound Research Twin -> CST lifecycle callbacks |

---

## 3. Why `state` Is `"blocked"` (`contract: "unverified"`) & What Remains for Requirement D Closure

As enforced by [`engine/src/research_twin/config.ts`](../../engine/src/research_twin/config.ts) and [`engine/src/research_twin/lifecycle.ts`](../../engine/src/research_twin/lifecycle.ts):

1. **Fail-Closed Contract Boundary:**
   - Having `RT_ENDPOINT_URL`, `RT_SERVICE_API_KEY`, and `RT_CALLBACK_SIGNING_SECRET` configured on Render satisfies the **infrastructure credential prerequisite** (`missing: []`).
   - However, per Jason's Requirement D guardrails, CST intentionally refuses to guess an unapproved n8n payload or claim `operational: true` before the external Research Twin request/callback schema is confirmed by Destiny Arupi / Jeganathan.
2. **Implemented & Locally Verified CST Lifecycle Spine (`ProvisionalResearchTwinLifecycle`):**
   - [`engine/src/research_twin/lifecycle.ts`](../../engine/src/research_twin/lifecycle.ts) implements the complete contract-independent investigation lifecycle and is verified by 10 unit/integration tests in [`tests/research_twin/lifecycle.test.ts`](../../tests/research_twin/lifecycle.test.ts) and [`tests/research_twin/config.test.ts`](../../tests/research_twin/config.test.ts):
     - **Outbound Request Envelope (`ResearchTwinInvestigationRequest`):** `tenant_id`, `project_id`, `correlation_id`, `source_system`, `originating_incident_id`, `occurred_at` (ISO-8601 authoritative source-observation timestamp), `event_type`, `priority`, `idempotency_key`.
     - **Creation State Machine (`ResearchTwinCreationState`):** `'pending'` -> `'creating'` -> `'created'` (or `'awaiting_retry'` on retryable `ResearchTwinTransportError`, or `'blocked_permanent_failure'` on non-retryable failure).
     - **Inbound External Update Envelope (`ResearchTwinExternalUpdate`):** `tenant_id`, `project_id`, `research_twin_investigation_id`, `external_event_id` (deduplicated idempotently), `event_type`, `assignment`, `lifecycle_status` (stored verbatim without fabricated CST status mapping), `observed_at`.

---

## 4. Remaining Action Items for Destiny Arupi (Research Twin Owner)

1. **Confirm the Wire Protocol for `RT_ENDPOINT_URL`:**
   - Confirm the exact HTTP method (`POST`), authentication header format (e.g., `Authorization: Bearer <RT_SERVICE_API_KEY>` or `x-api-key`), JSON request body fields, and synchronous response field returning `research_twin_investigation_id`.
2. **Confirm the Callback Signature & Payload Format (`RT_CALLBACK_SIGNING_SECRET`):**
   - Confirm the signature header name and HMAC algorithm (e.g., `X-Research-Twin-Signature: sha256=<hex>`) and the JSON payload mapping to `ResearchTwinExternalUpdate`.
3. **Execute 1 End-to-End Staging/Production Handshake:**
   - Once Destiny confirms the wire schema, CST will bind `ProvisionalResearchTwinTransport` to `RT_ENDPOINT_URL` and flip `contract` from `'unverified'` to `'verified'` (`operational: true`), allowing a live investigation round-trip to be recorded for Jason's Requirement D sign-off.
