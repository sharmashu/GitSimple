import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/utils/supabase/server";
import { getRequester, checkAiBudget } from "@/lib/auth";
import { resolveRepo } from "@/lib/repoAccess";
import { ensureCommitIndexed } from "@/lib/commitProcessor";
import { relatedHistoryForCommit, rowToAnalysis, CommitRow } from "@/lib/history";
import { generateDetailedReport } from "@/lib/AI Summarizer";
import { generateCommitPDF } from "@/lib/PDF Generator";
import { isValidSha } from "@/lib/validation";
import { errorResponse, HttpError } from "@/lib/errors";
import { logUsage } from "@/lib/usage";
import type { Requester } from "@/lib/auth";

export const maxDuration = 120;

// Concurrent requests for the same report share one AI call
const inflight = new Map<string, Promise<string>>();

async function getOrCreateReport(commit: CommitRow, requester: Requester): Promise<{ report: string; cached: boolean }> {
  if (commit.detailed_report) return { report: commit.detailed_report, cached: true };

  const running = inflight.get(commit.id);
  if (running) return { report: await running, cached: true };

  checkAiBudget(requester);
  const p = (async () => {
    const related = await relatedHistoryForCommit(commit, { semantic: true, limit: 6 });
    const result = await generateDetailedReport({
      title: commit.title,
      message: commit.message,
      diff: commit.diff_excerpt || "",
      analysis: rowToAnalysis(commit),
      related,
    });
    // Stored once: every later download (by anyone with access) costs 0 tokens
    await createAdminClient().from("commits").update({ detailed_report: result.text }).eq("id", commit.id);
    logUsage({ kind: "pdf", cached: false, requester, repoId: commit.repo_id, commitSha: commit.commit_sha, model: result.model, usage: result.usage });
    return result.text;
  })().finally(() => inflight.delete(commit.id));
  inflight.set(commit.id, p);
  return { report: await p, cached: false };
}

/** GET /api/explain/pdf?repoUrl=...&sha=... */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const sha = searchParams.get("sha");
  try {
    if (!isValidSha(sha)) throw new HttpError(400, "A valid commit sha is required.");
    const requester = await getRequester(req);
    const { repo, token } = await resolveRepo({ repoUrl: searchParams.get("repoUrl") }, requester);
    const { commit } = await ensureCommitIndexed(repo, sha, token, requester);
    const { report, cached } = await getOrCreateReport(commit, requester);
    if (cached) logUsage({ kind: "pdf", cached: true, requester, repoId: repo.id, commitSha: commit.commit_sha });

    const related = await relatedHistoryForCommit(commit, { limit: 6 });
    const pdf = generateCommitPDF({
      repoName: repo.name,
      repoUrl: repo.url,
      sha: commit.commit_sha,
      title: commit.title,
      author: commit.author_name,
      date: commit.committed_at,
      impactLevel: commit.impact_level,
      stats: commit.stats,
      executiveSummary: commit.executive_summary,
      breakingChanges: commit.breaking_changes || [],
      domains: commit.affected_domains || [],
      detailedReport: report,
      related: related.map((r) => ({ shortSha: r.shortSha, title: r.title, author: r.author, date: r.date, reason: r.reason })),
    });

    return new NextResponse(pdf, {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${repo.name.replace("/", "-")}-${commit.short_sha}.pdf"`,
        // Public commits never change: let browsers/CDNs keep the file
        "Cache-Control": repo.private ? "private, no-store" : "public, max-age=86400, immutable",
      },
    });
  } catch (e) {
    // The PDF is opened as a normal link: send guests to login for private repos
    if (e instanceof HttpError && e.extra.needsLogin) {
      const next = `/?repo=${encodeURIComponent(searchParams.get("repoUrl") || "")}`;
      return NextResponse.redirect(new URL(`/login?next=${encodeURIComponent(next)}`, req.url));
    }
    return errorResponse(e, "Failed to generate PDF.");
  }
}
