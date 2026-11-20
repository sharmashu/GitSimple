import { NextRequest, NextResponse } from "next/server";
import { getRequester } from "@/lib/auth";
import { resolveRepo } from "@/lib/repoAccess";
import { ensureCommitIndexed } from "@/lib/commitProcessor";
import { relatedHistoryForCommit, toSources } from "@/lib/history";
import { isValidSha } from "@/lib/validation";
import { errorResponse, HttpError } from "@/lib/errors";
import { logUsage } from "@/lib/usage";

/**
 * POST /api/explain/brief { repoUrl, sha }
 * Returns the stored analysis if anyone analysed this commit before (0 tokens);
 * otherwise analyses it once, with related history (RAG) as context.
 */
export async function POST(req: NextRequest) {
  try {
    const { repoUrl, sha } = await req.json();
    if (!isValidSha(sha)) throw new HttpError(400, "A valid commit sha is required.");

    const requester = await getRequester(req);
    const { repo, token } = await resolveRepo({ repoUrl }, requester);
    const { commit, cached } = await ensureCommitIndexed(repo, sha, token, requester);
    const related = await relatedHistoryForCommit(commit, { limit: 4 });

    if (cached) logUsage({ kind: "brief", cached: true, requester, repoId: repo.id });

    return NextResponse.json({
      summary: commit.brief_summary || commit.executive_summary,
      analysis: {
        impactLevel: commit.impact_level,
        executiveSummary: commit.executive_summary,
        breakingChanges: commit.breaking_changes || [],
        domains: commit.affected_domains || [],
        stats: commit.stats,
      },
      related: toSources(related, repo.url),
      cached,
    });
  } catch (e) {
    return errorResponse(e, "Failed to generate summary.");
  }
}
