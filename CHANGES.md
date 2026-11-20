# GitSimple: change log

## Round 4: Team Activity for managers
- New **Team Activity** page (`/dashboard/team`, managers only), with a 7 / 30 / 90-day period.
  - Team overview: members, how many were active, commits explored, commits shipped (+/- lines).
  - Per member: status (active today / N days ago / inactive), commits opened, Oracle chats, PDF reports,
    repo questions, repos explored, commits shipped, impact mix, and two bar charts:
    activity in GitSimple and commits shipped over time.
  - Member detail: day-by-day history (what they opened, on which repo and commit), where they worked
    (per-repository table), and every commit they shipped with its AI summary.
- Usage rows now record the commit ID (`ai_usage.commit_sha`) and a signed-in user opening a repository
  (`kind = 'open'`, at most once per 15 minutes per repo). Question text is never stored.
- GitHub username saved at sign-in (`profiles.github_login`) and for each analysed commit (`commits.author_login`),
  so commits are matched to members by username, email (including GitHub noreply addresses) or name.
- A manager can only see members whose `manager_id` is them, enforced in the page and by a new RLS policy.
- Upgrade: run `supabase/migrations/004_team_activity.sql`. The app keeps working before the migration is run.

## Round 3: Chrome extension removed
- The browser extension is no longer part of the project. All features are used through the web app.

## Round 2: public + private modes, RAG everywhere, caching, multi-LLM, Docker

### Two ways to use it
- **Public repos: no account.** Paste a URL (or `owner/repo`) on the home page. Commits, Explain, Oracle chat, PDF and Ask all work.
- **Private repos: Sign in with GitHub.** Access is checked against GitHub with the user's own permissions.
  Opened private repos are added to the user's dashboard (Timeline / Ask). After login, users return to the repo they were viewing.

### RAG in every feature
- Explain briefly, Oracle chat, PDF and Ask the Repo all use history from the database:
  earlier commits that touched the same files (exact SQL match) plus semantically similar commits (pgvector).
- Commits nobody analysed yet are analysed on demand. Repos are indexed automatically on the first "Ask" (latest 5 now, up to 25 in the background).
- Answers and reports cite the commits they used, as clickable sources.

### Token / speed optimisations
- 1 AI call per commit instead of 2: the brief and the structured analysis come from the same call.
- Commit analyses, PDF reports and chat/ask answers are stored and shared by everyone (`ai_cache` table + in-memory layer).
- Simultaneous identical requests share one AI call. Diffs are stored (no repeat GitHub calls). Lockfiles, binaries and build output are stripped from prompts.
- The commit list shows already-analysed summaries instantly. Commit lists and GitHub permission checks are briefly cached.
- Rate limits only apply when tokens are actually spent.

### SaaS
- Usage metering (`ai_usage`), with a dashboard card showing requests, % served from cache and tokens.
- Configurable guest and user limits. Health endpoint `/api/health`. Security headers. Safe login redirects.

### Bring your own keys
- `lib/llm.ts`: Gemini, any OpenAI-compatible API (OpenAI, Groq, OpenRouter, Together, Ollama…) or Anthropic.
- Embeddings: Gemini or OpenAI-compatible (768-dim).
- `Dockerfile` + `docker-compose.yml` (optional local Ollama profile). `supabase/schema.sql` for a fresh Supabase project.

### Database (run `supabase/migrations/003_public_repos_cache_usage.sql`)
- New columns on commits: brief_summary, detailed_report, diff_excerpt, file_paths, related_shas, analysis_model.
- New columns on repositories: private, github_id, metadata_checked_at, last_indexed_at.
- Commits are now unique per (repo, sha), so forks work. New tables `ai_cache` and `ai_usage`. Public repos are readable through RLS.

### UI
- New home page: public/private explanation, example repos, Commits / Ask tabs, impact badges, "Load older commits".
- Markdown rendering for AI answers. Polished multi-page PDF (summary box, breaking changes, related commits, page numbers).

## Round 1
- Security fixes (RLS, authenticated AI routes, webhook signature, SSRF, token logging).
- Commit Timeline, Track a Repository, Ask the Repo.
