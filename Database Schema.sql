-- ==============================================================================
-- LEGACY LOOP: PostgreSQL Database Schema with pgvector
-- ==============================================================================
-- Instructions: Run this entire script in your Supabase SQL Editor.
-- It enables vector similarity search, creates tables for commits and chunks,
-- indexes 1536-dimensional embeddings with HNSW, and creates the match_documents RPC.
-- ==============================================================================
-- IMPORTANT: after running this file, also run
--   supabase/migrations/002_security_timeline_rag.sql
-- It replaces the open "USING (true)" policies below with per-user access,
-- switches embeddings to Gemini (768 dims) and adds timeline indexes.
-- ==============================================================================

-- 1. Enable required PostgreSQL extensions
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 2. Repositories Table
CREATE TABLE IF NOT EXISTS repositories (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name TEXT NOT NULL UNIQUE,
    owner TEXT NOT NULL,
    url TEXT,
    default_branch TEXT DEFAULT 'main',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Commits Table (Living Architecture Records)
CREATE TABLE IF NOT EXISTS commits (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    repo_id UUID REFERENCES repositories(id) ON DELETE CASCADE,
    commit_sha TEXT NOT NULL UNIQUE,
    short_sha TEXT NOT NULL,
    branch TEXT DEFAULT 'main',
    author_name TEXT NOT NULL,
    author_email TEXT NOT NULL,
    author_avatar TEXT,
    message TEXT NOT NULL,
    title TEXT NOT NULL,
    executive_summary TEXT NOT NULL,
    architectural_impact TEXT NOT NULL,
    breaking_changes TEXT[] DEFAULT '{}',
    affected_domains TEXT[] DEFAULT '{}',
    impact_level TEXT NOT NULL CHECK (impact_level IN ('Breaking', 'Feature', 'Refactor', 'Security', 'Performance', 'Fix')),
    stats JSONB DEFAULT '{"files_changed": 0, "additions": 0, "deletions": 0}',
    files JSONB DEFAULT '[]',
    committed_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. Knowledge Chunks Table (RAG Vector Storage)
CREATE TABLE IF NOT EXISTS knowledge_chunks (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    commit_id UUID REFERENCES commits(id) ON DELETE CASCADE,
    repo_id UUID REFERENCES repositories(id) ON DELETE CASCADE,
    chunk_content TEXT NOT NULL,
    chunk_type TEXT NOT NULL CHECK (chunk_type IN ('summary', 'diff', 'architectural_insight', 'breaking_change')),
    embedding vector(1536) NOT NULL,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 5. Performance Indexes
CREATE INDEX IF NOT EXISTS idx_commits_repo_id ON commits(repo_id);
CREATE INDEX IF NOT EXISTS idx_commits_sha ON commits(commit_sha);
CREATE INDEX IF NOT EXISTS idx_commits_committed_at ON commits(committed_at DESC);
CREATE INDEX IF NOT EXISTS idx_chunks_commit_id ON knowledge_chunks(commit_id);

-- 6. HNSW Vector Index for High-Recall Cosine Distance Search
-- (m = 16, ef_construction = 64 optimized for OpenAI text-embedding-3-small)
CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_hnsw_embedding
ON knowledge_chunks USING hnsw (embedding vector_cosine_ops)
WITH (m = 16, ef_construction = 64);

-- 7. Semantic Search RPC Function: match_documents
CREATE OR REPLACE FUNCTION match_documents (
    query_embedding vector(1536),
    match_threshold float DEFAULT 0.65,
    match_count int DEFAULT 5,
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
    affected_domains text[]
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
        c.affected_domains
    FROM knowledge_chunks kc
    JOIN commits c ON kc.commit_id = c.id
    WHERE 
        (filter_repo_id IS NULL OR kc.repo_id = filter_repo_id)
        AND (1 - (kc.embedding <=> query_embedding)) > match_threshold
    ORDER BY kc.embedding <=> query_embedding
    LIMIT match_count;
END;
$$;

-- 8. Row Level Security (RLS) Configuration
ALTER TABLE repositories ENABLE ROW LEVEL SECURITY;
ALTER TABLE commits ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_chunks ENABLE ROW LEVEL SECURITY;

-- Allow read access for application queries
CREATE POLICY "Allow public read on repositories" ON repositories FOR SELECT USING (true);
CREATE POLICY "Allow public read on commits" ON commits FOR SELECT USING (true);
CREATE POLICY "Allow public read on knowledge_chunks" ON knowledge_chunks FOR SELECT USING (true);

-- Allow service role to insert and modify (for webhook & edge functions)
CREATE POLICY "Allow service role insert on repositories" ON repositories FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow service role insert on commits" ON commits FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow service role insert on knowledge_chunks" ON knowledge_chunks FOR INSERT WITH CHECK (true);

-- 9. User Repositories Table (Linking users to repositories)
CREATE TABLE IF NOT EXISTS user_repositories (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    repository_id UUID NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    assigned_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, repository_id)
);

ALTER TABLE user_repositories ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow public read on user_repositories" ON user_repositories FOR SELECT USING (true);
CREATE POLICY "Allow service role insert on user_repositories" ON user_repositories FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow service role update on user_repositories" ON user_repositories FOR UPDATE USING (true);
CREATE POLICY "Allow service role delete on user_repositories" ON user_repositories FOR DELETE USING (true);
