-- ============================================================================
-- Migration: Add application_question_responses table
-- Run this on EACH TENANT database
-- ============================================================================

-- Store responses to dynamic application questions
CREATE TABLE IF NOT EXISTS application_question_responses (
  id SERIAL PRIMARY KEY,
  application_id INTEGER REFERENCES applications(application_id) ON DELETE CASCADE,
  question_key VARCHAR(100) NOT NULL,
  question_label TEXT,
  response_value TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(application_id, question_key)
);

-- Index for looking up responses by application
CREATE INDEX IF NOT EXISTS idx_app_question_responses_app
  ON application_question_responses(application_id);

-- Index for looking up responses by question key
CREATE INDEX IF NOT EXISTS idx_app_question_responses_key
  ON application_question_responses(question_key);

-- Verification
SELECT 'application_question_responses created' AS status
WHERE EXISTS (
  SELECT 1 FROM information_schema.tables
  WHERE table_name = 'application_question_responses'
);
