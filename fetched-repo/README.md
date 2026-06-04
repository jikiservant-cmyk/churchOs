# churchOs — LivePay STK Push Fix

## What's in this zip

| File | Action |
|------|--------|
| `app/api/payments/collect/route.ts` | **NEW FILE** — drop this directly into your repo at that exact path |
| `GivingPortal.patch.ts` | **SNIPPET** — copy the `handleGive` function into your existing `GivingPortal.tsx` |

---

## Step 1 — Drop in the new API route

Copy the folder structure as-is into your project root:

```
your-project/
└── app/
    └── api/
        └── payments/
            └── collect/
                └── route.ts   ← this file
```

This creates the `/api/payments/collect` endpoint that your GivingPortal will call.

---

## Step 2 — Update GivingPortal.tsx

Open `components/GivingPortal.tsx` and find your existing payment/submit handler.
Replace it with (or merge in) the `handleGive` function from `GivingPortal.patch.ts`.

Key things it does:
- Calls `POST /api/payments/collect` (your new route)
- Sends `phoneNumber`, `amount` (as a number), and `description`
- Handles loading state, error state, and success state

---

## Step 3 — Fill in .env.local

Make sure these two values are set in your `.env.local` (not empty strings):

```env
LIVEPAY_API_KEY="your_actual_livepay_api_key"
LIVEPAY_ACCOUNT_NO="your_livepay_account_number"   # e.g. LP2305443309
```

> ⚠️ The variable name is `LIVEPAY_ACCOUNT_NO` — not `LIVEPAY_ACCOUNT_NUMBER`.
> The route.ts uses this exact name, matching your .env.example.

---

## Why it was broken

1. **No payment API route existed** — `GivingPortal.tsx` had no server endpoint to call.
   LivePay requests must go server-side so your API key is never exposed to the browser.

2. **Wrong env var name** — The LivePay docs use `accountNumber` as the JSON field name,
   but your project's env key is `LIVEPAY_ACCOUNT_NO`. The fix reads from the right key.

3. **Amount type** — LivePay requires `amount` to be a number (`5000`), not a string (`"5000"`).
   The route explicitly casts it with `Number(amount)`.

---

## Testing

Once deployed, trigger a payment and check your server logs. A successful STK push returns:

```json
{
  "success": true,
  "message": "Payment request sent",
  "reference": "CH...",
  "internal_reference": "...",
  "network": "MTN"
}
```

If you get a `403`, double-check that `LIVEPAY_ACCOUNT_NO` matches the account tied to your API key.
