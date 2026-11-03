# CST Live Production Telephony Acceptance Report

> **Execution Date:** 2026-11-03T00:16:18.047Z  
> **Target Production Service:** https://bha-cst-7u9e.onrender.com  
> **Deployed Production SHA:** `441d2b3f4a49c983f45131c229888a60116b9437`  
> **Local HEAD SHA:** `ea59fc33c5312e35817abad76a53b75918d3b756`  
> **Authorized Test Recipient:** `+9230***3844`  
> **Sender Caller ID:** `+19715885823`  
> **Tenant / Project Attribution:** `00000000-0000-0000-0000-000000000001` / `proj-vfarm-main`  

---

## 1. Executive Summary & Verdicts

| Subsystem / Operation | Verdict | Twilio Provider SID | Initial Status | Final Reconciled Status | Delivery Attribution |
|---|---|---|---|---|---|
| **Preflight Validation** | **`PASS`** | N/A | Ready | Ready | Verified |
| **Twilio Live SMS** | **`NOT_TESTED`** | `(empty)` | `not_tested` | `not_tested` | Scoped project & tenant |
| **Twilio Outbound Voice Call** | **`NOT_TESTED`** | `NONE..._RUN` | `dry_run` | `not_initiated` | Scoped project & tenant |

---

## 2. Preflight Health & Configuration Evidence

- **Production Health Probe:** `PASS` (HTTP 200 OK ({"status":"ok","service":"bha-cst-engine"}))
- **Voice Subsystem Readiness:** `PASS` (Voice lane ready, clone configured: Hmy9...esiM)
- **Twilio Credentials Integrity:** `PASS` (Account status: `active`)
- **Caller ID Ownership:** `PASS` (Owned Number: +19715885823 (Voice: true, SMS: true))
- **Database & Admin Readiness:** `PASS` (Admin verification healthy: 1 bound numbers, transport: healthy)

---

## 3. Real SMS Test Record

- **Test Run ID:** `N/A`
- **Correlation ID:** `N/A`
- **CST Message ID:** `N/A`
- **Twilio Message SID:** `N/A`
- **Request Timestamp (UTC):** `N/A`
- **Twilio Initial Status:** `N/A`
- **Final Delivery Status:** `N/A`
- **Carrier Price / Cost:** `N/A`
- **Error Code / Details:** `None`

---

## 4. Real Outbound Voice Call Record

- **Test Run ID:** `CST-LIVE-VOICE-1793664978045-8da0bac3`
- **Correlation ID:** `corr_CST-LIVE-VOICE-1793664978045-8da0bac3`
- **CST Voice Delivery ID:** `vd_CST-LIVE-VOICE-1793664978045-8da0bac3`
- **Twilio Call SID:** `NONE_DRY_RUN`
- **Request Timestamp (UTC):** `2026-11-03T00:16:18.045Z`
- **Call Initial Status:** `dry_run`
- **Call Final Status:** `not_initiated`
- **Call Duration:** `N/A`
- **Announcement Text Played:**
  > "This is an authorized Customer Service Twin production acceptance test. The CST voice service is being tested. You may hang up now."
- **Answered by Recipient:** `NO / PENDING`

---

## 5. Artifact Provenance

All raw JSON traces and logs are stored at:
`/Users/HaMi/Documents/Jason/customer twin/artifacts/acceptance/2026-11-03T00-16-14-217Z`
