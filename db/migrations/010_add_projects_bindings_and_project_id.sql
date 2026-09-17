-- Migration: 010_add_projects_bindings_and_project_id.sql
-- Feature: CST Multi-Tenant Platform — DB Tenancy Hardening
-- Closes critical gaps identified in the post-refactor schema review.
--
-- Gap 1: Durable `projects` table referencing `organizations` (durable tenant parent).
-- Gap 2: Durable `service_number_bindings` table with strict phone uniqueness.
-- Gap 3: `project_id` on conversations, messages, messages_in/out, audit, voice.
-- Gap 4: Scoped conversation uniqueness (tenant_id, project_id, customer_ref).
-- Gap 5: `customers` updated with project_id, farm_ids, and speaker cache expiry.
--
-- All statements preserve existing data safely.

-- Ensure organizations table exists (durable tenant parent from 005)
CREATE TABLE IF NOT EXISTS organizations (
  organization_id VARCHAR(64) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Seed default vFarm organization if missing
INSERT INTO organizations (organization_id, name, status)
VALUES ('tenant-vfarm-01', 'vFarm Global', 'active')
ON CONFLICT (organization_id) DO NOTHING;

-- ── 1. projects (durable registry) ──────────────────────────────────────────

CREATE TABLE IF NOT EXISTS projects (
  project_id            VARCHAR(64)  PRIMARY KEY,
  tenant_id             VARCHAR(64)  NOT NULL REFERENCES organizations(organization_id) ON DELETE CASCADE,
  name                  VARCHAR(255) NOT NULL,
  status                VARCHAR(32)  NOT NULL DEFAULT 'active',
  tenant_org_id         VARCHAR(64),
  capabilities          JSONB        NOT NULL DEFAULT '{"sms": false}'::jsonb,
  speaker_policy        VARCHAR(32)  NOT NULL DEFAULT 'allowlist',
  onboarding_reply      TEXT,
  elevenlabs_voice_id   TEXT,
  elevenlabs_model_id   TEXT,
  voice_enabled         BOOLEAN      NOT NULL DEFAULT FALSE,
  synced_at             TIMESTAMPTZ,
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_projects_tenant') THEN
    ALTER TABLE projects ADD CONSTRAINT fk_projects_tenant
      FOREIGN KEY (tenant_id) REFERENCES organizations(organization_id) ON DELETE CASCADE;
  END IF;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_projects_tenant ON projects(tenant_id);
CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(tenant_id, status);

-- ── 2. service_number_bindings (durable binding registry) ────────────────────

CREATE TABLE IF NOT EXISTS service_number_bindings (
  phone_e164    VARCHAR(32)  PRIMARY KEY,
  tenant_id     VARCHAR(64)  NOT NULL REFERENCES organizations(organization_id) ON DELETE CASCADE,
  project_id    VARCHAR(64)  NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  capability    VARCHAR(32)  NOT NULL DEFAULT 'sms',
  status        VARCHAR(32)  NOT NULL DEFAULT 'bound',
  sid           VARCHAR(128),
  bound_at      TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  unbound_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_snb_tenant') THEN
    ALTER TABLE service_number_bindings ADD CONSTRAINT fk_snb_tenant
      FOREIGN KEY (tenant_id) REFERENCES organizations(organization_id) ON DELETE CASCADE;
  END IF;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_snb_tenant_project ON service_number_bindings(tenant_id, project_id);
CREATE INDEX IF NOT EXISTS idx_snb_status          ON service_number_bindings(status);

-- ── 3. Add project_id to conversations ───────────────────────────────────────

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS project_id VARCHAR(64);

-- Backfill project_id for conversations
UPDATE conversations
  SET project_id = 'proj-vfarm-main'
  WHERE project_id IS NULL AND (tenant_id = 'tenant-vfarm-01' OR organization_id = 'tenant-vfarm-01');

-- Drop old unique constraint (tenant_id, customer_ref) — too broad across projects.
-- The new constraint scopes uniqueness to one open conversation per speaker per project.
ALTER TABLE conversations DROP CONSTRAINT IF EXISTS unq_conversations_tenant_customer;
ALTER TABLE conversations DROP CONSTRAINT IF EXISTS unq_conversations_tenant_project_customer;
ALTER TABLE conversations ADD CONSTRAINT unq_conversations_tenant_project_customer
  UNIQUE (tenant_id, project_id, customer_ref);

CREATE INDEX IF NOT EXISTS idx_conversations_tenant_project ON conversations(tenant_id, project_id);

-- ── 4. Add project_id to messages ─────────────────────────────────────────────

ALTER TABLE messages ADD COLUMN IF NOT EXISTS project_id VARCHAR(64);
UPDATE messages SET project_id = 'proj-vfarm-main' WHERE project_id IS NULL AND tenant_id = 'tenant-vfarm-01';
CREATE INDEX IF NOT EXISTS idx_messages_tenant_project ON messages(tenant_id, project_id);

-- ── 5. Add project_id to messages_in ──────────────────────────────────────────

ALTER TABLE messages_in ADD COLUMN IF NOT EXISTS project_id VARCHAR(64);
UPDATE messages_in SET project_id = 'proj-vfarm-main' WHERE project_id IS NULL AND tenant_id = 'tenant-vfarm-01';
CREATE INDEX IF NOT EXISTS idx_messages_in_tenant_project ON messages_in(tenant_id, project_id);

-- ── 6. Add project_id to messages_out ─────────────────────────────────────────

ALTER TABLE messages_out ADD COLUMN IF NOT EXISTS project_id VARCHAR(64);
UPDATE messages_out SET project_id = 'proj-vfarm-main' WHERE project_id IS NULL AND tenant_id = 'tenant-vfarm-01';
CREATE INDEX IF NOT EXISTS idx_messages_out_tenant_project ON messages_out(tenant_id, project_id);

-- ── 7. Add project_id to alert_audit_log ──────────────────────────────────────

ALTER TABLE alert_audit_log ADD COLUMN IF NOT EXISTS project_id VARCHAR(64);
UPDATE alert_audit_log SET project_id = 'proj-vfarm-main' WHERE project_id IS NULL AND tenant_id = 'tenant-vfarm-01';
CREATE INDEX IF NOT EXISTS idx_alert_audit_project ON alert_audit_log(project_id, created_at DESC);

-- ── 8. Add project_id to voice_deliveries ─────────────────────────────────────

ALTER TABLE voice_deliveries ADD COLUMN IF NOT EXISTS project_id VARCHAR(64);
UPDATE voice_deliveries SET project_id = 'proj-vfarm-main' WHERE project_id IS NULL AND tenant_id = 'tenant-vfarm-01';
CREATE INDEX IF NOT EXISTS idx_voice_deliveries_project ON voice_deliveries(project_id, created_at DESC);

-- ── 9. customers: add project_id, farm_ids[], and TTL ────────────────────────

-- Step A: add columns
ALTER TABLE customers ADD COLUMN IF NOT EXISTS project_id              VARCHAR(64);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS farm_ids               JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS speaker_cache_expires_at TIMESTAMPTZ;

-- Step B: backfill project_id for existing vFarm seed rows
UPDATE customers
  SET project_id = 'proj-vfarm-main'
  WHERE project_id IS NULL
    AND (tenant_id = 'tenant-vfarm-01' OR organization_id = 'tenant-vfarm-01');

-- Step C: backfill farm_ids from legacy single farm_id column (best-effort)
UPDATE customers
  SET farm_ids = JSONB_BUILD_ARRAY(farm_id)
  WHERE farm_id IS NOT NULL
    AND farm_ids = '[]'::jsonb;

-- Step D: Unique constraint per (tenant_id, project_id, phone_e164).
-- Preserves existing (tenant_id, phone_e164) constraint for backwards compat with 006.
ALTER TABLE customers DROP CONSTRAINT IF EXISTS unq_customers_tenant_project_phone;
ALTER TABLE customers ADD CONSTRAINT unq_customers_tenant_project_phone
  UNIQUE (tenant_id, project_id, phone_e164);

CREATE INDEX IF NOT EXISTS idx_customers_tenant_project_phone ON customers(tenant_id, project_id, phone_e164);
CREATE INDEX IF NOT EXISTS idx_customers_ttl ON customers(speaker_cache_expires_at)
  WHERE speaker_cache_expires_at IS NOT NULL;


-- ── 10. Seed default vFarm projects into durable projects table ──────────────
--   Mirrors the CoreRegistry.resetToDefault() in-memory state so DB + in-memory
--   are consistent on first deploy. Future syncs go through the admin pull API.

INSERT INTO projects (project_id, tenant_id, name, status, tenant_org_id, capabilities, speaker_policy, onboarding_reply, voice_enabled, synced_at)
VALUES
  (
    'proj-vfarm-main',
    'tenant-vfarm-01',
    'vFarm Austin HQ',
    'active',
    'org-vfarm-austin',
    '{"sms": true, "voice": true}'::jsonb,
    'allowlist',
    'Welcome to vFarm Support! We received your message. A specialist will assist you shortly.',
    TRUE,
    NOW()
  ),
  (
    'proj-vfarm-dallas',
    'tenant-vfarm-01',
    'vFarm Dallas Operations',
    'active',
    'org-vfarm-dallas',
    '{"sms": true}'::jsonb,
    'allowlist',
    'Welcome to vFarm Dallas Support! Contact your site manager for access.',
    FALSE,
    NOW()
  )
ON CONFLICT (project_id) DO UPDATE SET
  name             = EXCLUDED.name,
  status           = EXCLUDED.status,
  capabilities     = EXCLUDED.capabilities,
  speaker_policy   = EXCLUDED.speaker_policy,
  onboarding_reply = EXCLUDED.onboarding_reply,
  voice_enabled    = EXCLUDED.voice_enabled,
  synced_at        = EXCLUDED.synced_at,
  updated_at       = NOW();

-- ── 11. Seed default service number bindings ──────────────────────────────────
--   Mirrors CoreRegistry.resetToDefault() bind calls.

INSERT INTO service_number_bindings (phone_e164, tenant_id, project_id, capability, status, bound_at)
VALUES
  ('+19715885823', 'tenant-vfarm-01', 'proj-vfarm-main',   'sms', 'bound', NOW()),
  ('+19715885824', 'tenant-vfarm-01', 'proj-vfarm-dallas', 'sms', 'bound', NOW())
ON CONFLICT (phone_e164) DO UPDATE SET
  tenant_id  = EXCLUDED.tenant_id,
  project_id = EXCLUDED.project_id,
  capability = EXCLUDED.capability,
  status     = EXCLUDED.status;

-- ── 12. auto-update updated_at trigger on projects ───────────────────────────

CREATE OR REPLACE FUNCTION set_projects_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_projects_updated_at ON projects;
CREATE TRIGGER trg_projects_updated_at
  BEFORE UPDATE ON projects
  FOR EACH ROW EXECUTE FUNCTION set_projects_updated_at();
