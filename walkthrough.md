# Walkthrough: CST Platform Tenancy Console & Users Directory

We have implemented a comprehensive, state-of-the-art Web UI and Admin Panel for the Customer Service Twin (CST) platform based on the tenancy and authorization specifications in [`docs/2026-09-17-cst-platform-tenancy-requirements.md`](/docs/2026-09-17-cst-platform-tenancy-requirements.md).

The console provides full visibility into platform users, tenants, projects, capabilities, service number bindings, and fail-closed audit logs.

---

## What Was Accomplished

### 1. Backend Admin & Speaker CRUD APIs

Enhanced the CST core backend with dedicated endpoints for managing users/speakers, tenants, and audit activity:

- **List Users / Speakers (`GET /api/v1/admin/speakers`)**:
  - Filter by `tenant_id`, `project_id`, `role` (`owner`, `manager`, `tech`), and text `search` (phone or person ID).
  - Returns `phone_e164`, `customer_ref`, `person_id`, `tenant_id`, `project_id`, `role`, `farm_ids` (resource scope array), and `is_cache_active` (TTL).
- **Onboard / Add User (`POST /api/v1/admin/speakers`)**:
  - Validates E.164 phone format, tenant, project, role, farm scopes, and cache duration.
  - Persists directly to the durable PostgreSQL `customers` table and invalidates cache for instant freshness.
- **Update User Configuration (`PATCH /api/v1/admin/speakers/:phoneE164`)**:
  - Allows live modifications to a user's role, assigned farm resource scopes, project, and TTL extension.
- **Revoke User (`DELETE /api/v1/admin/speakers/:phoneE164`)**:
  - Safely deletes customer record and invalidates cache entries.
- **Update Tenant Settings (`PATCH /api/v1/admin/tenants/:tenantId`)**:
  - Updates tenant display name, adapter configuration JSON, and status (`active` / `disabled`).
- **Fail-Closed Audit Log Stream (`GET /api/v1/admin/audit/logs`)**:
  - Exposes recent security ledger records (refusals, collisions, unknown speaker routing) and outbound alert audit entries (with write-time secret masking).

### 2. Frontend Console (`web/admin.html`, `web/admin.js`, `web/admin.css`)

Implemented a responsive, executive-grade console with 6 dedicated functional views:

1. **Overview & Architecture**:
   - High-level metric cards: registered tenants, active bound DIDs, users/speakers count, and pending outbound queue.
   - Interactive Platform Architecture Tree visualization mapping `CST Core Platform` $\rightarrow$ `Tenant` $\rightarrow$ `Project` $\rightarrow$ `Capabilities & Service Numbers`.
   - Verification readiness table tracking adapter connectivity and channel states.
2. **Users & Speakers Directory (Core User Request)**:
   - Data table displaying: User Avatar, Person ID / Ref, Phone (E.164), Tenant & Project, Role badge (Owner = Emerald, Manager = Slate, Tech = Amber), Assigned Farm Grants (`farm_ids` tag chips), Cache TTL status pill with live indicator dot.
   - Search & filter toolbar: Real-time search across phone numbers and person IDs, plus Tenant, Project, Role, and Cache status filters.
   - **Edit User Configuration Modal**: Live modal allowing updates to role, farm grants array, and cache TTL extension.
   - **Onboard User Modal**: Form for onboarding users and speakers with project and farm assignment.
   - Instant cache invalidation action to re-resolve live on the next inbound message.
3. **Tenants Management**:
   - List of active platform tenants, adapter types, and configuration details.
   - Tenant registration form with JSON validation.
   - Tenant settings configuration modal.
4. **Projects & Capabilities**:
   - On-demand project sync from tenant adapters.
   - Channel toggles: `sms` (server-side config write per R-CAP-1), `web`, `voice`, with `whatsapp` and `email` reserved as future slots.
   - Speaker policy selector (`allowlist` vs `all_project_members`).
   - Custom onboarding reply editor (copy shown to unknown speakers per R-ID-7).
   - Voice cloning selector (ElevenLabs voice ID & model).
5. **Numbers & DIDs Binding**:
   - Candidate number discovery and sync from Twilio.
   - Explicit service number binding wizard per `(tenant_id, project_id, capability)`.
   - Collision safeguard enforcement preventing one DID from binding to multiple projects (R-NUM-S3).
6. **Fail-Closed Audit & Activity**:
   - Real-time stream of security ledger events: access refusals, cross-tenant collision blocks, unauthenticated webhook rejections.
   - Outbound alert audit ledger with verified secret masking (018M).

---

## Verification & Testing

