// lib/cache.ts
// Redis caching layer using Upstash (serverless Redis).
//
// Setup:
//   1. Create a free Redis database at https://upstash.com
//   2. Add UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN to your .env.local
//   3. npm install @upstash/redis
//
// If the env vars are not set, all cache operations silently no-op —
// the app still works, just without caching.

import { Redis } from '@upstash/redis';

let _redis: Redis | null = null;

function getRedis(): Redis | null {
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    return null;
  }
  if (!_redis) {
    _redis = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    });
  }
  return _redis;
}

// Default TTL: 60 seconds. Short enough to stay fresh, long enough to absorb bursts.
const DEFAULT_TTL_SECONDS = 60;

/**
 * Get a cached value by key. Returns null on cache miss or if Redis is not configured.
 */
export async function getCached<T>(key: string): Promise<T | null> {
  const redis = getRedis();
  if (!redis) return null;
  try {
    const data = await redis.get<T>(key);
    return data ?? null;
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
  const redis = getRedis();
  if (!redis) return;
  try {
    await redis.set(key, value, { ex: ttlSeconds });
  } catch (err) {
    console.warn('[cache] SET failed:', key, err);
  }
}

/**
 * Delete one or more keys from the cache.
 * Call this after any write operation to keep data fresh.
 */
export async function invalidateCache(...keys: string[]): Promise<void> {
  const redis = getRedis();
  if (!redis || keys.length === 0) return;
  try {
    await redis.del(...keys);
  } catch (err) {
    console.warn('[cache] DEL failed:', keys, err);
  }
}

// ---------------------------------------------------------------------------
// Cache key factories — keeps key names consistent across the codebase.
// Always use these instead of hardcoding strings.
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
 * Use this after bulk writes (e.g. CSV import, bulk SMS).
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
