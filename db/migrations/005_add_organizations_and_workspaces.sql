-- Migration: 005_add_organizations_and_workspaces.sql
-- Establishes Organization as the top-level tenant security boundary with Workspaces/Projects nested beneath it.

CREATE TABLE IF NOT EXISTS organizations (
  organization_id VARCHAR(64) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS workspaces (
  workspace_id VARCHAR(64) PRIMARY KEY,
  organization_id VARCHAR(64) NOT NULL REFERENCES organizations(organization_id),
  name VARCHAR(255) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Seed default vFarm Organization and Workspace
INSERT INTO organizations (organization_id, name, status)
VALUES ('tenant-vfarm-01', 'vFarm Organization', 'active')
ON CONFLICT (organization_id) DO NOTHING;

INSERT INTO workspaces (workspace_id, organization_id, name)
VALUES ('ws-vfarm-main', 'tenant-vfarm-01', 'vFarm Main Workspace')
ON CONFLICT (workspace_id) DO NOTHING;

-- Add organization_id and workspace_id to core tables
ALTER TABLE systems ADD COLUMN IF NOT EXISTS organization_id VARCHAR(64);
ALTER TABLE systems ADD COLUMN IF NOT EXISTS workspace_id VARCHAR(64);

ALTER TABLE customers ADD COLUMN IF NOT EXISTS organization_id VARCHAR(64);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS workspace_id VARCHAR(64);

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS organization_id VARCHAR(64);
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS workspace_id VARCHAR(64);

ALTER TABLE messages ADD COLUMN IF NOT EXISTS organization_id VARCHAR(64);
ALTER TABLE messages ADD COLUMN IF NOT EXISTS workspace_id VARCHAR(64);

ALTER TABLE messages_in ADD COLUMN IF NOT EXISTS organization_id VARCHAR(64);
ALTER TABLE messages_in ADD COLUMN IF NOT EXISTS workspace_id VARCHAR(64);

ALTER TABLE messages_out ADD COLUMN IF NOT EXISTS organization_id VARCHAR(64);
ALTER TABLE messages_out ADD COLUMN IF NOT EXISTS workspace_id VARCHAR(64);

-- Create composite index for organization and workspace lookups
CREATE INDEX IF NOT EXISTS idx_customers_org_ws_phone ON customers(organization_id, workspace_id, phone_e164);
CREATE INDEX IF NOT EXISTS idx_conversations_org_ws ON conversations(organization_id, workspace_id);
