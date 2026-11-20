/**
 * Shared answer cache. If anyone already asked the same question about the same
 * commit/repo state, the stored answer is returned and no tokens are spent.
 * Layer 1: in-memory LRU (per server). Layer 2: `ai_cache` table (shared by all servers).
 */
import crypto from "crypto";
import { waitUntil } from "@vercel/functions";
import { createAdminClient } from "@/utils/supabase/server";
import { MemoryCache } from "@/lib/memoryCache";

const memory = new MemoryCache<any>(1000, 30 * 60_000);

export function cacheKey(...parts: unknown[]): string {
  return crypto.createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

/** "What does this do??" and "what does this do" hit the same cache entry. */
export function normalizeQuestion(q: string): string {
  return q.toLowerCase().replace(/\s+/g, " ").replace(/[?!.\s]+$/g, "").trim();
}

export function normalizeHistory(history: unknown): { role: string; content: string }[] {
  if (!Array.isArray(history)) return [];
  return history
    .filter((h: any) => h && typeof h.content === "string" && (h.role === "user" || h.role === "assistant"))
    .slice(-10)
    .map((h: any) => ({ role: h.role, content: h.content.slice(0, 3000) }));
}

export async function getCached<T>(key: string): Promise<T | null> {
  const m = memory.get(key);
  if (m !== undefined) return m as T;
  try {
    const admin = createAdminClient();
    const { data } = await admin.from("ai_cache").select("response, hits").eq("key", key).maybeSingle();
    if (!data) return null;
    memory.set(key, data.response);
    waitUntil(
      Promise.resolve(
        admin.from("ai_cache").update({ hits: (data.hits || 0) + 1, last_hit_at: new Date().toISOString() }).eq("key", key)
      ).then(() => undefined, () => undefined)
    );
    return data.response as T;
  } catch {
    return null;
  }
}

export async function setCached(key: string, kind: string, value: unknown, refs: { repoId?: string; commitSha?: string } = {}) {
  memory.set(key, value);
  try {
    const admin = createAdminClient();
    await admin.from("ai_cache").upsert({
      key,
      kind,
      repo_id: refs.repoId || null,
      commit_sha: refs.commitSha || null,
      response: value,
    });
  } catch (e) {
    console.warn("Failed to store cache entry", e);
  }
}
