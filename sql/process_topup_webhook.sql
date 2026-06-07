-- =============================================================================
-- process_topup_webhook
-- =============================================================================
-- Single atomic RPC that replaces the 3-step approach in route.ts.
--
-- WHY THIS IS THE CORRECT APPROACH
-- ---------------------------------
-- The 3-step route approach (insert billing_events → credit wallet → mark success)
-- has an unavoidable race window between each step. If anything fails mid-way:
--
--   Scenario A: crash after billing_events insert, before wallet credit
--     → billing_events exists (idempotency blocks retries)
--     → wallet never credited
--     → transaction stuck pending forever ("zombie")
--
--   Scenario B: wallet credited, but status update fails
--     → wallet has money
--     → transaction still 'pending'
--     → any recovery logic that checks pending status will double-credit
--
-- By doing all three steps inside one Postgres transaction, none of these
-- intermediate states can exist. Either all succeed or all roll back.
-- LivePay retries a failed request → duplicate billing_events → returns 'duplicate'
-- safely. No recovery logic needed anywhere.
--
-- HOW TO CALL IT (from route.ts)
-- --------------------------------
--   const { data, error } = await db.rpc('process_topup_webhook', {
--     p_reference:  reference,
--     p_tenant_id:  tx.tenant_id,
--     p_amount:     tx.amount,
--     p_payload:    payload,
--   });
--
--   switch (data?.result) {
--     case 'credited':   // wallet credited, return 200
--     case 'duplicate':  // already processed, return 200
--     case 'not_found':  // no pending tx found, return 200
--   }
--
-- HOW TO DEPLOY
-- -------------
-- Run this in your Supabase SQL editor (Database → SQL Editor → New query).
-- =============================================================================

CREATE OR REPLACE FUNCTION process_topup_webhook(
  p_reference  TEXT,
  p_tenant_id  UUID,
  p_amount     NUMERIC,
  p_payload    JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER  -- runs as function owner, bypasses RLS
AS $$
DECLARE
  v_tx RECORD;
BEGIN

  -- ── Step 1: Lock the pending wallet_transaction row ──────────────────────
  --
  -- FOR UPDATE prevents concurrent calls from processing the same transaction.
  -- SKIP LOCKED means a concurrent call just gets NOT FOUND and returns safely
  -- instead of blocking — no deadlocks possible.
  SELECT *
    INTO v_tx
    FROM wallet_transactions
   WHERE reference_code = p_reference
     AND status         = 'pending'
   LIMIT 1
     FOR UPDATE SKIP LOCKED;

  IF NOT FOUND THEN
    -- Either already processed or doesn't exist — either way, safe to ignore.
    RETURN jsonb_build_object('result', 'not_found');
  END IF;

  -- ── Step 2: Idempotency guard ─────────────────────────────────────────────
  --
  -- Insert into billing_events with a unique constraint on idempotency_key.
  -- If LivePay retries and we've already processed this reference, the unique
  -- violation is caught here and we return early — no double credit possible.
  BEGIN
    INSERT INTO billing_events (
      event_type,
      payload,
      idempotency_key,
      reference_id,
      tenant_id
    ) VALUES (
      'topup',
      p_payload,
      p_reference,
      p_reference,
      p_tenant_id
    );
  EXCEPTION
    WHEN unique_violation THEN
      RETURN jsonb_build_object('result', 'duplicate');
  END;

  -- ── Step 3: Credit the wallet ─────────────────────────────────────────────
  --
  -- increment_wallet_balance is your existing RPC. Called here it runs inside
  -- this transaction — if anything after this fails and the transaction rolls
  -- back, the wallet credit is also rolled back automatically.
  PERFORM increment_wallet_balance(
    p_tenant_id => p_tenant_id,
    p_amount    => p_amount,
    p_app_type  => 'church'
  );

  -- ── Step 4: Mark transaction as success ───────────────────────────────────
  UPDATE wallet_transactions
     SET status           = 'success',
         provider_payload = p_payload
   WHERE reference_code   = p_reference;

  -- ── Done ──────────────────────────────────────────────────────────────────
  RETURN jsonb_build_object(
    'result',    'credited',
    'tenant_id', p_tenant_id,
    'amount',    p_amount,
    'reference', p_reference
  );

END;
$$;

-- Grant execute to the service role (the role your service key uses)
GRANT EXECUTE ON FUNCTION process_topup_webhook(TEXT, UUID, NUMERIC, JSONB)
  TO service_role;