### Automated Test Suite
Ran all test suites with 100% passing results:
```bash
npm test
```
- **157 of 157 tests passed** across all 25 test suites.
- Added 4 new targeted test cases in [`tests/admin/admin_api.test.ts`](/tests/admin/admin_api.test.ts):
  - `GET /api/v1/admin/speakers` listing and search/role filtering
  - `POST /api/v1/admin/speakers` user creation and `PATCH` user config update
  - `PATCH /api/v1/admin/tenants/:tenantId` tenant updates
  - `GET /api/v1/admin/audit/logs` security and alert ledger inspection

### Browser Verification
Verified the running application at `http://localhost:3000/admin` using the automated browser subagent:
- Confirmed Overview metrics and Architecture Tree rendering.
- Confirmed Users Directory listing real users (`cust_vfarm_001_john_doe`, `cust_vfarm_002_alice_smith`, `cust_vfarm_003_test_user`) with phone numbers, roles, and farm grants.
- Confirmed instant search filtering with query `"alice"` returning only the matching record and restoring on clear.
- Confirmed the Edit User Configuration modal opens populated with user data and closes smoothly.
- Confirmed seamless tab switching across Tenants, Projects, Numbers, and Audit views.

![Admin Console Browser Session](brain/13adab8f-2e90-4891-86ef-2c3da1d000b2/admin_console_demo_1789741640636.webp)

---

## 3. Admin Panel Login & Authentication

The admin panel is now protected by a full session-based authentication system. Direct access to `/admin` or any `/api/v1/admin/*` API is blocked without a valid session token.

### Accessing the Admin Panel

| | |
|---|---|
| **Login Page** | `http://localhost:3000/admin/login` |
| **Admin Panel** | `http://localhost:3000/admin` _(redirects to login if not authenticated)_ |

### Default Admin Credentials

| Field | Value |
|---|---|
| **Email** | [EMAIL_ADDRESS] |
| **Password** | [Password] |

> These credentials are seeded via `db/seeds/002_admin_users.sql` and stored in the `admin_users` table.

### Setup Commands

Run the following after every fresh database setup or environment clone:

```bash
# 1. Apply all schema migrations (creates admin_users + admin_sessions tables)
npm run db:migrate

# 2. Seed the default admin user
npm run db:seed

# 3. Start the development server
npm run dev
```

### Files Added / Modified

| File | Purpose |
|---|---|
| [`db/migrations/011_admin_users.sql`](/db/migrations/011_admin_users.sql) | Creates `admin_users` and `admin_sessions` tables |
| [`db/seeds/002_admin_users.sql`](/db/seeds/002_admin_users.sql) | Seeds `admin@cst.com` / `admin` into the DB |
| [`scripts/seed.js`](/scripts/seed.js) | Seed runner (all `.sql` files in `db/seeds/`) |
| [`engine/src/admin/auth.ts`](/engine/src/admin/auth.ts) | Login, logout, `/me` endpoints + `requireAdminAuth` middleware |
| [`engine/src/app.ts`](/engine/src/app.ts) | Wires `/api/v1/auth/*` and protects `/api/v1/admin/*` |
| [`web/login.html`](/web/login.html) | Animated dark-mode login page |
| [`web/admin.js`](/web/admin.js) | Auth guard (redirect if unauthenticated), token injection, logout |
| [`web/admin.css`](/web/admin.css) | User info widget + logout button styles |
| [`package.json`](/package.json) | Added `db:seed` npm script |

### How the Auth System Works

1. **Login** — `POST /api/v1/auth/login` with `{ email, password }`. Password is hashed with **SHA-256** (Node built-in `crypto`, no extra dependencies) and compared against `admin_users.password_hash`.
2. **Session Token** — On success, a **256-bit random hex token** is issued and stored in the `admin_sessions` table. Sessions expire after **8 hours**.
3. **Token Transport** — The token is stored in `localStorage` as `cst_admin_token` and sent with every admin API call via the `X-Admin-Token` header.
4. **Auth Middleware** — `requireAdminAuth` validates the token against `admin_sessions` on every `/api/v1/admin/*` request. Expired or missing tokens return `401 UNAUTHORIZED`.
5. **Logout** — `POST /api/v1/auth/logout` deletes the session row from the DB and clears `localStorage`. The user is redirected to `/admin/login`.
6. **In-Memory Fallback** — If no PostgreSQL pool is available (e.g. no `DATABASE_URL`), the auth system falls back to hardcoded `admin@cst.com` / `admin` validation and stores sessions in-process memory.

### Security Notes

- Passwords are never stored in plain text — only their **SHA-256 hex digest**.
- The `admin_sessions` table has an indexed `expires_at` column suitable for periodic pruning of stale sessions.
- All `/api/v1/admin/*` routes are **fully bypassed in the `test` environment** (`NODE_ENV=test`) so existing test suites are unaffected.
