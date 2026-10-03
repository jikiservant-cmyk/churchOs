import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

/**
 * Edge middleware: session refresh + coarse gating + CSRF origin check.
 *
 * This is DEFENCE IN DEPTH only. Authorisation lives in the data access layer
 * (lib/auth/tenant.ts) and in RLS — never rely on middleware or layouts alone.
 */

// Routes called by third parties / cron with their own secret. No browser origin.
const ORIGIN_EXEMPT_API = ['/api/najiki/webhook', '/api/sms/process-queue'];

const ADMIN_PATH = /^\/[^/]+\/admin(?:\/|$)/;
const ADMIN_LOGIN_PATH = /^\/[^/]+\/admin\/login\/?$/;

function sessionCookie(options: Record<string, unknown>) {
  const crossSite = process.env.ALLOW_CROSS_SITE_COOKIES === 'true';
  return {
    ...options,
    sameSite: crossSite ? ('none' as const) : ('lax' as const),
    secure: crossSite || process.env.NODE_ENV === 'production',
  };
}

function originAllowed(request: NextRequest): boolean {
  const origin = request.headers.get('origin');
  if (!origin) {
    const site = request.headers.get('sec-fetch-site');
    return site === 'same-origin' || site === 'none';
  }
  const host = request.headers.get('x-forwarded-host') || request.headers.get('host');
  const allowed = new Set<string>();
  if (host) {
    allowed.add(`https://${host}`);
    allowed.add(`http://${host}`);
  }
  for (const v of [process.env.NEXT_PUBLIC_APP_URL, process.env.APP_URL, ...(process.env.ALLOWED_ORIGINS || '').split(',')]) {
    const t = v?.trim().replace(/\/+$/, '');
    if (t) allowed.add(t);
  }
  return allowed.has(origin.replace(/\/+$/, ''));
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const method = request.method.toUpperCase();

  // CSRF: state-changing API calls must come from our own origin.
  if (
    pathname.startsWith('/api/') &&
    !['GET', 'HEAD', 'OPTIONS'].includes(method) &&
    !ORIGIN_EXEMPT_API.some((p) => pathname === p) &&
    !originAllowed(request)
  ) {
    return NextResponse.json({ error: 'Cross-origin request blocked' }, { status: 403 });
  }

  let supabaseResponse = NextResponse.next({ request });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    if (process.env.NODE_ENV === 'production' && ADMIN_PATH.test(pathname) && !ADMIN_LOGIN_PATH.test(pathname)) {
      return new NextResponse('Service unavailable', { status: 503 });
    }
    return supabaseResponse;
  }

  const supabase = createServerClient(url, key, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        supabaseResponse = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) =>
          supabaseResponse.cookies.set(name, value, sessionCookie(options as Record<string, unknown>)),
        );
      },
    },
  });

  try {
    // getUser() validates the JWT with Supabase Auth (getSession() would not).
    const { data: { user } } = await supabase.auth.getUser();

    if (ADMIN_PATH.test(pathname) && !ADMIN_LOGIN_PATH.test(pathname) && !user) {
      const dest = request.nextUrl.clone();
      dest.pathname = '/';
      dest.search = '?error=Session%20Expired';
      return NextResponse.redirect(dest);
    }
  } catch (e) {
    console.error('[middleware] auth check failed:', (e as Error).message);
    // Fail closed for admin routes if Auth is unreachable.
    if (ADMIN_PATH.test(pathname) && !ADMIN_LOGIN_PATH.test(pathname)) {
      return new NextResponse('Service unavailable', { status: 503 });
    }
  }

  return supabaseResponse;
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
