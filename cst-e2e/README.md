# CST E2E Context Bundle

This bundle contains the minimal set of files and documentation required to understand and execute the real end-to-end acceptance tests for the Customer Service Twin (CST) system across SMS and Voice channels.

## Structure

- `MANIFEST.md`: Complete index of included source files, their purposes, key symbols, and dependencies.
- `CONFIG_REQUIRED.md`: Environment and integration configuration status (SET/MISSING/UNKNOWN) without secrets.
- `IDENTITY_FLOW.md`: Step-by-step trace of how inbound phone numbers map to tenant, project, vFarm person_id, and live farm grants.
- `SMS_FLOW.md`: Detailed SMS inbound → resolution → BHARAG / vFarm Telemetry → outbound Twilio delivery trace.
- `VOICE_FLOW.md`: Detailed Twilio Voice call inbound → vFarm-backed identity → speech gathering → Voice Engine trace.
- `DASHBOARD_FLOW.md`: Documentation of `cst.turn` and `cst.delivery` event publication, `turn_id` join correlation, and retry/dry-run semantics.
- `TEST_MATRIX.md`: 9-point real acceptance test scenarios and expected outcomes.
- `scripts/`: Executable helper script (`run-real-e2e.sh`) to perform non-destructive live verification against the running system.
- `source/`: Isolated, clean source files extracted from `engine/src/`.
- `evidence/`: Artifacts, correlation logs, and receipts generated during real test runs.
