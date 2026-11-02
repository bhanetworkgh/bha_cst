# CST — Research Twin Integration Handoff (For Destiny Arupi)

**Date:** 2026-11-02
**From:** CST Engineering (`bha-cst`)
**To:** Destiny Arupi (Research Twin Owner) & Jeganathan
**CC:** Jason (PDQ2 Acceptance / Decision Watch `DW-1793626498819-PDQ2`)
**CST Service URL:** `https://bha-cst-7u9e.onrender.com`
**CST Implementation Reference:** [`engine/src/research_twin/config.ts`](file:///Users/HaMi/Documents/Jason/customer%20twin/engine/src/research_twin/config.ts), [`engine/src/research_twin/lifecycle.ts`](file:///Users/HaMi/Documents/Jason/customer%20twin/engine/src/research_twin/lifecycle.ts), [`tests/research_twin/config.test.ts`](file:///Users/HaMi/Documents/Jason/customer%20twin/tests/research_twin/config.test.ts), [`tests/research_twin/lifecycle.test.ts`](file:///Users/HaMi/Documents/Jason/customer%20twin/tests/research_twin/lifecycle.test.ts)

---

## 1. Latest Production Status (`RT_*` Credentials Now Configured on Render!)

On `2026-11-02T22:25:18.754Z`, the Research Twin environment variables (`RT_ENDPOINT_URL`, `RT_SERVICE_API_KEY`, `RT_CALLBACK_SIGNING_SECRET`) were added to the live Render service (`bha-cst`, deployment `dep-dbkgavp5efls73ag1olg`, SHA `fa701a3f7e2a4c642307d018f9a4a123cc6007d3`).

Live read-only verification of `GET https://bha-cst-7u9e.onrender.com/api/health` at `2026-11-02T22:25:18.754Z` confirms that `research_twin` has transitioned from `state: "unavailable"` (`missing: ["RT_ENDPOINT_URL", "RT_SERVICE_API_KEY", "RT_CALLBACK_SIGNING_SECRET"]`) to **`state: "blocked"` with zero missing environment variables**:

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

Per [`engine/src/config/env.ts`](file:///Users/HaMi/Documents/Jason/customer%20twin/engine/src/config/env.ts#L93-L95) and [`engine/src/research_twin/config.ts`](file:///Users/HaMi/Documents/Jason/customer%20twin/engine/src/research_twin/config.ts#L21-L39):

| Environment Variable | Production Status on Render (`2026-11-02T22:25:18Z`) | Purpose |
|---|---|---|
| `RT_ENDPOINT_URL` | **`CONFIGURED` (`endpoint_configured: true`)** | Candidate Research Twin / n8n webhook URL for outbound investigation creation |
| `RT_SERVICE_API_KEY` | **`CONFIGURED` (`service_api_key_configured: true`)** | Service API key for authenticating outbound CST -> Research Twin requests |
| `RT_CALLBACK_SIGNING_SECRET` | **`CONFIGURED` (`callback_signing_secret_configured: true`)** | Shared signing secret for verifying inbound Research Twin -> CST lifecycle callbacks |

---

## 3. Why `state` Is `"blocked"` (`contract: "unverified"`) & What Remains for Requirement D Closure

As enforced by [`engine/src/research_twin/config.ts`](file:///Users/HaMi/Documents/Jason/customer%20twin/engine/src/research_twin/config.ts) and [`engine/src/research_twin/lifecycle.ts`](file:///Users/HaMi/Documents/Jason/customer%20twin/engine/src/research_twin/lifecycle.ts):

1. **Fail-Closed Contract Boundary:**
   - Having `RT_ENDPOINT_URL`, `RT_SERVICE_API_KEY`, and `RT_CALLBACK_SIGNING_SECRET` configured on Render satisfies the **infrastructure credential prerequisite** (`missing: []`).
   - However, per Jason's Requirement D guardrails, CST intentionally refuses to guess an unapproved n8n payload or claim `operational: true` before the external Research Twin request/callback schema is confirmed by Destiny Arupi / Jeganathan.
2. **Implemented & Locally Verified CST Lifecycle Spine (`ProvisionalResearchTwinLifecycle`):**
   - [`engine/src/research_twin/lifecycle.ts`](file:///Users/HaMi/Documents/Jason/customer%20twin/engine/src/research_twin/lifecycle.ts) implements the complete contract-independent investigation lifecycle and is verified by 10 unit/integration tests in [`tests/research_twin/lifecycle.test.ts`](file:///Users/HaMi/Documents/Jason/customer%20twin/tests/research_twin/lifecycle.test.ts) and [`tests/research_twin/config.test.ts`](file:///Users/HaMi/Documents/Jason/customer%20twin/tests/research_twin/config.test.ts):
     - **Outbound Request Envelope (`ResearchTwinInvestigationRequest`):**
       - `tenant_id: string`
       - `project_id: string`
       - `correlation_id: string`
       - `source_system: string`
       - `originating_incident_id: string`
       - `occurred_at: string` (ISO-8601 authoritative source-observation timestamp)
       - `event_type: string`
       - `priority: string | null`
       - `idempotency_key: string`
     - **Creation State Machine (`ResearchTwinCreationState`):**
       - `'pending'` -> `'creating'` -> `'created'` (or `'awaiting_retry'` on retryable `ResearchTwinTransportError`, or `'blocked_permanent_failure'` on non-retryable failure).
     - **Inbound External Update Envelope (`ResearchTwinExternalUpdate`):**
       - `tenant_id: string`
       - `project_id: string`
       - `research_twin_investigation_id: string`
       - `external_event_id: string` (deduplicated idempotently)
       - `event_type: string`
       - `assignment: string | null`
       - `lifecycle_status: string | null` (stored verbatim without fabricated CST status mapping)
       - `observed_at: string`

---

## 4. Remaining Action Items for Destiny Arupi (Research Twin Owner)

Now that `RT_ENDPOINT_URL`, `RT_SERVICE_API_KEY`, and `RT_CALLBACK_SIGNING_SECRET` are live on Render (`bha-cst`):

1. **Confirm the Wire Protocol for `RT_ENDPOINT_URL`:**
   - Confirm the exact HTTP method (`POST`), authentication header format (e.g., `Authorization: Bearer <RT_SERVICE_API_KEY>` or `x-api-key`), JSON request body fields, and synchronous response field returning `research_twin_investigation_id`.
2. **Confirm the Callback Signature & Payload Format (`RT_CALLBACK_SIGNING_SECRET`):**
   - Confirm the signature header name and HMAC algorithm (e.g., `X-Research-Twin-Signature: sha256=<hex>`) and the JSON payload mapping to `ResearchTwinExternalUpdate` (`research_twin_investigation_id`, `external_event_id`, `event_type`, `assignment`, `lifecycle_status`, `observed_at`).
3. **Execute 1 End-to-End Staging/Production Handshake:**
   - Once Destiny confirms the wire schema, CST will bind `ProvisionalResearchTwinTransport` to `RT_ENDPOINT_URL` and flip `contract` from `'unverified'` to `'verified'` (`operational: true`), allowing a live investigation round-trip to be recorded for Jason's Requirement D sign-off.
