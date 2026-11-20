/** Usage metering: one row per AI-backed request (cached or not). Useful for SaaS billing/quotas. */
import { waitUntil } from "@vercel/functions";
import { createAdminClient } from "@/utils/supabase/server";
import type { Requester } from "@/lib/auth";

export function logUsage(entry: {
  kind: "brief" | "chat" | "pdf" | "ask" | "index";
  cached: boolean;
  requester?: Requester | null;
  repoId?: string | null;
  model?: string | null;
  usage?: { input: number; output: number } | null;
}) {
  const p = (async () => {
    try {
      await createAdminClient().from("ai_usage").insert({
        kind: entry.kind,
        cached: entry.cached,
        user_id: entry.requester?.user?.id || null,
        requester_hash: entry.requester?.hash || null,
        repo_id: entry.repoId || null,
        model: entry.model || null,
        input_tokens: entry.usage?.input || 0,
        output_tokens: entry.usage?.output || 0,
      });
    } catch {
      // metering must never break a request
    }
  })();
  waitUntil(p);
}
