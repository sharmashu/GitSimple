import { headers } from "next/headers";

/** Public base URL of the app. Behind Docker/proxies the Origin header can be missing, so SITE_URL wins. */
export function siteUrl(): string {
  const env = (process.env.SITE_URL || process.env.NEXT_PUBLIC_SITE_URL || "").replace(/\/+$/, "");
  if (env) return env;
  const h = headers();
  const origin = h.get("origin");
  if (origin) return origin;
  const host = h.get("x-forwarded-host") || h.get("host") || "localhost:3000";
  const proto = h.get("x-forwarded-proto") || (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

/** Only allow same-site relative redirects like "/dashboard" (prevents open redirects). */
export function safeNext(next: unknown, fallback = "/dashboard"): string {
  return typeof next === "string" && next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\") ? next : fallback;
}
