-- Hangtag: commercial plans, the launch offer, the 30-day trial with AutoPay, and the Platform Console (Phases 53-55).
-- Exactly section 3w of supabase/schema.sql. Needs section 3t (20261006120000_hangtag_plans_subscriptions.sql) first.
-- Run it in the Supabase SQL Editor; safe to run again. Then the report at the end of schema.sql: rows 80-86.

-- ==============================================================================
-- 3w. Commercial plans, the launch offer, the 30-day trial with AutoPay, and the Platform Console (Phases 53–55)
--   Plans: Monthly, 3 Months, 6 Months and 12 Months, priced in hangtag_plans (display order = sort, on sale = active).
--   Their starting prices are set once, over the earlier starting prices only: a price changed since is kept.
--   Campaigns are promo codes (hangtag_promo_codes) with a few more fields: a title, offered on their plans without a code
--   (auto_apply), only for shops that never paid (new_customers_only), a fixed offer price (kind 'price'), and a
--   redemption counter with a hard cap (redeemed <= max_uses, held by the table itself). A checkout of a capped offer holds
--   a place while its payment page is open; a payment the provider confirms after the offer filled up never takes a place
--   beyond the cap: it is honoured as the plan that costs what was paid (or kept for review). The launch offer
--   (LAUNCH100: 3 Months for 999, the first 100 customers) is one such row: its price, cap and dates are data, changed in
--   the Platform Console or with an UPDATE — never in code.
--   The trial: 30 days from the end of shop setup. Once AutoPay is set up for Hangtag (hangtag_platform_config.
--   autopay_enabled, after the subscription function has its provider plan) and required for trials (trial_requires_autopay),
--   a new trial is used after the owner set up AutoPay: nothing to pay today, the AutoPay plan (Monthly) after the trial,
--   cancel any time before it renews. Only the payment provider (the subscription Edge Functions, service role) moves
--   AutoPay: authorised, charged, failing (past_due: access kept for renewal_grace_hours while it retries), halted or
--   cancelled. A charge the provider captured adds a paid period from the end of the trial or plan, so no day is lost.
--   Shops whose trial began before this keep it as it is.
--   Money received: a payment is captured (captured_at) only when the provider captured a real amount — never a trial,
--   an AutoPay set-up, a free promo or a grant. Referral rewards and staff commissions may only ever be computed from
--   captured payments.
--   The Platform Console (platform/): Hangtag's own staff (hangtag_platform_staff, by account id — never by email), one
--   role each: super_admin, admin, billing_admin, support_admin, read_only. Every console function checks the caller's role
--   here, answers with totals (never a shop's own rows) and records each privileged action in hangtag_platform_audit. The
--   shops' data stays behind their row security: a staff account reaches none of it.
--   Safe to run again.
-- ==============================================================================

-- ---------- plans and their starting prices ----------
INSERT INTO public.hangtag_plans (code, label, kind, months, days, price, sort) VALUES ('m12', '12 Months', 'paid', 12, NULL, 7999, 4)
ON CONFLICT (code) DO NOTHING;
UPDATE public.hangtag_plans p SET price = v.new_price, updated_at = NOW()
  FROM (VALUES ('m1', 499, 999), ('m3', 1349, 2499), ('m6', 2499, 4499)) v(code, old_price, new_price)
 WHERE p.code = v.code AND p.price = v.old_price;
UPDATE public.hangtag_plans p SET label = v.new_label, updated_at = NOW()
  FROM (VALUES ('m1', '1 month', 'Monthly'), ('m3', '3 months', '3 Months'), ('m6', '6 months', '6 Months')) v(code, old_label, new_label)
 WHERE p.code = v.code AND p.label = v.old_label;
UPDATE public.hangtag_plans SET days = 30, updated_at = NOW() WHERE code = 'trial' AND days = 7;

-- ---------- campaigns: promo codes with a title, offered without a code, for new customers, a fixed price, a counter ----------
ALTER TABLE public.hangtag_promo_codes ADD COLUMN IF NOT EXISTS title TEXT;
ALTER TABLE public.hangtag_promo_codes ADD COLUMN IF NOT EXISTS auto_apply BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE public.hangtag_promo_codes ADD COLUMN IF NOT EXISTS new_customers_only BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE public.hangtag_promo_codes ADD COLUMN IF NOT EXISTS redeemed INT NOT NULL DEFAULT 0;
ALTER TABLE public.hangtag_promo_codes ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE public.hangtag_promo_codes DROP CONSTRAINT IF EXISTS hangtag_promo_codes_kind_check;
ALTER TABLE public.hangtag_promo_codes ADD CONSTRAINT hangtag_promo_codes_kind_check CHECK (kind IN ('percent', 'fixed', 'price'));
ALTER TABLE public.hangtag_promo_codes DROP CONSTRAINT IF EXISTS hangtag_promo_codes_title_check;
ALTER TABLE public.hangtag_promo_codes ADD CONSTRAINT hangtag_promo_codes_title_check CHECK (title IS NULL OR char_length(btrim(title)) BETWEEN 1 AND 60);
-- the counter starts from the redemptions already made, then the activation keeps it
UPDATE public.hangtag_promo_codes c SET redeemed = r.n
  FROM (SELECT code, count(*)::INT AS n FROM public.hangtag_promo_redemptions GROUP BY code) r
 WHERE r.code = c.code AND c.redeemed < r.n;
-- the hard cap: never more redemptions than max_uses (rows from before this are not re-checked)
ALTER TABLE public.hangtag_promo_codes DROP CONSTRAINT IF EXISTS hangtag_promo_codes_redeemed_check;
ALTER TABLE public.hangtag_promo_codes ADD CONSTRAINT hangtag_promo_codes_redeemed_check CHECK (redeemed >= 0 AND (max_uses IS NULL OR redeemed <= max_uses)) NOT VALID;
-- the launch offer: 3 Months for 999, the first 100 customers (its fields are data: change them in the console)
INSERT INTO public.hangtag_promo_codes (code, kind, value, plans, max_uses, per_account_limit, active, title, auto_apply, new_customers_only, note)
VALUES ('LAUNCH100', 'price', 999, ARRAY['m3'], 100, 1, TRUE, 'Launch offer', TRUE, TRUE, 'Launch offer: 3 Months for 999, for the first 100 customers')
ON CONFLICT (code) DO NOTHING;

-- ---------- payments: one-time or AutoPay; when the provider captured the money ----------
ALTER TABLE public.hangtag_subscription_payments ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'one_time';
ALTER TABLE public.hangtag_subscription_payments DROP CONSTRAINT IF EXISTS hangtag_subscription_payments_kind_check;
ALTER TABLE public.hangtag_subscription_payments ADD CONSTRAINT hangtag_subscription_payments_kind_check CHECK (kind IN ('one_time', 'autopay'));
ALTER TABLE public.hangtag_subscription_payments ADD COLUMN IF NOT EXISTS captured_at TIMESTAMPTZ;
UPDATE public.hangtag_subscription_payments SET captured_at = paid_at
 WHERE status = 'paid' AND amount > 0 AND provider NOT IN ('manual', 'free') AND captured_at IS NULL AND paid_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_hangtag_subscription_payments_captured ON public.hangtag_subscription_payments (captured_at) WHERE captured_at IS NOT NULL;

-- ---------- a shop's AutoPay: the provider's subscription (the mandate), its state, the owner's consent ----------
ALTER TABLE public.hangtag_subscriptions ADD COLUMN IF NOT EXISTS autopay_required BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE public.hangtag_subscriptions ADD COLUMN IF NOT EXISTS autopay_status TEXT NOT NULL DEFAULT 'none';
ALTER TABLE public.hangtag_subscriptions ADD COLUMN IF NOT EXISTS autopay_plan_code TEXT REFERENCES public.hangtag_plans(code);
ALTER TABLE public.hangtag_subscriptions ADD COLUMN IF NOT EXISTS autopay_provider TEXT;
ALTER TABLE public.hangtag_subscriptions ADD COLUMN IF NOT EXISTS autopay_subscription_id TEXT;
ALTER TABLE public.hangtag_subscriptions ADD COLUMN IF NOT EXISTS autopay_customer_id TEXT;
ALTER TABLE public.hangtag_subscriptions ADD COLUMN IF NOT EXISTS autopay_consent_at TIMESTAMPTZ;
ALTER TABLE public.hangtag_subscriptions ADD COLUMN IF NOT EXISTS autopay_consent_version TEXT;
ALTER TABLE public.hangtag_subscriptions ADD COLUMN IF NOT EXISTS autopay_authorized_at TIMESTAMPTZ;
ALTER TABLE public.hangtag_subscriptions ADD COLUMN IF NOT EXISTS autopay_next_charge_at TIMESTAMPTZ;
ALTER TABLE public.hangtag_subscriptions ADD COLUMN IF NOT EXISTS autopay_failed_at TIMESTAMPTZ;
ALTER TABLE public.hangtag_subscriptions ADD COLUMN IF NOT EXISTS autopay_cancelled_at TIMESTAMPTZ;
ALTER TABLE public.hangtag_subscriptions DROP CONSTRAINT IF EXISTS hangtag_subscriptions_autopay_status_check;
ALTER TABLE public.hangtag_subscriptions ADD CONSTRAINT hangtag_subscriptions_autopay_status_check
    CHECK (autopay_status IN ('none', 'pending', 'active', 'past_due', 'halted', 'cancelled'));
ALTER TABLE public.hangtag_subscriptions DROP CONSTRAINT IF EXISTS hangtag_subscriptions_autopay_ids_check;
ALTER TABLE public.hangtag_subscriptions ADD CONSTRAINT hangtag_subscriptions_autopay_ids_check CHECK (
    (autopay_provider IS NULL OR autopay_provider ~ '^[a-z][a-z0-9_]{1,30}$')
    AND (autopay_subscription_id IS NULL OR char_length(autopay_subscription_id) BETWEEN 1 AND 120)
    AND (autopay_customer_id IS NULL OR char_length(autopay_customer_id) BETWEEN 1 AND 120)
    AND (autopay_consent_version IS NULL OR char_length(autopay_consent_version) <= 40));
CREATE UNIQUE INDEX IF NOT EXISTS idx_hangtag_subscriptions_autopay ON public.hangtag_subscriptions (autopay_provider, autopay_subscription_id)
    WHERE autopay_subscription_id IS NOT NULL;

-- ---------- Hangtag's own commercial settings (one row; changed in the Platform Console by a super admin) ----------
CREATE TABLE IF NOT EXISTS public.hangtag_platform_config (
    id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
    autopay_enabled BOOLEAN NOT NULL DEFAULT FALSE,           -- AutoPay is set up (the subscription function and its provider plan)
    trial_requires_autopay BOOLEAN NOT NULL DEFAULT TRUE,     -- new trials need AutoPay set up first (only while autopay_enabled)
    autopay_plan_code TEXT NOT NULL DEFAULT 'm1' REFERENCES public.hangtag_plans(code),   -- what AutoPay renews after the trial
    trial_ending_days INT NOT NULL DEFAULT 3 CHECK (trial_ending_days BETWEEN 1 AND 14),
    renewal_grace_hours INT NOT NULL DEFAULT 48 CHECK (renewal_grace_hours BETWEEN 0 AND 168),
    autopay_consent_version TEXT NOT NULL DEFAULT 'autopay-2026-10' CHECK (autopay_consent_version ~ '^[a-z0-9._-]{3,40}$'),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by UUID
);
INSERT INTO public.hangtag_platform_config (id) VALUES (TRUE) ON CONFLICT (id) DO NOTHING;

-- ---------- the Platform Console's staff and its audit log ----------
CREATE TABLE IF NOT EXISTS public.hangtag_platform_staff (
    user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('super_admin', 'admin', 'billing_admin', 'support_admin', 'read_only')),
    active BOOLEAN NOT NULL DEFAULT TRUE,
    display_name TEXT CHECK (display_name IS NULL OR char_length(btrim(display_name)) BETWEEN 1 AND 60),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by UUID,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS public.hangtag_platform_audit (
    id BIGSERIAL PRIMARY KEY,
    t TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    actor UUID,                       -- the account (no link: the log outlives a removed account)
    actor_role TEXT,
    action TEXT NOT NULL CHECK (action ~ '^[a-z][a-z0-9_.]{2,60}$'),
    target_type TEXT CHECK (target_type IS NULL OR char_length(target_type) <= 40),
    target_id TEXT CHECK (target_id IS NULL OR char_length(target_id) <= 120),
    detail JSONB NOT NULL DEFAULT '{}'::jsonb,
    ok BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE INDEX IF NOT EXISTS idx_hangtag_platform_audit_t ON public.hangtag_platform_audit (t DESC);
CREATE INDEX IF NOT EXISTS idx_hangtag_platform_audit_actor ON public.hangtag_platform_audit (actor, t DESC);

-- ---------- the trial (30 days; AutoPay required for new trials when it is set up and switched on) ----------
CREATE OR REPLACE FUNCTION public.hangtag_subscription_ensure(p_owner UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    trial_days INT;
    em TEXT;
    k TEXT;
    nk TEXT;
    lp TEXT;
    dom TEXT;
    claimed UUID;
    started TIMESTAMPTZ := NOW();
    need_ap BOOLEAN := FALSE;
    ap_plan TEXT;
BEGIN
    IF p_owner IS NULL OR EXISTS (SELECT 1 FROM public.hangtag_subscriptions s WHERE s.owner_id = p_owner) THEN RETURN; END IF;
    IF EXISTS (SELECT 1 FROM public.hangtag_members m WHERE m.user_id = p_owner) THEN RETURN; END IF;
    IF NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = p_owner) THEN RETURN; END IF;
    SELECT p.days INTO trial_days FROM public.hangtag_plans p WHERE p.code = 'trial';
    trial_days := COALESCE(trial_days, 30);
    SELECT c.autopay_enabled AND c.trial_requires_autopay, c.autopay_plan_code INTO need_ap, ap_plan FROM public.hangtag_platform_config c WHERE c.id;
    SELECT lower(btrim(u.email)) INTO em FROM auth.users u WHERE u.id = p_owner;
    IF COALESCE(em, '') <> '' THEN
        k := md5(em);
        lp := regexp_replace(split_part(em, '@', 1), '\+.*$', '');
        dom := split_part(em, '@', 2);
        IF dom IN ('gmail.com', 'googlemail.com') THEN lp := replace(lp, '.', ''); dom := 'gmail.com'; END IF;
        nk := md5(lp || '@' || dom);
        INSERT INTO public.hangtag_trial_claims (email_key, owner_id) VALUES (nk, p_owner) ON CONFLICT (email_key) DO NOTHING;
        IF k <> nk THEN INSERT INTO public.hangtag_trial_claims (email_key, owner_id) VALUES (k, p_owner) ON CONFLICT (email_key) DO NOTHING; END IF;
        SELECT c.owner_id INTO claimed FROM public.hangtag_trial_claims c WHERE c.email_key IN (k, nk) AND c.owner_id <> p_owner LIMIT 1;
    END IF;
    INSERT INTO public.hangtag_subscriptions (owner_id, trial_started_at, trial_ends_at, autopay_required, autopay_plan_code)
    VALUES (p_owner, started, CASE WHEN claimed IS NOT NULL THEN started ELSE started + make_interval(days => trial_days) END,
            COALESCE(need_ap, FALSE), ap_plan)
    ON CONFLICT (owner_id) DO NOTHING;
END $$;

-- trial_active · trial_setup (the trial waits for AutoPay) · paid_active · renewal_due (AutoPay is collecting the renewal:
-- access kept for the grace hours) · trial_expired · paid_expired · suspended · none (no plan record: setup not finished)
CREATE OR REPLACE FUNCTION public.hangtag_subscription_state(p_owner UUID, p_now TIMESTAMPTZ DEFAULT NOW())
RETURNS TEXT LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE s RECORD; grace INT;
BEGIN
    SELECT x.suspended, x.trial_ends_at, x.period_end, x.autopay_required, x.autopay_status, x.autopay_authorized_at INTO s
      FROM public.hangtag_subscriptions x WHERE x.owner_id = p_owner;
    IF NOT FOUND THEN RETURN 'none'; END IF;
    IF s.suspended THEN RETURN 'suspended'; END IF;
    IF s.period_end IS NOT NULL AND s.period_end > p_now THEN RETURN 'paid_active'; END IF;
    IF s.trial_ends_at > p_now THEN
        IF s.autopay_required AND s.autopay_authorized_at IS NULL THEN RETURN 'trial_setup'; END IF;
        RETURN 'trial_active';
    END IF;
    IF s.autopay_status IN ('active', 'past_due') THEN
        SELECT c.renewal_grace_hours INTO grace FROM public.hangtag_platform_config c WHERE c.id;
        IF p_now < GREATEST(s.trial_ends_at, s.period_end) + make_interval(hours => COALESCE(grace, 48)) THEN RETURN 'renewal_due'; END IF;
    END IF;
    IF s.period_end IS NOT NULL THEN RETURN 'paid_expired'; END IF;
    RETURN 'trial_expired';
END $$;

-- whether a shop may use Hangtag now: a running trial (with AutoPay set up when it needs it), a running plan, a renewal
-- AutoPay is collecting — or a shop whose setup isn't finished and has no record yet
CREATE OR REPLACE FUNCTION public.hangtag_access_ok(p_owner UUID)
RETURNS BOOLEAN LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE st TEXT := public.hangtag_subscription_state(p_owner, NOW());
BEGIN
    IF st IN ('trial_active', 'paid_active', 'renewal_due') THEN RETURN TRUE; END IF;
    IF st = 'none' THEN
        RETURN NOT EXISTS (SELECT 1 FROM public.hangtag_profiles p WHERE p.id = p_owner AND p.onboarded_at IS NOT NULL);
    END IF;
    RETURN FALSE;
END $$;

-- 1. The plan of the caller's shop (owner or team member), for the app's lock and Plans & Billing. Works while locked.
--    lifecycle: trial · trial_ending · autopay_required · active · renewing · past_due · cancelled · halted · expired ·
--    suspended · none. The owner also gets the shop's AutoPay.
CREATE OR REPLACE FUNCTION public.hangtag_subscription_status()
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    shop UUID := public.hangtag_shop_id();
    n TIMESTAMPTZ := NOW();
    s RECORD;
    cfg RECORD;
    ap RECORD;
    st TEXT;
    lc TEXT;
    plan_label TEXT;
    trial_days INT;
    until_at TIMESTAMPTZ;
    owner BOOLEAN;
BEGIN
    IF shop IS NULL THEN
        RETURN jsonb_build_object('state', 'none', 'lifecycle', 'none', 'server_now', n, 'is_owner', FALSE, 'days_left', 0, 'suspended', FALSE);
    END IF;
    owner := shop = auth.uid();
    IF EXISTS (SELECT 1 FROM public.hangtag_profiles p WHERE p.id = shop AND p.onboarded_at IS NOT NULL) THEN
        PERFORM public.hangtag_subscription_ensure(shop);
    END IF;
    SELECT * INTO s FROM public.hangtag_subscriptions x WHERE x.owner_id = shop;
    SELECT * INTO cfg FROM public.hangtag_platform_config c WHERE c.id;
    st := public.hangtag_subscription_state(shop, n);
    SELECT p.days INTO trial_days FROM public.hangtag_plans p WHERE p.code = 'trial';
    IF s.owner_id IS NULL THEN
        RETURN jsonb_build_object('state', st, 'lifecycle', st, 'server_now', n, 'is_owner', owner, 'days_left', 0, 'suspended', FALSE,
            'trial_days', COALESCE(trial_days, 30));
    END IF;
    SELECT p.label INTO plan_label FROM public.hangtag_plans p WHERE p.code = s.plan_code;
    until_at := GREATEST(s.trial_ends_at, s.period_end);
    IF st = 'renewal_due' THEN until_at := until_at + make_interval(hours => COALESCE(cfg.renewal_grace_hours, 48)); END IF;
    lc := CASE
        WHEN st = 'suspended' THEN 'suspended'
        WHEN st = 'trial_setup' THEN 'autopay_required'
        WHEN st = 'trial_active' THEN CASE WHEN s.autopay_status = 'cancelled' THEN 'cancelled'
            WHEN s.trial_ends_at - n <= make_interval(days => COALESCE(cfg.trial_ending_days, 3)) THEN 'trial_ending' ELSE 'trial' END
        WHEN st = 'paid_active' THEN CASE WHEN s.autopay_status = 'cancelled' THEN 'cancelled' WHEN s.autopay_status = 'past_due' THEN 'past_due' ELSE 'active' END
        WHEN st = 'renewal_due' THEN CASE WHEN s.autopay_status = 'past_due' THEN 'past_due' ELSE 'renewing' END
        WHEN st IN ('trial_expired', 'paid_expired') THEN CASE WHEN s.autopay_status = 'halted' THEN 'halted' ELSE 'expired' END
        ELSE st END;
    IF owner THEN
        SELECT p.code, p.label, p.price, p.currency INTO ap FROM public.hangtag_plans p WHERE p.code = COALESCE(s.autopay_plan_code, cfg.autopay_plan_code);
    END IF;
    RETURN jsonb_build_object(
        'state', st,
        'lifecycle', lc,
        'plan_code', s.plan_code,
        'plan_label', plan_label,
        'trial_days', COALESCE(trial_days, 30),
        'trial_ending_days', COALESCE(cfg.trial_ending_days, 3),
        'trial_started_at', s.trial_started_at,
        'trial_ends_at', s.trial_ends_at,
        'period_start', s.period_start,
        'period_end', s.period_end,
        'access_until', until_at,
        'days_left', CASE WHEN st IN ('trial_active', 'paid_active', 'renewal_due') THEN GREATEST(0, ceil(extract(epoch FROM (until_at - n)) / 86400))::INT ELSE 0 END,
        'server_now', n,
        'is_owner', owner,
        'suspended', s.suspended,
        'suspended_reason', CASE WHEN owner THEN s.suspended_reason END,
        'autopay', CASE WHEN owner THEN jsonb_build_object(
            'status', s.autopay_status, 'required', s.autopay_required, 'set_up', s.autopay_subscription_id IS NOT NULL,
            'plan_code', ap.code, 'plan_label', ap.label, 'price', ap.price, 'currency', ap.currency,
            'authorized_at', s.autopay_authorized_at, 'consent_at', s.autopay_consent_at,
            'next_charge_at', CASE WHEN s.autopay_status IN ('pending', 'active', 'past_due') THEN s.autopay_next_charge_at END,
            'failed_at', s.autopay_failed_at, 'cancelled_at', s.autopay_cancelled_at) END);
END $$;

-- (internal) A promo code checked for a shop and a plan: { code, valid, reason, message, kind, value, discount, title,
-- auto, remaining }. Counted uses: the counter (paid redemptions), plus checkouts other shops opened in the last 30 minutes,
-- so a burst of checkouts cannot overrun the cap and trying again does not block yourself (the cap itself is held at
-- activation).
CREATE OR REPLACE FUNCTION public.hangtag_promo_evaluate(p_owner UUID, p_plan TEXT, p_code TEXT)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    v_code TEXT := upper(btrim(COALESCE(p_code, '')));
    c RECORD;
    pl RECORD;
    held INT;
    used_total INT;
    used_mine INT;
    disc NUMERIC(12,2);
    reason TEXT;
    msg TEXT;
BEGIN
    SELECT p.code, p.label, p.price INTO pl FROM public.hangtag_plans p WHERE p.code = p_plan;
    IF v_code !~ '^[A-Z0-9_-]{3,32}$' THEN
        RETURN jsonb_build_object('code', v_code, 'valid', FALSE, 'reason', 'invalid', 'message', 'This promo code isn''t valid.', 'discount', 0);
    END IF;
    SELECT * INTO c FROM public.hangtag_promo_codes x WHERE x.code = v_code;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('code', v_code, 'valid', FALSE, 'reason', 'invalid', 'message', 'This promo code isn''t valid.', 'discount', 0);
    END IF;
    SELECT count(*) INTO used_mine FROM public.hangtag_promo_redemptions r WHERE r.code = v_code AND r.owner_id = p_owner;
    SELECT count(*) INTO held FROM public.hangtag_subscription_payments y WHERE y.promo_code = v_code AND y.status = 'created'
       AND y.created_at > NOW() - interval '30 minutes' AND y.owner_id IS DISTINCT FROM p_owner;
    used_total := GREATEST(c.redeemed, 0) + held;
    IF NOT c.active THEN reason := 'inactive'; msg := 'This promo code is no longer active.';
    ELSIF c.starts_at IS NOT NULL AND c.starts_at > NOW() THEN reason := 'not_started'; msg := 'This promo code isn''t active yet.';
    ELSIF c.ends_at IS NOT NULL AND c.ends_at <= NOW() THEN reason := 'expired'; msg := 'This promo code has expired.';
    ELSIF c.plans IS NOT NULL AND NOT (p_plan = ANY (c.plans)) THEN
        reason := 'not_for_plan'; msg := 'This promo code isn''t for the ' || COALESCE(pl.label, 'chosen') || ' plan.';
    ELSIF c.new_customers_only AND EXISTS (SELECT 1 FROM public.hangtag_subscription_payments y WHERE y.owner_id = p_owner AND y.status = 'paid' AND y.amount > 0) THEN
        reason := 'not_new'; msg := 'This offer is for new customers.';
    ELSIF used_mine >= c.per_account_limit THEN reason := 'already_used'; msg := 'You have already used this promo code.';
    ELSIF c.max_uses IS NOT NULL AND used_total >= c.max_uses THEN
        reason := 'used_up'; msg := CASE WHEN c.auto_apply THEN 'This offer has been fully claimed.' ELSE 'This promo code has been fully used.' END;
    END IF;
    IF reason IS NOT NULL THEN
        RETURN jsonb_build_object('code', v_code, 'valid', FALSE, 'reason', reason, 'message', msg, 'kind', c.kind, 'value', c.value, 'discount', 0,
            'title', c.title, 'auto', c.auto_apply);
    END IF;
    disc := CASE c.kind WHEN 'percent' THEN round(COALESCE(pl.price, 0) * c.value / 100, 2) WHEN 'price' THEN COALESCE(pl.price, 0) - c.value ELSE c.value END;
    disc := LEAST(GREATEST(disc, 0), COALESCE(pl.price, 0));
    RETURN jsonb_build_object('code', v_code, 'valid', TRUE, 'reason', NULL,
        'message', CASE WHEN c.auto_apply THEN COALESCE(c.title, 'Offer') || ' applied.' ELSE 'Promo code applied.' END,
        'kind', c.kind, 'value', c.value, 'discount', disc, 'title', c.title, 'auto', c.auto_apply,
        'remaining', CASE WHEN c.max_uses IS NOT NULL THEN GREATEST(c.max_uses - used_total, 0) END);
END $$;

-- (internal) The best offer a shop may take on a plan without typing a code (the largest discount), or NULL
CREATE OR REPLACE FUNCTION public.hangtag_offer_for(p_owner UUID, p_plan TEXT)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE c RECORD; e JSONB; best JSONB;
BEGIN
    FOR c IN SELECT x.code FROM public.hangtag_promo_codes x
              WHERE x.auto_apply AND x.active AND (x.plans IS NULL OR p_plan = ANY (x.plans)) ORDER BY x.code LOOP
        e := public.hangtag_promo_evaluate(p_owner, p_plan, c.code);
        IF (e ->> 'valid')::BOOLEAN AND (e ->> 'discount')::NUMERIC > 0
           AND (best IS NULL OR (e ->> 'discount')::NUMERIC > (best ->> 'discount')::NUMERIC) THEN best := e; END IF;
    END LOOP;
    RETURN best;
END $$;

-- 2. The plans on sale in display order, each with the offer the caller's shop may take on it:
--    [{ code, label, months, price, currency, offer: { code, title, price, discount, remaining } | null }]
CREATE OR REPLACE FUNCTION public.hangtag_subscription_plans()
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE shop UUID := public.hangtag_shop_id(); out JSONB := '[]'::jsonb; p RECORD; o JSONB;
BEGIN
    FOR p IN SELECT x.code, x.label, x.months, x.price, x.currency FROM public.hangtag_plans x WHERE x.kind = 'paid' AND x.active ORDER BY x.sort, x.months LOOP
        o := CASE WHEN shop IS NOT NULL THEN public.hangtag_offer_for(shop, p.code) END;
        out := out || jsonb_build_array(jsonb_build_object('code', p.code, 'label', p.label, 'months', p.months, 'price', p.price, 'currency', p.currency,
            'offer', CASE WHEN o IS NOT NULL THEN jsonb_build_object('code', o ->> 'code', 'title', o ->> 'title', 'price', p.price - (o ->> 'discount')::NUMERIC,
                'discount', (o ->> 'discount')::NUMERIC, 'remaining', o -> 'remaining') END));
    END LOOP;
    RETURN out;
END $$;

-- 3. The price of a plan with a promo code — or, without one, with the best offer the shop may take — computed here (the owner only)
CREATE OR REPLACE FUNCTION public.hangtag_subscription_quote(p_plan TEXT, p_promo TEXT DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    me UUID := public.hangtag_subscription_owner();
    pl RECORD;
    promo JSONB;
    disc NUMERIC(12,2) := 0;
BEGIN
    SELECT p.code, p.label, p.months, p.price, p.currency INTO pl FROM public.hangtag_plans p WHERE p.code = p_plan AND p.kind = 'paid' AND p.active;
    IF NOT FOUND THEN RAISE EXCEPTION 'Choose a plan.' USING ERRCODE = 'P0001'; END IF;
    IF btrim(COALESCE(p_promo, '')) <> '' THEN
        promo := public.hangtag_promo_evaluate(me, pl.code, p_promo);
    ELSE
        promo := public.hangtag_offer_for(me, pl.code);
    END IF;
    IF promo IS NOT NULL AND (promo ->> 'valid')::BOOLEAN THEN disc := (promo ->> 'discount')::NUMERIC; END IF;
    RETURN jsonb_build_object('ok', TRUE, 'plan', jsonb_build_object('code', pl.code, 'label', pl.label, 'months', pl.months),
        'price', pl.price, 'discount', disc, 'amount', pl.price - disc, 'currency', pl.currency, 'promo', promo);
END $$;

-- 4. A payment for a plan, with the price and discount computed here (the owner only; the subscription Edge Function calls
-- it as the owner). A refused promo code refuses the checkout with its message. While AutoPay is set up the shop's plan
-- renews by itself: AutoPay is turned off first (no double payment).
CREATE OR REPLACE FUNCTION public.hangtag_subscription_checkout(p_plan TEXT, p_promo TEXT DEFAULT NULL, p_provider TEXT DEFAULT 'razorpay')
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    me UUID := public.hangtag_subscription_owner();
    q JSONB;
    pid UUID;
    prov TEXT := lower(btrim(COALESCE(p_provider, '')));
BEGIN
    IF prov !~ '^[a-z][a-z0-9_]{1,30}$' OR prov IN ('manual', 'free') THEN RAISE EXCEPTION 'Choose a way to pay.' USING ERRCODE = 'P0001'; END IF;
    IF EXISTS (SELECT 1 FROM public.hangtag_subscriptions s WHERE s.owner_id = me AND s.autopay_status IN ('pending', 'active', 'past_due')
                 AND s.autopay_subscription_id IS NOT NULL) THEN
        RAISE EXCEPTION 'AutoPay is set up for this shop. Turn AutoPay off before paying for a plan.' USING ERRCODE = 'P0001';
    END IF;
    IF (SELECT count(*) FROM public.hangtag_subscription_payments y WHERE y.owner_id = me AND y.created_at > NOW() - interval '1 hour') >= 20 THEN
        RAISE EXCEPTION 'Too many payment attempts. Try again in an hour.' USING ERRCODE = 'P0001';
    END IF;
    -- one checkout at a time per code (typed, or the offers that apply by themselves), so a burst of checkouts is counted
    -- against the limits one by one
    IF btrim(COALESCE(p_promo, '')) <> '' THEN
        PERFORM 1 FROM public.hangtag_promo_codes c WHERE c.code = upper(btrim(p_promo)) FOR UPDATE;
    ELSE
        PERFORM 1 FROM public.hangtag_promo_codes c WHERE c.auto_apply AND c.active AND (c.plans IS NULL OR p_plan = ANY (c.plans)) ORDER BY c.code FOR UPDATE;
    END IF;
    q := public.hangtag_subscription_quote(p_plan, p_promo);
    IF q -> 'promo' IS NOT NULL AND jsonb_typeof(q -> 'promo') = 'object' AND NOT (q #>> '{promo,valid}')::BOOLEAN THEN
        RAISE EXCEPTION '%', q #>> '{promo,message}' USING ERRCODE = 'P0001';
    END IF;
    INSERT INTO public.hangtag_subscription_payments (owner_id, plan_code, price, discount, amount, currency, promo_code, provider, created_by)
    VALUES (me, q #>> '{plan,code}', (q ->> 'price')::NUMERIC, (q ->> 'discount')::NUMERIC, (q ->> 'amount')::NUMERIC, q ->> 'currency',
            CASE WHEN (q #>> '{promo,valid}')::BOOLEAN THEN q #>> '{promo,code}' END,
            CASE WHEN (q ->> 'amount')::NUMERIC = 0 THEN 'free' ELSE prov END, me)
    RETURNING id INTO pid;
    RETURN jsonb_build_object('payment_id', pid, 'plan_code', q #>> '{plan,code}', 'plan_label', q #>> '{plan,label}',
        'price', (q ->> 'price')::NUMERIC, 'discount', (q ->> 'discount')::NUMERIC, 'amount', (q ->> 'amount')::NUMERIC,
        'currency', q ->> 'currency', 'promo_code', CASE WHEN (q #>> '{promo,valid}')::BOOLEAN THEN q #>> '{promo,code}' END);
END $$;

-- 7. (service role) the provider confirmed the payment: activate it. Idempotent; the amount must be exactly the amount due.
--    A promo code's limits are checked again under a lock: nothing to pay → refused; money taken is honoured. The cap of an
--    offer is never passed: when it filled up before this payment was confirmed, the payment is honoured as the plan that
--    costs what was paid (or kept on its plan for review) and the offer is not redeemed again.
CREATE OR REPLACE FUNCTION public.hangtag_subscription_activate(p_payment UUID, p_provider_payment TEXT, p_amount NUMERIC)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    pay RECORD;
    per JSONB;
    lim RECORD;
    mine_over BOOLEAN := FALSE;
    full_now BOOLEAN := FALSE;
    alt TEXT;
    plan_now TEXT;
    note_now TEXT;
BEGIN
    SELECT * INTO pay FROM public.hangtag_subscription_payments y WHERE y.id = p_payment FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Payment not found.' USING ERRCODE = 'P0002'; END IF;
    IF pay.status = 'paid' THEN
        RETURN jsonb_build_object('ok', TRUE, 'already', TRUE, 'state', public.hangtag_subscription_state(pay.owner_id, NOW()),
            'plan_code', pay.plan_code, 'period_start', pay.period_start, 'period_end', pay.period_end);
    END IF;
    IF p_amount IS NULL OR round(p_amount, 2) <> pay.amount THEN
        RAISE EXCEPTION 'The amount paid is not the amount due.' USING ERRCODE = 'P0001';
    END IF;
    IF pay.amount > 0 AND btrim(COALESCE(p_provider_payment, '')) = '' THEN
        RAISE EXCEPTION 'The provider''s payment reference is missing.' USING ERRCODE = 'P0001';
    END IF;
    plan_now := pay.plan_code; note_now := pay.note;
    IF pay.promo_code IS NOT NULL THEN
        SELECT c.max_uses, c.per_account_limit, c.redeemed INTO lim FROM public.hangtag_promo_codes c WHERE c.code = pay.promo_code FOR UPDATE;
        mine_over := (SELECT count(*) FROM public.hangtag_promo_redemptions r WHERE r.code = pay.promo_code AND r.owner_id = pay.owner_id) >= COALESCE(lim.per_account_limit, 1);
        full_now := lim.max_uses IS NOT NULL AND COALESCE(lim.redeemed, 0) >= lim.max_uses;
        IF (mine_over OR full_now) AND pay.amount = 0 THEN
            UPDATE public.hangtag_subscription_payments SET status = 'failed', note = 'Promo code limit reached' WHERE id = pay.id;
            RETURN jsonb_build_object('ok', FALSE, 'refused', TRUE, 'reason', 'promo_limit', 'message', 'This promo code has already been used.');
        END IF;
        IF full_now THEN
            SELECT p.code INTO alt FROM public.hangtag_plans p WHERE p.kind = 'paid' AND p.price = pay.amount ORDER BY p.active DESC, p.months DESC LIMIT 1;
            IF alt IS NOT NULL THEN plan_now := alt; note_now := 'Offer full when paid: honoured as ' || alt;
            ELSE note_now := 'Review: offer full when paid'; END IF;
        ELSIF mine_over THEN
            note_now := 'Review: promo code used beyond its limit';
        END IF;
    END IF;
    -- money the provider confirmed is honoured even if the checkout had been marked expired or cancelled meanwhile
    per := public.hangtag_subscription_extend(pay.owner_id, plan_now);
    UPDATE public.hangtag_subscription_payments SET status = 'paid', plan_code = plan_now,
        price = CASE WHEN alt IS NOT NULL THEN pay.amount ELSE price END,
        discount = CASE WHEN alt IS NOT NULL THEN 0 ELSE discount END,
        promo_code = CASE WHEN full_now THEN NULL ELSE promo_code END,
        provider_payment_id = NULLIF(btrim(COALESCE(p_provider_payment, '')), ''),
        paid_at = NOW(), captured_at = CASE WHEN pay.amount > 0 AND pay.provider NOT IN ('manual', 'free') THEN NOW() END,
        period_start = (per ->> 'start')::TIMESTAMPTZ, period_end = (per ->> 'end')::TIMESTAMPTZ, note = note_now
     WHERE id = pay.id;
    IF pay.promo_code IS NOT NULL AND NOT full_now THEN
        UPDATE public.hangtag_promo_codes SET redeemed = redeemed + 1, updated_at = NOW() WHERE code = pay.promo_code;
        INSERT INTO public.hangtag_promo_redemptions (payment_id, code, owner_id, plan_code, discount)
        VALUES (pay.id, pay.promo_code, pay.owner_id, pay.plan_code, pay.discount) ON CONFLICT (payment_id) DO NOTHING;
    END IF;
    RETURN jsonb_build_object('ok', TRUE, 'already', FALSE, 'state', public.hangtag_subscription_state(pay.owner_id, NOW()),
        'plan_code', plan_now, 'period_start', per ->> 'start', 'period_end', per ->> 'end', 'offer_full', full_now);
END $$;

-- ---------- AutoPay ----------
-- (internal) What AutoPay would do for a shop now: the plan and its price after the trial or plan running now, from when,
-- and what is paid today (nothing while a trial or plan is running)
CREATE OR REPLACE FUNCTION public.hangtag_autopay_terms(p_owner UUID)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE cfg RECORD; pl RECORD; s RECORD; n TIMESTAMPTZ := NOW(); first_at TIMESTAMPTZ;
BEGIN
    SELECT * INTO cfg FROM public.hangtag_platform_config c WHERE c.id;
    SELECT p.code, p.label, p.months, p.price, p.currency INTO pl FROM public.hangtag_plans p
     WHERE p.code = COALESCE(cfg.autopay_plan_code, 'm1') AND p.kind = 'paid';
    SELECT x.trial_ends_at, x.period_end, x.autopay_status INTO s FROM public.hangtag_subscriptions x WHERE x.owner_id = p_owner;
    first_at := GREATEST(n, CASE WHEN s.trial_ends_at > n THEN s.trial_ends_at END, CASE WHEN s.period_end > n THEN s.period_end END);
    RETURN jsonb_build_object('available', COALESCE(cfg.autopay_enabled, FALSE) AND pl.code IS NOT NULL,
        'plan', jsonb_build_object('code', pl.code, 'label', pl.label, 'months', pl.months), 'price', pl.price, 'currency', COALESCE(pl.currency, 'INR'),
        'today', CASE WHEN first_at > n THEN 0 ELSE pl.price END, 'first_charge_at', first_at,
        'consent_version', cfg.autopay_consent_version, 'status', COALESCE(s.autopay_status, 'none'));
END $$;

-- The AutoPay terms for the caller's shop (the owner): for the consent screen
CREATE OR REPLACE FUNCTION public.hangtag_autopay_quote()
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE me UUID := public.hangtag_subscription_owner();
BEGIN
    RETURN public.hangtag_autopay_terms(me);
END $$;

-- The owner agreed to AutoPay on the current terms (the subscription Edge Function calls this AS the owner, then asks the
-- provider): the consent is recorded and AutoPay waits for the provider's confirmation. A set-up that was waiting is
-- replaced (its provider subscription is given back, for the function to cancel).
CREATE OR REPLACE FUNCTION public.hangtag_autopay_begin(p_consent BOOLEAN, p_consent_version TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE me UUID := public.hangtag_subscription_owner(); t JSONB; s RECORD;
BEGIN
    IF EXISTS (SELECT 1 FROM public.hangtag_profiles p WHERE p.id = me AND p.onboarded_at IS NOT NULL) THEN PERFORM public.hangtag_subscription_ensure(me); END IF;
    SELECT * INTO s FROM public.hangtag_subscriptions x WHERE x.owner_id = me FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Finish setting up your shop first.' USING ERRCODE = 'P0001'; END IF;
    t := public.hangtag_autopay_terms(me);
    IF NOT (t ->> 'available')::BOOLEAN THEN RAISE EXCEPTION 'AutoPay isn''t available yet. Choose a plan instead.' USING ERRCODE = 'P0001'; END IF;
    IF p_consent IS DISTINCT FROM TRUE OR p_consent_version IS DISTINCT FROM (t ->> 'consent_version') THEN
        RAISE EXCEPTION 'Agree to the AutoPay terms first.' USING ERRCODE = 'P0001';
    END IF;
    IF s.suspended THEN RAISE EXCEPTION 'This shop is suspended. Contact Hangtag support.' USING ERRCODE = 'P0001'; END IF;
    IF s.autopay_status IN ('active', 'past_due') THEN RAISE EXCEPTION 'AutoPay is already on for this shop.' USING ERRCODE = 'P0001'; END IF;
    IF s.autopay_status = 'pending' AND s.autopay_consent_at > NOW() - interval '20 seconds' THEN
        RAISE EXCEPTION 'AutoPay is being set up. Try again in a moment.' USING ERRCODE = 'P0001';
    END IF;
    UPDATE public.hangtag_subscriptions SET autopay_status = 'pending', autopay_plan_code = t #>> '{plan,code}', autopay_consent_at = NOW(),
        autopay_consent_version = t ->> 'consent_version', autopay_provider = NULL, autopay_subscription_id = NULL, autopay_customer_id = NULL,
        autopay_next_charge_at = (t ->> 'first_charge_at')::TIMESTAMPTZ, autopay_cancelled_at = NULL, autopay_failed_at = NULL, updated_at = NOW()
     WHERE owner_id = me;
    RETURN t || jsonb_build_object('owner', me, 'previous', CASE WHEN s.autopay_status = 'pending' AND s.autopay_subscription_id IS NOT NULL
        THEN jsonb_build_object('provider', s.autopay_provider, 'subscription_id', s.autopay_subscription_id) END);
END $$;

-- (service role) the provider's subscription made for that set-up
CREATE OR REPLACE FUNCTION public.hangtag_autopay_attach(p_owner UUID, p_provider TEXT, p_subscription TEXT, p_customer TEXT DEFAULT NULL)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
    IF btrim(COALESCE(p_subscription, '')) = '' THEN RAISE EXCEPTION 'The provider''s subscription is missing.' USING ERRCODE = 'P0001'; END IF;
    UPDATE public.hangtag_subscriptions SET autopay_provider = lower(btrim(p_provider)), autopay_subscription_id = btrim(p_subscription),
        autopay_customer_id = NULLIF(btrim(COALESCE(p_customer, '')), ''), updated_at = NOW()
     WHERE owner_id = p_owner AND autopay_status = 'pending' AND autopay_subscription_id IS NULL;
    IF NOT FOUND THEN RAISE EXCEPTION 'AutoPay isn''t waiting to be set up.' USING ERRCODE = 'P0001'; END IF;
END $$;

-- (service role) What the provider reports about a shop's AutoPay. Idempotent: a charge is recorded once (by the provider's
-- payment id). A report about AutoPay that was replaced or isn't Hangtag's changes nothing ({ known: false }).
--   authenticated / activated / resumed → on (authorised) · charged (the provider CAPTURED the money) → a paid period of the
--   AutoPay plan (a different amount is honoured and kept for review) · pending → past_due (the provider retries) ·
--   halted → halted · cancelled / completed / expired → cancelled (the time already paid for or the trial is kept)
CREATE OR REPLACE FUNCTION public.hangtag_autopay_event(p_provider TEXT, p_subscription TEXT, p_event TEXT, p_payment TEXT DEFAULT NULL,
    p_amount NUMERIC DEFAULT NULL, p_next_charge_at TIMESTAMPTZ DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    s RECORD;
    pl RECORD;
    pid UUID;
    per JSONB;
    n TIMESTAMPTZ := NOW();
    ev TEXT := lower(btrim(COALESCE(p_event, '')));
    prov TEXT := lower(btrim(COALESCE(p_provider, '')));
    amt NUMERIC(12,2);
BEGIN
    IF ev NOT IN ('authenticated', 'activated', 'resumed', 'charged', 'pending', 'halted', 'cancelled', 'completed', 'expired') THEN
        RAISE EXCEPTION 'Unknown AutoPay event.' USING ERRCODE = 'P0001';
    END IF;
    SELECT * INTO s FROM public.hangtag_subscriptions x WHERE x.autopay_provider = prov AND x.autopay_subscription_id = btrim(COALESCE(p_subscription, '')) FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('ok', TRUE, 'known', FALSE); END IF;
    IF ev IN ('authenticated', 'activated', 'resumed') THEN
        UPDATE public.hangtag_subscriptions SET autopay_status = CASE WHEN s.autopay_status = 'cancelled' THEN 'cancelled' ELSE 'active' END,
            autopay_authorized_at = COALESCE(s.autopay_authorized_at, n), autopay_next_charge_at = COALESCE(p_next_charge_at, s.autopay_next_charge_at),
            autopay_failed_at = CASE WHEN ev = 'resumed' THEN NULL ELSE s.autopay_failed_at END, updated_at = n
         WHERE owner_id = s.owner_id;
    ELSIF ev = 'charged' THEN
        amt := round(COALESCE(p_amount, 0), 2);
        IF btrim(COALESCE(p_payment, '')) = '' OR amt <= 0 THEN
            RAISE EXCEPTION 'A charge needs the provider''s payment and its amount.' USING ERRCODE = 'P0001';
        END IF;
        SELECT p.code, p.price, p.currency INTO pl FROM public.hangtag_plans p WHERE p.code = COALESCE(s.autopay_plan_code, 'm1');
        INSERT INTO public.hangtag_subscription_payments (owner_id, plan_code, price, discount, amount, currency, provider, provider_order_id,
            provider_payment_id, status, kind, note)
        VALUES (s.owner_id, pl.code, amt, 0, amt, COALESCE(pl.currency, 'INR'), prov, left(s.autopay_subscription_id, 120), left(btrim(p_payment), 120), 'created', 'autopay',
            CASE WHEN amt <> pl.price THEN left('Review: AutoPay charged ' || amt || ', the plan costs ' || pl.price, 200) END)
        ON CONFLICT (provider, provider_payment_id) DO NOTHING
        RETURNING id INTO pid;
        IF pid IS NULL THEN
            RETURN jsonb_build_object('ok', TRUE, 'known', TRUE, 'already', TRUE, 'state', public.hangtag_subscription_state(s.owner_id, n));
        END IF;
        per := public.hangtag_subscription_extend(s.owner_id, pl.code);
        UPDATE public.hangtag_subscription_payments SET status = 'paid', paid_at = n, captured_at = n,
            period_start = (per ->> 'start')::TIMESTAMPTZ, period_end = (per ->> 'end')::TIMESTAMPTZ
         WHERE id = pid;
        UPDATE public.hangtag_subscriptions SET autopay_status = CASE WHEN autopay_status = 'cancelled' THEN 'cancelled' ELSE 'active' END,
            autopay_authorized_at = COALESCE(autopay_authorized_at, n), autopay_failed_at = NULL,
            autopay_next_charge_at = CASE WHEN autopay_status = 'cancelled' THEN NULL ELSE COALESCE(p_next_charge_at, (per ->> 'end')::TIMESTAMPTZ) END, updated_at = n
         WHERE owner_id = s.owner_id;
    ELSIF ev = 'pending' THEN
        UPDATE public.hangtag_subscriptions SET autopay_status = CASE WHEN s.autopay_status IN ('cancelled', 'halted') THEN s.autopay_status ELSE 'past_due' END,
            autopay_failed_at = n, updated_at = n
         WHERE owner_id = s.owner_id;
    ELSIF ev = 'halted' THEN
        UPDATE public.hangtag_subscriptions SET autopay_status = CASE WHEN s.autopay_status = 'cancelled' THEN 'cancelled' ELSE 'halted' END,
            autopay_failed_at = COALESCE(s.autopay_failed_at, n), autopay_next_charge_at = NULL, updated_at = n
         WHERE owner_id = s.owner_id;
    ELSE
        UPDATE public.hangtag_subscriptions SET autopay_status = 'cancelled', autopay_cancelled_at = COALESCE(s.autopay_cancelled_at, n),
            autopay_next_charge_at = NULL, updated_at = n
         WHERE owner_id = s.owner_id;
    END IF;
    RETURN jsonb_build_object('ok', TRUE, 'known', TRUE, 'owner', s.owner_id, 'state', public.hangtag_subscription_state(s.owner_id, n),
        'autopay_status', (SELECT x.autopay_status FROM public.hangtag_subscriptions x WHERE x.owner_id = s.owner_id));
END $$;

-- The owner turns AutoPay off (any time before it renews). The subscription Edge Function calls this AS the owner, cancels at
-- the provider, then reports it (hangtag_autopay_event 'cancelled'). The trial or the paid time already running is kept.
CREATE OR REPLACE FUNCTION public.hangtag_autopay_cancel_request()
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE me UUID := public.hangtag_subscription_owner(); s RECORD;
BEGIN
    SELECT x.autopay_status, x.autopay_provider, x.autopay_subscription_id INTO s FROM public.hangtag_subscriptions x WHERE x.owner_id = me FOR UPDATE;
    IF NOT FOUND OR s.autopay_status NOT IN ('pending', 'active', 'past_due', 'halted') THEN
        RAISE EXCEPTION 'AutoPay isn''t on for this shop.' USING ERRCODE = 'P0001';
    END IF;
    IF s.autopay_subscription_id IS NULL THEN
        -- set up but never sent to the provider: nothing to cancel there
        UPDATE public.hangtag_subscriptions SET autopay_status = 'cancelled', autopay_cancelled_at = NOW(), autopay_next_charge_at = NULL, updated_at = NOW()
         WHERE owner_id = me;
        RETURN jsonb_build_object('ok', TRUE, 'provider', NULL, 'subscription_id', NULL);
    END IF;
    RETURN jsonb_build_object('ok', TRUE, 'provider', s.autopay_provider, 'subscription_id', s.autopay_subscription_id);
END $$;

-- ---------- the Platform Console ----------
-- What each role may do. The console's menu follows it; every console function checks it.
CREATE OR REPLACE FUNCTION public.hangtag_platform_permissions(p_role TEXT)
RETURNS TEXT[] LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
    SELECT CASE p_role
        WHEN 'super_admin' THEN ARRAY['dashboard.view', 'customers.view', 'subscriptions.view', 'subscriptions.manage', 'payments.view', 'promotions.view',
            'promotions.manage', 'plans.manage', 'referrals.view', 'wallet.view', 'communications.view', 'health.view', 'inventory.view', 'diagnostics.view',
            'growth.view', 'employees.view', 'incentives.view', 'reports.view', 'audit.view', 'settings.view', 'settings.manage', 'staff.manage']
        WHEN 'admin' THEN ARRAY['dashboard.view', 'customers.view', 'subscriptions.view', 'subscriptions.manage', 'payments.view', 'promotions.view',
            'promotions.manage', 'plans.manage', 'referrals.view', 'wallet.view', 'communications.view', 'health.view', 'inventory.view', 'diagnostics.view',
            'growth.view', 'employees.view', 'incentives.view', 'reports.view', 'audit.view', 'settings.view', 'staff.manage']
        WHEN 'billing_admin' THEN ARRAY['dashboard.view', 'customers.view', 'subscriptions.view', 'subscriptions.manage', 'payments.view', 'promotions.view',
            'promotions.manage', 'plans.manage', 'referrals.view', 'wallet.view', 'incentives.view', 'reports.view']
        WHEN 'support_admin' THEN ARRAY['dashboard.view', 'customers.view', 'subscriptions.view', 'payments.view', 'communications.view', 'health.view',
            'inventory.view', 'diagnostics.view']
        WHEN 'read_only' THEN ARRAY['dashboard.view', 'customers.view', 'subscriptions.view', 'payments.view', 'promotions.view', 'health.view',
            'growth.view', 'reports.view']
        ELSE ARRAY[]::TEXT[] END;
$$;

-- (internal) the caller's console role: an active staff account, found by its account id (never by its email) — or NULL
CREATE OR REPLACE FUNCTION public.hangtag_platform_role()
RETURNS TEXT LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
    SELECT s.role FROM public.hangtag_platform_staff s WHERE s.user_id = auth.uid() AND s.active;
$$;

-- (internal) the caller may do this in the console, or the call is refused (42501)
CREATE OR REPLACE FUNCTION public.hangtag_platform_require(p_perm TEXT)
RETURNS TEXT LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE r TEXT := public.hangtag_platform_role();
BEGIN
    IF r IS NULL OR NOT (p_perm = ANY (public.hangtag_platform_permissions(r))) THEN
        RAISE EXCEPTION 'HANGTAG_PLATFORM_DENIED: Your console role can''t do this.' USING ERRCODE = '42501';
    END IF;
    RETURN r;
END $$;

-- (internal) one line of the console's audit log, written by the console functions themselves
CREATE OR REPLACE FUNCTION public.hangtag_platform_log(p_action TEXT, p_target_type TEXT, p_target_id TEXT, p_detail JSONB DEFAULT '{}'::jsonb, p_ok BOOLEAN DEFAULT TRUE)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
    INSERT INTO public.hangtag_platform_audit (actor, actor_role, action, target_type, target_id, detail, ok)
    VALUES (auth.uid(), public.hangtag_platform_role(), p_action, left(p_target_type, 40), left(p_target_id, 120), COALESCE(p_detail, '{}'::jsonb), COALESCE(p_ok, TRUE));
END $$;

-- Who is signed in to the console: { staff, role, name, permissions, account }. An account without a console role gets
-- { staff: false } (and its attempt is noted, at most once in ten minutes).
CREATE OR REPLACE FUNCTION public.hangtag_platform_whoami()
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE u UUID := auth.uid(); s RECORD;
BEGIN
    IF u IS NULL THEN RETURN jsonb_build_object('staff', FALSE, 'account', NULL); END IF;
    SELECT x.role, x.display_name, x.active INTO s FROM public.hangtag_platform_staff x WHERE x.user_id = u;
    IF NOT FOUND OR NOT s.active THEN
        IF NOT EXISTS (SELECT 1 FROM public.hangtag_platform_audit a WHERE a.actor = u AND a.action = 'console.denied' AND a.t > NOW() - interval '10 minutes') THEN
            PERFORM public.hangtag_platform_log('console.denied', 'account', u::TEXT, '{}'::jsonb, FALSE);
        END IF;
        RETURN jsonb_build_object('staff', FALSE, 'account', u);
    END IF;
    RETURN jsonb_build_object('staff', TRUE, 'account', u, 'role', s.role, 'name', s.display_name, 'permissions', to_jsonb(public.hangtag_platform_permissions(s.role)));
END $$;

-- A console sign-in (noted in the audit log)
CREATE OR REPLACE FUNCTION public.hangtag_platform_sign_in()
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE w JSONB := public.hangtag_platform_whoami();
BEGIN
    IF (w ->> 'staff')::BOOLEAN THEN PERFORM public.hangtag_platform_log('console.sign_in', 'account', w ->> 'account', '{}'::jsonb, TRUE); END IF;
    RETURN w;
END $$;

-- The console's dashboard: totals only (shops, plans, AutoPay, money received, offers, usage), never a shop's own rows
CREATE OR REPLACE FUNCTION public.hangtag_platform_dashboard()
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    r TEXT := public.hangtag_platform_require('dashboard.view');
    n TIMESTAMPTZ := NOW();
    m0 TIMESTAMPTZ := (date_trunc('month', NOW() AT TIME ZONE 'Asia/Kolkata')) AT TIME ZONE 'Asia/Kolkata';
    ending INT;
    shops JSONB; subs JSONB; money JSONB; offers JSONB; usage JSONB; cur TEXT;
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
    SELECT jsonb_build_object('currency', COALESCE(cur, 'INR'),
        'month', COALESCE(sum(y.amount) FILTER (WHERE y.captured_at >= m0), 0), 'month_count', count(*) FILTER (WHERE y.captured_at >= m0),
        'last_30d', COALESCE(sum(y.amount) FILTER (WHERE y.captured_at > n - interval '30 days'), 0),
        'autopay_30d', COALESCE(sum(y.amount) FILTER (WHERE y.captured_at > n - interval '30 days' AND y.kind = 'autopay'), 0),
        'failed_7d', (SELECT count(*) FROM public.hangtag_subscription_payments f WHERE f.status = 'failed' AND f.created_at > n - interval '7 days'))
      INTO money FROM public.hangtag_subscription_payments y WHERE y.captured_at IS NOT NULL;
    SELECT COALESCE(jsonb_agg(jsonb_build_object('code', c.code, 'title', COALESCE(c.title, c.code), 'redeemed', c.redeemed, 'cap', c.max_uses,
               'active', c.active, 'ends_at', c.ends_at) ORDER BY c.code), '[]'::jsonb)
      INTO offers FROM public.hangtag_promo_codes c WHERE c.auto_apply OR c.max_uses IS NOT NULL;
    SELECT jsonb_build_object('bills_24h', (SELECT count(*) FROM public.hangtag_sales x WHERE x.created_at > n - interval '24 hours'),
               'shops_selling_7d', (SELECT count(DISTINCT x.owner_id) FROM public.hangtag_sales x WHERE x.created_at > n - interval '7 days'))
      INTO usage;
    RETURN jsonb_build_object('generated_at', n, 'role', r, 'shops', shops, 'subscriptions', subs, 'revenue', money, 'offers', offers, 'usage', usage);
END $$;

-- The plans and campaigns, with their counters (promotions.view)
CREATE OR REPLACE FUNCTION public.hangtag_platform_promotions()
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r TEXT := public.hangtag_platform_require('promotions.view'); plans JSONB; codes JSONB;
BEGIN
    SELECT COALESCE(jsonb_agg(jsonb_build_object('code', p.code, 'label', p.label, 'kind', p.kind, 'months', p.months, 'days', p.days, 'price', p.price,
               'currency', p.currency, 'active', p.active, 'sort', p.sort) ORDER BY p.sort, p.code), '[]'::jsonb)
      INTO plans FROM public.hangtag_plans p;
    SELECT COALESCE(jsonb_agg(jsonb_build_object('code', c.code, 'title', c.title, 'kind', c.kind, 'value', c.value, 'plans', c.plans,
               'starts_at', c.starts_at, 'ends_at', c.ends_at, 'max_uses', c.max_uses, 'redeemed', c.redeemed, 'per_account_limit', c.per_account_limit,
               'active', c.active, 'auto_apply', c.auto_apply, 'new_customers_only', c.new_customers_only, 'updated_at', c.updated_at,
               'held', (SELECT count(*) FROM public.hangtag_subscription_payments y WHERE y.promo_code = c.code AND y.status = 'created'
                          AND y.created_at > NOW() - interval '30 minutes')) ORDER BY c.auto_apply DESC, c.code), '[]'::jsonb)
      INTO codes FROM public.hangtag_promo_codes c;
    RETURN jsonb_build_object('role', r, 'plans', plans, 'campaigns', codes);
END $$;

-- A campaign's fields changed (promotions.manage). Only these fields; each checked; the cap never below the redemptions.
CREATE OR REPLACE FUNCTION public.hangtag_platform_campaign_save(p_code TEXT, p_patch JSONB)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    r TEXT := public.hangtag_platform_require('promotions.manage');
    v_code TEXT := upper(btrim(COALESCE(p_code, '')));
    c public.hangtag_promo_codes;
    before JSONB;
    after JSONB;
    bad TEXT;
BEGIN
    IF p_patch IS NULL OR jsonb_typeof(p_patch) <> 'object' THEN RAISE EXCEPTION 'Nothing to change.' USING ERRCODE = 'P0001'; END IF;
    SELECT k INTO bad FROM jsonb_object_keys(p_patch) k
     WHERE k NOT IN ('title', 'active', 'auto_apply', 'new_customers_only', 'max_uses', 'value', 'starts_at', 'ends_at', 'per_account_limit', 'plans') LIMIT 1;
    IF bad IS NOT NULL THEN RAISE EXCEPTION 'A campaign has no field "%".', left(bad, 30) USING ERRCODE = 'P0001'; END IF;
    SELECT * INTO c FROM public.hangtag_promo_codes x WHERE x.code = v_code FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'No such campaign.' USING ERRCODE = 'P0002'; END IF;
    before := to_jsonb(c);
    BEGIN
        IF p_patch ? 'title' THEN c.title := NULLIF(btrim(p_patch ->> 'title'), ''); END IF;
        IF p_patch ? 'active' THEN c.active := (p_patch ->> 'active')::BOOLEAN; END IF;
        IF p_patch ? 'auto_apply' THEN c.auto_apply := (p_patch ->> 'auto_apply')::BOOLEAN; END IF;
        IF p_patch ? 'new_customers_only' THEN c.new_customers_only := (p_patch ->> 'new_customers_only')::BOOLEAN; END IF;
        IF p_patch ? 'max_uses' THEN c.max_uses := NULLIF(p_patch ->> 'max_uses', '')::INT; END IF;
        IF p_patch ? 'value' THEN c.value := (p_patch ->> 'value')::NUMERIC; END IF;
        IF p_patch ? 'starts_at' THEN c.starts_at := NULLIF(p_patch ->> 'starts_at', '')::TIMESTAMPTZ; END IF;
        IF p_patch ? 'ends_at' THEN c.ends_at := NULLIF(p_patch ->> 'ends_at', '')::TIMESTAMPTZ; END IF;
        IF p_patch ? 'per_account_limit' THEN c.per_account_limit := (p_patch ->> 'per_account_limit')::INT; END IF;
        IF p_patch ? 'plans' THEN
            c.plans := CASE WHEN jsonb_typeof(p_patch -> 'plans') = 'array' THEN ARRAY(SELECT jsonb_array_elements_text(p_patch -> 'plans')) END;
        END IF;
    EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow OR invalid_datetime_format OR numeric_value_out_of_range THEN
        RAISE EXCEPTION 'Check the values: a number, a yes/no or a date is not right.' USING ERRCODE = 'P0001';
    END;
    IF c.max_uses IS NOT NULL AND c.max_uses < c.redeemed THEN
        RAISE EXCEPTION 'The cap can''t be below the % already redeemed.', c.redeemed USING ERRCODE = 'P0001';
    END IF;
    IF c.plans IS NOT NULL AND EXISTS (SELECT 1 FROM unnest(c.plans) x WHERE NOT EXISTS (SELECT 1 FROM public.hangtag_plans p WHERE p.code = x AND p.kind = 'paid')) THEN
        RAISE EXCEPTION 'Choose plans that exist.' USING ERRCODE = 'P0001';
    END IF;
    UPDATE public.hangtag_promo_codes SET title = c.title, active = c.active, auto_apply = c.auto_apply, new_customers_only = c.new_customers_only,
        max_uses = c.max_uses, value = c.value, starts_at = c.starts_at, ends_at = c.ends_at, per_account_limit = c.per_account_limit, plans = c.plans,
        updated_at = NOW()
     WHERE code = v_code;
    SELECT to_jsonb(x) INTO after FROM public.hangtag_promo_codes x WHERE x.code = v_code;
    PERFORM public.hangtag_platform_log('promotion.update', 'promotion', v_code, jsonb_build_object('before', before - 'created_at', 'after', after - 'created_at'));
    RETURN after;
END $$;

-- A plan's price, name, order or sale changed (plans.manage); its length stays what it was sold as
CREATE OR REPLACE FUNCTION public.hangtag_platform_plan_save(p_code TEXT, p_patch JSONB)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r TEXT := public.hangtag_platform_require('plans.manage'); p public.hangtag_plans; before JSONB; after JSONB; bad TEXT;
BEGIN
    IF p_patch IS NULL OR jsonb_typeof(p_patch) <> 'object' THEN RAISE EXCEPTION 'Nothing to change.' USING ERRCODE = 'P0001'; END IF;
    SELECT k INTO bad FROM jsonb_object_keys(p_patch) k WHERE k NOT IN ('label', 'price', 'active', 'sort', 'days') LIMIT 1;
    IF bad IS NOT NULL THEN RAISE EXCEPTION 'A plan has no field "%".', left(bad, 30) USING ERRCODE = 'P0001'; END IF;
    SELECT * INTO p FROM public.hangtag_plans x WHERE x.code = p_code FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'No such plan.' USING ERRCODE = 'P0002'; END IF;
    before := to_jsonb(p);
    BEGIN
        IF p_patch ? 'label' THEN p.label := btrim(p_patch ->> 'label'); END IF;
        IF p_patch ? 'price' THEN p.price := (p_patch ->> 'price')::NUMERIC; END IF;
        IF p_patch ? 'active' THEN p.active := (p_patch ->> 'active')::BOOLEAN; END IF;
        IF p_patch ? 'sort' THEN p.sort := (p_patch ->> 'sort')::INT; END IF;
        IF p_patch ? 'days' THEN
            IF p.kind <> 'trial' THEN RAISE EXCEPTION 'Only the trial has days.' USING ERRCODE = 'P0001'; END IF;
            p.days := (p_patch ->> 'days')::INT;
        END IF;
    EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
        RAISE EXCEPTION 'Check the values: a number or a yes/no is not right.' USING ERRCODE = 'P0001';
    END;
    IF p.code = (SELECT c.autopay_plan_code FROM public.hangtag_platform_config c WHERE c.id) AND NOT p.active THEN
        RAISE EXCEPTION 'AutoPay renews this plan: it stays on sale.' USING ERRCODE = 'P0001';
    END IF;
    UPDATE public.hangtag_plans SET label = p.label, price = p.price, active = p.active, sort = p.sort, days = p.days, updated_at = NOW() WHERE code = p.code;
    SELECT to_jsonb(x) INTO after FROM public.hangtag_plans x WHERE x.code = p.code;
    PERFORM public.hangtag_platform_log('plan.update', 'plan', p.code, jsonb_build_object('before', before, 'after', after));
    RETURN after;
END $$;

-- The console's audit log, newest first (audit.view)
CREATE OR REPLACE FUNCTION public.hangtag_platform_audit_list(p_limit INT DEFAULT 50, p_before BIGINT DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r TEXT := public.hangtag_platform_require('audit.view'); out JSONB;
BEGIN
    SELECT COALESCE(jsonb_agg(jsonb_build_object('id', a.id, 't', a.t, 'actor', a.actor, 'actor_email', u.email, 'actor_role', a.actor_role, 'action', a.action,
               'target_type', a.target_type, 'target_id', a.target_id, 'detail', a.detail, 'ok', a.ok) ORDER BY a.id DESC), '[]'::jsonb)
      INTO out
      FROM (SELECT * FROM public.hangtag_platform_audit x WHERE p_before IS NULL OR x.id < p_before ORDER BY x.id DESC
             LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200)) a
      LEFT JOIN auth.users u ON u.id = a.actor;
    RETURN out;
END $$;

-- Hangtag's commercial settings (settings.view)
CREATE OR REPLACE FUNCTION public.hangtag_platform_settings()
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r TEXT := public.hangtag_platform_require('settings.view'); c RECORD;
BEGIN
    SELECT * INTO c FROM public.hangtag_platform_config x WHERE x.id;
    RETURN jsonb_build_object('autopay_enabled', c.autopay_enabled, 'trial_requires_autopay', c.trial_requires_autopay, 'autopay_plan_code', c.autopay_plan_code,
        'trial_ending_days', c.trial_ending_days, 'renewal_grace_hours', c.renewal_grace_hours, 'autopay_consent_version', c.autopay_consent_version,
        'trial_days', (SELECT p.days FROM public.hangtag_plans p WHERE p.code = 'trial'), 'updated_at', c.updated_at,
        'can_manage', 'settings.manage' = ANY (public.hangtag_platform_permissions(r)));
END $$;

-- Hangtag's commercial settings changed (settings.manage: a super admin)
CREATE OR REPLACE FUNCTION public.hangtag_platform_settings_save(p_patch JSONB)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r TEXT := public.hangtag_platform_require('settings.manage'); c public.hangtag_platform_config; before JSONB; bad TEXT;
BEGIN
    IF p_patch IS NULL OR jsonb_typeof(p_patch) <> 'object' THEN RAISE EXCEPTION 'Nothing to change.' USING ERRCODE = 'P0001'; END IF;
    SELECT k INTO bad FROM jsonb_object_keys(p_patch) k
     WHERE k NOT IN ('autopay_enabled', 'trial_requires_autopay', 'autopay_plan_code', 'trial_ending_days', 'renewal_grace_hours', 'autopay_consent_version') LIMIT 1;
    IF bad IS NOT NULL THEN RAISE EXCEPTION 'The settings have no field "%".', left(bad, 30) USING ERRCODE = 'P0001'; END IF;
    SELECT * INTO c FROM public.hangtag_platform_config x WHERE x.id FOR UPDATE;
    before := to_jsonb(c);
    BEGIN
        IF p_patch ? 'autopay_enabled' THEN c.autopay_enabled := (p_patch ->> 'autopay_enabled')::BOOLEAN; END IF;
        IF p_patch ? 'trial_requires_autopay' THEN c.trial_requires_autopay := (p_patch ->> 'trial_requires_autopay')::BOOLEAN; END IF;
        IF p_patch ? 'autopay_plan_code' THEN c.autopay_plan_code := p_patch ->> 'autopay_plan_code'; END IF;
        IF p_patch ? 'trial_ending_days' THEN c.trial_ending_days := (p_patch ->> 'trial_ending_days')::INT; END IF;
        IF p_patch ? 'renewal_grace_hours' THEN c.renewal_grace_hours := (p_patch ->> 'renewal_grace_hours')::INT; END IF;
        IF p_patch ? 'autopay_consent_version' THEN c.autopay_consent_version := btrim(p_patch ->> 'autopay_consent_version'); END IF;
    EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
        RAISE EXCEPTION 'Check the values: a number or a yes/no is not right.' USING ERRCODE = 'P0001';
    END;
    IF NOT EXISTS (SELECT 1 FROM public.hangtag_plans p WHERE p.code = c.autopay_plan_code AND p.kind = 'paid' AND p.active) THEN
        RAISE EXCEPTION 'AutoPay renews a paid plan on sale.' USING ERRCODE = 'P0001';
    END IF;
    UPDATE public.hangtag_platform_config SET autopay_enabled = c.autopay_enabled, trial_requires_autopay = c.trial_requires_autopay,
        autopay_plan_code = c.autopay_plan_code, trial_ending_days = c.trial_ending_days, renewal_grace_hours = c.renewal_grace_hours,
        autopay_consent_version = c.autopay_consent_version, updated_at = NOW(), updated_by = auth.uid()
     WHERE id;
    PERFORM public.hangtag_platform_log('settings.update', 'settings', 'platform', jsonb_build_object('before', before - 'updated_at' - 'updated_by',
        'after', (SELECT to_jsonb(x) - 'updated_at' - 'updated_by' FROM public.hangtag_platform_config x WHERE x.id)));
    RETURN public.hangtag_platform_settings();
END $$;

-- The console's staff (staff.manage)
CREATE OR REPLACE FUNCTION public.hangtag_platform_staff_list()
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r TEXT := public.hangtag_platform_require('staff.manage'); out JSONB;
BEGIN
    SELECT COALESCE(jsonb_agg(jsonb_build_object('user_id', s.user_id, 'email', u.email, 'role', s.role, 'active', s.active, 'name', s.display_name,
               'created_at', s.created_at, 'updated_at', s.updated_at) ORDER BY s.active DESC, s.role, u.email), '[]'::jsonb)
      INTO out FROM public.hangtag_platform_staff s LEFT JOIN auth.users u ON u.id = s.user_id;
    RETURN out;
END $$;

-- An account given a console role, its role changed, or switched off (staff.manage). Found by its account id (the person
-- reads it on the console's "no access" page). Only a super admin changes a super admin or an admin; nobody changes their
-- own access; one active super admin always stays.
CREATE OR REPLACE FUNCTION public.hangtag_platform_staff_save(p_user UUID, p_role TEXT, p_active BOOLEAN DEFAULT TRUE, p_name TEXT DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r TEXT := public.hangtag_platform_require('staff.manage'); prev RECORD;
BEGIN
    IF p_role IS NULL OR p_role NOT IN ('super_admin', 'admin', 'billing_admin', 'support_admin', 'read_only') THEN
        RAISE EXCEPTION 'Choose a role.' USING ERRCODE = 'P0001';
    END IF;
    IF p_user IS NULL OR NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = p_user) THEN
        RAISE EXCEPTION 'No Hangtag account has that id. The person signs in to the console once, then reads it there.' USING ERRCODE = 'P0001';
    END IF;
    IF p_user = auth.uid() THEN RAISE EXCEPTION 'You can''t change your own console access.' USING ERRCODE = 'P0001'; END IF;
    SELECT * INTO prev FROM public.hangtag_platform_staff s WHERE s.user_id = p_user FOR UPDATE;
    IF r <> 'super_admin' AND (p_role IN ('super_admin', 'admin') OR prev.role IN ('super_admin', 'admin')) THEN
        RAISE EXCEPTION 'Only a super admin can change admins.' USING ERRCODE = '42501';
    END IF;
    INSERT INTO public.hangtag_platform_staff AS st (user_id, role, active, display_name, created_by)
    VALUES (p_user, p_role, COALESCE(p_active, TRUE), NULLIF(btrim(COALESCE(p_name, '')), ''), auth.uid())
    ON CONFLICT (user_id) DO UPDATE SET role = EXCLUDED.role, active = EXCLUDED.active,
        display_name = COALESCE(EXCLUDED.display_name, st.display_name), updated_at = NOW();
    IF NOT EXISTS (SELECT 1 FROM public.hangtag_platform_staff s WHERE s.role = 'super_admin' AND s.active) THEN
        RAISE EXCEPTION 'One active super admin must stay.' USING ERRCODE = 'P0001';
    END IF;
    PERFORM public.hangtag_platform_log('staff.update', 'account', p_user::TEXT, jsonb_build_object(
        'before', CASE WHEN prev.user_id IS NOT NULL THEN jsonb_build_object('role', prev.role, 'active', prev.active) END,
        'after', jsonb_build_object('role', p_role, 'active', COALESCE(p_active, TRUE))));
    RETURN public.hangtag_platform_staff_list();
END $$;

-- Who may see and do what: the console's tables and Hangtag's settings are reached only through the functions above (each
-- checks the caller's console role); no app user may read or write them directly.
ALTER TABLE public.hangtag_platform_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hangtag_platform_staff ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hangtag_platform_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.hangtag_platform_config, public.hangtag_platform_staff, public.hangtag_platform_audit FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.hangtag_platform_audit_id_seq FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.hangtag_offer_for(UUID, TEXT), public.hangtag_autopay_terms(UUID), public.hangtag_autopay_attach(UUID, TEXT, TEXT, TEXT),
    public.hangtag_autopay_event(TEXT, TEXT, TEXT, TEXT, NUMERIC, TIMESTAMPTZ), public.hangtag_platform_permissions(TEXT), public.hangtag_platform_role(),
    public.hangtag_platform_require(TEXT), public.hangtag_platform_log(TEXT, TEXT, TEXT, JSONB, BOOLEAN),
    public.hangtag_autopay_quote(), public.hangtag_autopay_begin(BOOLEAN, TEXT), public.hangtag_autopay_cancel_request(),
    public.hangtag_platform_whoami(), public.hangtag_platform_sign_in(), public.hangtag_platform_dashboard(), public.hangtag_platform_promotions(),
    public.hangtag_platform_campaign_save(TEXT, JSONB), public.hangtag_platform_plan_save(TEXT, JSONB), public.hangtag_platform_audit_list(INT, BIGINT),
    public.hangtag_platform_settings(), public.hangtag_platform_settings_save(JSONB), public.hangtag_platform_staff_list(),
    public.hangtag_platform_staff_save(UUID, TEXT, BOOLEAN, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hangtag_autopay_quote(), public.hangtag_autopay_begin(BOOLEAN, TEXT), public.hangtag_autopay_cancel_request(),
    public.hangtag_platform_whoami(), public.hangtag_platform_sign_in(), public.hangtag_platform_dashboard(), public.hangtag_platform_promotions(),
    public.hangtag_platform_campaign_save(TEXT, JSONB), public.hangtag_platform_plan_save(TEXT, JSONB), public.hangtag_platform_audit_list(INT, BIGINT),
    public.hangtag_platform_settings(), public.hangtag_platform_settings_save(JSONB), public.hangtag_platform_staff_list(),
    public.hangtag_platform_staff_save(UUID, TEXT, BOOLEAN, TEXT) TO authenticated;
DO $do$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
        EXECUTE $g$GRANT ALL ON TABLE public.hangtag_platform_config, public.hangtag_platform_staff, public.hangtag_platform_audit TO service_role$g$;
        EXECUTE $g$GRANT USAGE, SELECT ON SEQUENCE public.hangtag_platform_audit_id_seq TO service_role$g$;
        EXECUTE $g$GRANT EXECUTE ON FUNCTION public.hangtag_autopay_attach(UUID, TEXT, TEXT, TEXT),
            public.hangtag_autopay_event(TEXT, TEXT, TEXT, TEXT, NUMERIC, TIMESTAMPTZ) TO service_role$g$;
    END IF;
END $do$;
-- The first super admin (once, in the SQL Editor), by the account's id:
--   INSERT INTO public.hangtag_platform_staff (user_id, role) VALUES ('<account id>', 'super_admin') ON CONFLICT (user_id) DO NOTHING;
