/**
 * Indexing pipeline: fetch a commit once → ONE AI call (brief + structured analysis, with
 * related history as context) → store everything + embeddings. Every feature reuses the result.
 */
import { waitUntil } from "@vercel/functions";
import { createAdminClient } from "@/utils/supabase/server";
import { analyzeCommit, embedTexts, prepareDiff, StructuredAnalysis, HistoryItem } from "@/lib/AI Summarizer";
import { fetchCommitDetails, listRecentCommitShas, getTokenForTrackedRepo, ensureWebhook, CommitDetails } from "@/lib/github";
import { findRelatedCommits, semanticSearch, matchesToHistory, CommitRow } from "@/lib/history";
import { checkAiBudget, Requester } from "@/lib/auth";
import { logUsage } from "@/lib/usage";
import { HttpError } from "@/lib/errors";

const MAX_DIFF_CHUNKS = 8;
const DIFF_CHUNK_CHARS = 1800;

export interface RepoRef {
  id: string;
  name: string;
  url?: string;
  default_branch?: string | null;
}

function buildDiff(details: CommitDetails): string {
  return details.files
    .map((f) => `diff --git a/${f.filename} b/${f.filename}\n--- ${f.status} (+${f.additions}/-${f.deletions})\n${f.patch || "(binary or very large file, no patch available)"}`)
    .join("\n");
}

function buildChunks(details: CommitDetails, analysis: StructuredAnalysis, title: string) {
  const header = `Commit ${details.sha.slice(0, 7)} "${title}" by ${details.authorName} (${details.date.slice(0, 10)})`;
  const chunks: { chunk_type: string; chunk_content: string; metadata: Record<string, unknown> }[] = [];

  chunks.push({
    chunk_type: "summary",
    chunk_content: `${header}\nType: ${analysis.impact_level}\nAreas: ${analysis.affected_domains.join(", ") || "n/a"}\nSummary: ${analysis.executive_summary}\nFiles: ${details.files.map((f) => f.filename).slice(0, 40).join(", ")}`,
    metadata: {},
  });

  if (analysis.architectural_impact && analysis.architectural_impact.trim().toLowerCase() !== "none") {
    chunks.push({ chunk_type: "architectural_insight", chunk_content: `${header}\nArchitectural impact: ${analysis.architectural_impact}`, metadata: {} });
  }

  for (const bc of analysis.breaking_changes.slice(0, 5)) {
    chunks.push({ chunk_type: "breaking_change", chunk_content: `${header}\nBreaking change: ${bc}`, metadata: {} });
  }

  const biggestFiles = details.files
    .filter((f) => f.patch)
    .sort((a, b) => b.additions + b.deletions - (a.additions + a.deletions))
    .slice(0, MAX_DIFF_CHUNKS);
  for (const f of biggestFiles) {
    chunks.push({
      chunk_type: "diff",
      chunk_content: `${header}\nFile: ${f.filename} (${f.status}, +${f.additions}/-${f.deletions})\n${f.patch!.slice(0, DIFF_CHUNK_CHARS)}`,
      metadata: { file: f.filename },
    });
  }
  return chunks;
}

/** Looks up an already-analysed commit by full or short SHA. */
export async function getStoredCommit(repoId: string, sha: string): Promise<CommitRow | null> {
  const admin = createAdminClient();
  const q = admin.from("commits").select("*").eq("repo_id", repoId);
  const { data } = sha.length === 40
    ? await q.eq("commit_sha", sha.toLowerCase()).maybeSingle()
    : await q.like("commit_sha", `${sha.toLowerCase()}%`).limit(1).maybeSingle();
  return (data as CommitRow) || null;
}

export type IndexStatus = "processed" | "exists" | "skipped" | "failed";

// Two people clicking the same commit at the same moment share one AI call
const inflight = new Map<string, Promise<{ status: IndexStatus; commit: CommitRow | null; model?: string; usage?: { input: number; output: number }; error?: string }>>();

