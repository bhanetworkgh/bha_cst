-- Migration: 011_admin_users.sql
-- Feature: CST Admin Panel — Authenticated Login
-- Creates admin_users table for admin panel session-based authentication.
-- Passwords are stored as SHA-256 hex hashes (Node built-in crypto, no bcrypt dependency).
-- Run: npm run db:migrate

CREATE TABLE IF NOT EXISTS admin_users (
  id            SERIAL        PRIMARY KEY,
  email         VARCHAR(255)  NOT NULL UNIQUE,
  password_hash VARCHAR(64)   NOT NULL,          -- SHA-256 hex digest of the password
  name          VARCHAR(255)  NOT NULL DEFAULT 'Admin',
  role          VARCHAR(64)   NOT NULL DEFAULT 'superadmin',
  is_active     BOOLEAN       NOT NULL DEFAULT TRUE,
  last_login    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMPTZ   NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_admin_users_email ON admin_users(email);

-- Auto-update updated_at on row modification
CREATE OR REPLACE FUNCTION update_admin_users_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_admin_users_updated_at ON admin_users;
CREATE TRIGGER trg_admin_users_updated_at
  BEFORE UPDATE ON admin_users
  FOR EACH ROW EXECUTE FUNCTION update_admin_users_updated_at();

-- admin_sessions — lightweight token-based session store
-- Token is a random 64-char hex string (256-bit entropy).
CREATE TABLE IF NOT EXISTS admin_sessions (
  token        VARCHAR(128)  PRIMARY KEY,
  admin_id     INTEGER       NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  email        VARCHAR(255)  NOT NULL,
  expires_at   TIMESTAMPTZ   NOT NULL,
  created_at   TIMESTAMPTZ   NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_admin_sessions_admin   ON admin_sessions(admin_id);
CREATE INDEX IF NOT EXISTS idx_admin_sessions_expires ON admin_sessions(expires_at);
