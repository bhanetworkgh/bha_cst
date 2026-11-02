# Ahad -- Open Decision Watches (15 open, full detail)

Pulled live from `list_decision_watches` (owner_user_id = U0AC6RFNP3P), 2 Nov 2026. Ordered longest-waiting first, as posted in the daily digest.

---

## 1. `DW-1792685420585-9LNK` -- reminded 2 of 3 (next reminder ~Wed 4 Nov, 13:23 Lagos)
**Lane:** CST · **SOP:** SOP -- CST/BHA Lane Logging Standard (bf241a6c-b1d5-407f-a4be-2ce339d544de)
**Thread:** https://bayshorizonnetwork.slack.com/archives/C0AD3PM603T/p1792681313409909
**Created:** 2026-10-22 by Jason (U0A9V97949F)

**Decision:** Jason set CST focus and deliverables for Ahad:
1. Narrow focus to P0 (vFarm form→device link, working with Jegan) and the P1 chain (CS Twin v1, VFAM auth contract, DNS/TLS) -- treat everything else as secondary until these are done.
2. Next Codex log must include the exact DB path for person→form→device once P0 closes with Jegan.
3. Next Codex log must include at least one line on what Genie/CS Twin is now allowed and not allowed to say about SMS delivery and CST health.
4. Next Codex log must include at least one self-healing rule: what incident/degraded mode should trigger when the same failure patterns recur.

**Next step owed:** Close P0 (form→device link) with Jegan, then post the next Codex log covering the DB path, the Genie/CS Twin allowed/must-not-say line, and the self-healing rule.

