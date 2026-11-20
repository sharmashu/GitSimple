import { NextRequest, NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { createAdminClient } from "@/utils/supabase/server";
import { getRequester, checkAiBudget } from "@/lib/auth";
import { resolveRepo } from "@/lib/repoAccess";
import { indexRecentCommits, enqueueBackground } from "@/lib/commitProcessor";
import { listCommits, CommitListItem } from "@/lib/github";
import { semanticSearch, matchesToContext, toSources } from "@/lib/history";
import { answerRepoQuestion, ContextItem } from "@/lib/AI Summarizer";
import { cacheKey, getCached, setCached, normalizeQuestion, normalizeHistory } from "@/lib/cache";
import { errorResponse, HttpError } from "@/lib/errors";
import { logUsage } from "@/lib/usage";

export const maxDuration = 300;

// Avoid re-triggering background indexing for the same repo over and over
const indexingStarted = new Map<string, number>();
const REINDEX_MS = 60 * 60_000;

/**
 * POST /api/ask { repoUrl | repoId, question, history }
 * Answers questions about a repository's whole history (RAG over stored analyses + diffs).
 * Works for public repos without login. Repos nobody analysed yet are indexed on first use.
 */
export async function POST(req: NextRequest) {
  try {
    const { repoId, repoUrl, question, history } = await req.json();
    if (typeof question !== "string" || !question.trim() || question.length > 2000) {
      throw new HttpError(400, "Please enter a question (max 2000 characters).");
    }

    const requester = await getRequester(req);
    const { repo, token } = await resolveRepo({ repoId, repoUrl }, requester);
    const admin = createAdminClient();

    const countCommits = async () =>
      (await admin.from("commits").select("id", { count: "exact", head: true }).eq("repo_id", repo.id)).count || 0;
    const indexed = await countCommits();
    let indexing = false;

    // Little analysed history yet: don't make the user wait for full AI analysis.
    // Answer now from the commit messages GitHub already gives us (one quick request),
    // while deeper analysis runs in the background (below).
    let quickCommits: CommitListItem[] = [];
    if (indexed < 5) {
      try {
        quickCommits = (await listCommits(repo.name, token, 1, 15, repo.default_branch)).commits;
      } catch (e) {
        console.warn("Could not list commits for quick context:", e);
      }
    }

    // Then keep filling history in the background (up to 25 recent commits), at most once an hour per repo
    const lastStart = indexingStarted.get(repo.id) || 0;
    if (indexed < 25 && Date.now() - lastStart > REINDEX_MS) {
      indexingStarted.set(repo.id, Date.now());
      indexing = true;
      // One AI call at a time in the background, behind any other background work
      waitUntil(enqueueBackground(() => indexRecentCommits(repo, token, 25, 1)).then(() => undefined));
    }

    if (indexed === 0 && quickCommits.length === 0) {
      return NextResponse.json({
        answer: "I couldn't read any commits for this repository yet. Please try again in a minute.",
        sources: [],
        indexing,
        cached: false,
      });
    }

    // Cache: same question + same conversation + same indexed history → same answer
    const { data: newest } = await admin
      .from("commits").select("created_at").eq("repo_id", repo.id).order("created_at", { ascending: false }).limit(1).maybeSingle();
    const hist = normalizeHistory(history);
    const key = cacheKey("ask", repo.id, indexed, newest?.created_at || "", normalizeQuestion(question), hist);
    const hit = await getCached<{ answer: string; sources: any[] }>(key);
    if (hit) {
      logUsage({ kind: "ask", cached: true, requester, repoId: repo.id });
      return NextResponse.json({ ...hit, indexing, indexedCommits: indexed, cached: true });
    }

    checkAiBudget(requester);
    const [matches, { data: recent }] = await Promise.all([
      semanticSearch(repo.id, question, 10, 0.45),
      admin
        .from("commits")
        .select("commit_sha, short_sha, title, author_name, executive_summary, impact_level, committed_at")
        .eq("repo_id", repo.id)
        .order("committed_at", { ascending: false })
        .limit(6),
    ]);

    const context: ContextItem[] = [
      ...matchesToContext(matches),
      ...(recent || []).map((c: any) => ({
        shortSha: c.short_sha,
        title: c.title,
        author: c.author_name,
        date: c.committed_at,
        content: `(recent commit) Type: ${c.impact_level}. ${c.executive_summary}`,
      })),
    ];

    const analysedShas = new Set((recent || []).map((c: any) => c.commit_sha));
    for (const c of quickCommits) {
      if (analysedShas.has(c.sha)) continue;
      context.push({
        shortSha: c.shortSha,
        title: c.message.split("\n")[0].slice(0, 200),
        author: c.author,
        date: c.date,
        content: `(commit message only; detailed analysis still loading) ${c.message.slice(0, 600)}`,
      });
    }

    const result = await answerRepoQuestion(repo.name, question.trim(), context, hist);

    const candidates = [
      ...matches.map((m) => ({ sha: m.commit_sha, shortSha: m.short_sha, title: m.commit_title, author: m.author_name, date: m.committed_at })),
      ...(recent || []).map((c: any) => ({ sha: c.commit_sha, shortSha: c.short_sha, title: c.title, author: c.author_name, date: c.committed_at })),
      ...quickCommits.map((c) => ({ sha: c.sha, shortSha: c.shortSha, title: c.message.split("\n")[0].slice(0, 200), author: c.author, date: c.date })),
    ];
    const cited = candidates.filter((c) => result.text.includes(c.shortSha));
    const sources = toSources(cited.length ? cited : candidates.slice(0, 4), repo.url).slice(0, 8);

    const response = { answer: result.text, sources };
    await setCached(key, "ask", response, { repoId: repo.id });
    logUsage({ kind: "ask", cached: false, requester, repoId: repo.id, model: result.model, usage: result.usage });
    return NextResponse.json({ ...response, indexing, indexedCommits: indexed, cached: false });
  } catch (e) {
    return errorResponse(e, "Failed to answer.");
  }
}
