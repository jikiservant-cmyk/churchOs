// lib/cache.ts
// Redis caching layer using Upstash REST API (no npm package required).
//
// Setup:
//   1. Create a free Redis database at https://upstash.com
//   2. Add UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN to your .env.local
//
// If the env vars are not set, all cache operations silently no-op —
// the app still works, just without caching.

function getConfig() {
  const url   = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return { url, token };
}

async function redisCommand(args: (string | number)[]): Promise<unknown> {
  const config = getConfig();
  if (!config) return null;

  const res = await fetch(`${config.url}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args),
  });

  const json = await res.json();
  if (json.error) throw new Error(json.error);
  return json.result;
}

// Default TTL: 60 seconds.
const DEFAULT_TTL_SECONDS = 60;

/**
 * Get a cached value by key. Returns null on cache miss or if Redis is not configured.
 */
export async function getCached<T>(key: string): Promise<T | null> {
  if (!getConfig()) return null;
  try {
    const result = await redisCommand(['GET', key]);
    if (result === null || result === undefined) return null;
    return (typeof result === 'string' ? JSON.parse(result) : result) as T;
  } catch (err) {
    console.warn('[cache] GET failed:', key, err);
    return null;
  }
}

/**
 * Store a value in the cache with an optional TTL (seconds).
 */
export async function setCached<T>(
  key: string,
  value: T,
  ttlSeconds: number = DEFAULT_TTL_SECONDS
): Promise<void> {
  if (!getConfig()) return;
  try {
    await redisCommand(['SET', key, JSON.stringify(value), 'EX', ttlSeconds]);
  } catch (err) {
    console.warn('[cache] SET failed:', key, err);
  }
}

/**
 * Delete one or more keys from the cache.
 */
export async function invalidateCache(...keys: string[]): Promise<void> {
  if (!getConfig() || keys.length === 0) return;
  try {
    await redisCommand(['DEL', ...keys]);
  } catch (err) {
    console.warn('[cache] DEL failed:', keys, err);
  }
}

// ---------------------------------------------------------------------------
// Cache key factories
// ---------------------------------------------------------------------------
export const cacheKeys = {
  members:        (churchId: string, page = 0) => `members:${churchId}:p${page}`,
  memberCount:    (churchId: string)            => `members:${churchId}:count`,
  wallet:         (tenantId: string)            => `wallet:${tenantId}`,
  dashboardStats: (churchId: string)            => `dashboard:${churchId}:stats`,
  events:         (churchId: string)            => `events:${churchId}`,
  smallGroups:    (churchId: string)            => `groups:${churchId}`,
  newConverts:    (churchId: string)            => `converts:${churchId}`,
  attendance:     (eventId: string)             => `attendance:${eventId}`,
};

/**
 * Invalidate all cached data for a church in one call.
 */
export async function invalidateChurch(churchId: string): Promise<void> {
  await invalidateCache(
    cacheKeys.members(churchId, 0),
    cacheKeys.memberCount(churchId),
    cacheKeys.wallet(churchId),
    cacheKeys.dashboardStats(churchId),
    cacheKeys.events(churchId),
    cacheKeys.smallGroups(churchId),
    cacheKeys.newConverts(churchId)
  );
}
