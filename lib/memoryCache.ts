/** Tiny in-process LRU cache with TTL, used in front of the database cache and for GitHub metadata. */
export class MemoryCache<T> {
  private map = new Map<string, { value: T; expires: number }>();
  constructor(private max = 500, private ttlMs = 10 * 60_000) {}

  get(key: string): T | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (hit.expires < Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    // refresh LRU order
    this.map.delete(key);
    this.map.set(key, hit);
    return hit.value;
  }

  set(key: string, value: T, ttlMs = this.ttlMs) {
    if (this.map.size >= this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(key, { value, expires: Date.now() + ttlMs });
  }

  delete(key: string) {
    this.map.delete(key);
  }
}
