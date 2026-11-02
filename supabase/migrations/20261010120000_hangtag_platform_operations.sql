-- Hangtag: the Platform Console’s customers, subscriptions, payments and the audited actions on a shop (Phase 56).
-- Exactly section 3x of supabase/schema.sql. Needs section 3w (20261009120000_hangtag_plans_autopay_platform.sql) first.
-- Requires: supabase/schema.sql (applied first)
-- Run it in the Supabase SQL Editor; safe to run again. Then the report at the end of schema.sql: rows 87-89.

-- ==============================================================================
-- 3x. The Platform Console: customers, subscriptions, payments and the actions on a shop (Phase 56)
--   Read from the shops' own records: the owner's profile, the plan (hangtag_subscriptions: the state machine, and AutoPay,
--   which only the provider's webhooks move), the plan payments, the catalog, the stock ledger, bills, messages and webhooks.
--   Nothing is copied for the console. Every list and detail is a console function that checks the caller's console role in
--   the database first; each tab of a shop's page also needs its own section's permission (inventory, messages, errors…).
--   The actions on a shop (suspend, restore, give a plan, extend the trial or the plan, end every sign-in) go through one
--   function, hangtag_platform_customer_action. It checks the action's own permission in the database (the console only
--   hides the buttons). It shows the exact consequence first: the action is done and rolled back, so nothing changes. It
--   needs a reason. It writes who did it, to which shop, the action, the state before and after, the reason and the outcome
--   to the console's audit log, for a refused or a failed attempt too. Nothing is deleted. Hangtag keeps no wallet or
--   referral ledger yet: those tabs say so instead of showing made-up figures. Safe to run again.
-- ==============================================================================

-- What each role may do (3w), now with suspending and restoring a shop (admins) and ending its sign-ins (support too)
CREATE OR REPLACE FUNCTION public.hangtag_platform_permissions(p_role TEXT)
RETURNS TEXT[] LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
    SELECT CASE p_role
        WHEN 'super_admin' THEN ARRAY['dashboard.view', 'customers.view', 'customers.suspend', 'customers.sessions', 'subscriptions.view', 'subscriptions.manage',
            'payments.view', 'promotions.view', 'promotions.manage', 'plans.manage', 'referrals.view', 'wallet.view', 'communications.view', 'health.view',
            'inventory.view', 'diagnostics.view', 'growth.view', 'employees.view', 'incentives.view', 'reports.view', 'audit.view', 'settings.view',
            'settings.manage', 'staff.manage']
        WHEN 'admin' THEN ARRAY['dashboard.view', 'customers.view', 'customers.suspend', 'customers.sessions', 'subscriptions.view', 'subscriptions.manage',
            'payments.view', 'promotions.view', 'promotions.manage', 'plans.manage', 'referrals.view', 'wallet.view', 'communications.view', 'health.view',
            'inventory.view', 'diagnostics.view', 'growth.view', 'employees.view', 'incentives.view', 'reports.view', 'audit.view', 'settings.view', 'staff.manage']
        WHEN 'billing_admin' THEN ARRAY['dashboard.view', 'customers.view', 'subscriptions.view', 'subscriptions.manage', 'payments.view', 'promotions.view',
            'promotions.manage', 'plans.manage', 'referrals.view', 'wallet.view', 'incentives.view', 'reports.view']
        WHEN 'support_admin' THEN ARRAY['dashboard.view', 'customers.view', 'customers.sessions', 'subscriptions.view', 'payments.view', 'communications.view',
            'health.view', 'inventory.view', 'diagnostics.view']
        WHEN 'read_only' THEN ARRAY['dashboard.view', 'customers.view', 'subscriptions.view', 'payments.view', 'promotions.view', 'health.view',
            'growth.view', 'reports.view']
        ELSE ARRAY[]::TEXT[] END;
$$;
-- (end of the role permissions)

-- (internal) A shop's lifecycle, in the same words its owner sees (hangtag_subscription_status)
CREATE OR REPLACE FUNCTION public.hangtag_platform_lifecycle(p_state TEXT, p_autopay TEXT, p_trial_ends TIMESTAMPTZ, p_ending_days INT, p_now TIMESTAMPTZ)
RETURNS TEXT LANGUAGE sql STABLE SET search_path = '' AS $$
    SELECT CASE
        WHEN p_state = 'suspended' THEN 'suspended'
        WHEN p_state = 'trial_setup' THEN 'autopay_required'
        WHEN p_state = 'trial_active' THEN CASE WHEN p_autopay = 'cancelled' THEN 'cancelled'
            WHEN p_trial_ends - p_now <= make_interval(days => COALESCE(p_ending_days, 3)) THEN 'trial_ending' ELSE 'trial' END
        WHEN p_state = 'paid_active' THEN CASE WHEN p_autopay = 'cancelled' THEN 'cancelled' WHEN p_autopay = 'past_due' THEN 'past_due' ELSE 'active' END
        WHEN p_state = 'renewal_due' THEN CASE WHEN p_autopay = 'past_due' THEN 'past_due' ELSE 'renewing' END
        WHEN p_state IN ('trial_expired', 'paid_expired') THEN CASE WHEN p_autopay = 'halted' THEN 'halted' ELSE 'expired' END
        ELSE COALESCE(p_state, 'none') END
$$;

