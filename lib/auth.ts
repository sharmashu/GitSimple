import crypto from "crypto";
import { NextResponse } from "next/server";
import type { User } from "@supabase/supabase-js";
import { createClient, createAdminClient } from "@/utils/supabase/server";
import { rateLimit } from "@/lib/rateLimit";
import { HttpError } from "@/lib/errors";

/** Who is making a request: a logged-in user, or an anonymous visitor identified by IP. */
export interface Requester {
  user: User | null;
  /** Stable key for rate limits: user id, or a hash of the IP address */
  key: string;
  /** Privacy-friendly identifier stored in usage logs */
  hash: string;
}

function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  return (fwd?.split(",")[0] || req.headers.get("x-real-ip") || "unknown").trim();
}

function hashValue(v: string) {
  const salt = process.env.USAGE_HASH_SALT || process.env.GITHUB_WEBHOOK_SECRET || "gitsimple";
  return crypto.createHash("sha256").update(salt + v).digest("hex").slice(0, 32);
}

export async function getRequester(req: Request): Promise<Requester> {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (user) return { user, key: `u:${user.id}`, hash: hashValue(`u:${user.id}`) };
  const h = hashValue(`ip:${clientIp(req)}`);
  return { user: null, key: `ip:${h}`, hash: h };
}

const num = (k: string, d: number) => Number(process.env[k]) || d;

/**
 * Call right before spending tokens. Cached answers never reach this, so they are free and unlimited.
 * Limits are configurable per deployment (SaaS plans can map to these).
 */
export function checkAiBudget(r: Requester, cost = 1) {
  const perMin = r.user ? num("USER_AI_PER_MINUTE", 20) : num("ANON_AI_PER_MINUTE", 6);
  const perDay = r.user ? num("USER_AI_PER_DAY", 500) : num("ANON_AI_PER_DAY", 60);
  for (let i = 0; i < cost; i++) {
    const m = rateLimit(`${r.key}:min`, perMin, 60_000);
    if (!m.ok) throw new HttpError(429, `Too many AI requests. Try again in ${m.retryAfter}s.`, { retryAfter: m.retryAfter });
    const d = rateLimit(`${r.key}:day`, perDay, 86_400_000);
    if (!d.ok) {
      throw new HttpError(429, r.user
        ? "Daily AI limit reached for your account."
        : "Daily limit for guests reached. Sign in to keep going.", { retryAfter: d.retryAfter, needsLogin: !r.user });
    }
  }
}

/**
 * Returns the logged-in user, or a ready-made error response (401 / 429).
 */
export async function requireUser(
  opts: { limit?: number; bucket?: string } = {}
): Promise<{ user: User; error?: undefined } | { user?: undefined; error: NextResponse }> {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return { error: NextResponse.json({ error: "Please log in first." }, { status: 401 }) };
  }

  const { ok, retryAfter } = rateLimit(`${opts.bucket || "ai"}:${user.id}`, opts.limit ?? 20);
  if (!ok) {
    return {
      error: NextResponse.json(
        { error: `Too many requests. Try again in ${retryAfter}s.` },
        { status: 429, headers: { "Retry-After": String(retryAfter) } }
      ),
    };
  }

  return { user };
}

export interface AccessibleRepo {
  id: string;
  name: string;
  url: string;
  default_branch: string | null;
  private?: boolean | null;
}

/**
 * Repositories a user has in their workspace (Timeline / Ask list):
 * repos assigned to them, plus repos they assigned to others, tracked, or opened privately.
 */
export async function getAccessibleRepos(userId: string): Promise<AccessibleRepo[]> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("user_repositories")
    .select("repositories(id, name, url, default_branch, private)")
    .or(`user_id.eq.${userId},assigned_by.eq.${userId}`);

  const map = new Map<string, AccessibleRepo>();
  for (const row of (data || []) as any[]) {
    const r = Array.isArray(row.repositories) ? row.repositories[0] : row.repositories;
    if (r?.id) map.set(r.id, r);
  }
  return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
}