**History:** Opened (more than one part, so a reply alone doesn't close it) → Ahad replied 3x on 22 Oct → reminder 1 of 3 posted 27 Oct → reminder 2 of 3 posted 28 Oct.

---

## 2. `DW-1792453482827-47MA` -- reminded 2 of 3 (next reminder ~Thu 5 Nov, 13:27 Lagos)
**Lane:** CST · **SOP:** SOP -- Engine Infra Evidence Standard (730b2e51-c259-4f0e-b809-ee3c60b206c1), section D "Logs as runbooks"
**Thread:** https://bayshorizonnetwork.slack.com/archives/C0AD3PM603T/p1792452150661999
**Created:** 2026-10-19 by Jason

**Decision:** For Ahad's next CST/infra session, the log must be traceable as a runbook: exact loop/ticket IDs, the precise error code and string (e.g. Twilio HTTP status, wrong content-type header, a snippet of the bad body), and the full test file path or command used to prove the fix, plus the mission framing he already brings. That day stays full pay; the bar applies going forward.

**Next step owed:** Next CST/infra session log: copy-pasteable exact loop/ticket IDs, precise error code/string, full test file path or command, plus mission framing -- traceable by another builder with no guessing.

**History:** Opened 19 Oct → reminder 1 of 3 posted 28 Oct → reminder 2 of 3 posted 29 Oct.

---

## 3. `DW-1792187689082-B0M2` -- reminded 2 of 3 (next reminder ~Fri 6 Nov, 00:15 Lagos)
**Lane:** CST · **SOP:** SOP -- CST x BHARAG Farm-Data Boundary (86b1d684-5a4a-4824-a74e-792ce901a086)
**Thread:** https://bayshorizonnetwork.slack.com/archives/C0AD3PM603T/p1792186848085019
**Created:** 2026-10-16 by Jason

**Decision:** Jason set a 4-part acceptance contract for Ahad's next CST/CS Twin block, approving past pay for the Twilio fix and KMG9 work but asking for at least one gate closed with precision:
1. **Voice E2E proof** -- a real authorized live call logged with Twilio number, call SID, timestamps, webhook/app logs, resolved tenant, transcript location -- distinct from simulations/health-200s.
2. **Security closure** -- close + test the 4 unauthenticated CST routes (devices, dashboard, farms, tokens→admin JWT); rotate any exposed farm keys; add regression tests.
3. **Test suite and data contracts** -- fix the circular module-init issue that regressed the suite from 57/57 to 26/185 with exact counts logged; move CST↔vFarm off fabricated mappings to real business ID + LM7W serial mappings; pin down the VFAM person↔unit authorization contract.
4. **Twin registry + monitoring** -- lock CS Twin into the CST registry (system_id, tenant_id, workspace_id, phone numbers, BHARAG key); expose metrics for Destiny's verification gate.

**Next step owed (as of latest update, 30 Oct):** Entries 393/399 stay PARTIAL -- specific gaps named: no authorized voice E2E run in the operator checklist, no signed inbound SMS acceptance, delivery callbacks failing SID→tenant/project attribution, security_ledger empty despite SECURITY_LEDGER logs, voice deadline inconsistency (abandoned/not persisted vs published outcomes), vFarm 422/404/timeout cases not reconciled, DB network still 0.0.0.0/0, migration count mismatch (Render 23 files vs 22 schema_migrations rows). Nothing so far closes any of the 4 gates. Ahad must NOT argue for acceptance yet. Instead: (1) clean up the Engine Surfacing spec (Monitoring Twin/Research Twin/Front Door) to match Jason's constraints -- real endpoint paths, the 5000ms vFarm timeout threshold, real sensor IDs, explicit non-promises; (2) then propose, in #cst, which single P1 gate he will attack next (Voice E2E vs Twilio attribution vs Security Ledger) and the exact artifact he will produce to close it. Watch moves/closes only on hard posted evidence for one of the 4 gates.

**History:** Opened 16 Oct → reminder 1 of 3 (20 Oct) → reminder 2 of 3 (25 Oct) → Ahad posted "cst-jason-consolidated-evidence.md" 30 Oct (documents production activity but closes none of the 4 gates) → Jason replied twice more (29-30 Oct) tightening what's still owed.

---

## 4. `DW-1792559119184-3A8Q` -- reminded 2 of 3 (next reminder ~Sat 7 Nov, 01:35 Lagos)
**Lane:** CST · **SOP:** SOP -- CST Phone-to-Identity Contract (b3588a57-4f34-49d9-8a0a-09db6177843f)
**Thread:** https://bayshorizonnetwork.slack.com/archives/C0ASMPYQLG3/p1792522702049669
**Created:** 2026-10-21 by Destiny (U0AEW3TBYH1)

**Decision:** Destiny asked Ahad to confirm he will link the phone number +923082113844 on the CST side once his vFarm user exists, and to tell Jegan if it needs to be linked to a different farm than the test farm.

**Next step owed:** Confirm the phone number gets linked on the CST side once the vFarm user exists, and tell Jegan if a different farm is needed. Additionally (21 Oct update): test the existing Bitwarden vFarm login (vfarm.bhanetwork.org) against what CST needs -- if anything is missing (a per-person user, a farm scope, a phone field on the user record, etc.), write the exact requirement as a small schema: which field(s) CST expects, on which object (user/farm/cabinet/system), and where/how CST reads them. Must follow the phone→identity contract (phone_number → system_id/farm_id/cabinet_id via config, no free-text farm name, no parallel user shape) -- a hard gate, not a suggestion.

**History:** Opened 21 Oct → reminder 1 of 3 posted 27 Oct → reminder 2 of 3 posted 31 Oct.

---

## 5. `DW-1792712806772-JLRL` -- reminded 1 of 3 (next reminder ~Thu 5 Nov, 10:39 Lagos)
**Lane:** CST · **SOPs:** SOP -- CST x BHARAG Farm-Data Boundary (86b1d684-5a4a-4824-a74e-792ce901a086); SOP -- CST Security and Consent as P1 Production Gates (1007a582-4b8f-4575-9172-5a06d53a5ae0)
**Thread:** https://bayshorizonnetwork.slack.com/archives/C0ASMPYQLG3/p1792702326928939
**Linked record:** LOOP-1788044070647-KMG9 (restarts the wait when it changes, closes when it closes)
**Created:** 2026-10-22 by Jason

**Decision:** Jason's ask of Ahad on the CST farm-data access audit:
1. Open the PR from `fix/vfarm-farm-level-status-without-unit-binding` to main (7 modified + 4 untracked files).
2. Keep the acceptance decision exactly as BLOCKED -- NEEDS JEGAN / UPSTREAM CONTRACT for P0 and KMG9.
3. Stop spending cycles trying to close P0 from the CST side -- Jason and Jegan now own the upstream vFarm + BHARAG contracts.

**Still owed (condensed from multiple updates, nothing dropped):**
1. Open the PR `fix/vfarm-farm-level-status-without-unit-binding` to main.
2. Send `test:true` on every automated CST test event per the events contract; log evidence (commands, counts, examples) the way Destiny did.
3. Voice/outbound acceptance stays PARTIAL until Ahad delivers: confirmed bounded DB bootstrap/retry, DB timeouts, worker heartbeat, 5-min stale-sending reclaim, 15s Twilio timeout, explicit provider-status mapping, persisted `next_retry_at`, plus a logged delivery/recovery test with event-store samples; an E2E test tying a valid signed Twilio callback to a persisted outbound row with correct attribution; fresh evidence `/health/voice` is healthy post-deploy and stays healthy; package-level triage of the 2 moderate/1 high/2 critical npm vulnerabilities with a compatible remediation path (no blind `--force`).
4. Run one CST test with live dashboard sending on (PR #6 override) so Destiny can confirm in-thread the event landed `test:true`, was classed "sent as a test" with correct reason, and stayed out of every count.
5. BHARAG key scope: pass `auth_context.allowed_workspaces` as an immediate stopgap, switch `BHARAG_CLUSTER_KEY` to the new `cst-help-read` key once Jegan's re-run is green, drop `workspaceKey`/`workspace` from the ask body.
6. KMG9 closure also needs Ahad's regression checks (CI proof disallowed workspaces aren't queried under the stopgap) + SHAs, alongside Jegan's green cluster reruns.

**28 Oct update (CST target-state acceptance):** (1) share ElevenLabs account access + Jason's cloned voice with Destiny; (2) debug in Twilio why calls aren't reaching the service and how STOP/HELP are handled; (3) produce an ElevenLabs-Agents migration plan (DB schema/memory, Twilio routing, Slack+email escalation); (4) backup/restore `bha-cst-postgres` proving consents/members/transcripts/memory survive, write upgrade-vs-move comparison+recommendation (logged to DW-1793106354268-UTR0); (5) get Jegan's eyes on that restore evidence/comparison before finalizing.

**Further 28 Oct update:** "voice is Jason's and call is connecting" is necessary but not sufficient. Still owed: (1) a short Codex-style note confirming exactly what was verified -- which numbers were called from/to, that ElevenLabs is actually serving Jason's voice on that path, that Twilio is the carrier in the middle, and observed behavior on both success and failure (timeout, error, no audio); (2) coordinate with Destiny's 30 Oct ElevenLabs/CST session -- complete any backend integration handoff, produce at least one failure-path log once that integration lands; (3) CST voice is only treated as properly stood up once the Twilio Critical Service Credit log lands on DW-1793188426632-R8TJ, Destiny's 30 Oct v1 entry lands on DW-1793194227952-90X3, and one success-path + one failure-path doc for the voice lane exist.

**History:** Opened 22 Oct → several next_step updates and Ahad replies (23-28 Oct, none closing it since it's multi-part) → reminder 1 of 3 posted 1 Nov.

---

## 6. `DW-1793289606909-UUCT` -- reminded 1 of 3 (next reminder ~Thu 5 Nov, 01:04 Lagos)
**Lane:** (none set) · **Thread:** https://bayshorizonnetwork.slack.com/archives/D0BEF6XG6SC/p1793289405397789
**Created:** 2026-10-29 by Jason

**Decision:** Jason set the bar for Ahad's two Pending Codex entries to move to approved. Both stay not approved until all parts are done and reflected in the entries, then brought back for review:
1. **Entry 393** (CST↔vFarm identity, U0AC6RFNP3P_1793130714338): fix mission-fit language distinguishing CST orchestration vs vFarm as authoritative source of farm/identity/live-state data; describe the CST↔vFarm integration accurately (which table/row/endpoint carries what, how a caller maps to a vFarm user + grant); attach record-level identity/authorization evidence instead of "tests passed" language.
2. **Entry 399** (DB/endpoint decision, U0AC6RFNP3P_1793226011533): create the explicit DB/endpoint decision record (Render/Postgres platform, access/IP-lockdown, readings endpoint contract, owner, rationale, acceptance criteria), link it from Entry 399, embed verbatim Render logs with UTC timestamps, call SID/correlation ID `CA1decc8a2aead3400c684327ec30ff44d`, the exact DB path, and the continuity/backup-vs-upgrade decision.
3. **E2E/security proof** (applies to both): keep the 404 and 7,000ms timeout as failure evidence, not E2E success; resolve the endpoint contract and device identifier validity (`/api/v1/readings/properties` vs `/api/v1/readings/latest`); log one clean successful E2E chain separately once it exists.

**Next step owed (29 Oct update):** Ahad has moved from brief to artifacts (399 decision record, Render/404-health evidence, 393 identity/authorization evidence, clean test/typecheck/build), but the watch stays open and 393/399 stay partial until he also: (1) commits and pushes the new decision/evidence files into the canonical repo branch -- nothing counts while local-only; (2) updates Entry 399 and Entry 393 (or their Codex tracking records) to reference the new artifacts explicitly and state the remaining open items (E2E voice chain, rack-sensor timeouts, KMG9 boundary evidence) as either named/dated loops with owners, or closed with evidence; (3) provides the exact file paths, the commit hash, and a short open-vs-satisfied summary.

**History:** Opened 29 Oct → next_step updated same day → reminder 1 of 3 posted 2 Nov.

---

## 7. `DW-1792496727676-IQB3` -- reminded 1 of 3 (next reminder ~Wed 4 Nov, 13:03 Lagos)
**Lane:** CST · **SOP:** SOP -- Daily Blocker Reporting, Said Out Loud in Channel (363b05c8-0654-4dcb-ab1d-eca22fd0a925)
**Thread:** https://bayshorizonnetwork.slack.com/archives/C0ASMPYQLG3/p1791852509147099
**Created:** 2026-10-20 by Jason

**Decision:** Ahad owes a genuine blocker report in this thread on the CST security/consent/verification rail -- what (if anything) is blocking him, what he needs and from whom, and by when he expects to move it. Per Jason, his earlier reply in this thread (asking for a summary) is not that report.

**Next step owed:** Post in this thread: what (if anything) is blocking, what is needed and from whom, and the date committed to for moving it -- not an acknowledgement or a request for a summary.

**History:** Opened 20 Oct → reminder 1 of 3 posted 1 Nov.

---

## 8. `DW-1793106354268-UTR0` -- watching, with a problem (held -- same-day reminder cap hit; goes on a later pass)
**Lane:** CST · **SOP:** SOP -- Infra Ask Contract: Infra-change request in bha-coordination (1afc3202-cc13-4255-9c10-90e3fa45a21f)
**Thread:** https://bayshorizonnetwork.slack.com/archives/C0ASMPYQLG3/p1793104953976509
**Linked record:** LOOP-1792104121807-XXHH (restarts the wait when it changes, closes when it closes)
**Created:** 2026-10-27 by Jason

**Decision:** Jason asked Ahad, on LOOP-1792104121807-XXHH (bha-cst-postgres, `dpg-db8he2qvcj2c73ado3s0-a`, free-plan expiry 2026-11-14T18:10:20Z), to own the analysis/evidence (not the purchase/migrate decision) and update the loop with: (1) current Render plan details -- limits and caps; (2) at least one tested backup/restore path into a sandbox DB; (3) a short "upgrade here" vs "migrate to DB X" comparison with risk, effort and downtime notes -- then propose a recommendation with those facts. No one is authorized to change the Render plan or move CST to another DB until the loop carries that evidence and a named decision owner.

**Next step owed (28 Oct update):** DB upgrade+log (part 1 of Jason's CST directive) confirmed satisfied. Before the DB is considered "safe," Ahad must, via Jegan, deliver a full backup + test restore of `bha-cst-postgres` with concrete evidence: backup artifact ID/location, restore target details, and a row-count/key-table check matching production -- passed through Jegan for review, then written onto the loop. Alongside it, a short upgrade-vs-migrate write-up is owed: why staying on the upgraded Render Postgres plan is acceptable vs migrating, the plan's limits/risks, and the conditions that would trigger a migration. (27 Oct update, folded in: the comparison must include risk, estimated downtime AND data-loss tolerance, not just risk/effort/downtime, and the final output needs a clear recommendation plus a named decision owner. Nothing in the evidence so far authorizes a plan change or migration.)

**History:** Opened 27 Oct → next_step update same day → loop changed (restarted wait) twice (27, 28 Oct) → next_step update 28 Oct.

---

## 9. `DW-1793373034142-26J5` -- watching, with a problem (held; goes on a later pass)
**Lane:** CST · **SOP:** SOP -- CST Production-Readiness: Gates Only Flip to 'Meets' With Reconstructable Evidence (525fa5e8-ffe1-4482-aa64-cf9ff0b907b2)
**Thread:** https://bayshorizonnetwork.slack.com/archives/C0AD3PM603T/p1793298443822689
**Created:** 2026-10-30 by Jason

**Decision:** Jason set 7 non-optional items for Ahad to close out CST Entry 399, as part of standing up CST properly for external partners (carriers, investors, counsel) -- not just satisfying a log:
1. Create `docs/release/cst-decision-record-2026-10-30.md` with real values, proven claims only, mark unproven as pending with a reason, align render.yaml/continuity doc with actual DB plan.
2. Resolve the 0.0.0.0/0 network access on the consent DB -- either remove it with documented rationale, or explicitly mark lockdown pending with a written reason.
3. Document the readings endpoint contract (sensor_id param, 5000ms timeout, meaning of 200/404/timeout) and replace the silent-failure catch with explicit 404 vs timeout vs other-error handling, logged and surfaced.
4. State DB plan, backup existence/retention, who approved it, and exact restore path in the continuity doc, linked from the decision record.
5. Add an acceptance criteria checklist (pass/pending) to the decision record with evidence pointers.
6. Update Entry 399 with a link to the decision record, the four Render log lines Destiny pulled on 28 Oct (verbatim + interpretation), correlation ID status (shown or explicitly "not logged yet"), and the DB write path.
7. List changed file paths and a short git diff snippet in the session log for the decision record, Entry 399 update, and render.yaml/continuity plan if corrected -- then commit cleanly and press "Send Back To Jason."

**Next step owed:** Create and commit `docs/release/cst-decision-record-2026-10-30.md` covering all 5 sections Destiny outlined, resolve the network lockdown item, fix the readings-endpoint error handling, update the continuity doc, update Entry 399 with evidence, then press "Send Back To Jason."

**History:** Opened 30 Oct, no movement yet.

---

## 10. `DW-1793380167011-MDWV` -- watching, with a problem (held; goes on a later pass)
**Lane:** CST · **Thread:** https://bayshorizonnetwork.slack.com/archives/C0ASMPYQLG3/p1793282408255389
**Created:** 2026-10-30

**Decision:** Ahad owes two things once the sensor_type-filtered fetch is in place in CST: 1) post the before vs after behavior for `/readings/latest` calls in CST, 2) post a sample of device IDs where CST correctly skips relays and reads only sensors.

**Next step owed:** After implementing the sensor_type-filtered fetch, post before/after `/readings/latest` behavior and a sample of device IDs where relays are correctly skipped.

**History:** Opened 30 Oct, no movement yet.

---

## 11. `DW-1793393849183-DN1D` -- watching, with a problem (held; goes on a later pass)
**Lane:** CST · **Thread:** https://bayshorizonnetwork.slack.com/archives/D0BDQHJHMUL/p1793393840284709
**Created:** 2026-10-30 by Jason

**Decision:** Jason told Ahad he wants to pay him, but needs serious, demonstrable progress now -- not more documentation. Three parts owed: (1) resolve the 22 vs 23 migration count discrepancy, (2) show a real production callback-attribution trace (actual correlation_id/provider_sid, not a code-path description), (3) get the Category B/C "code-level resolved" items actually production-verified, or say plainly what's blocking that.

**Next step owed:** Ahad to produce: migration count resolution, a real production callback trace, and production verification (or a clear blocker) for Category B/C items.

**History:** Opened 30 Oct → Ahad replied same day (reply never closes it; stays open until it's closed on proof): https://bayshorizonnetwork.slack.com/archives/D0BDQHJHMUL/p1793397355430089

---

## 12. `DW-1793405840064-50LF` -- watching, with a problem (held; goes on a later pass)
**Lane:** CST · **SOP:** SOP -- CST Production-Readiness: Gates Only Flip to 'Meets' With Reconstructable Evidence (68bfda00-5704-498a-880d-efa83f85c044)
**Thread:** https://bayshorizonnetwork.slack.com/archives/D0BDQHJHMUL/p1793405822182989
**Created:** 2026-10-31 by Jason

**Decision:** Ahad needs to make CST a must-ship core Engine surface: 1) ship a working deploy with a live, healthy DB; 2) verify the end-to-end SMS path (consent captured, message actually received); 3) document CST's integration points into Intake, Genie and incident/log flows, at the same standard used for the vFarm spine and Hero Rack contracts. Jason says "not quite production-ready" is no longer acceptable.

