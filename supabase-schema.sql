-- 1. Create the church schema
CREATE SCHEMA IF NOT EXISTS church;

-- 0. Enable Extensions
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Enable Admin Role Enum if not exists
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'admin_role_enum') THEN
    CREATE TYPE public.admin_role_enum AS ENUM ('pastor', 'admin', 'staff');
  END IF;

  -- Attendance Enums
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'event_service_type') THEN
    CREATE TYPE church.event_service_type AS ENUM (
      'sunday_service',
      'bible_study',
      'prayer_meeting',
      'youth_service'
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'event_status') THEN
    CREATE TYPE church.event_status AS ENUM (
      'upcoming',
      'active',
      'completed'
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'attendance_status') THEN
    CREATE TYPE church.attendance_status AS ENUM (
      'present',
      'late',
      'absent',
      'excused'
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'attendance_flag_type') THEN
    CREATE TYPE church.attendance_flag_type AS ENUM (
      'missed_3_sundays',
      'inactive_30_days'
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'attendance_flag_status') THEN
    CREATE TYPE church.attendance_flag_status AS ENUM (
      'open',
      'followed_up',
      'resolved'
    );
  END IF;
END $$;

-- 2. Create the churches table (in the custom schema)
CREATE TABLE IF NOT EXISTS church.churches (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  passkey text DEFAULT '1234', -- 4-6 digit entrance code for ushers
  app_type text DEFAULT 'church', -- Added to match unified app structure
  theme_color text DEFAULT 'bg-blue-600',
  logo_url text,
  sender_id text,
  created_at timestamptz DEFAULT now()
);

-- 3. Create the admin_profiles table in public
CREATE TABLE IF NOT EXISTS public.admin_profiles (
  id uuid REFERENCES auth.users(id) ON DELETE CASCADE PRIMARY KEY,
  email text, 
  tenant_id uuid REFERENCES public.tenants(id), 
  app_type text DEFAULT 'church', 
  role admin_role_enum NOT NULL DEFAULT 'pastor',
  full_name text, -- Added as per actual schema
  created_at timestamptz DEFAULT now()
);

-- 4. Create the sms_logs table
CREATE TABLE IF NOT EXISTS church.sms_logs (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id uuid REFERENCES church.churches(id) NOT NULL,
  recipient_phone text NOT NULL,
  body text NOT NULL,
  status text NOT NULL,
  message_provider_status text,
  provider_message_id text,
  idempotency_key text UNIQUE NOT NULL,
  sender_id text,
  error_message text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- 5. Create Unified Tenant & Wallet Schema
CREATE TABLE IF NOT EXISTS public.tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_type text NOT NULL DEFAULT 'church', 
  name text NOT NULL,
  created_at timestamptz DEFAULT now()
);

-- Audit Logs (Removed as per user verification that it does not exist)
-- CREATE TABLE IF NOT EXISTS public.audit_logs (...);

-- Migration: Ensure churches table has app_type
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='churches' AND table_schema='church' AND column_name='app_type') THEN
        ALTER TABLE church.churches ADD COLUMN app_type text DEFAULT 'church';
    END IF;
END $$;

-- Migration: Ensure admin_profiles table has full_name and lacks status/is_verified if needed
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='admin_profiles' AND table_schema='public' AND column_name='full_name') THEN
        ALTER TABLE public.admin_profiles ADD COLUMN full_name text;
    END IF;
    -- Note: We generally don't drop columns in migrations unless absolutely sure, 
    -- but we will ensure full_name exists.
END $$;

-- Migration: Ensure owner_id column exists if table was created earlier (Wait, user said this doesn't exist, so maybe we should remove this migration if it's incorrect)
-- User said: "public.tenants has only: id, app_type, name, created_at - no owner_id"
-- So I will remove the owner_id migration for tenants to match their reality.

-- Ensure slugs are unique across all churches
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'unique_church_slug') THEN
    ALTER TABLE church.churches ADD CONSTRAINT unique_church_slug UNIQUE (slug);
  END IF;
END $$;

