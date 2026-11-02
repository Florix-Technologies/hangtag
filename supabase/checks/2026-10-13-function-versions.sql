-- Read-only. After the 2026-10-13 repair (the whole supabase/schema.sql of fb62ace): the 18 functions that were older on the
-- live project must have the bodies schema.sql gives them, and the three indexes the first migration put back must be gone.
-- Every row should say ok. (Fingerprint = MD5 of the function body, line endings ignored; read from schema.sql on PostgreSQL 17.)
WITH expected(fn, fp) AS (VALUES
    ('hangtag_access_ok(p_owner uuid)', '2ae48842c0a7c0baa2bdf4ec8606f9d7'),
    ('hangtag_biz_changes()', 'cdee633ea7ae2b5cbdfdc3f88b0044d0'),
    ('hangtag_cap_on(p_owner uuid, p_cap text)', '97a385ae9687f0816b544f332ec75565'),
    ('hangtag_import_stock(p_import jsonb, p_products jsonb, p_variants jsonb, p_moves jsonb, p_allow_duplicate boolean)', '2459d864861028bc4dbbe5a1564d3dfc'),
    ('hangtag_mobile_catalog(p_token text)', 'b21165de194781fb8dbf5c685cfa0d69'),
    ('hangtag_mobile_order_status(p_order_token text)', '31003a987aee2faf3082c631613bc955'),
    ('hangtag_place_mobile_order(p_token text, p_items jsonb, p_customer jsonb, p_checkout_key text, p_note text, p_payment text, p_mode text)', 'c0d094e9bbe158f9f9bee2902f6dc5da'),
    ('hangtag_platform_dashboard()', '22014e75d1b1b79dd0c62e0600ab866b'),
    ('hangtag_platform_permissions(p_role text)', 'e42da56343a38176477dc90914e0a977'),
    ('hangtag_promo_evaluate(p_owner uuid, p_plan text, p_code text)', '766f5f60c342aadc7dd62513f651d4f9'),
    ('hangtag_save_sales(p_bills jsonb)', '5ef0aea6c92fabd52de446e6d92fdcc2'),
    ('hangtag_subscription_activate(p_payment uuid, p_provider_payment text, p_amount numeric)', '146d25d2fb9399d10296ae13e7b9f9ee'),
    ('hangtag_subscription_checkout(p_plan text, p_promo text, p_provider text)', '96862310354cfdc53dcb747b82aaf5e2'),
    ('hangtag_subscription_ensure(p_owner uuid)', 'bd162ea7d34eb620aa4ced0de13248c7'),
    ('hangtag_subscription_plans()', 'bfaa41bba8e92fe5a563179912222d49'),
    ('hangtag_subscription_quote(p_plan text, p_promo text)', '54061f89d83ace72d5358f3151ef9637'),
    ('hangtag_subscription_state(p_owner uuid, p_now timestamp with time zone)', '828c8cd96bd4f3d5685087b07f1ea0ca'),
    ('hangtag_subscription_status()', 'd86a8f29af3608686a30a0ba3f94f050')
)
SELECT e.fn AS object, CASE WHEN f.fp IS NULL THEN 'MISSING' WHEN f.fp = e.fp THEN 'ok' ELSE 'OLDER VERSION' END AS state
  FROM expected e LEFT JOIN (SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS fn, md5(replace(p.prosrc, chr(13), '')) AS fp
                              FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace) f ON f.fn = e.fn
UNION ALL
SELECT 'index ' || i, CASE WHEN to_regclass('public.' || i) IS NULL THEN 'ok' ELSE 'STILL THERE' END
  FROM unnest(ARRAY['idx_hangtag_sale_items_sale', 'idx_hangtag_sales_time', 'idx_hangtag_sizes_prod']) i
ORDER BY 1;
