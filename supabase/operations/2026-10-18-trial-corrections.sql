-- WRITES: run only with the owner's approval of this exact operation, naming the shops (2026-10-18). First run
-- supabase/checks/2026-10-18-trial-audit.sql: part 8 lists the shops below the standard and why, part 9 the "owed" ones as
-- a list to paste below. Only the shops listed here change, and only those still "owed" by part 8's rule: each one's trial
-- then ends 30 days after it started (start + 30 days) — the entitlement, nothing more. No list, nothing changes: there
-- is no "every shop". Never shortens a trial; never touches a shop with a paid period, AutoPay, a suspension, a 0-day
-- trial (its email had already had one) or whose 30 days from its start have passed; no shop's own data. Changes nothing
-- unless "actor" is an active console super admin. One statement (all or nothing), audited as the console's Extend is
-- (customer.extend: who, the shop, the reason, before and after). One row back per shop changed; a second run, none.
-- Fill in "input": your account ID, and the account IDs of the shops you approve (part 9's list, or fewer).
WITH input AS (
    SELECT '<your account ID>'::uuid AS actor,                    -- the super admin approving this (from /platform/ or part 7)
           ARRAY['<shop account ID>']::uuid[] AS only_shops,       -- the shops approved, e.g. part 9's list
           30 AS standard_days,
           'Trial set shorter than the 30-day standard: corrected to 30 days from its start (2026-10-18)'::text AS reason
),
guard AS (
    SELECT i.* FROM input i
      JOIN public.hangtag_platform_staff st ON st.user_id = i.actor AND st.active AND st.role = 'super_admin'
),
before AS (
    SELECT s.owner_id, s.trial_ends_at FROM public.hangtag_subscriptions s
),
changed AS (
    UPDATE public.hangtag_subscriptions s
       SET trial_ends_at = s.trial_started_at + make_interval(days => g.standard_days), updated_at = NOW()
      FROM guard g
     WHERE s.period_end IS NULL
       AND NOT s.suspended
       AND COALESCE(s.autopay_status, 'none') NOT IN ('pending', 'active', 'past_due')
       AND s.trial_ends_at > s.trial_started_at
       AND s.trial_ends_at < s.trial_started_at + make_interval(days => g.standard_days)
       AND s.trial_started_at + make_interval(days => g.standard_days) > NOW()
       AND s.owner_id = ANY (g.only_shops)
    RETURNING s.owner_id, s.trial_ends_at AS new_end, g.actor, g.reason
),
logged AS (
    INSERT INTO public.hangtag_platform_audit (actor, actor_role, action, target_type, target_id, detail, ok)
    SELECT c.actor, 'super_admin', 'customer.extend', 'shop', c.owner_id::text,
           jsonb_build_object('outcome', 'done', 'reason', c.reason, 'via', 'sql', 'extended', 'trial',
                              'before', jsonb_build_object('trial_ends_at', b.trial_ends_at),
                              'after', jsonb_build_object('trial_ends_at', c.new_end)), TRUE
      FROM changed c JOIN before b ON b.owner_id = c.owner_id
    RETURNING target_id
)
SELECT c.owner_id AS account_id, p.shop_name, b.trial_ends_at AS trial_ended_at_before, c.new_end AS trial_now_ends_at,
       round((extract(epoch FROM (c.new_end - GREATEST(b.trial_ends_at, NOW()))) / 86400)::numeric, 1) AS days_of_access_from_now
  FROM changed c
  JOIN before b ON b.owner_id = c.owner_id
  LEFT JOIN public.hangtag_profiles p ON p.id = c.owner_id
 ORDER BY c.new_end;
