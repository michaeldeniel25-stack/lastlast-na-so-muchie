-- SchoolDocs PostgreSQL schema. server.js creates these tables automatically at startup.
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  email VARCHAR(160) NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role VARCHAR(20) NOT NULL CHECK (role IN ('student', 'registrar')),
  lrn VARCHAR(12) UNIQUE,
  grade VARCHAR(40),
  section VARCHAR(60),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT users_lrn_format CHECK (lrn IS NULL OR lrn ~ '^[0-9]{12}$')
);
CREATE TABLE IF NOT EXISTS requests (
  id TEXT PRIMARY KEY,
  student_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  student_name VARCHAR(100) NOT NULL,
  lrn VARCHAR(12),
  grade VARCHAR(40),
  section VARCHAR(60),
  document_type VARCHAR(100) NOT NULL,
  purpose VARCHAR(100) NOT NULL,
  copies SMALLINT NOT NULL CHECK (copies BETWEEN 1 AND 3),
  notes VARCHAR(500) NOT NULL DEFAULT '',
  status VARCHAR(30) NOT NULL DEFAULT 'Pending',
  registrar_note VARCHAR(500) NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  picked_up_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS request_history (
  id BIGSERIAL PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  status VARCHAR(30) NOT NULL,
  note VARCHAR(500) NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS requests_student_created_idx ON requests(student_id, created_at DESC);
CREATE INDEX IF NOT EXISTS requests_status_created_idx ON requests(status, created_at DESC);
CREATE INDEX IF NOT EXISTS request_history_request_idx ON request_history(request_id, created_at ASC);
