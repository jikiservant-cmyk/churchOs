// lib/rate-limit.ts
// Per-route rate limiting using Upstash Ratelimit.
//
// Setup:
//   1. Same Upstash Redis instance used by lib/cache.ts
//   2. npm install @upstash/ratelimit @upstash/redis
//
// Usage in an API route:
//   import { checkRateLimit } from '@/lib/rate-limit';
//
//   export async function POST(request: NextRequest) {
//     const limited = await checkRateLimit(request, 'api');
//     if (limited) return limited;  // returns 429 response
//     // ... your handler
//   }

import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';
import { NextRequest, NextResponse } from 'next/server';

export type LimiterType = 'api' | 'sms' | 'auth' | 'bulkSms';

let _limiters: Record<LimiterType, Ratelimit> | null = null;

function getLimiters(): Record<LimiterType, Ratelimit> | null {
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    // Redis not configured — rate limiting is disabled (app still works)
    return null;
  }
  if (!_limiters) {
    const redis = new Redis({
      url:   process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    });
    _limiters = {
      // General API routes: 60 requests per 10 seconds per IP
      api: new Ratelimit({
        redis,
        limiter: Ratelimit.slidingWindow(60, '10 s'),
        prefix:  'rl:api',
      }),
      // SMS sending: 10 requests per minute per tenant (prevents accidental floods)
      sms: new Ratelimit({
        redis,
        limiter: Ratelimit.slidingWindow(10, '1 m'),
        prefix:  'rl:sms',
      }),
      // Bulk SMS (e.g. "message all members"): 3 per hour per tenant
      bulkSms: new Ratelimit({
        redis,
        limiter: Ratelimit.slidingWindow(3, '1 h'),
        prefix:  'rl:bulksms',
      }),
      // Auth (login/signup): 10 attempts per 15 minutes per IP
      auth: new Ratelimit({
        redis,
        limiter: Ratelimit.slidingWindow(10, '15 m'),
        prefix:  'rl:auth',
      }),
    };
  }
  return _limiters;
}

/**
 * Check rate limit for a request.
 *
 * Returns null if the request is within the limit.
 * Returns a 429 NextResponse if the limit is exceeded.
 *
 * @param request    - The incoming NextRequest
 * @param type       - Which limiter to use ('api' | 'sms' | 'bulkSms' | 'auth')
 * @param identifier - Optional custom identifier (e.g. tenantId for SMS limits).
 *                     Defaults to the caller's IP address.
 */
export async function checkRateLimit(
  request: NextRequest,
  type: LimiterType = 'api',
  identifier?: string
): Promise<NextResponse | null> {
  const limiters = getLimiters();

  // Fail open: if Redis isn't configured, don't block anyone.
  if (!limiters) return null;

  const ip =
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    request.headers.get('x-real-ip') ??
    '127.0.0.1';

  const key    = identifier ?? ip;
  const limiter = limiters[type];

  try {
    const { success, limit, remaining, reset } = await limiter.limit(key);

    if (!success) {
      const retryAfter = Math.ceil((reset - Date.now()) / 1000);
      return NextResponse.json(
        { error: 'Too many requests. Please wait and try again.' },
        {
          status: 429,
          headers: {
            'X-RateLimit-Limit':     String(limit),
            'X-RateLimit-Remaining': String(remaining),
            'X-RateLimit-Reset':     String(reset),
            'Retry-After':           String(retryAfter),
          },
        }
      );
    }
  } catch (err) {
    // If Redis is down, fail open — legitimate users should never be blocked
    // just because the rate limiter is unavailable.
    console.warn('[rate-limit] Check failed (failing open):', type, err);
  }

  return null;
}
