# Form A/B Field Contract

**Loop:** LOOP-1788044070646-ZNJA  
**Owner:** Kavin (CST/Genie consumer)

## Status
No existing Form A/B contract found in repository. Upstream contract confirmation required from Kavin. Below is the consumer-side expectation; fields marked `EXTERNAL_CONFIRMATION_REQUIRED`.

## Expected fields (to be confirmed)

| Field | Type | Required | Source | Owner | Privacy | Consumer |
|---|---|---|---|---|---|---|
| form_id | string | required | kiosk/mobile | Kavin | internal | CST, Genie |
| form_type | enum(A,B) | required | kiosk/mobile | Kavin | internal | CST, Genie |
| submission_id | string | required | kiosk/mobile | Kavin | internal | CST, Genie |
| submitted_at | timestamptz | required | kiosk/mobile | Kavin | internal | CST, Genie |
| tenant_id | string | required | vFarm | vFarm | internal | CST |
| project_id | string | required | vFarm | vFarm | internal | CST |
| speaker_ref | string | required | vFarm identity | vFarm | PII | CST |
| answers | object | required | user | user | PII | Genie |

## Example Genie questions depending on these fields
1. "What was the last Form A submission for farm X?"
2. "Show me Form B answers with pH > 7."
3. "How many Form A vs Form B submissions this week?"
4. "Which speaker submitted Form B most recently?"
5. "Summarize Form A answers for tenant Y."

## CST/Genie consumption
CST resolves tenant/project/speaker via vFarm; Genie queries within authorized scope. No duplicate source of truth.
