-- Migration: Add audit columns to attendance table
-- Description: Adds signed_in_by and signed_out_by columns referencing profiles(id).

ALTER TABLE public.attendance 
ADD COLUMN IF NOT EXISTS signed_in_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL;

ALTER TABLE public.attendance 
ADD COLUMN IF NOT EXISTS signed_out_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL;