**Next step owed:** Ahad to deliver the live deploy, verified SMS path, and documented integration points.

**History:** Opened 31 Oct, no movement yet.

---

## 13. `DW-1793406530806-QJY3` -- watching, with a problem (held; goes on a later pass)
**Lane:** CST · **SOP:** SOP -- CST Loop Closure and Pay-Eligibility: Mapping from Ahad, Sign-off from Destiny (ff228052-2517-4ddf-9953-cd51d7c7fb6e)
**Thread:** https://bayshorizonnetwork.slack.com/archives/D0BDQHJHMUL/p1793406522620769
**Created:** 2026-10-31 by Jason

**Decision:** Ahad owes a log→loop mapping for the four still-open CST loops: 1) `LOOP-1793031575930-X4EI` (KMG9 authorization evidence from Jonathan), 2) `LOOP-1793031575927-LSJY` (identify specific npm packages behind the 5 vulnerabilities), 3) `LOOP-1793031575929-X6DK` (re-check /health after a full deployment), 4) `LOOP-1792104121807-XXHH` (migration-count reconciliation, not a "likely cause" theory). For each he must name the session/submission ID and the concrete evidence that satisfies it, or say plainly no session resolves it yet.

**Next step owed:** Post the mapping for all four loops (session/submission ID + evidence, or "no session yet") so Destiny can review closure and pay-eligibility.

