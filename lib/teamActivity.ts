/**
 * Team Activity: what a manager's team members explored in GitSimple (history) and
 * the commits they authored in tracked repositories (work progress).
 * Server-only. Callers must check that the viewer is the members' manager.
 */
import { createAdminClient } from "@/utils/supabase/server";
import { getAccessibleRepos } from "@/lib/auth";

export type ActivityKind = "open" | "brief" | "index" | "chat" | "pdf" | "ask";

export const ACTIVITY_LABEL: Record<ActivityKind, string> = {
  open: "Opened repository",
  brief: "Explained commit",
  index: "Explained commit (first analysis)",
  chat: "Asked the Oracle about a commit",
  pdf: "Downloaded PDF report",
  ask: "Asked a question about the repository",
};

export interface Member {
  id: string;
  email: string;
  role: string;
  joinedAt: string | null;
  githubLogin: string | null;
  name: string | null;
  avatar: string | null;
  lastSignIn: string | null;
}

export interface UsageRow {
  user_id: string;
  kind: ActivityKind;
  cached: boolean;
  repo_id: string | null;
  commit_sha: string | null;
  created_at: string;
  input_tokens: number;
  output_tokens: number;
}

export interface AuthoredCommit {
  id: string;
  repo_id: string;
  commit_sha: string;
  short_sha: string;
  title: string;
  executive_summary: string;
  impact_level: string;
  stats: { files_changed: number; additions: number; deletions: number } | null;
  committed_at: string;
  author_name: string;
  author_email: string;
  author_login?: string | null;
}

export interface MemberSummary {
  member: Member;
  lastActive: string | null;
  actions: number;
  commitsOpened: number;
  chats: number;
  pdfs: number;
  questions: number;
  reposExplored: number;
  authored: AuthoredCommit[];
  additions: number;
  deletions: number;
  impactCounts: Record<string, number>;
  /** actions per bucket, oldest first */
  activitySeries: number[];
  /** authored commits per bucket, oldest first */
  workSeries: number[];
}

export interface Bucket {
  start: number;
  end: number;
  label: string;
}

const DAY = 86_400_000;

/** Daily buckets up to 31 days, weekly beyond that. Aligned to India time. */
export function makeBuckets(days: number, now = Date.now()): Bucket[] {
  const IST = 5.5 * 3600_000;
  const todayStart = Math.floor((now + IST) / DAY) * DAY - IST;
  const step = days > 31 ? 7 * DAY : DAY;
  const count = Math.ceil(days / (step / DAY));
  const end = todayStart + DAY;
  const buckets: Bucket[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const s = end - (i + 1) * step;
    const e = end - i * step;
    const d = new Date(s + IST);
    const label = `${d.getUTCDate()} ${d.toLocaleString("en-IN", { month: "short", timeZone: "UTC" })}`;
    buckets.push({ start: s, end: e, label: step > DAY ? `Week of ${label}` : label });
  }
  return buckets;
}

function bucketIndex(buckets: Bucket[], iso: string) {
  const t = new Date(iso).getTime();
  for (let i = 0; i < buckets.length; i++) if (t >= buckets[i].start && t < buckets[i].end) return i;
  return -1;
}

/** Lower-cased identifiers that may appear as a commit author for this member. */
function identities(m: Member) {
  const logins = new Set<string>();
  const emails = new Set<string>();
  const names = new Set<string>();
  if (m.githubLogin) logins.add(m.githubLogin.toLowerCase());
  if (m.email) emails.add(m.email.toLowerCase());
  if (m.name) names.add(m.name.toLowerCase());
  if (m.githubLogin) names.add(m.githubLogin.toLowerCase());
  return { logins, emails, names };
}

/** GitHub "noreply" addresses carry the username: 12345+login@users.noreply.github.com */
function loginFromNoreply(email: string) {
  const m = /^(?:\d+\+)?([^@]+)@users\.noreply\.github\.com$/i.exec(email || "");
  return m ? m[1].toLowerCase() : null;
}

