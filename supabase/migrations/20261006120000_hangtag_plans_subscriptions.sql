-- ==============================================================================
-- Hangtag: plans, subscriptions, promo codes, the access lock and the Agent's rate limit (schema.sql section 3t)
--   a 7-day free trial for every shop (from the end of its setup; one per email), paid plans of 1, 3 and 6 months with
--   prices kept here (hangtag_plans), promo codes checked only by the database, plan payments created by the database and
--   activated only after the payment provider confirmed them (subscription Edge Function), the lock (every business write
--   of the app refused with SQLSTATE HT402 once a shop's trial or plan has ended — reads keep working, nothing is deleted),
--   and the Agent's per-user / per-shop request limits (agent Edge Function).
--
-- For the live database that supabase/schema.sql builds (the hangtag_* tables). It needs everything up to section 3s
-- (bank accounts) already applied: run supabase/schema.sql once, or run this file after it. Safe to run again.
-- It is exactly section 3t of schema.sql (including its row security rules and grants), so running the whole schema.sql
-- again gives the same result.
--
-- IMPORTANT when it first runs: every shop that is already set up gets a 7-day free trial starting NOW. Give a shop paid
-- time without a payment with hangtag_admin_grant (examples in supabase/README.md, "Plans, subscriptions and promo codes").
--
-- Requires: supabase/schema.sql (applied first; supabase/tests/subscriptions.test.mjs runs this file on top of it, twice)
-- How to apply: Supabase → SQL Editor → New query → paste this file → Run (or `supabase db push`).
-- ==============================================================================
-- ==============================================================================
-- 3t. Plans, subscriptions, promo codes and the access lock (Wave 12)
--   Every shop starts with a free trial (7 days, from the plan 'trial') when its setup is finished (hangtag_profiles.
--   onboarded_at) — or, for a shop that never finished setup, at its first business write. One trial per email: an account
--   made again with the same email gets no new one. Paid plans (1, 3 or 6 months) and their prices live in hangtag_plans;
--   change a price with an UPDATE, never in the app. Promo codes (hangtag_promo_codes) are checked ONLY here: percentage
--   or fixed, for some or all plans, a start and an end, a total limit and a limit per shop, switched on or off.
--   A payment is created by the database with the price and discount it computed itself; the subscription Edge Function
--   sends the customer to the payment provider, and only the provider's confirmation (checked by the function with the
--   service role) activates it — the new period starts when the current trial or plan ends, so no paid day is lost.
--   The lock: when a shop's trial or plan has ended (or Hangtag suspended it), every write of the app to a business table
--   is refused with SQLSTATE HT402 (the trigger hangtag_subscription_guard on every table with an owner_id, below).
--   Reads keep working — the locked app shows the shop's plan and lets the owner pay — and nothing is deleted or archived:
--   renewing opens everything again at once. The public store and table ordering answer "closed" while a shop is locked.
--   Trusted callers (the service role of Edge Functions, the SQL Editor) are never blocked.
--   Also here: the Agent's server-side rate limit (hangtag_agent_take, used only by the agent Edge Function).
-- ==============================================================================
CREATE TABLE IF NOT EXISTS public.hangtag_plans (
    code TEXT PRIMARY KEY CHECK (code ~ '^[a-z0-9_]{1,20}$'),
    label TEXT NOT NULL CHECK (char_length(btrim(label)) BETWEEN 1 AND 40),
    kind TEXT NOT NULL CHECK (kind IN ('trial','paid')),
    months INT CHECK (months IS NULL OR months BETWEEN 1 AND 36),
    days INT CHECK (days IS NULL OR days BETWEEN 1 AND 90),
    price NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (price >= 0),
    currency TEXT NOT NULL DEFAULT 'INR' CHECK (currency ~ '^[A-Z]{3}$'),
    active BOOLEAN NOT NULL DEFAULT TRUE,
    sort INT NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT hangtag_plans_length_check CHECK ((kind = 'trial' AND days IS NOT NULL AND months IS NULL) OR (kind = 'paid' AND months IS NOT NULL AND days IS NULL))
);
-- the starting prices (placeholders: change them with UPDATE public.hangtag_plans SET price = … WHERE code = 'm1'; a re-run of
-- this script never overwrites a price that was changed)
INSERT INTO public.hangtag_plans (code, label, kind, months, days, price, sort) VALUES
    ('trial', 'Free trial', 'trial', NULL, 7, 0, 0),
    ('m1', '1 month', 'paid', 1, NULL, 499, 1),
    ('m3', '3 months', 'paid', 3, NULL, 1349, 2),
    ('m6', '6 months', 'paid', 6, NULL, 2499, 3)
