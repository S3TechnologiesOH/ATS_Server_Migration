-- Create app_user table to track users who interact with the system
-- This table is used by getActorUserId() to record who uploads files

CREATE TABLE IF NOT EXISTS public.app_user (
    id SERIAL PRIMARY KEY,
    email VARCHAR(255) NOT NULL UNIQUE,
    display_name VARCHAR(255),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create index on email for faster lookups
CREATE INDEX IF NOT EXISTS idx_app_user_email ON public.app_user(email);

-- Add a trigger to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_app_user_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS app_user_updated_at ON public.app_user;
CREATE TRIGGER app_user_updated_at
    BEFORE UPDATE ON public.app_user
    FOR EACH ROW
    EXECUTE FUNCTION update_app_user_updated_at();