-- (internal) Whether a shop is in one of the console's lists. One definition serves the dashboard's counts and the lists
-- they open, so a count and its list always agree:
--   trial (a trial running, or waiting for AutoPay) · active (a paid plan running, or AutoPay collecting its renewal) ·
--   payment_failed (AutoPay failing or stopped, or the latest plan payment of the last 30 days failed) · past_due (AutoPay
--   retrying) · cancelled (AutoPay turned off) · expiring (access ends within 7 days and AutoPay won't renew it) · expired ·
--   suspended · inactive (not used for 30 days, or never) · all
CREATE OR REPLACE FUNCTION public.hangtag_platform_in_list(p_list TEXT, p_state TEXT, p_autopay TEXT, p_access_until TIMESTAMPTZ,
    p_last_active TIMESTAMPTZ, p_payment_failed BOOLEAN, p_now TIMESTAMPTZ)
RETURNS BOOLEAN LANGUAGE sql STABLE SET search_path = '' AS $$
    SELECT COALESCE(CASE COALESCE(p_list, 'all')
        WHEN 'all' THEN TRUE
        WHEN 'trial' THEN p_state IN ('trial_active', 'trial_setup')
        WHEN 'active' THEN p_state IN ('paid_active', 'renewal_due')
        WHEN 'payment_failed' THEN COALESCE(p_autopay, 'none') IN ('past_due', 'halted') OR COALESCE(p_payment_failed, FALSE)
        WHEN 'past_due' THEN COALESCE(p_autopay, 'none') = 'past_due'
        WHEN 'cancelled' THEN COALESCE(p_autopay, 'none') = 'cancelled'
        WHEN 'expiring' THEN p_state IN ('trial_active', 'paid_active') AND p_access_until <= p_now + interval '7 days' AND COALESCE(p_autopay, 'none') <> 'active'
        WHEN 'expired' THEN p_state IN ('trial_expired', 'paid_expired')
        WHEN 'suspended' THEN p_state = 'suspended'
        WHEN 'inactive' THEN p_last_active IS NULL OR p_last_active < p_now - interval '30 days'
        ELSE FALSE END, FALSE)
$$;

-- (internal) Whether a shop matches the console's search (lower-cased): its name, its owner's name, email, GSTIN, phone (by
-- its digits) or account id (from its start)
CREATE OR REPLACE FUNCTION public.hangtag_platform_matches(p_q TEXT, p_id UUID, p_shop TEXT, p_owner TEXT, p_email TEXT, p_phone TEXT, p_gstin TEXT)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
    SELECT COALESCE(p_q, '') = ''
        OR strpos(lower(COALESCE(p_shop, '')), p_q) > 0 OR strpos(lower(COALESCE(p_owner, '')), p_q) > 0
        OR strpos(lower(COALESCE(p_email, '')), p_q) > 0 OR strpos(lower(COALESCE(p_gstin, '')), p_q) > 0
        OR (char_length(p_q) >= 4 AND strpos(COALESCE(p_id::TEXT, ''), p_q) = 1)
        OR (regexp_replace(p_q, '[[:space:]+().-]', '', 'g') ~ '^[0-9]{3,}$'
            AND strpos(regexp_replace(COALESCE(p_phone, ''), '[^0-9]', '', 'g'), regexp_replace(p_q, '[^0-9]', '', 'g')) > 0)
$$;

-- (internal) A plan payment's state as the console shows it: pending (checkout open) · captured (the provider has the money)
-- · granted (given from the console or the SQL Editor, no money) · free (an offer took the price to nothing) · failed ·
-- cancelled · expired
CREATE OR REPLACE FUNCTION public.hangtag_platform_pay_status(p_status TEXT, p_captured TIMESTAMPTZ, p_provider TEXT)
RETURNS TEXT LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
    SELECT CASE p_status WHEN 'created' THEN 'pending'
        WHEN 'paid' THEN CASE WHEN p_captured IS NOT NULL THEN 'captured' WHEN p_provider = 'manual' THEN 'granted' ELSE 'free' END
        ELSE p_status END
$$;

-- (internal) Every shop as the console lists it (or the one shop asked for), from the shop's own records:
--   the owner (name, email, phone, GSTIN) and its plan (the state machine's state, the lifecycle its owner sees, when its
--   access ends, AutoPay);
--   when it was last used (a bill, a catalog or stock change, a customer saved, a team member or phone seen);
--   its catalog and stock (the stock ledger, less what was sold, plus returns put back);
--   its problems of the last 30 days (failed messages, webhooks and plan payments) and the money it paid (captured only).
-- A team member's account is not a shop. Neither is a console account that never set up a shop.
CREATE OR REPLACE FUNCTION public.hangtag_platform_shop_rows(p_owner UUID DEFAULT NULL)
RETURNS TABLE (owner_id UUID, shop_name TEXT, owner_name TEXT, email TEXT, phone TEXT, gstin TEXT, city TEXT, joined_at TIMESTAMPTZ,
    onboarded BOOLEAN, state TEXT, lifecycle TEXT, plan_code TEXT, plan_label TEXT, trial_ends_at TIMESTAMPTZ, period_start TIMESTAMPTZ,
    period_end TIMESTAMPTZ, access_until TIMESTAMPTZ, autopay_status TEXT, next_charge_at TIMESTAMPTZ, last_active TIMESTAMPTZ,
    products BIGINT, variants BIGINT, stock BIGINT, errors_30d BIGINT, revenue NUMERIC, payment_failed BOOLEAN,
    last_payment_status TEXT, last_payment_at TIMESTAMPTZ, promo_code TEXT, discount NUMERIC)
LANGUAGE sql STABLE SET search_path = '' AS $$
    SELECT p.id, NULLIF(btrim(COALESCE(p.shop_name, '')), ''), NULLIF(btrim(COALESCE(p.full_name, '')), ''),
        COALESCE(NULLIF(btrim(COALESCE(p.email, '')), ''), u.email), NULLIF(btrim(COALESCE(p.phone, '')), ''), p.gstin, p.city,
        COALESCE(p.onboarded_at, p.created_at), p.onboarded_at IS NOT NULL,
        st.s, public.hangtag_platform_lifecycle(st.s, x.autopay_status, x.trial_ends_at, cfg.trial_ending_days, NOW()),
        x.plan_code, pl.label, x.trial_ends_at, x.period_start, x.period_end,
        CASE WHEN x.owner_id IS NULL THEN NULL
             WHEN st.s = 'renewal_due' THEN GREATEST(x.trial_ends_at, x.period_end) + make_interval(hours => COALESCE(cfg.renewal_grace_hours, 48))
             ELSE GREATEST(x.trial_ends_at, x.period_end) END,
        COALESCE(x.autopay_status, 'none'), CASE WHEN x.autopay_status IN ('pending', 'active', 'past_due') THEN x.autopay_next_charge_at END,
        GREATEST(p.last_seen_at, a.sale_at, a.product_at, a.move_at, a.customer_at, a.member_at, a.device_at),
        a.products, a.variants, a.stock, a.errors, a.revenue, COALESCE(ls.status = 'failed', FALSE),
        la.status, la.created_at, lp.promo_code, lp.discount
      FROM public.hangtag_profiles p
      JOIN auth.users u ON u.id = p.id
      LEFT JOIN (SELECT c.trial_ending_days, c.renewal_grace_hours FROM public.hangtag_platform_config c WHERE c.id) cfg ON TRUE
      LEFT JOIN public.hangtag_subscriptions x ON x.owner_id = p.id
      LEFT JOIN public.hangtag_plans pl ON pl.code = x.plan_code
      CROSS JOIN LATERAL (SELECT public.hangtag_subscription_state(p.id, NOW()) AS s) st
      CROSS JOIN LATERAL (SELECT
          (SELECT max(b.created_at) FROM public.hangtag_sales b WHERE b.owner_id = p.id) AS sale_at,
          (SELECT max(pr.updated_at) FROM public.hangtag_products pr WHERE pr.owner_id = p.id) AS product_at,
          (SELECT max(mv.created_at) FROM public.hangtag_stock_moves mv WHERE mv.owner_id = p.id) AS move_at,
          (SELECT max(cu.updated_at) FROM public.hangtag_customers cu WHERE cu.owner_id = p.id) AS customer_at,
          (SELECT max(mb.last_seen_at) FROM public.hangtag_members mb WHERE mb.shop_id = p.id) AS member_at,
          (SELECT max(dv.last_seen_at) FROM public.hangtag_devices dv WHERE dv.owner_id = p.id) AS device_at,
          (SELECT count(*) FROM public.hangtag_products pr WHERE pr.owner_id = p.id AND NOT pr.archived) AS products,
          (SELECT count(*) FROM public.hangtag_variants va WHERE va.owner_id = p.id AND va.active) AS variants,
          ((SELECT COALESCE(sum(mv.qty), 0) FROM public.hangtag_stock_moves mv WHERE mv.owner_id = p.id)
           - (SELECT COALESCE(sum(si.quantity), 0) FROM public.hangtag_sale_items si JOIN public.hangtag_sales b ON b.owner_id = si.owner_id AND b.id = si.sale_id
               WHERE si.owner_id = p.id AND si.variant_id IS NOT NULL AND NOT b.is_void)
           + (SELECT COALESCE(sum(ri.quantity), 0) FROM public.hangtag_return_items ri
               JOIN public.hangtag_returns rt ON rt.owner_id = ri.owner_id AND rt.id = ri.return_id
               JOIN public.hangtag_sales b ON b.owner_id = rt.owner_id AND b.id = rt.sale_id
               WHERE ri.owner_id = p.id AND ri.variant_id IS NOT NULL AND ri.restock AND NOT b.is_void))::BIGINT AS stock,
          ((SELECT count(*) FROM public.hangtag_deliveries dl WHERE dl.owner_id = p.id AND dl.status = 'failed' AND dl.created_at > NOW() - interval '30 days')
           + (SELECT count(*) FROM public.hangtag_webhook_deliveries wd WHERE wd.owner_id = p.id AND wd.status = 'failed' AND wd.updated_at > NOW() - interval '30 days')
           + (SELECT count(*) FROM public.hangtag_subscription_payments y WHERE y.owner_id = p.id AND y.status = 'failed' AND y.created_at > NOW() - interval '30 days')) AS errors,
          (SELECT COALESCE(sum(y.amount), 0) FROM public.hangtag_subscription_payments y WHERE y.owner_id = p.id AND y.captured_at IS NOT NULL) AS revenue
      ) a
      LEFT JOIN LATERAL (SELECT y.status FROM public.hangtag_subscription_payments y WHERE y.owner_id = p.id AND y.status IN ('paid', 'failed')
                          AND y.created_at > NOW() - interval '30 days' ORDER BY y.created_at DESC LIMIT 1) ls ON TRUE
      LEFT JOIN LATERAL (SELECT public.hangtag_platform_pay_status(y.status, y.captured_at, y.provider) AS status, y.created_at FROM public.hangtag_subscription_payments y
                          WHERE y.owner_id = p.id ORDER BY y.created_at DESC LIMIT 1) la ON TRUE
      LEFT JOIN LATERAL (SELECT y.promo_code, y.discount FROM public.hangtag_subscription_payments y WHERE y.owner_id = p.id AND y.status = 'paid'
                          ORDER BY y.paid_at DESC NULLS LAST LIMIT 1) lp ON TRUE
     WHERE (p_owner IS NULL OR p.id = p_owner)
       AND NOT EXISTS (SELECT 1 FROM public.hangtag_members mm WHERE mm.user_id = p.id)
       AND (p.onboarded_at IS NOT NULL OR x.owner_id IS NOT NULL OR NOT EXISTS (SELECT 1 FROM public.hangtag_platform_staff ps WHERE ps.user_id = p.id))
$$;

-- (internal) A shop's plan as an audited action records it, before and after
CREATE OR REPLACE FUNCTION public.hangtag_platform_snapshot(p_owner UUID)
RETURNS JSONB LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE v_sub RECORD; v_state TEXT := public.hangtag_subscription_state(p_owner, NOW());
BEGIN
    SELECT x.plan_code, x.trial_ends_at, x.period_start, x.period_end, x.suspended, x.autopay_status INTO v_sub
      FROM public.hangtag_subscriptions x WHERE x.owner_id = p_owner;
    IF NOT FOUND THEN RETURN jsonb_build_object('state', v_state, 'access', public.hangtag_access_ok(p_owner)); END IF;
    RETURN jsonb_build_object('state', v_state, 'access', v_state IN ('trial_active', 'paid_active', 'renewal_due'), 'plan_code', v_sub.plan_code,
        'trial_ends_at', v_sub.trial_ends_at, 'period_start', v_sub.period_start, 'period_end', v_sub.period_end,
        'access_until', GREATEST(v_sub.trial_ends_at, v_sub.period_end), 'suspended', v_sub.suspended, 'autopay_status', v_sub.autopay_status);
END $$;

-- (internal) A plan payment as the console shows it: what was paid, for which plan, how, its state, and the provider's
-- references (to find it at the provider). Never a card, a token or a key: Hangtag keeps none.
CREATE OR REPLACE FUNCTION public.hangtag_platform_pay_json(p_id UUID)
RETURNS JSONB LANGUAGE sql STABLE SET search_path = '' AS $$
    SELECT jsonb_build_object('id', y.id, 'owner_id', y.owner_id, 'plan_code', y.plan_code, 'plan_label', pl.label, 'plan_months', pl.months,
        'kind', y.kind, 'provider', y.provider, 'status', public.hangtag_platform_pay_status(y.status, y.captured_at, y.provider), 'raw_status', y.status,
        'price', y.price, 'discount', y.discount, 'amount', y.amount, 'currency', y.currency, 'promo_code', y.promo_code,
        'provider_order_id', y.provider_order_id, 'provider_payment_id', y.provider_payment_id, 'created_at', y.created_at, 'paid_at', y.paid_at,
        'captured_at', y.captured_at, 'period_start', y.period_start, 'period_end', y.period_end)
      FROM public.hangtag_subscription_payments y LEFT JOIN public.hangtag_plans pl ON pl.code = y.plan_code
     WHERE y.id = p_id
$$;
-- (internal) A shop's plan payments, newest first
CREATE OR REPLACE FUNCTION public.hangtag_platform_pay_list(p_owner UUID, p_limit INT DEFAULT 50)
RETURNS JSONB LANGUAGE sql STABLE SET search_path = '' AS $$
    SELECT COALESCE(jsonb_agg(public.hangtag_platform_pay_json(z.id) ORDER BY z.created_at DESC, z.id), '[]'::jsonb)
      FROM (SELECT y.id, y.created_at FROM public.hangtag_subscription_payments y WHERE y.owner_id = p_owner
             ORDER BY y.created_at DESC, y.id LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200)) z
