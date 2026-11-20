/**
 * Usage metering: one row per AI-backed request (cached or not), plus "open" rows when a
 * signed-in user opens a repository. Feeds the dashboard and the manager's Team Activity page.
 */
import { waitUntil } from "@vercel/functions";
import { createAdminClient } from "@/utils/supabase/server";
import type { Requester } from "@/lib/auth";

export function logUsage(entry: {
  kind: "brief" | "chat" | "pdf" | "ask" | "index" | "open";
  cached: boolean;
  requester?: Requester | null;
  repoId?: string | null;
  /** The commit the request was about (never the question text). */
  commitSha?: string | null;
  model?: string | null;
  usage?: { input: number; output: number } | null;
}) {
  const p = (async () => {
    try {
      const row: Record<string, unknown> = {
        kind: entry.kind,
        cached: entry.cached,
        user_id: entry.requester?.user?.id || null,
        requester_hash: entry.requester?.hash || null,
        repo_id: entry.repoId || null,
        model: entry.model || null,
        input_tokens: entry.usage?.input || 0,
        output_tokens: entry.usage?.output || 0,
        commit_sha: entry.commitSha || null,
      };
      const admin = createAdminClient();
      const { error } = await admin.from("ai_usage").insert(row);
      // Migration 004 not applied yet: store the row without the commit column
      if (error && /commit_sha/.test(error.message || "")) {
        delete row.commit_sha;
        await admin.from("ai_usage").insert(row);
      }
    } catch {
      // metering must never break a request
    }
  })();
  waitUntil(p);
}
