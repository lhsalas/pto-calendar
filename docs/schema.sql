-- PTO / Vacation Calendar App Database Schema
-- MVP rules enforced by application logic:
-- - Users are seeded manually and authenticate with email/password.
-- - Multi-day PTO uses day_part = 'all_day'.
-- - PTO cannot start or end on a weekend.
-- - Weekends inside multi-day PTO ranges count and are displayed as continuous PTO.
-- - PTO ranges cannot overlap another PTO entry for the same user.
-- - PTO notes are returned only to the owner or team leads.
-- - Audit logging for update/delete actions is included in MVP.

CREATE TABLE users (
  id UUID PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  email VARCHAR(255) NOT NULL UNIQUE,
  role VARCHAR(20) NOT NULL CHECK (role IN ('member', 'team_lead')),
  color_code VARCHAR(20) NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE pto_requests (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  day_part VARCHAR(20) NOT NULL CHECK (day_part IN ('morning', 'evening', 'all_day')),
  note TEXT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  CHECK (end_date >= start_date),
  CHECK (start_date = end_date OR day_part = 'all_day')
);

CREATE INDEX idx_pto_requests_user_id ON pto_requests(user_id);
CREATE INDEX idx_pto_requests_start_date ON pto_requests(start_date);
CREATE INDEX idx_pto_requests_end_date ON pto_requests(end_date);
CREATE INDEX idx_pto_requests_date_range ON pto_requests(start_date, end_date);

CREATE TABLE audit_logs (
  id UUID PRIMARY KEY,
  actor_user_id UUID NOT NULL REFERENCES users(id),
  action VARCHAR(50) NOT NULL,
  entity_type VARCHAR(50) NOT NULL,
  entity_id UUID NOT NULL,
  details JSONB NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audit_logs_actor_user_id ON audit_logs(actor_user_id);
CREATE INDEX idx_audit_logs_entity ON audit_logs(entity_type, entity_id);

-- Optional seed examples
-- INSERT INTO users (id, name, email, role, color_code, password_hash)
-- VALUES
--   ('11111111-1111-1111-1111-111111111111', 'Team Lead', 'lead@example.com', 'team_lead', '#3B82F6', 'hashed-password'),
--   ('22222222-2222-2222-2222-222222222222', 'Developer One', 'dev1@example.com', 'member', '#10B981', 'hashed-password');