$$;

-- (internal) A shop's plan in full: the plan and its price, the trial, the period running, when access ends, the next
-- charge, AutoPay (the mandate at the provider, its consent), the latest offer used, the console's suspension (who, when,
-- why). Hangtag keeps no wallet: wallet_used is null.
CREATE OR REPLACE FUNCTION public.hangtag_platform_sub_json(p_owner UUID)
RETURNS JSONB LANGUAGE plpgsql STABLE SET search_path = '' AS $$
DECLARE
    v_now TIMESTAMPTZ := NOW();
    v_sub RECORD; v_cfg RECORD; v_plan RECORD; v_ap RECORD; v_paid RECORD; v_susp RECORD;
    v_state TEXT; v_until TIMESTAMPTZ;
BEGIN
    SELECT * INTO v_sub FROM public.hangtag_subscriptions x WHERE x.owner_id = p_owner;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('state', public.hangtag_subscription_state(p_owner, v_now), 'lifecycle', 'none', 'wallet_used', NULL);
    END IF;
    SELECT c.trial_ending_days, c.renewal_grace_hours, c.autopay_plan_code INTO v_cfg FROM public.hangtag_platform_config c WHERE c.id;
    v_state := public.hangtag_subscription_state(p_owner, v_now);
    SELECT pl.code, pl.label, pl.price, pl.months, pl.currency INTO v_plan FROM public.hangtag_plans pl WHERE pl.code = v_sub.plan_code;
    SELECT pl.code, pl.label, pl.price, pl.months, pl.currency INTO v_ap FROM public.hangtag_plans pl WHERE pl.code = COALESCE(v_sub.autopay_plan_code, v_cfg.autopay_plan_code);
    SELECT y.promo_code, y.discount, y.price, y.amount, y.paid_at, pc.title INTO v_paid
      FROM public.hangtag_subscription_payments y LEFT JOIN public.hangtag_promo_codes pc ON pc.code = y.promo_code
     WHERE y.owner_id = p_owner AND y.status = 'paid' AND y.promo_code IS NOT NULL ORDER BY y.paid_at DESC NULLS LAST LIMIT 1;
    SELECT au.t, au.detail ->> 'reason' AS reason, au.actor_role INTO v_susp FROM public.hangtag_platform_audit au
     WHERE v_sub.suspended AND au.target_type = 'shop' AND au.target_id = p_owner::TEXT AND au.action = 'customer.suspend' AND au.ok ORDER BY au.id DESC LIMIT 1;
    v_until := GREATEST(v_sub.trial_ends_at, v_sub.period_end);
    IF v_state = 'renewal_due' THEN v_until := v_until + make_interval(hours => COALESCE(v_cfg.renewal_grace_hours, 48)); END IF;
    RETURN jsonb_build_object(
        'state', v_state,
        'lifecycle', public.hangtag_platform_lifecycle(v_state, v_sub.autopay_status, v_sub.trial_ends_at, v_cfg.trial_ending_days, v_now),
        'plan', CASE WHEN v_plan.code IS NOT NULL THEN jsonb_build_object('code', v_plan.code, 'label', v_plan.label, 'price', v_plan.price,
            'months', v_plan.months, 'currency', v_plan.currency) END,
        'trial_started_at', v_sub.trial_started_at, 'trial_ends_at', v_sub.trial_ends_at,
        'period_start', v_sub.period_start, 'period_end', v_sub.period_end, 'access_until', v_until,
        'next_charge_at', CASE WHEN v_sub.autopay_status IN ('pending', 'active', 'past_due') THEN v_sub.autopay_next_charge_at END,
        'suspended', v_sub.suspended,
        'suspension', CASE WHEN v_sub.suspended THEN jsonb_build_object('at', v_susp.t, 'reason', v_susp.reason, 'by_role', v_susp.actor_role) END,
        'autopay', jsonb_build_object('status', v_sub.autopay_status, 'required', v_sub.autopay_required, 'provider', v_sub.autopay_provider,
            'subscription_id', v_sub.autopay_subscription_id, 'plan_code', v_ap.code, 'plan_label', v_ap.label, 'price', v_ap.price, 'currency', v_ap.currency,
            'consent_at', v_sub.autopay_consent_at, 'consent_version', v_sub.autopay_consent_version, 'authorized_at', v_sub.autopay_authorized_at,
            'failed_at', v_sub.autopay_failed_at, 'cancelled_at', v_sub.autopay_cancelled_at),
        'promo', CASE WHEN v_paid.promo_code IS NOT NULL THEN jsonb_build_object('code', v_paid.promo_code, 'title', v_paid.title, 'discount', v_paid.discount,
            'price', v_paid.price, 'amount', v_paid.amount, 'paid_at', v_paid.paid_at) END,
        'wallet_used', NULL,
        'created_at', v_sub.created_at, 'updated_at', v_sub.updated_at);
END $$;

