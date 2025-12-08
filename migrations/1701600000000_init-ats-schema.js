/* eslint-disable camelcase */

exports.shorthands = undefined;

exports.up = (pgm) => {
  const schema = process.env.DB_SCHEMA || "public";
  pgm.sql(`
    ALTER TABLE IF EXISTS ${schema}.applications ADD COLUMN IF NOT EXISTS resume_url TEXT;
    ALTER TABLE IF EXISTS ${schema}.applications ADD COLUMN IF NOT EXISTS cover_letter_url TEXT;
    ALTER TABLE IF EXISTS ${schema}.candidates ADD COLUMN IF NOT EXISTS archived BOOLEAN DEFAULT FALSE;
    ALTER TABLE IF EXISTS ${schema}.candidates ADD COLUMN IF NOT EXISTS archived_at TIMESTAMP;
    ALTER TABLE IF EXISTS ${schema}.candidates ADD COLUMN IF NOT EXISTS archived_by VARCHAR(120);
    ALTER TABLE IF EXISTS ${schema}.candidates ADD COLUMN IF NOT EXISTS archive_reason TEXT;
    CREATE INDEX IF NOT EXISTS idx_candidates_archived ON ${schema}.candidates(archived) WHERE archived = TRUE;
    ALTER TABLE IF EXISTS ${schema}.job_listings ADD COLUMN IF NOT EXISTS archived BOOLEAN DEFAULT FALSE;
    ALTER TABLE IF EXISTS ${schema}.job_listings ADD COLUMN IF NOT EXISTS archived_at TIMESTAMP;
    ALTER TABLE IF EXISTS ${schema}.job_listings ADD COLUMN IF NOT EXISTS archived_by VARCHAR(120);
    ALTER TABLE IF EXISTS ${schema}.job_listings ADD COLUMN IF NOT EXISTS archive_reason TEXT;
    CREATE INDEX IF NOT EXISTS idx_job_listings_archived ON ${schema}.job_listings(archived) WHERE archived = TRUE;
  `);
};

exports.down = (pgm) => {
  // No-op for safety as this is an initial retrofit migration
};
