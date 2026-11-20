import { createClient, createAdminClient } from "@/utils/supabase/server";
import { parseGithubRepoUrl } from "@/lib/validation";

const GH_HEADERS = { "User-Agent": "GitSimple-App" };

function authHeaders(token: string | null | undefined, accept = "application/vnd.github.v3+json") {
  const headers: Record<string, string> = { ...GH_HEADERS, Accept: accept };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return headers;
}

/** Optional server-wide token (no scopes needed) so public-repo calls get 5,000 req/h instead of 60. */
export function serverGithubToken(): string | null {
  return (process.env.GITHUB_TOKEN || "").trim() || null;
}

export async function getGithubTokenForRepo(repoUrl: string): Promise<string | null> {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  return getUserGithubToken(user.id, repoUrl);
}

/** The user's own GitHub token, or the token of the manager who assigned them this repo. */
export async function getUserGithubToken(userId: string, repoUrl: string): Promise<string | null> {
  const user = { id: userId };
  const adminAuthClient = createAdminClient();

  // First check if user has their own token
  const { data: profile } = await adminAuthClient
    .from('profiles')
    .select('github_token')
    .eq('id', user.id)
    .single();

  if (profile?.github_token) {
    return profile.github_token;
  }

  // If no personal token, check if they are assigned this repo
  const { data: userRepo } = await adminAuthClient
    .from('user_repositories')
    .select('assigned_by, repositories!inner(url)')
    .eq('user_id', user.id)
    .eq('repositories.url', repoUrl)
    .maybeSingle();

  if (userRepo?.assigned_by) {
    const { data: managerProfile } = await adminAuthClient
      .from('profiles')
      .select('github_token')
      .eq('id', userRepo.assigned_by)
      .single();

    if (managerProfile?.github_token) {
      return managerProfile.github_token;
    }
  }

  return null;
}

/**
 * Picks a GitHub token that can read a tracked repository (used by background jobs).
 * Prefers the manager who assigned the repo, then anyone linked to it.
 */
export async function getTokenForTrackedRepo(repoId: string): Promise<string | null> {
  const admin = createAdminClient();
  const { data: links } = await admin
    .from("user_repositories")
    .select("user_id, assigned_by")
    .eq("repository_id", repoId)
    .limit(50);

  const ids = new Set<string>();
  (links || []).forEach((l: any) => l.assigned_by && ids.add(l.assigned_by));
  (links || []).forEach((l: any) => l.user_id && ids.add(l.user_id));
  if (ids.size === 0) return null;

  const { data: profiles } = await admin
    .from("profiles")
    .select("id, github_token")
    .in("id", Array.from(ids))
    .not("github_token", "is", null);

  if (!profiles?.length) return null;
  // Keep the preference order (managers first)
  for (const id of Array.from(ids)) {
    const p = profiles.find((x: any) => x.id === id);
    if (p?.github_token) return p.github_token;
  }
  return null;
}

export async function fetchCommitDiff(repoUrl: string, sha: string, token: string | null): Promise<string> {
  const ref = parseGithubRepoUrl(repoUrl);
  if (!ref) throw new Error("Invalid repo URL");

  const response = await fetch(`https://api.github.com/repos/${ref.fullName}/commits/${sha}`, {
    headers: authHeaders(token, "application/vnd.github.v3.diff"),
  });

  if (!response.ok) {
    if (response.status === 404) throw new Error("Repository not found or is private.");
    if (response.status === 403) throw new Error("GitHub API rate limit exceeded.");
    throw new Error(`GitHub API returned ${response.status}`);
  }

  return response.text();
}

/**
 * Gets a commit diff via the API, falling back to github.com's public .diff URL.
 * The fallback URL is always built from the validated repo + sha, never taken from the client.
 */
export async function getDiffForCommit(repoUrl: string, sha: string): Promise<string> {
  const ref = parseGithubRepoUrl(repoUrl);
  if (!ref) throw new Error("Invalid repo URL");

  try {
    const token = await getGithubTokenForRepo(ref.url);
    return await fetchCommitDiff(ref.url, sha, token);
  } catch (e) {
    console.warn("API diff fetch failed, trying public .diff URL", e);
    const res = await fetch(`https://github.com/${ref.fullName}/commit/${sha}.diff`, { headers: GH_HEADERS });
    if (!res.ok) throw new Error("Failed to fetch diff");
    return res.text();
  }
}

export interface GithubRepoSummary {
  id: string;
  name: string;
  private: boolean;
  url: string;
  default_branch: string;
}

function formatRepo(repo: any): GithubRepoSummary {
  return {
    id: repo.id.toString(),
    name: repo.full_name,
    private: repo.private,
    url: repo.html_url,
    default_branch: repo.default_branch,
  };
}

/** Repos the token's owner can access (owner, collaborator, org member). */
export async function fetchUserRepos(token: string): Promise<GithubRepoSummary[]> {
  const res = await fetch(
    "https://api.github.com/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member",
    { headers: authHeaders(token), cache: "no-store" }
  );
  if (!res.ok) {
    throw new Error(`GitHub API Error: ${res.status} ${res.statusText}`);
  }
  return (await res.json()).map(formatRepo);
}

export async function fetchPublicReposForUser(username: string): Promise<GithubRepoSummary[]> {
  const res = await fetch(`https://api.github.com/users/${encodeURIComponent(username)}/repos?per_page=100`, {
    headers: authHeaders(null),
  });
  if (!res.ok) throw Object.assign(new Error("Failed to fetch public repositories for this user"), { status: res.status });
  return (await res.json()).map(formatRepo);
}