export function isAuthoredBy(c: AuthoredCommit, m: Member) {
  const { logins, emails, names } = identities(m);
  if (c.author_login && logins.has(c.author_login.toLowerCase())) return true;
  const email = (c.author_email || "").toLowerCase();
  if (email && emails.has(email)) return true;
  const noreply = loginFromNoreply(email);
  if (noreply && logins.has(noreply)) return true;
  return !!c.author_name && names.has(c.author_name.toLowerCase());
}

/** Members whose manager is `managerId`, with GitHub profile details. */
export async function getTeamMembers(managerId: string): Promise<Member[]> {
  const admin = createAdminClient();
  let { data, error } = await admin
    .from("profiles")
    .select("id, email, role, created_at, github_login")
    .eq("manager_id", managerId)
    .order("created_at", { ascending: true });
  if (error && /github_login/.test(error.message || "")) {
    ({ data } = await admin
      .from("profiles")
      .select("id, email, role, created_at")
      .eq("manager_id", managerId)
      .order("created_at", { ascending: true }) as any);
  }
  const rows = (data || []) as any[];

  return Promise.all(
    rows.map(async (p) => {
      let meta: any = {};
      let lastSignIn: string | null = null;
      try {
        const { data: u } = await admin.auth.admin.getUserById(p.id);
        meta = u?.user?.user_metadata || {};
        lastSignIn = u?.user?.last_sign_in_at || null;
      } catch {
        // profile details are optional
      }
      return {
        id: p.id,
        email: p.email || "",
        role: p.role,
        joinedAt: p.created_at || null,
        githubLogin: p.github_login || meta.user_name || meta.preferred_username || null,
        name: meta.full_name || meta.name || null,
        avatar: meta.avatar_url || null,
        lastSignIn,
      } as Member;
    })
  );
}

export interface TeamData {
  members: Member[];
  usage: UsageRow[];
  commits: AuthoredCommit[];
  repoNames: Map<string, { name: string; url: string | null }>;
  commitTitles: Map<string, string>;
  buckets: Bucket[];
  summaries: MemberSummary[];
  hasCommitColumn: boolean;
}

