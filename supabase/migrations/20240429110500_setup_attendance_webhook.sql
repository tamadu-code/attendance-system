-- Setup Database Webhook for Attendance Events
-- This script enables pg_net and creates a trigger to forward INSERT events to an external service.

-- 1. Enable the pg_net extension
CREATE EXTENSION IF NOT EXISTS pg_net;

-- 2. Create a function to handle the webhook
CREATE OR REPLACE FUNCTION public.handle_attendance_insert()
RETURNS TRIGGER AS $$
DECLARE
  webhook_url TEXT := 'https://your-sms-gateway-endpoint'; -- Replace with actual SMS gateway or Edge Function URL
  secret_token TEXT := 'your-shared-secret'; -- Ideally set via vault or app settings
BEGIN
  PERFORM
    net.http_post(
      url := webhook_url,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || secret_token
      ),
      body := jsonb_build_object(
        'type', 'INSERT',
        'table', 'attendance',
        'record', row_to_json(NEW)
      )
    );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 3. Create the trigger
DROP TRIGGER IF EXISTS on_attendance_insert ON public.attendance;
CREATE TRIGGER on_attendance_insert
  AFTER INSERT ON public.attendance
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_attendance_insert();
