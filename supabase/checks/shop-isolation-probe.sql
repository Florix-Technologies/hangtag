-- Shop isolation on the six tables reopened on 2026-10-13 (hangtag_meta, _sales, _sale_items, _products, _images, _sizes),
-- acting as two real shop owners (A, B: the first two shops with saved settings; no id is printed). Each check runs in a
-- sub-transaction that is always rolled back (the role switch too), so nothing it does stays: reads count rows; writes try
-- one row of the other shop by its physical address (at most one row each) and are undone whatever they did. Results go
-- to a temporary table that vanishes with the session. Expected: other shops' rows visible 0; change/delete of the other
-- shop blocked (0 rows); adding a row as the other shop blocked by row security (42501); changing an own row works.
-- Run it as the database owner (SQL Editor, or supabase db query --linked).
CREATE TEMP TABLE IF NOT EXISTS zz_probe_result (who text, tbl text, probe text, result text);
TRUNCATE zz_probe_result;
DO $probe$
DECLARE
  shops uuid[]; me uuid; other uuid; t text; n bigint; m bigint; res text; c_other tid; c_own tid; j jsonb; pk text[]; col text;
  six text[] := ARRAY['hangtag_meta','hangtag_sales','hangtag_sale_items','hangtag_products','hangtag_images','hangtag_sizes'];
  writes boolean := true;
  pass int;
