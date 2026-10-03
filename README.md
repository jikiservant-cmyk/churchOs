# churchOs

Multi-tenant church management (members, visitors, new converts, attendance with an usher
check-in portal, SMS broadcasts, prepaid SMS wallet). Next.js 15 (App Router) + TypeScript +
Supabase (Postgres + RLS). SMS/payments via Najiki, with Africa's Talking as SMS fallback.

## Run locally

```bash
npm ci
cp .env.example .env.local   # fill it in; see the comments in the file
npm run dev
```

Checks: `npm run typecheck`, `npm run lint`, `npm test` (unit), `npm run test:db`
(applies the SQL to an in-memory Postgres and runs RLS / RPC probes).

## Database

Apply **in this order** in the Supabase SQL editor (or `supabase db push`):

1. `supabase-schema.sql` – baseline tables, RLS, policies (idempotent).
2. `supabase/migrations/20261001000000_security_hardening.sql` – privileged RPCs, rate
   limiting, audit log, SMS queue, hashed usher credentials (idempotent).
3. `supabase/seed.sql` – **development only** demo data. Never run in production.

Not in this repo: the `sync_missed_3_sundays_flags` Edge Function that
`sendMissedYouMessages` invokes (best effort), and the live DB's 3-argument
`increment_wallet_balance` overload (the migration only revokes it from `anon`/`authenticated`).

## Security model

- **Tenant authorisation lives in the data-access layer**, not the layout:
  `lib/auth/tenant.ts` (`requireTenantAdmin` for pages, `assertTenantAdmin` for actions,
  `getTenantAdminForChurchId` for API routes). They return a *user-scoped* Supabase client, so RLS
  is the second line of defence. The service-role client (`createAdminClient`) is used only for
  things users must not touch (wallet RPCs, usher credentials, audit log, rate limits, queue).
- **Server Actions and API routes are public endpoints.** Every exported function in a
  `'use server'` file authorises itself. Helpers that must not be callable live in non-`'use server'`
  modules (`lib/auth/usher.ts`, `lib/passkey.ts`, `lib/sms-actions.ts`, `lib/queue-actions.ts`).
- **CSRF**: `middleware.ts` rejects cross-origin mutating requests (Origin / Sec-Fetch-Site).
  Auth cookies are `SameSite=Lax` unless `ALLOW_CROSS_SITE_COOKIES=true`.
- **Usher portal**: passkeys are random, scrypt-hashed (`church.usher_credentials`), rate-limited,
  and exchanged for a 12 h signed session that is revoked when the passkey is rotated. Admins cannot
  *view* a passkey; they generate a new one (shown once).
- **Money**: SMS debits are atomic (`debit_wallet`), refunded on provider failure (`refund_wallet`);
  top-ups are credited only by the HMAC-verified Najiki webhook via `apply_topup`, for the amount
  recorded at initiation, idempotently.
- **Queue worker** (`/api/sms/process-queue`) is disabled unless `QUEUE_PROCESSOR_SECRET` or
  `CRON_SECRET` is set. In-app enqueue paths process in-process (`after()`), no HTTP self-call.
- Recipients for broadcasts are resolved server-side from ids; the browser never receives raw phone
  numbers on the Messages page.

## Deploy checklist

1. Apply the migration **before** deploying this code.
2. Set `USHER_JWT_SECRET` (>= 32 chars), `NEXT_PUBLIC_APP_URL`, `NAJIKI_WEBHOOK_SECRET` (or rely on
   `NAJIKI_API_KEY`), and `QUEUE_PROCESSOR_SECRET`/`CRON_SECRET`.
3. **Every church must generate a new usher passkey** (old plaintext passkeys were readable by
   anyone and are no longer accepted). Treat the old ones as compromised.
4. Rotate `NAJIKI_API_KEY` and the Supabase service-role key if they were ever logged or shared.
5. Optional cron (`vercel.json`): `{ "crons": [{ "path": "/api/sms/process-queue", "schedule": "* * * * *" }] }`.

## Known limitations

- `npm audit` still reports a PostCSS advisory bundled inside `next` 15.x; fixing it needs Next 16.
- Rate limits are fixed-window counters in Postgres; behind a proxy that doesn't set
  `x-vercel-forwarded-for` / `x-real-ip` the client IP may be `unknown`.
