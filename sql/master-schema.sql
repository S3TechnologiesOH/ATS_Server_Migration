-- ============================================================================
-- Master Database Schema: ats-master
-- ============================================================================
-- This schema should be run on the master database (ats-master) which
-- contains tenant configuration and user allowlists.
--
-- To create the master database:
--   CREATE DATABASE "ats-master";
--
-- Then connect to it and run this script:
--   \c "ats-master"
--   \i master-schema.sql
-- ============================================================================

-- ============================================
-- TENANTS TABLE
-- ============================================
CREATE TABLE tenants (
  id SERIAL PRIMARY KEY,
  company_name VARCHAR(255) NOT NULL,
  subdomain VARCHAR(100) UNIQUE NOT NULL,
  custom_domain VARCHAR(255) UNIQUE,

  -- Database location
  db_name VARCHAR(100) NOT NULL UNIQUE,
  db_host VARCHAR(255) DEFAULT 'postgres',
  db_port INTEGER DEFAULT 5432,

  -- Microsoft authentication
  auth_type VARCHAR(50) DEFAULT 'shared',
  microsoft_client_id VARCHAR(255),
  microsoft_client_secret VARCHAR(500),
  microsoft_tenant_id VARCHAR(255),
  email_domains TEXT[],
  allow_auto_provision BOOLEAN DEFAULT false,
  consent_granted BOOLEAN DEFAULT false,
  consent_granted_at TIMESTAMP,

  -- Billing & seats
  subscription_tier VARCHAR(50) DEFAULT 'standard',
  max_seats INTEGER DEFAULT 5,
  price_per_seat DECIMAL(10,2) DEFAULT 50.00,
  billing_email VARCHAR(255),
  stripe_customer_id VARCHAR(255),
  stripe_subscription_id VARCHAR(255),

  -- Job board branding
  logo_url VARCHAR(500),
  primary_color VARCHAR(7) DEFAULT '#0066CC',
  secondary_color VARCHAR(7) DEFAULT '#333333',
  favicon_url VARCHAR(500),
  custom_css TEXT,

  -- AI configuration: { provider: "openai"|"google", model: "gpt-4o-mini", api_key: "..." }
  ai_config JSONB DEFAULT '{}'::jsonb,

  -- Status
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  is_active BOOLEAN DEFAULT true
);

-- ============================================
-- TENANT USERS TABLE (Allowlist for login)
-- ============================================
CREATE TABLE tenant_users (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email VARCHAR(255) NOT NULL,
  first_name VARCHAR(100),
  last_name VARCHAR(100),
  role VARCHAR(50) DEFAULT 'user',
  microsoft_oid VARCHAR(255),

  -- Access control
  is_active BOOLEAN DEFAULT true,
  invited_by INTEGER REFERENCES tenant_users(id),
  invited_at TIMESTAMP,
  last_login TIMESTAMP,

  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),

  UNIQUE(tenant_id, email)
);

-- ============================================
-- TENANT ACCESS LOG (Optional - for auditing)
-- ============================================
CREATE TABLE tenant_access_log (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER REFERENCES tenants(id),
  user_email VARCHAR(255),
  action VARCHAR(50),
  ip_address INET,
  details JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW()
);

-- ============================================
-- SESSION TABLE (for connect-pg-simple)
-- ============================================
CREATE TABLE IF NOT EXISTS session (
  sid VARCHAR NOT NULL COLLATE "default" PRIMARY KEY,
  sess JSON NOT NULL,
  expire TIMESTAMP(6) NOT NULL
);

-- ============================================
-- TENANT API KEYS (for external integrations)
-- ============================================
CREATE TABLE tenant_api_keys (
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
CREATE TABLE tenant_application_questions (
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
CREATE INDEX idx_tenant_subdomain ON tenants(subdomain);
CREATE INDEX idx_tenant_custom_domain ON tenants(custom_domain);
CREATE INDEX idx_tenant_stripe_customer ON tenants(stripe_customer_id);
CREATE INDEX idx_tenant_users_email ON tenant_users(tenant_id, email);
CREATE INDEX idx_tenant_users_microsoft_oid ON tenant_users(microsoft_oid);
CREATE INDEX idx_tenant_users_active ON tenant_users(tenant_id, is_active);
CREATE INDEX idx_session_expire ON session(expire);
CREATE INDEX idx_access_log_tenant ON tenant_access_log(tenant_id);
CREATE INDEX idx_access_log_created ON tenant_access_log(created_at);
CREATE INDEX idx_tenant_api_keys_key ON tenant_api_keys(api_key);
CREATE INDEX idx_tenant_api_keys_tenant ON tenant_api_keys(tenant_id);
CREATE INDEX idx_tenant_api_keys_active ON tenant_api_keys(tenant_id, is_active);
CREATE INDEX idx_tenant_questions_tenant ON tenant_application_questions(tenant_id);
CREATE INDEX idx_tenant_questions_active ON tenant_application_questions(tenant_id, is_active);

-- ============================================
-- TRIGGERS
-- ============================================
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_tenants_updated_at BEFORE UPDATE ON tenants
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_tenant_users_updated_at BEFORE UPDATE ON tenant_users
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_tenant_questions_updated_at BEFORE UPDATE ON tenant_application_questions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================
-- INITIAL DATA (uncomment and customize)
-- ============================================
-- INSERT INTO tenants (company_name, subdomain, db_name)
-- VALUES ('S3 Technology Group', 'mys3tech', 'ats-tenant-mys3tech');

-- INSERT INTO tenant_users (tenant_id, email, first_name, last_name, role)
-- VALUES
--     (1, 'nancy.larker@gmail.com', 'Nancy', 'Larker', 'admin'),
--     (1, 'catwell@mys3tech.com', 'Cat', 'Well', 'admin');

-- ============================================
-- USEFUL QUERIES
-- ============================================
-- View all tenants with user counts:
-- SELECT t.*, COUNT(tu.id) as user_count
-- FROM tenants t
-- LEFT JOIN tenant_users tu ON tu.tenant_id = t.id AND tu.is_active = true
-- GROUP BY t.id
-- ORDER BY t.company_name;

-- View users for a specific tenant:
-- SELECT * FROM tenant_users WHERE tenant_id = 1 ORDER BY email;

-- Check if a user has access to a tenant:
-- SELECT * FROM tenant_users
-- WHERE tenant_id = 1 AND email = 'user@example.com' AND is_active = true;
