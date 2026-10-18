-- Read-only (2026-10-18): the free trial and the console, in one result. A single SELECT: it reads tables and calls one
-- STABLE function (which Postgres doesn't let write). Run it whole in the SQL Editor: it returns one table, which is all
-- the editor shows. Change only the two emails in "input" first.
-- Rows (part · detail):
--   1 the trial new shops get now              5 console actions on the client's shop (none: no rows)
--   2 console edits to the trial plan (none: no rows)   6 console staff, counts by role
--   3 trial lengths, counts by days            7 your account's console role
--   4 the client's account and trial           8 every shop below the standard: its verdict and the days it is owed
--   9 the "owed" shops as a list for supabase/operations/2026-10-18-trial-corrections.sql (review part 8 first)
-- Owed = days until "trial start + the standard" counted from its trial end or now, whichever is later (as the console's
-- Extend counts them), rounded up. A shop whose standard days have already passed is owed nothing; more is a goodwill
-- decision. (2026-10-18-trial-diagnosis.sql asks 1-6 one query at a time.)
WITH input AS (
    SELECT lower(btrim('client@example.com')) AS client_email,   -- the affected client's sign-in email
           lower(btrim('owner@example.com'))  AS owner_email,    -- your own sign-in email
           30 AS standard_days,                                    -- the free trial's standard, from 2026-10-18
           NOW() AS now_
),
shops AS (
    SELECT s.owner_id, pr.shop_name, pr.onboarded_at, s.trial_started_at, s.trial_ends_at, s.plan_code, s.period_end,
           s.suspended, s.autopay_status, s.updated_at,
           round(extract(epoch FROM (s.trial_ends_at - s.trial_started_at)) / 86400)::int AS trial_days
      FROM public.hangtag_subscriptions s
      LEFT JOIN public.hangtag_profiles pr ON pr.id = s.owner_id
),
judged AS (
    SELECT j.*, CASE WHEN j.verdict = 'owed'
                     THEN ceil(extract(epoch FROM (j.entitled_end - GREATEST(j.trial_ends_at, j.now_))) / 86400)::int END AS extend_days
      FROM (SELECT sh.*, i.now_, sh.trial_started_at + make_interval(days => i.standard_days) AS entitled_end,
                   CASE
                     WHEN sh.period_end IS NOT NULL THEN 'has a paid period: the trial no longer decides access'
                     WHEN sh.trial_days = 0 THEN 'no trial: this email (or its Gmail form) had already had one; nothing owed'
                     WHEN sh.trial_days >= i.standard_days THEN 'ok'
                     WHEN sh.suspended THEN 'suspended: decide that first'
                     WHEN sh.autopay_status IN ('pending', 'active', 'past_due') THEN 'AutoPay is set up: Extend is refused; give a plan instead'
                     WHEN sh.trial_started_at + make_interval(days => i.standard_days) <= i.now_
                       THEN 'its ' || i.standard_days || ' days from the start have passed: nothing owed (more is a goodwill decision)'
                     ELSE 'owed'
                   END AS verdict
              FROM shops sh CROSS JOIN input i) j
),
acts AS (
    SELECT a.target_id, count(*) FILTER (WHERE a.ok) AS n
      FROM public.hangtag_platform_audit a WHERE a.target_type = 'shop' GROUP BY a.target_id
)
SELECT part, detail FROM (
    SELECT '1 trial new shops get' AS part, 0::bigint AS k,
           jsonb_build_object('days', p.days, 'standard', i.standard_days, 'meets_standard', COALESCE(p.days >= i.standard_days, FALSE),
                              'last_changed', p.updated_at) AS detail
      FROM input i LEFT JOIN public.hangtag_plans p ON p.code = 'trial'
    UNION ALL
    SELECT '2 console edits to the trial plan', row_number() OVER (ORDER BY a.t DESC),
           jsonb_build_object('when', a.t, 'role', a.actor_role, 'ok', a.ok, 'days_before', a.detail -> 'before' -> 'days', 'days_after', a.detail -> 'after' -> 'days')
      FROM public.hangtag_platform_audit a WHERE a.action = 'plan.update' AND a.target_id = 'trial'
    UNION ALL
    SELECT '3 trial lengths', sh.trial_days,
           jsonb_build_object('trial_days', sh.trial_days, 'shops', count(*), 'first_started', min(sh.trial_started_at), 'last_started', max(sh.trial_started_at))
      FROM shops sh GROUP BY sh.trial_days
    UNION ALL
    SELECT '4 the client', 0,
           CASE WHEN u.id IS NULL THEN jsonb_build_object('found', FALSE, 'note', 'no Hangtag account has this email')
                WHEN j.owner_id IS NOT NULL THEN jsonb_build_object('found', TRUE, 'account_id', j.owner_id, 'shop', j.shop_name,
                     'onboarded_at', j.onboarded_at, 'trial_started_at', j.trial_started_at, 'trial_ends_at', j.trial_ends_at,
                     'trial_days', j.trial_days, 'record_last_changed', j.updated_at, 'plan', j.plan_code, 'paid_until', j.period_end,
                     'suspended', j.suspended, 'autopay', j.autopay_status, 'state_now', public.hangtag_subscription_state(j.owner_id, i.now_),
                     'verdict', j.verdict, 'entitled_end', j.entitled_end, 'extend_days', j.extend_days)
                WHEN m.user_id IS NOT NULL THEN jsonb_build_object('found', TRUE, 'note', 'a team member: access follows the shop owner''s trial or plan',
                     'shop_owner_id', m.shop_id, 'member_status', m.status, 'shop_trial_ends_at', o.trial_ends_at, 'shop_verdict', o.verdict,
                     'shop_extend_days', o.extend_days)
                ELSE jsonb_build_object('found', TRUE, 'account_id', u.id, 'note', 'has not finished setting up a shop: no trial yet') END
      FROM input i LEFT JOIN auth.users u ON lower(u.email) = i.client_email
      LEFT JOIN judged j ON j.owner_id = u.id
      LEFT JOIN public.hangtag_members m ON m.user_id = u.id
      LEFT JOIN judged o ON o.owner_id = m.shop_id
    UNION ALL
    SELECT '5 console actions on the client''s shop', row_number() OVER (ORDER BY a.t DESC),
           jsonb_build_object('when', a.t, 'role', a.actor_role, 'action', a.action, 'ok', a.ok, 'reason', a.detail ->> 'reason')
      FROM input i JOIN auth.users u ON lower(u.email) = i.client_email
      JOIN public.hangtag_platform_audit a ON a.target_id = u.id::text
    UNION ALL
    SELECT '6 console staff', count(*), jsonb_build_object('role', st.role, 'active', st.active, 'people', count(*))
      FROM public.hangtag_platform_staff st GROUP BY st.role, st.active
    UNION ALL
    SELECT '7 your console role', 0,
           CASE WHEN u.id IS NULL THEN jsonb_build_object('account_found', FALSE, 'note', 'no Hangtag account has this email: sign in to Hangtag once first')
                WHEN st.user_id IS NULL THEN jsonb_build_object('account_found', TRUE, 'account_id', u.id, 'console_role', NULL, 'note', 'not on the console team')
                ELSE jsonb_build_object('account_found', TRUE, 'account_id', u.id, 'console_role', st.role, 'active', st.active,
                     'note', CASE WHEN st.active AND st.role = 'super_admin' THEN 'super admin: the whole console'
                                  WHEN st.active THEN 'on the console team, not a super admin' ELSE 'on the team but switched off' END) END
      FROM input i LEFT JOIN auth.users u ON lower(u.email) = i.owner_email
      LEFT JOIN public.hangtag_platform_staff st ON st.user_id = u.id
    UNION ALL
    SELECT '8 shops below the standard', row_number() OVER (ORDER BY j.verdict <> 'owed', j.trial_started_at),
           jsonb_build_object('account_id', j.owner_id, 'shop', j.shop_name, 'trial_started_at', j.trial_started_at, 'trial_ends_at', j.trial_ends_at,
                              'trial_days', j.trial_days, 'entitled_end', j.entitled_end, 'verdict', j.verdict, 'extend_days', j.extend_days,
                              'console_actions', COALESCE(ac.n, 0))
      FROM judged j LEFT JOIN acts ac ON ac.target_id = j.owner_id::text
     WHERE j.verdict <> 'ok' AND j.period_end IS NULL
    UNION ALL
    SELECT '9 owed shops, as a list', 0,
           jsonb_build_object('shops', count(*),
                              'only_shops', 'ARRAY[' || COALESCE(string_agg(quote_literal(j.owner_id::text), ', ' ORDER BY j.trial_started_at), '') || ']::uuid[]')
      FROM judged j WHERE j.verdict = 'owed'
) r
ORDER BY part, k;
