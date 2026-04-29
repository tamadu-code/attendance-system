-- Update the handle_attendance_insert function with correct SMS details
CREATE OR REPLACE FUNCTION public.handle_attendance_insert()
RETURNS TRIGGER AS $$
DECLARE
  webhook_url TEXT := 'https://urqygjltionvaxuacfzr.supabase.co/functions/v1/receive-attendance'; 
  secret_token TEXT := 'Tam360Du180'; 
BEGIN
  PERFORM
    net.http_post(
      url := webhook_url,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || secret_token
      ),
      body := jsonb_build_object(
        'attendance_code', NEW.student_id,
        'status', NEW.status,
        'date', NEW.date
      )
    );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