/** Creates the push webhook on a repo if it isn't there yet. Non-fatal on failure. */
export async function ensureWebhook(fullName: string, token: string): Promise<"created" | "exists" | "skipped" | "failed"> {
  const webhookUrl = process.env.WEBHOOK_PROXY_URL;
  const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!webhookUrl || !webhookSecret) return "skipped";

  try {
    const hooksRes = await fetch(`https://api.github.com/repos/${fullName}/hooks`, { headers: authHeaders(token) });
    if (!hooksRes.ok) {
      console.error(`GitHub API error fetching webhooks for ${fullName}:`, await hooksRes.text());
      return "failed";
    }
    const hooks = await hooksRes.json();
    if (hooks.some((h: any) => h.config?.url === webhookUrl)) return "exists";

    const createRes = await fetch(`https://api.github.com/repos/${fullName}/hooks`, {
      method: "POST",
      headers: { ...authHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "web",
        active: true,
        events: ["push"],
        config: { url: webhookUrl, content_type: "json", secret: webhookSecret, insecure_ssl: "0" },
      }),
    });
    if (!createRes.ok) {
      console.error(`GitHub API error creating webhook for ${fullName}:`, await createRes.text());
      return "failed";
    }
    return "created";
  } catch (e) {
    console.error("Failed to configure GitHub webhook:", e);
    return "failed";
  }
}

export interface CommitDetails {
  sha: string;
  message: string;
  authorName: string;
  authorEmail: string;
  authorAvatar: string;
  date: string;
  additions: number;
  deletions: number;
  parents: number;
  files: { filename: string; status: string; additions: number; deletions: number; patch?: string }[];
}

/** Full commit info (stats, files with patches, avatar) from the JSON endpoint. */
export async function fetchCommitDetails(fullName: string, sha: string, token: string | null): Promise<CommitDetails> {
  const res = await fetch(`https://api.github.com/repos/${fullName}/commits/${sha}`, { headers: authHeaders(token) });
  if (res.status === 403 || res.status === 429) throw new Error("GitHub API rate limit reached. Set GITHUB_TOKEN on the server or try again later.");
  if (res.status === 404 || res.status === 422) throw new Error(`Commit ${sha.slice(0, 7)} not found in ${fullName}.`);
  if (!res.ok) throw new Error(`GitHub API returned ${res.status} for ${fullName}@${sha}`);
  const c = await res.json();
  return {
    sha: c.sha,
    message: c.commit?.message || "",
    authorName: c.commit?.author?.name || c.author?.login || "Unknown",
    authorEmail: c.commit?.author?.email || "",
    authorAvatar: c.author?.avatar_url || "",
    date: c.commit?.author?.date || new Date().toISOString(),
    additions: c.stats?.additions || 0,
    deletions: c.stats?.deletions || 0,
    parents: c.parents?.length || 0,
    files: (c.files || []).map((f: any) => ({
      filename: f.filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      patch: f.patch,
    })),
  };
}

/** Latest commit SHAs on a branch, newest first. */
export async function listRecentCommitShas(fullName: string, branch: string | null, token: string | null, limit = 10): Promise<string[]> {
  const params = new URLSearchParams({ per_page: String(limit) });
  if (branch) params.set("sha", branch);
  const res = await fetch(`https://api.github.com/repos/${fullName}/commits?${params}`, { headers: authHeaders(token) });
  if (!res.ok) throw new Error(`GitHub API returned ${res.status} listing commits for ${fullName}`);
  return (await res.json()).map((c: any) => c.sha);
}

export interface GithubRepoMeta {
  id: number;
  full_name: string;
  html_url: string;
  default_branch: string;
  private: boolean;
  description: string | null;
}

/** GET /repos/{owner}/{repo}. Returns null on 404 (missing, or private without access). */
export async function fetchRepoMeta(fullName: string, token: string | null): Promise<GithubRepoMeta | null> {
  const res = await fetch(`https://api.github.com/repos/${fullName}`, { headers: authHeaders(token), cache: "no-store" });
  if (res.status === 404 || res.status === 401) return null;
  if (res.status === 403) throw Object.assign(new Error("GitHub API rate limit exceeded. Try again later or sign in with GitHub."), { status: 429 });
  if (!res.ok) throw new Error(`GitHub API returned ${res.status}`);
  return res.json();
}

export interface CommitListItem {
  sha: string;
  shortSha: string;
  message: string;
  author: string;
  avatar: string;
  date: string;
  url: string;
}

export async function listCommits(fullName: string, token: string | null, page = 1, perPage = 15, branch?: string | null) {
  const params = new URLSearchParams({ per_page: String(perPage), page: String(page) });
  if (branch) params.set("sha", branch);
  const res = await fetch(`https://api.github.com/repos/${fullName}/commits?${params}`, { headers: authHeaders(token), cache: "no-store" });
  if (res.status === 409) return { commits: [] as CommitListItem[], hasMore: false }; // empty repository
  if (res.status === 403) throw Object.assign(new Error("GitHub API rate limit exceeded. Try again later or sign in with GitHub."), { status: 429 });
  if (!res.ok) throw Object.assign(new Error(`GitHub API returned ${res.status}`), { status: res.status });
  const data = await res.json();
  const commits: CommitListItem[] = data.map((c: any) => ({
    sha: c.sha,
    shortSha: c.sha.substring(0, 7),
    message: c.commit?.message || "",
    author: c.commit?.author?.name || c.author?.login || "Unknown",
    avatar: c.author?.avatar_url || "",
    date: c.commit?.author?.date,
    url: c.html_url,
  }));
  const hasMore = /rel="next"/.test(res.headers.get("link") || "");
  return { commits, hasMore };
}
