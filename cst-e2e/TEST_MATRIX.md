# CST Real E2E Acceptance Test Matrix

This matrix defines the 9 acceptance scenarios evaluated during live verification.

---

| # | Test Scenario | Channel | Caller Identity / Farm Input | Expected Outcome | Verification Criteria |
|---|---|---|---|---|---|
| **1** | **Real SMS + Authorized Farm** | SMS | Registered caller (`+923082113844`) asking status of granted farm (`21dde23e-f7f6-46bc-9b54-e97fabaaafd7`) | **PASS** (Answered) | Real farm telemetry / sensor data returned in SMS body. `cst.turn.status = 'ANSWERED'`. |
| **2** | **Real SMS + Unauthorized Farm** | SMS | Registered caller (`+923082113844`) asking status of ungranted farm (e.g. `ed95e120-74c4-4126-a2e9-0e4ffa9275e6`) | **PASS** (Refused) | Explicit refusal text returned; NO telemetry leaked. `cst.turn.status = 'REFUSED'`. |
| **3** | **Real SMS + Unknown Caller** | SMS | Unregistered phone (`+15559990001`) sending query | **PASS** (Restricted) | Onboarding / fallback reply returned; no farm data accessible. `is_known = false`. |
| **4** | **Real Voice + Authorized Farm** | Voice | Registered caller (`+923082113844`) asking status on voice call | **PASS** (Spoken) | TwiML generated with speech synthesis of authorized telemetry. `CoreRegistry.resolveSpeaker` called. |
| **5** | **Real Voice + Unauthorized Farm** | Voice | Registered caller asking about ungranted farm via voice | **PASS** (Refused) | Speech synthesis delivers polite access denial; no sensor metrics spoken. |
| **6** | **Real Voice + Unknown Caller** | Voice | Unregistered phone calling Voice number | **PASS** (Restricted) | Generic greeting / site manager contact instructions spoken; no internal data exposed. |
| **7** | **Real Dashboard `cst.turn`** | Dashboard | Ingested turn event from test #1 | **PASS** (Emitted) | Valid JSON payload conforming to `CstTurnEventSchema` sent to `ENGINE_DASHBOARD_URL`. |
| **8** | **Real Dashboard `cst.delivery`** | Dashboard | Ingested delivery event from test #1 | **PASS** (Emitted) | Valid delivery receipt conforming to `CstDeliveryEventSchema` sent to Dashboard. |
| **9** | **`turn_id` Correlation** | Dashboard | Comparison of #7 and #8 | **PASS** (Correlated) | `cst.turn.turn_id === cst.delivery.turn_id` exactly matching originating message SID. |
