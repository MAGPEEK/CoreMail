-- CoreMail PostgreSQL Init
-- Runs once on first container start

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "pg_trgm";      -- trigram search
CREATE EXTENSION IF NOT EXISTS "unaccent";      -- accent-insensitive search
CREATE EXTENSION IF NOT EXISTS "pgcrypto";      -- gen_random_uuid()

-- Full-text search configuration with unaccent
CREATE TEXT SEARCH CONFIGURATION coremail_search (COPY = german);
ALTER TEXT SEARCH CONFIGURATION coremail_search
  ALTER MAPPING FOR hword, hword_part, word WITH unaccent, german_stem;

-- Performance: set timezone
SET timezone = 'UTC';