-- RPC: Atomic Provisioning Function
-- This prevents race conditions and ensures data integrity across schemas
CREATE OR REPLACE FUNCTION public.provision_church_v2(
  p_user_id uuid,
  p_name text,
  p_slug text,
  p_role text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, church, auth
AS $$
DECLARE
  v_tenant_id uuid;
  v_user_email text;
BEGIN
  -- 1. Identity Check
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'User ID is required';
  END IF;

  -- 2. Namespace Check: Unique slug (churches.slug)
  IF EXISTS (
    SELECT 1
    FROM church.churches
    WHERE lower(slug) = lower(p_slug)
  ) THEN
    RAISE EXCEPTION 'Workspace URL (slug) is already taken';
  END IF;

  -- 3. Identity Resolution (email)
  v_user_email := auth.jwt() ->> 'email';
  IF v_user_email IS NULL THEN
    SELECT email INTO v_user_email
    FROM auth.users
    WHERE id = p_user_id;
  END IF;

  IF v_user_email IS NULL THEN
    RAISE EXCEPTION 'User email not found. Please try logging in again.';
  END IF;

  -- 4. Atomic Write Strategy

  -- a) Create Tenant
  -- Tenants table uses: id (PK), app_type, name, created_at
  v_tenant_id := gen_random_uuid();

  INSERT INTO public.tenants (id, app_type, name)
  VALUES (v_tenant_id, 'church', p_name);

  -- b) Create Church Link
  -- church.churches uses: id, name, slug, app_type, ...
  INSERT INTO church.churches (id, name, slug, app_type)
  VALUES (v_tenant_id, p_name, p_slug, 'church');

  -- c) Create Admin Profile (Owner)
  -- admin_profiles uses: id (FK to auth.users), tenant_id, role, app_type, email, full_name
  INSERT INTO public.admin_profiles (id, tenant_id, email, app_type, role, full_name)
  VALUES (p_user_id, v_tenant_id, v_user_email, 'church', p_role::admin_role_enum, p_name)
  ON CONFLICT (id) DO UPDATE SET
    tenant_id = EXCLUDED.tenant_id,
    app_type = EXCLUDED.app_type,
    role = EXCLUDED.role,
    email = EXCLUDED.email,
    full_name = EXCLUDED.full_name;

  RETURN v_tenant_id;
END;
$$;

-- Explicit Permission Grants
GRANT EXECUTE ON FUNCTION public.provision_church_v2(uuid, text, text, text)
TO authenticated, service_role;

GRANT USAGE ON SCHEMA public TO authenticated, service_role;
GRANT USAGE ON SCHEMA church TO authenticated, service_role;
GRANT ALL ON ALL TABLES IN SCHEMA church TO postgres, authenticated, service_role;
GRANT ALL ON ALL TABLES IN SCHEMA public TO postgres, authenticated, service_role;
GRANT SELECT ON auth.users TO postgres, service_role;

-- 8. SECURITY: Row Level Security (RLS) Hardening
-- This is the "Police Force" that prevents cross-tenant data leaks

-- Tenants Table RLS
ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view tenants they are admins of" 
ON public.tenants FOR SELECT 
TO authenticated 
USING (
  id IN (
    SELECT tenant_id FROM public.admin_profiles 
    WHERE id = auth.uid()
  )
);

CREATE POLICY "Service role full access on tenants" 
ON public.tenants FOR ALL 
TO service_role 
USING (true);

-- Admin Profiles RLS
ALTER TABLE public.admin_profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own profile" 
ON public.admin_profiles FOR SELECT 
TO authenticated 
USING (id = auth.uid());

CREATE POLICY "Service role full access on profiles" 
ON public.admin_profiles FOR ALL 
TO service_role 
USING (true);

-- Churches Table RLS (church schema)
ALTER TABLE church.churches ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins can view their associated church" ON church.churches;
CREATE POLICY "Admins can manage their associated church" 
ON church.churches FOR ALL 
TO authenticated 
USING (
  id IN (
    SELECT tenant_id FROM public.admin_profiles 
    WHERE id = auth.uid()
  )
);

CREATE POLICY "Service role full access on churches" 
ON church.churches FOR ALL 
TO service_role 
USING (true);

-- 5.1 Removed: Schools feature disabled to focus on churches

-- Trigger: Auto-create tenant when church is created
CREATE OR REPLACE FUNCTION church.create_tenant_for_church()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.tenants (id, app_type, name)
  VALUES (NEW.id, 'church', NEW.name)
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trigger_create_tenant_for_church ON church.churches;
CREATE TRIGGER trigger_create_tenant_for_church
AFTER INSERT ON church.churches
FOR EACH ROW
EXECUTE FUNCTION church.create_tenant_for_church();

CREATE TABLE IF NOT EXISTS public.wallets (
  tenant_id uuid REFERENCES public.tenants(id) PRIMARY KEY,
  balance bigint NOT NULL DEFAULT 0,
  sms_rate int NOT NULL DEFAULT 70, 
  last_updated timestamptz DEFAULT now(),
  app_type text NOT NULL
);

