-- ============================================================================
-- Security hardening migration (audit remediation CH-001 … CH-032)
--
-- Apply AFTER supabase-schema.sql. Idempotent: safe to run more than once.
--
-- Key effects (read before applying to production):
--   * Usher passkeys are no longer stored in plaintext. The `passkey` column is
--     DROPPED. The old values were world-readable (anon) so they MUST be
--     considered compromised. Every church must generate a new passkey from
--     Admin → Attendance after deploy; ushers are locked out until then.
--   * All SECURITY DEFINER RPCs that mutate money / attendance / tenants are
--     revoked from PUBLIC/anon/authenticated and granted to service_role only.
--   * "Churches are viewable by everyone" policy is removed.
--   * Adds DB-backed rate limiting, atomic wallet debit/refund/top-up, atomic
--     attendance RPCs, SMS queue tables + claim function, audit log.
-- ============================================================================

-- ─── 0. Roles that exist on Supabase (no-ops elsewhere handled by caller) ───

-- ─── 1. Tables ──────────────────────────────────────────────────────────────

-- 1.1 Usher credentials: hashed passkey, never exposed through the API.
CREATE TABLE IF NOT EXISTS church.usher_credentials (
  church_id    uuid PRIMARY KEY REFERENCES church.churches(id) ON DELETE CASCADE,
  passkey_hash text        NOT NULL,
  rotated_at   timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE church.usher_credentials ENABLE ROW LEVEL SECURITY;
-- Deliberately NO policies for anon/authenticated: only service_role (BYPASSRLS).

-- 1.2 Rate limiter storage.
CREATE TABLE IF NOT EXISTS public.rate_limits (
  key          text        NOT NULL,
  window_start timestamptz NOT NULL,
  count        integer     NOT NULL DEFAULT 0,
  PRIMARY KEY (key, window_start)
);
ALTER TABLE public.rate_limits ENABLE ROW LEVEL SECURITY;

-- 1.3 Audit log (who did what, to which tenant). No PII payloads.
CREATE TABLE IF NOT EXISTS church.audit_log (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id  uuid,
  actor      text,
  action     text        NOT NULL,
  meta       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_log_tenant_created ON church.audit_log (tenant_id, created_at DESC);
ALTER TABLE church.audit_log ENABLE ROW LEVEL SECURITY;

-- 1.4 SMS broadcast queue (previously only described in QUEUE_INTEGRATION.md).
CREATE TABLE IF NOT EXISTS church.broadcasts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES church.churches(id) ON DELETE CASCADE,
  message_template text NOT NULL,
  audience         text NOT NULL DEFAULT 'all',
  total_recipients integer NOT NULL DEFAULT 0,
  sent_count       integer NOT NULL DEFAULT 0,
  failed_count     integer NOT NULL DEFAULT 0,
  status           text NOT NULL DEFAULT 'QUEUED',
  created_by       uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  started_at       timestamptz,
  completed_at     timestamptz,
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_broadcasts_tenant_created ON church.broadcasts (tenant_id, created_at DESC);
ALTER TABLE church.broadcasts ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS church.sms_queue (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES church.churches(id) ON DELETE CASCADE,
  broadcast_id    uuid REFERENCES church.broadcasts(id) ON DELETE CASCADE,
  recipient_phone text NOT NULL,
  recipient_name  text,
  message         text NOT NULL,
  sender_id       text,
  status          text NOT NULL DEFAULT 'PENDING',
  idempotency_key text NOT NULL UNIQUE,
  attempts        integer NOT NULL DEFAULT 0,
  max_attempts    integer NOT NULL DEFAULT 3,
  scheduled_at    timestamptz NOT NULL DEFAULT now(),
  processed_at    timestamptz,
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sms_queue_claim     ON church.sms_queue (status, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_sms_queue_broadcast ON church.sms_queue (broadcast_id);
CREATE INDEX IF NOT EXISTS idx_sms_queue_tenant    ON church.sms_queue (tenant_id, status);
ALTER TABLE church.sms_queue ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "broadcasts_select_own" ON church.broadcasts;
CREATE POLICY "broadcasts_select_own" ON church.broadcasts
  FOR SELECT TO authenticated USING (tenant_id = church.my_tenant_id());

-- ─── 2. Backfill tenants / wallets for legacy churches ──────────────────────
-- (the old /api/sms/send route auto-provisioned these with the USER client.)
INSERT INTO public.tenants (id, app_type, name)
SELECT c.id, 'church', c.name
FROM church.churches c
WHERE NOT EXISTS (SELECT 1 FROM public.tenants t WHERE t.id = c.id);

INSERT INTO public.wallets (tenant_id, balance, sms_rate, app_type)
SELECT t.id, 0, 70, t.app_type
FROM public.tenants t
WHERE t.app_type = 'church'
  AND NOT EXISTS (SELECT 1 FROM public.wallets w WHERE w.tenant_id = t.id);

-- ─── 3. Passkey: drop plaintext, drop legacy validators ─────────────────────
DROP FUNCTION IF EXISTS church.validate_usher_passkey(text, text);
DROP FUNCTION IF EXISTS public.validate_usher_passkey(text, text);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'church' AND table_name = 'churches' AND column_name = 'passkey'
  ) THEN
    ALTER TABLE church.churches DROP COLUMN passkey;
  END IF;
END $$;

-- ─── 4. RLS: remove public church listing ───────────────────────────────────
DROP POLICY IF EXISTS "Churches are viewable by everyone" ON church.churches;

-- ─── 5. Functions ───────────────────────────────────────────────────────────

-- 5.1 Pin search_path on pre-existing helper / trigger functions.
ALTER FUNCTION church.my_tenant_id() SET search_path = public, church, pg_temp;

DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'church'
      AND p.proname IN (
        'assert_visitor_belongs_to_church', 'assert_followup_visitor_belongs_to_church',
        'assert_conversion_consistent', 'assert_attendance_consistent',
        'create_tenant_for_church', 'process_inactive_30_days_followups'
      )
  LOOP
    -- NB: the original used SET search_path = 'church, pg_temp' (a single,
    -- non-existent schema name). Set a proper list.
    EXECUTE format('ALTER FUNCTION %s SET search_path = church, public, pg_temp', r.sig);
  END LOOP;

  FOR r IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname IN ('initialize_tenant_wallet')
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = public, pg_temp', r.sig);
  END LOOP;
END $$;

-- 5.2 Rate limiter -----------------------------------------------------------
CREATE OR REPLACE FUNCTION public.check_rate_limit(
  p_key text, p_max integer, p_window_seconds integer
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_start timestamptz;
  v_count integer;
BEGIN
  IF p_key IS NULL OR p_max < 1 OR p_window_seconds < 1 THEN
    RAISE EXCEPTION 'invalid rate limit arguments';
  END IF;
  v_start := to_timestamp(floor(extract(epoch FROM clock_timestamp()) / p_window_seconds) * p_window_seconds);
  INSERT INTO public.rate_limits AS rl (key, window_start, count)
  VALUES (p_key, v_start, 1)
  ON CONFLICT (key, window_start) DO UPDATE SET count = rl.count + 1
  RETURNING rl.count INTO v_count;
  RETURN v_count <= p_max;
END $$;

CREATE OR REPLACE FUNCTION public.purge_rate_limits() RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  DELETE FROM public.rate_limits WHERE window_start < now() - interval '2 days';
$$;

-- 5.3 Wallet: idempotent top-up, atomic debit, refund ------------------------
CREATE OR REPLACE FUNCTION public.apply_topup(
  p_reference text, p_amount bigint, p_payload jsonb DEFAULT '{}'::jsonb
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  tx public.wallet_transactions%ROWTYPE;
BEGIN
  -- Row lock serialises concurrent / replayed webhooks for the same reference.
  SELECT * INTO tx FROM public.wallet_transactions WHERE reference_code = p_reference FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  IF tx.type <> 'TOPUP' THEN RETURN 'invalid_type'; END IF;
  IF tx.status = 'success' THEN RETURN 'already_processed'; END IF;
  IF tx.status NOT IN ('pending', 'review') THEN RETURN 'invalid_state'; END IF;

  -- Credit the amount WE recorded at initiation; never the webhook's number.
  IF p_amount IS NOT NULL AND p_amount <> tx.amount THEN
    UPDATE public.wallet_transactions
       SET status = 'review',
           provider_payload = COALESCE(p_payload, '{}'::jsonb)
             || jsonb_build_object('_flag', 'amount_mismatch', '_expected', tx.amount, '_received', p_amount)
     WHERE id = tx.id;
    RETURN 'amount_mismatch';
  END IF;

  UPDATE public.wallets
     SET balance = balance + tx.amount, last_updated = now()
   WHERE tenant_id = tx.tenant_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'wallet missing for tenant %', tx.tenant_id; END IF;

  UPDATE public.wallet_transactions
     SET status = 'success', provider_payload = COALESCE(p_payload, '{}'::jsonb)
   WHERE id = tx.id;
  RETURN 'credited';
END $$;

CREATE OR REPLACE FUNCTION public.debit_wallet(
  p_tenant_id uuid, p_amount bigint, p_idempotency_key text,
  p_description text DEFAULT NULL, p_reference_id text DEFAULT NULL
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN RAISE EXCEPTION 'amount must be positive'; END IF;
  IF p_idempotency_key IS NULL THEN RAISE EXCEPTION 'idempotency key required'; END IF;

  IF EXISTS (SELECT 1 FROM public.wallet_transactions WHERE idempotency_key = p_idempotency_key) THEN
    RETURN true;                         -- replay: already debited
  END IF;

  -- Single atomic statement: no stale-balance read-modify-write.
  UPDATE public.wallets
     SET balance = balance - p_amount, last_updated = now()
   WHERE tenant_id = p_tenant_id AND balance >= p_amount;
  IF NOT FOUND THEN RETURN false; END IF;

  INSERT INTO public.wallet_transactions
    (tenant_id, amount, type, description, reference_code, status, idempotency_key, product, created_by, reference_id)
  VALUES
    (p_tenant_id, -p_amount, 'SMS_SENT', p_description,
     'DEBIT_' || gen_random_uuid()::text, 'success', p_idempotency_key, 'sms', 'system', p_reference_id);
  RETURN true;
EXCEPTION WHEN unique_violation THEN
  RETURN true;                           -- concurrent replay; our UPDATE rolled back with the sub-transaction
END $$;

CREATE OR REPLACE FUNCTION public.refund_wallet(
  p_tenant_id uuid, p_original_key text
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  d public.wallet_transactions%ROWTYPE;
BEGIN
  SELECT * INTO d FROM public.wallet_transactions
   WHERE idempotency_key = p_original_key AND tenant_id = p_tenant_id AND amount < 0;
  IF NOT FOUND THEN RETURN false; END IF;

  INSERT INTO public.wallet_transactions
    (tenant_id, amount, type, description, reference_code, status, idempotency_key, product, created_by, reference_id)
  VALUES
    (p_tenant_id, -d.amount, 'REFUND', 'Refund: ' || COALESCE(d.description, 'SMS not delivered'),
     'REFUND_' || gen_random_uuid()::text, 'success', 'refund:' || p_original_key, d.product, 'system', d.reference_id)
  ON CONFLICT (idempotency_key) DO NOTHING;
  IF NOT FOUND THEN RETURN true; END IF;   -- already refunded

  UPDATE public.wallets SET balance = balance - d.amount, last_updated = now()
   WHERE tenant_id = p_tenant_id;           -- d.amount is negative → balance increases
  RETURN true;
END $$;

-- 5.4 Attendance: atomic, tenant-consistent, count maintained in-transaction -
CREATE OR REPLACE FUNCTION church.set_attendance(
  p_event_id uuid, p_member_id uuid, p_status church.attendance_status, p_recorded_by uuid DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = church, public, pg_temp AS $$
DECLARE
  v_event church.events%ROWTYPE;
  v_old   church.attendance_status;
  v_was   boolean;
  v_is    boolean := p_status IN ('present', 'late');
BEGIN
  SELECT * INTO v_event FROM church.events WHERE id = p_event_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Event not found'; END IF;

  IF NOT EXISTS (SELECT 1 FROM church.members m WHERE m.id = p_member_id AND m.church_id = v_event.church_id) THEN
    RAISE EXCEPTION 'Member does not belong to this church';
  END IF;

  SELECT attendance_status INTO v_old FROM church.attendance_logs
   WHERE member_id = p_member_id AND event_id = p_event_id;
  v_was := COALESCE(v_old IN ('present', 'late'), false);

  INSERT INTO church.attendance_logs (church_id, member_id, event_id, attendance_status, check_in_time, recorded_by)
  VALUES (v_event.church_id, p_member_id, p_event_id, p_status, now(), p_recorded_by)
  ON CONFLICT (member_id, event_id) DO UPDATE
    SET attendance_status = EXCLUDED.attendance_status,
        check_in_time     = EXCLUDED.check_in_time,
        recorded_by       = EXCLUDED.recorded_by;

  IF v_is AND NOT v_was THEN
    UPDATE church.events SET attending_count = attending_count + 1 WHERE id = p_event_id;
  ELSIF v_was AND NOT v_is THEN
    UPDATE church.events SET attending_count = GREATEST(attending_count - 1, 0) WHERE id = p_event_id;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION church.clear_attendance(p_event_id uuid, p_member_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = church, public, pg_temp AS $$
DECLARE
  v_status church.attendance_status;
BEGIN
  PERFORM 1 FROM church.events WHERE id = p_event_id FOR UPDATE;
  DELETE FROM church.attendance_logs
   WHERE event_id = p_event_id AND member_id = p_member_id
   RETURNING attendance_status INTO v_status;
  IF v_status IN ('present', 'late') THEN
    UPDATE church.events SET attending_count = GREATEST(attending_count - 1, 0) WHERE id = p_event_id;
  END IF;
END $$;

-- Completes an event and marks everybody without a log as absent.
-- ON CONFLICT DO NOTHING: an existing present/late/excused row is NEVER overwritten.
CREATE OR REPLACE FUNCTION church.finalize_event(p_event_id uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = church, public, pg_temp AS $$
DECLARE
  v_event  church.events%ROWTYPE;
  v_absent integer;
BEGIN
  SELECT * INTO v_event FROM church.events WHERE id = p_event_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Event not found'; END IF;

  INSERT INTO church.attendance_logs (church_id, member_id, event_id, attendance_status)
  SELECT v_event.church_id, m.id, p_event_id, 'absent'
    FROM church.members m
   WHERE m.church_id = v_event.church_id
     AND m.status = 'active'
  ON CONFLICT (member_id, event_id) DO NOTHING;
  GET DIAGNOSTICS v_absent = ROW_COUNT;

  UPDATE church.events
     SET status = 'completed',
         attending_count = (SELECT count(*) FROM church.attendance_logs
                             WHERE event_id = p_event_id AND attendance_status IN ('present', 'late'))
   WHERE id = p_event_id;
  RETURN v_absent;
END $$;

-- 5.5 Inactivity refresh: tenant-checked, idempotent (fixes unique violation) -
CREATE OR REPLACE FUNCTION church.refresh_inactive_30_days(p_church_id uuid DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = church, public, pg_temp AS $$
DECLARE
  v_count integer := 0;
BEGIN
  -- End users (JWT with a uid) may only act on their own tenant. Service role /
  -- cron (no uid) may pass NULL to run for every tenant.
  IF auth.uid() IS NOT NULL THEN
    IF p_church_id IS NULL OR p_church_id IS DISTINCT FROM church.my_tenant_id() THEN
      RAISE EXCEPTION 'not authorised for this church' USING ERRCODE = '42501';
    END IF;
  END IF;

  -- Members who attended in the last 30 days: close any open/followed-up flag.
  UPDATE church.attendance_flags f
     SET status = 'resolved'
   WHERE f.flag_type = 'inactive_30_days'
     AND f.status IN ('open', 'followed_up')
     AND (p_church_id IS NULL OR f.church_id = p_church_id)
     AND EXISTS (
       SELECT 1 FROM church.attendance_logs al
         JOIN church.events e ON e.id = al.event_id
        WHERE al.member_id = f.member_id
          AND al.attendance_status IN ('present', 'late')
          AND e.event_date >= CURRENT_DATE - 30
     );

  -- Members with no attendance in 30 days: open (or re-open a resolved) flag.
  INSERT INTO church.attendance_flags (church_id, member_id, flag_type, status, created_at)
  SELECT m.church_id, m.id, 'inactive_30_days', 'open', now()
    FROM church.members m
   WHERE (p_church_id IS NULL OR m.church_id = p_church_id)
     AND m.status = 'active'
     AND NOT EXISTS (
       SELECT 1 FROM church.attendance_logs al
         JOIN church.events e ON e.id = al.event_id
        WHERE al.member_id = m.id
          AND al.attendance_status IN ('present', 'late')
          AND e.event_date >= CURRENT_DATE - 30
     )
  ON CONFLICT (member_id, flag_type) DO UPDATE
     SET status = 'open', created_at = now()
   WHERE church.attendance_flags.status = 'resolved';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $$;

-- 5.6 Tenant provisioning: validated, one workspace per user ------------------
DROP FUNCTION IF EXISTS public.provision_church_v2(uuid, text, text, text);
CREATE OR REPLACE FUNCTION public.provision_church_v2(
  p_user_id uuid, p_name text, p_slug text, p_role text DEFAULT 'pastor', p_ip text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, church, auth, pg_temp AS $$
DECLARE
  v_tenant uuid := gen_random_uuid();
  v_email  text;
  v_name   text := btrim(p_name);
  v_slug   text := lower(btrim(p_slug));
BEGIN
  IF p_user_id IS NULL THEN RAISE EXCEPTION 'User ID is required'; END IF;
  IF v_name IS NULL OR char_length(v_name) NOT BETWEEN 3 AND 50 THEN
    RAISE EXCEPTION 'Church name must be between 3 and 50 characters';
  END IF;
  IF v_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' OR char_length(v_slug) NOT BETWEEN 3 AND 30 THEN
    RAISE EXCEPTION 'Invalid workspace URL';
  END IF;
  IF v_slug = ANY (ARRAY['admin','portal','api','auth','signup','login','logout','pastoros','root','usher','static','_next','www','app','support','help']) THEN
    RAISE EXCEPTION 'This workspace URL is reserved';
  END IF;
  IF COALESCE(lower(p_role), 'pastor') <> 'pastor' THEN
    RAISE EXCEPTION 'Invalid role';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('provision_slug:' || v_slug));
  PERFORM pg_advisory_xact_lock(hashtext('provision_user:' || p_user_id::text));

  IF EXISTS (SELECT 1 FROM public.admin_profiles WHERE id = p_user_id AND tenant_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Your account is already associated with a ministry workspace.';
  END IF;
  IF EXISTS (SELECT 1 FROM church.churches WHERE lower(slug) = v_slug) THEN
    RAISE EXCEPTION 'Workspace URL (slug) is already taken' USING ERRCODE = '23505';
  END IF;

  SELECT u.email INTO v_email FROM auth.users u WHERE u.id = p_user_id;
  IF v_email IS NULL THEN RAISE EXCEPTION 'User not found'; END IF;

  INSERT INTO public.tenants (id, app_type, name) VALUES (v_tenant, 'church', v_name);
  INSERT INTO church.churches (id, name, slug, app_type, ip_address)
  VALUES (v_tenant, v_name, v_slug, 'church', p_ip);

  INSERT INTO public.admin_profiles (id, email, tenant_id, role, full_name, app_type, ip_address)
  VALUES (p_user_id, v_email, v_tenant, 'pastor', v_name, 'church', p_ip)
  ON CONFLICT (id) DO UPDATE
     SET tenant_id = EXCLUDED.tenant_id, role = 'pastor', app_type = 'church', ip_address = EXCLUDED.ip_address
   WHERE public.admin_profiles.tenant_id IS NULL;

  INSERT INTO church.audit_log (tenant_id, actor, action, meta)
  VALUES (v_tenant, p_user_id::text, 'tenant.provisioned', jsonb_build_object('slug', v_slug));

  RETURN v_tenant;
END $$;

-- 5.7 SMS queue claim (SKIP LOCKED) ------------------------------------------
DROP FUNCTION IF EXISTS public.claim_sms_queue_batch(uuid, integer);
CREATE OR REPLACE FUNCTION public.claim_sms_queue_batch(p_tenant_id uuid, p_batch_size integer)
RETURNS SETOF church.sms_queue
LANGUAGE plpgsql SECURITY DEFINER SET search_path = church, public, pg_temp AS $$
BEGIN
  RETURN QUERY
  WITH picked AS (
    SELECT q.id FROM church.sms_queue q
     WHERE (p_tenant_id IS NULL OR q.tenant_id = p_tenant_id)
       AND ( (q.status = 'PENDING'    AND q.scheduled_at <= now())
          OR (q.status = 'PROCESSING' AND q.updated_at < now() - interval '5 minutes') )
     ORDER BY q.scheduled_at
     LIMIT GREATEST(1, LEAST(COALESCE(p_batch_size, 10), 50))
     FOR UPDATE SKIP LOCKED
  )
  UPDATE church.sms_queue q
     SET status = 'PROCESSING', updated_at = now()
    FROM picked
   WHERE q.id = picked.id
  RETURNING q.*;
END $$;

-- 5.8 Retention (DPPA 2019 data-minimisation): scrub old SMS bodies/numbers ---
CREATE OR REPLACE FUNCTION church.purge_old_sms_content(p_days integer DEFAULT 180) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = church, public, pg_temp AS $$
DECLARE v_n integer;
BEGIN
  UPDATE church.sms_logs
     SET body = '[purged]', recipient_phone = left(recipient_phone, 5) || '****' || right(recipient_phone, 3)
   WHERE created_at < now() - make_interval(days => p_days) AND body <> '[purged]';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  DELETE FROM church.sms_queue WHERE status IN ('SENT', 'FAILED') AND created_at < now() - make_interval(days => p_days);
  RETURN v_n;
END $$;

-- ─── 6. Constraints & indexes ───────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_admin_profiles_tenant     ON public.admin_profiles (tenant_id);
CREATE INDEX IF NOT EXISTS idx_events_church_date        ON church.events (church_id, event_date DESC);
CREATE INDEX IF NOT EXISTS idx_members_church_status     ON church.members (church_id, status);
CREATE INDEX IF NOT EXISTS idx_attendance_flags_church   ON church.attendance_flags (church_id, status);
CREATE INDEX IF NOT EXISTS idx_attendance_logs_member    ON church.attendance_logs (member_id, attendance_status);
CREATE INDEX IF NOT EXISTS idx_sms_logs_tenant_created   ON church.sms_logs (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wallet_tx_tenant_created  ON public.wallet_transactions (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wallet_tx_pending         ON public.wallet_transactions (status) WHERE status IN ('pending', 'review');

DO $$
BEGIN
  CREATE UNIQUE INDEX IF NOT EXISTS uq_churches_slug_lower ON church.churches (lower(slug));
EXCEPTION WHEN unique_violation THEN
  RAISE NOTICE 'Duplicate slugs differing only by case exist; resolve them, then create uq_churches_slug_lower.';
END $$;

-- Money invariants.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wallets_balance_non_negative') THEN
    BEGIN
      ALTER TABLE public.wallets ADD CONSTRAINT wallets_balance_non_negative CHECK (balance >= 0) NOT VALID;
    EXCEPTION WHEN others THEN RAISE NOTICE 'could not add wallets_balance_non_negative: %', SQLERRM;
    END;
  END IF;
END $$;

-- ─── 7. Privileges ──────────────────────────────────────────────────────────

-- 7.1 Tables: anon gets nothing; authenticated cannot write money / logs / queue.
REVOKE ALL ON ALL TABLES    IN SCHEMA church FROM anon;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA church FROM anon;
REVOKE USAGE ON SCHEMA church FROM anon;
REVOKE ALL ON public.wallets, public.wallet_transactions, public.billing_events,
              public.admin_profiles, public.tenants, public.rate_limits FROM anon;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON
  public.wallets, public.wallet_transactions, public.billing_events,
  public.admin_profiles, public.tenants FROM authenticated;
REVOKE ALL ON public.rate_limits FROM authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON church.sms_logs FROM authenticated;
REVOKE ALL ON church.usher_credentials, church.audit_log, church.sms_queue FROM authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON church.broadcasts FROM authenticated;

GRANT ALL ON church.usher_credentials, church.audit_log, church.sms_queue, church.broadcasts TO service_role;
GRANT ALL ON public.rate_limits TO service_role;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA church TO service_role;

-- 7.2 Functions: default-deny, then allow-list.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA church REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon, authenticated;

DO $$
DECLARE r record;
BEGIN
  -- Service-role only (every overload, including legacy signatures that exist
  -- only in the live DB, e.g. 3-arg increment_wallet_balance).
  FOR r IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE (n.nspname, p.proname) IN (
      ('public','increment_wallet_balance'), ('public','process_topup_webhook'),
      ('public','apply_topup'), ('public','debit_wallet'), ('public','refund_wallet'),
      ('public','check_rate_limit'), ('public','purge_rate_limits'),
      ('public','provision_church_v2'), ('public','claim_sms_queue_batch'),
      ('public','initialize_tenant_wallet'),
      ('church','get_or_create_event'), ('church','check_in_member_manual'),
      ('church','check_in_member_manual_by_date'), ('church','increment_event_attendance'),
      ('church','decrement_event_attendance'), ('church','remove_attendance_manual'),
      ('church','set_attendance'), ('church','clear_attendance'), ('church','finalize_event'),
      ('church','process_inactive_30_days'), ('church','process_inactive_30_days_followups'),
      ('church','purge_old_sms_content'), ('church','create_tenant_for_church'),
      ('church','assert_visitor_belongs_to_church'), ('church','assert_followup_visitor_belongs_to_church'),
      ('church','assert_conversion_consistent'), ('church','assert_attendance_consistent')
    )
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', r.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', r.sig);
  END LOOP;

  -- Needed by RLS policies / the dashboard under the end-user role.
  FOR r IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE (n.nspname, p.proname) IN (('church','my_tenant_id'), ('church','refresh_inactive_30_days'))
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', r.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', r.sig);
  END LOOP;
END $$;

-- ─── 8. Scheduled jobs (only when pg_cron is installed) ─────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule('purge-rate-limits',   '17 * * * *', 'SELECT public.purge_rate_limits()');
    PERFORM cron.schedule('purge-old-sms-content', '30 3 * * 0', 'SELECT church.purge_old_sms_content(180)');
  END IF;
EXCEPTION WHEN others THEN
  RAISE NOTICE 'pg_cron scheduling skipped: %', SQLERRM;
END $$;
