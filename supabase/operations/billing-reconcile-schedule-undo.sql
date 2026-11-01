-- Undo of billing-reconcile-schedule.sql: the hourly job removed (nothing else changes; safe to run again). The two Vault
-- secrets stay until removed in Dashboard → Project Settings → Vault. Without the job, no AutoPay charge is asked for and
-- readiness turns false within 26 hours, so AutoPay is no longer offered: turn it off in the console first if that's intended.
SELECT cron.unschedule('hangtag-billing-reconcile') FROM cron.job j WHERE j.jobname = 'hangtag-billing-reconcile';
SELECT count(*) = 0 AS removed FROM cron.job j WHERE j.jobname = 'hangtag-billing-reconcile';