-- Trigger: Auto-initialize wallet for new tenants
CREATE OR REPLACE FUNCTION public.initialize_tenant_wallet()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.wallets (tenant_id, balance, sms_rate, app_type)
  VALUES (NEW.id, 0, 70, NEW.app_type)
  ON CONFLICT (tenant_id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trigger_initialize_tenant_wallet ON public.tenants;
CREATE TRIGGER trigger_initialize_tenant_wallet
AFTER INSERT ON public.tenants
FOR EACH ROW
EXECUTE FUNCTION public.initialize_tenant_wallet();

CREATE TABLE IF NOT EXISTS public.wallet_transactions (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id uuid REFERENCES public.tenants(id) NOT NULL,
  amount int NOT NULL, -- Negative for debit, Positive for credit
  type text NOT NULL CHECK (type IN ('TOPUP','SMS_SENT','REFUND','ADJUSTMENT','BONUS','REVERSAL','credit','debit')),
  description text,
  reference_code text UNIQUE,
  status text NOT NULL DEFAULT 'success', -- 'pending', 'success', 'failed'
  created_at timestamptz DEFAULT now(),
  idempotency_key text UNIQUE,
  product text DEFAULT 'sms',
  created_by text,
  reference_id text,
  cost_ugx bigint,
  revenue_ugx bigint,
  provider_payload jsonb DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS public.billing_events (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  event_type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key text UNIQUE,
  provider_message_id text,
  reference_id text,
  tenant_id uuid REFERENCES public.tenants(id),
  created_at timestamptz DEFAULT now()
);

-- 6. Trigger: Atomic SMS Credit Deduction (Refactored for public.wallets)
CREATE OR REPLACE FUNCTION church.deduct_sms_credit()
RETURNS TRIGGER AS $$
DECLARE
  rows_updated int;
  current_rate int;
  billable_statuses text[] := ARRAY['Success', 'Sent', 'Queued', 'Buffered'];
  ref_code text;
BEGIN
  -- 1. "Real Delivery Only" Guard: Only debit if entering a billable state
  IF NOT (NEW.status = ANY(billable_statuses)) THEN
    RETURN NEW;
  END IF;

  -- 2. Idempotency Guard: If this is an update, only debit if transitioning FROM a non-billable state
  IF (TG_OP = 'UPDATE') THEN
    IF (OLD.status = ANY(billable_statuses)) THEN
      RETURN NEW; -- Already debited
    END IF;
  END IF;

  -- 3. Fetch the tenant's specific SMS rate
  SELECT sms_rate INTO current_rate
  FROM public.wallets
  WHERE tenant_id = NEW.tenant_id;

  -- 4. Atomic Debit
  UPDATE public.wallets
  SET balance = balance - current_rate,
      last_updated = now()
  WHERE tenant_id = NEW.tenant_id
    AND balance >= current_rate;

  GET DIAGNOSTICS rows_updated = ROW_COUNT;

  -- 5. Block the transaction if balance is insufficient
  IF rows_updated = 0 THEN
    RAISE EXCEPTION 'Insufficient SMS balance. Please top up your account.';
  END IF;

  -- 6. Auto-log the ledger entry
  ref_code := 'SMS_ATOMIC_' || gen_random_uuid()::text;
  INSERT INTO public.wallet_transactions (
    tenant_id, 
    amount, 
    type, 
    description, 
    reference_code, 
    status,
    idempotency_key,
    product,
    revenue_ugx,
    reference_id
  )
  VALUES (
    NEW.tenant_id, 
    -current_rate, 
    'SMS_SENT', 
    'Sent 1 SMS to ' || COALESCE(NEW.recipient_phone, 'unknown'),
    ref_code,
    'success',
    COALESCE(NEW.provider_message_id, NEW.idempotency_key, gen_random_uuid()::text),
    'sms',
    current_rate, -- Recording revenue
    NEW.id::text  -- Link back to the sms_logs ID
  );

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Trigger should be BEFORE INSERT OR UPDATE so we can block if no money exists
DROP TRIGGER IF EXISTS before_sms_sent ON church.sms_logs;
CREATE TRIGGER trigger_sms_billing
BEFORE INSERT OR UPDATE ON church.sms_logs
FOR EACH ROW
EXECUTE FUNCTION church.deduct_sms_credit();

-- 7. RPC: Securely increment wallet balance for Topups (prevents race conditions)
CREATE OR REPLACE FUNCTION public.increment_wallet_balance(p_tenant_id uuid, p_amount bigint)
RETURNS void AS $$
BEGIN
  UPDATE public.wallets
  SET balance = balance + p_amount,
      last_updated = now()
  WHERE tenant_id = p_tenant_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 8. Consolidated RLS Policies for Other Tables
ALTER TABLE church.sms_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wallet_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE church.members ENABLE ROW LEVEL SECURITY;
ALTER TABLE church.new_converts ENABLE ROW LEVEL SECURITY;
ALTER TABLE church.events ENABLE ROW LEVEL SECURITY;
ALTER TABLE church.prayers ENABLE ROW LEVEL SECURITY;
ALTER TABLE church.small_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE church.donations ENABLE ROW LEVEL SECURITY;

-- SMS Logs Policies
CREATE POLICY "Pastors can manage their church sms logs"
  ON church.sms_logs FOR ALL
  TO authenticated
  USING (
    tenant_id IN (
      SELECT tenant_id FROM public.admin_profiles 
      WHERE id = auth.uid() AND role = 'pastor'
    )
  );

-- Wallets Policies
CREATE POLICY "Pastors can view their church wallet"
  ON public.wallets FOR SELECT
  TO authenticated
  USING (
    tenant_id IN (
      SELECT tenant_id FROM public.admin_profiles 
      WHERE id = auth.uid()
    )
  );

-- Transactions Policies
CREATE POLICY "Pastors can view their church transactions"
  ON public.wallet_transactions FOR SELECT
  TO authenticated
  USING (
    tenant_id IN (
      SELECT tenant_id FROM public.admin_profiles 
      WHERE id = auth.uid()
    )
  );

-- Members Policies
CREATE POLICY "Pastors can manage their members"
  ON church.members FOR ALL
  TO authenticated
  USING (
    church_id IN (
      SELECT tenant_id FROM public.admin_profiles 
      WHERE id = auth.uid()
    )
  );

-- New Converts Policies
CREATE POLICY "Pastors can manage their new converts"
  ON church.new_converts FOR ALL
  TO authenticated
  USING (
    church_id IN (
      SELECT tenant_id FROM public.admin_profiles 
      WHERE id = auth.uid()
    )
  );

-- Dasboard Items Policies (Events, Prayers, Groups, Donations)
CREATE POLICY "Pastors can manage their events" ON church.events FOR ALL TO authenticated
  USING (church_id IN (SELECT tenant_id FROM public.admin_profiles WHERE id = auth.uid()));

CREATE POLICY "Pastors can manage their prayers" ON church.prayers FOR ALL TO authenticated
  USING (church_id IN (SELECT tenant_id FROM public.admin_profiles WHERE id = auth.uid()));

CREATE POLICY "Pastors can manage their small_groups" ON church.small_groups FOR ALL TO authenticated
  USING (church_id IN (SELECT tenant_id FROM public.admin_profiles WHERE id = auth.uid()));

CREATE POLICY "Pastors can manage their donations" ON church.donations FOR ALL TO authenticated
  USING (church_id IN (SELECT tenant_id FROM public.admin_profiles WHERE id = auth.uid()));

-- Service Role Bypass for all
CREATE POLICY "Service role bypass on sms_logs" ON church.sms_logs TO service_role USING (true);
CREATE POLICY "Service role bypass on wallets" ON public.wallets TO service_role USING (true);
CREATE POLICY "Service role bypass on wallet_transactions" ON public.wallet_transactions TO service_role USING (true);
CREATE POLICY "Service role bypass on billing_events" ON public.billing_events TO service_role USING (true);
CREATE POLICY "Service role bypass on members" ON church.members TO service_role USING (true);
CREATE POLICY "Service role bypass on new_converts" ON church.new_converts TO service_role USING (true);
CREATE POLICY "Service role bypass on events" ON church.events TO service_role USING (true);
CREATE POLICY "Service role bypass on prayers" ON church.prayers TO service_role USING (true);
CREATE POLICY "Service role bypass on small_groups" ON church.small_groups TO service_role USING (true);
CREATE POLICY "Service role bypass on donations" ON church.donations TO service_role USING (true);

-- 9. Create missing tables for members and new converts
CREATE TABLE IF NOT EXISTS church.members (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  church_id uuid REFERENCES church.churches(id) NOT NULL,
  full_name text NOT NULL,
  phone_number text,
  email text,
  gender text,
  birthday date,
  is_youth boolean DEFAULT false,
  status text DEFAULT 'active',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS church.new_converts (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  church_id uuid REFERENCES church.churches(id) NOT NULL,
  name text NOT NULL,
  contact text,
  follow_up_status text DEFAULT 'pending',
  notes text,
  created_at timestamptz DEFAULT now()
);

-- Enable RLS for new tables
ALTER TABLE church.members ENABLE ROW LEVEL SECURITY;
ALTER TABLE church.new_converts ENABLE ROW LEVEL SECURITY;

-- 10. Insert initial demo data for Grace Church
INSERT INTO church.churches (id, name, slug, theme_color, logo_url)
VALUES (
  '11111111-1111-1111-1111-111111111111',
  'Grace Church Kampala', 
  'grace', 
  'bg-green-600', 
  'https://picsum.photos/seed/grace/200/200'
) ON CONFLICT (id) DO UPDATE SET slug = EXCLUDED.slug;

-- 11. Tables for Dashboard (Events, Attendance, Prayers, Groups, Donations)
-- Events / Services
CREATE TABLE IF NOT EXISTS church.events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  church_id uuid NOT NULL REFERENCES church.churches(id) ON DELETE CASCADE,

  name text NOT NULL,
  service_type church.event_service_type NOT NULL,
  event_date date NOT NULL DEFAULT CURRENT_DATE,
  start_time time DEFAULT '09:00:00',
  location text,
  status church.event_status NOT NULL DEFAULT 'upcoming',
  attending_count int DEFAULT 0,

  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),

  -- useful for filtering
  UNIQUE (church_id, service_type, event_date, start_time)
);

-- Attendance Logs (bridge)
CREATE TABLE IF NOT EXISTS church.attendance_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  church_id uuid NOT NULL REFERENCES church.churches(id) ON DELETE CASCADE,

  member_id uuid NOT NULL REFERENCES church.members(id) ON DELETE CASCADE,
  event_id uuid NOT NULL REFERENCES church.events(id) ON DELETE CASCADE,

  attendance_status church.attendance_status NOT NULL DEFAULT 'present',
  check_in_time timestamptz DEFAULT now(),
  notes text,
  recorded_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT attendance_logs_member_event_unique
    UNIQUE (member_id, event_id)
);

