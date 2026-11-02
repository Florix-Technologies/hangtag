-- The first file of a recovery into a NEW Supabase project (supabase/RESTORE-RUNBOOK.md section 5), run as postgres in the
-- same transaction as the recovery itself. Never on the live project.
--
-- 1. It refuses any database that isn't a new, empty project: tables in schema public, schema private or
--    supabase_migrations, or sign-in accounts in auth.users. The run then stops before anything is changed and the whole
--    transaction rolls back. A second run of the recovery, or a run against the live project, stops here.
DO $guard$
DECLARE
  found text[] := '{}';
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')) THEN
    found := found || 'tables in schema public'::text;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname IN ('private', 'supabase_migrations')) THEN
    found := found || 'schema private or supabase_migrations'::text;
  END IF;
  IF to_regclass('auth.users') IS NULL THEN
    found := found || 'no auth.users: not a Supabase project'::text;
  ELSIF EXISTS (SELECT 1 FROM auth.users) THEN
    found := found || 'sign-in accounts in auth.users'::text;
  END IF;
  IF cardinality(found) > 0 THEN
    RAISE EXCEPTION 'not a new, empty Supabase project (%): the recovery never runs over an existing database. Nothing was changed.',
      array_to_string(found, '; ');
  END IF;
END
$guard$;

-- 2. A new Supabase project gives anon, authenticated and service_role ALL on every table, function and sequence that
-- postgres creates in schema public: these are its default privileges, which live has too. The backup writes each object's
-- privileges against PostgreSQL's built-in defaults, so it never revokes from anon or authenticated what live never
-- granted them. Restored over Supabase's default privileges, every restored object would keep those extra grants: anyone
-- with the publishable key could run service-role-only functions such as hangtag_admin_grant. So postgres's default grants
-- in public are taken away while the objects are created. The backup's own DEFAULT ACL entries, at the very end of the
-- recovery, put Supabase's defaults back for objects made later. Owners keep their own rights (a schema's default privileges
-- can only add to the built-in ones).
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon, authenticated, service_role;
