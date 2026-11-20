/**
 * Decides who may use a repository and which GitHub token to use.
 *
 *  - Public repo  → anyone, no login. Calls GitHub with the server's GITHUB_TOKEN (if set).
 *  - Private repo → must be signed in with GitHub (or assigned the repo by a manager).
 *                   Access is verified against GitHub with the user's own token.
 *
 * The server token is NEVER used to open a private repo for someone else.
 */
import { createAdminClient } from "@/utils/supabase/server";
import { fetchRepoMeta, getUserGithubToken, serverGithubToken, GithubRepoMeta } from "@/lib/github";
import { parseGithubRepoUrl } from "@/lib/validation";
import { HttpError } from "@/lib/errors";
import { MemoryCache } from "@/lib/memoryCache";
import type { Requester } from "@/lib/auth";

export interface RepoRow {
  id: string;
  name: string;
  owner: string;
  url: string;
  default_branch: string | null;
  private: boolean;
  last_indexed_at?: string | null;
}

export interface ResolvedRepo {
  repo: RepoRow;
  /** Token to use for GitHub API calls about this repo (may be null for public repos) */
  token: string | null;
}

const REPO_COLUMNS = "id, name, owner, url, default_branch, private, last_indexed_at, metadata_checked_at";
// GitHub permission checks are cached briefly so every click doesn't hit the GitHub API
const accessCache = new MemoryCache<{ meta: GithubRepoMeta; token: string | null }>(2000, 10 * 60_000);
const PUBLIC_RECHECK_MS = 24 * 3600_000;

function escapeLike(s: string) {
  return s.replace(/[\\%_]/g, (c) => "\\" + c);
}

async function upsertRepo(meta: GithubRepoMeta): Promise<RepoRow> {
  const admin = createAdminClient();
  const row = {
    name: meta.full_name,
    owner: meta.full_name.split("/")[0],
    url: meta.html_url,
    default_branch: meta.default_branch || "main",
    private: !!meta.private,
    github_id: meta.id,
    metadata_checked_at: new Date().toISOString(),
  };
  const { data, error } = await admin.from("repositories").upsert(row, { onConflict: "name" }).select(REPO_COLUMNS).single();
  if (error || !data) throw new HttpError(500, `Could not save repository: ${error?.message || "unknown error"}`);
  return data as RepoRow;
}

/** Links a private repo to the user so it appears in their dashboard (Timeline / Ask). */
async function linkRepoToUser(repoId: string, userId: string) {
  const admin = createAdminClient();
  await admin
    .from("user_repositories")
    .upsert({ user_id: userId, repository_id: repoId, assigned_by: userId }, { onConflict: "user_id,repository_id", ignoreDuplicates: true });
}

export async function resolveRepo(input: { repoUrl?: string | null; repoId?: string | null }, requester: Requester): Promise<ResolvedRepo> {
  const admin = createAdminClient();
  let existing: (RepoRow & { metadata_checked_at?: string | null }) | null = null;
  let fullName: string;

  if (input.repoId) {
    if (!/^[0-9a-f-]{36}$/i.test(input.repoId)) throw new HttpError(400, "Invalid repository id.");
    const { data } = await admin.from("repositories").select(REPO_COLUMNS).eq("id", input.repoId).maybeSingle();
    if (!data) throw new HttpError(404, "Repository not found.");
    existing = data as any;
    fullName = existing!.name;
  } else {
    const ref = parseGithubRepoUrl(input.repoUrl);
    if (!ref) throw new HttpError(400, "Please enter a valid GitHub repository URL, e.g. https://github.com/owner/repo");
    fullName = ref.fullName;
    const { data } = await admin.from("repositories").select(REPO_COLUMNS).ilike("name", escapeLike(fullName)).maybeSingle();
    existing = (data as any) || null;
  }

  const user = requester.user;
  const serverToken = serverGithubToken();

  // Fast path: known public repo, checked recently → no GitHub call at all
  if (existing && !existing.private && existing.metadata_checked_at &&
      Date.now() - new Date(existing.metadata_checked_at).getTime() < PUBLIC_RECHECK_MS) {
    const userToken = user ? await getUserGithubToken(user.id, existing.url) : null;
    return { repo: existing, token: userToken || serverToken };
  }

  const cacheId = `${fullName.toLowerCase()}|${user?.id || "anon"}`;
  let access = accessCache.get(cacheId);

  if (!access) {
    // 1. Signed-in user: check with their own (or their manager's) token. This is what unlocks private repos.
    const userToken = user ? await getUserGithubToken(user.id, existing?.url || `https://github.com/${fullName}`) : null;
    if (userToken) {
      const meta = await fetchRepoMeta(fullName, userToken).catch((e) => { throw new HttpError(e.status || 502, e.message); });
      if (meta) access = { meta, token: userToken };
    }

    // 2. Otherwise only PUBLIC repos are allowed (server token is for rate limits, not for access)
    if (!access) {
      const meta = await fetchRepoMeta(fullName, serverToken).catch((e) => { throw new HttpError(e.status || 502, e.message); });
      if (meta && !meta.private) access = { meta, token: serverToken };
    }

    if (!access) {
      if (!user) {
        throw new HttpError(401, "This repository is private or doesn't exist. Sign in with GitHub to open private repositories.", { needsLogin: true });
      }
      throw new HttpError(404, "Repository not found, or your GitHub account doesn't have access. If it's private, sign in with GitHub (not email) so we can use your GitHub permissions.", { needsGithub: true });
    }
    accessCache.set(cacheId, access);
  }

  const needsUpdate =
    !existing ||
    existing.private !== !!access.meta.private ||
    existing.name !== access.meta.full_name ||
    !existing.metadata_checked_at ||
    Date.now() - new Date(existing.metadata_checked_at).getTime() > PUBLIC_RECHECK_MS;
  const repo = needsUpdate ? await upsertRepo(access.meta) : existing!;

  if (repo.private && user) await linkRepoToUser(repo.id, user.id);

  return { repo, token: access.token };
}