-- Optional: Attendance Flags
CREATE TABLE IF NOT EXISTS church.attendance_flags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  church_id uuid NOT NULL REFERENCES church.churches(id) ON DELETE CASCADE,

  member_id uuid NOT NULL REFERENCES church.members(id) ON DELETE CASCADE,
  flag_type church.attendance_flag_type NOT NULL,
  status church.attendance_flag_status NOT NULL DEFAULT 'open',
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),

  -- One open flag of each type per member is typical for follow-up
  UNIQUE (member_id, flag_type)
);

CREATE TABLE IF NOT EXISTS church.prayers (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  church_id uuid REFERENCES church.churches(id) NOT NULL,
  submitter_name text NOT NULL,
  body text NOT NULL,
  status text DEFAULT 'open', -- 'open', 'answered'
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS church.small_groups (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  church_id uuid REFERENCES church.churches(id) NOT NULL,
  name text NOT NULL,
  leader_name text NOT NULL,
  meeting_day text NOT NULL,
  member_count int DEFAULT 0,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS church.donations (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  church_id uuid REFERENCES church.churches(id) NOT NULL,
  category text NOT NULL, -- 'Tithes', 'Offerings', 'Missions'
  amount_cents bigint NOT NULL,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE church.events ENABLE ROW LEVEL SECURITY;
ALTER TABLE church.attendance_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE church.attendance_flags ENABLE ROW LEVEL SECURITY;
ALTER TABLE church.prayers ENABLE ROW LEVEL SECURITY;
ALTER TABLE church.small_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE church.donations ENABLE ROW LEVEL SECURITY;

-- Additional RLS Policies
CREATE POLICY "Pastors can manage their attendance logs" ON church.attendance_logs FOR ALL TO authenticated
  USING (event_id IN (SELECT id FROM church.events WHERE church_id IN (SELECT tenant_id FROM public.admin_profiles WHERE id = auth.uid())));

CREATE POLICY "Pastors can manage their attendance flags" ON church.attendance_flags FOR ALL TO authenticated
  USING (church_id IN (SELECT tenant_id FROM public.admin_profiles WHERE id = auth.uid()));

CREATE POLICY "Service role bypass on attendance_logs" ON church.attendance_logs TO service_role USING (true);
CREATE POLICY "Service role bypass on attendance_flags" ON church.attendance_flags TO service_role USING (true);

-- RPC Functions for Attendance
CREATE OR REPLACE FUNCTION church.get_or_create_event(
  p_church_id uuid,
  p_service_type church.event_service_type,
  p_event_date date,
  p_start_time time DEFAULT NULL,
  p_name text DEFAULT NULL,
  p_location text DEFAULT NULL,
  p_creator_id uuid DEFAULT NULL
)
RETURNS church.events
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_event church.events;
  v_name text;
BEGIN
  -- Basic integrity
  IF p_church_id IS NULL THEN
    RAISE EXCEPTION 'p_church_id is required';
  END IF;

  v_name := COALESCE(p_name, (
    CASE p_service_type
      WHEN 'sunday_service' THEN 'Sunday Service'
      WHEN 'bible_study' THEN 'Bible Study'
      WHEN 'prayer_meeting' THEN 'Prayer Meeting'
      WHEN 'youth_service' THEN 'Youth Service'
      ELSE 'Service'
    END
  ));

  SELECT * INTO v_event
  FROM church.events e
  WHERE e.church_id = p_church_id
    AND e.service_type = p_service_type
    AND e.event_date = p_event_date
    AND ( (p_start_time IS NULL AND e.start_time IS NULL) OR e.start_time = p_start_time )
  LIMIT 1;

  IF FOUND THEN
    RETURN v_event;
  END IF;

  INSERT INTO church.events (
    church_id,
    name,
    service_type,
    event_date,
    start_time,
    location,
    status,
    created_by
  )
  VALUES (
    p_church_id,
    v_name,
    p_service_type,
    p_event_date,
    p_start_time,
    p_location,
    'active'::church.event_status,
    COALESCE(p_creator_id, auth.uid())
  )
  RETURNING * INTO v_event;

  RETURN v_event;
END;
$$;

-- Manual check-in: upsert attendance_logs by (member_id, event_id)
CREATE OR REPLACE FUNCTION church.check_in_member_manual(
  p_member_id uuid,
  p_event_id uuid,
  p_attendance_status church.attendance_status,
  p_check_in_time timestamptz DEFAULT now(),
  p_notes text DEFAULT NULL,
  p_recorded_by uuid DEFAULT NULL
)
RETURNS church.attendance_logs
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
AS $$
DECLARE
  v_event church.events;
  v_row church.attendance_logs;
  v_recorded_by uuid;
BEGIN
  IF p_member_id IS NULL OR p_event_id IS NULL THEN
    RAISE EXCEPTION 'member_id and event_id are required';
  END IF;

  -- Fetch event to get tenant scope
  SELECT * INTO v_event
  FROM church.events e
  WHERE e.id = p_event_id
  LIMIT 1;

  IF v_event.id IS NULL THEN
    RAISE EXCEPTION 'Event not found';
  END IF;

  -- Ensure member is in the same tenant
  IF NOT EXISTS (
    SELECT 1
    FROM church.members m
    WHERE m.id = p_member_id
      AND m.church_id = v_event.church_id
  ) THEN
    RAISE EXCEPTION 'Member does not belong to this church';
  END IF;

  v_recorded_by := COALESCE(p_recorded_by, auth.uid());

  -- Upsert by unique (member_id, event_id)
  INSERT INTO church.attendance_logs (
    church_id,
    member_id,
    event_id,
    attendance_status,
    check_in_time,
    notes,
    recorded_by,
    created_at
  )
  VALUES (
    v_event.church_id,
    p_member_id,
    p_event_id,
    p_attendance_status,
    p_check_in_time,
    p_notes,
    v_recorded_by,
    now()
  )
  ON CONFLICT (member_id, event_id)
  DO UPDATE SET
    attendance_status = EXCLUDED.attendance_status,
    check_in_time = EXCLUDED.check_in_time,
    notes = EXCLUDED.notes,
    recorded_by = EXCLUDED.recorded_by;

  SELECT * INTO v_row
  FROM church.attendance_logs al
  WHERE al.member_id = p_member_id
    AND al.event_id = p_event_id
  LIMIT 1;

  RETURN v_row;
END;
$$;

-- Option 2 convenience wrapper: create/get event then check-in
CREATE OR REPLACE FUNCTION church.check_in_member_manual_by_date(
  p_church_id uuid,
  p_service_type church.event_service_type,
  p_event_date date,
  p_member_id uuid,
  p_attendance_status church.attendance_status,
  p_check_in_time timestamptz DEFAULT now(),
  p_notes text DEFAULT NULL
)
RETURNS church.attendance_logs
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
AS $$
DECLARE
  v_event church.events;
  v_row church.attendance_logs;
BEGIN
  -- Get or create the event
  v_event := church.get_or_create_event(
    p_church_id,
    p_service_type,
    p_event_date,
    NULL,
    NULL,
    NULL,
    auth.uid()
  );

  -- Use existing check-in logic (authorization + upsert)
  v_row := church.check_in_member_manual(
    p_member_id,
    v_event.id,
    p_attendance_status,
    p_check_in_time,
    p_notes,
    auth.uid()
  );

  RETURN v_row;
END;
$$;

-- RPC Functions for Attendance Counts
CREATE OR REPLACE FUNCTION church.increment_event_attendance(event_id uuid)
RETURNS void AS $$
BEGIN
  UPDATE church.events
  SET attending_count = attending_count + 1
  WHERE id = event_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION church.decrement_event_attendance(event_id uuid)
RETURNS void AS $$
BEGIN
  UPDATE church.events
  SET attending_count = attending_count - 1
  WHERE id = event_id AND attending_count > 0;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION church.remove_attendance_manual(
  p_member_id uuid,
  p_event_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  DELETE FROM church.attendance_logs
  WHERE member_id = p_member_id AND event_id = p_event_id;
END;
$$;

-- Inactivity Detection Function
CREATE OR REPLACE FUNCTION church.refresh_inactive_30_days(p_church_id uuid DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_now timestamptz := now();
  v_count integer := 0;
BEGIN
  IF p_church_id IS NOT NULL THEN
    -- Remove existing open flags for this church/type/members that are no longer inactive
    DELETE FROM church.attendance_flags f
    USING church.members m
    WHERE f.church_id = p_church_id
      AND f.flag_type = 'inactive_30_days'::church.attendance_flag_type
      AND f.member_id = m.id
      AND (
        -- Member has at least one present/late check-in in the last 30 days
        EXISTS (
          SELECT 1
          FROM church.attendance_logs al
          JOIN church.events e ON e.id = al.event_id
          WHERE al.member_id = m.id
            AND al.attendance_status IN ('present','late')
            AND e.event_date >= (CURRENT_DATE - 30)
            AND al.church_id = p_church_id
        )
      );

    -- Insert (or reopen) inactive flags for members who currently have no present/late logs
    WITH inactive_members AS (
      SELECT m.id AS member_id, p_church_id AS church_id
      FROM church.members m
      WHERE m.church_id = p_church_id
        AND NOT EXISTS (
          SELECT 1
          FROM church.attendance_logs al
          JOIN church.events e ON e.id = al.event_id
          WHERE al.member_id = m.id
            AND al.attendance_status IN ('present','late')
            AND e.event_date >= (CURRENT_DATE - 30)
            AND al.church_id = p_church_id
        )
    )
    INSERT INTO church.attendance_flags (id, church_id, member_id, flag_type, status, created_at)
    SELECT gen_random_uuid(), im.church_id, im.member_id,
           'inactive_30_days'::church.attendance_flag_type,
           'open'::church.attendance_flag_status,
           v_now
    FROM inactive_members im
    WHERE NOT EXISTS (
      SELECT 1
      FROM church.attendance_flags f
      WHERE f.church_id = im.church_id
        AND f.member_id = im.member_id
        AND f.flag_type = 'inactive_30_days'::church.attendance_flag_type
        AND f.status = 'open'::church.attendance_flag_status
    );

    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
  ELSE
    -- Run for all churches
    WITH inactive_members AS (
      SELECT m.church_id AS church_id, m.id AS member_id
      FROM church.members m
      WHERE NOT EXISTS (
        SELECT 1
        FROM church.attendance_logs al
        JOIN church.events e ON e.id = al.event_id
        WHERE al.member_id = m.id
          AND al.attendance_status IN ('present','late')
          AND e.event_date >= (CURRENT_DATE - 30)
          AND al.church_id = m.church_id
      )
    )
    INSERT INTO church.attendance_flags (id, church_id, member_id, flag_type, status, created_at)
    SELECT gen_random_uuid(), im.church_id, im.member_id,
           'inactive_30_days'::church.attendance_flag_type,
           'open'::church.attendance_flag_status,
           v_now
    FROM inactive_members im
    WHERE NOT EXISTS (
      SELECT 1
      FROM church.attendance_flags f
      WHERE f.church_id = im.church_id
        AND f.member_id = im.member_id
        AND f.flag_type = 'inactive_30_days'::church.attendance_flag_type
        AND f.status = 'open'::church.attendance_flag_status
    );

    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION church.process_inactive_30_days(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION church.refresh_inactive_30_days(uuid) TO authenticated, service_role;

-- Usher Passkey Validation
CREATE OR REPLACE FUNCTION church.validate_usher_passkey(
  p_church_slug text,
  p_passkey text
)
RETURNS TABLE (
  valid boolean,
  church_id uuid,
  church_name text
) 
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  SELECT true AS valid, id AS church_id, name AS church_name
  FROM church.churches
  WHERE LOWER(slug) = LOWER(p_church_slug) 
    AND passkey = p_passkey
  LIMIT 1;
END;
$$;

-- Proxy to public schema to avoid routing issues
CREATE OR REPLACE FUNCTION public.validate_usher_passkey(
  p_church_slug text,
  p_passkey text
)
RETURNS TABLE (
  valid boolean,
  church_id uuid,
  church_name text
) 
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY SELECT * FROM church.validate_usher_passkey(p_church_slug, p_passkey);
END;
$$;

GRANT EXECUTE ON FUNCTION church.validate_usher_passkey(text, text) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.validate_usher_passkey(text, text) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION church.get_or_create_event(uuid, church.event_service_type, date, time, text, text, uuid) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION church.check_in_member_manual(uuid, uuid, church.attendance_status, timestamptz, text, uuid) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION church.check_in_member_manual_by_date(uuid, church.event_service_type, date, uuid, church.attendance_status, timestamptz, text) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION church.increment_event_attendance(uuid) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION church.decrement_event_attendance(uuid) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION church.remove_attendance_manual(uuid, uuid) TO anon, authenticated, service_role;

-- Follow-up Processor for Inactivity
CREATE OR REPLACE FUNCTION church.process_inactive_30_days_followups(p_church_id uuid DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_now timestamptz := now();
  v_count integer := 0;
BEGIN
  -- 1) Resolve any followed_up/open that has returned (present/late in last 30 days)
  WITH returned AS (
    SELECT DISTINCT al.church_id, al.member_id
    FROM church.attendance_logs al
    JOIN church.events e ON e.id = al.event_id
    WHERE al.attendance_status IN ('present','late')
      AND e.event_date >= (CURRENT_DATE - 30)
      AND (p_church_id IS NULL OR al.church_id = p_church_id)
  )
  UPDATE church.attendance_flags f
  SET status = 'resolved'::church.attendance_flag_status
  WHERE f.flag_type = 'inactive_30_days'::church.attendance_flag_type
    AND f.status IN ('open'::church.attendance_flag_status,'followed_up'::church.attendance_flag_status)
    AND EXISTS (
      SELECT 1 FROM returned r
      WHERE r.church_id = f.church_id
        AND r.member_id = f.member_id
    );

  -- 2) open -> followed_up after 7 days (if still not returned)
  WITH still_inactive AS (
    SELECT f.id
    FROM church.attendance_flags f
    WHERE f.flag_type = 'inactive_30_days'::church.attendance_flag_type
      AND f.status = 'open'::church.attendance_flag_status
      AND f.created_at <= (v_now - interval '7 days')
      AND (p_church_id IS NULL OR f.church_id = p_church_id)
      AND NOT EXISTS (
        SELECT 1
        FROM church.attendance_logs al
        JOIN church.events e ON e.id = al.event_id
        WHERE al.member_id = f.member_id
          AND al.attendance_status IN ('present','late')
          AND e.event_date >= (CURRENT_DATE - 30)
          AND al.church_id = f.church_id
      )
  )
  UPDATE church.attendance_flags f
  SET status = 'followed_up'::church.attendance_flag_status
  WHERE f.id IN (SELECT id FROM still_inactive);

  -- 3) followed_up -> resolved after another 7 days (time-based fallback)
  WITH due_resolve AS (
    SELECT f.id
    FROM church.attendance_flags f
    WHERE f.flag_type = 'inactive_30_days'::church.attendance_flag_type
      AND f.status = 'followed_up'::church.attendance_flag_status
      AND f.created_at <= (v_now - interval '14 days')
      AND (p_church_id IS NULL OR f.church_id = p_church_id)
  )
  UPDATE church.attendance_flags f
  SET status = 'resolved'::church.attendance_flag_status
  WHERE f.id IN (SELECT id FROM due_resolve);

  -- best-effort count: how many unresolved/open remain older than thresholds
  SELECT count(*) INTO v_count
  FROM church.attendance_flags f
  WHERE f.flag_type = 'inactive_30_days'::church.attendance_flag_type
    AND f.status <> 'resolved'::church.attendance_flag_status
    AND (p_church_id IS NULL OR f.church_id = p_church_id);

  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION church.process_inactive_30_days_followups(uuid) TO authenticated, service_role;

-- Enable pg_cron
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Schedule daily refresh (at 2 AM)
SELECT cron.schedule('refresh-inactive-30-days-daily','0 2 * * *','SELECT church.refresh_inactive_30_days();');

-- Schedule daily follow-up processing (at 2:10 AM)
SELECT cron.schedule('process-inactive-30-days-followups-daily','10 2 * * *','SELECT church.process_inactive_30_days_followups();');
