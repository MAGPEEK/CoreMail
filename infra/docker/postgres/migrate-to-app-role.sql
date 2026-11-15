-- CoreMail — switch an EXISTING database to the least-privilege role coremail_app
-- (new installations get it from 02-app-role.sh). Run as the superuser, then set
-- COREMAIL_DB_USER=coremail_app + COREMAIL_DB_PASSWORD in .env and recreate the
-- coremail container. Steps and rollback: docs/deployment-security.md.
--
--   docker exec -i coremail-postgres psql -U coremail -d coremail \
--     -v app_password="$COREMAIL_DB_PASSWORD" < infra/docker/postgres/migrate-to-app-role.sql
--
-- One transaction: either everything is handed over or nothing changes.
\set ON_ERROR_STOP on
BEGIN;
CREATE ROLE coremail_app LOGIN PASSWORD :'app_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT CONNECT, TEMPORARY ON DATABASE coremail TO coremail_app;
ALTER SCHEMA public OWNER TO coremail_app;
-- Hand over every table, standalone sequence, view and enum type of schema public.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT format('ALTER TABLE public.%I OWNER TO coremail_app', c.relname) AS stmt
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
    UNION ALL
    SELECT format('ALTER VIEW public.%I OWNER TO coremail_app', c.relname)
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('v', 'm')
    UNION ALL
    SELECT format('ALTER SEQUENCE public.%I OWNER TO coremail_app', c.relname)
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'S'
       AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype IN ('a', 'i'))
    UNION ALL
    SELECT format('ALTER TYPE public.%I OWNER TO coremail_app', t.typname)
      FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
     WHERE n.nspname = 'public' AND t.typtype = 'e'
  LOOP
    EXECUTE r.stmt;
  END LOOP;
END $$;
COMMIT;
