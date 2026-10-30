# Changes Done (Current Branch: fix/dashboard-test-isolation)

## Commits on this branch (vs main)
1. **1da43a2** - fix(cst): preserve test traffic markers in dashboard events
   - Added optional `test: boolean` to `CstTurnSchema` and `CstDeliverySchema` in contracts
   - In `CoreEngine` and `CstDeliveryPublisher`, mark events with `test: true` when running in test runner (`isTestRunner()`)
   - Added `tests/contracts/test_traffic_marking.test.ts` to verify marker propagation through serialization

2. **f17ab02** - fix(cst): complete test traffic and operational verification  
   - Added temporary `CST_COMPLETE_PENDING_WORK_REPORT.md`, `CST_COMPLETE_REMAINING_WORK_REPORT.md` (superseded by `docs/release/CST_REMAINING_GAPS_CLOSURE_REPORT.md` and `docs/release/task.md`; removed in a later cleanup pass)

3. **ca3bb15** - test(kmg9,outbound): add boundary and operational readiness tests
   - Added `tests/regression/kmg9_phase3_additional.test.ts` (KMG9 boundary verification)
   - Added `tests/transport/outbound_phase5_additional.test.ts` (outbound operational readiness)
   - Updated `CST_COMPLETE_PENDING_WORK_REPORT.md`

4. **181c44c** - feat(admin): add read-only dashboard publisher status endpoint and UI indicator
   - Added dashboard publisher status endpoint in `engine/src/admin/routes.ts`
   - Added UI indicator in `web/admin.js`

5. **cd2ce3d** - fix(dashboard): default to dry-run for remote dashboard URLs in Vitest runs
   - Updated `engine/src/publishers/dashboard.ts`

## Summary of Code Changes
- **Test traffic separation**: Events from test runner are explicitly marked with `test: true` to help dashboard distinguish automated tests from real traffic
- **KMG9 hardening**: Already in place from previous commits (farm fallback removed, intent routing fixed) - verified with new tests
- **Outbound reliability**: Enhanced callback handling, monotonic status updates, attribution from persisted rows, fail-closed behavior - verified with tests
- **Observability**: Admin endpoint to check dashboard publisher status
- **Test coverage**: Added comprehensive tests for traffic marking, KMG9 boundaries, outbound operations

All tests pass (967 passed, 6 skipped). No production data modified.