**History:** Opened 31 Oct, no movement yet.

---

## 14. `DW-1793450974729-Q64Y` -- watching, with a problem (held; goes on a later pass)
**Lane:** CST · **Thread:** https://bayshorizonnetwork.slack.com/archives/C0ASMPYQLG3/p1793397175467509
**Created:** 2026-10-31 by Jason

**Decision:** Jason asked Ahad, after reviewing the CST evidence (migrations, tenancy, voice path), to: 1) resolve the double-003 migration discrepancy so the 22 vs 23 count and applied migrations are actually consistent, not just explained; 2) clear the "tenancy unresolved" error so production text message delivery works end-to-end for CST, not just voice; 3) support Destiny/vFarm with a fast, reliable "farm status summary" surface (record or endpoint) the ElevenLabs agent can read quickly and safely.

**Next step owed:** Resolve double-003 migration discrepancy, clear tenancy-unresolved error for texts, and deliver a fast farm-status summary surface for the ElevenLabs agent.

**History:** Opened 31 Oct, no movement yet.

---

## 15. `DW-1793381880209-HWB8` -- watching, with a problem (held; goes on a later pass)
**Lane:** CST · **Thread:** https://bayshorizonnetwork.slack.com/archives/C0ASMPYQLG3/p1793368337737139
**Created:** 2026-10-30 by Jason

**Decision:** Jason asked Ahad to confirm that CST's device/readings mapping does exactly this: filter strictly to sensor types before calling `/readings/latest`, never call `/readings/latest` for loads/relay channels/cabinets, answer state questions from fleet_status/device list only (no readings call), and for metric questions identify the sensor device then call `/readings/latest` only for that sensor.

**Next step owed:** Confirm in thread that CST's code does exactly the device-filtering/readings mapping Jason described, for both state and metric questions.

**History:** Opened 30 Oct, no movement yet.

---

*Note on "held" watches (#8-15): these are overdue for a reminder but Bays caps reminders at one per person per 12 hours across all watches -- Ahad was last reminded (on DW-1793289606909-UUCT) at 2026-11-02T00:04Z, so these go out on a later pass rather than all at once.*
