/**
 * Tiny in-memory LRU + TTL cache for serverless route handlers.
 *
 * Vercel Lambdas have a 512MB–1GB cap. Multiple routes were caching
 * multi-MB JSON blobs (snapshots, diffs, Shapley outputs) in unbounded
 * `Map` instances — 20 entries × 5MB easily blows the budget and the
 * function gets cold-killed. This helper enforces both:
 *
 *   1. Time-based TTL (entries expire after `ttlMs` from write)
 *   2. Size-based LRU (when over `maxSize`, evict least-recently-used)
 *
 * Implementation note: JavaScript Maps preserve insertion order, so
 * we re-insert on every access to keep the LRU semantics — `delete`
 * then `set` is cheap and avoids tracking a separate access timestamp.
 *
 * Not thread-safe in the strict sense, but Node.js's single-threaded
 * event loop means concurrent `get`/`set` calls within a single
 * function instance are serialized.
 */

export interface LruCacheOptions {
  /** Time-to-live in ms before an entry is considered stale. */
  ttlMs: number;
  /** Max number of entries before LRU eviction kicks in. */
  maxSize: number;
}

interface Entry<V> {
  value: V;
  writtenAt: number;
}

export class LruCache<K, V> {
  private map = new Map<K, Entry<V>>();
  private readonly ttlMs: number;
  private readonly maxSize: number;

  constructor(options: LruCacheOptions) {
    this.ttlMs = options.ttlMs;
    this.maxSize = options.maxSize;
  }

  get(key: K): V | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.writtenAt > this.ttlMs) {
      this.map.delete(key);
      return undefined;
    }
    // Refresh LRU position
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key: K, value: V): void {
    // Remove if present so re-insert puts it at the end (LRU tail)
    this.map.delete(key);
    this.map.set(key, { value, writtenAt: Date.now() });
    // Evict oldest while over capacity
    while (this.map.size > this.maxSize) {
      const oldestKey = this.map.keys().next().value;
      if (oldestKey === undefined) break;
      this.map.delete(oldestKey);
    }
  }

  delete(key: K): void {
    this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}
