-- WRITES (DDL). The undo of supabase/migrations/20261019120000_hangtag_post_repair_integrity.sql (generated with it by
-- scripts/gen-post-repair.mjs): the 10 functions it changed go back to supabase/schema.sql's versions, byte for
-- byte (their arguments never changed, so their grants stay as they are); its triggers and every function it added are
-- removed. Its tables stay, with what they hold (deleted products' marks; the billing mode; notifications, money for review,
-- the AutoPay registry, reconciliation runs): drop them by hand only when they are no longer needed. Redeploy the
-- subscription functions of the build before this migration first, or keep the current build: it falls back to the older
-- functions when these are gone. Run it whole; the last row says whether it took.
BEGIN;
SET LOCAL lock_timeout = '10s';
CREATE OR REPLACE FUNCTION public.hangtag_check_return_qty()
RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = ''
AS $$
DECLARE
    bought NUMERIC;
    already NUMERIC;
    what TEXT := CASE WHEN COALESCE(NEW.unit, 'pcs') = 'pcs' THEN 'piece(s)' ELSE NEW.unit END;
BEGIN
    SELECT quantity INTO bought FROM public.hangtag_sale_items
     WHERE owner_id = NEW.owner_id AND sale_id = NEW.sale_id AND line_no = NEW.sale_line_no;
    IF bought IS NULL THEN
        RAISE EXCEPTION 'Bill line % of bill % was not found', NEW.sale_line_no, NEW.sale_id USING ERRCODE = 'foreign_key_violation';
    END IF;
    SELECT COALESCE(SUM(quantity), 0) INTO already FROM public.hangtag_return_items
     WHERE owner_id = NEW.owner_id AND sale_id = NEW.sale_id AND sale_line_no = NEW.sale_line_no
       AND NOT (return_id = NEW.return_id AND line_no = NEW.line_no);
    IF already + NEW.quantity > bought THEN
        RAISE EXCEPTION 'Can''t return % %: % bought, % already returned', trim_scale(NEW.quantity), what, trim_scale(bought), trim_scale(already)
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.hangtag_save_sales(p_bills JSONB)
RETURNS JSONB LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE
    uid UUID := public.hangtag_shop_id();
    member BOOLEAN;
    b JSONB;
    s public.hangtag_sales;
    voided BOOLEAN;
    due NUMERIC;
    paid NUMERIC;
    n INT := 0;
