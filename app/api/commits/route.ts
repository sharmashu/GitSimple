import { NextRequest, NextResponse } from "next/server";
import { getRequester } from "@/lib/auth";
import { resolveRepo } from "@/lib/repoAccess";
import { listCommits, CommitListItem } from "@/lib/github";
import { createAdminClient } from "@/utils/supabase/server";
import { errorResponse } from "@/lib/errors";
import { MemoryCache } from "@/lib/memoryCache";
import { logUsage } from "@/lib/usage";

// Commit lists are cached for 60s (public repos are shared between all visitors)
const listCache = new MemoryCache<{ commits: CommitListItem[]; hasMore: boolean }>(500, 60_000);
// One "opened repository" activity row per user and repo every 15 minutes (for Team Activity)
const openLogged = new MemoryCache<true>(5000, 15 * 60_000);

/** GET /api/commits?repo=<github url>&page=1 — works without login for public repos. */
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const page = Math.min(Math.max(parseInt(searchParams.get("page") || "1", 10) || 1, 1), 50);
    const requester = await getRequester(req);
    const { repo, token } = await resolveRepo({ repoUrl: searchParams.get("repo") }, requester);

    if (requester.user && page === 1) {
      const openKey = `${requester.user.id}|${repo.id}`;
      if (!openLogged.get(openKey)) {
        openLogged.set(openKey, true);
        logUsage({ kind: "open", cached: true, requester, repoId: repo.id });
      }
    }

    const cacheId = `${repo.id}|${page}|${repo.private ? requester.key : "public"}`;
    let list = listCache.get(cacheId);
    if (!list) {
      list = await listCommits(repo.name, token, page, 15);
      listCache.set(cacheId, list);
    }

    // Attach analyses that already exist, so their summaries show instantly (no AI call)
    const shas = list.commits.map((c) => c.sha);
    const analysed = new Map<string, any>();
    if (shas.length) {
      const { data } = await createAdminClient()
        .from("commits")
        .select("commit_sha, brief_summary, executive_summary, impact_level, breaking_changes, affected_domains, stats, detailed_report")
        .eq("repo_id", repo.id)
        .in("commit_sha", shas);
      (data || []).forEach((c: any) => analysed.set(c.commit_sha, c));
    }

    return NextResponse.json({
      repo: { id: repo.id, name: repo.name, url: repo.url, private: repo.private, defaultBranch: repo.default_branch },
      page,
      hasMore: list.hasMore,
      commits: list.commits.map((c) => {
        const a = analysed.get(c.sha);
        return {
          ...c,
          analysis: a
            ? {
                brief: a.brief_summary || a.executive_summary,
                impactLevel: a.impact_level,
                breakingChanges: a.breaking_changes || [],
                domains: a.affected_domains || [],
                stats: a.stats,
                hasReport: !!a.detailed_report,
              }
            : null,
        };
      }),
    }, { headers: { "Cache-Control": "private, max-age=30" } });
  } catch (e: any) {
    if (e?.status === 429 && !(e as any).extra) return NextResponse.json({ error: e.message }, { status: 429 });
    return errorResponse(e, "Failed to fetch commits.");
  }
}
