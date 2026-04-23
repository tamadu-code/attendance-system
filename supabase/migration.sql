-- SQL Migration for Staggered Sign-out System

-- 1. Create daily_groups table
CREATE TABLE IF NOT EXISTS public.daily_groups (
    date DATE NOT NULL,
    student_id TEXT NOT NULL,
    group_index INTEGER NOT NULL,
    PRIMARY KEY (date, student_id),
    CONSTRAINT fk_student FOREIGN KEY (student_id) REFERENCES public.students(id) ON DELETE CASCADE
);

-- Index for performance
CREATE INDEX IF NOT EXISTS idx_daily_groups_date ON public.daily_groups(date);

-- 2. Ensure settings table exists (it should, based on the app)
-- And ensure it has a 'config' entry or at least the schema supports it.
-- Based on the app code, it uses a JSONB or JSON field for 'value'.

-- 3. Add default settings if they don't exist in the JSON config
-- This will be handled by the frontend when it saves, but good to have here too.
-- UPDATE public.settings 
-- SET value = value || '{"school_closing_time": "15:30", "dismissal_group_size": 20, "dismissal_interval_minutes": 1}'::jsonb
-- WHERE key = 'config';
