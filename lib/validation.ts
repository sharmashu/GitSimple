// Input validation helpers shared by the API routes.

export interface RepoRef {
  owner: string;
  repo: string;
  fullName: string;
  url: string;
}

const NAME_RE = /^[A-Za-z0-9_.-]+$/;
const SHA_RE = /^[0-9a-f]{7,40}$/i;

/**
 * Parses a GitHub repository URL (https://github.com/owner/repo[/...]).
 * Returns null for anything that is not a github.com URL, so user input can
 * never make the server fetch an arbitrary host.
 */
export function parseGithubRepoUrl(input: string | null | undefined): RepoRef | null {
  if (!input) return null;
  try {
    const url = new URL(input.startsWith("http") ? input : `https://${input}`);
    if (url.protocol !== "https:" || (url.hostname !== "github.com" && url.hostname !== "www.github.com")) {
      return null;
    }
    const [owner, rawRepo] = url.pathname.split("/").filter(Boolean);
    const repo = rawRepo?.replace(/\.git$/, "");
    if (!owner || !repo || !NAME_RE.test(owner) || !NAME_RE.test(repo)) return null;
    return { owner, repo, fullName: `${owner}/${repo}`, url: `https://github.com/${owner}/${repo}` };
  } catch {
    return null;
  }
}

export function isValidSha(sha: unknown): sha is string {
  return typeof sha === "string" && SHA_RE.test(sha);
}

export function isValidFullName(name: unknown): name is string {
  if (typeof name !== "string") return false;
  const parts = name.split("/");
  return parts.length === 2 && parts.every((p) => NAME_RE.test(p));
}
