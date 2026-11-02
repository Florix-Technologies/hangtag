-- Read-only. The shop payments migration's report (supabase/migrations/20261023120000_hangtag_shop_payments.sql): run it
-- any time to see whether the migration's changes are all in place — every row ok (the migration itself refuses to commit
-- otherwise). After a run of schema.sql, row 5 reads false until the migration is run again. The same rows as the
-- migration's own report (supabase/tests/shop-payments.test.mjs checks they stay the same).
SELECT check_name, ok FROM (
    SELECT 1 AS n, 'Shop payment accounts: closed to every app account (row security on, no policy, no privilege)' AS check_name,
           COALESCE((SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = to_regclass('public.hangtag_payment_accounts')), FALSE)
           AND NOT EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'hangtag_payment_accounts')
           AND to_regclass('public.hangtag_payment_accounts') IS NOT NULL
           AND NOT has_table_privilege('authenticated', 'public.hangtag_payment_accounts', 'SELECT, INSERT, UPDATE, DELETE')
           AND NOT has_table_privilege('anon', 'public.hangtag_payment_accounts', 'SELECT, INSERT, UPDATE, DELETE') AS ok
    UNION ALL
    SELECT 2, 'Shop payment accounts hold only sealed secrets, one connected account per shop',
           EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conname = 'hangtag_payment_accounts_check' AND pg_get_constraintdef(c.oid) LIKE '%v1%')
           AND EXISTS (SELECT 1 FROM pg_indexes i WHERE i.schemaname = 'public' AND i.indexname = 'hangtag_payment_accounts_connected')
           AND NOT EXISTS (SELECT 1 FROM public.hangtag_payment_accounts a WHERE a.secret_box !~ '^v1\.' OR a.webhook_box !~ '^v1\.')
    UNION ALL
    SELECT 3, 'Every new payment intent names an account of its own shop',
           EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conname = 'hangtag_payment_intents_account_fk' AND c.contype = 'f' AND array_length(c.conkey, 1) = 2)
           AND EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = 'public.hangtag_payment_intents'::regclass AND t.tgname = 'hangtag_intent_account_check')
    UNION ALL
    SELECT 4, 'Provider notifications kept once per account and event; read by the shop only',
           EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid = 'public.hangtag_payment_events'::regclass AND c.contype = 'u')
           AND (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = 'public.hangtag_payment_events'::regclass)
           AND NOT has_table_privilege('authenticated', 'public.hangtag_payment_events', 'INSERT, UPDATE, DELETE')
           AND NOT has_table_privilege('anon', 'public.hangtag_payment_events', 'SELECT, INSERT, UPDATE, DELETE')
    UNION ALL
    SELECT 5, 'UPI confirmed only by the shop, never undone by a bill sent again',
           EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = 'public.hangtag_payments'::regclass AND t.tgname = 'hangtag_keep_payment_state')
           AND 'hangtag_keep_payment_state' < 'hangtag_member_write_check'
           AND EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conname = 'hangtag_payments_verification_check' AND pg_get_constraintdef(c.oid) LIKE '%confirmed%')
           AND EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = to_regprocedure('public.hangtag_confirm_upi_payment(text)') AND p.prosecdef)
           AND has_function_privilege('authenticated', 'public.hangtag_confirm_upi_payment(text)', 'EXECUTE')
           AND NOT has_function_privilege('anon', 'public.hangtag_confirm_upi_payment(text)', 'EXECUTE')
    UNION ALL
    SELECT 6, 'No shop table open to every account (a policy that is always true)',
           NOT EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname = 'public' AND p.permissive = 'PERMISSIVE'
               AND (btrim(COALESCE(p.qual, '')) IN ('true', '(true)') OR btrim(COALESCE(p.with_check, '')) IN ('true', '(true)'))
               AND EXISTS (SELECT 1 FROM information_schema.columns c WHERE c.table_schema = 'public' AND c.table_name = p.tablename AND c.column_name = 'owner_id'))
    UNION ALL
    SELECT 7, 'The new tables wait like every business table while a plan has ended',
           (SELECT count(*) FROM pg_trigger t WHERE t.tgname = 'zz_hangtag_subscription_guard'
               AND t.tgrelid IN ('public.hangtag_payment_accounts'::regclass, 'public.hangtag_payment_events'::regclass)) = 2
) r ORDER BY n;
