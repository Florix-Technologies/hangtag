-- The billing reconciliation's schedule, read-only (SQL Editor, as postgres): the job; its last 5 runs as pg_cron saw
-- them; the last 5 answers pg_net received (every pg_net request of the project, newest first: the reconcile's body reads
-- {"ok":true,"run_id":…,"complete":true,…}); the last complete run as the database recorded it. Healthy: the job active
-- at "7 * * * *", its runs "succeeded", answers 200 with "ok":true, the last complete run under 2 hours ago (readiness
-- turns false at 26).
SELECT 1 AS n, 'job' AS what, jsonb_build_object('schedule', j.schedule, 'active', j.active) AS detail
  FROM cron.job j WHERE j.jobname = 'hangtag-billing-reconcile'
UNION ALL
SELECT 2, 'cron run', jsonb_build_object('status', d.status, 'started', d.start_time, 'ended', d.end_time, 'message', left(d.return_message, 120))
  FROM (SELECT x.status, x.start_time, x.end_time, x.return_message FROM cron.job_run_details x
         WHERE x.jobid = (SELECT j.jobid FROM cron.job j WHERE j.jobname = 'hangtag-billing-reconcile') ORDER BY x.start_time DESC LIMIT 5) d
UNION ALL
SELECT 3, 'function answer', jsonb_build_object('status', r.status_code, 'at', r.created, 'timed_out', r.timed_out, 'error', left(r.error_msg, 120), 'body', left(r.content, 200))
  FROM (SELECT x.status_code, x.created, x.timed_out, x.error_msg, x.content FROM net._http_response x ORDER BY x.created DESC LIMIT 5) r
UNION ALL
SELECT 4, 'last complete run', jsonb_build_object('started_at', max(x.started_at), 'hours_ago', round((EXTRACT(EPOCH FROM (NOW() - max(x.started_at))) / 3600)::NUMERIC, 1))
  FROM public.hangtag_billing_reconcile_runs x WHERE x.ok AND x.complete
ORDER BY 1;
