/* eslint-disable camelcase */

exports.shorthands = undefined;

exports.up = (pgm) => {
  const schema = process.env.DB_SCHEMA || "public";
  pgm.sql(`
    -- Add icon column to departments table
    ALTER TABLE IF EXISTS ${schema}.departments 
    ADD COLUMN IF NOT EXISTS icon VARCHAR(100);
    
    -- Add a comment to document the column
    COMMENT ON COLUMN ${schema}.departments.icon IS 'Phosphor icon class name (e.g., ph-briefcase, ph-users)';
  `);
};

exports.down = (pgm) => {
  const schema = process.env.DB_SCHEMA || "public";
  pgm.sql(`
    ALTER TABLE IF EXISTS ${schema}.departments 
    DROP COLUMN IF EXISTS icon;
  `);
};
