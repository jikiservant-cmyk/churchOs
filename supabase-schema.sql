-- 1. Create the church schema
CREATE SCHEMA IF NOT EXISTS church;

-- 2. Create the churches table (in the custom schema)
CREATE TABLE IF NOT EXISTS church.churches (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  theme_color text DEFAULT 'bg-blue-600',
  logo_url text,
  sender_id text,
  created_at timestamptz DEFAULT now()
);

-- 3. Create the admin_profiles table in public
CREATE TABLE IF NOT EXISTS public.admin_profiles (
  id uuid REFERENCES auth.users(id) ON DELETE CASCADE PRIMARY KEY,
  email text, -- Added as per user requirement, pastors can be identified by email
  tenant_id uuid REFERENCES church.churches(id), -- Changed from church_id as per user request
  role text NOT NULL DEFAULT 'pastor',
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
  id uuid PRIMARY KEY,
  app_type text NOT NULL, -- 'church' or 'school'
  name text NOT NULL,
  created_at timestamptz DEFAULT now()
);

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
  type text NOT NULL CHECK (type IN ('TOPUP','SMS_SENT','REFUND','ADJUSTMENT','BONUS','REVERSAL')),
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

-- 8. Enable Row Level Security (RLS)
ALTER TABLE church.churches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE church.sms_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wallet_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_events ENABLE ROW LEVEL SECURITY;

-- 8. Create RLS Policies

-- Tenants: Pastors can view their own tenant
CREATE POLICY "Pastors can view their tenant" 
  ON public.tenants FOR SELECT 
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.admin_profiles
      WHERE id = auth.uid() AND (tenant_id = public.tenants.id OR tenant_id IS NULL)
    )
  );

-- Tenants: Pastors can self-heal/insert their tenant
CREATE POLICY "Pastors can insert their tenant" 
  ON public.tenants FOR INSERT 
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.admin_profiles ap
      WHERE ap.id = auth.uid() AND (ap.tenant_id = id OR ap.tenant_id IS NULL)
    )
  );

-- Tenants: Pastors can self-heal/update their tenant
CREATE POLICY "Pastors can update their tenant" 
  ON public.tenants FOR UPDATE 
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.admin_profiles ap
      WHERE ap.id = auth.uid() AND (ap.tenant_id = id OR ap.tenant_id IS NULL)
    )
  );

-- Churches: Public read access for the giving portal
CREATE POLICY "Allow public read access to churches" 
  ON church.churches FOR SELECT 
  USING (true);

-- Admin Profiles: Users can read their own profile
CREATE POLICY "Allow users to read own profile" 
  ON public.admin_profiles FOR SELECT 
  TO authenticated
  USING (auth.uid() = id OR auth.jwt() ->> 'email' = email);

-- SMS Logs: Only pastors of the specific church can read their logs
CREATE POLICY "Pastors can read their church sms logs"
  ON church.sms_logs FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.admin_profiles ap
      WHERE ap.id = auth.uid() 
      AND ap.role = 'pastor' 
      AND (ap.tenant_id = tenant_id OR ap.tenant_id IS NULL)
    )
  );

-- SMS Logs: Only pastors of the specific church can insert logs
CREATE POLICY "Pastors can insert sms logs for their church"
  ON church.sms_logs FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.admin_profiles ap
      WHERE ap.id = auth.uid() 
      AND ap.role = 'pastor' 
      AND (ap.tenant_id = tenant_id OR ap.tenant_id IS NULL)
    )
  );

-- SMS Logs: Only pastors can update their own church's logs (to set final status)
CREATE POLICY "Pastors can update church sms logs"
  ON church.sms_logs FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.admin_profiles ap
      WHERE ap.id = auth.uid() 
      AND ap.role = 'pastor' 
      AND (ap.tenant_id = tenant_id OR ap.tenant_id IS NULL)
    )
  );

-- Wallets: Pastors can read their own church offset wallet
CREATE POLICY "Pastors can view church wallet"
  ON public.wallets FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.admin_profiles ap
      WHERE ap.id = auth.uid() AND (ap.tenant_id = tenant_id OR ap.tenant_id IS NULL)
    )
  );

-- Wallets: Pastors can self-heal and initialize their own wallet
CREATE POLICY "Pastors can initialize church wallet"
  ON public.wallets FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.admin_profiles ap
      WHERE ap.id = auth.uid() AND (ap.tenant_id = tenant_id OR ap.tenant_id IS NULL)
    )
  );

-- Wallets: Pastors can update their wallet (used in self-healing upsert)
CREATE POLICY "Pastors can update church wallet"
  ON public.wallets FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.admin_profiles ap
      WHERE ap.id = auth.uid() AND (ap.tenant_id = tenant_id OR ap.tenant_id IS NULL)
    )
  );

