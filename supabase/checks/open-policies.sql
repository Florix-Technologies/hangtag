-- Read-only. Policies that are always true: on a shop table (one with owner_id) one is enough to open every shop's rows to
-- every account, because policies are OR-ed (2026-10-13: six "Public access to …" policies came back that way). Expected:
-- no row. schema.sql's report row 96 counts the same on shop tables.
SELECT schemaname, tablename, policyname, roles::text AS roles, cmd
  FROM pg_policies
 WHERE btrim(COALESCE(qual, '')) IN ('true', '(true)') OR btrim(COALESCE(with_check, '')) IN ('true', '(true)')
 ORDER BY 1, 2, 3;
