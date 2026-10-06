# CST Real E2E Scripts

This directory contains executable scripts to facilitate the real end-to-end acceptance testing of CST against live upstream services (vFarm, Twilio, BHARAG, Engine Dashboard).

## Available Scripts

### `run-real-e2e.sh`
Executes safe, non-destructive live verification against the running CST instance:
- Verifies CST health and tenant/project bindings.
- Verifies live vFarm connectivity, organization membership, and real farm grants.
- Executes real SMS pipeline verification for authorized, unauthorized, and unknown caller states.
- Executes real Voice pipeline verification confirming `CoreRegistry.resolveSpeaker` vFarm-backed path.
- Verifies Dashboard `cst.turn` and `cst.delivery` emission and `turn_id` join correlation.

## Usage

```bash
# Make executable
chmod +x cst-e2e/scripts/run-real-e2e.sh

# Run against local running CST instance (port 3000)
./cst-e2e/scripts/run-real-e2e.sh
```
