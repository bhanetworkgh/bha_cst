# Remaining Actions (Named Owners)

## Immediate owner actions required

**Jason (KMG9 live acceptance):**
- Run the three KMG9 live tests per cst-kmg9-live-test-instructions.md against deployed instance. Return correlation IDs, responses, logs (if accessible), and confirmation no BHARAG fallback for farm-specific cases. Also confirm deployed SHA.

**Claude on Render / Ops/DB Admin (HOFE staging):**
- Provide staging evidence for 017/018: schema_migrations rows (filename, checksum, applied_at), migrate.js logs from staging run, and SMS consent E2E results. Indicate environment (staging) and whether applied successfully.

**Platform Team / DB Owner (Database continuity):**
- Confirm Render Postgres expiry for bha-cst DB (Nov 14 2026 verification), automated backups/PITR status + retention, current Render plan (free/starter/prod), upgrade decision/timeline, and assigned continuity owner.

**Domain Admin / Platform Ops (OYP9):**
- Provide CNAME resolution (dig) for cst.* and cst-admin.* to Render target, custom domain TLS cert status, Render plan confirmation (starter+), and evidence of no hibernation behavior.

**Ahad/Jegan (KMG9 external):**
- As applicable per DW-19QD/DW-53P7, provide vFarm smoke acceptance (Ahad/Jason) and BHARAG cluster-key scope verification (Jegan) with artifacts.

## SMS/Voice (with approval)
- Require explicit approval + test recipient + window. Collect delivery receipts/callbacks, voice call completion, signature validation evidence. Not performed without authorization.

## Four Pillars
- Local verified; live confirmation only where non-destructive and authorized.

## Status summary
- Local: PASS (584/590, typecheck/build clean). Farm routing verified.
- Live public: /health 200, root→api-docs 200; no 503 now.
- External: All listed above BLOCKED pending evidence.
