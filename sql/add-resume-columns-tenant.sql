-- Add resume_url and cover_letter_url columns to tenant databases
-- Run this on each tenant database (e.g., ats-tenant-mys3tech)

-- For public schema (default)
ALTER TABLE IF EXISTS public.applications
  ADD COLUMN IF NOT EXISTS resume_url TEXT;

ALTER TABLE IF EXISTS public.applications
  ADD COLUMN IF NOT EXISTS cover_letter_url TEXT;

-- For custom schemas (update 'ats' if your schema is different)
ALTER TABLE IF EXISTS ats.applications
  ADD COLUMN IF NOT EXISTS resume_url TEXT;

ALTER TABLE IF EXISTS ats.applications
  ADD COLUMN IF NOT EXISTS cover_letter_url TEXT;

-- Verify columns were added
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'applications'
  AND column_name IN ('resume_url', 'cover_letter_url');
