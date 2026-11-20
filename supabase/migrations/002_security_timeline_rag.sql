-- ==============================================================================
-- GitSimple migration 002: security lockdown + timeline + Gemini embeddings
-- Run this once in the Supabase SQL Editor (after "Database Schema.sql").
-- Safe to re-run.
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 1. Row Level Security
--    Before: every table had "USING (true)" policies, so anyone holding the public
--    anon key could read every team's commits (including private repos) and insert
--    rows. The app does all writes with the service-role key, which bypasses RLS,
--    so normal users only need narrow read access.
-- ------------------------------------------------------------------------------

-- Remove every existing policy on these tables (names differ between setups)
DO $$
DECLARE pol record;
BEGIN
  FOR pol IN
    SELECT policyname, tablename FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename IN ('repositories', 'commits', 'knowledge_chunks', 'user_repositories', 'profiles')
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', pol.policyname, pol.tablename);
  END LOOP;
END $$;

ALTER TABLE repositories      ENABLE ROW LEVEL SECURITY;
ALTER TABLE commits           ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_chunks  ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_repositories ENABLE ROW LEVEL SECURITY;
ALTER TABLE profiles          ENABLE ROW LEVEL SECURITY;

-- Helper: can the current user see this repository?
-- (assigned to them, or they are the manager who assigned/tracked it)
CREATE OR REPLACE FUNCTION public.can_access_repo(target_repo uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM user_repositories ur
    WHERE ur.repository_id = target_repo
      AND (ur.user_id = auth.uid() OR ur.assigned_by = auth.uid())
  );
$$;

CREATE POLICY "Members read their repositories" ON repositories
  FOR SELECT TO authenticated USING (public.can_access_repo(id));

CREATE POLICY "Members read commits of their repositories" ON commits
  FOR SELECT TO authenticated USING (public.can_access_repo(repo_id));

CREATE POLICY "Members read chunks of their repositories" ON knowledge_chunks
  FOR SELECT TO authenticated USING (public.can_access_repo(repo_id));

CREATE POLICY "Users read their own repo assignments" ON user_repositories
  FOR SELECT TO authenticated USING (user_id = auth.uid() OR assigned_by = auth.uid());

-- Profiles hold GitHub tokens: a user may only read their own row.
CREATE POLICY "Users read own profile" ON profiles
  FOR SELECT TO authenticated USING (id = auth.uid());

-- No INSERT / UPDATE / DELETE policies on purpose: only the server (service role) writes.

-- ------------------------------------------------------------------------------
-- 2. Columns / indexes used by the webhook and the timeline
-- ------------------------------------------------------------------------------
ALTER TABLE repositories ADD COLUMN IF NOT EXISTS private BOOLEAN DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_commits_repo_committed ON commits(repo_id, committed_at DESC);
CREATE INDEX IF NOT EXISTS idx_commits_impact_level ON commits(impact_level);
CREATE INDEX IF NOT EXISTS idx_chunks_repo_id ON knowledge_chunks(repo_id);
CREATE INDEX IF NOT EXISTS idx_user_repositories_assigned_by ON user_repositories(assigned_by);

-- ------------------------------------------------------------------------------
-- 3. Switch embeddings to Gemini (gemini-embedding-001 @ 768 dimensions)
--    The old schema expected 1536-dim OpenAI vectors, but nothing ever generated
--    them, so the table is emptied before changing the column size.
-- ------------------------------------------------------------------------------
DROP INDEX IF EXISTS idx_knowledge_chunks_hnsw_embedding;
DROP FUNCTION IF EXISTS match_documents(vector, float, int, uuid);

DO $$
BEGIN
  IF (SELECT atttypmod FROM pg_attribute
      WHERE attrelid = 'public.knowledge_chunks'::regclass AND attname = 'embedding') <> 768 THEN
    TRUNCATE knowledge_chunks;
    ALTER TABLE knowledge_chunks ALTER COLUMN embedding TYPE vector(768);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_hnsw_embedding
ON knowledge_chunks USING hnsw (embedding vector_cosine_ops)
WITH (m = 16, ef_construction = 64);

CREATE OR REPLACE FUNCTION match_documents (
    query_embedding vector(768),
    match_threshold float DEFAULT 0.5,
    match_count int DEFAULT 8,
    filter_repo_id uuid DEFAULT NULL
)
RETURNS TABLE (
    id uuid,
    commit_id uuid,
    repo_id uuid,
    chunk_content text,
    chunk_type text,
    metadata jsonb,
    similarity float,
    commit_sha text,
    short_sha text,
    commit_title text,
    author_name text,
    impact_level text,
    affected_domains text[],
    committed_at timestamptz
)
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY
    SELECT
        kc.id,
        kc.commit_id,
        kc.repo_id,
        kc.chunk_content,
        kc.chunk_type,
        kc.metadata,
        (1 - (kc.embedding <=> query_embedding))::float AS similarity,
        c.commit_sha,
        c.short_sha,
        c.title AS commit_title,
        c.author_name,
        c.impact_level,
        c.affected_domains,
        c.committed_at
    FROM knowledge_chunks kc
    JOIN commits c ON kc.commit_id = c.id
    WHERE
        (filter_repo_id IS NULL OR kc.repo_id = filter_repo_id)
        AND (1 - (kc.embedding <=> query_embedding)) > match_threshold
    ORDER BY kc.embedding <=> query_embedding
    LIMIT match_count;
END;
$$;

-- Only the server calls this (it checks repo access first)
REVOKE EXECUTE ON FUNCTION match_documents(vector, float, int, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION match_documents(vector, float, int, uuid) TO service_role;
