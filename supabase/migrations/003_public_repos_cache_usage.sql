-- ==============================================================================
-- GitSimple migration 003: public repos, shared AI cache, usage metering, RAG columns
-- Run AFTER 002_security_timeline_rag.sql. Safe to re-run.
-- ==============================================================================

-- 1. Repository metadata --------------------------------------------------------
ALTER TABLE repositories ADD COLUMN IF NOT EXISTS private BOOLEAN DEFAULT false;
ALTER TABLE repositories ADD COLUMN IF NOT EXISTS github_id BIGINT;
ALTER TABLE repositories ADD COLUMN IF NOT EXISTS metadata_checked_at TIMESTAMPTZ;
ALTER TABLE repositories ADD COLUMN IF NOT EXISTS last_indexed_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_repositories_name_lower ON repositories (lower(name));
-- Unknown visibility is treated as PRIVATE until GitHub confirms it is public
-- (the app re-checks automatically the next time someone opens the repo).
ALTER TABLE repositories ALTER COLUMN private SET DEFAULT true;
UPDATE repositories SET private = true WHERE metadata_checked_at IS NULL;

-- 2. Commit columns: stored results so nothing is generated twice ---------------
ALTER TABLE commits ADD COLUMN IF NOT EXISTS brief_summary TEXT;          -- "Explain briefly"
ALTER TABLE commits ADD COLUMN IF NOT EXISTS detailed_report TEXT;        -- PDF report body
ALTER TABLE commits ADD COLUMN IF NOT EXISTS diff_excerpt TEXT;           -- cleaned diff (avoids refetching GitHub)
ALTER TABLE commits ADD COLUMN IF NOT EXISTS file_paths TEXT[] DEFAULT '{}';
ALTER TABLE commits ADD COLUMN IF NOT EXISTS related_shas TEXT[] DEFAULT '{}';
ALTER TABLE commits ADD COLUMN IF NOT EXISTS analysis_model TEXT;

-- Fill file_paths for commits stored before this migration
UPDATE commits
SET file_paths = ARRAY(
  SELECT CASE WHEN jsonb_typeof(f) = 'string' THEN f #>> '{}' ELSE f ->> 'filename' END
  FROM jsonb_array_elements(files) f
)
WHERE (file_paths IS NULL OR file_paths = '{}') AND jsonb_typeof(files) = 'array' AND jsonb_array_length(files) > 0;

CREATE INDEX IF NOT EXISTS idx_commits_file_paths ON commits USING gin (file_paths);

-- The same SHA can exist in a repo and its forks: make it unique per repository
ALTER TABLE commits DROP CONSTRAINT IF EXISTS commits_commit_sha_key;
CREATE UNIQUE INDEX IF NOT EXISTS commits_repo_sha_key ON commits (repo_id, commit_sha);

-- 3. Shared AI answer cache ----------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_cache (
    key TEXT PRIMARY KEY,                  -- sha256 of (kind, repo, commit, question, history, ...)
    kind TEXT NOT NULL,                    -- chat | ask
    repo_id UUID REFERENCES repositories(id) ON DELETE CASCADE,
    commit_sha TEXT,
    response JSONB NOT NULL,
    hits INT DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    last_hit_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_ai_cache_repo ON ai_cache (repo_id);
ALTER TABLE ai_cache ENABLE ROW LEVEL SECURITY;   -- no policies: server-only

-- 4. Usage metering (for quotas / billing / "tokens saved" stats) ----------------
CREATE TABLE IF NOT EXISTS ai_usage (
    id BIGSERIAL PRIMARY KEY,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    kind TEXT NOT NULL,                    -- brief | chat | pdf | ask | index
    cached BOOLEAN NOT NULL DEFAULT false,
    user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    requester_hash TEXT,                   -- hashed IP for guests
    repo_id UUID REFERENCES repositories(id) ON DELETE SET NULL,
    model TEXT,
    input_tokens INT DEFAULT 0,
    output_tokens INT DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_ai_usage_user ON ai_usage (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_usage_requester ON ai_usage (requester_hash, created_at DESC);
ALTER TABLE ai_usage ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users read own usage" ON ai_usage;
CREATE POLICY "Users read own usage" ON ai_usage FOR SELECT TO authenticated USING (user_id = auth.uid());

-- 5. Public repositories are readable by everyone ------------------------------
CREATE OR REPLACE FUNCTION public.can_access_repo(target_repo uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM repositories r WHERE r.id = target_repo AND r.private = false)
      OR EXISTS (
        SELECT 1 FROM user_repositories ur
        WHERE ur.repository_id = target_repo
          AND (ur.user_id = auth.uid() OR ur.assigned_by = auth.uid())
      );
$$;

DROP POLICY IF EXISTS "Members read their repositories" ON repositories;
DROP POLICY IF EXISTS "Members read commits of their repositories" ON commits;
DROP POLICY IF EXISTS "Members read chunks of their repositories" ON knowledge_chunks;
CREATE POLICY "Members read their repositories" ON repositories
  FOR SELECT TO anon, authenticated USING (public.can_access_repo(id));
CREATE POLICY "Members read commits of their repositories" ON commits
  FOR SELECT TO anon, authenticated USING (public.can_access_repo(repo_id));
CREATE POLICY "Members read chunks of their repositories" ON knowledge_chunks
  FOR SELECT TO anon, authenticated USING (public.can_access_repo(repo_id));
