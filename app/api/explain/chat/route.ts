import { NextRequest, NextResponse } from "next/server";
import { getRequester, checkAiBudget } from "@/lib/auth";
import { resolveRepo } from "@/lib/repoAccess";
import { ensureCommitIndexed } from "@/lib/commitProcessor";
import { relatedHistoryForCommit, semanticSearch, matchesToContext, toSources, rowToAnalysis } from "@/lib/history";
import { chatAboutCommit } from "@/lib/AI Summarizer";
import { cacheKey, getCached, setCached, normalizeQuestion, normalizeHistory } from "@/lib/cache";
import { isValidSha } from "@/lib/validation";
import { errorResponse, HttpError } from "@/lib/errors";
import { logUsage } from "@/lib/usage";

/**
 * POST /api/explain/chat { repoUrl, sha, userMessage, history }
 * Oracle chat about one commit. Context = the commit's diff + its analysis +
 * earlier commits touching the same files + semantic matches for the question.
 * Identical conversations are answered from the shared cache.
 */
export async function POST(req: NextRequest) {
  try {
    const { repoUrl, sha, userMessage, history } = await req.json();
    if (!isValidSha(sha)) throw new HttpError(400, "A valid commit sha is required.");
    if (typeof userMessage !== "string" || !userMessage.trim()) throw new HttpError(400, "Please type a question.");
    if (userMessage.length > 4000) throw new HttpError(400, "Message is too long (max 4000 characters).");

    const requester = await getRequester(req);
    const { repo, token } = await resolveRepo({ repoUrl }, requester);
    const { commit } = await ensureCommitIndexed(repo, sha, token, requester);

    const hist = normalizeHistory(history);
    const key = cacheKey("chat", repo.id, commit.commit_sha, normalizeQuestion(userMessage), hist);
    const hit = await getCached<{ answer: string; sources: any[] }>(key);
    if (hit) {
      logUsage({ kind: "chat", cached: true, requester, repoId: repo.id, commitSha: commit.commit_sha });
      return NextResponse.json({ ...hit, cached: true });
    }

    checkAiBudget(requester);
    const [related, matches] = await Promise.all([
      relatedHistoryForCommit(commit, { limit: 5 }),
      semanticSearch(repo.id, `${userMessage}\n(about commit: ${commit.title})`, 8),
    ]);
    const otherMatches = matches.filter((m) => m.commit_sha !== commit.commit_sha);

    const result = await chatAboutCommit({
      title: commit.title,
      diff: commit.diff_excerpt || "",
      analysis: rowToAnalysis(commit),
      related,
      matches: matchesToContext(otherMatches),
      question: userMessage.trim(),
      history: hist,
    });

    // Only list sources the answer actually used (cited by short SHA), else the closest ones
    const candidates = [
      ...related,
      ...otherMatches.map((m) => ({ sha: m.commit_sha, shortSha: m.short_sha, title: m.commit_title, author: m.author_name, date: m.committed_at })),
    ];
    const cited = candidates.filter((c) => result.text.includes(c.shortSha));
    const sources = toSources(cited.length ? cited : candidates.slice(0, 3), repo.url);

    const response = { answer: result.text, sources };
    await setCached(key, "chat", response, { repoId: repo.id, commitSha: commit.commit_sha });
    logUsage({ kind: "chat", cached: false, requester, repoId: repo.id, commitSha: commit.commit_sha, model: result.model, usage: result.usage });
    return NextResponse.json({ ...response, cached: false });
  } catch (e) {
    return errorResponse(e, "Failed to answer.");
  }
}
