-- The hourly billing reconciliation (supabase/functions/subscription/reconcile.js), scheduled inside the project: pg_cron
-- runs a job at minute 7 of every hour that POSTs to the subscription-webhook function through pg_net, as Supabase's
-- "Scheduling Edge Functions" guide does. Its two values are kept in Supabase Vault, never in this file, the repository or
-- the job's text (the job reads them by name each time it runs):
--   hangtag_reconcile_url     https://<project-ref>.supabase.co/functions/v1/subscription-webhook
--   hangtag_reconcile_secret  the same value as the function secret SUBSCRIPTION_RECONCILE_SECRET (32 characters or more)
-- Before it (CASHFREE_RELEASE_READINESS.md, the deployment): the post-repair migration; the subscription-webhook function
-- deployed with SUBSCRIPTION_RECONCILE_SECRET; pg_cron (Dashboard → Integrations → Cron) and pg_net (Database →
-- Extensions) enabled; both Vault secrets added (Dashboard → Project Settings → Vault, so the value isn't typed into a
-- query). Run once per project in the SQL Editor, as postgres. Safe to run again: the job is replaced, never doubled.
-- Refuses, changing nothing, when anything above is missing. Undo: supabase/operations/billing-reconcile-schedule-undo.sql.
-- Each run: "x-hangtag-reconcile: 1" and "Authorization: Bearer <secret>"; the function answers 401 to anything else, 503
-- when its own secret is unset, "busy" within 5 minutes of the last run, and records every run in
-- hangtag_billing_reconcile_runs. pg_net waits up to 120 s for the answer (the function's own budget is 300 provider calls).
-- Watched by: the console's billing health (the last 5 runs; readiness says "no complete reconciliation in 26 hours" and
-- AutoPay is then no longer offered to new shops), and supabase/checks/reconcile-schedule-health.sql (read-only: the job,
-- its last runs, the function's last answers, the last complete run).
DO $$
BEGIN
    IF to_regclass('cron.job') IS NULL THEN
        RAISE EXCEPTION 'pg_cron is not enabled: Dashboard → Integrations → Cron, then run this again.';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'net' AND p.proname = 'http_post') THEN
        RAISE EXCEPTION 'pg_net is not enabled: Database → Extensions → pg_net, then run this again.';
    END IF;
    IF to_regclass('vault.decrypted_secrets') IS NULL THEN
        RAISE EXCEPTION 'Supabase Vault is not available on this database.';
    END IF;
    IF to_regprocedure('public.hangtag_billing_reconcile_begin(integer, text)') IS NULL THEN
        RAISE EXCEPTION 'Run the post-repair migration first: hangtag_billing_reconcile_begin is missing.';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM vault.decrypted_secrets s WHERE s.name = 'hangtag_reconcile_url'
                    AND s.decrypted_secret ~ '^https://[A-Za-z0-9.-]+/functions/v1/subscription-webhook$') THEN
        RAISE EXCEPTION 'Vault secret hangtag_reconcile_url is missing, or is not https://<project>/functions/v1/subscription-webhook.';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM vault.decrypted_secrets s WHERE s.name = 'hangtag_reconcile_secret' AND length(s.decrypted_secret) >= 32) THEN
        RAISE EXCEPTION 'Vault secret hangtag_reconcile_secret is missing or shorter than 32 characters (it must equal SUBSCRIPTION_RECONCILE_SECRET).';
    END IF;
    PERFORM cron.unschedule('hangtag-billing-reconcile') WHERE EXISTS (SELECT 1 FROM cron.job j WHERE j.jobname = 'hangtag-billing-reconcile');
    PERFORM cron.schedule('hangtag-billing-reconcile', '7 * * * *', $job$
SELECT net.http_post(
    url := (SELECT s.decrypted_secret FROM vault.decrypted_secrets s WHERE s.name = 'hangtag_reconcile_url'),
    body := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-hangtag-reconcile', '1',
        'Authorization', 'Bearer ' || (SELECT s.decrypted_secret FROM vault.decrypted_secrets s WHERE s.name = 'hangtag_reconcile_secret')),
    timeout_milliseconds := 120000) AS request_id;
$job$);
END $$;
SELECT j.jobname, j.schedule, j.active FROM cron.job j WHERE j.jobname = 'hangtag-billing-reconcile';
