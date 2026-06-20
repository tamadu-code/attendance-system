-- Migration: Role-Based Access Control for Teachers and Admins
-- Description: Restricts table mutations to Admin/SuperAdmin roles, while allowing Teachers to read data and log attendance.

-- ============================================================
-- STEP 1: Create is_admin helper function
-- ============================================================
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
    RETURN (current_setting('request.jwt.claims', true)::jsonb ->> 'user_role') IN ('Admin', 'SuperAdmin');
END;
$$;

GRANT EXECUTE ON FUNCTION public.is_admin TO authenticated, service_role;

-- ============================================================
-- STEP 2: Re-create policies for each table
-- ============================================================

-- Table 1: profiles
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_select_profiles" ON public.profiles;
DROP POLICY IF EXISTS "tenant_insert_profiles" ON public.profiles;
DROP POLICY IF EXISTS "tenant_update_profiles" ON public.profiles;
DROP POLICY IF EXISTS "tenant_delete_profiles" ON public.profiles;
DROP POLICY IF EXISTS "service_role_bypass_profiles" ON public.profiles;

CREATE POLICY "tenant_select_profiles" ON public.profiles FOR SELECT TO authenticated
    USING (public.is_tenant_member(tenant_id));
CREATE POLICY "tenant_insert_profiles" ON public.profiles FOR INSERT TO authenticated
    WITH CHECK (public.is_tenant_member(tenant_id) AND public.is_admin());
CREATE POLICY "tenant_update_profiles" ON public.profiles FOR UPDATE TO authenticated
    USING (public.is_tenant_member(tenant_id) AND public.is_admin())
    WITH CHECK (public.is_tenant_member(tenant_id) AND public.is_admin());
CREATE POLICY "tenant_delete_profiles" ON public.profiles FOR DELETE TO authenticated
    USING (public.is_tenant_member(tenant_id) AND public.is_admin());
CREATE POLICY "service_role_bypass_profiles" ON public.profiles FOR ALL TO service_role
    USING (true) WITH CHECK (true);

-- Table 2: students
ALTER TABLE public.students ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_select_students" ON public.students;
DROP POLICY IF EXISTS "tenant_insert_students" ON public.students;
DROP POLICY IF EXISTS "tenant_update_students" ON public.students;
DROP POLICY IF EXISTS "tenant_delete_students" ON public.students;
DROP POLICY IF EXISTS "service_role_bypass_students" ON public.students;

CREATE POLICY "tenant_select_students" ON public.students FOR SELECT TO authenticated
    USING (public.is_tenant_member(tenant_id));
CREATE POLICY "tenant_insert_students" ON public.students FOR INSERT TO authenticated
    WITH CHECK (public.is_tenant_member(tenant_id) AND public.is_admin());
CREATE POLICY "tenant_update_students" ON public.students FOR UPDATE TO authenticated
    USING (public.is_tenant_member(tenant_id) AND public.is_admin())
    WITH CHECK (public.is_tenant_member(tenant_id) AND public.is_admin());
CREATE POLICY "tenant_delete_students" ON public.students FOR DELETE TO authenticated
    USING (public.is_tenant_member(tenant_id) AND public.is_admin());
CREATE POLICY "service_role_bypass_students" ON public.students FOR ALL TO service_role
    USING (true) WITH CHECK (true);

-- Table 3: settings
ALTER TABLE public.settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_select_settings" ON public.settings;
DROP POLICY IF EXISTS "tenant_insert_settings" ON public.settings;
DROP POLICY IF EXISTS "tenant_update_settings" ON public.settings;
DROP POLICY IF EXISTS "tenant_delete_settings" ON public.settings;
DROP POLICY IF EXISTS "service_role_bypass_settings" ON public.settings;

CREATE POLICY "tenant_select_settings" ON public.settings FOR SELECT TO authenticated
    USING (public.is_tenant_member(tenant_id));
CREATE POLICY "tenant_insert_settings" ON public.settings FOR INSERT TO authenticated
    WITH CHECK (public.is_tenant_member(tenant_id) AND public.is_admin());
CREATE POLICY "tenant_update_settings" ON public.settings FOR UPDATE TO authenticated
    USING (public.is_tenant_member(tenant_id) AND public.is_admin())
    WITH CHECK (public.is_tenant_member(tenant_id) AND public.is_admin());
CREATE POLICY "tenant_delete_settings" ON public.settings FOR DELETE TO authenticated
    USING (public.is_tenant_member(tenant_id) AND public.is_admin());
CREATE POLICY "service_role_bypass_settings" ON public.settings FOR ALL TO service_role
    USING (true) WITH CHECK (true);

-- Table 4: daily_groups
ALTER TABLE public.daily_groups ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_select_daily_groups" ON public.daily_groups;
DROP POLICY IF EXISTS "tenant_insert_daily_groups" ON public.daily_groups;
DROP POLICY IF EXISTS "tenant_update_daily_groups" ON public.daily_groups;
DROP POLICY IF EXISTS "tenant_delete_daily_groups" ON public.daily_groups;
DROP POLICY IF EXISTS "service_role_bypass_daily_groups" ON public.daily_groups;

CREATE POLICY "tenant_select_daily_groups" ON public.daily_groups FOR SELECT TO authenticated
    USING (public.is_tenant_member(tenant_id));
CREATE POLICY "tenant_insert_daily_groups" ON public.daily_groups FOR INSERT TO authenticated
    WITH CHECK (public.is_tenant_member(tenant_id) AND public.is_admin());
CREATE POLICY "tenant_update_daily_groups" ON public.daily_groups FOR UPDATE TO authenticated
    USING (public.is_tenant_member(tenant_id) AND public.is_admin())
    WITH CHECK (public.is_tenant_member(tenant_id) AND public.is_admin());
CREATE POLICY "tenant_delete_daily_groups" ON public.daily_groups FOR DELETE TO authenticated
    USING (public.is_tenant_member(tenant_id) AND public.is_admin());
CREATE POLICY "service_role_bypass_daily_groups" ON public.daily_groups FOR ALL TO service_role
    USING (true) WITH CHECK (true);

-- Table 5: attendance
ALTER TABLE public.attendance ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_select_attendance" ON public.attendance;
DROP POLICY IF EXISTS "tenant_insert_attendance" ON public.attendance;
DROP POLICY IF EXISTS "tenant_update_attendance" ON public.attendance;
DROP POLICY IF EXISTS "tenant_delete_attendance" ON public.attendance;
DROP POLICY IF EXISTS "service_role_bypass_attendance" ON public.attendance;

CREATE POLICY "tenant_select_attendance" ON public.attendance FOR SELECT TO authenticated
    USING (public.is_tenant_member(tenant_id));
CREATE POLICY "tenant_insert_attendance" ON public.attendance FOR INSERT TO authenticated
    WITH CHECK (public.is_tenant_member(tenant_id));
CREATE POLICY "tenant_update_attendance" ON public.attendance FOR UPDATE TO authenticated
    USING (public.is_tenant_member(tenant_id))
    WITH CHECK (public.is_tenant_member(tenant_id));
CREATE POLICY "tenant_delete_attendance" ON public.attendance FOR DELETE TO authenticated
    USING (public.is_tenant_member(tenant_id) AND public.is_admin());
CREATE POLICY "service_role_bypass_attendance" ON public.attendance FOR ALL TO service_role
    USING (true) WITH CHECK (true);
