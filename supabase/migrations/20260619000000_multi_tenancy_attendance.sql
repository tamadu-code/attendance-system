-- Migration: Multi-Tenancy Foundation and Security for Attendance System
-- Description: Creates tenants, subscriptions, profiles tables. Adds tenant_id to existing tables, configures RLS, and sets up auth token claims.

-- ============================================================
-- STEP 1: Enable required extensions
-- ============================================================
CREATE EXTENSION IF NOT EXISTS pg_net;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- STEP 2: Create core multi-tenancy management tables
-- ============================================================

CREATE TABLE IF NOT EXISTS public.tenants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    slug VARCHAR(100) UNIQUE NOT NULL,
    student_id_prefix VARCHAR(20) NOT NULL DEFAULT 'NKQMS',
    status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'deleted')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    plan_tier VARCHAR(50) NOT NULL DEFAULT 'standard' CHECK (plan_tier IN ('free', 'standard', 'premium', 'custom')),
    status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('trialing', 'active', 'past_due', 'canceled')),
    max_student_limit INTEGER DEFAULT 500,
    expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.profiles (
    id UUID PRIMARY KEY,
    tenant_id UUID REFERENCES public.tenants(id) ON DELETE CASCADE,
    role TEXT DEFAULT 'Admin',
    full_name TEXT,
    email TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- Indexes for lookup performance
CREATE INDEX IF NOT EXISTS idx_subscriptions_tenant ON public.subscriptions(tenant_id);
CREATE INDEX IF NOT EXISTS idx_profiles_tenant ON public.profiles(tenant_id);

-- ============================================================
-- STEP 3: Create default seed tenant for existing school
-- ============================================================
INSERT INTO public.tenants (id, name, slug, student_id_prefix, status)
VALUES (
    '00000000-0000-0000-0000-000000000001',
    'NKQM Default School',
    'nkqm-default',
    'NKQMS',
    'active'
) ON CONFLICT (id) DO NOTHING;

INSERT INTO public.subscriptions (tenant_id, plan_tier, status, max_student_limit, expires_at)
VALUES (
    '00000000-0000-0000-0000-000000000001',
    'custom',
    'active',
    99999,
    '2099-12-31T23:59:59Z'
) ON CONFLICT DO NOTHING;

-- ============================================================
-- STEP 4: Add tenant_id to all user tables & backfill
-- ============================================================

ALTER TABLE public.students ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES public.tenants(id);
ALTER TABLE public.attendance ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES public.tenants(id);
ALTER TABLE public.daily_groups ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES public.tenants(id);
ALTER TABLE public.settings ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES public.tenants(id);

-- Backfill existing records with the default seed tenant ID
UPDATE public.students SET tenant_id = '00000000-0000-0000-0000-000000000001' WHERE tenant_id IS NULL;
UPDATE public.attendance SET tenant_id = '00000000-0000-0000-0000-000000000001' WHERE tenant_id IS NULL;
UPDATE public.daily_groups SET tenant_id = '00000000-0000-0000-0000-000000000001' WHERE tenant_id IS NULL;
UPDATE public.settings SET tenant_id = '00000000-0000-0000-0000-000000000001' WHERE tenant_id IS NULL;

-- Enforce NOT NULL constraint on tenant_id now that backfill is done
ALTER TABLE public.students ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE public.attendance ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE public.daily_groups ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE public.settings ALTER COLUMN tenant_id SET NOT NULL;

-- ============================================================
-- STEP 5: Rebuild settings primary key to include tenant_id
-- ============================================================
ALTER TABLE public.settings DROP CONSTRAINT IF EXISTS settings_pkey;
ALTER TABLE public.settings ADD PRIMARY KEY (tenant_id, key);

-- Create performance indexes
CREATE INDEX IF NOT EXISTS idx_students_tenant ON public.students(tenant_id);
CREATE INDEX IF NOT EXISTS idx_attendance_tenant ON public.attendance(tenant_id);
CREATE INDEX IF NOT EXISTS idx_daily_groups_tenant ON public.daily_groups(tenant_id);
CREATE INDEX IF NOT EXISTS idx_settings_tenant ON public.settings(tenant_id);

-- ============================================================
-- STEP 6: Custom access token claims hook and helper function
-- ============================================================

CREATE OR REPLACE FUNCTION public.custom_access_token_hook(event jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
DECLARE
    claims jsonb;
    user_tenant_id uuid;
    user_role text;
    raw_user_id text;
BEGIN
    -- 1. Safety check
    IF event IS NULL OR event->'claims' IS NULL THEN
        RETURN event;
    END IF;

    claims := event->'claims';
    raw_user_id := event->>'user_id';

    IF raw_user_id IS NULL AND event->'user' IS NOT NULL THEN
        raw_user_id := event->'user'->>'id';
    END IF;

    -- 2. Query profiles table
    IF raw_user_id IS NOT NULL AND raw_user_id ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN
        BEGIN
            SELECT p.tenant_id, p.role INTO user_tenant_id, user_role
            FROM public.profiles p
            WHERE p.id = raw_user_id::uuid;
        EXCEPTION WHEN OTHERS THEN
            user_tenant_id := NULL;
            user_role := NULL;
        END;
    END IF;

    -- 3. Inject claims
    IF user_tenant_id IS NOT NULL THEN
        claims := jsonb_set(claims, '{tenant_id}', to_jsonb(user_tenant_id::text));
    END IF;

    IF user_role IS NOT NULL THEN
        claims := jsonb_set(claims, '{user_role}', to_jsonb(user_role));
    ELSE
        claims := jsonb_set(claims, '{user_role}', '"Admin"'); -- Default role
    END IF;

    event := jsonb_set(event, '{claims}', claims);
    RETURN event;
EXCEPTION WHEN OTHERS THEN
    RETURN event;
END;
$$;

-- Grant permissions for token hook
GRANT USAGE ON SCHEMA public TO supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.custom_access_token_hook TO supabase_auth_admin;
GRANT SELECT ON TABLE public.profiles TO supabase_auth_admin;
REVOKE EXECUTE ON FUNCTION public.custom_access_token_hook FROM authenticated, anon, public;

-- RLS Policy Helper
CREATE OR REPLACE FUNCTION public.is_tenant_member(row_tenant_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
    IF (current_setting('request.jwt.claims', true)::jsonb ->> 'user_role') = 'SuperAdmin' THEN
        RETURN true;
    END IF;

    IF row_tenant_id IS NULL THEN
        RETURN true;
    END IF;

    RETURN row_tenant_id::text = (current_setting('request.jwt.claims', true)::jsonb ->> 'tenant_id');
END;
$$;

GRANT EXECUTE ON FUNCTION public.is_tenant_member TO authenticated, service_role;

-- ============================================================
-- STEP 7: Enable RLS and create tenant-aware policies
-- ============================================================

DO $$
DECLARE
    tbl TEXT;
BEGIN
    FOREACH tbl IN ARRAY ARRAY[
        'profiles', 'students', 'attendance', 'daily_groups', 'settings'
    ]
    LOOP
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl);

        EXECUTE format('DROP POLICY IF EXISTS "tenant_select_%s" ON public.%I', tbl, tbl);
        EXECUTE format('DROP POLICY IF EXISTS "tenant_insert_%s" ON public.%I', tbl, tbl);
        EXECUTE format('DROP POLICY IF EXISTS "tenant_update_%s" ON public.%I', tbl, tbl);
        EXECUTE format('DROP POLICY IF EXISTS "tenant_delete_%s" ON public.%I', tbl, tbl);
        EXECUTE format('DROP POLICY IF EXISTS "service_role_bypass_%s" ON public.%I', tbl, tbl);

        -- SELECT
        EXECUTE format(
            'CREATE POLICY "tenant_select_%s" ON public.%I FOR SELECT TO authenticated USING (public.is_tenant_member(tenant_id))',
            tbl, tbl
        );

        -- INSERT
        EXECUTE format(
            'CREATE POLICY "tenant_insert_%s" ON public.%I FOR INSERT TO authenticated WITH CHECK (public.is_tenant_member(tenant_id))',
            tbl, tbl
        );

        -- UPDATE
        EXECUTE format(
            'CREATE POLICY "tenant_update_%s" ON public.%I FOR UPDATE TO authenticated USING (public.is_tenant_member(tenant_id)) WITH CHECK (public.is_tenant_member(tenant_id))',
            tbl, tbl
        );

        -- DELETE
        EXECUTE format(
            'CREATE POLICY "tenant_delete_%s" ON public.%I FOR DELETE TO authenticated USING (public.is_tenant_member(tenant_id))',
            tbl, tbl
        );

        -- service_role bypass for edge functions
        EXECUTE format(
            'CREATE POLICY "service_role_bypass_%s" ON public.%I FOR ALL TO service_role USING (true) WITH CHECK (true)',
            tbl, tbl
        );

        RAISE NOTICE 'RLS applied to table: %', tbl;
    END LOOP;
END $$;

-- Tenants policies
ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenants_select" ON public.tenants;
CREATE POLICY "tenants_select" ON public.tenants
    FOR SELECT TO authenticated
    USING (
        id::text = (current_setting('request.jwt.claims', true)::jsonb ->> 'tenant_id')
        OR (current_setting('request.jwt.claims', true)::jsonb ->> 'user_role') = 'SuperAdmin'
    );
DROP POLICY IF EXISTS "tenants_manage" ON public.tenants;
CREATE POLICY "tenants_manage" ON public.tenants
    FOR ALL TO authenticated
    USING ((current_setting('request.jwt.claims', true)::jsonb ->> 'user_role') = 'SuperAdmin')
    WITH CHECK ((current_setting('request.jwt.claims', true)::jsonb ->> 'user_role') = 'SuperAdmin');
DROP POLICY IF EXISTS "tenants_service_role" ON public.tenants;
CREATE POLICY "tenants_service_role" ON public.tenants
    FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Subscriptions policies
ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "subscriptions_select" ON public.subscriptions;
CREATE POLICY "subscriptions_select" ON public.subscriptions
    FOR SELECT TO authenticated
    USING (
        tenant_id::text = (current_setting('request.jwt.claims', true)::jsonb ->> 'tenant_id')
        OR (current_setting('request.jwt.claims', true)::jsonb ->> 'user_role') = 'SuperAdmin'
    );
DROP POLICY IF EXISTS "subscriptions_manage" ON public.subscriptions;
CREATE POLICY "subscriptions_manage" ON public.subscriptions
    FOR ALL TO authenticated
    USING ((current_setting('request.jwt.claims', true)::jsonb ->> 'user_role') = 'SuperAdmin')
    WITH CHECK ((current_setting('request.jwt.claims', true)::jsonb ->> 'user_role') = 'SuperAdmin');
DROP POLICY IF EXISTS "subscriptions_service_role" ON public.subscriptions;
CREATE POLICY "subscriptions_service_role" ON public.subscriptions
    FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ============================================================
-- STEP 8: Update SMS Webhook Trigger to include tenant_id
-- ============================================================
CREATE OR REPLACE FUNCTION public.handle_attendance_event()
RETURNS TRIGGER AS $$
DECLARE
  webhook_url TEXT := 'https://urqygjltionvaxuacfzr.supabase.co/functions/v1/receive-attendance'; 
  secret_token TEXT := 'Tam360Du180'; 
  student_code TEXT;
  student_tenant_id UUID;
BEGIN
  -- 1. Fetch the biometric code and tenant_id for this student
  SELECT code, tenant_id INTO student_code, student_tenant_id 
  FROM public.students 
  WHERE id = NEW.student_id;

  -- 2. Skip if student not found (avoid sending null code)
  IF student_code IS NULL THEN
    RAISE WARNING 'handle_attendance_event: No student found for id=%, skipping webhook', NEW.student_id;
    RETURN NEW;
  END IF;

  -- 3. Send the webhook with tenant_id in the payload
  PERFORM
    net.http_post(
      url := webhook_url,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || secret_token
      ),
      body := jsonb_build_object(
        'attendance_code', student_code,
        'date', NEW.date,
        'sign_in', NEW.sign_in,
        'sign_out', NEW.sign_out,
        'is_late', NEW.is_late,
        'tenant_id', student_tenant_id,
        'event_type', TG_OP
      )
    );
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'handle_attendance_event failed: %', SQLERRM;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Recreate trigger
DROP TRIGGER IF EXISTS on_attendance_event ON public.attendance;
CREATE TRIGGER on_attendance_event
  AFTER INSERT OR UPDATE ON public.attendance
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_attendance_event();

-- ============================================================
-- STEP 9: Grant API access to new tables
-- ============================================================
GRANT SELECT ON TABLE public.tenants TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.tenants TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.tenants TO service_role;

GRANT SELECT ON TABLE public.subscriptions TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.subscriptions TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.subscriptions TO service_role;
