-- ==============================================================================
-- GitSimple: COMPLETE schema for a NEW Supabase project (self-hosting / Docker)
-- Paste into the Supabase SQL Editor and run once.
-- Existing installs: run migrations/002_*.sql and migrations/003_*.sql instead.
-- ==============================================================================

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Profiles (one per auth user) -------------------------------------------------
CREATE TABLE IF NOT EXISTS profiles (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    email TEXT,
    role TEXT NOT NULL DEFAULT 'manager' CHECK (role IN ('manager', 'employee', 'intern')),
    manager_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
    github_token TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_profiles_manager ON profiles(manager_id);
CREATE INDEX IF NOT EXISTS idx_profiles_email ON profiles(email);

-- New sign-ups become managers of their own workspace; invited users get the invited role
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, email, role)
  VALUES (
    NEW.id,
    NEW.email,
    CASE WHEN NEW.raw_user_meta_data->>'role' IN ('manager', 'employee', 'intern')
         THEN NEW.raw_user_meta_data->>'role' ELSE 'manager' END
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Repositories -------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS repositories (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name TEXT NOT NULL UNIQUE,              -- owner/repo
    owner TEXT NOT NULL,
    url TEXT,
    default_branch TEXT DEFAULT 'main',
    private BOOLEAN DEFAULT true,          -- unknown = private until GitHub confirms
    github_id BIGINT,
    metadata_checked_at TIMESTAMPTZ,
    last_indexed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_repositories_name_lower ON repositories (lower(name));

-- Commits (AI analysis, stored once and shared) ---------------------------------
CREATE TABLE IF NOT EXISTS commits (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    repo_id UUID REFERENCES repositories(id) ON DELETE CASCADE,
    commit_sha TEXT NOT NULL,
    short_sha TEXT NOT NULL,
    branch TEXT DEFAULT 'main',
    author_name TEXT NOT NULL,
    author_email TEXT NOT NULL,
    author_avatar TEXT,
    message TEXT NOT NULL,
    title TEXT NOT NULL,
    brief_summary TEXT,
    executive_summary TEXT NOT NULL,
    architectural_impact TEXT NOT NULL,
    breaking_changes TEXT[] DEFAULT '{}',
    affected_domains TEXT[] DEFAULT '{}',
    impact_level TEXT NOT NULL CHECK (impact_level IN ('Breaking', 'Feature', 'Refactor', 'Security', 'Performance', 'Fix')),
    stats JSONB DEFAULT '{"files_changed": 0, "additions": 0, "deletions": 0}',
    files JSONB DEFAULT '[]',
    file_paths TEXT[] DEFAULT '{}',
    related_shas TEXT[] DEFAULT '{}',
    diff_excerpt TEXT,
    detailed_report TEXT,
    analysis_model TEXT,
    committed_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS commits_repo_sha_key ON commits (repo_id, commit_sha);
CREATE INDEX IF NOT EXISTS idx_commits_sha ON commits(commit_sha);
CREATE INDEX IF NOT EXISTS idx_commits_repo_committed ON commits(repo_id, committed_at DESC);
CREATE INDEX IF NOT EXISTS idx_commits_impact_level ON commits(impact_level);
CREATE INDEX IF NOT EXISTS idx_commits_file_paths ON commits USING gin (file_paths);

-- RAG vector store (768-dim embeddings) -----------------------------------------
CREATE TABLE IF NOT EXISTS knowledge_chunks (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    commit_id UUID REFERENCES commits(id) ON DELETE CASCADE,
    repo_id UUID REFERENCES repositories(id) ON DELETE CASCADE,
    chunk_content TEXT NOT NULL,
    chunk_type TEXT NOT NULL CHECK (chunk_type IN ('summary', 'diff', 'architectural_insight', 'breaking_change')),
    embedding vector(768) NOT NULL,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_chunks_commit_id ON knowledge_chunks(commit_id);
CREATE INDEX IF NOT EXISTS idx_chunks_repo_id ON knowledge_chunks(repo_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_hnsw_embedding
  ON knowledge_chunks USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);

CREATE OR REPLACE FUNCTION match_documents (
    query_embedding vector(768),
    match_threshold float DEFAULT 0.5,
    match_count int DEFAULT 8,
    filter_repo_id uuid DEFAULT NULL
)
RETURNS TABLE (
    id uuid, commit_id uuid, repo_id uuid, chunk_content text, chunk_type text, metadata jsonb,
    similarity float, commit_sha text, short_sha text, commit_title text, author_name text,
    impact_level text, affected_domains text[], committed_at timestamptz
)
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY
    SELECT kc.id, kc.commit_id, kc.repo_id, kc.chunk_content, kc.chunk_type, kc.metadata,
           (1 - (kc.embedding <=> query_embedding))::float AS similarity,
           c.commit_sha, c.short_sha, c.title, c.author_name, c.impact_level, c.affected_domains, c.committed_at
    FROM knowledge_chunks kc
    JOIN commits c ON kc.commit_id = c.id
    WHERE (filter_repo_id IS NULL OR kc.repo_id = filter_repo_id)
      AND (1 - (kc.embedding <=> query_embedding)) > match_threshold
    ORDER BY kc.embedding <=> query_embedding
    LIMIT match_count;
END;
$$;
REVOKE EXECUTE ON FUNCTION match_documents(vector, float, int, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION match_documents(vector, float, int, uuid) TO service_role;

-- Workspace membership ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_repositories (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    repository_id UUID NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    assigned_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, repository_id)
);
CREATE INDEX IF NOT EXISTS idx_user_repositories_assigned_by ON user_repositories(assigned_by);

-- Shared AI answer cache + usage metering ----------------------------------------
CREATE TABLE IF NOT EXISTS ai_cache (
    key TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    repo_id UUID REFERENCES repositories(id) ON DELETE CASCADE,
    commit_sha TEXT,
    response JSONB NOT NULL,
    hits INT DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    last_hit_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_ai_cache_repo ON ai_cache (repo_id);

CREATE TABLE IF NOT EXISTS ai_usage (
    id BIGSERIAL PRIMARY KEY,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    kind TEXT NOT NULL,
    cached BOOLEAN NOT NULL DEFAULT false,
    user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    requester_hash TEXT,
    repo_id UUID REFERENCES repositories(id) ON DELETE SET NULL,
    model TEXT,
    input_tokens INT DEFAULT 0,
    output_tokens INT DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_ai_usage_user ON ai_usage (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_usage_requester ON ai_usage (requester_hash, created_at DESC);

-- Row Level Security (the server uses the service-role key and bypasses RLS) -----
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE repositories ENABLE ROW LEVEL SECURITY;
ALTER TABLE commits ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_repositories ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_usage ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.can_access_repo(target_repo uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM repositories r WHERE r.id = target_repo AND r.private = false)
      OR EXISTS (SELECT 1 FROM user_repositories ur
                 WHERE ur.repository_id = target_repo AND (ur.user_id = auth.uid() OR ur.assigned_by = auth.uid()));
$$;

DROP POLICY IF EXISTS "Users read own profile" ON profiles;
DROP POLICY IF EXISTS "Members read their repositories" ON repositories;
DROP POLICY IF EXISTS "Members read commits of their repositories" ON commits;
DROP POLICY IF EXISTS "Members read chunks of their repositories" ON knowledge_chunks;
DROP POLICY IF EXISTS "Users read their own repo assignments" ON user_repositories;
DROP POLICY IF EXISTS "Users read own usage" ON ai_usage;

CREATE POLICY "Users read own profile" ON profiles FOR SELECT TO authenticated USING (id = auth.uid());
CREATE POLICY "Members read their repositories" ON repositories FOR SELECT TO anon, authenticated USING (public.can_access_repo(id));
CREATE POLICY "Members read commits of their repositories" ON commits FOR SELECT TO anon, authenticated USING (public.can_access_repo(repo_id));
CREATE POLICY "Members read chunks of their repositories" ON knowledge_chunks FOR SELECT TO anon, authenticated USING (public.can_access_repo(repo_id));
CREATE POLICY "Users read their own repo assignments" ON user_repositories FOR SELECT TO authenticated USING (user_id = auth.uid() OR assigned_by = auth.uid());
CREATE POLICY "Users read own usage" ON ai_usage FOR SELECT TO authenticated USING (user_id = auth.uid());
