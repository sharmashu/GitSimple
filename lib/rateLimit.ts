// Simple in-memory sliding-window rate limiter.
// Good enough for a single server / dev. On serverless hosting each instance
// keeps its own counters, so for production use a shared store (e.g. Upstash Redis).

const buckets = new Map<string, number[]>();

export function rateLimit(key: string, limit = 20, windowMs = 60_000): { ok: boolean; retryAfter: number } {
  const now = Date.now();
  const hits = (buckets.get(key) || []).filter((t) => now - t < windowMs);

  if (hits.length >= limit) {
    buckets.set(key, hits);
    return { ok: false, retryAfter: Math.ceil((windowMs - (now - hits[0])) / 1000) };
  }

  hits.push(now);
  buckets.set(key, hits);

  // Occasional cleanup so the map doesn't grow forever
  if (buckets.size > 5000) {
    buckets.forEach((v, k) => {
      if (!v.some((t) => now - t < windowMs)) buckets.delete(k);
    });
  }

  return { ok: true, retryAfter: 0 };
}
