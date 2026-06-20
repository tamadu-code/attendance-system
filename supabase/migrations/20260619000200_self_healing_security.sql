-- Migration: Self-Healing RLS Security Fallback
-- Description: Configures is_tenant_member and is_admin as SECURITY DEFINER functions to query profiles table when JWT claims are missing. Allows users to read their own profile.

-- ============================================================
-- STEP 1: Enable profiles read access for own user ID (before recreating is_tenant_member)
-- ============================================================
DROP POLICY IF EXISTS "profiles_select_own" ON public.profiles;
CREATE POLICY "profiles_select_own" ON public.profiles FOR SELECT TO authenticated
    USING (auth.uid() = id);

-- ============================================================
-- STEP 2: Recreate is_tenant_member with SECURITY DEFINER and fallback query
-- ============================================================
CREATE OR REPLACE FUNCTION public.is_tenant_member(row_tenant_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
DECLARE
    jwt_claims jsonb;
    jwt_tenant_id text;
    user_id uuid;
    db_tenant_id uuid;
BEGIN
    -- Try JWT claims first
    BEGIN
        jwt_claims := current_setting('request.jwt.claims', true)::jsonb;
    EXCEPTION WHEN OTHERS THEN
        jwt_claims := null;
    END;

    IF jwt_claims IS NOT NULL THEN
        IF (jwt_claims ->> 'user_role') = 'SuperAdmin' THEN
            RETURN true;
        END IF;

        jwt_tenant_id := jwt_claims ->> 'tenant_id';
        IF jwt_tenant_id IS NOT NULL THEN
            RETURN row_tenant_id::text = jwt_tenant_id;
        END IF;
    END IF;

    -- Fallback: query database directly (SECURITY DEFINER runs as postgres and bypasses RLS)
    user_id := auth.uid();
    IF user_id IS NOT NULL THEN
        -- Check if user is SuperAdmin in profiles
        SELECT tenant_id, role INTO db_tenant_id, jwt_tenant_id 
        FROM public.profiles 
        WHERE id = user_id;

        IF jwt_tenant_id = 'SuperAdmin' THEN
            RETURN true;
        END IF;

        IF row_tenant_id IS NULL THEN
            RETURN true;
        END IF;

        RETURN row_tenant_id = db_tenant_id;
    END IF;

    RETURN false;
END;
$$;

GRANT EXECUTE ON FUNCTION public.is_tenant_member TO authenticated, service_role;

-- ============================================================
-- STEP 3: Recreate is_admin with SECURITY DEFINER and fallback query
-- ============================================================
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
DECLARE
    jwt_claims jsonb;
    jwt_user_role text;
    user_id uuid;
    db_user_role text;
BEGIN
    -- Try JWT claims first
    BEGIN
        jwt_claims := current_setting('request.jwt.claims', true)::jsonb;
    EXCEPTION WHEN OTHERS THEN
        jwt_claims := null;
    END;

    IF jwt_claims IS NOT NULL THEN
        jwt_user_role := jwt_claims ->> 'user_role';
        IF jwt_user_role IS NOT NULL THEN
            RETURN jwt_user_role IN ('Admin', 'SuperAdmin');
        END IF;
    END IF;

    -- Fallback: query database directly
    user_id := auth.uid();
    IF user_id IS NOT NULL THEN
        SELECT role INTO db_user_role 
        FROM public.profiles 
        WHERE id = user_id;

        RETURN db_user_role IN ('Admin', 'SuperAdmin');
    END IF;

    RETURN false;
END;
$$;

GRANT EXECUTE ON FUNCTION public.is_admin TO authenticated, service_role;
