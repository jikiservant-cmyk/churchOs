# churchOs Webhook Fix — v3 (final)

## What changed from v2

v2 introduced a `recoverZombieTransactions()` function inside the webhook route.
It was removed entirely in v3 for three reasons:

1. **It fired in the wrong place.** Recovery only triggered when `tx == null` (transaction
   not found). But the real zombie scenario has `tx` still present — so recovery never
   actually ran on the stuck transactions it was meant to fix.

2. **Double-credit risk.** The recovery had no way to prove whether the wallet had already
   been credited. It only checked `wallet_transactions.status === 'pending'`, but that's
   true in two completely different states: wallet credited (status update failed) and
   wallet never credited. Running `increment_wallet_balance` again in the first case would
   add money a second time with no guard to stop it.

3. **Fire-and-forget in serverless.** The recovery ran without `await`. On Vercel/serverless
   environments the process terminates immediately after the response is sent — the recovery
   task would silently die before finishing.

## The actual fix

All three steps (billing_events insert → wallet credit → mark success) now happen inside
a single Postgres transaction via the `process_topup_webhook` RPC. Either all succeed or
all roll back. No intermediate state can exist. No recovery logic needed anywhere.

---

## Files

```
app/
  api/
    billing/
      topup/
        route.ts        ← Drop into your Next.js project at this path
middleware.ts           ← Drop at the root of your Next.js project
sql/
  process_topup_webhook.sql  ← Run this in Supabase SQL editor FIRST
```

---

## Deployment steps

### 1. Run the SQL first
Open Supabase → Database → SQL Editor → New query.
Paste the contents of `sql/process_topup_webhook.sql` and run it.
This creates the `process_topup_webhook` function that `route.ts` calls.

### 2. Drop in the TypeScript files
Copy `route.ts` to `app/api/billing/topup/route.ts` in your project.
Copy `middleware.ts` to the root of your Next.js project.

### 3. Check your env vars
Make sure one of these is set in your deployment environment:
```
LIVEPAY_WEBHOOK_SECRET=your_secret_here
```
or
```
WEBHOOK_SECRET=your_secret_here
```

### 4. Verify your LivePay dashboard
Confirm the webhook URL registered there exactly matches your deployed route:
```
https://yourdomain.com/api/billing/topup
```

---

## All bugs fixed (cumulative from v1)

| # | Bug | Severity |
|---|-----|----------|
| 1 | Missing `p_app_type: 'church'` — wallets never credited | 🔴 Critical |
| 2 | 200 returned on wallet failure — LivePay never retried | 🔴 Critical |
| 3 | `billing_events` inserted before wallet credit — retries permanently blocked | 🔴 Critical |
| 4 | Signature bypass — missing header skipped HMAC check entirely | 🔴 Critical |
| 5 | Relworx `customer_reference` field not checked | 🟡 Medium |
| 6 | Middleware running session refresh on every webhook request | 🟡 Medium |
| 7 | Race condition between billing_events insert / wallet credit / status update | 🟠 Architecture |
