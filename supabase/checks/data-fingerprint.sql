-- Read-only. One line per shop table (public hangtag_* tables with an owner_id column): its row count and an MD5 of all its
-- rows. No row is printed. Run it right before and right after a database change that must not touch data (the 2026-10-13
-- repair): every line must be the same. A shop working at that moment changes its own tables — then repeat in a quiet
-- minute, or look at which table moved and why.
CREATE TEMP TABLE IF NOT EXISTS zz_data_fingerprint (tbl text, row_count bigint, md5 text);
TRUNCATE zz_data_fingerprint;
DO $fp$
DECLARE t text; n bigint; h text;
BEGIN
  FOR t IN SELECT DISTINCT c.table_name FROM information_schema.columns c JOIN pg_class k ON k.relname = c.table_name AND k.relnamespace = 'public'::regnamespace AND k.relkind IN ('r', 'p')
            WHERE c.table_schema = 'public' AND c.column_name = 'owner_id' AND c.table_name LIKE 'hangtag%' ORDER BY 1 LOOP
    EXECUTE format('SELECT count(*), md5(COALESCE(string_agg(x, ''|'' ORDER BY x), '''')) FROM (SELECT to_jsonb(r)::text AS x FROM public.%I r) s', t) INTO n, h;
    INSERT INTO zz_data_fingerprint VALUES (t, n, h);
  END LOOP;
END $fp$;
SELECT tbl, row_count, md5 FROM zz_data_fingerprint ORDER BY tbl;
