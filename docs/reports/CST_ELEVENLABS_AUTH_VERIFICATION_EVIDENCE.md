# ElevenLabs Post-Call Webhook Authentication & Dual Observability Verification Report

**Document Reference:** `CST-REP-2026-11-04-ELEVENLABS-AUTH`  
**System:** Customer Service Twin (`bha-cst`)  
**Environment:** Production (`https://bha-cst-7u9e.onrender.com`)  
**Database:** Render Managed PostgreSQL (`dpg-db8he2qvcj2c73ado3s0-a` / `bha_cst_1sh0`)  
**Service ID:** `srv-db8hepqvcj2c73adpus0` (Oregon)  
**Date:** November 4, 2026  
**Status:** **100% OPERATIONAL & VERIFIED IN PRODUCTION**

---

## 1. Executive Summary

This report documents the end-to-end investigation, incremental engineering fixes, and definitive empirical evidence for the **ElevenLabs Conversational AI Post-Call Webhook** integration and **Twilio Telephony Dual Observability** pipeline for Bays Horizon Network (`bha-cst`).

Initial telephony calls were successfully handled by the voice clone agent, but conversation transcripts failed to record on Render due to cryptographic signature verification differences and nested payload schemas. Through three iterative Pull Requests (PR #28, PR #29, and PR #30), the webhook receiver was hardened against signature re-stringification flaws and payload envelope variations.

On November 4, 2026 at `17:12:08 UTC`, live call `conv_0401m6krqe37eebabeds8r7n9gfd` was cryptographically verified, fully parsed, and persisted into Render PostgreSQL (`dashboard_publish_outcomes` and `voice_deliveries`).

---

## 2. Chronological Authentication & Ingestion Matrix

| # | Timestamp (UTC) | Interaction / Call ID | Type / Source | Auth Status | HTTP Code | Outcome / Error Detail | Relevant PR |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **1** | `14:45:00` | Telephony Inbound | Twilio Event Streams | **Failed** | `403` | Twilio Event Streams test probe rejected (unsupported CloudEvents signature format). | **PR #26** |
| **2** | `15:36:11` | `CAda5935f38feebf...` | Twilio Call (43s) | **Success** | `200` | Carrier telephony completed; ElevenLabs webhook not yet configured. | **PR #27** |
| **3** | `16:15:00` | Synthetic Probe | ElevenLabs Receiver | **Failed** | `401` | `auth_failures: 1`. Missing `ElevenLabs-Signature` parser (`t=<timestamp>,v0=<hmac>`). | **PR #28** |
| **4** | `16:43:00` | `conv_probe_179381...` | ElevenLabs Test Probe | **Success** | `200` | Probe signed with `wsec_...`; 3 events persisted in PostgreSQL. | **PR #28** |
| **5** | `16:51:36` | `CA3b5552908a3f5...` | Live Call (57s) | **Failed** | `401` | `auth_failures: 2`. Wire format HMAC mismatch: signature checked against `JSON.stringify(req.body)` instead of `req.rawBody` buffer. | **PR #29** |
| **6** | `17:04:27` | `CA9ae509f00c4d4...` | Live Call (108s) | **Auth Pass / Validation Fail** | `400` | `authenticated_success: 1`, `validation_failures: 1`. Signature passed, but Zod rejected nested `data: { conversation_id }` envelope. | **PR #30** |
| **7** | `17:12:08` | `conv_0401m6krqe3...` | Live Call (11s) | **Success** | `200` | **Full Success!** Auth passed, nested `data` parsed, complete dialogue persisted into PostgreSQL. | **PR #30** |
| **8** | `17:13:00` | `CA7951fb657b1b4...` | Twilio Call (55s) | **Success** | `200` | Dual observability verified: carrier delivery (`cst.delivery`) logged in parallel. | **PR #30** |

---

## 3. Incident Investigations & Engineering Solutions

### Incident 1: 401 Unauthorized via Missing Header Standard
* **Symptom:** Receiver initially expected an `x-webhook-secret` header.
* **Root Cause:** ElevenLabs Conversational AI does not support custom header injection. Instead, it signs outgoing webhooks with its own secret via:
  ```http
  ElevenLabs-Signature: t=1730739096,v0=a78f29...
  ```
* **Resolution (PR #28):** Implemented official timestamped HMAC-SHA256 signature extraction (`t=<timestamp>,v0=<hmac>`) with constant-time equality checks and a 30-minute replay tolerance window.

### Incident 2: 401 Unauthorized via JSON Re-Serialization
* **Symptom:** Live 57-second call (`CA3b5552908a3f5...`) failed authentication (`auth_failures` incremented from 1 to 2).
* **Root Cause:** In `engine/src/interfaces/elevenlabs/index.ts`, Express parsed `req.body` into a JavaScript object, and the verification function evaluated `JSON.stringify(req.body)`. `JSON.stringify` re-orders object keys and strips whitespace, which produced a different HMAC hash than the byte-exact payload transmitted by ElevenLabs.
* **Resolution (PR #29):** Captured the raw network buffer `req.rawBody` directly in Express middleware (`verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); }`). Updated `ElevenLabsWebhookService.authenticate` with multi-candidate resilience:
  1. Primary: Exact raw wire buffer `(req as any).rawBody`.
  2. Fallback: Re-stringified JSON `JSON.stringify(req.body)`.
  3. Secret Normalization: Checks both `wsec_...` and trimmed hex keys.

### Incident 3: 400 Bad Request via Payload Envelope Drift
* **Symptom:** Live 108-second call (`CA9ae509f00c4d4...`) passed authentication (`authenticated_success: 1`, `auth_failures: 0`), but returned `400 INVALID_PAYLOAD` (`validation_failures: 1`).
* **Root Cause:** ElevenLabs wraps full post-call data inside a nested `data` object:
  ```json
  {
    "type": "post_call_transcription",
    "event_timestamp": 1739537297,
    "data": {
      "agent_id": "agent_5701m66tmyfseeyt84r3rcwrg3b7",
      "conversation_id": "conv_0401m6krqe37eebabeds8r7n9gfd",
      "transcript": [ ... ],
      "metadata": { "call_duration_secs": 11, "cost": 30 },
      "analysis": { ... }
    }
  }
  ```
  The Zod schema was expecting `conversation_id` and `transcript` at the top level.
* **Resolution (PR #30):** Updated `schemas.ts` and `service.ts` to unwrap `payload.data`, relaxed `metadata` and `analysis` schemas to `.passthrough()`, and added automated regression tests.

---

## 4. Production Database Evidence (Render PostgreSQL)

### 4.1 Ingested Transcript Record (`cst.transcript`)
**Query:**
```sql
SELECT id, event_type, correlation_id, created_at, payload
FROM dashboard_publish_outcomes
WHERE correlation_id = 'conv_0401m6krqe37eebabeds8r7n9gfd' AND event_type = 'cst.transcript';
```
**Database Row:**
```json
{
  "id": "dpo_c709927e-c92b-49df-8913-f449eae5eec6",
  "event_type": "cst.transcript",
  "correlation_id": "conv_0401m6krqe37eebabeds8r7n9gfd",
  "status": "published",
  "created_at": "2026-11-04T17:12:08.225Z",
  "payload": {
    "id": "evt_trsc_b9b51fbf-14cc-4af0-863d-94dea4fc37f2",
    "type": "cst.transcript",
    "source": "cst/voice/elevenlabs",
    "channel": "voice",
    "time": "2026-11-04T17:12:08.216Z",
    "tenant_id": "tenant-vfarm-01",
    "project_id": "proj-vfarm-main",
    "correlation_id": "conv_0401m6krqe37eebabeds8r7n9gfd",
    "customer": {
      "phone_e164": "+15550000000",
      "customer_ref": "+15550000000",
      "role": "owner",
      "is_known": true,
      "farm_ids": ["farm_1"]
    },
    "data": {
      "channel": "voice",
      "duration_secs": 11,
      "summary": "The agent introduced itself as the BHA assistant for Bays Horizon Network and offered assistance to the user.",
      "metadata": {
        "agent_id": "agent_5701m66tmyfseeyt84r3rcwrg3b7"
      },
      "messages": [
        {
          "role": "agent",
          "message": "Hi, this is the BHA assistant, an automated helper for Bays Horizon Network. How can I help you today?",
          "timestamp": "2026-11-04T17:12:08.216Z",
          "time_in_call_secs": 1
        }
      ]
    }
  }
}
```

### 4.2 Ingested Outcome Record (`cst.outcome`)
```json
{
  "id": "dpo_78df8a42-40aa-46ae-b51f-d24c3c0dc971",
  "event_type": "cst.outcome",
  "correlation_id": "conv_0401m6krqe37eebabeds8r7n9gfd",
  "status": "published",
  "created_at": "2026-11-04T17:12:08.272Z",
  "payload": {
    "id": "evt_outc_94254603-5701-4801-b0ad-c6522861a434",
    "type": "cst.outcome",
    "source": "cst/voice/elevenlabs",
    "channel": "voice",
    "data": {
      "status": "resolved",
      "duration_secs": 11,
      "summary": "The agent introduced itself as the BHA assistant for Bays Horizon Network and offered assistance to the user."
    }
  }
}
```

### 4.3 Carrier Telephony Status in `voice_deliveries`
```json
{
  "id": "vd_1182b0abfbab57b186d27876ecd2ae2c7905a17228a991ff",
  "status": "sent",
  "correlation_id": "CA7951fb657b1b425a2e4bb2ca3fd4e859",
  "delivered_at": "2026-11-04T17:12:59.198Z",
  "created_at": "2026-11-04T17:13:00.268Z",
  "project_id": "proj-vfarm-main"
}
```

---

## 5. Linked GitHub Pull Requests & Deployments

| PR Number | Merged Commit | Render Deploy ID | Deploy Completed | Summary of Changes |
| :--- | :--- | :--- | :--- | :--- |
| **[PR #28](https://github.com/bhanetworkgh/bha_cst/pull/28)** | `0bf4ade1` | `dep-dbllmqrbc2fs739trd9g` | `16:21:52 UTC` | Official ElevenLabs signature format (`t=<timestamp>,v0=<hmac>`) and 30-min tolerance. |
| **[PR #29](https://github.com/bhanetworkgh/bha_cst/pull/29)** | `c3270f19` | `dep-dblm9mfb9u1s73d0i6r0` | `17:02:27 UTC` | Raw wire buffer `req.rawBody` HMAC checking with multi-candidate resilience. |
| **[PR #30](https://github.com/bhanetworkgh/bha_cst/pull/30)** | `744e145f` | `dep-dblme5jbc2fs739v69rg` | `17:11:35 UTC` | Unwrapped nested `data` payload schema, flexible metadata/analysis Zod schemas. |

---

## 6. Current Operational Health & Readiness Status

1. **ElevenLabs Webhook Receiver:** `https://bha-cst-7u9e.onrender.com/webhooks/elevenlabs/health`
   * `status`: **Ready / Healthy**
   * `auth_failures`: **0** (under active deployment `dep-dblme5jbc2fs739v69rg`)
   * `last_successful_timestamp`: `2026-11-04T17:12:08.483Z`
2. **Telephony Voice Lane:** `https://bha-cst-7u9e.onrender.com/health/voice`
   * `status`: **Healthy**
   * `can_route_voice`: `true`
   * `successful_deliveries_24h`: `5+`
   * `last_successful_spoken_delivery`: `2026-11-04T17:12:59.198Z`

**Sign-off:**  
The ElevenLabs Conversational AI voice twin is fully integrated with Render production and Twilio. Inbound calls are answered by the voice clone, transcripts are cryptographically verified and saved to PostgreSQL, and carrier lifecycle status is auditable in real time.
