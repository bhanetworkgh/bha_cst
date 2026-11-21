# CST Live Production Telephony Acceptance Report

> **Execution Date:** 2026-11-13T13:40:28.628Z  
> **Target Production Service:** https://bha-cst-7u9e.onrender.com  
> **Deployed Production SHA:** `441d2b3f4a49c983f45131c229888a60116b9437`  
> **Local HEAD SHA:** `9ed7e1b7a8c094c5c64d038431b290970ecb6042`  
> **Authorized Test Recipient:** `+9230***3844`  
> **Sender Caller ID:** `+19715885823`  
> **Tenant / Project Attribution:** `00000000-0000-0000-0000-000000000001` / `proj-vfarm-main`  

---

## 1. Executive Summary & Verdicts

| Subsystem / Operation | Verdict | Twilio Provider SID | Initial Status | Final Reconciled Status | Delivery Attribution |
|---|---|---|---|---|---|
| **Preflight Validation** | **`PASS`** | N/A | Ready | Ready | Verified |
| **Twilio Live SMS** | **`PASS`** | `SM35...c762` | `queued` | `sent` | Scoped project & tenant |
| **Twilio Outbound Voice Call** | **`NOT_TESTED`** | `(empty)` | `not_tested` | `not_tested` | Scoped project & tenant |

---

## 2. Preflight Health & Configuration Evidence

- **Production Health Probe:** `PASS` (HTTP 200 OK ({"status":"ok","service":"bha-cst-engine"}))
- **Voice Subsystem Readiness:** `PASS` (Voice lane ready, clone configured: Hmy9...esiM)
- **Twilio Credentials Integrity:** `PASS` (Account status: `active`)
- **Caller ID Ownership:** `PASS` (Owned Number: +19715885823 (Voice: true, SMS: true))
- **Database & Admin Readiness:** `PASS` (Admin verification healthy: 1 bound numbers, transport: healthy)

---

## 3. Real SMS Test Record

- **Test Run ID:** `CST-LIVE-SMS-1794577227412-aac9b098`
- **Correlation ID:** `corr_CST-LIVE-SMS-1794577227412-aac9b098`
- **CST Message ID:** `msg_CST-LIVE-SMS-1794577227412-aac9b098`
- **Twilio Message SID:** `SM351e015208037f527b63f43158ffc762`
- **Request Timestamp (UTC):** `2026-11-13T13:40:27.412Z`
- **Twilio Initial Status:** `queued`
- **Final Delivery Status:** `sent`
- **Carrier Price / Cost:** `N/A`
- **Error Code / Details:** `None`

---

## 4. Real Outbound Voice Call Record

- **Test Run ID:** `N/A`
- **Correlation ID:** `N/A`
- **CST Voice Delivery ID:** `N/A`
- **Twilio Call SID:** `N/A`
- **Request Timestamp (UTC):** `N/A`
- **Call Initial Status:** `N/A`
- **Call Final Status:** `N/A`
- **Call Duration:** `undefined seconds`
- **Announcement Text Played:**
  > "N/A"
- **Answered by Recipient:** `NO / PENDING`

---

## 5. Artifact Provenance

All raw JSON traces and logs are stored at:
`/Users/HaMi/Documents/Jason/customer twin/artifacts/acceptance/2026-11-13T13-40-24-504Z`