export async function loadTeamData(managerId: string, days: number, onlyMemberId?: string): Promise<TeamData> {
  const admin = createAdminClient();
  const since = new Date(Date.now() - days * DAY).toISOString();
  let members = await getTeamMembers(managerId);
  if (onlyMemberId) members = members.filter((m) => m.id === onlyMemberId);
  const memberIds = members.map((m) => m.id);
  const buckets = makeBuckets(days);

  // 1. What members did in GitSimple (only commit IDs, never question text)
  let usage: UsageRow[] = [];
  let hasCommitColumn = true;
  if (memberIds.length) {
    const cols = "user_id, kind, cached, repo_id, commit_sha, created_at, input_tokens, output_tokens";
    let res = await admin.from("ai_usage").select(cols).in("user_id", memberIds).gte("created_at", since)
      .order("created_at", { ascending: false }).limit(5000);
    if (res.error && /commit_sha/.test(res.error.message || "")) {
      hasCommitColumn = false;
      res = await admin.from("ai_usage").select(cols.replace("commit_sha, ", "")).in("user_id", memberIds)
        .gte("created_at", since).order("created_at", { ascending: false }).limit(5000) as any;
    }
    usage = ((res.data || []) as any[]).filter((r) => r.kind in ACTIVITY_LABEL) as UsageRow[];
  }

  // 2. Commits authored in the manager's repositories during the period
  const repos = await getAccessibleRepos(managerId);
  const repoNames = new Map<string, { name: string; url: string | null }>(repos.map((r) => [r.id, { name: r.name, url: r.url }]));
  let commits: AuthoredCommit[] = [];
  if (repos.length && members.length) {
    const cols = "id, repo_id, commit_sha, short_sha, title, executive_summary, impact_level, stats, committed_at, author_name, author_email";
    let res = await admin.from("commits").select(`${cols}, author_login`).in("repo_id", repos.map((r) => r.id))
      .gte("committed_at", since).order("committed_at", { ascending: false }).limit(3000);
    if (res.error && /author_login/.test(res.error.message || "")) {
      res = await admin.from("commits").select(cols).in("repo_id", repos.map((r) => r.id))
        .gte("committed_at", since).order("committed_at", { ascending: false }).limit(3000) as any;
    }
    commits = (res.data || []) as AuthoredCommit[];
  }

  // 3. Names of repos members explored outside the manager's list (e.g. public repos)
  const missingRepoIds = Array.from(new Set(usage.map((u) => u.repo_id).filter((id): id is string => !!id && !repoNames.has(id))));
  if (missingRepoIds.length) {
    const { data } = await admin.from("repositories").select("id, name, url").in("id", missingRepoIds.slice(0, 500));
    (data || []).forEach((r: any) => repoNames.set(r.id, { name: r.name, url: r.url }));
  }

  // 4. Titles for commits members opened
  const commitTitles = new Map<string, string>();
  const openedShas = Array.from(new Set(usage.map((u) => u.commit_sha).filter((s): s is string => !!s)));
  for (let i = 0; i < openedShas.length && i < 1000; i += 200) {
    const { data } = await admin.from("commits").select("commit_sha, title").in("commit_sha", openedShas.slice(i, i + 200));
    (data || []).forEach((c: any) => commitTitles.set(c.commit_sha, c.title));
  }

  const summaries = members.map((m) => summarise(m, usage, commits, buckets));
  return { members, usage, commits, repoNames, commitTitles, buckets, summaries, hasCommitColumn };
}

function summarise(m: Member, usage: UsageRow[], commits: AuthoredCommit[], buckets: Bucket[]): MemberSummary {
  const mine = usage.filter((u) => u.user_id === m.id);
  const opened = new Set<string>();
  const repos = new Set<string>();
  const activitySeries = buckets.map(() => 0);
  let chats = 0, pdfs = 0, questions = 0, explainsWithoutSha = 0;
  for (const u of mine) {
    if (u.kind !== "open" && u.kind !== "ask" && u.commit_sha) opened.add(u.commit_sha);
    // rows logged before migration 004 have no commit ID: count them individually
    if ((u.kind === "brief" || u.kind === "index") && !u.commit_sha) explainsWithoutSha++;
    if (u.kind === "chat") chats++;
    if (u.kind === "pdf") pdfs++;
    if (u.kind === "ask") questions++;
    if (u.repo_id) repos.add(u.repo_id);
    const b = bucketIndex(buckets, u.created_at);
    if (b >= 0) activitySeries[b]++;
  }

  const authored = commits.filter((c) => isAuthoredBy(c, m));
  const workSeries = buckets.map(() => 0);
  const impactCounts: Record<string, number> = {};
  let additions = 0, deletions = 0;
  for (const c of authored) {
    impactCounts[c.impact_level] = (impactCounts[c.impact_level] || 0) + 1;
    additions += c.stats?.additions || 0;
    deletions += c.stats?.deletions || 0;
    const b = bucketIndex(buckets, c.committed_at);
    if (b >= 0) workSeries[b]++;
  }

  const latestUsage = mine[0]?.created_at || null;
  const candidates = [latestUsage, m.lastSignIn].filter(Boolean) as string[];
  const lastActive = candidates.sort().pop() || null;

  return {
    member: m,
    lastActive,
    actions: mine.length,
    commitsOpened: opened.size + explainsWithoutSha,
    chats,
    pdfs,
    questions,
    reposExplored: repos.size,
    authored,
    additions,
    deletions,
    impactCounts,
    activitySeries,
    workSeries,
  };
}
