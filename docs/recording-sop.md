# bha-cst Recording Standard Operating Procedure (SOP)

**Version**: 1.0
**Effective**: 2026-09-14
**Scope**: All video, audio, and screen-capture recordings produced by or for the bha-cst (Customer Service Twin) project — including debug sessions, demos, incident reviews, and pair-programming calls.

---

## 1. Purpose

This SOP ensures every recording is self-describing and unambiguous when reviewed out of context. Recordings that lack a stated Session Type create audit confusion and reduce the evidentiary value of the record.

---

## 2. Mandatory Opening Statement

**Every recording MUST begin with an explicit verbal and/or on-screen statement of the following fields, in order, within the first 15 seconds:**

```
SESSION TYPE : <type>
DATE         : <YYYY-MM-DD>
ENVIRONMENT  : <production | staging | local>
PARTICIPANTS : <name/role, name/role, ...>
PURPOSE      : <one sentence describing the goal of this session>
```

The Session Type MUST be the very first item stated — before any screen activity, command execution, or conversation.

---

## 3. Approved Session Type Labels

| Session Type | When to Use |
|---|---|
| `DEBUG` | Investigating a bug, tracing a failure, reading logs |
| `DEMO` | Showing a feature to stakeholders or clients |
| `INCIDENT_REVIEW` | Post-incident analysis, RCA walkthrough |
| `PAIR_PROGRAMMING` | Two or more engineers writing or reviewing code together |
| `ONBOARDING` | Walkthrough for new team members |
| `INFRA_OPS` | Infrastructure changes, deployments, DB migrations |
| `SECURITY_AUDIT` | Access review, secret rotation, penetration testing |
| `TRAINING` | Instructional material recording |

> **Rule**: Never omit the Session Type. An unlabelled recording cannot be classified, archived, or cited in an incident trail.

---

## 4. Example Opening Statement (Verbal + On-Screen)

> *"Recording start. Session Type: INCIDENT_REVIEW. Date: 2026-09-14. Environment: Production. Participants: Jason — Lead Engineer, Hamid — Infra. Purpose: Post-mortem review of vFarm telemetry outage between 14:00 and 15:30 UTC."*

The same text should be visible on-screen — in a terminal, sticky note overlay, or dedicated title card — for the first 15 seconds.

---

## 5. File Naming Convention

All recordings must follow this naming pattern:

```
<YYYY-MM-DD>_<SESSION_TYPE>_<short-description>.<ext>
```

Examples:
- `2026-09-14_INCIDENT_REVIEW_vfarm-telemetry-outage.mp4`
- `2026-09-14_DEBUG_migrate-credential-masking.mkv`
- `2026-09-14_INFRA_OPS_db-migration-006.mp4`
- `2026-09-14_PAIR_PROGRAMMING_router-intent-refactor.mp4`

---

## 6. Storage & Retention

- Recordings are stored under `/recordings/<year>/<session-type>/` in the team shared drive.
- Retention periods:
  - `DEBUG`, `PAIR_PROGRAMMING`, `TRAINING`, `ONBOARDING`: **90 days**
  - `DEMO`: **180 days**
  - `INCIDENT_REVIEW`, `SECURITY_AUDIT`, `INFRA_OPS`: **365 days** (access-controlled, no public links)

---

## 7. Compliance & Remediation

Failure to state Session Type at the start of a recording is a **process violation**. The recording must be:
1. Re-recorded with the correct opening, **or**
2. A visible title-card prepended before the recording is shared.

Recordings shared externally (clients, demos) must carry the `DEMO` label only. Any internal infra details, credentials, or security context must be cut before external distribution.
