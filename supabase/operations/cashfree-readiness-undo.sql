-- Undo of 20261027120000_hangtag_cashfree_readiness.sql: hangtag_billing_readiness() as the post-repair migration defines it
-- (Razorpay's notifications only), then hangtag_autopay_report as that migration defines it, and hangtag_autopay_cancel_owed
-- removed. Run on the database the migration was run on; nothing else changes. Refuses on a database without the
-- post-repair migration (there is nothing of this to undo, and the definitions below would be made fresh there).
DO $$
BEGIN
    IF to_regprocedure('public.hangtag_billing_mode()') IS NULL
       OR to_regprocedure('public.hangtag_autopay_report(text, text, text, text, numeric, text, timestamptz, timestamptz, text)') IS NULL THEN
        RAISE EXCEPTION 'Nothing to undo: the post-repair migration (20261019120000) is not on this database.';
    END IF;
END $$;
CREATE OR REPLACE FUNCTION public.hangtag_billing_readiness()
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE bm TEXT := public.hangtag_billing_mode(); l TIMESTAMPTZ; a TIMESTAMPTZ; rc TIMESTAMPTZ; why TEXT[] := ARRAY[]::TEXT[];
BEGIN
    SELECT max(e.provider_created_at) INTO l FROM public.hangtag_billing_events e
     WHERE e.provider = 'razorpay' AND e.mode = bm AND left(e.event_type, 13) = 'payment_link.' AND e.provider_created_at > NOW() - interval '7 days'
       AND (EXISTS (SELECT 1 FROM public.hangtag_billing_probes pr WHERE pr.provider = e.provider AND pr.entity_id = e.entity_id AND pr.mode = bm)
            OR EXISTS (SELECT 1 FROM public.hangtag_subscription_payments y WHERE y.provider = e.provider AND y.provider_order_id = e.entity_id));
    SELECT max(e.provider_created_at) INTO a FROM public.hangtag_billing_events e
     WHERE e.provider = 'razorpay' AND e.mode = bm AND starts_with(e.event_type, 'subscription.') AND e.provider_created_at > NOW() - interval '7 days'
       AND (EXISTS (SELECT 1 FROM public.hangtag_billing_probes pr WHERE pr.provider = e.provider AND pr.entity_id = e.entity_id AND pr.mode = bm)
            OR EXISTS (SELECT 1 FROM public.hangtag_autopay_mandates m WHERE m.provider = e.provider AND m.subscription_id = e.entity_id AND m.shop_owner_id IS NOT NULL));
    SELECT max(x.started_at) INTO rc FROM public.hangtag_billing_reconcile_runs x
     WHERE x.mode = bm AND x.ok AND x.complete AND x.finished_at IS NOT NULL AND x.started_at > NOW() - interval '26 hours';
    IF l IS NULL THEN why := why || 'no payment-link notification proven in 7 days'::TEXT; END IF;
    IF a IS NULL THEN why := why || 'no subscription notification proven in 7 days'::TEXT; END IF;
    IF rc IS NULL THEN why := why || 'no complete reconciliation in 26 hours'::TEXT; END IF;
    RETURN jsonb_build_object('ready', cardinality(why) = 0, 'mode', bm, 'link_event_at', l, 'autopay_event_at', a, 'reconcile_at', rc, 'reasons', to_jsonb(why));
END $$;


-- hangtag_autopay_report as the post-repair migration defines it (before the two changes above).
CREATE OR REPLACE FUNCTION public.hangtag_autopay_report(p_provider TEXT, p_subscription TEXT, p_event TEXT, p_payment TEXT, p_amount NUMERIC,
    p_currency TEXT, p_next_charge_at TIMESTAMPTZ, p_event_at TIMESTAMPTZ, p_mode TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    bm TEXT := public.hangtag_billing_mode();
    ev TEXT := lower(btrim(COALESCE(p_event, '')));
    prov TEXT := lower(btrim(COALESCE(p_provider, '')));
    sid TEXT := btrim(COALESCE(p_subscription, ''));
    pay TEXT := btrim(COALESCE(p_payment, ''));
    n TIMESTAMPTZ := NOW();
    at_ TIMESTAMPTZ := LEAST(p_event_at, NOW());
    terminal BOOLEAN;
    mo UUID;
    mm RECORD;
    s RECORD;
    pl RECORD;
    cur BOOLEAN;
    stale BOOLEAN;
    ps TEXT;
    want_cancel BOOLEAN;
    amt NUMERIC(12,2);
    due NUMERIC(12,2);
    due_cur TEXT;
    pid UUID;
    per JSONB;
    x JSONB;
BEGIN
    IF ev NOT IN ('authenticated', 'activated', 'resumed', 'charged', 'pending', 'halted', 'cancelled', 'completed', 'expired') THEN
        RAISE EXCEPTION 'Unknown AutoPay event.' USING ERRCODE = 'P0001';
    END IF;
    IF p_mode IS DISTINCT FROM bm THEN
        RAISE EXCEPTION 'An AutoPay report in % mode on a % database: not applied.', COALESCE(p_mode, 'no'), bm USING ERRCODE = 'P0001';
    END IF;
    terminal := ev IN ('cancelled', 'completed', 'expired');
    -- the shop first, then its set-up (one lock order with begin and attach)
    SELECT r1.shop_owner_id INTO mo FROM public.hangtag_autopay_mandates r1 WHERE r1.provider = prov AND r1.subscription_id = sid;
    IF NOT FOUND THEN
        SELECT r2.owner_id INTO mo FROM public.hangtag_subscriptions r2 WHERE r2.autopay_provider = prov AND r2.autopay_subscription_id = sid;
        IF NOT FOUND THEN RETURN jsonb_build_object('ok', TRUE, 'known', FALSE); END IF;
        -- attached before the registry (or by the older attach): the shop's own current set-up, registered now
        PERFORM 1 FROM public.hangtag_subscriptions r3 WHERE r3.owner_id = mo FOR UPDATE;
        UPDATE public.hangtag_autopay_mandates m SET provider = prov, subscription_id = sid, attached_at = COALESCE(m.attached_at, n), mode = COALESCE(m.mode, bm)
         WHERE m.shop_owner_id = mo AND m.is_current AND m.subscription_id IS NULL;
        IF NOT FOUND THEN
            UPDATE public.hangtag_autopay_mandates m SET is_current = FALSE,
                cancel_requested_at = CASE WHEN m.subscription_id IS NOT NULL AND m.cancel_confirmed_at IS NULL
                    AND COALESCE(m.provider_status, '') NOT IN ('cancelled', 'completed', 'expired') THEN COALESCE(m.cancel_requested_at, n) ELSE m.cancel_requested_at END
             WHERE m.shop_owner_id = mo AND m.is_current;
            INSERT INTO public.hangtag_autopay_mandates (shop_owner_id, provider, subscription_id, plan_code, price, currency, mode, attached_at, is_current, provider_status)
            SELECT r4.owner_id, prov, sid, r4.autopay_plan_code, p.price, COALESCE(p.currency, 'INR'), bm, n, TRUE, r4.autopay_status
              FROM public.hangtag_subscriptions r4 LEFT JOIN public.hangtag_plans p ON p.code = r4.autopay_plan_code WHERE r4.owner_id = mo
            ON CONFLICT (provider, subscription_id) DO NOTHING;
        END IF;
    ELSIF mo IS NOT NULL THEN
        PERFORM 1 FROM public.hangtag_subscriptions r3 WHERE r3.owner_id = mo FOR UPDATE;
    END IF;
    SELECT * INTO mm FROM public.hangtag_autopay_mandates r5 WHERE r5.provider = prov AND r5.subscription_id = sid FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('ok', TRUE, 'known', FALSE); END IF;
    SELECT * INTO s FROM public.hangtag_subscriptions r6 WHERE r6.owner_id = mm.shop_owner_id;
    cur := FOUND AND mm.shop_owner_id IS NOT NULL AND mm.is_current AND s.autopay_provider IS NOT DISTINCT FROM mm.provider
           AND s.autopay_subscription_id IS NOT DISTINCT FROM mm.subscription_id;
    stale := NOT terminal AND at_ IS NOT NULL AND mm.last_state_event_at IS NOT NULL AND at_ < mm.last_state_event_at;
    ps := CASE WHEN stale THEN mm.provider_status
               WHEN ev IN ('activated', 'resumed') THEN 'active'
               WHEN ev = 'charged' THEN CASE WHEN mm.provider_status IN ('cancelled', 'completed', 'expired') THEN mm.provider_status ELSE 'active' END
               ELSE ev END;
    want_cancel := NOT cur AND NOT terminal AND mm.cancel_confirmed_at IS NULL AND COALESCE(ps, '') NOT IN ('cancelled', 'completed', 'expired');
    UPDATE public.hangtag_autopay_mandates SET provider_status = ps,
        last_state_event_at = CASE WHEN stale OR at_ IS NULL THEN last_state_event_at ELSE GREATEST(COALESCE(last_state_event_at, at_), at_) END,
        cancel_confirmed_at = CASE WHEN terminal THEN COALESCE(cancel_confirmed_at, n) ELSE cancel_confirmed_at END,
        cancel_requested_at = CASE WHEN want_cancel THEN COALESCE(cancel_requested_at, n) ELSE cancel_requested_at END
     WHERE id = mm.id;
    IF ev = 'charged' THEN
        amt := round(COALESCE(p_amount, 0), 2);
        IF pay = '' OR amt <= 0 THEN RAISE EXCEPTION 'A charge needs the provider''s payment and its amount.' USING ERRCODE = 'P0001'; END IF;
        IF mm.shop_owner_id IS NULL OR s.owner_id IS NULL THEN
            -- a set-up no shop recorded: the money is kept for review (to refund), never time
            x := public.hangtag_billing_exception_open(prov, 'unknown_mandate_charge', pay, NULL, NULL, amt,
                jsonb_build_object('subscription', sid, 'currency', p_currency, 'note', 'refund it in the provider''s dashboard'), pay);
            RETURN jsonb_build_object('ok', TRUE, 'known', FALSE, 'orphan', TRUE, 'recorded', FALSE, 'current', FALSE, 'cancel', want_cancel);
        END IF;
        IF EXISTS (SELECT 1 FROM public.hangtag_subscription_payments y WHERE y.provider = prov AND y.provider_payment_id = pay) THEN
            RETURN jsonb_build_object('ok', TRUE, 'known', TRUE, 'already', TRUE, 'recorded', TRUE, 'current', cur, 'cancel', want_cancel,
                'state', public.hangtag_subscription_state(s.owner_id, n));
        END IF;
        IF EXISTS (SELECT 1 FROM public.hangtag_billing_exceptions e WHERE e.provider = prov AND e.provider_payment_id = pay AND e.kind IN ('refund', 'dispute') AND e.status = 'open') THEN
            RETURN jsonb_build_object('ok', TRUE, 'known', TRUE, 'recorded', FALSE, 'refunded', TRUE, 'current', cur, 'cancel', want_cancel);
        END IF;
        SELECT p.code, p.price, p.currency INTO pl FROM public.hangtag_plans p WHERE p.code = COALESCE(mm.plan_code, s.autopay_plan_code, 'm1');
        due := COALESCE(mm.price, pl.price); due_cur := upper(COALESCE(mm.currency, pl.currency, 'INR'));
        -- a price or plan that can't be found (a plan since removed) is no price agreed: kept for review like another amount,
        -- never a failure the provider would send again and again
        IF pl.code IS NULL OR due IS NULL OR amt <> due OR upper(btrim(COALESCE(p_currency, ''))) <> due_cur THEN
            x := public.hangtag_billing_exception_open(prov, CASE WHEN pl.code IS NULL OR due IS NULL OR amt <> due THEN 'amount_mismatch' ELSE 'currency_mismatch' END, pay, s.owner_id, NULL, amt,
                jsonb_build_object('subscription', sid, 'due', due, 'currency', p_currency, 'due_currency', due_cur, 'plan', COALESCE(pl.code, mm.plan_code)), pay);
            RETURN jsonb_build_object('ok', TRUE, 'known', TRUE, 'recorded', FALSE, 'mismatch', TRUE, 'current', cur, 'cancel', want_cancel);
        END IF;
        INSERT INTO public.hangtag_subscription_payments (owner_id, plan_code, price, discount, amount, currency, provider, provider_order_id,
            provider_payment_id, status, kind, note)
        VALUES (s.owner_id, pl.code, amt, 0, amt, due_cur, prov, left(sid, 120), left(pay, 120), 'created', 'autopay',
            CASE WHEN NOT cur THEN 'Review: charge on a replaced AutoPay' END)
        ON CONFLICT (provider, provider_payment_id) DO NOTHING
        RETURNING id INTO pid;
        IF pid IS NULL THEN
            RETURN jsonb_build_object('ok', TRUE, 'known', TRUE, 'already', TRUE, 'recorded', TRUE, 'current', cur, 'cancel', want_cancel,
                'state', public.hangtag_subscription_state(s.owner_id, n));
        END IF;
        per := public.hangtag_subscription_extend(s.owner_id, pl.code);
        UPDATE public.hangtag_subscription_payments SET status = 'paid', paid_at = n, captured_at = n,
            period_start = (per ->> 'start')::TIMESTAMPTZ, period_end = (per ->> 'end')::TIMESTAMPTZ
         WHERE id = pid;
        IF cur AND NOT stale THEN
            UPDATE public.hangtag_subscriptions SET autopay_status = CASE WHEN autopay_status = 'cancelled' THEN 'cancelled' ELSE 'active' END,
                autopay_authorized_at = COALESCE(autopay_authorized_at, n), autopay_failed_at = NULL,
                autopay_next_charge_at = CASE WHEN autopay_status = 'cancelled' THEN NULL ELSE COALESCE(p_next_charge_at, (per ->> 'end')::TIMESTAMPTZ) END, updated_at = n
             WHERE owner_id = s.owner_id;
        END IF;
        RETURN jsonb_build_object('ok', TRUE, 'known', TRUE, 'recorded', TRUE, 'current', cur, 'stale', stale, 'cancel', want_cancel, 'owner', s.owner_id,
            'state', public.hangtag_subscription_state(s.owner_id, n),
            'autopay_status', (SELECT y.autopay_status FROM public.hangtag_subscriptions y WHERE y.owner_id = s.owner_id));
    END IF;
    -- a state report: the shop's AutoPay moves only for its current set-up, and not on an older report
    IF NOT cur OR stale THEN
        RETURN jsonb_build_object('ok', TRUE, 'known', mm.shop_owner_id IS NOT NULL, 'orphan', mm.shop_owner_id IS NULL, 'current', cur, 'stale', stale,
            'cancel', want_cancel);
    END IF;
    IF ev IN ('authenticated', 'activated', 'resumed') THEN
        UPDATE public.hangtag_subscriptions SET autopay_status = CASE WHEN s.autopay_status = 'cancelled' THEN 'cancelled' ELSE 'active' END,
            autopay_authorized_at = COALESCE(s.autopay_authorized_at, n), autopay_next_charge_at = COALESCE(p_next_charge_at, s.autopay_next_charge_at),
            autopay_failed_at = CASE WHEN ev = 'resumed' THEN NULL ELSE s.autopay_failed_at END, updated_at = n
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
    RETURN jsonb_build_object('ok', TRUE, 'known', TRUE, 'current', TRUE, 'stale', FALSE, 'cancel', FALSE, 'owner', s.owner_id,
        'state', public.hangtag_subscription_state(s.owner_id, n),
        'autopay_status', (SELECT y.autopay_status FROM public.hangtag_subscriptions y WHERE y.owner_id = s.owner_id));
END $$;

-- and the function it added
DROP FUNCTION IF EXISTS public.hangtag_autopay_cancel_owed(TEXT, TEXT, TEXT);
REVOKE ALL ON FUNCTION public.hangtag_billing_readiness(),
    public.hangtag_autopay_report(TEXT, TEXT, TEXT, TEXT, NUMERIC, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TEXT) FROM PUBLIC, anon, authenticated;
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
        EXECUTE $g$GRANT EXECUTE ON FUNCTION public.hangtag_billing_readiness(),
            public.hangtag_autopay_report(TEXT, TEXT, TEXT, TEXT, NUMERIC, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TEXT) TO service_role$g$;
    END IF;
END $$;
