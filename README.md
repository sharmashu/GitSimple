# GitSimple

Understand any GitHub repository in plain English.

- **Explain briefly**: a short summary of each commit, linked to the earlier commits it builds on.
- **Oracle chat**: ask about one commit or the whole repository. Answers cite the commits they come from.
- **PDF reports**: a detailed engineering report per commit, including how it fits the project history.
- **Commit Timeline** (signed in): every push to your tracked repos, with impact levels and breaking-change alerts.
- **Teams**: managers invite employees/interns and assign repositories.

Public repositories work **without an account**. Private repositories need **Sign in with GitHub**.

---

## How it works

```
GitHub ──► fetch commit once ──► ONE AI call (summary + analysis, with related history as context)
                                   │
                                   ├─► commits table        (brief, analysis, cleaned diff, files)
                                   └─► knowledge_chunks     (768-dim embeddings for semantic search)

Explain briefly ─► stored brief (0 tokens if anyone analysed this commit before)
Oracle chat     ─► diff + analysis + same-file history + semantic matches ─► answer ─► ai_cache
PDF report      ─► stored report (generated once per commit) ─► rendered PDF
Ask the Repo    ─► semantic search + recent commits ─► answer ─► ai_cache
```

**RAG (retrieval-augmented generation)** is used in every feature:

| Feature | Context retrieved from the database |
|---|---|
| Explain briefly | earlier commits touching the same files + semantically similar commits |
| Oracle chat | the commit's diff & analysis, same-file history, semantic matches for the question |
| PDF report | the above, plus a "How this fits the project history" section and a related-commits list |
| Ask the Repo | semantic matches across all analysed commits + the latest commits |

**Saving tokens:**

- A commit is analysed **once** and shared by every user. The brief and the analysis come from a single model call.
- PDF reports are generated once per commit and stored. Later downloads cost nothing, and public PDFs are cached by browsers and CDNs.
- Chat and Ask answers are cached by commit or repo, question and conversation. Identical questions (including the suggested ones) are instant.
- Two people clicking the same commit at the same time share one AI call.
- Lockfiles, build output and binaries are removed from diffs before anything is sent to the model. Prompt size is capped by `MAX_DIFF_CHARS`.
- GitHub responses (repo permissions, commit lists) are cached briefly. Diffs are stored, so they aren't fetched again.
- Rate limits are checked only right before tokens are spent. Cached answers are free and unlimited.

**Security:**

- Private repositories are only opened with the requesting user's own GitHub permissions. The server's `GITHUB_TOKEN` is never used to open a private repo for someone else.
- Supabase row-level security: anyone can read public repos. Private repos are visible only to users linked to them. Only the server writes.
- Login is required for private repos. Every request that spends AI tokens is rate-limited per user, or per hashed IP for guests.
- Webhooks are verified with HMAC signatures. Input URLs are validated, so the server never fetches arbitrary URLs.

---

## Quick start (Docker, your own keys)

1. **Create a Supabase project** (the free tier works) and open **SQL Editor**. Run `supabase/schema.sql` once.
2. In Supabase, go to **Authentication → Providers**. Enable **GitHub**, using a GitHub OAuth app whose callback URL is `https://<your-project>.supabase.co/auth/v1/callback`. Optionally enable Google.
3. In **Authentication → URL Configuration**, set the Site URL to your app URL (e.g. `http://localhost:3000`) and add `http://localhost:3000/auth/callback` to the redirect URLs.
4. Configure the app:
   ```bash
   cp .env.example .env
   # fill in Supabase keys + your LLM key (Gemini, OpenAI, Anthropic, Groq, OpenRouter, Ollama…)
   ```
5. Run:
   ```bash
   docker compose up --build -d
   ```
   Open http://localhost:3000. The health check is at http://localhost:3000/api/health.

Public Supabase settings are built into the browser bundle. If you change `NEXT_PUBLIC_SUPABASE_*`, rerun `docker compose up --build`.

### Run with a free local model (no API key)

```bash
docker compose --profile local-llm up --build -d
docker compose exec ollama ollama pull llama3.1
docker compose exec ollama ollama pull nomic-embed-text
```
`.env`:
```
LLM_PROVIDER=openai
LLM_BASE_URL=http://ollama:11434/v1
LLM_MODEL=llama3.1
EMBEDDING_PROVIDER=openai
EMBEDDING_BASE_URL=http://ollama:11434/v1
EMBEDDING_MODEL=nomic-embed-text
```

## Local development

```bash
npm install
cp .env.example .env.local     # fill it in
npm run dev
```

**Existing database (upgrading):** run `supabase/migrations/002_security_timeline_rag.sql`, then `003_public_repos_cache_usage.sql`.

## Configuration reference

| Variable | Purpose |
|---|---|
| `SITE_URL` | Public URL of the app (used for OAuth redirects behind proxies) |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | Your Supabase project |
| `LLM_PROVIDER` | `gemini`, `openai` (any OpenAI-compatible API) or `anthropic` |
| `LLM_API_KEY`, `LLM_MODEL`, `LLM_BASE_URL` | Model settings |
| `EMBEDDING_PROVIDER`, `EMBEDDING_API_KEY`, `EMBEDDING_MODEL`, `EMBEDDING_BASE_URL` | Embedding model (must output 768-dim vectors) |
| `GITHUB_TOKEN` | Optional token with no scopes. Raises the public-repo API limit to 5,000/h |
| `WEBHOOK_PROXY_URL`, `GITHUB_WEBHOOK_SECRET` | Keep tracked repos updated on every push |
| `ANON_AI_PER_MINUTE/DAY`, `USER_AI_PER_MINUTE/DAY` | Rate limits (map these to SaaS plans) |
| `MAX_DIFF_CHARS` | Max diff size sent to the model (lower = cheaper) |

## Project structure

```
app/
  page.tsx                 Public home: open any repo, Commits + Ask tabs
  dashboard/               Signed-in area: team, Timeline, Ask, usage
  api/commits              List commits (+ already-analysed summaries)
  api/explain/brief|chat|pdf
  api/ask                  Whole-repo Q&A
  api/webhooks/github      Push events → background indexing
  api/repos/track          Track a repo (webhook + import)
  api/health               Health check
lib/
  llm.ts                   Provider layer (Gemini / OpenAI-compatible / Anthropic)
  AI Summarizer.ts         All prompts
  commitProcessor.ts       Indexing pipeline (analysis + embeddings, deduplicated)
  history.ts               RAG retrieval (same-file history + vector search)
  repoAccess.ts            Public/private access decisions
  cache.ts, usage.ts       Shared answer cache, usage metering
supabase/
  schema.sql               Full schema for new projects
  migrations/              Upgrades for existing projects
```

## Scaling notes

- Rate limits and the in-memory cache layer live in each server process. With several instances, the database cache (`ai_cache`) is still shared. Move rate limits to Redis (e.g. Upstash) if you need strict global limits.
- `ai_usage` records every AI-backed request, cached or not, with token counts. This is the basis for quotas and billing per user.
- Changing the embedding size means changing `vector(768)` in the schema and re-indexing.