BEGIN
  SELECT array_agg(owner_id ORDER BY owner_id) INTO shops FROM (SELECT DISTINCT owner_id FROM public.hangtag_meta WHERE key = 'settings' AND owner_id IS NOT NULL ORDER BY owner_id LIMIT 2) s;
  IF COALESCE(array_length(shops, 1), 0) < 2 THEN INSERT INTO zz_probe_result VALUES ('-', '-', 'two shops', 'not found'); RETURN; END IF;
  FOR pass IN 1..2 LOOP
    me := shops[pass]; other := shops[3 - pass];
    FOREACH t IN ARRAY six LOOP
      -- what the database owner sees (counts only), and one row of each shop to aim the writes at
      EXECUTE format('SELECT ctid FROM public.%I WHERE owner_id = $1 LIMIT 1', t) INTO c_other USING other;
      EXECUTE format('SELECT ctid FROM public.%I WHERE owner_id = $1 LIMIT 1', t) INTO c_own USING me;
      EXECUTE format('SELECT to_jsonb(x) FROM public.%I x WHERE owner_id = $1 LIMIT 1', t) INTO j USING other;
      -- reads, as `me`
      BEGIN
        PERFORM set_config('request.jwt.claim.sub', me::text, true);
        PERFORM set_config('request.jwt.claims', json_build_object('sub', me, 'role', 'authenticated')::text, true);
        PERFORM set_config('request.headers', '{}', true);
        SET LOCAL ROLE authenticated;
        EXECUTE format('SELECT count(*) FROM public.%I WHERE owner_id <> $1', t) INTO n USING me;
        EXECUTE format('SELECT count(*) FROM public.%I WHERE owner_id = $1', t) INTO m USING me;
        res := 'other shops'' rows visible: ' || n || '; own rows visible: ' || m;
        RAISE EXCEPTION USING ERRCODE = 'ZZ001';
      EXCEPTION WHEN SQLSTATE 'ZZ001' THEN NULL; WHEN OTHERS THEN res := 'read error ' || SQLSTATE;
      END;
      INSERT INTO zz_probe_result VALUES (CASE pass WHEN 1 THEN 'A' ELSE 'B' END, t, '1 read', res);
      CONTINUE WHEN NOT writes;
      -- change one of the other shop's rows (a no-op change), as `me`
      res := 'the other shop has no row here';
      IF c_other IS NOT NULL THEN BEGIN
        PERFORM set_config('request.jwt.claim.sub', me::text, true);
        PERFORM set_config('request.jwt.claims', json_build_object('sub', me, 'role', 'authenticated')::text, true);
        PERFORM set_config('request.headers', '{}', true);
        SET LOCAL ROLE authenticated;
        EXECUTE format('UPDATE public.%I SET owner_id = owner_id WHERE ctid = $1', t) USING c_other; GET DIAGNOSTICS n = ROW_COUNT;
        res := CASE WHEN n = 0 THEN 'blocked (0 rows)' ELSE 'ALLOWED (' || n || ' row)' END;
        RAISE EXCEPTION USING ERRCODE = 'ZZ001';
      EXCEPTION WHEN SQLSTATE 'ZZ001' THEN NULL; WHEN OTHERS THEN res := 'refused ' || SQLSTATE;
      END; END IF;
      INSERT INTO zz_probe_result VALUES (CASE pass WHEN 1 THEN 'A' ELSE 'B' END, t, '2 change other shop', res);
      -- delete one of the other shop's rows, as `me`
      res := 'the other shop has no row here';
      IF c_other IS NOT NULL THEN BEGIN
        PERFORM set_config('request.jwt.claim.sub', me::text, true);
        PERFORM set_config('request.jwt.claims', json_build_object('sub', me, 'role', 'authenticated')::text, true);
        PERFORM set_config('request.headers', '{}', true);
        SET LOCAL ROLE authenticated;
        EXECUTE format('DELETE FROM public.%I WHERE ctid = $1', t) USING c_other; GET DIAGNOSTICS n = ROW_COUNT;
        res := CASE WHEN n = 0 THEN 'blocked (0 rows)' ELSE 'ALLOWED (' || n || ' row)' END;
        RAISE EXCEPTION USING ERRCODE = 'ZZ001';
      EXCEPTION WHEN SQLSTATE 'ZZ001' THEN NULL; WHEN OTHERS THEN res := 'refused ' || SQLSTATE;
      END; END IF;
      INSERT INTO zz_probe_result VALUES (CASE pass WHEN 1 THEN 'A' ELSE 'B' END, t, '3 delete other shop', res);
      -- add a row naming the other shop (a copy of one of its rows under a new key), as `me`
      res := 'the other shop has no row here';
      IF j IS NOT NULL THEN
        SELECT array_agg(a.attname::text) INTO pk FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
         WHERE i.indrelid = ('public.' || t)::regclass AND i.indisprimary;
        FOREACH col IN ARRAY COALESCE(pk, ARRAY[]::text[]) LOOP
          CONTINUE WHEN col = 'owner_id';
          j := jsonb_set(j, ARRAY[col], CASE jsonb_typeof(j -> col)
            WHEN 'number' THEN to_jsonb((j ->> col)::numeric + 1000000000)
            ELSE CASE WHEN (j ->> col) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-' THEN to_jsonb(gen_random_uuid()::text) ELSE to_jsonb((j ->> col) || '-zzprobe') END END);
        END LOOP;
        BEGIN
          PERFORM set_config('request.jwt.claim.sub', me::text, true);
          PERFORM set_config('request.jwt.claims', json_build_object('sub', me, 'role', 'authenticated')::text, true);
          PERFORM set_config('request.headers', '{}', true);
          SET LOCAL ROLE authenticated;
          EXECUTE format('INSERT INTO public.%I SELECT * FROM jsonb_populate_record(NULL::public.%I, $1)', t, t) USING j;
          res := 'ALLOWED (row added)';
          RAISE EXCEPTION USING ERRCODE = 'ZZ001';
        EXCEPTION WHEN SQLSTATE 'ZZ001' THEN NULL;
          WHEN insufficient_privilege THEN res := 'blocked by row security (' || SQLSTATE || ')';
          WHEN OTHERS THEN res := 'refused ' || SQLSTATE;
        END;
      END IF;
      INSERT INTO zz_probe_result VALUES (CASE pass WHEN 1 THEN 'A' ELSE 'B' END, t, '4 add as other shop', res);
      -- change one of its own rows (a no-op change), as `me`: the shop's own writes still work
      res := 'this shop has no row here';
      IF c_own IS NOT NULL THEN BEGIN
        PERFORM set_config('request.jwt.claim.sub', me::text, true);
        PERFORM set_config('request.jwt.claims', json_build_object('sub', me, 'role', 'authenticated')::text, true);
        PERFORM set_config('request.headers', '{}', true);
        SET LOCAL ROLE authenticated;
        EXECUTE format('UPDATE public.%I SET owner_id = owner_id WHERE ctid = $1', t) USING c_own; GET DIAGNOSTICS n = ROW_COUNT;
        res := CASE WHEN n = 1 THEN 'works (1 row)' ELSE 'NOT ALLOWED (' || n || ' rows)' END;
        RAISE EXCEPTION USING ERRCODE = 'ZZ001';
      EXCEPTION WHEN SQLSTATE 'ZZ001' THEN NULL; WHEN OTHERS THEN res := 'refused ' || SQLSTATE;
      END; END IF;
      INSERT INTO zz_probe_result VALUES (CASE pass WHEN 1 THEN 'A' ELSE 'B' END, t, '5 change own row', res);
    END LOOP;
  END LOOP;
END $probe$;
SELECT who, tbl, probe, result FROM zz_probe_result ORDER BY who, tbl, probe;
