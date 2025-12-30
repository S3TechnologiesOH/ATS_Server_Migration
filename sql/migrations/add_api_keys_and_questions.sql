-- ============================================================================
-- Migration: Add API Keys and Application Questions tables
-- Run this on the MASTER database (ats-master)
-- ============================================================================

-- ============================================
-- TENANT API KEYS (for external integrations)
-- ============================================
CREATE TABLE IF NOT EXISTS tenant_api_keys (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  api_key VARCHAR(64) NOT NULL UNIQUE,
  api_key_prefix VARCHAR(12) NOT NULL,  -- "pk_live_xxxx" for display
  name VARCHAR(100) DEFAULT 'Default Key',
  description TEXT,
  allowed_domains TEXT[],               -- Optional CORS restriction
  rate_limit_per_minute INTEGER DEFAULT 100,
  is_active BOOLEAN DEFAULT true,
  last_used_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  revoked_at TIMESTAMP
);

-- ============================================
-- TENANT APPLICATION QUESTIONS (default questions)
-- ============================================
CREATE TABLE IF NOT EXISTS tenant_application_questions (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  question_key VARCHAR(100) NOT NULL,   -- e.g., "values_resonates"
  question_type VARCHAR(50) NOT NULL,   -- text, textarea, radio, checkbox, yes_no, dropdown, file
  label TEXT NOT NULL,
  helper_text TEXT,
  placeholder TEXT,
  options JSONB DEFAULT '[]',           -- [{value, label}, ...] for radio/checkbox/dropdown
  is_required BOOLEAN DEFAULT false,
  min_length INTEGER,
  max_length INTEGER,
  display_order INTEGER DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(tenant_id, question_key)
);

-- ============================================
-- INDEXES
-- ============================================
CREATE INDEX IF NOT EXISTS idx_tenant_api_keys_key ON tenant_api_keys(api_key);
CREATE INDEX IF NOT EXISTS idx_tenant_api_keys_tenant ON tenant_api_keys(tenant_id);
CREATE INDEX IF NOT EXISTS idx_tenant_api_keys_active ON tenant_api_keys(tenant_id, is_active);
CREATE INDEX IF NOT EXISTS idx_tenant_questions_tenant ON tenant_application_questions(tenant_id);
CREATE INDEX IF NOT EXISTS idx_tenant_questions_active ON tenant_application_questions(tenant_id, is_active);

-- ============================================
-- TRIGGER (reuse existing function)
-- ============================================
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'update_tenant_questions_updated_at') THEN
    CREATE TRIGGER update_tenant_questions_updated_at
      BEFORE UPDATE ON tenant_application_questions
      FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  END IF;
END
$$;

-- ============================================
-- Verification
-- ============================================
SELECT 'tenant_api_keys created' AS status WHERE EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'tenant_api_keys');
SELECT 'tenant_application_questions created' AS status WHERE EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'tenant_application_questions');
