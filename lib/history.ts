/**
 * RAG retrieval helpers shared by every feature.
 *  - findRelatedCommits: earlier commits that touched the SAME FILES (cheap SQL, very precise)
 *  - semanticSearch:     chunks whose meaning matches a question (pgvector)
 */
import { createAdminClient } from "@/utils/supabase/server";
import { embedTexts, HistoryItem, ContextItem, StructuredAnalysis } from "@/lib/AI Summarizer";
import { IMPACT_LEVELS } from "@/lib/impact";

export interface CommitRow {
  id: string;
  repo_id: string;
  commit_sha: string;
  short_sha: string;
  branch: string;
  author_name: string;
  author_avatar: string | null;
  message: string;
  title: string;
  brief_summary: string | null;
  executive_summary: string;
  architectural_impact: string;
  breaking_changes: string[] | null;
  affected_domains: string[] | null;
  impact_level: string;
  stats: { files_changed: number; additions: number; deletions: number } | null;
  file_paths: string[] | null;
  related_shas: string[] | null;
  diff_excerpt: string | null;
  detailed_report: string | null;
  committed_at: string;
}

export function rowToAnalysis(c: CommitRow): StructuredAnalysis {
  return {
    brief_summary: c.brief_summary || c.executive_summary,
    executive_summary: c.executive_summary,
    architectural_impact: c.architectural_impact,
    breaking_changes: c.breaking_changes || [],
    impact_level: (IMPACT_LEVELS as readonly string[]).includes(c.impact_level) ? (c.impact_level as any) : "Fix",
    affected_domains: c.affected_domains || [],
  };
}

export async function findRelatedCommits(
  repoId: string,
  opts: { filePaths: string[]; before?: string; excludeSha?: string; limit?: number }
): Promise<HistoryItem[]> {
  const paths = opts.filePaths.filter(Boolean).slice(0, 60);
  if (!paths.length) return [];
  const admin = createAdminClient();
  let q = admin
    .from("commits")
    .select("commit_sha, short_sha, title, author_name, committed_at, executive_summary")
    .eq("repo_id", repoId)
    .overlaps("file_paths", paths)
    .order("committed_at", { ascending: false })
    .limit(opts.limit ?? 5);
  if (opts.before) q = q.lt("committed_at", opts.before);
  if (opts.excludeSha) q = q.neq("commit_sha", opts.excludeSha);
  const { data } = await q;
  return (data || []).map((c: any) => ({
    sha: c.commit_sha,
    shortSha: c.short_sha,
    title: c.title,
    author: c.author_name,
    date: c.committed_at,
    summary: c.executive_summary,
    reason: "same files" as const,
  }));
}

export interface SemanticMatch {
  commit_sha: string;
  short_sha: string;
  commit_title: string;
  author_name: string;
  committed_at?: string;
  chunk_content: string;
  similarity: number;
}

/** Vector search; never throws (RAG is an enhancement, not a hard dependency). */
export async function semanticSearch(repoId: string, query: string, count = 8, threshold = 0.45): Promise<SemanticMatch[]> {
  try {
    const [vector] = await embedTexts([query.slice(0, 4000)], "RETRIEVAL_QUERY");
    const { data, error } = await createAdminClient().rpc("match_documents", {
      query_embedding: JSON.stringify(vector),
      match_threshold: threshold,
      match_count: count,
      filter_repo_id: repoId,
    });
    if (error) throw error;
    return (data || []) as SemanticMatch[];
  } catch (e) {
    console.warn("Semantic search unavailable:", (e as any)?.message || e);
    return [];
  }
}

export function matchesToContext(matches: SemanticMatch[]): ContextItem[] {
  return matches.map((m) => ({
    shortSha: m.short_sha,
    title: m.commit_title,
    author: m.author_name,
    date: m.committed_at,
    content: m.chunk_content,
  }));
}

/** Semantic hits turned into HistoryItems (deduplicated by commit), for the "related history" lists. */
export function matchesToHistory(matches: SemanticMatch[], exclude: Set<string>): HistoryItem[] {
  const out: HistoryItem[] = [];
  for (const m of matches) {
    if (exclude.has(m.commit_sha)) continue;
    exclude.add(m.commit_sha);
    out.push({
      sha: m.commit_sha,
      shortSha: m.short_sha,
      title: m.commit_title,
      author: m.author_name,
      date: m.committed_at,
      summary: m.chunk_content.split("\n").slice(1).join(" ").slice(0, 300),
      reason: "similar change",
    });
  }
  return out;
}

export interface SourceLink {
  sha: string;
  shortSha: string;
  title: string;
  author: string;
  date?: string;
  url: string;
  reason?: string;
}

export function toSources(items: { sha: string; shortSha: string; title: string; author: string; date?: string; reason?: string }[], repoUrl: string): SourceLink[] {
  const seen = new Set<string>();
  const out: SourceLink[] = [];
  for (const i of items) {
    if (seen.has(i.sha)) continue;
    seen.add(i.sha);
    out.push({ ...i, url: `${repoUrl}/commit/${i.sha}` });
  }
  return out;
}

/** Related history for a stored commit: same-file commits first, then semantically similar ones. */
export async function relatedHistoryForCommit(commit: CommitRow, opts: { semantic?: boolean; limit?: number } = {}): Promise<HistoryItem[]> {
  const limit = opts.limit ?? 6;
  const byFiles = await findRelatedCommits(commit.repo_id, {
    filePaths: commit.file_paths || [],
    before: commit.committed_at,
    excludeSha: commit.commit_sha,
    limit,
  });
  if (!opts.semantic || byFiles.length >= limit) return byFiles;
  const matches = await semanticSearch(commit.repo_id, `${commit.title}\n${commit.executive_summary}`, 8);
  const exclude = new Set<string>([commit.commit_sha, ...byFiles.map((b) => b.sha)]);
  return [...byFiles, ...matchesToHistory(matches, exclude)].slice(0, limit);
}
