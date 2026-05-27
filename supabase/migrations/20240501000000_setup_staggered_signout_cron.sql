-- Migration: Setup Staggered Signout Cron Job
-- This migration enables pg_cron and pg_net, and schedules a recurring job 
-- to trigger the staggered-signout edge function.

-- 1. Enable required extensions
CREATE EXTENSION IF NOT EXISTS pg_net;
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- 2. Define the project reference and secret
-- IMPORTANT: Update these values if they differ from your project setup
DO $$
DECLARE
    project_ref TEXT := 'wuzliodvddzmhehffqfx'; -- From index.html SUPABASE_URL
    auto_signout_secret TEXT := 'Tam360Du180'; -- Default secret, should match AUTO_SIGNOUT_SECRET environment variable
    function_url TEXT;
BEGIN
    function_url := 'https://' || project_ref || '.supabase.co/functions/v1/staggered-signout';

    -- 3. Schedule the cron job
    -- This job runs every minute. The edge function itself handles the time-based logic.
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
END $$;
