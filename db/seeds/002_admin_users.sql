-- Seed: 002_admin_users.sql
-- Creates the default CST Admin Panel superadmin user.
--
-- Credentials:
--   Email:    admin@cst.com
--   Password: admin
--   Hash:     SHA-256("admin") = 8c6976e5b5410415bde908bd4dee15dfb167a9c873fc4bb8a81f6f2ab448a918
--
-- Run: psql $DATABASE_URL -f db/seeds/002_admin_users.sql
--   Or: npm run db:seed  (if script is configured)

INSERT INTO admin_users (email, password_hash, name, role, is_active)
VALUES (
  'admin@cst.com',
  '8c6976e5b5410415bde908bd4dee15dfb167a9c873fc4bb8a81f6f2ab448a918',  -- SHA-256("admin")
  'CST Super Admin',
  'superadmin',
  TRUE
)
ON CONFLICT (email) DO UPDATE
  SET password_hash = EXCLUDED.password_hash,
      name          = EXCLUDED.name,
      role          = EXCLUDED.role,
      is_active     = EXCLUDED.is_active,
      updated_at    = CURRENT_TIMESTAMP;
