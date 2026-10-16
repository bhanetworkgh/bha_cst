# KMG9 Ready Check
- Router correctly classifies farm-specific as status; only uses bound farm/unit from identity.unit_context (no user text override). Unbound/unauthorized → refuse; fail-closed.
- Connector: no BHARAG fallback on auth errors, upstream errors, or missing live client (explicit log messages).
- Regression tests: 9/9 passing (tests/regression/kmg9_farm_isolation.test.ts).
- Typecheck/build clean; full suite 584/590 passing.
- Live acceptance still required (Jason) with correlation IDs and evidence per cst-kmg9-live-test-instructions.md.