BEGIN
    IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Sign in to save bills.' USING ERRCODE = '42501'; END IF;
    IF uid IS NULL OR NOT public.hangtag_can('create_sale') THEN RAISE EXCEPTION 'Not allowed to save bills.' USING ERRCODE = '42501'; END IF;
    member := uid <> auth.uid();
    PERFORM set_config('hangtag.bill_upload', 'on', true);
    FOR b IN SELECT * FROM jsonb_array_elements(COALESCE(p_bills, '[]'::jsonb)) LOOP
        s := jsonb_populate_record(NULL::public.hangtag_sales, b -> 'sale');
        IF COALESCE(s.id, '') = '' THEN RAISE EXCEPTION 'A bill has no id.' USING ERRCODE = '22023'; END IF;
        IF member AND EXISTS (SELECT 1 FROM public.hangtag_sales x WHERE x.owner_id = uid AND x.id = s.id) THEN n := n + 1; CONTINUE; END IF;
        INSERT INTO public.hangtag_sales (id, timestamp, subtotal, discount, total, payment_method, device_id, is_void, bill_no,
            customer_id, customer_name, customer_phone, tax_rate, tax_amount, tax_inclusive, kind, exchange_id, credit,
            item_discount, bill_discount, bill_discount_type, bill_discount_value, taxable_amount, cgst_amount, sgst_amount, igst_amount,
            round_off, gst_mode, place_of_supply, customer_gstin, customer_type, event_id, due_amount, order_id, table_id, session_id)
        VALUES (s.id, s.timestamp, COALESCE(s.subtotal, 0), COALESCE(s.discount, 0), COALESCE(s.total, 0), s.payment_method, s.device_id,
            COALESCE(s.is_void, FALSE), s.bill_no, s.customer_id, s.customer_name, s.customer_phone, COALESCE(s.tax_rate, 0),
            COALESCE(s.tax_amount, 0), COALESCE(s.tax_inclusive, TRUE), COALESCE(s.kind, 'sale'), s.exchange_id, COALESCE(s.credit, 0),
            COALESCE(s.item_discount, 0), COALESCE(s.bill_discount, 0), s.bill_discount_type, s.bill_discount_value, s.taxable_amount,
            COALESCE(s.cgst_amount, 0), COALESCE(s.sgst_amount, 0), COALESCE(s.igst_amount, 0), COALESCE(s.round_off, 0),
            s.gst_mode, s.place_of_supply, s.customer_gstin, s.customer_type, s.event_id, COALESCE(s.due_amount, 0), s.order_id, s.table_id, s.session_id)
        ON CONFLICT (owner_id, id) DO UPDATE SET timestamp = EXCLUDED.timestamp, subtotal = EXCLUDED.subtotal, discount = EXCLUDED.discount,
            total = EXCLUDED.total, payment_method = EXCLUDED.payment_method, device_id = EXCLUDED.device_id, is_void = hangtag_sales.is_void OR EXCLUDED.is_void,
            void_reason = CASE WHEN hangtag_sales.is_void OR EXCLUDED.is_void THEN hangtag_sales.void_reason END,
            bill_no = EXCLUDED.bill_no, customer_id = EXCLUDED.customer_id, customer_name = EXCLUDED.customer_name,
            customer_phone = EXCLUDED.customer_phone, tax_rate = EXCLUDED.tax_rate, tax_amount = EXCLUDED.tax_amount,
            tax_inclusive = EXCLUDED.tax_inclusive, kind = EXCLUDED.kind, exchange_id = EXCLUDED.exchange_id, credit = EXCLUDED.credit,
            item_discount = EXCLUDED.item_discount, bill_discount = EXCLUDED.bill_discount, bill_discount_type = EXCLUDED.bill_discount_type,
            bill_discount_value = EXCLUDED.bill_discount_value, taxable_amount = EXCLUDED.taxable_amount, cgst_amount = EXCLUDED.cgst_amount,
            sgst_amount = EXCLUDED.sgst_amount, igst_amount = EXCLUDED.igst_amount, round_off = EXCLUDED.round_off, gst_mode = EXCLUDED.gst_mode,
            place_of_supply = EXCLUDED.place_of_supply, customer_gstin = EXCLUDED.customer_gstin, customer_type = EXCLUDED.customer_type,
            event_id = EXCLUDED.event_id, due_amount = EXCLUDED.due_amount, order_id = EXCLUDED.order_id, table_id = EXCLUDED.table_id, session_id = EXCLUDED.session_id;
        INSERT INTO public.hangtag_sale_items (sale_id, line_no, product_id, product_name, size, quantity, unit_price, variant_id, color, sku,
            cost_price, variant_label, options, discount_type, discount_value, discount_amount, bill_discount_share, taxable_value, gst_rate,
            cgst_amount, sgst_amount, igst_amount, line_total, hsn, serials, batches, kit)
        SELECT s.id, i.line_no, i.product_id, i.product_name, COALESCE(i.size, ''), COALESCE(i.quantity, 1), COALESCE(i.unit_price, 0),
            i.variant_id, COALESCE(i.color, ''), i.sku, i.cost_price, i.variant_label, i.options, i.discount_type, i.discount_value,
            COALESCE(i.discount_amount, 0), COALESCE(i.bill_discount_share, 0), i.taxable_value, i.gst_rate, COALESCE(i.cgst_amount, 0),
            COALESCE(i.sgst_amount, 0), COALESCE(i.igst_amount, 0), i.line_total, i.hsn, i.serials, i.batches, i.kit
        FROM jsonb_populate_recordset(NULL::public.hangtag_sale_items, COALESCE(b -> 'items', '[]'::jsonb)) i
        ON CONFLICT (owner_id, sale_id, line_no) DO UPDATE SET product_id = EXCLUDED.product_id, product_name = EXCLUDED.product_name,
            size = EXCLUDED.size, quantity = EXCLUDED.quantity, unit_price = EXCLUDED.unit_price, variant_id = EXCLUDED.variant_id,
            color = EXCLUDED.color, sku = EXCLUDED.sku, cost_price = EXCLUDED.cost_price, variant_label = EXCLUDED.variant_label,
            options = EXCLUDED.options, discount_type = EXCLUDED.discount_type, discount_value = EXCLUDED.discount_value,
            discount_amount = EXCLUDED.discount_amount, bill_discount_share = EXCLUDED.bill_discount_share, taxable_value = EXCLUDED.taxable_value,
            gst_rate = EXCLUDED.gst_rate, cgst_amount = EXCLUDED.cgst_amount, sgst_amount = EXCLUDED.sgst_amount,
            igst_amount = EXCLUDED.igst_amount, line_total = EXCLUDED.line_total, hsn = EXCLUDED.hsn, serials = EXCLUDED.serials, batches = EXCLUDED.batches, kit = EXCLUDED.kit;
        SELECT x.is_void, GREATEST(x.total - x.credit - x.due_amount, 0) INTO voided, due FROM public.hangtag_sales x WHERE x.owner_id = uid AND x.id = s.id;
        DELETE FROM public.hangtag_payments p WHERE p.owner_id = uid AND p.sale_id = s.id
           AND p.id NOT IN (SELECT y ->> 'id' FROM jsonb_array_elements(COALESCE(b -> 'payments', '[]'::jsonb)) y);
        INSERT INTO public.hangtag_payments (id, sale_id, method, amount, tendered, change_given, reference, status, t, device_id,
            verification, via, intent_id, provider_payment_id, card_last4)
        SELECT p.id, s.id, p.method, p.amount, p.tendered, COALESCE(p.change_given, 0), NULLIF(btrim(p.reference), ''),
            CASE WHEN voided THEN 'cancelled' ELSE 'completed' END, COALESCE(p.t, s.timestamp), p.device_id,
            COALESCE(p.verification, 'recorded'), p.via, p.intent_id, p.provider_payment_id, NULLIF(btrim(p.card_last4), '')
        FROM jsonb_populate_recordset(NULL::public.hangtag_payments, COALESCE(b -> 'payments', '[]'::jsonb)) p
        ON CONFLICT (owner_id, id) DO UPDATE SET method = EXCLUDED.method, amount = EXCLUDED.amount, tendered = EXCLUDED.tendered,
            change_given = EXCLUDED.change_given, reference = EXCLUDED.reference, status = EXCLUDED.status, t = EXCLUDED.t,
            device_id = EXCLUDED.device_id, via = EXCLUDED.via, card_last4 = EXCLUDED.card_last4,
            verification = CASE WHEN hangtag_payments.verification = 'verified' THEN 'verified' ELSE EXCLUDED.verification END,
            intent_id = COALESCE(EXCLUDED.intent_id, hangtag_payments.intent_id),
            provider_payment_id = COALESCE(EXCLUDED.provider_payment_id, hangtag_payments.provider_payment_id);
        SELECT COALESCE(SUM(amount), 0) INTO paid FROM public.hangtag_payments WHERE owner_id = uid AND sale_id = s.id;
        IF paid <> due THEN
            RAISE EXCEPTION 'The payments on bill % come to % but % is due', COALESCE(s.bill_no, s.id), paid, due USING ERRCODE = 'check_violation';
        END IF;
        n := n + 1;
    END LOOP;
    PERFORM set_config('hangtag.bill_upload', 'off', true);
    RETURN jsonb_build_object('status', 'saved', 'bills', n);
