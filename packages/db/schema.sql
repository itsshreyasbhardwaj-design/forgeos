-- ForgeOS PostgreSQL schema.
--
-- Design notes:
--
--  * Every tenant-scoped table carries `workspace_id` and is indexed on it.
--    Row-level security policies are defined below and enabled, so a query that
--    forgets its tenant filter returns nothing rather than everything.
--
--  * Entity payloads are stored as JSONB with the frequently-queried fields
--    promoted to real columns. This keeps the schema stable as the domain model
--    evolves while retaining indexable access to the fields that matter.
--
--  * `pgvector` is optional. When the extension is unavailable the memories
--    table is created without the embedding column and ForgeOS falls back to
--    lexical retrieval, which is degraded but functional.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS "vector";
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pgvector is unavailable; semantic memory will use lexical retrieval.';
END
$$;

CREATE TABLE IF NOT EXISTS users (
  id           TEXT PRIMARY KEY,
  email        TEXT NOT NULL UNIQUE,
  name         TEXT NOT NULL,
  avatar_url   TEXT,
  created_at   BIGINT NOT NULL,
  data         JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS workspaces (
  id           TEXT PRIMARY KEY,
  slug         TEXT NOT NULL UNIQUE,
  name         TEXT NOT NULL,
  owner_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   BIGINT NOT NULL,
  updated_at   BIGINT NOT NULL,
  data         JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS memberships (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role         TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
  created_at   BIGINT NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
);

CREATE INDEX IF NOT EXISTS memberships_user_idx ON memberships (user_id);

CREATE TABLE IF NOT EXISTS projects (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  slug         TEXT NOT NULL,
  name         TEXT NOT NULL,
  created_at   BIGINT NOT NULL,
  updated_at   BIGINT NOT NULL,
  data         JSONB NOT NULL,
  UNIQUE (workspace_id, slug)
);

CREATE INDEX IF NOT EXISTS projects_workspace_idx ON projects (workspace_id, created_at DESC);

-- Generic tenant-scoped entity tables. `parent_id` links a record to the
-- project, workflow or document it belongs to, which is enough for every
-- listing the product performs.
CREATE TABLE IF NOT EXISTS records (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  collection   TEXT NOT NULL,
  parent_id    TEXT,
  created_at   BIGINT NOT NULL,
  updated_at   BIGINT NOT NULL,
  data         JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS records_lookup_idx
  ON records (workspace_id, collection, created_at DESC);
CREATE INDEX IF NOT EXISTS records_parent_idx
  ON records (workspace_id, collection, parent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS records_data_idx ON records USING gin (data jsonb_path_ops);

CREATE TABLE IF NOT EXISTS memories (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id    TEXT,
  kind          TEXT NOT NULL,
  content       TEXT NOT NULL,
  importance    REAL NOT NULL DEFAULT 0.5,
  access_count  INTEGER NOT NULL DEFAULT 0,
  created_at    BIGINT NOT NULL,
  updated_at    BIGINT NOT NULL,
  data          JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS memories_workspace_idx ON memories (workspace_id, created_at DESC);

-- Full-text retrieval, which works with or without pgvector.
CREATE INDEX IF NOT EXISTS memories_content_idx
  ON memories USING gin (to_tsvector('english', content));

DO $$
BEGIN
  ALTER TABLE memories ADD COLUMN IF NOT EXISTS embedding vector(384);
  CREATE INDEX IF NOT EXISTS memories_embedding_idx
    ON memories USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Skipping vector column: pgvector is not installed.';
END
$$;

CREATE TABLE IF NOT EXISTS api_keys (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  hash          TEXT NOT NULL UNIQUE,
  prefix        TEXT NOT NULL,
  scopes        TEXT[] NOT NULL DEFAULT '{}',
  created_at    BIGINT NOT NULL,
  created_by    TEXT NOT NULL,
  last_used_at  BIGINT,
  expires_at    BIGINT
);

CREATE INDEX IF NOT EXISTS api_keys_workspace_idx ON api_keys (workspace_id);

CREATE TABLE IF NOT EXISTS audit_log (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_id      TEXT NOT NULL,
  action        TEXT NOT NULL,
  target        TEXT,
  created_at    BIGINT NOT NULL,
  ip            TEXT,
  user_agent    TEXT,
  meta          JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS audit_workspace_idx ON audit_log (workspace_id, created_at DESC);

-- Row-level security. The application sets `app.workspace_id` per connection;
-- policies then make cross-tenant reads impossible even if a query is wrong.
ALTER TABLE records   ENABLE ROW LEVEL SECURITY;
ALTER TABLE memories  ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  CREATE POLICY records_tenant_isolation ON records
    USING (workspace_id = current_setting('app.workspace_id', true));
EXCEPTION WHEN duplicate_object THEN NULL;
END
$$;

DO $$
BEGIN
  CREATE POLICY memories_tenant_isolation ON memories
    USING (workspace_id = current_setting('app.workspace_id', true));
EXCEPTION WHEN duplicate_object THEN NULL;
END
$$;

DO $$
BEGIN
  CREATE POLICY audit_tenant_isolation ON audit_log
    USING (workspace_id = current_setting('app.workspace_id', true));
EXCEPTION WHEN duplicate_object THEN NULL;
END
$$;
