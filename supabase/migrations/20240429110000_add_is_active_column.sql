-- Add is_active column to students table for soft deletion
ALTER TABLE public.students 
ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE;

-- Update existing students to be active by default (already handled by DEFAULT TRUE but good to be explicit)
UPDATE public.students SET is_active = TRUE WHERE is_active IS NULL;
