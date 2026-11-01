-- Read-only. Whether 20261027120000_hangtag_cashfree_readiness.sql is in place. Run it after that migration, and after
-- any run of the post-repair migration (which puts back its own two definitions: the migration must then be run again).
-- Expected: 4 rows, all ok.
SELECT 1 AS n, 'readiness counts Cashfree''s notifications' AS check_name,
       COALESCE((SELECT p.prosrc FROM pg_proc p WHERE p.oid = to_regprocedure('public.hangtag_billing_readiness()')), '') LIKE '%starts_with(e.event_type, ''SUBSCRIPTION_'')%' AS ok
UNION ALL
SELECT 2, 'the registry keeps past_due, gives a resumed mandate its next charge and keeps an ended mandate ended',
       COALESCE((SELECT p.prosrc FROM pg_proc p WHERE p.oid = to_regprocedure('public.hangtag_autopay_report(text, text, text, text, numeric, text, timestamptz, timestamptz, text)')), '')
         LIKE '%WHEN ev = ''authenticated'' AND s.autopay_status = ''past_due'' THEN ''past_due''%'
       AND COALESCE((SELECT p.prosrc FROM pg_proc p WHERE p.oid = to_regprocedure('public.hangtag_autopay_report(text, text, text, text, numeric, text, timestamptz, timestamptz, text)')), '')
         LIKE '%WHEN NOT terminal AND mm.provider_status IN (''cancelled'', ''completed'', ''expired'') THEN mm.provider_status%'
UNION ALL
SELECT 3, 'a cancel the provider couldn''t confirm can be kept owed', to_regprocedure('public.hangtag_autopay_cancel_owed(text, text, text)') IS NOT NULL
UNION ALL
SELECT 4, 'all three are the service role''s only',
       COALESCE((SELECT bool_and(NOT has_function_privilege('anon', f, 'EXECUTE') AND NOT has_function_privilege('authenticated', f, 'EXECUTE'))
                   FROM unnest(ARRAY[to_regprocedure('public.hangtag_billing_readiness()'),
                     to_regprocedure('public.hangtag_autopay_report(text, text, text, text, numeric, text, timestamptz, timestamptz, text)'),
                     to_regprocedure('public.hangtag_autopay_cancel_owed(text, text, text)')]) f WHERE f IS NOT NULL), FALSE)
ORDER BY 1;