-- (internal) What a console role may do to a shop, for its buttons (the action function checks again), and the paid plans a
-- console may give
CREATE OR REPLACE FUNCTION public.hangtag_platform_can(p_perms TEXT[])
RETURNS JSONB LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
    SELECT jsonb_build_object('suspend', 'customers.suspend' = ANY (p_perms), 'subscriptions', 'subscriptions.manage' = ANY (p_perms),
        'sessions', 'customers.sessions' = ANY (p_perms))
$$;
CREATE OR REPLACE FUNCTION public.hangtag_platform_paid_plans()
RETURNS JSONB LANGUAGE sql STABLE SET search_path = '' AS $$
    SELECT COALESCE(jsonb_agg(jsonb_build_object('code', pl.code, 'label', pl.label, 'months', pl.months, 'price', pl.price, 'currency', pl.currency)
        ORDER BY pl.sort, pl.code), '[]'::jsonb)
      FROM public.hangtag_plans pl WHERE pl.kind = 'paid' AND pl.active
$$;

-- (internal) One page of the console's customers or subscriptions (p_kind): searched, in a list, sorted (newest · oldest ·
-- last_active · expiry: the soonest ending first, then the latest ended · revenue), with how many shops of this search are in
-- each list
CREATE OR REPLACE FUNCTION public.hangtag_platform_list(p_kind TEXT, p_query TEXT, p_list TEXT, p_sort TEXT, p_limit INT, p_offset INT)
RETURNS JSONB LANGUAGE plpgsql STABLE SET search_path = '' AS $$
DECLARE
    v_now TIMESTAMPTZ := NOW();
    v_q TEXT := lower(btrim(COALESCE(p_query, '')));
    v_list TEXT := COALESCE(NULLIF(btrim(COALESCE(p_list, '')), ''), 'all');
    v_sort TEXT := COALESCE(NULLIF(btrim(COALESCE(p_sort, '')), ''), CASE WHEN p_kind = 'subscriptions' THEN 'expiry' ELSE 'newest' END);
    v_lim INT := LEAST(GREATEST(COALESCE(p_limit, 25), 1), 100);
    v_off INT := LEAST(GREATEST(COALESCE(p_offset, 0), 0), 100000);
    v_lists TEXT[] := CASE WHEN p_kind = 'subscriptions' THEN ARRAY['all', 'trial', 'active', 'payment_failed', 'past_due', 'cancelled', 'expired', 'suspended']
        ELSE ARRAY['all', 'trial', 'active', 'payment_failed', 'expiring', 'expired', 'suspended', 'inactive'] END;
    v_out JSONB;
BEGIN
    IF NOT (v_list = ANY (v_lists)) THEN RAISE EXCEPTION 'Unknown list.' USING ERRCODE = 'P0001'; END IF;
    IF v_sort NOT IN ('newest', 'oldest', 'last_active', 'expiry', 'revenue') THEN RAISE EXCEPTION 'Unknown order.' USING ERRCODE = 'P0001'; END IF;
    IF char_length(v_q) > 120 THEN RAISE EXCEPTION 'Search for something shorter.' USING ERRCODE = 'P0001'; END IF;
    WITH m AS MATERIALIZED (
        SELECT r.* FROM public.hangtag_platform_shop_rows(NULL) r
         WHERE (p_kind <> 'subscriptions' OR r.state <> 'none')
           AND public.hangtag_platform_matches(v_q, r.owner_id, r.shop_name, r.owner_name, r.email, r.phone, r.gstin)
    ), f AS (
        SELECT m.*, row_number() OVER (ORDER BY
            CASE WHEN v_sort = 'oldest' THEN m.joined_at END ASC NULLS LAST,
            CASE WHEN v_sort = 'last_active' THEN m.last_active END DESC NULLS LAST,
            CASE WHEN v_sort = 'expiry' THEN (m.access_until IS NULL OR m.access_until < v_now) END ASC,
            CASE WHEN v_sort = 'expiry' AND m.access_until >= v_now THEN m.access_until END ASC NULLS LAST,
            CASE WHEN v_sort = 'expiry' AND m.access_until < v_now THEN m.access_until END DESC NULLS LAST,
            CASE WHEN v_sort = 'revenue' THEN m.revenue END DESC NULLS LAST,
            m.joined_at DESC, m.owner_id) AS rn
          FROM m WHERE public.hangtag_platform_in_list(v_list, m.state, m.autopay_status, m.access_until, m.last_active, m.payment_failed, v_now)
    )
    SELECT jsonb_build_object(
        'rows', COALESCE((SELECT jsonb_agg(to_jsonb(f) - 'rn' ORDER BY f.rn) FROM f WHERE f.rn > v_off AND f.rn <= v_off + v_lim), '[]'::jsonb),
        'total', (SELECT count(*) FROM f),
        'counts', (SELECT jsonb_object_agg(l.k, (SELECT count(*) FROM m WHERE public.hangtag_platform_in_list(l.k, m.state, m.autopay_status, m.access_until,
            m.last_active, m.payment_failed, v_now))) FROM unnest(v_lists) AS l(k)),
        'list', v_list, 'sort', v_sort, 'limit', v_lim, 'offset', v_off, 'generated_at', v_now)
      INTO v_out;
    RETURN v_out;
END $$;

-- The console's customers (customers.view): every shop, searched (shop, owner, email, phone, account id, GSTIN), in a list
-- (all · trial · active · payment_failed · expiring · expired · suspended · inactive), sorted, a page at a time
CREATE OR REPLACE FUNCTION public.hangtag_platform_customers(p_query TEXT DEFAULT NULL, p_list TEXT DEFAULT 'all', p_sort TEXT DEFAULT 'newest',
    p_limit INT DEFAULT 25, p_offset INT DEFAULT 0)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_role TEXT := public.hangtag_platform_require('customers.view');
BEGIN
    RETURN public.hangtag_platform_list('customers', p_query, p_list, p_sort, p_limit, p_offset);
END $$;

-- The console's subscriptions (subscriptions.view): every shop with a plan record, in a list (all · trial · active ·
-- payment_failed · past_due · cancelled · expired · suspended), the soonest ending first by default
CREATE OR REPLACE FUNCTION public.hangtag_platform_subscriptions(p_query TEXT DEFAULT NULL, p_list TEXT DEFAULT 'all', p_sort TEXT DEFAULT 'expiry',
    p_limit INT DEFAULT 25, p_offset INT DEFAULT 0)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_role TEXT := public.hangtag_platform_require('subscriptions.view');
BEGIN
    RETURN public.hangtag_platform_list('subscriptions', p_query, p_list, p_sort, p_limit, p_offset);
END $$;

