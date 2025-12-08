-- Add icon column to departments table
-- Run this SQL directly in your PostgreSQL database

ALTER TABLE ats.departments ADD COLUMN IF NOT EXISTS icon VARCHAR(100);

-- Add comment for documentation
COMMENT ON COLUMN ats.departments.icon IS 'Phosphor icon class name (e.g., ph-briefcase, ph-users)';

-- Verify the column was added
SELECT column_name, data_type, character_maximum_length, is_nullable
FROM information_schema.columns
WHERE table_schema = 'ats' 
  AND table_name = 'departments'
  AND column_name = 'icon';
