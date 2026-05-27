-- ============================================================================
-- ATTENDANCE SYSTEM: Consolidated Fix Script
-- ============================================================================
-- Run this entire script in Supabase Dashboard -> SQL Editor to apply all fixes.
-- This is safe to run multiple times (idempotent).
-- ============================================================================

-- ============================================================================
-- STEP 1: Enable Required Extensions
-- ============================================================================
CREATE EXTENSION IF NOT EXISTS pg_net;

-- NOTE: pg_cron is only available on Supabase Pro plan ($25/month).
-- If you're on the free tier, uncomment the line below will fail — that's OK,
-- the manual "Trigger Auto Signout" button in the app will still work.
CREATE EXTENSION IF NOT EXISTS pg_cron;


-- ============================================================================
-- STEP 2: Ensure daily_groups table exists (for staggered sign-out)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.daily_groups (
    date DATE NOT NULL,
    student_id TEXT NOT NULL,
    group_index INTEGER NOT NULL,
    PRIMARY KEY (date, student_id)
);

-- Add foreign key only if students table exists and constraint doesn't exist
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints 
        WHERE constraint_name = 'fk_student' AND table_name = 'daily_groups'
    ) THEN
        BEGIN
            ALTER TABLE public.daily_groups 
            ADD CONSTRAINT fk_student 
            FOREIGN KEY (student_id) REFERENCES public.students(id) ON DELETE CASCADE;
        EXCEPTION WHEN OTHERS THEN
            RAISE WARNING 'Could not add foreign key fk_student: %', SQLERRM;
        END;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_daily_groups_date ON public.daily_groups(date);

-- Enable RLS but allow service role full access
ALTER TABLE public.daily_groups ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE tablename = 'daily_groups' AND policyname = 'Allow service role full access'
    ) THEN
        CREATE POLICY "Allow service role full access" ON public.daily_groups
            FOR ALL USING (true) WITH CHECK (true);
    END IF;
END $$;


-- ============================================================================
-- STEP 3: Ensure is_active column exists on students table
-- ============================================================================
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema = 'public' AND table_name = 'students' AND column_name = 'is_active'
    ) THEN
        ALTER TABLE public.students ADD COLUMN is_active BOOLEAN DEFAULT true;
    END IF;
END $$;


-- ============================================================================
-- STEP 4: Fix SMS Webhook Trigger (with error handling)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.handle_attendance_event()
RETURNS TRIGGER AS $$
DECLARE
  webhook_url TEXT := 'https://urqygjltionvaxuacfzr.supabase.co/functions/v1/receive-attendance'; 
  secret_token TEXT := 'Tam360Du180'; 
  student_code TEXT;
BEGIN
  -- 1. Fetch the biometric code for this student
  SELECT code INTO student_code 
  FROM public.students 
  WHERE id = NEW.student_id;

  -- 2. Skip if student not found (avoid sending null code)
  IF student_code IS NULL THEN
    RAISE WARNING 'handle_attendance_event: No student found for id=%, skipping webhook', NEW.student_id;
    RETURN NEW;
  END IF;

  -- 3. Send the webhook
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
        'event_type', TG_OP
      )
    );
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Log error but don't block the INSERT/UPDATE operation
  RAISE WARNING 'handle_attendance_event failed: %', SQLERRM;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Recreate trigger (safe to re-run)
DROP TRIGGER IF EXISTS on_attendance_insert ON public.attendance;
DROP TRIGGER IF EXISTS on_attendance_event ON public.attendance;

CREATE TRIGGER on_attendance_event
  AFTER INSERT OR UPDATE ON public.attendance
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_attendance_event();


-- ============================================================================
-- STEP 5: Setup/Fix Staggered Signout Cron Job (Pro plan only)
-- ============================================================================
-- This section will fail on Free tier (pg_cron not available) — that's expected.
-- The manual trigger button in the admin UI will still work regardless.

DO $$
DECLARE
    project_ref TEXT := 'wuzliodvddzmhehffqfx';
    auto_signout_secret TEXT := 'Tam360Du180';
    function_url TEXT;
BEGIN
    function_url := 'https://' || project_ref || '.supabase.co/functions/v1/staggered-signout';

    -- Remove existing job if any (to update headers)
    BEGIN
        PERFORM cron.unschedule('staggered-signout-job');
    EXCEPTION WHEN OTHERS THEN
        -- Job didn't exist, that's fine
        NULL;
    END;

    -- Schedule the cron job (runs every minute)
    PERFORM cron.schedule(
        'staggered-signout-job',
        '* * * * *',
        format(
            $command$
            SELECT net.http_post(
                url := %L,
                headers := jsonb_build_object(
                    'Content-Type', 'application/json',
                    'X-Auto-Signout-Secret', %L,
                    'Authorization', 'Bearer ' || current_setting('supabase.service_role_key', true)
                ),
                body := '{}'
            );
            $command$,
            function_url,
            auto_signout_secret
        )
    );
    
    RAISE NOTICE 'Staggered signout cron job scheduled successfully.';
EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'Could not setup cron job (pg_cron may not be available on Free tier): %', SQLERRM;
END $$;


-- ============================================================================
-- VERIFICATION QUERIES (uncomment to run after applying)
-- ============================================================================
-- SELECT extname, extversion FROM pg_extension WHERE extname IN ('pg_net', 'pg_cron');
-- SELECT trigger_name, event_manipulation, action_statement FROM information_schema.triggers WHERE trigger_name = 'on_attendance_event';
-- SELECT * FROM information_schema.tables WHERE table_name = 'daily_groups';
-- SELECT * FROM information_schema.columns WHERE table_name = 'students' AND column_name = 'is_active';
-- SELECT jobid, jobname, schedule, command FROM cron.job WHERE jobname = 'staggered-signout-job';