-- One shop, for its page in the console (customers.view). Each tab needs its own section's permission: the plan
-- (subscriptions.view), payments (payments.view), usage (health.view), inventory (inventory.view), messages
-- (communications.view), errors (diagnostics.view); the console actions on it show the staff account only to audit.view.
-- Counts only: never the shop's sales figures, nor who its receipts went to.
CREATE OR REPLACE FUNCTION public.hangtag_platform_customer(p_owner UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    v_role TEXT := public.hangtag_platform_require('customers.view');
    v_perms TEXT[] := public.hangtag_platform_permissions(v_role);
    v_now TIMESTAMPTZ := NOW();
    v_shop RECORD;
    v_prof RECORD;
    v_usage JSONB; v_inv JSONB; v_msgs JSONB; v_errs JSONB; v_acts JSONB;
BEGIN
    SELECT * INTO v_shop FROM public.hangtag_platform_shop_rows(p_owner) r;
    IF NOT FOUND THEN RAISE EXCEPTION 'No such customer.' USING ERRCODE = 'P0002'; END IF;
    SELECT pf.address, pf.state AS region, pf.business_type, pf.created_at, pf.onboarded_at INTO v_prof FROM public.hangtag_profiles pf WHERE pf.id = p_owner;
    IF 'health.view' = ANY (v_perms) THEN
        SELECT jsonb_build_object('bills', count(*) FILTER (WHERE NOT b.is_void),
            'bills_30d', count(*) FILTER (WHERE NOT b.is_void AND b.created_at > v_now - interval '30 days'),
            'bills_7d', count(*) FILTER (WHERE NOT b.is_void AND b.created_at > v_now - interval '7 days'),
            'cancelled_bills', count(*) FILTER (WHERE b.is_void),
            'days_billing_30d', count(DISTINCT (b.created_at AT TIME ZONE 'Asia/Kolkata')::DATE) FILTER (WHERE NOT b.is_void AND b.created_at > v_now - interval '30 days'),
            'first_bill_at', min(b.created_at), 'last_bill_at', max(b.created_at))
          INTO v_usage FROM public.hangtag_sales b WHERE b.owner_id = p_owner;
        v_usage := v_usage || jsonb_build_object('last_active', v_shop.last_active,
            'team', (SELECT count(*) FROM public.hangtag_members mb WHERE mb.shop_id = p_owner AND mb.status = 'active'),
            'phones', (SELECT count(*) FROM public.hangtag_devices dv WHERE dv.owner_id = p_owner AND dv.status = 'active'),
            'customers', (SELECT count(*) FROM public.hangtag_customers cu WHERE cu.owner_id = p_owner));
    END IF;
    IF 'inventory.view' = ANY (v_perms) THEN
        v_inv := jsonb_build_object('products', v_shop.products, 'variants', v_shop.variants, 'stock', v_shop.stock,
            'archived', (SELECT count(*) FROM public.hangtag_products pr WHERE pr.owner_id = p_owner AND pr.archived),
            'moves_30d', (SELECT count(*) FROM public.hangtag_stock_moves mv WHERE mv.owner_id = p_owner AND mv.created_at > v_now - interval '30 days'),
            'last_change_at', (SELECT max(mv.created_at) FROM public.hangtag_stock_moves mv WHERE mv.owner_id = p_owner));
    END IF;
    IF 'communications.view' = ANY (v_perms) THEN
        SELECT jsonb_build_object('sent_30d', count(*) FILTER (WHERE dl.status = 'sent' AND dl.created_at > v_now - interval '30 days'),
            'delivered_30d', count(*) FILTER (WHERE dl.delivered_at IS NOT NULL AND dl.created_at > v_now - interval '30 days'),
            'failed_30d', count(*) FILTER (WHERE dl.status = 'failed' AND dl.created_at > v_now - interval '30 days'),
            'pending', count(*) FILTER (WHERE dl.status = 'pending'),
            'recent', COALESCE((SELECT jsonb_agg(jsonb_build_object('t', z.created_at, 'channel', z.channel, 'status', z.status, 'provider', z.provider,
                'delivered_at', z.delivered_at, 'error', z.error) ORDER BY z.created_at DESC)
                FROM (SELECT * FROM public.hangtag_deliveries d2 WHERE d2.owner_id = p_owner ORDER BY d2.created_at DESC LIMIT 20) z), '[]'::jsonb))
          INTO v_msgs FROM public.hangtag_deliveries dl WHERE dl.owner_id = p_owner;
    END IF;
    IF 'diagnostics.view' = ANY (v_perms) THEN
        SELECT COALESCE(jsonb_agg(to_jsonb(e) ORDER BY e.t DESC), '[]'::jsonb) INTO v_errs FROM (
            SELECT * FROM (
                SELECT dl.created_at AS t, 'message' AS source, dl.channel AS what, dl.error AS detail FROM public.hangtag_deliveries dl
                 WHERE dl.owner_id = p_owner AND dl.status = 'failed' AND dl.created_at > v_now - interval '30 days'
                UNION ALL
                SELECT wd.updated_at, 'webhook', COALESCE('HTTP ' || wd.last_status::TEXT, 'webhook'), wd.last_error FROM public.hangtag_webhook_deliveries wd
                 WHERE wd.owner_id = p_owner AND wd.status = 'failed' AND wd.updated_at > v_now - interval '30 days'
                UNION ALL
                SELECT y.created_at, 'payment', y.provider, COALESCE(y.note, 'The plan payment failed') FROM public.hangtag_subscription_payments y
                 WHERE y.owner_id = p_owner AND y.status = 'failed' AND y.created_at > v_now - interval '30 days'
            ) u ORDER BY u.t DESC LIMIT 30) e;
        v_errs := jsonb_build_object('count_30d', v_shop.errors_30d, 'recent', v_errs);
    END IF;
    SELECT COALESCE(jsonb_agg(to_jsonb(ev) ORDER BY ev.t DESC), '[]'::jsonb) INTO v_acts FROM (
        SELECT * FROM (
            SELECT v_prof.created_at AS t, 'signed_up' AS kind, NULL::TEXT AS detail, NULL::BOOLEAN AS ok, NULL::TEXT AS by_role, NULL::TEXT AS by_email
            UNION ALL SELECT v_prof.onboarded_at, 'shop_set_up', NULL, NULL, NULL, NULL
            UNION ALL SELECT x.trial_started_at, 'trial_started', NULL, NULL, NULL, NULL FROM public.hangtag_subscriptions x WHERE x.owner_id = p_owner
            UNION ALL SELECT x.autopay_authorized_at, 'autopay_on', NULL, NULL, NULL, NULL FROM public.hangtag_subscriptions x WHERE x.owner_id = p_owner
            UNION ALL SELECT x.autopay_failed_at, 'autopay_failed', NULL, NULL, NULL, NULL FROM public.hangtag_subscriptions x WHERE x.owner_id = p_owner
            UNION ALL SELECT x.autopay_cancelled_at, 'autopay_off', NULL, NULL, NULL, NULL FROM public.hangtag_subscriptions x WHERE x.owner_id = p_owner
            UNION ALL SELECT COALESCE(y.paid_at, y.created_at), 'payment_' || public.hangtag_platform_pay_status(y.status, y.captured_at, y.provider),
                   COALESCE(pl.label, y.plan_code) || ' · ' || y.currency || ' ' || y.amount::TEXT, NULL, NULL, NULL
              FROM public.hangtag_subscription_payments y LEFT JOIN public.hangtag_plans pl ON pl.code = y.plan_code
             WHERE y.owner_id = p_owner AND y.status IN ('paid', 'failed')
            UNION ALL SELECT au.t, au.action, au.detail ->> 'reason', au.ok, au.actor_role, CASE WHEN 'audit.view' = ANY (v_perms) THEN us.email END
              FROM public.hangtag_platform_audit au LEFT JOIN auth.users us ON us.id = au.actor
             WHERE au.target_type = 'shop' AND au.target_id = p_owner::TEXT
        ) u WHERE u.t IS NOT NULL ORDER BY u.t DESC LIMIT 60) ev;
    RETURN jsonb_build_object('generated_at', v_now,
        'overview', to_jsonb(v_shop) || jsonb_build_object('address', v_prof.address, 'region', v_prof.region, 'business_type', v_prof.business_type,
            'signed_up_at', v_prof.created_at, 'onboarded_at', v_prof.onboarded_at),
        'subscription', CASE WHEN 'subscriptions.view' = ANY (v_perms) THEN public.hangtag_platform_sub_json(p_owner) END,
        'payments', CASE WHEN 'payments.view' = ANY (v_perms) THEN public.hangtag_platform_pay_list(p_owner, 50) END,
        'usage', v_usage, 'inventory', v_inv, 'communications', v_msgs, 'errors', v_errs,
        'referrals', CASE WHEN 'referrals.view' = ANY (v_perms) THEN jsonb_build_object('available', FALSE) END,
        'wallet', CASE WHEN 'wallet.view' = ANY (v_perms) THEN jsonb_build_object('available', FALSE) END,
        'activity', v_acts,
        'can', public.hangtag_platform_can(v_perms),
        'plans', public.hangtag_platform_paid_plans());
END $$;

-- One shop's plan, for the console's Subscriptions (subscriptions.view): the plan in full, its payments (payments.view) and
-- what the caller's role may do to it
CREATE OR REPLACE FUNCTION public.hangtag_platform_subscription(p_owner UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    v_role TEXT := public.hangtag_platform_require('subscriptions.view');
    v_perms TEXT[] := public.hangtag_platform_permissions(v_role);
    v_who RECORD;
BEGIN
    SELECT pf.id, NULLIF(btrim(COALESCE(pf.shop_name, '')), '') AS shop_name, NULLIF(btrim(COALESCE(pf.full_name, '')), '') AS owner_name,
           COALESCE(NULLIF(btrim(COALESCE(pf.email, '')), ''), us.email) AS email, pf.phone
      INTO v_who FROM public.hangtag_profiles pf JOIN auth.users us ON us.id = pf.id
     WHERE pf.id = p_owner AND NOT EXISTS (SELECT 1 FROM public.hangtag_members mm WHERE mm.user_id = pf.id);
    IF NOT FOUND THEN RAISE EXCEPTION 'No such customer.' USING ERRCODE = 'P0002'; END IF;
    RETURN jsonb_build_object('generated_at', NOW(),
        'customer', jsonb_build_object('owner_id', v_who.id, 'shop_name', v_who.shop_name, 'owner_name', v_who.owner_name, 'email', v_who.email, 'phone', v_who.phone),
        'subscription', public.hangtag_platform_sub_json(p_owner),
        'payments', CASE WHEN 'payments.view' = ANY (v_perms) THEN public.hangtag_platform_pay_list(p_owner, 50) END,
        'can', public.hangtag_platform_can(v_perms),
        'plans', public.hangtag_platform_paid_plans());
END $$;

-- The plan payments (payments.view): searched (the shop, its owner, email or phone, the payment's id, the provider's
-- references), by status (pending · captured · failed · refunded · cancelled · expired · granted · free), between dates or
-- over the last p_days days, newest first, a page at a time, with how many of this search are in each status. Hangtag
-- records no refunds yet (a refund is made at the provider), so "refunded" is always empty and the console says why.
CREATE OR REPLACE FUNCTION public.hangtag_platform_payments(p_query TEXT DEFAULT NULL, p_status TEXT DEFAULT 'all', p_from TIMESTAMPTZ DEFAULT NULL,
    p_to TIMESTAMPTZ DEFAULT NULL, p_days INT DEFAULT NULL, p_limit INT DEFAULT 25, p_offset INT DEFAULT 0)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    v_role TEXT := public.hangtag_platform_require('payments.view');
    v_q TEXT := lower(btrim(COALESCE(p_query, '')));
    v_status TEXT := COALESCE(NULLIF(btrim(COALESCE(p_status, '')), ''), 'all');
    v_from TIMESTAMPTZ := CASE WHEN p_days IS NOT NULL THEN NOW() - make_interval(days => LEAST(GREATEST(p_days, 1), 3660)) ELSE p_from END;
    v_lim INT := LEAST(GREATEST(COALESCE(p_limit, 25), 1), 100);
    v_off INT := LEAST(GREATEST(COALESCE(p_offset, 0), 0), 100000);
    v_statuses TEXT[] := ARRAY['all', 'captured', 'pending', 'failed', 'refunded', 'cancelled', 'expired', 'granted', 'free'];
    v_out JSONB;
BEGIN
    IF NOT (v_status = ANY (v_statuses)) THEN RAISE EXCEPTION 'Unknown payment status.' USING ERRCODE = 'P0001'; END IF;
    IF char_length(v_q) > 120 THEN RAISE EXCEPTION 'Search for something shorter.' USING ERRCODE = 'P0001'; END IF;
    IF v_from IS NOT NULL AND p_to IS NOT NULL AND p_to < v_from THEN RAISE EXCEPTION 'The end date is before the start date.' USING ERRCODE = 'P0001'; END IF;
    WITH m AS MATERIALIZED (
        SELECT y.id, y.created_at, y.amount, public.hangtag_platform_pay_status(y.status, y.captured_at, y.provider) AS shown,
               NULLIF(btrim(COALESCE(pf.shop_name, '')), '') AS shop_name, NULLIF(btrim(COALESCE(pf.full_name, '')), '') AS owner_name,
               COALESCE(NULLIF(btrim(COALESCE(pf.email, '')), ''), us.email) AS email
          FROM public.hangtag_subscription_payments y
          LEFT JOIN public.hangtag_profiles pf ON pf.id = y.owner_id
          LEFT JOIN auth.users us ON us.id = y.owner_id
         WHERE (v_from IS NULL OR y.created_at >= v_from) AND (p_to IS NULL OR y.created_at <= p_to)
           AND (v_q = '' OR public.hangtag_platform_matches(v_q, y.owner_id, pf.shop_name, pf.full_name, COALESCE(NULLIF(btrim(COALESCE(pf.email, '')), ''), us.email),
                    pf.phone, pf.gstin)
                OR (char_length(v_q) >= 4 AND strpos(y.id::TEXT, v_q) = 1)
                OR strpos(lower(COALESCE(y.provider_payment_id, '')), v_q) > 0 OR strpos(lower(COALESCE(y.provider_order_id, '')), v_q) > 0)
    ), f AS (
        SELECT m.*, row_number() OVER (ORDER BY m.created_at DESC, m.id) AS rn FROM m WHERE v_status = 'all' OR m.shown = v_status
    )
    SELECT jsonb_build_object(
        'rows', COALESCE((SELECT jsonb_agg(public.hangtag_platform_pay_json(f.id) || jsonb_build_object('shop_name', f.shop_name, 'owner_name', f.owner_name,
            'email', f.email) ORDER BY f.rn) FROM f WHERE f.rn > v_off AND f.rn <= v_off + v_lim), '[]'::jsonb),
        'total', (SELECT count(*) FROM f),
        'counts', (SELECT jsonb_object_agg(s.k, (SELECT count(*) FROM m WHERE s.k = 'all' OR m.shown = s.k)) FROM unnest(v_statuses) AS s(k)),
        'captured_amount', (SELECT COALESCE(sum(m.amount), 0) FROM m WHERE m.shown = 'captured'),
        'refunds_recorded', FALSE,
        'status', v_status, 'from', v_from, 'to', p_to, 'limit', v_lim, 'offset', v_off, 'generated_at', NOW())
      INTO v_out;
    RETURN v_out;
END $$;

-- One plan payment (payments.view): its safe fields, the shop, its plan now, the offer it used, and what happened to it
-- (created, paid or captured, and the console actions that made it)
CREATE OR REPLACE FUNCTION public.hangtag_platform_payment(p_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    v_role TEXT := public.hangtag_platform_require('payments.view');
    v_pay RECORD;
BEGIN
    SELECT y.id, y.owner_id, y.note, y.created_by, y.created_at, y.paid_at, y.captured_at INTO v_pay FROM public.hangtag_subscription_payments y WHERE y.id = p_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'No such payment.' USING ERRCODE = 'P0002'; END IF;
    RETURN public.hangtag_platform_pay_json(p_id) || jsonb_build_object(
        'note', v_pay.note,
        'by_console', v_pay.created_by IS NOT NULL,
        'customer', (SELECT jsonb_build_object('owner_id', pf.id, 'shop_name', NULLIF(btrim(COALESCE(pf.shop_name, '')), ''),
            'owner_name', NULLIF(btrim(COALESCE(pf.full_name, '')), ''), 'email', COALESCE(NULLIF(btrim(COALESCE(pf.email, '')), ''), us.email), 'phone', pf.phone)
            FROM public.hangtag_profiles pf LEFT JOIN auth.users us ON us.id = pf.id WHERE pf.id = v_pay.owner_id),
        'subscription', public.hangtag_platform_sub_json(v_pay.owner_id),
        'promo', (SELECT jsonb_build_object('code', rd.code, 'title', pc.title, 'discount', rd.discount, 'redeemed_at', rd.redeemed_at)
            FROM public.hangtag_promo_redemptions rd LEFT JOIN public.hangtag_promo_codes pc ON pc.code = rd.code WHERE rd.payment_id = p_id),
        'activity', (SELECT COALESCE(jsonb_agg(to_jsonb(ev) - 'n' ORDER BY ev.t, ev.n), '[]'::jsonb) FROM (
            SELECT v_pay.created_at AS t, 1 AS n, 'created' AS kind, NULL::TEXT AS detail, NULL::BOOLEAN AS ok
            UNION ALL SELECT v_pay.paid_at, 2, CASE WHEN v_pay.captured_at IS NOT NULL THEN 'captured' ELSE 'activated' END, NULL, NULL WHERE v_pay.paid_at IS NOT NULL
            UNION ALL SELECT au.t, 3, au.action, au.detail ->> 'reason', au.ok FROM public.hangtag_platform_audit au WHERE au.detail ->> 'payment_id' = p_id::TEXT) ev));
END $$;

-- An action on a shop, from the console. p_action:
--   suspend · restore · grant (p_args.plan: a paid plan, given without a payment) · extend (p_args.days, 1–90: the paid plan
--   if it has one, else the trial) · sign_out (end every sign-in of the owner and of the shop's team)
-- Each needs its own permission: customers.suspend, subscriptions.manage or customers.sessions.
-- p_dry_run: the exact consequence; the action is done and rolled back, so nothing changes and nothing is logged.
-- Otherwise a reason (3–300 characters) is needed, and the audit log keeps who, which shop, the action, before and after,
-- the reason and the outcome. A refused or failed attempt is logged as such and answered { ok: false, code, message }:
-- raising an error would undo its own log line.
CREATE OR REPLACE FUNCTION public.hangtag_platform_customer_action(p_owner UUID, p_action TEXT, p_reason TEXT DEFAULT NULL,
    p_args JSONB DEFAULT '{}'::jsonb, p_dry_run BOOLEAN DEFAULT FALSE)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    v_role TEXT := public.hangtag_platform_role();
    v_act TEXT := lower(btrim(COALESCE(p_action, '')));
    v_perm TEXT;
    v_name TEXT;
    v_why TEXT := NULLIF(btrim(COALESCE(p_reason, '')), '');
    v_args JSONB := CASE WHEN jsonb_typeof(p_args) = 'object' THEN p_args ELSE '{}'::jsonb END;
    v_clean JSONB;
    v_dry BOOLEAN := COALESCE(p_dry_run, FALSE);
    v_before JSONB;
    v_after JSONB;
    v_extra JSONB := '{}'::jsonb;
    v_sub RECORD;
    v_plan TEXT;
    v_days INT;
    v_n INT;
    v_pay UUID;
    v_res JSONB;
    v_code TEXT;
    v_msg TEXT;
BEGIN
    v_perm := CASE v_act WHEN 'suspend' THEN 'customers.suspend' WHEN 'restore' THEN 'customers.suspend' WHEN 'grant' THEN 'subscriptions.manage'
        WHEN 'extend' THEN 'subscriptions.manage' WHEN 'sign_out' THEN 'customers.sessions' END;
    IF v_perm IS NULL THEN RAISE EXCEPTION 'Unknown action.' USING ERRCODE = 'P0001'; END IF;
    v_name := 'customer.' || v_act;
    v_clean := jsonb_strip_nulls(jsonb_build_object('plan', left(v_args ->> 'plan', 20), 'days', left(v_args ->> 'days', 6)));
    -- the permission, checked here: a refused attempt is logged (at most once a minute per account and action) and answered
    IF v_role IS NULL OR NOT (v_perm = ANY (public.hangtag_platform_permissions(v_role))) THEN
        IF auth.uid() IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.hangtag_platform_audit au WHERE au.actor = auth.uid() AND au.action = v_name
                AND NOT au.ok AND au.detail ->> 'outcome' = 'denied' AND au.t > NOW() - interval '1 minute') THEN
            PERFORM public.hangtag_platform_log(v_name, 'shop', p_owner::TEXT, jsonb_build_object('outcome', 'denied', 'reason', left(v_why, 300),
                'dry_run', v_dry, 'args', v_clean), FALSE);
        END IF;
        RETURN jsonb_build_object('ok', FALSE, 'code', 'DENIED', 'message', 'Your console role can''t do this.');
    END IF;
    IF p_owner IS NULL OR NOT EXISTS (SELECT 1 FROM public.hangtag_profiles pf WHERE pf.id = p_owner)
       OR EXISTS (SELECT 1 FROM public.hangtag_members mm WHERE mm.user_id = p_owner) THEN
        RAISE EXCEPTION 'No such customer.' USING ERRCODE = 'P0002';
    END IF;
    IF NOT v_dry AND (v_why IS NULL OR char_length(v_why) < 3 OR char_length(v_why) > 300) THEN
        RAISE EXCEPTION 'Give a reason (3 to 300 characters): the audit log keeps it.' USING ERRCODE = 'P0001';
    END IF;
    v_before := public.hangtag_platform_snapshot(p_owner);
    BEGIN
        IF v_act = 'suspend' THEN
            IF v_before ->> 'state' = 'suspended' THEN RAISE EXCEPTION 'This shop is already suspended.' USING ERRCODE = 'P0001'; END IF;
            -- the shop's own record says only that Hangtag suspended it: the staff's reason stays in the console's audit log
            PERFORM public.hangtag_admin_suspend(p_owner, TRUE, 'Suspended by Hangtag');
        ELSIF v_act = 'restore' THEN
            IF v_before ->> 'state' IS DISTINCT FROM 'suspended' THEN RAISE EXCEPTION 'This shop isn''t suspended.' USING ERRCODE = 'P0001'; END IF;
            PERFORM public.hangtag_admin_suspend(p_owner, FALSE, NULL);
        ELSIF v_act = 'grant' THEN
            v_plan := btrim(COALESCE(v_args ->> 'plan', ''));
            IF NOT EXISTS (SELECT 1 FROM public.hangtag_plans pl WHERE pl.code = v_plan AND pl.kind = 'paid') THEN
                RAISE EXCEPTION 'Choose a paid plan.' USING ERRCODE = 'P0001';
            END IF;
            v_res := public.hangtag_admin_grant(p_owner, v_plan, left('Console: ' || COALESCE(v_why, 'preview'), 200));
            IF NOT COALESCE((v_res ->> 'ok')::BOOLEAN, FALSE) THEN
                RAISE EXCEPTION '%', COALESCE(v_res ->> 'message', 'The plan couldn''t be given.') USING ERRCODE = 'P0001';
            END IF;
            SELECT y.id INTO v_pay FROM public.hangtag_subscription_payments y
             WHERE y.owner_id = p_owner AND y.provider = 'manual' AND y.created_at = NOW() ORDER BY y.id LIMIT 1;
            UPDATE public.hangtag_subscription_payments SET created_by = auth.uid() WHERE id = v_pay;
            v_extra := jsonb_build_object('payment_id', v_pay, 'plan', v_plan);
        ELSIF v_act = 'extend' THEN
            v_days := CASE WHEN COALESCE(v_args ->> 'days', '') ~ '^[0-9]{1,3}$' THEN (v_args ->> 'days')::INT END;
            IF v_days IS NULL OR v_days NOT BETWEEN 1 AND 90 THEN RAISE EXCEPTION 'Extend by 1 to 90 days.' USING ERRCODE = 'P0001'; END IF;
            SELECT x.trial_ends_at, x.period_start, x.period_end, x.autopay_status INTO v_sub FROM public.hangtag_subscriptions x WHERE x.owner_id = p_owner FOR UPDATE;
            IF NOT FOUND THEN RAISE EXCEPTION 'This shop hasn''t finished setting up: it has no plan to extend yet.' USING ERRCODE = 'P0001'; END IF;
            IF v_sub.period_end IS NOT NULL THEN
                UPDATE public.hangtag_subscriptions SET period_start = CASE WHEN v_sub.period_end > NOW() THEN v_sub.period_start ELSE NOW() END,
                    period_end = GREATEST(v_sub.period_end, NOW()) + make_interval(days => v_days), updated_at = NOW()
                 WHERE owner_id = p_owner;
                v_extra := jsonb_build_object('days', v_days, 'extended', 'plan');
            ELSE
                IF v_sub.autopay_status IN ('pending', 'active', 'past_due') THEN
                    RAISE EXCEPTION 'AutoPay charges this shop when its trial ends, on the provider''s schedule: a longer trial here wouldn''t move that charge. Give a plan instead.'
                        USING ERRCODE = 'P0001';
                END IF;
                UPDATE public.hangtag_subscriptions SET trial_ends_at = GREATEST(v_sub.trial_ends_at, NOW()) + make_interval(days => v_days), updated_at = NOW()
                 WHERE owner_id = p_owner;
                v_extra := jsonb_build_object('days', v_days, 'extended', 'trial');
            END IF;
        ELSE
            -- sign_out: the owner's and the team's sign-ins end (each signs in again; a page already open stops within the hour)
            BEGIN
                DELETE FROM auth.sessions se WHERE se.user_id = p_owner OR se.user_id IN (SELECT mb.user_id FROM public.hangtag_members mb WHERE mb.shop_id = p_owner);
                GET DIAGNOSTICS v_n = ROW_COUNT;
            EXCEPTION WHEN undefined_table OR undefined_column OR insufficient_privilege THEN
                RAISE EXCEPTION 'Sign-ins can''t be ended from this database.' USING ERRCODE = 'P0001';
            END;
            v_extra := jsonb_build_object('sessions_ended', v_n,
                'team', (SELECT count(*) FROM public.hangtag_members mb WHERE mb.shop_id = p_owner AND mb.status = 'active'));
        END IF;
        v_after := public.hangtag_platform_snapshot(p_owner);
        IF v_dry THEN RAISE EXCEPTION 'preview' USING ERRCODE = 'HTDRY'; END IF;
    EXCEPTION
        WHEN SQLSTATE 'HTDRY' THEN
            RETURN jsonb_build_object('ok', TRUE, 'dry_run', TRUE, 'action', v_act, 'before', v_before, 'after', v_after) || v_extra;
        WHEN OTHERS THEN
            GET STACKED DIAGNOSTICS v_code = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
            v_msg := CASE WHEN v_code IN ('P0001', 'P0002') THEN left(v_msg, 300) ELSE 'The change couldn''t be made: nothing changed.' END;
            IF NOT v_dry THEN
                PERFORM public.hangtag_platform_log(v_name, 'shop', p_owner::TEXT, jsonb_build_object('outcome', 'failed', 'reason', v_why, 'before', v_before,
                    'args', v_clean, 'error', v_msg, 'sqlstate', v_code), FALSE);
            END IF;
            RETURN jsonb_build_object('ok', FALSE, 'code', 'REFUSED', 'message', v_msg, 'dry_run', v_dry);
    END;
    PERFORM public.hangtag_platform_log(v_name, 'shop', p_owner::TEXT, jsonb_build_object('outcome', 'done', 'reason', v_why, 'before', v_before,
        'after', v_after, 'args', v_clean) || v_extra, TRUE);
    RETURN jsonb_build_object('ok', TRUE, 'dry_run', FALSE, 'action', v_act, 'before', v_before, 'after', v_after) || v_extra;
END $$;

-- The console's dashboard (3w), now with how many customers are in each of the Customers lists. The console makes each
-- of those counts a link that opens its list.
CREATE OR REPLACE FUNCTION public.hangtag_platform_dashboard()
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    r TEXT := public.hangtag_platform_require('dashboard.view');
    n TIMESTAMPTZ := NOW();
    m0 TIMESTAMPTZ := (date_trunc('month', NOW() AT TIME ZONE 'Asia/Kolkata')) AT TIME ZONE 'Asia/Kolkata';
    ending INT;
    shops JSONB; subs JSONB; money JSONB; offers JSONB; usage JSONB; customers JSONB; cur TEXT;
BEGIN
    SELECT c.trial_ending_days INTO ending FROM public.hangtag_platform_config c WHERE c.id;
    SELECT p.currency INTO cur FROM public.hangtag_plans p WHERE p.kind = 'paid' ORDER BY p.sort LIMIT 1;
    SELECT jsonb_build_object('total', count(*), 'new_7d', count(*) FILTER (WHERE p.onboarded_at > n - interval '7 days'),
               'new_30d', count(*) FILTER (WHERE p.onboarded_at > n - interval '30 days'))
      INTO shops FROM public.hangtag_profiles p
     WHERE p.onboarded_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.hangtag_members m WHERE m.user_id = p.id);
    WITH s AS (SELECT public.hangtag_subscription_state(x.owner_id, n) AS st, x.autopay_status AS ap, x.trial_ends_at FROM public.hangtag_subscriptions x)
    SELECT jsonb_build_object(
        'trial', count(*) FILTER (WHERE st = 'trial_active' AND trial_ends_at - n > make_interval(days => COALESCE(ending, 3))),
        'trial_ending', count(*) FILTER (WHERE st = 'trial_active' AND trial_ends_at - n <= make_interval(days => COALESCE(ending, 3))),
        'autopay_setup', count(*) FILTER (WHERE st = 'trial_setup'),
        'active', count(*) FILTER (WHERE st = 'paid_active'),
        'renewing', count(*) FILTER (WHERE st = 'renewal_due'),
        'expired', count(*) FILTER (WHERE st IN ('trial_expired', 'paid_expired')),
        'suspended', count(*) FILTER (WHERE st = 'suspended'),
        'autopay_on', count(*) FILTER (WHERE ap = 'active'),
        'autopay_failing', count(*) FILTER (WHERE ap IN ('past_due', 'halted')),
        'autopay_cancelled', count(*) FILTER (WHERE ap = 'cancelled'))
      INTO subs FROM s;
    WITH w AS MATERIALIZED (SELECT * FROM public.hangtag_platform_shop_rows(NULL))
    SELECT jsonb_object_agg(l.k, (SELECT count(*) FROM w WHERE public.hangtag_platform_in_list(l.k, w.state, w.autopay_status, w.access_until,
               w.last_active, w.payment_failed, n)))
      INTO customers FROM unnest(ARRAY['all', 'trial', 'active', 'payment_failed', 'expiring', 'expired', 'suspended', 'inactive']) AS l(k);
    SELECT jsonb_build_object('currency', COALESCE(cur, 'INR'),
        'month', COALESCE(sum(y.amount) FILTER (WHERE y.captured_at >= m0), 0), 'month_count', count(*) FILTER (WHERE y.captured_at >= m0),
        'last_30d', COALESCE(sum(y.amount) FILTER (WHERE y.captured_at > n - interval '30 days'), 0),
        'autopay_30d', COALESCE(sum(y.amount) FILTER (WHERE y.captured_at > n - interval '30 days' AND y.kind = 'autopay'), 0),
        'failed_7d', (SELECT count(*) FROM public.hangtag_subscription_payments f WHERE f.status = 'failed' AND f.created_at >= n - interval '7 days'))
      INTO money FROM public.hangtag_subscription_payments y WHERE y.captured_at IS NOT NULL;
    SELECT COALESCE(jsonb_agg(jsonb_build_object('code', c.code, 'title', COALESCE(c.title, c.code), 'redeemed', c.redeemed, 'cap', c.max_uses,
               'active', c.active, 'ends_at', c.ends_at) ORDER BY c.code), '[]'::jsonb)
      INTO offers FROM public.hangtag_promo_codes c WHERE c.auto_apply OR c.max_uses IS NOT NULL;
    SELECT jsonb_build_object('bills_24h', (SELECT count(*) FROM public.hangtag_sales x WHERE x.created_at > n - interval '24 hours'),
               'shops_selling_7d', (SELECT count(DISTINCT x.owner_id) FROM public.hangtag_sales x WHERE x.created_at > n - interval '7 days'))
      INTO usage;
    RETURN jsonb_build_object('generated_at', n, 'role', r, 'shops', shops, 'customers', customers, 'subscriptions', subs, 'revenue', money,
        'offers', offers, 'usage', usage);
END $$;

-- Who may call what: the lists, the pages and the action are the console's (each checks the role); the pieces they are
-- built from are not callable by any app user (they read every shop).
REVOKE ALL ON FUNCTION public.hangtag_platform_lifecycle(TEXT, TEXT, TIMESTAMPTZ, INT, TIMESTAMPTZ),
    public.hangtag_platform_in_list(TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, BOOLEAN, TIMESTAMPTZ),
    public.hangtag_platform_matches(TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT), public.hangtag_platform_pay_status(TEXT, TIMESTAMPTZ, TEXT),
    public.hangtag_platform_shop_rows(UUID), public.hangtag_platform_snapshot(UUID), public.hangtag_platform_pay_json(UUID),
    public.hangtag_platform_pay_list(UUID, INT), public.hangtag_platform_sub_json(UUID), public.hangtag_platform_can(TEXT[]),
    public.hangtag_platform_paid_plans(), public.hangtag_platform_list(TEXT, TEXT, TEXT, TEXT, INT, INT),
    public.hangtag_platform_customers(TEXT, TEXT, TEXT, INT, INT), public.hangtag_platform_subscriptions(TEXT, TEXT, TEXT, INT, INT),
    public.hangtag_platform_customer(UUID), public.hangtag_platform_subscription(UUID),
    public.hangtag_platform_payments(TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, INT, INT, INT), public.hangtag_platform_payment(UUID),
    public.hangtag_platform_customer_action(UUID, TEXT, TEXT, JSONB, BOOLEAN) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hangtag_platform_customers(TEXT, TEXT, TEXT, INT, INT), public.hangtag_platform_subscriptions(TEXT, TEXT, TEXT, INT, INT),
    public.hangtag_platform_customer(UUID), public.hangtag_platform_subscription(UUID),
    public.hangtag_platform_payments(TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, INT, INT, INT), public.hangtag_platform_payment(UUID),
    public.hangtag_platform_customer_action(UUID, TEXT, TEXT, JSONB, BOOLEAN) TO authenticated;
