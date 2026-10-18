-- Read-only on stored data (one temporary table for the result, gone with the session). For RELEASE.md §2a item 3: every
-- foreign key in public, and the rows whose reference points at nothing. Expected: no row in the result. A restore loads
-- data with triggers off, so foreign keys aren't checked while it runs; this checks them afterwards. Run it whole.
CREATE TEMP TABLE IF NOT EXISTS zz_fk_orphans (constraint_name text, child text, orphans bigint);
TRUNCATE zz_fk_orphans;
DO $fk$
DECLARE r record; n bigint;
BEGIN
  FOR r IN
    SELECT c.conname, c.conrelid::regclass::text AS child, c.confrelid::regclass::text AS parent,
           (SELECT string_agg(format('c.%I', a.attname), ', ' ORDER BY k.ord) FROM unnest(c.conkey) WITH ORDINALITY k(att, ord)
              JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.att) AS ccols,
           (SELECT string_agg(format('p.%I', a.attname), ', ' ORDER BY k.ord) FROM unnest(c.confkey) WITH ORDINALITY k(att, ord)
              JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.att) AS pcols
      FROM pg_constraint c WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace
  LOOP
    EXECUTE format('SELECT count(*) FROM %s c WHERE ROW(%s) IS NOT NULL AND NOT EXISTS (SELECT 1 FROM %s p WHERE ROW(%s) = ROW(%s))',
                   r.child, r.ccols, r.parent, r.pcols, r.ccols) INTO n;
    IF n > 0 THEN INSERT INTO zz_fk_orphans VALUES (r.conname, r.child, n); END IF;
  END LOOP;
END $fk$;
SELECT * FROM zz_fk_orphans ORDER BY 1;
