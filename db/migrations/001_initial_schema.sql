-- Database migration 001_initial_schema.sql
-- Table: systems (Systems Registry)
CREATE TABLE IF NOT EXISTS systems (
  system_id VARCHAR(64) PRIMARY KEY,
  tenant_id VARCHAR(64) NOT NULL UNIQUE,
  name VARCHAR(255) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'active',
  phone_numbers JSONB NOT NULL DEFAULT '[]'::jsonb,
  onboarding_reply TEXT NOT NULL,
  resolve_endpoint_url TEXT,
  bharag_workspace_key TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Table: conversations
CREATE TABLE IF NOT EXISTS conversations (
  conversation_id VARCHAR(64) PRIMARY KEY,
  tenant_id VARCHAR(64) NOT NULL REFERENCES systems(tenant_id),
  system_id VARCHAR(64) NOT NULL REFERENCES systems(system_id),
  customer_ref VARCHAR(255) NOT NULL,
  channel VARCHAR(32) NOT NULL DEFAULT 'sms',
  state VARCHAR(32) NOT NULL DEFAULT 'open',
  incident_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_conversations_tenant_customer ON conversations(tenant_id, customer_ref);

-- Table: messages (transcripts)
CREATE TABLE IF NOT EXISTS messages (
  message_id VARCHAR(64) PRIMARY KEY,
  conversation_id VARCHAR(64) NOT NULL REFERENCES conversations(conversation_id),
  tenant_id VARCHAR(64) NOT NULL REFERENCES systems(tenant_id),
  direction VARCHAR(16) NOT NULL, -- 'inbound' | 'outbound'
  from_e164 VARCHAR(32) NOT NULL,
  to_e164 VARCHAR(32) NOT NULL,
  body TEXT NOT NULL,
  media_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
  provider_sid VARCHAR(128),
  delivery_status VARCHAR(32) NOT NULL DEFAULT 'received',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_messages_tenant ON messages(tenant_id);

-- Table: messages_in (Transport queue & deduplication ledger)
CREATE TABLE IF NOT EXISTS messages_in (
  message_id VARCHAR(128) PRIMARY KEY, -- Twilio MessageSid for deduplication
  tenant_id VARCHAR(64) NOT NULL REFERENCES systems(tenant_id),
  from_e164 VARCHAR(32) NOT NULL,
  to_e164 VARCHAR(32) NOT NULL,
  body TEXT NOT NULL,
  media JSONB NOT NULL DEFAULT '[]'::jsonb,
  received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  status VARCHAR(32) NOT NULL DEFAULT 'enqueued',
  correlation_id VARCHAR(128) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_in_tenant ON messages_in(tenant_id);

-- Table: messages_out (Outbound transport queue)
CREATE TABLE IF NOT EXISTS messages_out (
  id VARCHAR(64) PRIMARY KEY,
  tenant_id VARCHAR(64) NOT NULL REFERENCES systems(tenant_id),
  to_e164 VARCHAR(32) NOT NULL,
  body TEXT NOT NULL,
  media_url TEXT,
  correlation_id VARCHAR(128) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'pending', -- pending, sent, failed, refused
  retry_count INT NOT NULL DEFAULT 0,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  sent_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_messages_out_tenant ON messages_out(tenant_id);
