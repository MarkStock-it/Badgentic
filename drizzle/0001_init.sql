-- 0001_init.sql — initial schema (spec §3).
-- gen_random_uuid() needs pgcrypto on PG<13; Render managed Postgres is PG15+.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id              CHAR(64) PRIMARY KEY,
  canvas_domain   VARCHAR(255) NOT NULL,
  canvas_user_id  VARCHAR(64)  NOT NULL,
  display_name    VARCHAR(255) NOT NULL DEFAULT '',
  email           VARCHAR(255) NOT NULL DEFAULT '',
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  last_seen_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_domain_user ON users (canvas_domain, canvas_user_id);

CREATE TABLE IF NOT EXISTS sessions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         CHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  canvas_token_enc TEXT NULL,
  token_iv        TEXT NULL,
  token_tag       TEXT NULL,
  ai_keys_enc     JSONB NULL,
  expires_at      TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);

CREATE TABLE IF NOT EXISTS jobs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         CHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind            VARCHAR(32) NOT NULL,
  state           VARCHAR(32) NOT NULL DEFAULT 'DISCOVERED',
  title           VARCHAR(500) NOT NULL DEFAULT '',
  canvas_course_id      BIGINT NULL,
  canvas_assignment_id  BIGINT NULL,
  session_id      UUID NULL,
  manifest        JSONB NULL,
  plan            JSONB NULL,
  result          JSONB NULL,
  failure_reason  TEXT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_jobs_user_state ON jobs (user_id, state, created_at DESC);

CREATE TABLE IF NOT EXISTS runs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id          UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  attempt         SMALLINT NOT NULL DEFAULT 1,
  state           VARCHAR(32) NOT NULL DEFAULT 'RUNNING',
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at     TIMESTAMPTZ NULL,
  error           TEXT NULL
);
CREATE INDEX IF NOT EXISTS idx_runs_job ON runs (job_id, attempt);

CREATE TABLE IF NOT EXISTS run_logs (
  id              BIGSERIAL PRIMARY KEY,
  run_id          UUID NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  seq             INT NOT NULL,
  type            VARCHAR(64) NOT NULL,
  detail          JSONB NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_logs_run ON run_logs (run_id, seq);

CREATE TABLE IF NOT EXISTS artifacts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id          UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  run_id          UUID NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  filename        VARCHAR(255) NOT NULL,
  mime_type       VARCHAR(128) NOT NULL,
  size_bytes      INT NOT NULL,
  content         TEXT NOT NULL,
  checksum        CHAR(64) NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_artifacts_job ON artifacts (job_id);

CREATE TABLE IF NOT EXISTS approvals (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id          UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  run_id          UUID NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  type            VARCHAR(32) NOT NULL,
  artifact_id     UUID NULL REFERENCES artifacts(id) ON DELETE SET NULL,
  payload         JSONB NULL,
  state           VARCHAR(16) NOT NULL DEFAULT 'PENDING',
  decided_at      TIMESTAMPTZ NULL,
  expires_at      TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_approvals_job ON approvals (job_id, state);

CREATE TABLE IF NOT EXISTS canvas_cache (
  user_id         CHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  resource        VARCHAR(64) NOT NULL,
  payload         JSONB NOT NULL,
  fetched_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (user_id, resource)
);
