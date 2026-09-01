# bha-cst Architecture & System Boundaries

`bha-cst` (Customer Service Twin) is a multi-tenant conversation engine designed to handle customer communications across multiple BHA systems. System #1 is vFarm.

For complete details on execution, per-message flows, and database schemas, see [System Architecture & Implementation Guide](system-architecture-and-guide.md).

## Architecture Overview

```
bha-cst/
├── docs/               System documentation & isolation guide
├── engine/             Core TypeScript Express engine & transport workers
│   ├── config/         Environment & logger setup
│   ├── middleware/     Server-side tenant isolation gate
│   ├── transport/      Twilio webhook (inbound) & worker (outbound)
│   ├── identity/       vFarm customer registry resolver
│   ├── systems/        Systems registry
│   ├── handler/        Canned echo / logic seam
│   ├── conversations/  Conversation state & transcripts
│   └── incidents/      BHARAG incidents.v0 filing seam
├── db/                 Database migrations & seeds
└── tests/              Isolation, transport, and integration test suites
```

## System Responsibilities & Boundaries

### What `bha-cst` Holds
- **Systems Registry**: Registered tenant systems (vFarm = system #1) with per-system numbers and configuration.
- **Conversations & Messages**: Transcripts, state (open/closed/waiting), customer_ref (opaque).
- **Transport Queues**: `messages_in` and `messages_out`.

### What `bha-cst` Does NOT Hold
- **Incidents**: Filed directly into BHARAG `incidents.v0` (`subsystem=CUSTOMER_TWIN`, `engine=VFARM`). CST holds only `incident_id`.
- **Identity**: Resolved via the tenant's registry API (`vFarm resolve-by-phone`).
- **Knowledge**: BHARAG RAG ask endpoint.
- **Media**: Signed URLs from Media Server.

## Tenancy Isolation & Security Rules (GAP-AUTH-01 Compliance)

> **1. Organization Boundary**: Organization is the top-level tenant boundary.
> **2. Workspaces/Projects**: Workspaces/projects exist inside an organization.
> **3. Workspace Isolation**: Workspace/project access cannot cross organization boundaries.
> **4. Identity Rule**: Caller phone numbers are routing hints, not authentication credentials.
> **5. Known/Unknown Rule**: Only onboarded users receive personalized/account-level information.
> **6. Server-Side Roles**: Roles are server-resolved (`owner`, `manager`, `tech`).
> **7. Role Matrix**: Each role has explicit permissions.
> **8. Step-Up Rule**: Sensitive write/action operations require step-up authentication regardless of role.
> **9. BHARAG Cluster**: CST uses BHARAG Cluster Search rather than selecting an arbitrary workspace.
> **10. Server Scope Authority**: Organization/workspace scope cannot be supplied or overridden by customer or LLM.
> **11. Incidents Ownership**: Incidents remain owned by BHARAG `incidents.v0`.
> **12. Fail Closed**: Unresolved or conflicting tenancy scope produces an immediate refusal.

### Roles & Authorization Model
- **owner**: Full read, view status, BHARAG cluster search, file incidents, manage workspace users & permissions, perform sensitive operations (**with step-up auth only**).
- **manager**: Read context, view status, BHARAG cluster search, file incidents, operational actions (**with step-up auth only**).
- **tech**: Read context, view status, BHARAG cluster search, investigate issues, file incidents. Cannot manage users/roles or execute control actions.
- **unknown**: Safe generic onboarding response (`onboarding_reply`); zero account/device access.

1. **Receiving Phone Number**: For inbound SMS, the receiving `To` phone number is the sole server-side tenancy decision.
2. **Twilio Signature Verification**: Verified BEFORE any database access.
3. **Fail Closed**: Any unknown receiving number or missing tenant scope produces an immediate refusal with structured audit logs.

## Endpoints Summary

| Endpoint | Method | Content-Type | Description | Success Response |
|---|---|---|---|---|
| `/webhooks/twilio/sms` | `POST` | `application/x-www-form-urlencoded` | Twilio inbound webhook with signature validation & tenant gate | `204 No Content` |
| `/webhooks/twilio/delivery-status` | `POST` | `application/x-www-form-urlencoded` | Outbound delivery callback handling | `204 No Content` |
| `/health` | `GET` | `application/json` | Engine service health check | `200 OK` |

See [docs/system-architecture-and-guide.md](system-architecture-and-guide.md#6-api-endpoints--requestresponse-schemas) for full request body parameters and JSON error schemas.