export function indexCommit(opts: {
  repo: RepoRef;
  sha: string;
  token: string | null;
  branch?: string;
  skipMerges?: boolean;
}) {
  const key = `${opts.repo.id}:${opts.sha.toLowerCase()}`;
  const running = inflight.get(key);
  if (running) return running;
  const p = indexCommitInner(opts).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

async function indexCommitInner(opts: {
  repo: RepoRef;
  sha: string;
  token: string | null;
  branch?: string;
  skipMerges?: boolean;
}): Promise<{ status: IndexStatus; commit: CommitRow | null; model?: string; usage?: { input: number; output: number }; error?: string }> {
  const admin = createAdminClient();

  const existing = await getStoredCommit(opts.repo.id, opts.sha);
  if (existing) return { status: "exists", commit: existing };

  let details: CommitDetails;
  try {
    details = await fetchCommitDetails(opts.repo.name, opts.sha, opts.token);
  } catch (e) {
    console.warn(`Could not fetch commit ${opts.sha}:`, e);
    return { status: "failed", commit: null, error: `GitHub: ${(e as any)?.message || "could not fetch commit"}` };
  }

  // Background jobs skip merge commits (their changes are analysed in the merged commits)
  if (opts.skipMerges && details.parents > 1) return { status: "skipped", commit: null };

  const diff = buildDiff(details);
  const title = details.message.split("\n")[0].slice(0, 300) || "(no message)";
  const filePaths = details.files.map((f) => f.filename);

  // RAG: what happened before in the same files, plus semantically similar commits
  let related: HistoryItem[] = await findRelatedCommits(opts.repo.id, {
    filePaths,
    before: details.date,
    excludeSha: details.sha,
    limit: 5,
  });
  if (related.length < 3) {
    const matches = await semanticSearch(opts.repo.id, `${details.message}\n${filePaths.slice(0, 30).join("\n")}`, 6, 0.5);
    related = [...related, ...matchesToHistory(matches, new Set([details.sha, ...related.map((r) => r.sha)]))].slice(0, 5);
  }

  let analysis: StructuredAnalysis;
  let model: string | undefined;
  let usage: { input: number; output: number } | undefined;
  try {
    const r = await analyzeCommit({ message: details.message, diff: diff.trim() ? diff : "(no textual changes)", related });
    analysis = r.analysis;
    model = r.result.model;
    usage = r.result.usage;
  } catch (e) {
    console.error(`AI analysis failed for ${opts.sha}:`, e);
    return { status: "failed", commit: null, error: `AI: ${(e as any)?.message || "analysis failed"}` };
  }

  const { data: inserted, error: insertError } = await admin
    .from("commits")
    .insert({
      repo_id: opts.repo.id,
      commit_sha: details.sha,
      short_sha: details.sha.substring(0, 7),
      branch: opts.branch || opts.repo.default_branch || "main",
      author_name: details.authorName,
      author_email: details.authorEmail,
      author_avatar: details.authorAvatar,
      message: details.message,
      title,
      brief_summary: analysis.brief_summary,
      executive_summary: analysis.executive_summary,
      architectural_impact: analysis.architectural_impact,
      breaking_changes: analysis.breaking_changes,
      affected_domains: analysis.affected_domains,
      impact_level: analysis.impact_level,
      stats: { files_changed: details.files.length, additions: details.additions, deletions: details.deletions },
      files: details.files.map((f) => ({ filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions })),
      file_paths: filePaths,
      related_shas: related.map((r) => r.sha),
      diff_excerpt: prepareDiff(diff),
      analysis_model: model,
      committed_at: details.date,
    })
    .select("*")
    .single();

  if (insertError) {
    if (insertError.code === "23505") return { status: "exists", commit: await getStoredCommit(opts.repo.id, details.sha) };
    console.error("Failed to insert commit:", insertError);
    return { status: "failed", commit: null };
  }

  // Embeddings for semantic search run AFTER the user already has the result:
  // they are only needed by later searches, so they never delay the response.
  const embedJob = (async () => {
    try {
      const chunks = buildChunks(details, analysis, title);
      const vectors = await embedTexts(chunks.map((c) => c.chunk_content));
      const { error: chunkError } = await admin.from("knowledge_chunks").insert(
        chunks.map((c, i) => ({
          commit_id: inserted.id,
          repo_id: opts.repo.id,
          chunk_content: c.chunk_content,
          chunk_type: c.chunk_type,
          embedding: JSON.stringify(vectors[i]),
          metadata: c.metadata,
        }))
      );
      if (chunkError) console.error("Failed to store knowledge chunks:", chunkError);
    } catch (e) {
      console.error(`Embedding failed for ${opts.sha}:`, e);
    }
    await admin.from("repositories").update({ last_indexed_at: new Date().toISOString() }).eq("id", opts.repo.id);
  })();
  waitUntil(embedJob);

  return { status: "processed", commit: inserted as CommitRow, model, usage };
}

/**
 * Used by "Explain briefly", Oracle chat and PDF: returns the stored analysis instantly
 * if anyone analysed this commit before; otherwise analyses it now (counts against limits).
 */
export async function ensureCommitIndexed(repo: RepoRef, sha: string, token: string | null, requester: Requester) {
  const existing = await getStoredCommit(repo.id, sha);
  if (existing) return { commit: existing, cached: true };

  checkAiBudget(requester);
  const r = await indexCommit({ repo, sha, token });
  if (!r.commit) throw new HttpError(502, `Could not analyse this commit. ${r.error || "Please try again."}`);
  if (r.status === "processed") {
    logUsage({ kind: "index", cached: false, requester, repoId: repo.id, model: r.model, usage: r.usage });
  }
  return { commit: r.commit, cached: r.status !== "processed" };
}

/** Runs async tasks with a concurrency limit. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]);
      }
    })
  );
  return out;
}

// Background work (history reading, backfills, webhook pushes) runs one job at a time,
// so it never uses up the AI provider's per-minute limit that interactive requests need.
let backgroundChain: Promise<unknown> = Promise.resolve();
export function enqueueBackground<T>(job: () => Promise<T>): Promise<T | undefined> {
  const next = backgroundChain.then(job, job).catch((e) => {
    console.error("Background job failed:", e);
    return undefined;
  });
  backgroundChain = next;
  return next;
}

/** Indexes the latest N commits of a repo. Oldest first so history context builds up. */
export async function indexRecentCommits(repo: RepoRef, token: string | null, count = 10, concurrency = 3) {
  const shas = await listRecentCommitShas(repo.name, repo.default_branch || null, token, count);
  const results = await mapLimit(shas.reverse(), concurrency, (sha) =>
    indexCommit({ repo, sha, token, skipMerges: true }).then((r) => {
      if (r.status === "processed") logUsage({ kind: "index", cached: false, repoId: repo.id, model: r.model, usage: r.usage });
      return r.status;
    })
  );
  return results;
}

/** Webhook: processes pushed commits one by one (keeps AI/GitHub rate limits happy). */
export async function processCommits(repoId: string, repoFullName: string, branch: string, shas: string[], token: string | null) {
  const counts: Record<IndexStatus, number> = { processed: 0, exists: 0, skipped: 0, failed: 0 };
  for (const sha of shas) {
    const r = await indexCommit({ repo: { id: repoId, name: repoFullName }, sha, token, branch, skipMerges: true });
    counts[r.status]++;
    if (r.status === "processed") logUsage({ kind: "index", cached: false, repoId, model: r.model, usage: r.usage });
  }
  console.log(`[${repoFullName}] commit processing finished`, counts);
  return counts;
}

/** Imports the latest N commits so a newly tracked repo isn't empty. */
export async function backfillRepo(repoId: string, repoFullName: string, branch: string | null, limit = 10) {
  try {
    const token = await getTokenForTrackedRepo(repoId);
    return await enqueueBackground(() => indexRecentCommits({ id: repoId, name: repoFullName, default_branch: branch }, token, limit, 1));
  } catch (e) {
    console.error(`Backfill failed for ${repoFullName}:`, e);
  }
}

/**
 * Registers a repo, links it to `userId` (so it shows in their timeline),
 * and makes sure the GitHub push webhook exists.
 */
export async function trackRepository(
  repo: { name: string; url: string; default_branch?: string | null; private?: boolean },
  userId: string,
  token: string | null
): Promise<{ id: string; hasCommits: boolean; webhook: string }> {
  const admin = createAdminClient();

  const { data: upserted, error: repoError } = await admin
    .from("repositories")
    .upsert(
      {
        name: repo.name,
        owner: repo.name.split("/")[0] || "unknown",
        url: repo.url,
        default_branch: repo.default_branch || "main",
        ...(typeof repo.private === "boolean" ? { private: repo.private, metadata_checked_at: new Date().toISOString() } : {}),
      },
      { onConflict: "name" }
    )
    .select("id")
    .single();
  if (repoError || !upserted) throw repoError || new Error("Failed to save repository");

  const { error: linkError } = await admin
    .from("user_repositories")
    .upsert({ user_id: userId, repository_id: upserted.id, assigned_by: userId }, { onConflict: "user_id,repository_id", ignoreDuplicates: true });
  if (linkError) console.error("Failed to link repository to user:", linkError);

  const webhook = token ? await ensureWebhook(repo.name, token) : "skipped";
  const { count } = await admin.from("commits").select("id", { count: "exact", head: true }).eq("repo_id", upserted.id);
  return { id: upserted.id, hasCommits: (count || 0) > 0, webhook };
}