-- Transactions: Pastors can read their own church transactions
CREATE POLICY "Pastors can view church transactions"
  ON public.wallet_transactions FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.admin_profiles ap
      WHERE ap.id = auth.uid() AND (ap.tenant_id = tenant_id OR ap.tenant_id IS NULL)
    )
  );

-- Billing Events: Pastors can read their own church events
CREATE POLICY "Pastors can view church billing events"
  ON public.billing_events FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.admin_profiles ap
      WHERE ap.id = auth.uid() AND (ap.tenant_id = tenant_id OR ap.tenant_id IS NULL)
    )
  );

-- Billing Events: Webhooks or system can insert
CREATE POLICY "Pastors can insert billing events"
  ON public.billing_events FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.admin_profiles ap
      WHERE ap.id = auth.uid() AND (ap.tenant_id = tenant_id OR ap.tenant_id IS NULL)
    )
  );

-- 9. Create missing tables for members and new converts
CREATE TABLE IF NOT EXISTS church.members (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id uuid REFERENCES church.churches(id) NOT NULL,
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

-- RLS for Members
CREATE POLICY "Pastors can read their members"
  ON church.members FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.admin_profiles ap
      WHERE ap.id = auth.uid() AND (ap.tenant_id = tenant_id OR ap.tenant_id IS NULL)
    )
  );

CREATE POLICY "Pastors can insert members"
  ON church.members FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.admin_profiles ap
      WHERE ap.id = auth.uid() AND (ap.tenant_id = tenant_id OR ap.tenant_id IS NULL)
    )
  );

-- RLS for New Converts
CREATE POLICY "Pastors can read their new converts"
  ON church.new_converts FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.admin_profiles ap
      WHERE ap.id = auth.uid() AND (ap.tenant_id = church_id OR ap.tenant_id IS NULL)
    )
  );

CREATE POLICY "Pastors can insert new converts"
  ON church.new_converts FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.admin_profiles ap
      WHERE ap.id = auth.uid() AND (ap.tenant_id = church_id OR ap.tenant_id IS NULL)
    )
  );

-- 10. Insert initial demo data for Grace Church
INSERT INTO church.churches (id, name, slug, theme_color, logo_url)
VALUES (
  '11111111-1111-1111-1111-111111111111',
  'Grace Church Kampala', 
  'grace', 
  'bg-green-600', 
  'https://picsum.photos/seed/grace/200/200'
) ON CONFLICT (id) DO UPDATE SET slug = EXCLUDED.slug;

-- 11. Tables for Dashboard (Events, Prayers, Groups, Donations)
CREATE TABLE IF NOT EXISTS church.events (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id uuid REFERENCES church.churches(id) NOT NULL,
  title text NOT NULL,
  day text NOT NULL,
  start_time text NOT NULL,
  attending_count int DEFAULT 0,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS church.prayers (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id uuid REFERENCES church.churches(id) NOT NULL,
  submitter_name text NOT NULL,
  body text NOT NULL,
  status text DEFAULT 'open', -- 'open', 'answered'
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS church.small_groups (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id uuid REFERENCES church.churches(id) NOT NULL,
  name text NOT NULL,
  leader_name text NOT NULL,
  meeting_day text NOT NULL,
  member_count int DEFAULT 0,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS church.donations (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id uuid REFERENCES church.churches(id) NOT NULL,
  category text NOT NULL, -- 'Tithes', 'Offerings', 'Missions'
  amount_cents bigint NOT NULL,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE church.events ENABLE ROW LEVEL SECURITY;
ALTER TABLE church.prayers ENABLE ROW LEVEL SECURITY;
ALTER TABLE church.small_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE church.donations ENABLE ROW LEVEL SECURITY;

-- RLS policies for pastors
CREATE POLICY "Pastors can manage events" ON church.events
  TO authenticated USING (EXISTS (SELECT 1 FROM public.admin_profiles ap WHERE ap.id = auth.uid() AND (ap.tenant_id = tenant_id OR ap.tenant_id IS NULL)));
  
CREATE POLICY "Pastors can manage prayers" ON church.prayers
  TO authenticated USING (EXISTS (SELECT 1 FROM public.admin_profiles ap WHERE ap.id = auth.uid() AND (ap.tenant_id = tenant_id OR ap.tenant_id IS NULL)));

CREATE POLICY "Pastors can manage small_groups" ON church.small_groups
  TO authenticated USING (EXISTS (SELECT 1 FROM public.admin_profiles ap WHERE ap.id = auth.uid() AND (ap.tenant_id = tenant_id OR ap.tenant_id IS NULL)));

CREATE POLICY "Pastors can manage donations" ON church.donations
  TO authenticated USING (EXISTS (SELECT 1 FROM public.admin_profiles ap WHERE ap.id = auth.uid() AND (ap.tenant_id = tenant_id OR ap.tenant_id IS NULL)));
