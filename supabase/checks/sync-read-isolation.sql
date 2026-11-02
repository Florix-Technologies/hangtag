-- What a full sync can read, as two real shop owners (A, B: the first two shops with saved settings; no id is printed): every
-- shop table (public hangtag_* with an owner_id column), the rows visible and how many of them belong to another shop.
-- Read-only: each table is read in a sub-transaction that is always rolled back (with its role switch). Counts only.
-- Expected: rows_of_other_shops 0 for both; errors only on the tables the app never reads directly (permission denied,
-- 42501: the backup tables, hangtag_subscriptions, hangtag_trial_claims, hangtag_promo_redemptions, hangtag_webhook_secrets).
CREATE TEMP TABLE IF NOT EXISTS zz_sync_probe (who text, tbl text, visible bigint, other_shops bigint, err text);
TRUNCATE zz_sync_probe;
DO $probe$
DECLARE shops uuid[]; me uuid; t text; n bigint; o bigint; e text; pass int;
BEGIN
  SELECT array_agg(owner_id ORDER BY owner_id) INTO shops FROM (SELECT DISTINCT owner_id FROM public.hangtag_meta WHERE key = 'settings' AND owner_id IS NOT NULL ORDER BY owner_id LIMIT 2) s;
  FOR pass IN 1..2 LOOP
    me := shops[pass];
    FOR t IN SELECT DISTINCT c.table_name FROM information_schema.columns c JOIN pg_class k ON k.relname = c.table_name AND k.relnamespace = 'public'::regnamespace AND k.relkind IN ('r', 'p')
              WHERE c.table_schema = 'public' AND c.column_name = 'owner_id' AND c.table_name LIKE 'hangtag%' ORDER BY 1 LOOP
      n := NULL; o := NULL; e := NULL;
      BEGIN
        PERFORM set_config('request.jwt.claim.sub', me::text, true);
        PERFORM set_config('request.jwt.claims', json_build_object('sub', me, 'role', 'authenticated')::text, true);
        PERFORM set_config('request.headers', '{}', true);
        SET LOCAL ROLE authenticated;
        EXECUTE format('SELECT count(*), count(*) FILTER (WHERE owner_id IS DISTINCT FROM $1) FROM public.%I', t) INTO n, o USING me;
        RAISE EXCEPTION USING ERRCODE = 'ZZ001';
      EXCEPTION WHEN SQLSTATE 'ZZ001' THEN NULL; WHEN OTHERS THEN e := SQLSTATE;
      END;
      INSERT INTO zz_sync_probe VALUES (CASE pass WHEN 1 THEN 'A' ELSE 'B' END, t, n, o, e);
    END LOOP;
  END LOOP;
END $probe$;
SELECT who, count(*) AS tables, sum(visible) AS rows_visible, sum(other_shops) AS rows_of_other_shops,
       count(*) FILTER (WHERE err IS NOT NULL) AS tables_with_errors, string_agg(DISTINCT tbl || ':' || err, ', ') FILTER (WHERE err IS NOT NULL) AS errors,
       string_agg(DISTINCT tbl, ', ') FILTER (WHERE other_shops > 0) AS tables_showing_other_shops
  FROM zz_sync_probe GROUP BY who ORDER BY who;
