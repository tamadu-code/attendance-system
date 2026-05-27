-- Ensure pg_net extension is enabled (required for net.http_post)
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Upgrade Webhook for Attendance Events
-- This script updates the trigger to handle BOTH Insert and Update,
-- and correctly maps the internal student_id to the biometric attendance code.

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
        'attendance_code', student_code, -- CORRECT biometric code
        'date', NEW.date,
        'sign_in', NEW.sign_in,
        'sign_out', NEW.sign_out,
        'is_late', NEW.is_late,
        'event_type', TG_OP -- INSERT or UPDATE
      )
    );
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Log error but don't block the INSERT/UPDATE operation
  RAISE WARNING 'handle_attendance_event failed: %', SQLERRM;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 3. Re-create the trigger for both INSERT and UPDATE
DROP TRIGGER IF EXISTS on_attendance_insert ON public.attendance;
DROP TRIGGER IF EXISTS on_attendance_event ON public.attendance;

CREATE TRIGGER on_attendance_event
  AFTER INSERT OR UPDATE ON public.attendance
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_attendance_event();
