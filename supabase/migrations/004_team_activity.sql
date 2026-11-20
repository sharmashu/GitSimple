-- GitSimple: Team Activity (manager view of team history and work progress)
-- Safe to run more than once.

-- Which commit an AI request was about (for "commits opened" history).
-- Only the commit ID is stored, never the question text.
ALTER TABLE ai_usage ADD COLUMN IF NOT EXISTS commit_sha TEXT;
CREATE INDEX IF NOT EXISTS idx_ai_usage_user_created ON ai_usage (user_id, created_at DESC) WHERE user_id IS NOT NULL;

-- GitHub username of each member, saved at sign-in, so their commits can be matched
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS github_login TEXT;
CREATE INDEX IF NOT EXISTS idx_profiles_github_login ON profiles (lower(github_login));

-- GitHub username of each commit author (set for newly analysed commits)
ALTER TABLE commits ADD COLUMN IF NOT EXISTS author_login TEXT;
CREATE INDEX IF NOT EXISTS idx_commits_author_login ON commits (lower(author_login));

-- Managers may read the usage rows of their own team (the app reads them server-side,
-- but this keeps the rule in the database too)
DROP POLICY IF EXISTS "Managers read team usage" ON ai_usage;
CREATE POLICY "Managers read team usage" ON ai_usage FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles p WHERE p.id = ai_usage.user_id AND p.manager_id = auth.uid()));