END $$;

CREATE OR REPLACE FUNCTION public.hangtag_cap_on(p_owner UUID, p_cap TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE raw TEXT; kind TEXT; caps JSONB; v BOOLEAN; need TEXT;
BEGIN
    IF p_cap IN ('uses_mobile_store', 'uses_table_qr', 'uses_customer_ordering') AND NOT public.hangtag_access_ok(p_owner) THEN
        RETURN FALSE;
    END IF;
    SELECT lower(btrim(COALESCE(business_type, ''))) INTO raw FROM public.hangtag_profiles WHERE id = p_owner;
    kind := CASE
        WHEN raw IN ('retail','grocery','restaurant','electronics','other') THEN raw
        WHEN raw ~ '(restaurant|hotel|cafe|café|food)' THEN 'restaurant'
        WHEN raw ~ '(grocer|kirana|supermarket)' THEN 'grocery'
        WHEN raw ~ '(electronic|mobile)' THEN 'electronics'
        WHEN raw = 'other' THEN 'other'
        ELSE 'retail' END;
    SELECT m.value -> 'caps' INTO caps FROM public.hangtag_meta m WHERE m.owner_id = p_owner AND m.key = 'settings';
    IF caps IS NOT NULL AND jsonb_typeof(caps) = 'object' AND jsonb_typeof(caps -> p_cap) = 'boolean' THEN v := (caps ->> p_cap)::BOOLEAN;
    ELSE v := CASE p_cap
        WHEN 'uses_variants' THEN kind IN ('retail','grocery','electronics','other')
        WHEN 'uses_serials' THEN kind = 'electronics'
        WHEN 'uses_batches' THEN kind = 'grocery'
        WHEN 'uses_expiry' THEN kind = 'grocery'
        WHEN 'uses_weight' THEN kind = 'grocery'
        WHEN 'uses_quotations' THEN kind IN ('retail','grocery','electronics')
        WHEN 'uses_sales_orders' THEN kind IN ('retail','grocery','electronics')
        WHEN 'uses_mobile_store' THEN FALSE
        WHEN 'uses_tables' THEN kind = 'restaurant'
        WHEN 'uses_table_qr' THEN kind = 'restaurant'
        WHEN 'uses_customer_ordering' THEN kind = 'restaurant'
        WHEN 'uses_server_ordering' THEN kind = 'restaurant'
        WHEN 'uses_kitchen' THEN kind = 'restaurant'
        WHEN 'uses_price_lists' THEN FALSE
        WHEN 'uses_purchase_orders' THEN kind IN ('retail','grocery','electronics')
        WHEN 'uses_bundles' THEN kind = 'electronics'
        WHEN 'uses_repack' THEN kind = 'grocery'
        WHEN 'uses_vouchers' THEN FALSE
        WHEN 'uses_einvoice' THEN FALSE
        WHEN 'uses_eway' THEN FALSE
        ELSE FALSE END;
    END IF;
    need := CASE p_cap WHEN 'uses_mobile_store' THEN 'uses_sales_orders'
        WHEN 'uses_table_qr' THEN 'uses_tables' WHEN 'uses_customer_ordering' THEN 'uses_table_qr'
        WHEN 'uses_server_ordering' THEN 'uses_tables' WHEN 'uses_kitchen' THEN 'uses_tables' END;
    IF v AND need IS NOT NULL THEN v := public.hangtag_cap_on(p_owner, need); END IF;
    RETURN COALESCE(v, FALSE);
END $$;

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

CREATE OR REPLACE FUNCTION public.hangtag_subscription_attach(p_payment UUID, p_provider TEXT, p_order TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
    UPDATE public.hangtag_subscription_payments SET provider = lower(btrim(p_provider)), provider_order_id = p_order
     WHERE id = p_payment AND status = 'created';
END $$;

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

DROP TRIGGER IF EXISTS hangtag_tracking_required ON public.hangtag_stock_moves;
DROP FUNCTION IF EXISTS public.hangtag_tracking_required();
DROP TRIGGER IF EXISTS hangtag_product_deleted ON public.hangtag_products;
DROP FUNCTION IF EXISTS public.hangtag_product_deleted();
DROP TRIGGER IF EXISTS zz_hangtag_subscription_guard ON public.hangtag_deleted_products;
DROP FUNCTION IF EXISTS public.hangtag_billing_mode();
DROP FUNCTION IF EXISTS public.hangtag_billing_event_seen(TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.hangtag_billing_event_record(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, BOOLEAN);
DROP FUNCTION IF EXISTS public.hangtag_billing_exception_open(TEXT, TEXT, TEXT, UUID, UUID, NUMERIC, JSONB, TEXT);
DROP FUNCTION IF EXISTS public.hangtag_subscription_activate_checked(UUID, TEXT, NUMERIC, TEXT);
DROP FUNCTION IF EXISTS public.hangtag_autopay_attach_mandate(UUID, TEXT, TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.hangtag_autopay_report(TEXT, TEXT, TEXT, TEXT, NUMERIC, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TEXT);
DROP FUNCTION IF EXISTS public.hangtag_autopay_orphan(TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.hangtag_autopay_check_claim(UUID);
DROP FUNCTION IF EXISTS public.hangtag_billing_reconcile_begin(INT, TEXT);
DROP FUNCTION IF EXISTS public.hangtag_billing_reconcile_done(BIGINT, JSONB);
DROP FUNCTION IF EXISTS public.hangtag_billing_known_payments(TEXT, TEXT[]);
DROP FUNCTION IF EXISTS public.hangtag_autopay_known(TEXT, TEXT[]);
DROP FUNCTION IF EXISTS public.hangtag_billing_probe_record(TEXT, TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.hangtag_billing_integrity();
DROP FUNCTION IF EXISTS public.hangtag_billing_readiness();
DROP FUNCTION IF EXISTS public.hangtag_billing_selfcheck_allowed();
DROP FUNCTION IF EXISTS public.hangtag_platform_billing_exceptions(TEXT, INT);
DROP FUNCTION IF EXISTS public.hangtag_platform_billing_exception_resolve(BIGINT, TEXT);
DROP FUNCTION IF EXISTS public.hangtag_platform_billing_health();
DROP FUNCTION IF EXISTS public.hangtag_billing_call_claim(UUID, TEXT);
COMMIT;
SELECT md5(replace(COALESCE((SELECT p.prosrc FROM pg_proc p WHERE p.oid = to_regprocedure('public.hangtag_check_return_qty()')), ''), chr(13), '')) = 'a802051932e15ec5c1d62ae232b9013b'
   AND md5(replace(COALESCE((SELECT p.prosrc FROM pg_proc p WHERE p.oid = to_regprocedure('public.hangtag_save_sales(jsonb)')), ''), chr(13), '')) = '5ef0aea6c92fabd52de446e6d92fdcc2'
   AND md5(replace(COALESCE((SELECT p.prosrc FROM pg_proc p WHERE p.oid = to_regprocedure('public.hangtag_cap_on(uuid, text)')), ''), chr(13), '')) = '97a385ae9687f0816b544f332ec75565'
   AND md5(replace(COALESCE((SELECT p.prosrc FROM pg_proc p WHERE p.oid = to_regprocedure('public.hangtag_subscription_checkout(text, text, text)')), ''), chr(13), '')) = '96862310354cfdc53dcb747b82aaf5e2'
   AND md5(replace(COALESCE((SELECT p.prosrc FROM pg_proc p WHERE p.oid = to_regprocedure('public.hangtag_subscription_attach(uuid, text, text)')), ''), chr(13), '')) = 'ea62f55e6c34cb3bb9ca56cacd52c789'
   AND md5(replace(COALESCE((SELECT p.prosrc FROM pg_proc p WHERE p.oid = to_regprocedure('public.hangtag_promo_evaluate(uuid, text, text)')), ''), chr(13), '')) = '766f5f60c342aadc7dd62513f651d4f9'
   AND md5(replace(COALESCE((SELECT p.prosrc FROM pg_proc p WHERE p.oid = to_regprocedure('public.hangtag_autopay_begin(boolean, text)')), ''), chr(13), '')) = '7c5bb10343221aa0efad299494d5fa6a'
   AND md5(replace(COALESCE((SELECT p.prosrc FROM pg_proc p WHERE p.oid = to_regprocedure('public.hangtag_autopay_terms(uuid)')), ''), chr(13), '')) = '25e73292fd619bcc193bd3b3d86eff6e'
   AND md5(replace(COALESCE((SELECT p.prosrc FROM pg_proc p WHERE p.oid = to_regprocedure('public.hangtag_platform_settings_save(jsonb)')), ''), chr(13), '')) = '91c06bcc3a09b5f70573a4b7c74a51e4'
   AND md5(replace(COALESCE((SELECT p.prosrc FROM pg_proc p WHERE p.oid = to_regprocedure('public.hangtag_subscription_ensure(uuid)')), ''), chr(13), '')) = 'bd162ea7d34eb620aa4ced0de13248c7'
   AND to_regprocedure('public.hangtag_tracking_required()') IS NULL AND to_regprocedure('public.hangtag_product_deleted()') IS NULL
   AND NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = to_regclass('public.hangtag_deleted_products') AND t.tgname = 'zz_hangtag_subscription_guard')
   AND to_regprocedure('public.hangtag_billing_mode()') IS NULL
   AND to_regprocedure('public.hangtag_billing_event_seen(text, text, text)') IS NULL
   AND to_regprocedure('public.hangtag_billing_event_record(text, text, text, text, text, text, timestamptz, text, boolean)') IS NULL
   AND to_regprocedure('public.hangtag_billing_exception_open(text, text, text, uuid, uuid, numeric, jsonb, text)') IS NULL
   AND to_regprocedure('public.hangtag_subscription_activate_checked(uuid, text, numeric, text)') IS NULL
   AND to_regprocedure('public.hangtag_autopay_attach_mandate(uuid, text, text, text, text)') IS NULL
   AND to_regprocedure('public.hangtag_autopay_report(text, text, text, text, numeric, text, timestamptz, timestamptz, text)') IS NULL
   AND to_regprocedure('public.hangtag_autopay_orphan(text, text, text)') IS NULL
   AND to_regprocedure('public.hangtag_autopay_check_claim(uuid)') IS NULL
   AND to_regprocedure('public.hangtag_billing_reconcile_begin(int, text)') IS NULL
   AND to_regprocedure('public.hangtag_billing_reconcile_done(bigint, jsonb)') IS NULL
   AND to_regprocedure('public.hangtag_billing_known_payments(text, text[])') IS NULL
   AND to_regprocedure('public.hangtag_autopay_known(text, text[])') IS NULL
   AND to_regprocedure('public.hangtag_billing_probe_record(text, text, text, text)') IS NULL
   AND to_regprocedure('public.hangtag_billing_integrity()') IS NULL
   AND to_regprocedure('public.hangtag_billing_readiness()') IS NULL
   AND to_regprocedure('public.hangtag_billing_selfcheck_allowed()') IS NULL
   AND to_regprocedure('public.hangtag_platform_billing_exceptions(text, int)') IS NULL
   AND to_regprocedure('public.hangtag_platform_billing_exception_resolve(bigint, text)') IS NULL
   AND to_regprocedure('public.hangtag_platform_billing_health()') IS NULL
   AND to_regprocedure('public.hangtag_billing_call_claim(uuid, text)') IS NULL AS undone;
