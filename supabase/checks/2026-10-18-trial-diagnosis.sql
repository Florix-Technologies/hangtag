-- Read-only. Why a shop's free trial ended early. Changes nothing; prints counts, and only the one shop asked about.
-- Replace :client_email with the affected client's sign-in email before running (SQL Editor: paste it in quotes).

-- 1. The trial new shops get now, and when it last changed
SELECT code, days, updated_at FROM public.hangtag_plans WHERE code = 'trial';

-- 2. Console edits to plans: when, by which role, before and after (the trial's days included)
SELECT t, actor_role, detail FROM public.hangtag_platform_audit WHERE action = 'plan.update' ORDER BY t DESC LIMIT 20;

-- 3. How long shops' trials were set to, in days (counts only: one line per length)
SELECT round(extract(epoch FROM (trial_ends_at - trial_started_at)) / 86400)::int AS trial_days, count(*) AS shops,
       min(trial_started_at) AS first_started, max(trial_started_at) AS last_started
  FROM public.hangtag_subscriptions GROUP BY 1 ORDER BY 1;

-- 4. The affected shop: when it finished setting up, its trial, any paid period, suspension
SELECT s.owner_id, p.onboarded_at, s.trial_started_at, s.trial_ends_at,
       round(extract(epoch FROM (s.trial_ends_at - s.trial_started_at)) / 86400)::int AS trial_days,
       s.plan_code, s.period_end, s.suspended, public.hangtag_subscription_state(s.owner_id, NOW()) AS state_now
  FROM public.hangtag_subscriptions s
  JOIN public.hangtag_profiles p ON p.id = s.owner_id
  JOIN auth.users u ON u.id = s.owner_id
 WHERE lower(u.email) = lower(:client_email);

-- 5. Console actions on that shop (extend, grant, suspend…): when, by which role, and the reason given
SELECT au.t, au.actor_role, au.action, au.ok, au.detail ->> 'reason' AS reason
  FROM public.hangtag_platform_audit au
  JOIN auth.users u ON au.target_id = u.id::text
 WHERE lower(u.email) = lower(:client_email)
 ORDER BY au.t DESC LIMIT 20;

-- 6. Console staff: is there an active super admin? (counts only)
SELECT role, active, count(*) FROM public.hangtag_platform_staff GROUP BY 1, 2 ORDER BY 1, 2;