ON CONFLICT (code) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.hangtag_subscriptions (
    owner_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    trial_started_at TIMESTAMPTZ NOT NULL,
    trial_ends_at TIMESTAMPTZ NOT NULL,
    plan_code TEXT REFERENCES public.hangtag_plans(code),
    period_start TIMESTAMPTZ,
    period_end TIMESTAMPTZ,
    suspended BOOLEAN NOT NULL DEFAULT FALSE,
    suspended_reason TEXT CHECK (suspended_reason IS NULL OR char_length(suspended_reason) <= 200),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT hangtag_subscriptions_trial_check CHECK (trial_ends_at >= trial_started_at),
    CONSTRAINT hangtag_subscriptions_period_check CHECK (period_end IS NULL OR (period_start IS NOT NULL AND period_end > period_start))
);
-- one free trial per email (md5 of the lower-cased email; kept when an account is deleted, so a new account with the
-- same email does not get a second trial)
CREATE TABLE IF NOT EXISTS public.hangtag_trial_claims (
    email_key TEXT PRIMARY KEY CHECK (email_key ~ '^[0-9a-f]{32}$'),
    owner_id UUID NOT NULL,
    claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS public.hangtag_promo_codes (
    code TEXT PRIMARY KEY CHECK (code = upper(code) AND code ~ '^[A-Z0-9_-]{3,32}$'),
    kind TEXT NOT NULL CHECK (kind IN ('percent','fixed')),
    value NUMERIC(12,2) NOT NULL CHECK (value > 0 AND (kind <> 'percent' OR value <= 100)),
    plans TEXT[],
    starts_at TIMESTAMPTZ,
    ends_at TIMESTAMPTZ,
    max_uses INT CHECK (max_uses IS NULL OR max_uses > 0),
    per_account_limit INT NOT NULL DEFAULT 1 CHECK (per_account_limit > 0),
    active BOOLEAN NOT NULL DEFAULT TRUE,
    note TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT hangtag_promo_codes_window_check CHECK (starts_at IS NULL OR ends_at IS NULL OR ends_at > starts_at)
);
CREATE TABLE IF NOT EXISTS public.hangtag_subscription_payments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    plan_code TEXT NOT NULL REFERENCES public.hangtag_plans(code),
    price NUMERIC(12,2) NOT NULL CHECK (price >= 0),
    discount NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (discount >= 0 AND discount <= price),
    amount NUMERIC(12,2) NOT NULL CHECK (amount >= 0),
    currency TEXT NOT NULL DEFAULT 'INR',
    promo_code TEXT REFERENCES public.hangtag_promo_codes(code),
    provider TEXT NOT NULL CHECK (provider ~ '^[a-z][a-z0-9_]{1,30}$'),
    provider_order_id TEXT CHECK (provider_order_id IS NULL OR char_length(provider_order_id) <= 120),
    provider_payment_id TEXT CHECK (provider_payment_id IS NULL OR char_length(provider_payment_id) <= 120),
    status TEXT NOT NULL DEFAULT 'created' CHECK (status IN ('created','paid','failed','cancelled','expired')),
    period_start TIMESTAMPTZ,
    period_end TIMESTAMPTZ,
    note TEXT CHECK (note IS NULL OR char_length(note) <= 200),
    created_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    paid_at TIMESTAMPTZ,
    CONSTRAINT hangtag_subscription_payments_total_check CHECK (amount = price - discount),
    CONSTRAINT hangtag_subscription_payments_provider_payment_key UNIQUE (provider, provider_payment_id)
);
CREATE INDEX IF NOT EXISTS idx_hangtag_subscription_payments_owner ON public.hangtag_subscription_payments (owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_hangtag_subscription_payments_promo ON public.hangtag_subscription_payments (promo_code, status, created_at) WHERE promo_code IS NOT NULL;
CREATE TABLE IF NOT EXISTS public.hangtag_promo_redemptions (
    payment_id UUID PRIMARY KEY REFERENCES public.hangtag_subscription_payments(id) ON DELETE CASCADE,
    code TEXT NOT NULL REFERENCES public.hangtag_promo_codes(code),
    owner_id UUID NOT NULL,
    plan_code TEXT,
    discount NUMERIC(12,2) NOT NULL DEFAULT 0,
    redeemed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_hangtag_promo_redemptions_code ON public.hangtag_promo_redemptions (code, owner_id);
-- the Agent's request counters (per user and per shop, per minute and per UTC day)
CREATE TABLE IF NOT EXISTS public.hangtag_agent_usage (
    subject TEXT NOT NULL CHECK (char_length(subject) <= 80),
    bucket TIMESTAMPTZ NOT NULL,
    hits INT NOT NULL DEFAULT 0,
    PRIMARY KEY (subject, bucket)
);

-- A shop's plan record: made once (idempotent), when its setup is finished or at its first business write. A team member
-- has no shop of its own, so no trial. The email's trial is claimed; a second account with the same email starts with
-- its trial already over.
CREATE OR REPLACE FUNCTION public.hangtag_subscription_ensure(p_owner UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    trial_days INT;
    em TEXT;
    k TEXT;
    claimed UUID;
    started TIMESTAMPTZ := NOW();
BEGIN
    IF p_owner IS NULL OR EXISTS (SELECT 1 FROM public.hangtag_subscriptions s WHERE s.owner_id = p_owner) THEN RETURN; END IF;
    IF EXISTS (SELECT 1 FROM public.hangtag_members m WHERE m.user_id = p_owner) THEN RETURN; END IF;
    IF NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = p_owner) THEN RETURN; END IF;
    SELECT p.days INTO trial_days FROM public.hangtag_plans p WHERE p.code = 'trial';
    trial_days := COALESCE(trial_days, 7);
    SELECT lower(btrim(u.email)) INTO em FROM auth.users u WHERE u.id = p_owner;
    IF COALESCE(em, '') <> '' THEN
        k := md5(em);
        INSERT INTO public.hangtag_trial_claims (email_key, owner_id) VALUES (k, p_owner) ON CONFLICT (email_key) DO NOTHING;
        SELECT c.owner_id INTO claimed FROM public.hangtag_trial_claims c WHERE c.email_key = k;
    END IF;
    INSERT INTO public.hangtag_subscriptions (owner_id, trial_started_at, trial_ends_at)
    VALUES (p_owner, started, CASE WHEN claimed IS NOT NULL AND claimed <> p_owner THEN started ELSE started + make_interval(days => trial_days) END)
    ON CONFLICT (owner_id) DO NOTHING;
END $$;

-- trial_active · paid_active · trial_expired · paid_expired · suspended · none (no plan record: setup not finished)
CREATE OR REPLACE FUNCTION public.hangtag_subscription_state(p_owner UUID, p_now TIMESTAMPTZ DEFAULT NOW())
RETURNS TEXT LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE s RECORD;
BEGIN
    SELECT x.suspended, x.trial_ends_at, x.period_end INTO s FROM public.hangtag_subscriptions x WHERE x.owner_id = p_owner;
    IF NOT FOUND THEN RETURN 'none'; END IF;
    IF s.suspended THEN RETURN 'suspended'; END IF;
    IF s.period_end IS NOT NULL AND s.period_end > p_now THEN RETURN 'paid_active'; END IF;
    IF s.trial_ends_at > p_now THEN RETURN 'trial_active'; END IF;
    IF s.period_end IS NOT NULL THEN RETURN 'paid_expired'; END IF;
    RETURN 'trial_expired';
END $$;

-- whether a shop may use Hangtag now: a running trial or plan (or a shop whose setup isn't finished and has no record yet)
CREATE OR REPLACE FUNCTION public.hangtag_access_ok(p_owner UUID)
RETURNS BOOLEAN LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE st TEXT := public.hangtag_subscription_state(p_owner, NOW());
BEGIN
    IF st IN ('trial_active', 'paid_active') THEN RETURN TRUE; END IF;
    IF st = 'none' THEN
        RETURN NOT EXISTS (SELECT 1 FROM public.hangtag_profiles p WHERE p.id = p_owner AND p.onboarded_at IS NOT NULL);
    END IF;
    RETURN FALSE;
END $$;

-- the trial starts when the shop's setup is finished
CREATE OR REPLACE FUNCTION public.hangtag_subscription_on_onboard()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
    IF NEW.onboarded_at IS NOT NULL THEN PERFORM public.hangtag_subscription_ensure(NEW.id); END IF;
    RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS hangtag_subscription_on_onboard ON public.hangtag_profiles;
CREATE TRIGGER hangtag_subscription_on_onboard AFTER INSERT OR UPDATE OF onboarded_at ON public.hangtag_profiles
    FOR EACH ROW EXECUTE FUNCTION public.hangtag_subscription_on_onboard();

-- The lock. On every business table (the loop below): a write by the app (role authenticated or anon — also inside the
-- SECURITY DEFINER functions the app calls, which keep that role) to a shop whose trial or plan has ended is refused with
-- SQLSTATE HT402. The app keeps such a change queued and shows Plans & Billing. Trusted roles pass. Deletes made by the
-- database itself (cascades, triggers) pass.
CREATE OR REPLACE FUNCTION public.hangtag_subscription_guard()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE shop UUID;
BEGIN
    IF COALESCE(current_setting('role', true), '') NOT IN ('authenticated', 'anon') THEN
        IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
    END IF;
    IF TG_OP = 'DELETE' THEN
        IF pg_trigger_depth() > 1 THEN RETURN OLD; END IF;
        shop := OLD.owner_id;
    ELSE
        shop := NEW.owner_id;
    END IF;
    IF shop IS NOT NULL THEN
        IF NOT EXISTS (SELECT 1 FROM public.hangtag_subscriptions s WHERE s.owner_id = shop) THEN
            PERFORM public.hangtag_subscription_ensure(shop);
        END IF;
        IF NOT public.hangtag_access_ok(shop) THEN
            RAISE EXCEPTION 'HANGTAG_SUBSCRIPTION_INACTIVE: This shop''s Hangtag plan has ended. Renew it in Plans & Billing.'
                USING ERRCODE = 'HT402', HINT = 'Open Plans & Billing to choose a plan.';
        END IF;
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END $$;
-- every table with an owner_id, except the team's device records (their sign-in check writes them), the audit log
-- (written by the database), old backups and this section's own tables. Named zz_ so it runs after the other BEFORE
-- triggers that complete a row.
DO $$
DECLARE t TEXT;
BEGIN
    FOR t IN SELECT c.table_name FROM information_schema.columns c
               JOIN information_schema.tables tb ON tb.table_schema = c.table_schema AND tb.table_name = c.table_name AND tb.table_type = 'BASE TABLE'
              WHERE c.table_schema = 'public' AND c.column_name = 'owner_id' AND c.table_name LIKE 'hangtag\_%'
                AND c.table_name NOT LIKE 'hangtag\_backup\_%'
                AND c.table_name NOT IN ('hangtag_audit_log', 'hangtag_devices', 'hangtag_enrollments', 'hangtag_subscriptions',
                    'hangtag_subscription_payments', 'hangtag_promo_redemptions', 'hangtag_trial_claims')
    LOOP
        EXECUTE format('DROP TRIGGER IF EXISTS zz_hangtag_subscription_guard ON public.%I', t);
        EXECUTE format('CREATE TRIGGER zz_hangtag_subscription_guard BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.hangtag_subscription_guard()', t);
    END LOOP;
END $$;

-- The public store and table ordering are "closed" while the shop is locked (the same answer as a store that is switched
-- off). Otherwise exactly as section 3r defines hangtag_cap_on.
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
REVOKE ALL ON FUNCTION public.hangtag_cap_on(UUID,TEXT) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.hangtag_cap_on(UUID,TEXT) TO authenticated;

-- The public store pages (Wave 12): the catalog also gives the shop's region (its currency and number style: the store page
-- writes money the shop's way), and an order's status page gives its stages (received → confirmed → ready → completed, or
-- cancelled), its lines, the total and how to reach the shop. Otherwise exactly as section 3s / 3q define them.
CREATE OR REPLACE FUNCTION public.hangtag_mobile_catalog(p_token TEXT)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE shop RECORD; items JSONB; cats JSONB; logo TEXT; region TEXT; tax_on BOOLEAN := FALSE; tax_incl BOOLEAN := TRUE; default_rate NUMERIC := 5;
BEGIN
    IF p_token IS NULL OR p_token !~ '^st_[A-Za-z0-9_-]{32,61}$' THEN
        RETURN jsonb_build_object('ok', FALSE, 'message', 'This shop link is not valid. Ask the shop for a new link.');
    END IF;
    SELECT p.id, p.shop_name, p.city INTO shop FROM public.hangtag_profiles p WHERE p.store_token = p_token;
    IF NOT FOUND THEN RETURN jsonb_build_object('ok', FALSE, 'message', 'This mobile store is not open right now.'); END IF;
    -- closed (switched off, or the shop's plan has ended): its name and town, so the page says whose store is closed
    IF NOT public.hangtag_cap_on(shop.id, 'uses_mobile_store') THEN
        RETURN jsonb_build_object('ok', FALSE, 'closed', TRUE, 'message', 'This mobile store is not open right now.',
            'shop', COALESCE(NULLIF(btrim(shop.shop_name), ''), 'Shop'), 'city', NULLIF(btrim(COALESCE(shop.city, '')), ''));
    END IF;
    SELECT CASE WHEN m.value->>'region' ~ '^[A-Z]{2}$' THEN m.value->>'region' END,
           COALESCE(CASE WHEN jsonb_typeof(m.value->'taxOn')='boolean' THEN (m.value->>'taxOn')::BOOLEAN END,FALSE),
           COALESCE(CASE WHEN jsonb_typeof(m.value->'taxIncl')='boolean' THEN (m.value->>'taxIncl')::BOOLEAN END,TRUE),
           COALESCE(CASE WHEN jsonb_typeof(m.value->'taxRate')='number' THEN (m.value->>'taxRate')::NUMERIC END,5)
      INTO region,tax_on,tax_incl,default_rate FROM public.hangtag_meta m WHERE m.owner_id=shop.id AND m.key='settings';
    SELECT COALESCE(jsonb_agg(x.item ORDER BY x.sort_key), '[]'::jsonb) INTO items FROM (
        SELECT jsonb_build_object('id', p.id, 'name', p.name, 'description', COALESCE(p.description, ''),
                   'brand', COALESCE(p.brand, ''), 'category', COALESCE(p.category, ''), 'gst', CASE WHEN tax_on THEN COALESCE(p.gst_rate,default_rate) ELSE 0 END,
                   'unit', COALESCE(p.unit, 'pcs'), 'image', CASE WHEN im.image_data ~ '^data:image/(png|jpeg|webp);base64,' THEN im.image_data END,
                   'variants', (SELECT COALESCE(jsonb_agg(jsonb_build_object('v', v.id,
                       'label', COALESCE((SELECT string_agg(e.value, ' / ' ORDER BY e.n) FROM jsonb_array_elements_text(v.option_values) WITH ORDINALITY e(value,n)), ''),
                       'price', public.hangtag_list_price(p.owner_id, NULL, NULL, p.id, v.id, COALESCE(v.price, p.price)), 'available', public.hangtag_mobile_available(p.owner_id, v.id))
                       ORDER BY v.sort_order, v.id), '[]'::jsonb)
                     FROM public.hangtag_variants v WHERE v.owner_id = p.owner_id AND v.product_id = p.id AND v.active)) AS item,
               lower(COALESCE(p.category, 'zzz')) || '|' || lpad(p.sort_order::TEXT, 10, '0') || '|' || lower(p.name) AS sort_key
          FROM public.hangtag_products p LEFT JOIN public.hangtag_images im ON im.owner_id = p.owner_id AND im.product_id = p.id
         WHERE p.owner_id = shop.id AND NOT p.archived AND p.bundle IS NULL
           AND EXISTS (SELECT 1 FROM public.hangtag_variants v WHERE v.owner_id = p.owner_id AND v.product_id = p.id AND v.active)
         ORDER BY lower(COALESCE(p.category, 'zzz')), p.sort_order, lower(p.name) LIMIT 500) x;
    SELECT COALESCE(jsonb_agg(c ORDER BY lower(c)), '[]'::jsonb) INTO cats FROM (
        SELECT DISTINCT btrim(p.category) c FROM public.hangtag_products p WHERE p.owner_id = shop.id AND NOT p.archived AND p.bundle IS NULL AND btrim(COALESCE(p.category, '')) <> '') q;
    -- the shop's logo (the one printed on its receipts), only when it is a picture
    SELECT CASE WHEN jsonb_typeof(m.value) = 'string' AND (m.value #>> '{}') ~ '^data:image/(png|jpeg|webp);base64,' THEN m.value #>> '{}' END
      INTO logo FROM public.hangtag_meta m WHERE m.owner_id = shop.id AND m.key = 'logo';
    RETURN jsonb_build_object('ok', TRUE, 'shop', COALESCE(NULLIF(btrim(shop.shop_name), ''), 'Shop'), 'city', NULLIF(btrim(COALESCE(shop.city, '')), ''), 'logo', logo, 'tax_on', tax_on,
        'tax_inclusive', tax_incl, 'items', items, 'categories', cats, 'region', COALESCE(region, 'IN'));
END $$;
CREATE OR REPLACE FUNCTION public.hangtag_mobile_order_status(p_order_token TEXT)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE o public.hangtag_orders; ordered NUMERIC; billed NUMERIC; state TEXT; state_label TEXT; payment_state TEXT; payment_label TEXT;
    prof RECORD; items JSONB; region TEXT;
BEGIN
    IF p_order_token IS NULL OR p_order_token !~ '^mo_[A-Za-z0-9_-]{32,61}$' THEN RETURN jsonb_build_object('ok', FALSE, 'message', 'That order link is not valid.'); END IF;
    SELECT * INTO o FROM public.hangtag_orders x WHERE x.public_token = p_order_token;
    IF NOT FOUND THEN RETURN jsonb_build_object('ok', FALSE, 'message', 'That order was not found.'); END IF;
    SELECT COALESCE(sum(i.qty),0) INTO ordered FROM public.hangtag_order_items i WHERE i.owner_id=o.owner_id AND i.order_id=o.id;
    SELECT COALESCE(sum(i.quantity),0) INTO billed FROM public.hangtag_sales s JOIN public.hangtag_sale_items i ON i.owner_id=s.owner_id AND i.sale_id=s.id
     WHERE s.owner_id=o.owner_id AND s.order_id=o.id AND NOT s.is_void;
    IF EXISTS (SELECT 1 FROM public.hangtag_sales s WHERE s.owner_id=o.owner_id AND s.order_id=o.id AND NOT s.is_void
        AND COALESCE((SELECT sum(p.amount) FROM public.hangtag_payments p WHERE p.owner_id=s.owner_id AND p.sale_id=s.id AND p.status='completed'),0)
            >= GREATEST(s.total-s.credit-s.due_amount,0)) THEN payment_state:='confirmed'; payment_label:='Payment confirmed';
    ELSE payment_state:='awaiting_staff'; payment_label:=CASE o.payment_preference WHEN 'upi' THEN 'UPI to be verified by staff' WHEN 'cash' THEN 'Cash at checkout' ELSE 'Pay at checkout' END; END IF;
    -- received (placed) → confirmed (the shop has worked on it) → ready (all of it billed, payment pending) → completed (paid);
    -- or cancelled. "partial": some of it is ready.
    IF o.status='cancelled' THEN state:='cancelled'; state_label:='Cancelled';
    ELSIF ordered>0 AND billed>=ordered THEN
        IF payment_state='confirmed' THEN state:='completed'; state_label:='Completed'; ELSE state:='ready'; state_label:='Ready'; END IF;
    ELSIF billed>0 THEN state:='partial'; state_label:='Partly ready';
    -- a store order arrives already reserved (status confirmed, version 1): "Received" until the shop works on it
    ELSIF COALESCE(o.version, 1) > 1 THEN state:='confirmed'; state_label:='Confirmed';
    ELSE state:='received'; state_label:='Received'; END IF;
    SELECT p.shop_name, p.phone, p.city INTO prof FROM public.hangtag_profiles p WHERE p.id = o.owner_id;
    SELECT CASE WHEN m.value->>'region' ~ '^[A-Z]{2}$' THEN m.value->>'region' END INTO region FROM public.hangtag_meta m WHERE m.owner_id = o.owner_id AND m.key = 'settings';
    SELECT COALESCE(jsonb_agg(jsonb_build_object('name', i.name, 'label', COALESCE(i.variant_label, ''), 'qty', i.qty) ORDER BY i.line_no), '[]'::jsonb) INTO items
      FROM public.hangtag_order_items i WHERE i.owner_id = o.owner_id AND i.order_id = o.id;
    RETURN jsonb_build_object('ok',TRUE,'order_no',o.no,'state',state,'state_label',state_label,'payment_state',payment_state,'payment_label',payment_label,
        'total',o.total,'mode',COALESCE(o.checkout_mode,'store'),'updated_at',o.updated_at,'placed_at',o.created_at,'items',items,
        'shop',COALESCE(NULLIF(btrim(prof.shop_name),''),'Shop'),'shop_phone',NULLIF(btrim(COALESCE(prof.phone,'')),''),'shop_city',NULLIF(btrim(COALESCE(prof.city,'')),''),
        'region',COALESCE(region,'IN'));
END $$;
REVOKE ALL ON FUNCTION public.hangtag_mobile_order_status(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.hangtag_mobile_order_status(TEXT) TO anon,authenticated;

-- (internal) A promo code checked for a shop and a plan: { code, valid, reason, message, kind, value, discount }.
-- Counted uses: paid redemptions, plus checkouts started in the last 30 minutes by OTHER shops (so a burst of checkouts
-- cannot overrun the total limit, and trying again does not block yourself).
CREATE OR REPLACE FUNCTION public.hangtag_promo_evaluate(p_owner UUID, p_plan TEXT, p_code TEXT)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    v_code TEXT := upper(btrim(COALESCE(p_code, '')));
    c RECORD;
    pl RECORD;
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
    SELECT (SELECT count(*) FROM public.hangtag_promo_redemptions r WHERE r.code = v_code)
         + (SELECT count(*) FROM public.hangtag_subscription_payments y WHERE y.promo_code = v_code AND y.status = 'created'
              AND y.created_at > NOW() - interval '30 minutes' AND y.owner_id IS DISTINCT FROM p_owner)
      INTO used_total;
    IF NOT c.active THEN reason := 'inactive'; msg := 'This promo code is no longer active.';
    ELSIF c.starts_at IS NOT NULL AND c.starts_at > NOW() THEN reason := 'not_started'; msg := 'This promo code isn''t active yet.';
    ELSIF c.ends_at IS NOT NULL AND c.ends_at <= NOW() THEN reason := 'expired'; msg := 'This promo code has expired.';
    ELSIF c.plans IS NOT NULL AND NOT (p_plan = ANY (c.plans)) THEN
        reason := 'not_for_plan'; msg := 'This promo code isn''t for the ' || COALESCE(pl.label, 'chosen') || ' plan.';
    ELSIF used_mine >= c.per_account_limit THEN reason := 'already_used'; msg := 'You have already used this promo code.';
    ELSIF c.max_uses IS NOT NULL AND used_total >= c.max_uses THEN reason := 'used_up'; msg := 'This promo code has been fully used.';
    END IF;
    IF reason IS NOT NULL THEN
        RETURN jsonb_build_object('code', v_code, 'valid', FALSE, 'reason', reason, 'message', msg, 'kind', c.kind, 'value', c.value, 'discount', 0);
    END IF;
    disc := CASE WHEN c.kind = 'percent' THEN round(COALESCE(pl.price, 0) * c.value / 100, 2) ELSE c.value END;
    disc := LEAST(GREATEST(disc, 0), COALESCE(pl.price, 0));
    RETURN jsonb_build_object('code', v_code, 'valid', TRUE, 'reason', NULL, 'message', 'Promo code applied.', 'kind', c.kind, 'value', c.value, 'discount', disc);
END $$;

-- (internal) the caller is the shop's owner (a team member never chooses or pays for a plan)
CREATE OR REPLACE FUNCTION public.hangtag_subscription_owner()
RETURNS UUID LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE u UUID := auth.uid();
BEGIN
    IF u IS NULL OR public.hangtag_shop_id() IS DISTINCT FROM u OR EXISTS (SELECT 1 FROM public.hangtag_members m WHERE m.user_id = u) THEN
        RAISE EXCEPTION 'Only the shop owner can choose a plan.' USING ERRCODE = 'P0001';
    END IF;
    RETURN u;
END $$;

-- 1. The plan of the caller's shop (owner or team member), for the app's lock and Plans & Billing. Works while locked.
CREATE OR REPLACE FUNCTION public.hangtag_subscription_status()
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    shop UUID := public.hangtag_shop_id();
    n TIMESTAMPTZ := NOW();
    s RECORD;
    st TEXT;
    plan_label TEXT;
    trial_days INT;
    until_at TIMESTAMPTZ;
BEGIN
    IF shop IS NULL THEN
        RETURN jsonb_build_object('state', 'none', 'server_now', n, 'is_owner', FALSE, 'days_left', 0, 'suspended', FALSE);
    END IF;
    IF EXISTS (SELECT 1 FROM public.hangtag_profiles p WHERE p.id = shop AND p.onboarded_at IS NOT NULL) THEN
        PERFORM public.hangtag_subscription_ensure(shop);
    END IF;
    SELECT * INTO s FROM public.hangtag_subscriptions x WHERE x.owner_id = shop;
    st := public.hangtag_subscription_state(shop, n);
    SELECT p.days INTO trial_days FROM public.hangtag_plans p WHERE p.code = 'trial';
    IF s.owner_id IS NULL THEN
        RETURN jsonb_build_object('state', st, 'server_now', n, 'is_owner', shop = auth.uid(), 'days_left', 0, 'suspended', FALSE,
            'trial_days', COALESCE(trial_days, 7));
    END IF;
    SELECT p.label INTO plan_label FROM public.hangtag_plans p WHERE p.code = s.plan_code;
    until_at := GREATEST(s.trial_ends_at, s.period_end);
    RETURN jsonb_build_object(
        'state', st,
        'plan_code', s.plan_code,
        'plan_label', plan_label,
        'trial_days', COALESCE(trial_days, 7),
        'trial_started_at', s.trial_started_at,
        'trial_ends_at', s.trial_ends_at,
        'period_start', s.period_start,
        'period_end', s.period_end,
        'access_until', until_at,
        'days_left', CASE WHEN st IN ('trial_active', 'paid_active') THEN GREATEST(0, ceil(extract(epoch FROM (until_at - n)) / 86400))::INT ELSE 0 END,
        'server_now', n,
        'is_owner', shop = auth.uid(),
        'suspended', s.suspended,
        'suspended_reason', CASE WHEN shop = auth.uid() THEN s.suspended_reason END);
END $$;

-- 2. The plans on sale, cheapest period first: [{ code, label, months, price, currency }]
CREATE OR REPLACE FUNCTION public.hangtag_subscription_plans()
RETURNS JSONB LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
    SELECT COALESCE(jsonb_agg(jsonb_build_object('code', p.code, 'label', p.label, 'months', p.months, 'price', p.price, 'currency', p.currency)
        ORDER BY p.sort, p.months), '[]'::jsonb)
      FROM public.hangtag_plans p WHERE p.kind = 'paid' AND p.active;
$$;

-- 3. The price of a plan with a promo code, computed here (the owner only)
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
        IF (promo ->> 'valid')::BOOLEAN THEN disc := (promo ->> 'discount')::NUMERIC; END IF;
    END IF;
    RETURN jsonb_build_object('ok', TRUE, 'plan', jsonb_build_object('code', pl.code, 'label', pl.label, 'months', pl.months),
        'price', pl.price, 'discount', disc, 'amount', pl.price - disc, 'currency', pl.currency, 'promo', promo);
END $$;

-- 4. A payment for a plan, with the price and discount computed here (the owner only; the subscription Edge Function calls
-- it as the owner). A refused promo code refuses the checkout with its message.
CREATE OR REPLACE FUNCTION public.hangtag_subscription_checkout(p_plan TEXT, p_promo TEXT DEFAULT NULL, p_provider TEXT DEFAULT 'razorpay')
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    me UUID := public.hangtag_subscription_owner();
    q JSONB;
    pid UUID;
    prov TEXT := lower(btrim(COALESCE(p_provider, '')));
BEGIN
    IF prov !~ '^[a-z][a-z0-9_]{1,30}$' OR prov IN ('manual', 'free') THEN RAISE EXCEPTION 'Choose a way to pay.' USING ERRCODE = 'P0001'; END IF;
    IF (SELECT count(*) FROM public.hangtag_subscription_payments y WHERE y.owner_id = me AND y.created_at > NOW() - interval '1 hour') >= 20 THEN
        RAISE EXCEPTION 'Too many payment attempts. Try again in an hour.' USING ERRCODE = 'P0001';
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

-- 6. (service role) the provider's order for a payment
CREATE OR REPLACE FUNCTION public.hangtag_subscription_attach(p_payment UUID, p_provider TEXT, p_order TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
    UPDATE public.hangtag_subscription_payments SET provider = lower(btrim(p_provider)), provider_order_id = p_order
     WHERE id = p_payment AND status = 'created';
END $$;

-- (internal) a paid period added to a shop: from the end of its running trial or plan (or now), for the plan's months
CREATE OR REPLACE FUNCTION public.hangtag_subscription_extend(p_owner UUID, p_plan TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    sub RECORD;
    pl RECORD;
    n TIMESTAMPTZ := NOW();
    st TIMESTAMPTZ;
    en TIMESTAMPTZ;
BEGIN
    PERFORM public.hangtag_subscription_ensure(p_owner);
    SELECT * INTO sub FROM public.hangtag_subscriptions x WHERE x.owner_id = p_owner FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'No shop for this account.' USING ERRCODE = 'P0002'; END IF;
    SELECT p.code, p.months INTO pl FROM public.hangtag_plans p WHERE p.code = p_plan AND p.kind = 'paid';
    IF NOT FOUND THEN RAISE EXCEPTION 'Choose a plan.' USING ERRCODE = 'P0001'; END IF;
    st := GREATEST(n, CASE WHEN sub.period_end > n THEN sub.period_end END, CASE WHEN sub.trial_ends_at > n THEN sub.trial_ends_at END);
    en := st + make_interval(months => pl.months);
    UPDATE public.hangtag_subscriptions SET plan_code = pl.code,
        period_start = CASE WHEN sub.period_end > n AND sub.period_start IS NOT NULL THEN sub.period_start ELSE st END,
        period_end = en, updated_at = n
     WHERE owner_id = p_owner;
    RETURN jsonb_build_object('start', st, 'end', en);
END $$;

-- 7. (service role) the provider confirmed the payment: activate it. Idempotent; the amount must be exactly the amount due.
CREATE OR REPLACE FUNCTION public.hangtag_subscription_activate(p_payment UUID, p_provider_payment TEXT, p_amount NUMERIC)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    pay RECORD;
    per JSONB;
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
    -- money the provider confirmed is honoured even if the checkout had been marked expired or cancelled meanwhile
    per := public.hangtag_subscription_extend(pay.owner_id, pay.plan_code);
    UPDATE public.hangtag_subscription_payments SET status = 'paid', provider_payment_id = NULLIF(btrim(COALESCE(p_provider_payment, '')), ''),
        paid_at = NOW(), period_start = (per ->> 'start')::TIMESTAMPTZ, period_end = (per ->> 'end')::TIMESTAMPTZ
     WHERE id = pay.id;
    IF pay.promo_code IS NOT NULL THEN
        INSERT INTO public.hangtag_promo_redemptions (payment_id, code, owner_id, plan_code, discount)
        VALUES (pay.id, pay.promo_code, pay.owner_id, pay.plan_code, pay.discount) ON CONFLICT (payment_id) DO NOTHING;
    END IF;
    RETURN jsonb_build_object('ok', TRUE, 'already', FALSE, 'state', public.hangtag_subscription_state(pay.owner_id, NOW()),
        'plan_code', pay.plan_code, 'period_start', per ->> 'start', 'period_end', per ->> 'end');
END $$;

-- 8. (service role) a checkout that failed, was cancelled or expired at the provider
CREATE OR REPLACE FUNCTION public.hangtag_subscription_fail(p_payment UUID, p_status TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
    IF p_status NOT IN ('failed', 'cancelled', 'expired') THEN RAISE EXCEPTION 'Unknown payment status.' USING ERRCODE = 'P0001'; END IF;
    UPDATE public.hangtag_subscription_payments SET status = p_status WHERE id = p_payment AND status = 'created';
END $$;

-- 9. (SQL Editor / service role) give a shop a paid period without a payment, or suspend it.
--    SELECT public.hangtag_admin_grant((SELECT id FROM auth.users WHERE email = 'owner@shop.in'), 'm3', 'Launch offer');
--    SELECT public.hangtag_admin_suspend((SELECT id FROM auth.users WHERE email = 'owner@shop.in'), true, 'Chargeback');
CREATE OR REPLACE FUNCTION public.hangtag_admin_grant(p_owner UUID, p_plan TEXT, p_note TEXT DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE pl RECORD; pid UUID;
BEGIN
    SELECT p.code, p.price, p.currency INTO pl FROM public.hangtag_plans p WHERE p.code = p_plan AND p.kind = 'paid';
    IF NOT FOUND THEN RAISE EXCEPTION 'Choose a plan.' USING ERRCODE = 'P0001'; END IF;
    INSERT INTO public.hangtag_subscription_payments (owner_id, plan_code, price, discount, amount, currency, provider, note)
    VALUES (p_owner, pl.code, pl.price, pl.price, 0, pl.currency, 'manual', left(p_note, 200)) RETURNING id INTO pid;
    RETURN public.hangtag_subscription_activate(pid, 'manual:' || pid::TEXT, 0);
END $$;
CREATE OR REPLACE FUNCTION public.hangtag_admin_suspend(p_owner UUID, p_suspended BOOLEAN, p_reason TEXT DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
    PERFORM public.hangtag_subscription_ensure(p_owner);
    UPDATE public.hangtag_subscriptions SET suspended = COALESCE(p_suspended, FALSE),
        suspended_reason = CASE WHEN p_suspended THEN left(p_reason, 200) END, updated_at = NOW()
     WHERE owner_id = p_owner;
    RETURN jsonb_build_object('ok', FOUND, 'state', public.hangtag_subscription_state(p_owner, NOW()));
END $$;

-- The Agent's rate limit (service role only: called by the agent Edge Function after it checked who is asking).
-- Four windows: the user per minute and per UTC day, the shop per minute and per day. A request is allowed only when every
-- window is under its limit (a limit of 0 or NULL = no limit); then all four counters go up together. A refused request is
-- NOT counted, so a refusal never extends a wait beyond the window: retry_after is the time until the window that refused
-- rolls over. Counters older than two days are cleared as new days start.
CREATE OR REPLACE FUNCTION public.hangtag_agent_take(p_user UUID, p_shop UUID, p_per_minute INT, p_per_day INT, p_shop_per_minute INT, p_shop_per_day INT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    n TIMESTAMPTZ := clock_timestamp();
    mb TIMESTAMPTZ := date_trunc('minute', n);
    db TIMESTAMPTZ := (date_trunc('day', n AT TIME ZONE 'UTC')) AT TIME ZONE 'UTC';
    um INT; ud INT; sm INT; sd INT;
    lim TEXT;
    secs INT;
    fresh_day BOOLEAN;
BEGIN
    IF p_user IS NULL OR p_shop IS NULL THEN RAISE EXCEPTION 'A user and a shop are required.' USING ERRCODE = '22023'; END IF;
    fresh_day := NOT EXISTS (SELECT 1 FROM public.hangtag_agent_usage WHERE subject = 'ud:' || p_user AND bucket = db);
    -- the four counters exist, then are locked in one fixed order
    INSERT INTO public.hangtag_agent_usage (subject, bucket, hits) VALUES
        ('sd:' || p_shop, db, 0), ('sm:' || p_shop, mb, 0), ('ud:' || p_user, db, 0), ('um:' || p_user, mb, 0)
    ON CONFLICT (subject, bucket) DO NOTHING;
    PERFORM 1 FROM public.hangtag_agent_usage
      WHERE (subject, bucket) IN (('sd:' || p_shop, db), ('sm:' || p_shop, mb), ('ud:' || p_user, db), ('um:' || p_user, mb))
      ORDER BY subject, bucket FOR UPDATE;
    SELECT hits INTO sd FROM public.hangtag_agent_usage WHERE subject = 'sd:' || p_shop AND bucket = db;
    SELECT hits INTO sm FROM public.hangtag_agent_usage WHERE subject = 'sm:' || p_shop AND bucket = mb;
    SELECT hits INTO ud FROM public.hangtag_agent_usage WHERE subject = 'ud:' || p_user AND bucket = db;
    SELECT hits INTO um FROM public.hangtag_agent_usage WHERE subject = 'um:' || p_user AND bucket = mb;
    lim := CASE
        WHEN COALESCE(p_per_minute, 0) > 0 AND um >= p_per_minute THEN 'user_minute'
        WHEN COALESCE(p_shop_per_minute, 0) > 0 AND sm >= p_shop_per_minute THEN 'shop_minute'
        WHEN COALESCE(p_per_day, 0) > 0 AND ud >= p_per_day THEN 'user_day'
        WHEN COALESCE(p_shop_per_day, 0) > 0 AND sd >= p_shop_per_day THEN 'shop_day' END;
    IF lim IS NOT NULL THEN
        secs := CASE WHEN lim IN ('user_minute', 'shop_minute') THEN ceil(extract(epoch FROM (mb + interval '1 minute' - n)))
                     ELSE ceil(extract(epoch FROM (db + interval '1 day' - n))) END;
        RETURN jsonb_build_object('allowed', FALSE, 'limit', lim, 'retry_after', GREATEST(1, secs),
            'user_minute', um, 'user_day', ud, 'shop_minute', sm, 'shop_day', sd);
    END IF;
    UPDATE public.hangtag_agent_usage SET hits = hits + 1
     WHERE (subject, bucket) IN (('sd:' || p_shop, db), ('sm:' || p_shop, mb), ('ud:' || p_user, db), ('um:' || p_user, mb));
    IF fresh_day THEN DELETE FROM public.hangtag_agent_usage WHERE bucket < n - interval '2 days'; END IF;
    RETURN jsonb_build_object('allowed', TRUE, 'limit', NULL, 'retry_after', 0,
        'user_minute', um + 1, 'user_day', ud + 1, 'shop_minute', sm + 1, 'shop_day', sd + 1);
END $$;

-- Every shop already set up (or already holding data) gets its trial from now, so nobody is locked out the moment this runs
DO $$
DECLARE o UUID;
BEGIN
    FOR o IN SELECT p.id FROM public.hangtag_profiles p
              WHERE NOT EXISTS (SELECT 1 FROM public.hangtag_subscriptions s WHERE s.owner_id = p.id)
                AND NOT EXISTS (SELECT 1 FROM public.hangtag_members m WHERE m.user_id = p.id)
                AND (p.onboarded_at IS NOT NULL OR EXISTS (SELECT 1 FROM public.hangtag_products x WHERE x.owner_id = p.id)
                     OR EXISTS (SELECT 1 FROM public.hangtag_sales x WHERE x.owner_id = p.id))
    LOOP
        PERFORM public.hangtag_subscription_ensure(o);
    END LOOP;
END $$;

-- Who may see and do what: plans are readable by anyone signed in (active ones); a shop owner reads its own payments; the
-- rest is reached only through the functions above. No client may add, change or remove any row of this section.
ALTER TABLE public.hangtag_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hangtag_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hangtag_trial_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hangtag_promo_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hangtag_subscription_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hangtag_promo_redemptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hangtag_agent_usage ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.hangtag_plans, public.hangtag_subscriptions, public.hangtag_trial_claims, public.hangtag_promo_codes,
    public.hangtag_subscription_payments, public.hangtag_promo_redemptions, public.hangtag_agent_usage FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.hangtag_plans TO authenticated;
GRANT SELECT ON TABLE public.hangtag_subscription_payments TO authenticated;
DROP POLICY IF EXISTS "Active plans" ON public.hangtag_plans;
CREATE POLICY "Active plans" ON public.hangtag_plans FOR SELECT TO authenticated USING (active);
DROP POLICY IF EXISTS "Own plan payments" ON public.hangtag_subscription_payments;
CREATE POLICY "Own plan payments" ON public.hangtag_subscription_payments FOR SELECT TO authenticated USING (owner_id = (SELECT auth.uid()));
REVOKE ALL ON FUNCTION public.hangtag_subscription_ensure(UUID), public.hangtag_subscription_state(UUID, TIMESTAMPTZ),
    public.hangtag_access_ok(UUID), public.hangtag_subscription_on_onboard(), public.hangtag_subscription_guard(),
    public.hangtag_promo_evaluate(UUID, TEXT, TEXT), public.hangtag_subscription_owner(), public.hangtag_subscription_extend(UUID, TEXT),
    public.hangtag_subscription_attach(UUID, TEXT, TEXT), public.hangtag_subscription_activate(UUID, TEXT, NUMERIC),
    public.hangtag_subscription_fail(UUID, TEXT), public.hangtag_admin_grant(UUID, TEXT, TEXT), public.hangtag_admin_suspend(UUID, BOOLEAN, TEXT),
    public.hangtag_agent_take(UUID, UUID, INT, INT, INT, INT),
    public.hangtag_subscription_status(), public.hangtag_subscription_plans(), public.hangtag_subscription_quote(TEXT, TEXT),
    public.hangtag_subscription_checkout(TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hangtag_subscription_status(), public.hangtag_subscription_plans(), public.hangtag_subscription_quote(TEXT, TEXT),
    public.hangtag_subscription_checkout(TEXT, TEXT, TEXT) TO authenticated;
-- the trusted service role (Edge Functions) — present on Supabase; skipped where it does not exist
DO $do$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
        EXECUTE $g$GRANT ALL ON TABLE public.hangtag_plans, public.hangtag_subscriptions, public.hangtag_trial_claims, public.hangtag_promo_codes,
    public.hangtag_subscription_payments, public.hangtag_promo_redemptions, public.hangtag_agent_usage TO service_role$g$;
        EXECUTE $g$GRANT EXECUTE ON FUNCTION public.hangtag_subscription_attach(UUID, TEXT, TEXT), public.hangtag_subscription_activate(UUID, TEXT, NUMERIC),
    public.hangtag_subscription_fail(UUID, TEXT), public.hangtag_admin_grant(UUID, TEXT, TEXT), public.hangtag_admin_suspend(UUID, BOOLEAN, TEXT),
    public.hangtag_agent_take(UUID, UUID, INT, INT, INT, INT), public.hangtag_subscription_state(UUID, TIMESTAMPTZ),
    public.hangtag_access_ok(UUID) TO service_role$g$;
    END IF;
END $do$;
