-- Read-only on stored data (one temporary table for the result, gone with the session). For RELEASE.md §2a item 3: the
-- exact row count of every table in public and auth, and storage objects by bucket — no row's content. Run it whole on
-- live and on the restored copy, and compare line by line.
CREATE TEMP TABLE IF NOT EXISTS zz_row_counts (tbl text, row_count bigint);
TRUNCATE zz_row_counts;
DO $rc$
DECLARE t record; n bigint;
BEGIN
  FOR t IN SELECT n.nspname, c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE c.relkind IN ('r', 'p') AND n.nspname IN ('public', 'auth') ORDER BY 1, 2 LOOP
    EXECUTE format('SELECT count(*) FROM %I.%I', t.nspname, t.relname) INTO n;
    INSERT INTO zz_row_counts VALUES (t.nspname || '.' || t.relname, n);
  END LOOP;
  IF to_regclass('storage.objects') IS NOT NULL THEN
    FOR t IN EXECUTE 'SELECT bucket_id, count(*) AS n FROM storage.objects GROUP BY 1' LOOP
      INSERT INTO zz_row_counts VALUES ('storage.objects:' || t.bucket_id, t.n);
    END LOOP;
  END IF;
END $rc$;
SELECT * FROM zz_row_counts ORDER BY 1;
