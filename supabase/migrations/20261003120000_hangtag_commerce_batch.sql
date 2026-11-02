-- ==============================================================================
-- Hangtag: commerce batch (schema.sql section 3r)
--   price lists · purchase orders and receiving · kits · partial fulfilment of sales orders · e-invoice and e-way bill
--   readiness · repack / unit conversion · gift vouchers · outbound webhooks
--
-- For the live database that supabase/schema.sql builds (the hangtag_* tables). It needs everything up to section 3q
-- (mobile store) already applied: run supabase/schema.sql once, or run this file after it. Safe to run again.
-- It is exactly section 3r of schema.sql plus the row security rules section 5 gives these tables, so running the whole
-- schema.sql again gives the same result.
--
-- Requires: supabase/schema.sql (applied first; supabase/tests/commerce-batch.test.mjs runs this file on top of it)
-- How to apply: Supabase → SQL Editor → New query → paste this file → Run (or `supabase db push`).
-- After applying: deploy the Edge Function webhook-dispatch (only if the shop will use webhooks) and schedule it.
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 3r. Commerce batch: price lists, purchase orders and receiving, kits, partial fulfilment, e-invoice / e-way bill
--     readiness, repack, gift vouchers, outbound webhooks
-- ------------------------------------------------------------------------------
-- Everything reuses what is already here: prices end up on bill lines as before (a bill never changes when a list does),
-- receiving is an ordinary purchase pointing at its PO, a kit is sold as its components' lines, a repack is two stock
-- records, a voucher is one payment of a bill, and webhooks are written from changes the database already sees.
-- Capabilities switch the parts on (a part that is off refuses writes here too); permissions are the existing ones.

-- (a) Capabilities of this batch (the same defaults as src/domain/shop/capabilities.js DEFAULT_CAPS)
CREATE OR REPLACE FUNCTION public.hangtag_cap_on(p_owner UUID, p_cap TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE raw TEXT; kind TEXT; caps JSONB; v BOOLEAN; need TEXT;
BEGIN
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

-- (b) Price lists. One row per list; its prices are a JSON object { "p:<product>": rupees, "v:<variant>": rupees } (a
--     variant's price wins over its product's). At most one default per shop: making a list the default unmarks the old
--     one in the same statement. A customer may have their own list (same shop only: the key includes the shop).
CREATE TABLE IF NOT EXISTS public.hangtag_price_lists (
    owner_id UUID NOT NULL DEFAULT public.hangtag_shop_id() REFERENCES auth.users(id) ON DELETE CASCADE,
    id TEXT NOT NULL CHECK (id ~ '^[A-Za-z0-9_-]{1,64}$'),
    name TEXT NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 40),
    is_default BOOLEAN NOT NULL DEFAULT FALSE,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    starts_on DATE,
    ends_on DATE,
    prices JSONB NOT NULL DEFAULT '{}'::jsonb,
    t BIGINT,
    device_id TEXT,
    user_id UUID DEFAULT auth.uid(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (owner_id, id),
    CONSTRAINT hangtag_price_lists_dates_check CHECK (ends_on IS NULL OR starts_on IS NULL OR ends_on >= starts_on),
    CONSTRAINT hangtag_price_lists_default_check CHECK (NOT is_default OR active),
    CONSTRAINT hangtag_price_lists_prices_check CHECK (jsonb_typeof(prices) = 'object')
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_hangtag_price_lists_name ON public.hangtag_price_lists (owner_id, lower(btrim(name)));
CREATE UNIQUE INDEX IF NOT EXISTS uq_hangtag_price_lists_default ON public.hangtag_price_lists (owner_id) WHERE is_default;
CREATE OR REPLACE FUNCTION public.hangtag_price_list_check()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE n INT; bad TEXT;
BEGIN
    IF NOT public.hangtag_cap_on(NEW.owner_id, 'uses_price_lists') THEN
        RAISE EXCEPTION 'Price lists are switched off for this shop.' USING ERRCODE = '42501';
    END IF;
    SELECT count(*) INTO n FROM jsonb_object_keys(NEW.prices);
    IF n > 5000 THEN RAISE EXCEPTION 'A price list can have up to 5,000 prices.' USING ERRCODE = 'check_violation'; END IF;
    SELECT e.key INTO bad FROM jsonb_each(NEW.prices) e
     WHERE e.key !~ '^[pv]:.{1,64}$' OR jsonb_typeof(e.value) <> 'number' OR (e.value #>> '{}')::NUMERIC <= 0
        OR (e.value #>> '{}')::NUMERIC > 10000000 OR (e.value #>> '{}')::NUMERIC <> round((e.value #>> '{}')::NUMERIC, 2) LIMIT 1;
    IF bad IS NOT NULL THEN RAISE EXCEPTION 'Every price on a list must be more than ₹0 with at most 2 decimals (%).', bad USING ERRCODE = 'check_violation'; END IF;
    NEW.name := btrim(regexp_replace(NEW.name, '\s+', ' ', 'g'));
    NEW.updated_at := NOW();
    IF auth.uid() IS NOT NULL THEN NEW.user_id := auth.uid(); END IF;
    IF NEW.is_default THEN
        UPDATE public.hangtag_price_lists SET is_default = FALSE, updated_at = NOW() WHERE owner_id = NEW.owner_id AND id <> NEW.id AND is_default;
    END IF;
    RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS hangtag_price_list_check ON public.hangtag_price_lists;
CREATE TRIGGER hangtag_price_list_check BEFORE INSERT OR UPDATE ON public.hangtag_price_lists FOR EACH ROW EXECUTE FUNCTION public.hangtag_price_list_check();
DROP TRIGGER IF EXISTS hangtag_audit ON public.hangtag_price_lists;
CREATE TRIGGER hangtag_audit AFTER INSERT OR DELETE ON public.hangtag_price_lists FOR EACH ROW EXECUTE FUNCTION public.hangtag_audit();
DROP TRIGGER IF EXISTS hangtag_audit_change ON public.hangtag_price_lists;
CREATE TRIGGER hangtag_audit_change AFTER UPDATE ON public.hangtag_price_lists FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION public.hangtag_audit();

ALTER TABLE public.hangtag_customers ADD COLUMN IF NOT EXISTS price_list_id TEXT;
ALTER TABLE public.hangtag_customers ADD COLUMN IF NOT EXISTS address JSONB;
ALTER TABLE public.hangtag_customers DROP CONSTRAINT IF EXISTS hangtag_customers_price_list_fkey;
ALTER TABLE public.hangtag_customers ADD CONSTRAINT hangtag_customers_price_list_fkey FOREIGN KEY (owner_id, price_list_id)
    REFERENCES public.hangtag_price_lists (owner_id, id) ON DELETE SET NULL (price_list_id);
ALTER TABLE public.hangtag_customers DROP CONSTRAINT IF EXISTS hangtag_customers_address_check;
ALTER TABLE public.hangtag_customers ADD CONSTRAINT hangtag_customers_address_check CHECK (address IS NULL OR (jsonb_typeof(address) = 'object'
    AND char_length(COALESCE(address ->> 'line', '')) <= 200 AND char_length(COALESCE(address ->> 'city', '')) <= 60
    AND COALESCE(address ->> 'pin', '') ~ '^([1-9][0-9]{5})?$' AND char_length(COALESCE(address ->> 'state', '')) <= 60)) NOT VALID;

-- The one price resolver of the database (the same order as src/domain/sales/pricing.js resolvePrice): the customer's
-- own list → the list chosen → the shop's default list → the item's own price. A list counts only while it is in use
-- (active, between its days) and has a price for the item; nothing ever resolves to ₹0 by accident.
CREATE OR REPLACE FUNCTION public.hangtag_list_price(p_owner UUID, p_customer TEXT, p_list TEXT, p_product TEXT, p_variant TEXT, p_base NUMERIC,
    p_day DATE DEFAULT ((now() AT TIME ZONE 'Asia/Kolkata')::DATE))
RETURNS NUMERIC LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE lid TEXT; l RECORD; p NUMERIC;
BEGIN
    FOREACH lid IN ARRAY ARRAY[
        (SELECT c.price_list_id FROM public.hangtag_customers c WHERE c.owner_id = p_owner AND c.id = p_customer),
        p_list,
        (SELECT x.id FROM public.hangtag_price_lists x WHERE x.owner_id = p_owner AND x.is_default)] LOOP
        CONTINUE WHEN lid IS NULL;
        SELECT * INTO l FROM public.hangtag_price_lists x WHERE x.owner_id = p_owner AND x.id = lid AND x.active
           AND (x.starts_on IS NULL OR x.starts_on <= p_day) AND (x.ends_on IS NULL OR x.ends_on >= p_day);
        CONTINUE WHEN NOT FOUND;
        p := COALESCE(CASE WHEN p_variant IS NOT NULL AND jsonb_typeof(l.prices -> ('v:' || p_variant)) = 'number' THEN (l.prices ->> ('v:' || p_variant))::NUMERIC END,
                      CASE WHEN p_product IS NOT NULL AND jsonb_typeof(l.prices -> ('p:' || p_product)) = 'number' THEN (l.prices ->> ('p:' || p_product))::NUMERIC END);
        IF p IS NOT NULL AND p > 0 THEN RETURN p; END IF;
    END LOOP;
    RETURN COALESCE(p_base, 0);
END $$;
REVOKE ALL ON FUNCTION public.hangtag_list_price(UUID,TEXT,TEXT,TEXT,TEXT,NUMERIC,DATE), public.hangtag_price_list_check() FROM PUBLIC, anon, authenticated;

-- (c) Purchase orders. A PO never changes stock. Its lines are kept as one JSON array ([{ ln, p, v, name, vl, u, q, price,
--     gst }]); the supplier's bill typed or read for it (bill) and the review of differences (review: who accepted what,
--     with notes — never a change of the PO, the receipts or the bill) go with it. Saved whole through
--     hangtag_save_purchase_order on the version the phone last saw, like orders (section 3m).
CREATE TABLE IF NOT EXISTS public.hangtag_purchase_orders (
    owner_id UUID NOT NULL DEFAULT public.hangtag_shop_id() REFERENCES auth.users(id) ON DELETE CASCADE,
    id TEXT NOT NULL CHECK (id ~ '^[A-Za-z0-9_:-]{1,64}$'),
    no TEXT CHECK (no IS NULL OR char_length(no) <= 40),
    supplier_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('draft','sent','closed','cancelled')),
    expected_on DATE,
    notes TEXT CHECK (notes IS NULL OR char_length(notes) <= 500),
    items JSONB NOT NULL CHECK (jsonb_typeof(items) = 'array' AND jsonb_array_length(items) BETWEEN 1 AND 200),
    bill JSONB CHECK (bill IS NULL OR (jsonb_typeof(bill) = 'object' AND jsonb_typeof(bill -> 'lines') = 'array' AND jsonb_array_length(bill -> 'lines') <= 200)),
    review JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(review) = 'array' AND jsonb_array_length(review) <= 400),
    source TEXT NOT NULL DEFAULT 'staff' CHECK (source IN ('staff','reorder')),
    version INT NOT NULL DEFAULT 1 CHECK (version >= 1),
    t BIGINT NOT NULL,
    updated_t BIGINT,
    device_id TEXT,
    user_id UUID DEFAULT auth.uid(),
    save_hash TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (owner_id, id),
    CONSTRAINT hangtag_purchase_orders_supplier_fkey FOREIGN KEY (owner_id, supplier_id) REFERENCES public.hangtag_suppliers (owner_id, id)
);
CREATE INDEX IF NOT EXISTS idx_hangtag_purchase_orders_status ON public.hangtag_purchase_orders (owner_id, status, t DESC);
-- A receipt (purchase) belongs to at most one PO of the same shop
ALTER TABLE public.hangtag_stock_imports ADD COLUMN IF NOT EXISTS po_id TEXT;
ALTER TABLE public.hangtag_stock_imports DROP CONSTRAINT IF EXISTS hangtag_stock_imports_po_fkey;
ALTER TABLE public.hangtag_stock_imports ADD CONSTRAINT hangtag_stock_imports_po_fkey FOREIGN KEY (owner_id, po_id) REFERENCES public.hangtag_purchase_orders (owner_id, id);
CREATE INDEX IF NOT EXISTS idx_hangtag_imports_po ON public.hangtag_stock_imports (owner_id, po_id) WHERE po_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.hangtag_po_next_ok(p_from TEXT, p_to TEXT)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
    SELECT p_from = p_to OR (p_from, p_to) IN (('draft','sent'), ('draft','cancelled'), ('draft','closed'), ('sent','draft'), ('sent','cancelled'), ('sent','closed'))
$$;
-- p_po: { id, no, supplier_id, status, expected_on, notes, items, bill, review, source, t, updated_t, device_id, version (the
-- version the phone last saw; 0 for a new one) }. Refused (40001) when another device changed it meanwhile, except the very
-- same save sent again. A cancelled PO doesn't change; a closed one only gets its bill and review. Once goods were received
-- on it, its lines stay as they are (a new PO is made for something else). -> { status, po, version }
CREATE OR REPLACE FUNCTION public.hangtag_save_purchase_order(p_po JSONB)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    uid UUID := public.hangtag_shop_id(); cur public.hangtag_purchase_orders; base INT := COALESCE(NULLIF(p_po ->> 'version', '')::INT, 0);
    fp TEXT := md5((COALESCE(p_po, '{}'::jsonb) - 'version' - 'updated_t')::TEXT); ver INT; st TEXT := p_po ->> 'status'; pid TEXT := p_po ->> 'id';
    items JSONB := p_po -> 'items'; bad TEXT; sid TEXT := p_po ->> 'supplier_id';
    pbill JSONB := NULLIF(p_po -> 'bill', 'null'::jsonb); prev JSONB := COALESCE(NULLIF(p_po -> 'review', 'null'::jsonb), '[]'::jsonb);   -- JSON null = none
BEGIN
    IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Sign in to save purchase orders.' USING ERRCODE = '42501'; END IF;
    IF uid IS NULL OR NOT public.hangtag_can('create_purchase') THEN RAISE EXCEPTION 'Not allowed to save purchase orders.' USING ERRCODE = '42501'; END IF;
    IF NOT public.hangtag_cap_on(uid, 'uses_purchase_orders') THEN RAISE EXCEPTION 'Purchase orders are switched off for this shop.' USING ERRCODE = '42501'; END IF;
    IF COALESCE(pid, '') = '' THEN RAISE EXCEPTION 'A purchase order has no id.' USING ERRCODE = '22023'; END IF;
    IF jsonb_typeof(COALESCE(items, 'null'::jsonb)) <> 'array' OR jsonb_array_length(items) = 0 THEN RAISE EXCEPTION 'A purchase order needs at least one line.' USING ERRCODE = 'check_violation'; END IF;
    -- every line: a variant of this shop's catalog, a quantity above 0, a price of 0 or more, each variant once
    SELECT COALESCE(x ->> 'name', x ->> 'v', '?') INTO bad FROM jsonb_array_elements(items) x
     WHERE NOT EXISTS (SELECT 1 FROM public.hangtag_variants v WHERE v.owner_id = uid AND v.id = x ->> 'v' AND v.product_id = x ->> 'p')
        OR jsonb_typeof(x -> 'q') <> 'number' OR (x ->> 'q')::NUMERIC <= 0 OR (x ->> 'q')::NUMERIC > 1000000
        OR (x ? 'price' AND jsonb_typeof(x -> 'price') NOT IN ('number','null')) OR COALESCE((x ->> 'price')::NUMERIC, 0) < 0 LIMIT 1;
    IF bad IS NOT NULL THEN RAISE EXCEPTION 'Purchase order line % is not a product of this shop with a quantity above 0.', bad USING ERRCODE = 'check_violation'; END IF;
    IF (SELECT count(*) <> count(DISTINCT x ->> 'v') FROM jsonb_array_elements(items) x) THEN RAISE EXCEPTION 'A product is on the purchase order twice.' USING ERRCODE = 'check_violation'; END IF;
    SELECT * INTO cur FROM public.hangtag_purchase_orders x WHERE x.owner_id = uid AND x.id = pid FOR UPDATE;
    IF FOUND THEN
        IF cur.version <> base THEN
            IF cur.version = base + 1 AND cur.save_hash = fp THEN RETURN jsonb_build_object('status', 'saved', 'po', cur.id, 'version', cur.version); END IF;
            RAISE EXCEPTION 'Purchase order % was changed on another device (this phone had version %, the cloud has %). Open it again.', COALESCE(cur.no, cur.id), base, cur.version USING ERRCODE = '40001';
        END IF;
        IF cur.status = 'cancelled' THEN RAISE EXCEPTION 'Purchase order % is cancelled and can''t be changed.', COALESCE(cur.no, cur.id) USING ERRCODE = 'check_violation'; END IF;
        IF NOT public.hangtag_po_next_ok(cur.status, st) THEN RAISE EXCEPTION 'A % purchase order can''t become %.', cur.status, st USING ERRCODE = 'check_violation'; END IF;
        IF cur.supplier_id IS DISTINCT FROM sid AND EXISTS (SELECT 1 FROM public.hangtag_stock_imports i WHERE i.owner_id = uid AND i.po_id = cur.id) THEN
            RAISE EXCEPTION 'Goods were already received on this purchase order: its supplier stays.' USING ERRCODE = 'check_violation';
        END IF;
        IF (cur.items IS DISTINCT FROM items OR cur.status = 'closed' AND (cur.notes, cur.expected_on) IS DISTINCT FROM (p_po ->> 'notes', NULLIF(p_po ->> 'expected_on', '')::DATE))
           AND (cur.status = 'closed' OR EXISTS (SELECT 1 FROM public.hangtag_stock_imports i WHERE i.owner_id = uid AND i.po_id = cur.id AND i.status = 'posted')) THEN
            RAISE EXCEPTION 'Goods were already received on purchase order %: its lines stay as they are. Make a new purchase order for anything else.', COALESCE(cur.no, cur.id) USING ERRCODE = 'check_violation';
        END IF;
        ver := cur.version + 1;
        UPDATE public.hangtag_purchase_orders SET no = COALESCE(p_po ->> 'no', cur.no), supplier_id = sid, status = st, expected_on = NULLIF(p_po ->> 'expected_on', '')::DATE,
            notes = NULLIF(left(btrim(COALESCE(p_po ->> 'notes', '')), 500), ''), items = p_po -> 'items', bill = pbill, review = prev,
            version = ver, updated_t = (p_po ->> 'updated_t')::BIGINT, device_id = p_po ->> 'device_id', save_hash = fp, updated_at = NOW()
         WHERE owner_id = uid AND id = cur.id;
    ELSE
        IF base <> 0 THEN RAISE EXCEPTION 'Purchase order % is no longer in the cloud.', COALESCE(p_po ->> 'no', pid) USING ERRCODE = '40001'; END IF;
        IF st NOT IN ('draft','sent') THEN RAISE EXCEPTION 'A new purchase order is a draft or sent.' USING ERRCODE = 'check_violation'; END IF;
        ver := 1;
        INSERT INTO public.hangtag_purchase_orders (owner_id, id, no, supplier_id, status, expected_on, notes, items, bill, review, source, version, t, updated_t, device_id, user_id, save_hash)
        VALUES (uid, pid, p_po ->> 'no', sid, st, NULLIF(p_po ->> 'expected_on', '')::DATE, NULLIF(left(btrim(COALESCE(p_po ->> 'notes', '')), 500), ''), items, pbill,
            prev, CASE WHEN p_po ->> 'source' = 'reorder' THEN 'reorder' ELSE 'staff' END, ver,
            COALESCE((p_po ->> 't')::BIGINT, (extract(epoch FROM now()) * 1000)::BIGINT), (p_po ->> 'updated_t')::BIGINT, p_po ->> 'device_id', auth.uid(), fp);
    END IF;
    RETURN jsonb_build_object('status', 'saved', 'po', pid, 'version', ver);
END $$;
REVOKE ALL ON FUNCTION public.hangtag_save_purchase_order(JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.hangtag_save_purchase_order(JSONB) TO authenticated;
DROP TRIGGER IF EXISTS hangtag_audit ON public.hangtag_purchase_orders;
CREATE TRIGGER hangtag_audit AFTER INSERT OR DELETE ON public.hangtag_purchase_orders FOR EACH ROW EXECUTE FUNCTION public.hangtag_audit();
DROP TRIGGER IF EXISTS hangtag_audit_change ON public.hangtag_purchase_orders;
CREATE TRIGGER hangtag_audit_change AFTER UPDATE OF status, review ON public.hangtag_purchase_orders FOR EACH ROW
    WHEN (OLD.status IS DISTINCT FROM NEW.status OR OLD.review IS DISTINCT FROM NEW.review) EXECUTE FUNCTION public.hangtag_audit();

-- The PO a receipt is for, locked until the receipt is saved (the app may only read POs, and a row lock needs more)
CREATE OR REPLACE FUNCTION public.hangtag_po_for_receipt(p_po TEXT)
RETURNS public.hangtag_purchase_orders LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE uid UUID := public.hangtag_shop_id(); po public.hangtag_purchase_orders;
BEGIN
    IF auth.uid() IS NULL OR uid IS NULL OR NOT public.hangtag_can('create_purchase') THEN RAISE EXCEPTION 'Not allowed to record purchases.' USING ERRCODE = '42501'; END IF;
    SELECT * INTO po FROM public.hangtag_purchase_orders x WHERE x.owner_id = uid AND x.id = p_po FOR UPDATE;
    RETURN po;
END $$;
REVOKE ALL ON FUNCTION public.hangtag_po_for_receipt(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.hangtag_po_for_receipt(TEXT) TO authenticated;

-- Saving a purchase (as section 3n (i)), now also for a PO: the PO row is locked first, so two phones receiving the same
-- delivery are taken one after the other; a receipt that would take more of a line than is still to come (or a product
-- not on the PO) is refused unless the person said the supplier sent extra (allow_over). The same receipt sent again is
-- "already_saved" before anything is checked. Only receiving changes stock.
CREATE OR REPLACE FUNCTION public.hangtag_save_purchase(p_purchase JSONB, p_moves JSONB, p_tracking JSONB DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE
    uid UUID := public.hangtag_shop_id(); pid TEXT := btrim(COALESCE(p_purchase ->> 'id', ''));
    lines JSONB := COALESCE(p_purchase -> 'lines', '[]'::jsonb); sid TEXT := NULLIF(btrim(COALESCE(p_purchase ->> 'supplier_id', '')), '');
    sub NUMERIC := round(COALESCE((p_purchase ->> 'subtotal')::NUMERIC, 0), 2); tax NUMERIC := round(COALESCE((p_purchase ->> 'tax_amount')::NUMERIC, 0), 2);
    l_sub NUMERIC; l_tax NUMERIC; l_q NUMERIC; n_m INT; m_q NUMERIC; bad BOOLEAN; s_name TEXT; s_gstin TEXT;
    poid TEXT := NULLIF(btrim(COALESCE(p_purchase ->> 'po_id', '')), ''); po public.hangtag_purchase_orders; over TEXT;
    allow_over BOOLEAN := COALESCE((p_purchase ->> 'allow_over')::BOOLEAN, FALSE);
BEGIN
    IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Sign in to record purchases.' USING ERRCODE = '42501'; END IF;
    IF uid IS NULL OR NOT public.hangtag_can('create_purchase') THEN RAISE EXCEPTION 'Not allowed to record purchases.' USING ERRCODE = '42501'; END IF;
    IF pid = '' OR char_length(pid) > 58 THEN RAISE EXCEPTION 'The purchase has no id.' USING ERRCODE = '22023'; END IF;
    IF EXISTS (SELECT 1 FROM public.hangtag_stock_imports WHERE owner_id = uid AND id = pid) THEN
        RETURN jsonb_build_object('status', 'already_saved', 'purchase_id', pid);
    END IF;
    IF jsonb_typeof(lines) <> 'array' OR jsonb_array_length(lines) = 0 THEN RAISE EXCEPTION 'A purchase needs at least one line.' USING ERRCODE = '23514'; END IF;
    IF jsonb_typeof(COALESCE(p_moves, 'null'::jsonb)) <> 'array' OR jsonb_array_length(p_moves) = 0 THEN RAISE EXCEPTION 'A purchase needs its stock-in lines.' USING ERRCODE = '23514'; END IF;
    SELECT COALESCE(sum(round((x ->> 'tx')::NUMERIC, 2)), 0), COALESCE(sum(round((x ->> 'tax')::NUMERIC, 2)), 0), COALESCE(sum((x ->> 'q')::NUMERIC), 0)
      INTO l_sub, l_tax, l_q FROM jsonb_array_elements(lines) x;
    IF l_sub <> sub OR l_tax <> tax THEN RAISE EXCEPTION 'The purchase lines don''t add up to its subtotal and GST.' USING ERRCODE = '23514'; END IF;
    SELECT count(*), COALESCE(sum((x ->> 'qty')::NUMERIC), 0), COALESCE(bool_or(COALESCE((x ->> 'qty')::NUMERIC, 0) <= 0 OR COALESCE((x ->> 'cost_price')::NUMERIC, 0) < 0), FALSE)
      INTO n_m, m_q, bad FROM jsonb_array_elements(p_moves) x;
    IF bad THEN RAISE EXCEPTION 'Every line needs a quantity more than 0 and a cost of ₹0 or more.' USING ERRCODE = '23514'; END IF;
    IF m_q <> l_q THEN RAISE EXCEPTION 'The stock-in lines don''t match the purchase lines.' USING ERRCODE = '23514'; END IF;
    IF poid IS NOT NULL THEN
        po := public.hangtag_po_for_receipt(poid);
        IF po.id IS NULL THEN RAISE EXCEPTION 'That purchase order isn''t in the cloud yet.' USING ERRCODE = '23503'; END IF;
        IF po.status IN ('cancelled','closed') THEN RAISE EXCEPTION 'Purchase order % is %: nothing more can be received on it.', COALESCE(po.no, po.id), po.status USING ERRCODE = 'check_violation'; END IF;
        IF sid IS DISTINCT FROM po.supplier_id THEN RAISE EXCEPTION 'Goods for purchase order % come from its own supplier.', COALESCE(po.no, po.id) USING ERRCODE = 'check_violation'; END IF;
        IF NOT allow_over THEN
            SELECT COALESCE(x ->> 'n', x ->> 'v') INTO over FROM jsonb_array_elements(lines) x
             WHERE (x ->> 'q')::NUMERIC > COALESCE((SELECT sum((o ->> 'q')::NUMERIC) FROM jsonb_array_elements(po.items) o WHERE o ->> 'v' = x ->> 'v'), 0)
                 - COALESCE((SELECT sum((y ->> 'q')::NUMERIC) FROM public.hangtag_stock_imports r, jsonb_array_elements(r.lines) y
                     WHERE r.owner_id = uid AND r.po_id = poid AND r.status = 'posted' AND y ->> 'v' = x ->> 'v'), 0) LIMIT 1;
            IF over IS NOT NULL THEN
                RAISE EXCEPTION '% was already received on purchase order % (or isn''t on it). Refresh the order, or receive it as extra.', over, COALESCE(po.no, po.id) USING ERRCODE = 'check_violation';
            END IF;
        END IF;
    END IF;
    IF sid IS NOT NULL THEN SELECT name, gstin INTO s_name, s_gstin FROM public.hangtag_suppliers WHERE owner_id = uid AND id = sid; END IF;
    INSERT INTO public.hangtag_stock_imports (id, kind, supplier_id, supplier_name, supplier_gstin, invoice_no, invoice_date, t, line_count, units, amount,
                                              subtotal, tax_amount, total_amount, paid_amount, payment_method, status, note, lines, device_id, po_id)
    VALUES (pid, 'purchase', sid, COALESCE(NULLIF(btrim(p_purchase ->> 'supplier_name'), ''), s_name), COALESCE(NULLIF(btrim(p_purchase ->> 'supplier_gstin'), ''), s_gstin),
            NULLIF(btrim(COALESCE(p_purchase ->> 'invoice_no', '')), ''), NULLIF(p_purchase ->> 'invoice_date', '')::DATE,
            COALESCE((p_purchase ->> 't')::BIGINT, (extract(epoch FROM now()) * 1000)::BIGINT), jsonb_array_length(lines), m_q,
            round(COALESCE((p_purchase ->> 'total_amount')::NUMERIC, 0), 2), sub, tax, round(COALESCE((p_purchase ->> 'total_amount')::NUMERIC, 0), 2),
            round(COALESCE((p_purchase ->> 'paid_amount')::NUMERIC, 0), 2), NULLIF(p_purchase ->> 'payment_method', ''), 'posted',
            NULLIF(left(btrim(COALESCE(p_purchase ->> 'note', '')), 200), ''), lines, p_purchase ->> 'device_id', poid);
    INSERT INTO public.hangtag_stock_moves (id, variant_id, product_id, type, qty, cost_price, note, t, device_id, import_id, serials, batch_no, expiry)
    SELECT x ->> 'id', x ->> 'variant_id', x ->> 'product_id', 'RESTOCK', (x ->> 'qty')::NUMERIC, round((x ->> 'cost_price')::NUMERIC)::INTEGER, left(x ->> 'note', 200),
           COALESCE((x ->> 't')::BIGINT, (p_purchase ->> 't')::BIGINT, (extract(epoch FROM now()) * 1000)::BIGINT), COALESCE(x ->> 'device_id', p_purchase ->> 'device_id'), pid,
           CASE WHEN jsonb_typeof(x -> 'serials') = 'array' THEN ARRAY(SELECT jsonb_array_elements_text(x -> 'serials')) END,
           NULLIF(x ->> 'batch_no', ''), NULLIF(x ->> 'expiry', '')::DATE
    FROM jsonb_array_elements(p_moves) x
    ON CONFLICT (owner_id, id) DO NOTHING;
    RETURN jsonb_build_object('status', 'saved', 'purchase_id', pid, 'moves', n_m);
END $$;
REVOKE ALL ON FUNCTION public.hangtag_save_purchase(JSONB, JSONB, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.hangtag_save_purchase(JSONB, JSONB, JSONB) TO authenticated;

-- (d) Kits. A kit is a product with its components (bundle: [{ v, q }]: variants of the same shop that are not kits).
--     Its bill line is saved as the components' lines; each remembers its kit (kit: { v, p, name, n }).
ALTER TABLE public.hangtag_products ADD COLUMN IF NOT EXISTS bundle JSONB;
ALTER TABLE public.hangtag_products ADD COLUMN IF NOT EXISTS repack JSONB;
ALTER TABLE public.hangtag_products DROP CONSTRAINT IF EXISTS hangtag_products_bundle_check;
ALTER TABLE public.hangtag_products ADD CONSTRAINT hangtag_products_bundle_check CHECK (bundle IS NULL OR (jsonb_typeof(bundle) = 'array'
    AND jsonb_array_length(bundle) BETWEEN 1 AND 20)) NOT VALID;
ALTER TABLE public.hangtag_products DROP CONSTRAINT IF EXISTS hangtag_products_repack_check;
ALTER TABLE public.hangtag_products ADD CONSTRAINT hangtag_products_repack_check CHECK (repack IS NULL OR (jsonb_typeof(repack) = 'array'
    AND jsonb_array_length(repack) <= 20)) NOT VALID;
CREATE OR REPLACE FUNCTION public.hangtag_bundle_check()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE bad TEXT;
BEGIN
    IF NEW.bundle IS NULL OR (TG_OP = 'UPDATE' AND NEW.bundle IS NOT DISTINCT FROM OLD.bundle) THEN RETURN NEW; END IF;
    IF jsonb_typeof(NEW.bundle) = 'array' AND jsonb_array_length(NEW.bundle) = 0 THEN NEW.bundle := NULL; RETURN NEW; END IF;
    IF NOT public.hangtag_cap_on(NEW.owner_id, 'uses_bundles') THEN RAISE EXCEPTION 'Kits are switched off for this shop.' USING ERRCODE = '42501'; END IF;
    SELECT COALESCE(c ->> 'v', '?') INTO bad FROM jsonb_array_elements(NEW.bundle) c
     WHERE jsonb_typeof(c -> 'q') <> 'number' OR (c ->> 'q')::NUMERIC <= 0
        OR NOT EXISTS (SELECT 1 FROM public.hangtag_variants v JOIN public.hangtag_products p ON p.owner_id = v.owner_id AND p.id = v.product_id
                        WHERE v.owner_id = NEW.owner_id AND v.id = c ->> 'v' AND p.id <> NEW.id AND p.bundle IS NULL AND COALESCE(p.tracking, 'none') <> 'serial') LIMIT 1;
    IF bad IS NOT NULL THEN RAISE EXCEPTION 'Kit item % must be a product of this shop that is not a kit or tracked by serial number, with a quantity above 0.', bad USING ERRCODE = 'check_violation'; END IF;
    IF (SELECT count(*) <> count(DISTINCT c ->> 'v') FROM jsonb_array_elements(NEW.bundle) c) THEN RAISE EXCEPTION 'An item is in the kit twice.' USING ERRCODE = 'check_violation'; END IF;
    RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS hangtag_bundle_check ON public.hangtag_products;
CREATE TRIGGER hangtag_bundle_check BEFORE INSERT OR UPDATE OF bundle ON public.hangtag_products FOR EACH ROW EXECUTE FUNCTION public.hangtag_bundle_check();
ALTER TABLE public.hangtag_sale_items ADD COLUMN IF NOT EXISTS kit JSONB;
ALTER TABLE public.hangtag_sale_items DROP CONSTRAINT IF EXISTS hangtag_sale_items_kit_check;
ALTER TABLE public.hangtag_sale_items ADD CONSTRAINT hangtag_sale_items_kit_check CHECK (kit IS NULL OR (jsonb_typeof(kit) = 'object' AND kit ? 'v'
    AND char_length(COALESCE(kit ->> 'name', '')) <= 120)) NOT VALID;

-- Saving bills (as section 3o (h)), now with the kit a line came from
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
            total = EXCLUDED.total, payment_method = EXCLUDED.payment_method, device_id = EXCLUDED.device_id, is_void = EXCLUDED.is_void, void_reason = CASE WHEN EXCLUDED.is_void THEN hangtag_sales.void_reason END,
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
    RETURN jsonb_build_object('status', 'saved', 'bills', n);
END $$;
REVOKE ALL ON FUNCTION public.hangtag_save_sales(JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.hangtag_save_sales(JSONB) TO authenticated;

-- (e) Partial fulfilment of staff sales orders: like mobile orders (section 3q), the bills made from one never deliver more
--     of a product than it ordered, so two tills can't fulfil the same remaining quantity twice (deferred: sees the whole bill).
CREATE OR REPLACE FUNCTION public.hangtag_check_order_fulfilment()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE sid TEXT; own UUID; sale public.hangtag_sales; ord public.hangtag_orders; v TEXT;
BEGIN
    IF TG_TABLE_NAME = 'hangtag_sales' THEN
        IF TG_OP = 'DELETE' THEN sid := OLD.id; own := OLD.owner_id; ELSE sid := NEW.id; own := NEW.owner_id; END IF;
    ELSE
        IF TG_OP = 'DELETE' THEN sid := OLD.sale_id; own := OLD.owner_id; ELSE sid := NEW.sale_id; own := NEW.owner_id; END IF;
    END IF;
    SELECT * INTO sale FROM public.hangtag_sales s WHERE s.owner_id = own AND s.id = sid;
    IF NOT FOUND OR sale.order_id IS NULL OR sale.is_void THEN RETURN NULL; END IF;
    SELECT * INTO ord FROM public.hangtag_orders o WHERE o.owner_id = own AND o.id = sale.order_id AND o.kind = 'sales' AND o.public_token IS NULL FOR UPDATE;
    IF NOT FOUND THEN RETURN NULL; END IF;
    SELECT i.variant_id INTO v FROM public.hangtag_sales s JOIN public.hangtag_sale_items i ON i.owner_id = s.owner_id AND i.sale_id = s.id
     WHERE s.owner_id = own AND s.order_id = ord.id AND NOT s.is_void AND i.variant_id IS NOT NULL
     GROUP BY i.variant_id
    HAVING sum(i.quantity) > COALESCE((SELECT sum(oi.qty) FROM public.hangtag_order_items oi WHERE oi.owner_id = own AND oi.order_id = ord.id AND oi.variant_id = i.variant_id), 0)
       AND EXISTS (SELECT 1 FROM public.hangtag_order_items oi WHERE oi.owner_id = own AND oi.order_id = ord.id AND oi.variant_id = i.variant_id)
    LIMIT 1;
    IF v IS NOT NULL THEN
        RAISE EXCEPTION 'Sales order % has already been fulfilled for that quantity (another bill delivered it).', COALESCE(ord.no, ord.id) USING ERRCODE = 'check_violation';
    END IF;
    RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS hangtag_check_order_sale ON public.hangtag_sales;
CREATE CONSTRAINT TRIGGER hangtag_check_order_sale AFTER INSERT OR UPDATE OF is_void, order_id ON public.hangtag_sales
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.hangtag_check_order_fulfilment();
DROP TRIGGER IF EXISTS hangtag_check_order_line ON public.hangtag_sale_items;
CREATE CONSTRAINT TRIGGER hangtag_check_order_line AFTER INSERT OR UPDATE ON public.hangtag_sale_items
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.hangtag_check_order_fulfilment();

-- What a customer sees of a mobile order (as section 3q), in shop words: Confirmed → Partially ready → Ready (all handed
-- over, payment at the counter) → Completed (handed over and paid). The state keys stay as before.
CREATE OR REPLACE FUNCTION public.hangtag_mobile_order_status(p_order_token TEXT)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE o public.hangtag_orders; ordered NUMERIC; billed NUMERIC; state TEXT; state_label TEXT; payment_state TEXT; payment_label TEXT;
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
    IF o.status='cancelled' THEN state:='cancelled'; state_label:='Cancelled';
    ELSIF ordered>0 AND billed>=ordered THEN state:='fulfilled'; state_label:=CASE WHEN payment_state='confirmed' THEN 'Completed' ELSE 'Ready' END;
    ELSIF billed>0 THEN state:='partial'; state_label:='Partially ready';
    ELSE state:='received'; state_label:='Confirmed'; END IF;
    RETURN jsonb_build_object('ok',TRUE,'order_no',o.no,'state',state,'state_label',state_label,'payment_state',payment_state,'payment_label',payment_label,
        'total',o.total,'mode',COALESCE(o.checkout_mode,'store'),'updated_at',o.updated_at);
END $$;
REVOKE ALL ON FUNCTION public.hangtag_mobile_order_status(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.hangtag_mobile_order_status(TEXT) TO anon,authenticated;

-- The mobile store (as section 3q) sells at the shop's default price list (else the item's price). A customer's own list
-- is never used there: anyone can type a phone number, so a customer's prices stay with the staff. Kits are not offered
-- in the mobile store (their stock is their components').
CREATE OR REPLACE FUNCTION public.hangtag_mobile_catalog(p_token TEXT)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE shop RECORD; items JSONB; cats JSONB; tax_on BOOLEAN := FALSE; tax_incl BOOLEAN := TRUE; default_rate NUMERIC := 5;
BEGIN
    IF p_token IS NULL OR p_token !~ '^st_[A-Za-z0-9_-]{32,61}$' THEN
        RETURN jsonb_build_object('ok', FALSE, 'message', 'This shop link is not valid. Ask the shop for a new link.');
    END IF;
    SELECT p.id, p.shop_name INTO shop FROM public.hangtag_profiles p WHERE p.store_token = p_token;
    IF NOT FOUND OR NOT public.hangtag_cap_on(shop.id, 'uses_mobile_store') THEN
        RETURN jsonb_build_object('ok', FALSE, 'message', 'This mobile store is not open right now.');
    END IF;
    SELECT COALESCE(CASE WHEN jsonb_typeof(m.value->'taxOn')='boolean' THEN (m.value->>'taxOn')::BOOLEAN END,FALSE),
           COALESCE(CASE WHEN jsonb_typeof(m.value->'taxIncl')='boolean' THEN (m.value->>'taxIncl')::BOOLEAN END,TRUE),
           COALESCE(CASE WHEN jsonb_typeof(m.value->'taxRate')='number' THEN (m.value->>'taxRate')::NUMERIC END,5)
      INTO tax_on,tax_incl,default_rate FROM public.hangtag_meta m WHERE m.owner_id=shop.id AND m.key='settings';
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
    RETURN jsonb_build_object('ok', TRUE, 'shop', COALESCE(NULLIF(btrim(shop.shop_name), ''), 'Shop'), 'tax_on', tax_on,
        'tax_inclusive', tax_incl, 'items', items, 'categories', cats);
END $$;

CREATE OR REPLACE FUNCTION public.hangtag_place_mobile_order(p_token TEXT, p_items JSONB, p_customer JSONB, p_checkout_key TEXT,
    p_note TEXT DEFAULT NULL, p_payment TEXT DEFAULT 'counter', p_mode TEXT DEFAULT 'store')
RETURNS JSONB LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    shop RECORD; prior public.hangtag_orders; vr RECORD; it JSONB; q NUMERIC; available NUMERIC; dp INT; ln INT := 0;
    oid TEXT := 'om' || replace(gen_random_uuid()::TEXT, '-', ''); otok TEXT := 'mo_' || replace(gen_random_uuid()::TEXT, '-', '');
    now_ms BIGINT := (extract(epoch FROM now()) * 1000)::BIGINT; ono TEXT; total NUMERIC := 0; cid TEXT; line_net NUMERIC;
    tax_on BOOLEAN := FALSE; tax_incl BOOLEAN := TRUE; default_rate NUMERIC := 5;
    nm TEXT; ph TEXT; em TEXT; raw_phone TEXT; clean_note TEXT;
BEGIN
    IF p_token IS NULL OR p_token !~ '^st_[A-Za-z0-9_-]{32,61}$' THEN RETURN jsonb_build_object('ok', FALSE, 'message', 'This shop link is not valid.'); END IF;
    SELECT p.id, p.shop_name INTO shop FROM public.hangtag_profiles p WHERE p.store_token = p_token FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('ok', FALSE, 'message', 'This shop link is not valid.'); END IF;
    IF p_checkout_key IS NULL OR p_checkout_key !~ '^[A-Za-z0-9_-]{24,64}$' THEN RETURN jsonb_build_object('ok', FALSE, 'message', 'Start checkout again and retry.'); END IF;
    SELECT * INTO prior FROM public.hangtag_orders o WHERE o.owner_id = shop.id AND o.checkout_key = p_checkout_key;
    IF FOUND THEN RETURN jsonb_build_object('ok', TRUE, 'order_no', prior.no, 'order_token', prior.public_token, 'state', 'received', 'state_label', 'Confirmed'); END IF;
    IF NOT public.hangtag_cap_on(shop.id, 'uses_mobile_store') THEN RETURN jsonb_build_object('ok', FALSE, 'message', 'This mobile store is not open right now.'); END IF;
    SELECT COALESCE(CASE WHEN jsonb_typeof(m.value->'taxOn')='boolean' THEN (m.value->>'taxOn')::BOOLEAN END,FALSE),
           COALESCE(CASE WHEN jsonb_typeof(m.value->'taxIncl')='boolean' THEN (m.value->>'taxIncl')::BOOLEAN END,TRUE),
           COALESCE(CASE WHEN jsonb_typeof(m.value->'taxRate')='number' THEN (m.value->>'taxRate')::NUMERIC END,5)
      INTO tax_on,tax_incl,default_rate FROM public.hangtag_meta m WHERE m.owner_id=shop.id AND m.key='settings';
    IF p_mode NOT IN ('store','assisted') OR p_payment NOT IN ('counter','cash','upi') THEN RETURN jsonb_build_object('ok', FALSE, 'message', 'Choose a valid checkout option.'); END IF;
    IF jsonb_typeof(COALESCE(p_items, 'null'::jsonb)) <> 'array' OR jsonb_array_length(p_items) NOT BETWEEN 1 AND 50 THEN RETURN jsonb_build_object('ok', FALSE, 'message', 'Add from 1 to 50 products to your cart.'); END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_items) x(item) GROUP BY x.item ->> 'v' HAVING count(*) > 1) THEN RETURN jsonb_build_object('ok', FALSE, 'message', 'Choose each product variant only once.'); END IF;
    IF jsonb_typeof(COALESCE(p_customer, 'null'::jsonb)) <> 'object' THEN RETURN jsonb_build_object('ok', FALSE, 'message', 'Enter your customer details.'); END IF;
    nm := left(btrim(regexp_replace(COALESCE(p_customer ->> 'name', ''), '[[:cntrl:]]', ' ', 'g')), 80);
    raw_phone := regexp_replace(COALESCE(p_customer ->> 'phone', ''), '[^0-9]', '', 'g'); ph := left(raw_phone, 15);
    em := lower(left(btrim(COALESCE(p_customer ->> 'email', '')), 120));
    clean_note := NULLIF(left(btrim(regexp_replace(COALESCE(p_note, ''), '[[:cntrl:]]', ' ', 'g')), 500), '');
    IF nm = '' THEN RETURN jsonb_build_object('ok', FALSE, 'message', 'Enter your name.'); END IF;
    IF char_length(raw_phone) NOT BETWEEN 10 AND 15 THEN RETURN jsonb_build_object('ok', FALSE, 'message', 'Enter a valid mobile number.'); END IF;
    IF em <> '' AND em !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' THEN RETURN jsonb_build_object('ok', FALSE, 'message', 'Enter a valid email address.'); END IF;
    IF (SELECT count(*) FROM public.hangtag_orders o WHERE o.owner_id = shop.id AND o.public_token IS NOT NULL AND o.created_at > NOW() - interval '10 minutes') >= 100 THEN
        RETURN jsonb_build_object('ok', FALSE, 'message', 'The shop received many orders just now. Please wait a moment or contact the staff.');
    END IF;
    FOR it IN SELECT x.item FROM jsonb_array_elements(p_items) x(item) ORDER BY x.item ->> 'v' LOOP
        q := CASE WHEN jsonb_typeof(it -> 'q') = 'number' THEN (it ->> 'q')::NUMERIC END;
        SELECT v.id, v.product_id, p.name, p.unit, public.hangtag_list_price(shop.id, NULL, NULL, p.id, v.id, COALESCE(v.price, p.price)) price,
               CASE WHEN tax_on THEN COALESCE(p.gst_rate,default_rate) ELSE 0 END gst_rate,
               COALESCE((SELECT string_agg(e.value, ' / ' ORDER BY e.n) FROM jsonb_array_elements_text(v.option_values) WITH ORDINALITY e(value,n)), '') label
          INTO vr FROM public.hangtag_variants v JOIN public.hangtag_products p ON p.owner_id = v.owner_id AND p.id = v.product_id
         WHERE v.owner_id = shop.id AND v.id = it ->> 'v' AND v.active AND NOT p.archived AND p.bundle IS NULL FOR UPDATE OF v, p;
        IF NOT FOUND THEN RAISE EXCEPTION 'A product in your cart is not available any more. Refresh the store and try again.' USING ERRCODE = 'check_violation'; END IF;
        dp := CASE vr.unit WHEN 'kg' THEN 3 WHEN 'l' THEN 3 WHEN 'm' THEN 2 ELSE 0 END;
        IF q IS NULL OR q <= 0 OR q > 50 OR q <> round(q, dp) THEN RAISE EXCEPTION 'Choose a valid quantity for %.', vr.name USING ERRCODE = 'check_violation'; END IF;
        available := public.hangtag_mobile_available(shop.id, vr.id);
        IF q > available THEN RAISE EXCEPTION '% now has only % available. Refresh your cart and try again.', vr.name, trim_scale(available) USING ERRCODE = 'check_violation'; END IF;
        line_net := round(q * vr.price,2);
        total := total + line_net + CASE WHEN tax_on AND NOT tax_incl AND vr.gst_rate>0 THEN 2*round(line_net*vr.gst_rate/200,2) ELSE 0 END;
    END LOOP;
    SELECT c.id INTO cid FROM public.hangtag_customers c WHERE c.owner_id = shop.id
     AND right(regexp_replace(COALESCE(c.phone, ''), '[^0-9]', '', 'g'), 10) = right(ph, 10) ORDER BY c.created_at LIMIT 1;
    IF cid IS NULL THEN
        cid := 'mc' || replace(gen_random_uuid()::TEXT, '-', '');
        INSERT INTO public.hangtag_customers (owner_id, id, name, phone, email, customer_type) VALUES (shop.id, cid, nm, ph, NULLIF(em, ''), 'individual');
    END IF;
    ono := 'MO-' || to_char(NOW() AT TIME ZONE 'Asia/Kolkata', 'YYMMDD') || '-' || upper(substr(md5(oid), 1, 6));
    INSERT INTO public.hangtag_orders (owner_id,id,kind,no,status,customer_id,customer,notes,source,version,t,updated_t,device_id,user_id,total,
        public_token,checkout_key,checkout_mode,payment_preference)
    VALUES (shop.id,oid,'sales',ono,'confirmed',cid,jsonb_build_object('id',cid,'name',nm,'phone',ph) || CASE WHEN em <> '' THEN jsonb_build_object('email',em) ELSE '{}'::jsonb END,
        clean_note,'customer',1,now_ms,now_ms,'mobile-store',NULL,round(total),otok,p_checkout_key,p_mode,p_payment);
    FOR it IN SELECT x.item FROM jsonb_array_elements(p_items) WITH ORDINALITY x(item,n) ORDER BY x.n LOOP
        q := (it ->> 'q')::NUMERIC;
        SELECT v.id, v.product_id, p.name, p.unit, public.hangtag_list_price(shop.id, NULL, NULL, p.id, v.id, COALESCE(v.price, p.price)) price,
               CASE WHEN tax_on THEN COALESCE(p.gst_rate,default_rate) ELSE 0 END gst_rate,
               COALESCE((SELECT string_agg(e.value, ' / ' ORDER BY e.n) FROM jsonb_array_elements_text(v.option_values) WITH ORDINALITY e(value,n)), '') label
          INTO vr FROM public.hangtag_variants v JOIN public.hangtag_products p ON p.owner_id=v.owner_id AND p.id=v.product_id
         WHERE v.owner_id=shop.id AND v.id=it->>'v';
        INSERT INTO public.hangtag_order_items (owner_id,order_id,line_no,product_id,variant_id,name,variant_label,unit,qty,price,gst_rate,fulfilled_qty)
        VALUES (shop.id,oid,ln,vr.product_id,vr.id,vr.name,vr.label,COALESCE(vr.unit,'pcs'),q,vr.price,vr.gst_rate,0);
        ln := ln + 1;
    END LOOP;
    RETURN jsonb_build_object('ok', TRUE, 'order_no', ono, 'order_token', otok, 'total', round(total), 'state', 'received', 'state_label', 'Confirmed');
END $$;
REVOKE ALL ON FUNCTION public.hangtag_mobile_catalog(TEXT), public.hangtag_place_mobile_order(TEXT,JSONB,JSONB,TEXT,TEXT,TEXT,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.hangtag_mobile_catalog(TEXT), public.hangtag_place_mobile_order(TEXT,JSONB,JSONB,TEXT,TEXT,TEXT,TEXT) TO anon,authenticated;

-- (f) E-invoice and e-way bill readiness: one row per bill, kept by the app (status ready / pending / not_required, the
--     payload it prepared, the transport typed for an e-way bill). The IRN, acknowledgement, signed QR, EWB number and
--     validity — and the statuses generated / failed / cancelled — come only from a provider adapter running with the
--     service role: the app can never write them, so Hangtag can't show an e-invoice or e-way bill that doesn't exist.
CREATE TABLE IF NOT EXISTS public.hangtag_einvoices (
    owner_id UUID NOT NULL DEFAULT public.hangtag_shop_id() REFERENCES auth.users(id) ON DELETE CASCADE,
    sale_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('not_required','ready','pending','generated','failed','cancelled')),
    payload JSONB,
    irn TEXT CHECK (irn IS NULL OR irn ~ '^[0-9a-f]{64}$'),
    ack_no TEXT CHECK (ack_no IS NULL OR char_length(ack_no) <= 30),
    ack_at TIMESTAMPTZ,
    signed_qr TEXT,
    provider TEXT CHECK (provider IS NULL OR char_length(provider) <= 40),
    errors JSONB,
    t BIGINT,
    device_id TEXT,
    user_id UUID DEFAULT auth.uid(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (owner_id, sale_id),
    CONSTRAINT hangtag_einvoices_sale_fkey FOREIGN KEY (owner_id, sale_id) REFERENCES public.hangtag_sales (owner_id, id) ON DELETE CASCADE,
    CONSTRAINT hangtag_einvoices_generated_check CHECK ((status IN ('generated','cancelled')) = (irn IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS public.hangtag_eway_bills (
    owner_id UUID NOT NULL DEFAULT public.hangtag_shop_id() REFERENCES auth.users(id) ON DELETE CASCADE,
    sale_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('not_required','ready','pending','generated','failed','cancelled')),
    transport JSONB CHECK (transport IS NULL OR jsonb_typeof(transport) = 'object'),
    payload JSONB,
    ewb_no TEXT CHECK (ewb_no IS NULL OR ewb_no ~ '^[0-9]{12}$'),
    ewb_at TIMESTAMPTZ,
    valid_until TIMESTAMPTZ,
    provider TEXT CHECK (provider IS NULL OR char_length(provider) <= 40),
    errors JSONB,
    t BIGINT,
    device_id TEXT,
    user_id UUID DEFAULT auth.uid(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (owner_id, sale_id),
    CONSTRAINT hangtag_eway_bills_sale_fkey FOREIGN KEY (owner_id, sale_id) REFERENCES public.hangtag_sales (owner_id, id) ON DELETE CASCADE,
    CONSTRAINT hangtag_eway_bills_no_check CHECK ((status IN ('generated','cancelled')) = (ewb_no IS NOT NULL))
);
-- SECURITY INVOKER on purpose: current_user is then the caller's role (the app is authenticated; a provider adapter runs as
-- the service role)
CREATE OR REPLACE FUNCTION public.hangtag_compliance_check()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE app BOOLEAN := current_user IN ('authenticated','anon');
        cap TEXT := CASE TG_TABLE_NAME WHEN 'hangtag_einvoices' THEN 'uses_einvoice' ELSE 'uses_eway' END;
        provider_fields JSONB;
BEGIN
    IF app THEN
        IF NOT public.hangtag_cap_on(NEW.owner_id, cap) THEN RAISE EXCEPTION '% is switched off for this shop.', CASE cap WHEN 'uses_einvoice' THEN 'E-invoicing' ELSE 'E-way bills' END USING ERRCODE = '42501'; END IF;
        IF NEW.status NOT IN ('not_required','ready','pending') THEN
            RAISE EXCEPTION 'Only the GST provider can mark this %.', NEW.status USING ERRCODE = '42501';
        END IF;
        IF TG_OP = 'UPDATE' AND OLD.status IN ('generated','cancelled') THEN
            RAISE EXCEPTION 'This one was generated by the GST provider and can''t be changed here.' USING ERRCODE = '42501';
        END IF;
        provider_fields := CASE TG_TABLE_NAME WHEN 'hangtag_einvoices' THEN jsonb_build_array(to_jsonb(NEW) -> 'irn', to_jsonb(NEW) -> 'ack_no', to_jsonb(NEW) -> 'ack_at', to_jsonb(NEW) -> 'signed_qr', to_jsonb(NEW) -> 'provider')
                                ELSE jsonb_build_array(to_jsonb(NEW) -> 'ewb_no', to_jsonb(NEW) -> 'ewb_at', to_jsonb(NEW) -> 'valid_until', to_jsonb(NEW) -> 'provider') END;
        IF EXISTS (SELECT 1 FROM jsonb_array_elements(provider_fields) f WHERE f <> 'null'::jsonb) THEN
            RAISE EXCEPTION 'The IRN / e-way bill number and the provider''s answer come only from the GST provider.' USING ERRCODE = '42501';
        END IF;
        IF auth.uid() IS NOT NULL THEN NEW.user_id := auth.uid(); END IF;
    END IF;
    NEW.updated_at := NOW();
    RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS hangtag_compliance_check ON public.hangtag_einvoices;
CREATE TRIGGER hangtag_compliance_check BEFORE INSERT OR UPDATE ON public.hangtag_einvoices FOR EACH ROW EXECUTE FUNCTION public.hangtag_compliance_check();
DROP TRIGGER IF EXISTS hangtag_compliance_check ON public.hangtag_eway_bills;
CREATE TRIGGER hangtag_compliance_check BEFORE INSERT OR UPDATE ON public.hangtag_eway_bills FOR EACH ROW EXECUTE FUNCTION public.hangtag_compliance_check();

-- (g) Repack: a source opened into a target, saved as one conversion (audit row) and its two stock records (rpk:<id>:out,
--     rpk:<id>:in) in one step. The quantity and value reconcile: what comes in is what went out × per, at its cost.
CREATE TABLE IF NOT EXISTS public.hangtag_repacks (
    owner_id UUID NOT NULL DEFAULT public.hangtag_shop_id() REFERENCES auth.users(id) ON DELETE CASCADE,
    id TEXT NOT NULL CHECK (id ~ '^[A-Za-z0-9_-]{1,50}$'),
    from_variant TEXT NOT NULL,
    from_product TEXT NOT NULL,
    to_variant TEXT NOT NULL,
    to_product TEXT NOT NULL,
    from_qty NUMERIC(12,3) NOT NULL CHECK (from_qty > 0),
    to_qty NUMERIC(12,3) NOT NULL CHECK (to_qty > 0),
    per NUMERIC(12,3) NOT NULL CHECK (per > 0),
    value NUMERIC(14,2),
    unit_cost NUMERIC(14,4),
    t BIGINT NOT NULL,
    device_id TEXT,
    user_id UUID DEFAULT auth.uid(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (owner_id, id),
    CONSTRAINT hangtag_repacks_diff_check CHECK (from_variant <> to_variant),
    CONSTRAINT hangtag_repacks_qty_check CHECK (to_qty <= from_qty * per + 0.001 AND to_qty > from_qty * per - 1)
);
-- SECURITY DEFINER: the app only reads conversions and may not lock a product; who may repack, and the shop, are checked here
CREATE OR REPLACE FUNCTION public.hangtag_save_repack(p JSONB)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE uid UUID := public.hangtag_shop_id(); rid TEXT := p ->> 'id'; fq NUMERIC := (p ->> 'from_qty')::NUMERIC; tq NUMERIC := (p ->> 'to_qty')::NUMERIC;
        fv RECORD; tv RECORD; onhand NUMERIC; tt BIGINT := COALESCE((p ->> 't')::BIGINT, (extract(epoch FROM now()) * 1000)::BIGINT); note TEXT;
BEGIN
    IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Sign in to repack stock.' USING ERRCODE = '42501'; END IF;
    IF uid IS NULL OR NOT public.hangtag_can('manage_inventory') THEN RAISE EXCEPTION 'Not allowed to repack stock.' USING ERRCODE = '42501'; END IF;
    IF NOT public.hangtag_cap_on(uid, 'uses_repack') THEN RAISE EXCEPTION 'Repacking is switched off for this shop.' USING ERRCODE = '42501'; END IF;
    IF EXISTS (SELECT 1 FROM public.hangtag_repacks r WHERE r.owner_id = uid AND r.id = rid) THEN RETURN jsonb_build_object('status', 'already_saved', 'id', rid); END IF;
    SELECT v.id, v.product_id, pr.name, COALESCE(pr.tracking, 'none') tracking INTO fv FROM public.hangtag_variants v JOIN public.hangtag_products pr ON pr.owner_id = v.owner_id AND pr.id = v.product_id
     WHERE v.owner_id = uid AND v.id = p ->> 'from_variant' FOR UPDATE OF v;
    SELECT v.id, v.product_id, pr.name, COALESCE(pr.tracking, 'none') tracking INTO tv FROM public.hangtag_variants v JOIN public.hangtag_products pr ON pr.owner_id = v.owner_id AND pr.id = v.product_id
     WHERE v.owner_id = uid AND v.id = p ->> 'to_variant';
    IF fv.id IS NULL OR tv.id IS NULL THEN RAISE EXCEPTION 'Both products of a repack must be in this shop''s catalog.' USING ERRCODE = '23503'; END IF;
    IF fv.tracking = 'serial' OR tv.tracking = 'serial' THEN RAISE EXCEPTION 'Products tracked by serial number can''t be repacked.' USING ERRCODE = 'check_violation'; END IF;
    onhand := COALESCE((SELECT sum(m.qty) FROM public.hangtag_stock_moves m WHERE m.owner_id = uid AND m.variant_id = fv.id), 0)
        - COALESCE((SELECT sum(i.quantity) FROM public.hangtag_sale_items i JOIN public.hangtag_sales s ON s.owner_id = i.owner_id AND s.id = i.sale_id
                     WHERE i.owner_id = uid AND i.variant_id = fv.id AND NOT s.is_void), 0)
        + COALESCE((SELECT sum(i.quantity) FROM public.hangtag_return_items i JOIN public.hangtag_returns r ON r.owner_id = i.owner_id AND r.id = i.return_id
                     JOIN public.hangtag_sales s ON s.owner_id = r.owner_id AND s.id = r.sale_id WHERE i.owner_id = uid AND i.variant_id = fv.id AND i.restock AND NOT s.is_void), 0);
    IF fq > onhand THEN RAISE EXCEPTION 'Only % of % is in stock to repack.', trim_scale(onhand), fv.name USING ERRCODE = 'check_violation'; END IF;
    note := left(COALESCE(NULLIF(btrim(p ->> 'note'), ''), 'Repacked ' || trim_scale(fq) || ' ' || fv.name || ' → ' || trim_scale(tq) || ' ' || tv.name), 200);
    INSERT INTO public.hangtag_repacks (owner_id, id, from_variant, from_product, to_variant, to_product, from_qty, to_qty, per, value, unit_cost, t, device_id)
    VALUES (uid, rid, fv.id, fv.product_id, tv.id, tv.product_id, fq, tq, (p ->> 'per')::NUMERIC, (p ->> 'value')::NUMERIC, (p ->> 'unit_cost')::NUMERIC, tt, p ->> 'device_id');
    INSERT INTO public.hangtag_stock_moves (owner_id, id, variant_id, product_id, type, qty, cost_price, note, t, device_id, batch_no, expiry)
    VALUES (uid, 'rpk:' || rid || ':out', fv.id, fv.product_id, 'ADJUST', -fq, NULL, note, tt, p ->> 'device_id', NULLIF(p ->> 'from_batch', ''), NULL),
           (uid, 'rpk:' || rid || ':in', tv.id, tv.product_id, 'RESTOCK', tq, CASE WHEN p ->> 'unit_cost' IS NULL THEN NULL ELSE round((p ->> 'unit_cost')::NUMERIC)::INTEGER END, note, tt, p ->> 'device_id',
            NULLIF(p ->> 'to_batch', ''), NULLIF(p ->> 'to_expiry', '')::DATE)
    ON CONFLICT (owner_id, id) DO NOTHING;
    RETURN jsonb_build_object('status', 'saved', 'id', rid);
END $$;
REVOKE ALL ON FUNCTION public.hangtag_save_repack(JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.hangtag_save_repack(JSONB) TO authenticated;
DROP TRIGGER IF EXISTS hangtag_audit ON public.hangtag_repacks;
CREATE TRIGGER hangtag_audit AFTER INSERT OR DELETE ON public.hangtag_repacks FOR EACH ROW EXECUTE FUNCTION public.hangtag_audit();

-- (h) Gift vouchers. Issued online (the code comes from the database's own randomness and is unique), spent as a payment
--     of a bill. Spending locks the voucher row, so two tills can't spend the same balance; a payment is taken off a
--     voucher once (its redemption has the payment's id); cancelling the bill gives the amount back. A code only works at
--     the shop that issued it.
CREATE TABLE IF NOT EXISTS public.hangtag_vouchers (
    owner_id UUID NOT NULL DEFAULT public.hangtag_shop_id() REFERENCES auth.users(id) ON DELETE CASCADE,
    id TEXT NOT NULL CHECK (id ~ '^[A-Za-z0-9_-]{1,64}$'),
    code TEXT NOT NULL CHECK (code ~ '^GV-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$'),
    amount NUMERIC(12,2) NOT NULL CHECK (amount > 0 AND amount <= 100000),
    balance NUMERIC(12,2) NOT NULL CHECK (balance >= 0),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','fully_redeemed','expired','cancelled')),
    expires_on DATE,
    customer_id TEXT,
    customer_name TEXT CHECK (customer_name IS NULL OR char_length(customer_name) <= 80),
    paid_method TEXT NOT NULL CHECK (paid_method IN ('cash','upi','card')),
    note TEXT CHECK (note IS NULL OR char_length(note) <= 200),
    cancel_reason TEXT CHECK (cancel_reason IS NULL OR char_length(cancel_reason) <= 200),
    t BIGINT NOT NULL,
    device_id TEXT,
    user_id UUID DEFAULT auth.uid(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (owner_id, id),
    CONSTRAINT hangtag_vouchers_balance_amount_check CHECK (balance <= amount AND (status <> 'fully_redeemed' OR balance = 0)),
    CONSTRAINT hangtag_vouchers_customer_fkey FOREIGN KEY (owner_id, customer_id) REFERENCES public.hangtag_customers (owner_id, id) ON DELETE SET NULL (customer_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_hangtag_vouchers_code ON public.hangtag_vouchers (code);
CREATE TABLE IF NOT EXISTS public.hangtag_voucher_redemptions (
    owner_id UUID NOT NULL DEFAULT public.hangtag_shop_id() REFERENCES auth.users(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    voucher_id TEXT NOT NULL,
    sale_id TEXT,
    payment_id TEXT NOT NULL,
    amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
    kind TEXT NOT NULL CHECK (kind IN ('redeem','reverse')),
    t BIGINT NOT NULL,
    user_id UUID DEFAULT auth.uid(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (owner_id, id),
    CONSTRAINT hangtag_voucher_redemptions_once UNIQUE (owner_id, payment_id, kind),
    CONSTRAINT hangtag_voucher_redemptions_voucher_fkey FOREIGN KEY (owner_id, voucher_id) REFERENCES public.hangtag_vouchers (owner_id, id)
);
CREATE INDEX IF NOT EXISTS idx_hangtag_voucher_redemptions_voucher ON public.hangtag_voucher_redemptions (owner_id, voucher_id, t);

-- Bills may be paid (in part) by a voucher; such a payment is not money in the drawer or the bank
ALTER TABLE public.hangtag_payments DROP CONSTRAINT IF EXISTS hangtag_payments_method_check;
ALTER TABLE public.hangtag_payments ADD CONSTRAINT hangtag_payments_method_check CHECK (method IN ('cash','upi','card','voucher'));
ALTER TABLE public.hangtag_sales DROP CONSTRAINT IF EXISTS hangtag_sales_payment_method_check;
ALTER TABLE public.hangtag_sales ADD CONSTRAINT hangtag_sales_payment_method_check CHECK (payment_method IN ('cash','upi','card','split','credit','voucher')) NOT VALID;

CREATE OR REPLACE FUNCTION public.hangtag_voucher_code()
RETURNS TEXT LANGUAGE plpgsql VOLATILE SET search_path = '' AS $$
DECLARE a TEXT := '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; b BYTEA := decode(md5(gen_random_uuid()::TEXT || clock_timestamp()::TEXT), 'hex'); s TEXT := ''; i INT;
BEGIN
    FOR i IN 0..11 LOOP s := s || substr(a, (get_byte(b, i) % 32) + 1, 1); END LOOP;
    RETURN 'GV-' || substr(s, 1, 4) || '-' || substr(s, 5, 4) || '-' || substr(s, 9, 4);
END $$;
-- p: { amount, expires_on, customer_id, paid_method, note, device_id, t } -> the voucher (with its code, shown once to print)
CREATE OR REPLACE FUNCTION public.hangtag_issue_voucher(p JSONB)
RETURNS JSONB LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE uid UUID := public.hangtag_shop_id(); v public.hangtag_vouchers; a NUMERIC := round((p ->> 'amount')::NUMERIC, 2); cname TEXT; tries INT := 0;
        tt BIGINT := COALESCE((p ->> 't')::BIGINT, (extract(epoch FROM now()) * 1000)::BIGINT);
BEGIN
    IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Sign in to issue vouchers.' USING ERRCODE = '42501'; END IF;
    IF uid IS NULL OR NOT public.hangtag_can('create_sale') THEN RAISE EXCEPTION 'Not allowed to issue vouchers.' USING ERRCODE = '42501'; END IF;
    IF NOT public.hangtag_cap_on(uid, 'uses_vouchers') THEN RAISE EXCEPTION 'Gift vouchers are switched off for this shop.' USING ERRCODE = '42501'; END IF;
    IF a IS NULL OR a <= 0 OR a > 100000 THEN RAISE EXCEPTION 'A voucher is for ₹1 to ₹1,00,000.' USING ERRCODE = 'check_violation'; END IF;
    IF NULLIF(p ->> 'expires_on', '')::DATE < (now() AT TIME ZONE 'Asia/Kolkata')::DATE THEN RAISE EXCEPTION 'The last day is already past.' USING ERRCODE = 'check_violation'; END IF;
    IF NULLIF(p ->> 'customer_id', '') IS NOT NULL THEN
        SELECT c.name INTO cname FROM public.hangtag_customers c WHERE c.owner_id = uid AND c.id = p ->> 'customer_id';
        IF NOT FOUND THEN RAISE EXCEPTION 'That customer isn''t in the cloud yet.' USING ERRCODE = '23503'; END IF;
    END IF;
    LOOP
        BEGIN
            INSERT INTO public.hangtag_vouchers (owner_id, id, code, amount, balance, status, expires_on, customer_id, customer_name, paid_method, note, t, device_id, user_id)
            VALUES (uid, 'gv' || replace(gen_random_uuid()::TEXT, '-', ''), public.hangtag_voucher_code(), a, a, 'active', NULLIF(p ->> 'expires_on', '')::DATE,
                NULLIF(p ->> 'customer_id', ''), cname, p ->> 'paid_method', NULLIF(left(btrim(COALESCE(p ->> 'note', '')), 200), ''), tt, p ->> 'device_id', auth.uid())
            RETURNING * INTO v;
            EXIT;
        EXCEPTION WHEN unique_violation THEN
            tries := tries + 1; IF tries > 5 THEN RAISE; END IF;
        END;
    END LOOP;
    -- the money came in now: cash goes into the drawer's book (UPI and card are kept on the voucher)
    IF v.paid_method = 'cash' THEN
        INSERT INTO public.hangtag_cash_moves (owner_id, id, type, amount, reason, t, device_id)
        VALUES (uid, 'gv:' || v.id, 'in', v.amount, left('Gift voucher sold ' || 'GV-····-····-' || right(v.code, 4), 200), tt, v.device_id)
        ON CONFLICT DO NOTHING;
    END IF;
    RETURN jsonb_build_object('ok', TRUE, 'voucher', to_jsonb(v));
END $$;
-- The balance of a code at this shop (another shop's code is "not found")
CREATE OR REPLACE FUNCTION public.hangtag_voucher_lookup(p_code TEXT)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE uid UUID := public.hangtag_shop_id(); v public.hangtag_vouchers; st TEXT;
BEGIN
    IF auth.uid() IS NULL OR uid IS NULL OR NOT public.hangtag_can('create_sale') THEN RAISE EXCEPTION 'Not allowed to use vouchers.' USING ERRCODE = '42501'; END IF;
    SELECT * INTO v FROM public.hangtag_vouchers x WHERE x.owner_id = uid AND x.code = upper(btrim(COALESCE(p_code, '')));
    IF NOT FOUND THEN RETURN jsonb_build_object('ok', FALSE, 'message', 'That voucher code wasn''t found at this shop.'); END IF;
    st := CASE WHEN v.status IN ('cancelled','fully_redeemed') THEN v.status WHEN v.balance <= 0 THEN 'fully_redeemed'
               WHEN v.expires_on < (now() AT TIME ZONE 'Asia/Kolkata')::DATE THEN 'expired' ELSE 'active' END;
    RETURN jsonb_build_object('ok', TRUE, 'id', v.id, 'code', v.code, 'amount', v.amount, 'balance', v.balance, 'status', st, 'expires_on', v.expires_on, 'customer_name', v.customer_name);
END $$;
-- Takes an amount off a voucher for one payment of a bill (before the bill is saved). The same payment again: its answer
-- again; a changed amount for the same payment (the cashier changed the split): adjusted, never below 0.
CREATE OR REPLACE FUNCTION public.hangtag_redeem_voucher(p_code TEXT, p_amount NUMERIC, p_sale TEXT, p_payment TEXT, p_t BIGINT DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE uid UUID := public.hangtag_shop_id(); v public.hangtag_vouchers; r public.hangtag_voucher_redemptions; a NUMERIC := round(p_amount, 2); free NUMERIC;
        tt BIGINT := COALESCE(p_t, (extract(epoch FROM now()) * 1000)::BIGINT);
BEGIN
    IF auth.uid() IS NULL OR uid IS NULL OR NOT public.hangtag_can('create_sale') THEN RAISE EXCEPTION 'Not allowed to use vouchers.' USING ERRCODE = '42501'; END IF;
    IF p_payment IS NULL OR p_payment !~ '^.{1,80}:voucher$' OR p_sale IS NULL OR p_payment <> p_sale || ':voucher' THEN RAISE EXCEPTION 'A voucher pays one bill.' USING ERRCODE = '22023'; END IF;
    IF a IS NULL OR a <= 0 THEN RAISE EXCEPTION 'Enter the amount to pay with the voucher.' USING ERRCODE = 'check_violation'; END IF;
    SELECT * INTO v FROM public.hangtag_vouchers x WHERE x.owner_id = uid AND x.code = upper(btrim(COALESCE(p_code, ''))) FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('ok', FALSE, 'message', 'That voucher code wasn''t found at this shop.'); END IF;
    IF EXISTS (SELECT 1 FROM public.hangtag_payments p WHERE p.owner_id = uid AND p.id = p_payment) THEN
        RETURN jsonb_build_object('ok', FALSE, 'message', 'This bill is already saved.');
    END IF;
    SELECT * INTO r FROM public.hangtag_voucher_redemptions x WHERE x.owner_id = uid AND x.payment_id = p_payment AND x.kind = 'redeem';
    IF FOUND AND r.voucher_id <> v.id THEN RETURN jsonb_build_object('ok', FALSE, 'message', 'Another voucher already pays this bill. Remove it first.'); END IF;
    IF FOUND AND r.amount = a THEN RETURN jsonb_build_object('ok', TRUE, 'id', v.id, 'redemption', r.id, 'amount', r.amount, 'balance', v.balance); END IF;
    IF v.status = 'cancelled' THEN RETURN jsonb_build_object('ok', FALSE, 'message', 'This voucher was cancelled.'); END IF;
    IF v.expires_on < (now() AT TIME ZONE 'Asia/Kolkata')::DATE THEN RETURN jsonb_build_object('ok', FALSE, 'message', 'This voucher expired on ' || to_char(v.expires_on, 'DD Mon YYYY') || '.'); END IF;
    free := v.balance + CASE WHEN FOUND THEN r.amount ELSE 0 END;
    IF a > free THEN RETURN jsonb_build_object('ok', FALSE, 'message', 'This voucher has only ₹' || trim_scale(free) || ' left.', 'balance', free); END IF;
    IF FOUND THEN
        UPDATE public.hangtag_voucher_redemptions SET amount = a, t = tt WHERE owner_id = uid AND id = r.id RETURNING * INTO r;
    ELSE
        INSERT INTO public.hangtag_voucher_redemptions (owner_id, id, voucher_id, sale_id, payment_id, amount, kind, t, user_id)
        VALUES (uid, 'gvr' || replace(gen_random_uuid()::TEXT, '-', ''), v.id, p_sale, p_payment, a, 'redeem', tt, auth.uid()) RETURNING * INTO r;
    END IF;
    UPDATE public.hangtag_vouchers SET balance = free - a, status = CASE WHEN free - a = 0 THEN 'fully_redeemed' ELSE 'active' END, updated_at = NOW()
     WHERE owner_id = uid AND id = v.id RETURNING * INTO v;
    RETURN jsonb_build_object('ok', TRUE, 'id', v.id, 'redemption', r.id, 'amount', r.amount, 'balance', v.balance);
END $$;
-- The cashier took the voucher off a bill that was never saved: its amount goes back on the voucher
CREATE OR REPLACE FUNCTION public.hangtag_release_voucher(p_payment TEXT)
RETURNS JSONB LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE uid UUID := public.hangtag_shop_id(); r public.hangtag_voucher_redemptions;
BEGIN
    IF auth.uid() IS NULL OR uid IS NULL OR NOT public.hangtag_can('create_sale') THEN RAISE EXCEPTION 'Not allowed to use vouchers.' USING ERRCODE = '42501'; END IF;
    IF EXISTS (SELECT 1 FROM public.hangtag_payments p WHERE p.owner_id = uid AND p.id = p_payment) THEN RETURN jsonb_build_object('ok', FALSE, 'message', 'The bill is saved: cancel the bill instead.'); END IF;
    SELECT * INTO r FROM public.hangtag_voucher_redemptions x WHERE x.owner_id = uid AND x.payment_id = p_payment AND x.kind = 'redeem';
    IF NOT FOUND THEN RETURN jsonb_build_object('ok', TRUE, 'released', 0); END IF;
    PERFORM 1 FROM public.hangtag_vouchers v WHERE v.owner_id = uid AND v.id = r.voucher_id FOR UPDATE;
    DELETE FROM public.hangtag_voucher_redemptions WHERE owner_id = uid AND id = r.id;
    UPDATE public.hangtag_vouchers SET balance = balance + r.amount, status = CASE WHEN status = 'fully_redeemed' THEN 'active' ELSE status END, updated_at = NOW()
     WHERE owner_id = uid AND id = r.voucher_id;
    RETURN jsonb_build_object('ok', TRUE, 'released', r.amount);
END $$;
-- Never used yet: cancelled with a reason (cash paid for it goes back out of the drawer)
CREATE OR REPLACE FUNCTION public.hangtag_cancel_voucher(p_id TEXT, p_reason TEXT)
RETURNS JSONB LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE uid UUID := public.hangtag_shop_id(); v public.hangtag_vouchers; why TEXT := btrim(COALESCE(p_reason, ''));
BEGIN
    IF auth.uid() IS NULL OR uid IS NULL OR NOT public.hangtag_can('manage_settings') THEN RAISE EXCEPTION 'Not allowed to cancel vouchers.' USING ERRCODE = '42501'; END IF;
    SELECT * INTO v FROM public.hangtag_vouchers x WHERE x.owner_id = uid AND x.id = p_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'That voucher wasn''t found.' USING ERRCODE = '23503'; END IF;
    IF v.status = 'cancelled' THEN RETURN jsonb_build_object('ok', TRUE, 'status', 'already_cancelled'); END IF;
    IF v.balance <> v.amount OR EXISTS (SELECT 1 FROM public.hangtag_voucher_redemptions r WHERE r.owner_id = uid AND r.voucher_id = v.id AND r.kind = 'redeem'
        AND NOT EXISTS (SELECT 1 FROM public.hangtag_voucher_redemptions x WHERE x.owner_id = uid AND x.payment_id = r.payment_id AND x.kind = 'reverse')) THEN
        RAISE EXCEPTION 'Part of this voucher was used, so it can''t be cancelled.' USING ERRCODE = 'check_violation';
    END IF;
    IF char_length(why) < 3 THEN RAISE EXCEPTION 'Say why the voucher is cancelled.' USING ERRCODE = 'check_violation'; END IF;
    UPDATE public.hangtag_vouchers SET status = 'cancelled', cancel_reason = left(why, 200), updated_at = NOW() WHERE owner_id = uid AND id = v.id;
    INSERT INTO public.hangtag_cash_moves (owner_id, id, type, amount, reason, reverses, t)
    SELECT uid, 'gvx:' || v.id, 'reversal', c.amount, left('Gift voucher cancelled: ' || why, 200), c.id, (extract(epoch FROM now()) * 1000)::BIGINT
      FROM public.hangtag_cash_moves c WHERE c.owner_id = uid AND c.id = 'gv:' || v.id
    ON CONFLICT DO NOTHING;
    RETURN jsonb_build_object('ok', TRUE, 'status', 'cancelled');
END $$;
-- A voucher payment on a bill is taken only with its redemption (same voucher amount, same payment); cancelling the bill
-- gives it back once; restoring the bill takes it again if the balance still allows.
CREATE OR REPLACE FUNCTION public.hangtag_voucher_payment_check()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.hangtag_voucher_redemptions; v public.hangtag_vouchers; rev BOOLEAN;
BEGIN
    IF NEW.method <> 'voucher' THEN RETURN NEW; END IF;
    SELECT * INTO r FROM public.hangtag_voucher_redemptions x WHERE x.owner_id = NEW.owner_id AND x.payment_id = NEW.id AND x.kind = 'redeem';
    IF NOT FOUND OR r.amount <> NEW.amount THEN
        RAISE EXCEPTION 'The voucher payment on bill % was not taken off a voucher. Use the voucher again.', NEW.sale_id USING ERRCODE = 'check_violation';
    END IF;
    rev := EXISTS (SELECT 1 FROM public.hangtag_voucher_redemptions x WHERE x.owner_id = NEW.owner_id AND x.payment_id = NEW.id AND x.kind = 'reverse');
    IF NEW.status = 'cancelled' AND NOT rev THEN
        SELECT * INTO v FROM public.hangtag_vouchers x WHERE x.owner_id = NEW.owner_id AND x.id = r.voucher_id FOR UPDATE;
        INSERT INTO public.hangtag_voucher_redemptions (owner_id, id, voucher_id, sale_id, payment_id, amount, kind, t)
        VALUES (NEW.owner_id, 'gvx' || replace(gen_random_uuid()::TEXT, '-', ''), r.voucher_id, NEW.sale_id, NEW.id, r.amount, 'reverse', (extract(epoch FROM now()) * 1000)::BIGINT);
        UPDATE public.hangtag_vouchers SET balance = LEAST(amount, balance + r.amount), status = CASE WHEN status = 'fully_redeemed' THEN 'active' ELSE status END, updated_at = NOW()
         WHERE owner_id = NEW.owner_id AND id = r.voucher_id;
    ELSIF NEW.status = 'completed' AND rev THEN
        SELECT * INTO v FROM public.hangtag_vouchers x WHERE x.owner_id = NEW.owner_id AND x.id = r.voucher_id FOR UPDATE;
        IF v.status = 'cancelled' OR v.balance < r.amount THEN RAISE EXCEPTION 'The voucher no longer has ₹% for this bill, so it can''t be restored.', r.amount USING ERRCODE = 'check_violation'; END IF;
        DELETE FROM public.hangtag_voucher_redemptions WHERE owner_id = NEW.owner_id AND payment_id = NEW.id AND kind = 'reverse';
        UPDATE public.hangtag_vouchers SET balance = balance - r.amount, status = CASE WHEN balance - r.amount = 0 THEN 'fully_redeemed' ELSE 'active' END, updated_at = NOW()
         WHERE owner_id = NEW.owner_id AND id = r.voucher_id;
    END IF;
    RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS hangtag_voucher_payment_check ON public.hangtag_payments;
CREATE TRIGGER hangtag_voucher_payment_check BEFORE INSERT OR UPDATE ON public.hangtag_payments FOR EACH ROW EXECUTE FUNCTION public.hangtag_voucher_payment_check();
-- Posting payments to the money books (as section 3e): a voucher payment is neither cash nor bank money
CREATE OR REPLACE FUNCTION public.hangtag_post_payment()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    ft TEXT := 'ft:' || NEW.id;
    voided BOOLEAN;
    st TEXT;
BEGIN
    IF NEW.method = 'voucher' THEN
        DELETE FROM public.hangtag_cash_book WHERE owner_id = NEW.owner_id AND fin_txn_id = ft;
        DELETE FROM public.hangtag_bank_book WHERE owner_id = NEW.owner_id AND fin_txn_id = ft;
        DELETE FROM public.hangtag_fin_txns WHERE owner_id = NEW.owner_id AND id = ft;
        RETURN NULL;
    END IF;
    SELECT is_void INTO voided FROM public.hangtag_sales WHERE owner_id = NEW.owner_id AND id = NEW.sale_id;
    st := CASE WHEN NEW.status = 'completed' AND NOT COALESCE(voided, FALSE) THEN 'posted' ELSE 'cancelled' END;
    INSERT INTO public.hangtag_fin_txns (owner_id, id, kind, direction, method, amount, sale_id, payment_id, reference, status, t)
    VALUES (NEW.owner_id, ft, 'sale_receipt', 'in', NEW.method, NEW.amount, NEW.sale_id, NEW.id, NEW.reference, st, NEW.t)
    ON CONFLICT (owner_id, id) DO UPDATE SET method = EXCLUDED.method, amount = EXCLUDED.amount, reference = EXCLUDED.reference,
        status = EXCLUDED.status, t = EXCLUDED.t;
    IF NEW.method = 'cash' THEN
        DELETE FROM public.hangtag_bank_book WHERE owner_id = NEW.owner_id AND fin_txn_id = ft;
        INSERT INTO public.hangtag_cash_book (owner_id, id, fin_txn_id, sale_id, entry_type, amount_in, cash_received, change_given, status, t)
        VALUES (NEW.owner_id, 'cb:' || ft, ft, NEW.sale_id, 'cash_sale', NEW.amount, COALESCE(NEW.tendered, NEW.amount), NEW.change_given, st, NEW.t)
        ON CONFLICT (owner_id, id) DO UPDATE SET amount_in = EXCLUDED.amount_in, cash_received = EXCLUDED.cash_received,
            change_given = EXCLUDED.change_given, status = EXCLUDED.status, t = EXCLUDED.t;
    ELSE
        DELETE FROM public.hangtag_cash_book WHERE owner_id = NEW.owner_id AND fin_txn_id = ft;
        INSERT INTO public.hangtag_bank_book (owner_id, id, fin_txn_id, sale_id, method, entry_type, reference, amount_in, status, t, verification)
        VALUES (NEW.owner_id, 'bb:' || ft, ft, NEW.sale_id, NEW.method, 'receipt', NEW.reference, NEW.amount, st, NEW.t, to_jsonb(NEW) ->> 'verification')
        ON CONFLICT (owner_id, id) DO UPDATE SET method = EXCLUDED.method, reference = EXCLUDED.reference, amount_in = EXCLUDED.amount_in,
            status = EXCLUDED.status, t = EXCLUDED.t, verification = EXCLUDED.verification;
    END IF;
    RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.hangtag_issue_voucher(JSONB), public.hangtag_voucher_lookup(TEXT), public.hangtag_redeem_voucher(TEXT,NUMERIC,TEXT,TEXT,BIGINT),
    public.hangtag_release_voucher(TEXT), public.hangtag_cancel_voucher(TEXT,TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.hangtag_issue_voucher(JSONB), public.hangtag_voucher_lookup(TEXT), public.hangtag_redeem_voucher(TEXT,NUMERIC,TEXT,TEXT,BIGINT),
    public.hangtag_release_voucher(TEXT), public.hangtag_cancel_voucher(TEXT,TEXT) TO authenticated;
REVOKE ALL ON FUNCTION public.hangtag_voucher_code(), public.hangtag_voucher_payment_check(), public.hangtag_post_payment() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS hangtag_audit ON public.hangtag_vouchers;
CREATE TRIGGER hangtag_audit AFTER INSERT OR DELETE ON public.hangtag_vouchers FOR EACH ROW EXECUTE FUNCTION public.hangtag_audit();
DROP TRIGGER IF EXISTS hangtag_audit_change ON public.hangtag_vouchers;
CREATE TRIGGER hangtag_audit_change AFTER UPDATE OF status ON public.hangtag_vouchers FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status) EXECUTE FUNCTION public.hangtag_audit();

-- (i) Outbound webhooks (owner only; Settings → Advanced → Integrations). Endpoints hold no secret: the secret is in its
--     own table nobody but the service role reads (supabase/functions/webhook-dispatch signs with it); it is shown to the
--     owner once, when made or replaced. An event is written once per change (event key), a delivery once per event and
--     endpoint; the function retries with back-off and records every attempt's result.
CREATE TABLE IF NOT EXISTS public.hangtag_webhook_endpoints (
    owner_id UUID NOT NULL DEFAULT public.hangtag_shop_id() REFERENCES auth.users(id) ON DELETE CASCADE,
    id UUID NOT NULL DEFAULT gen_random_uuid(),
    url TEXT NOT NULL CHECK (url ~ '^https://[^/@\s]+\.[^/@\s]+(/.*)?$' AND char_length(url) <= 500),
    events TEXT[] NOT NULL CHECK (cardinality(events) BETWEEN 1 AND 10 AND events <@ ARRAY['sale.completed','payment.recorded','order.created','order.updated','purchase.received','inventory.changed','customer.created']::TEXT[]),
    active BOOLEAN NOT NULL DEFAULT TRUE,
    description TEXT CHECK (description IS NULL OR char_length(description) <= 80),
    last_success_at TIMESTAMPTZ,
    last_failure_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (owner_id, id),
    CONSTRAINT hangtag_webhook_endpoints_id_key UNIQUE (id)
);
CREATE TABLE IF NOT EXISTS public.hangtag_webhook_secrets (
    endpoint_id UUID PRIMARY KEY REFERENCES public.hangtag_webhook_endpoints (id) ON DELETE CASCADE,
    owner_id UUID NOT NULL DEFAULT public.hangtag_shop_id() REFERENCES auth.users(id) ON DELETE CASCADE,
    secret TEXT NOT NULL CHECK (secret ~ '^whsec_[0-9a-f]{64}$'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS public.hangtag_webhook_events (
    owner_id UUID NOT NULL DEFAULT public.hangtag_shop_id() REFERENCES auth.users(id) ON DELETE CASCADE,
    id UUID NOT NULL DEFAULT gen_random_uuid(),
    type TEXT NOT NULL,
    event_key TEXT NOT NULL,
    payload JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (owner_id, id),
    CONSTRAINT hangtag_webhook_events_id_key UNIQUE (id),
    CONSTRAINT hangtag_webhook_events_once UNIQUE (owner_id, type, event_key)
);
CREATE TABLE IF NOT EXISTS public.hangtag_webhook_deliveries (
    owner_id UUID NOT NULL DEFAULT public.hangtag_shop_id() REFERENCES auth.users(id) ON DELETE CASCADE,
    id UUID NOT NULL DEFAULT gen_random_uuid(),
    endpoint_id UUID NOT NULL REFERENCES public.hangtag_webhook_endpoints (id) ON DELETE CASCADE,
    event_id UUID NOT NULL REFERENCES public.hangtag_webhook_events (id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sending','delivered','failed')),
    attempts INT NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_status INT,
    last_error TEXT CHECK (last_error IS NULL OR char_length(last_error) <= 300),
    delivered_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (owner_id, id),
    CONSTRAINT hangtag_webhook_deliveries_once UNIQUE (endpoint_id, event_id)
);
CREATE INDEX IF NOT EXISTS idx_hangtag_webhook_deliveries_due ON public.hangtag_webhook_deliveries (next_attempt_at) WHERE status IN ('pending','sending');
CREATE INDEX IF NOT EXISTS idx_hangtag_webhook_deliveries_shop ON public.hangtag_webhook_deliveries (owner_id, created_at DESC);

-- One event for a change (the same key again — a bill uploaded twice — does nothing), with a delivery to every active
-- endpoint of the shop that asked for that type. Costs one indexed look-up when the shop has no endpoints.
CREATE OR REPLACE FUNCTION public.hangtag_webhook_emit(p_owner UUID, p_type TEXT, p_key TEXT, p_payload JSONB)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE eid UUID;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM public.hangtag_webhook_endpoints e WHERE e.owner_id = p_owner AND e.active AND p_type = ANY (e.events)) THEN RETURN; END IF;
    INSERT INTO public.hangtag_webhook_events (owner_id, type, event_key, payload) VALUES (p_owner, p_type, left(p_key, 200), p_payload)
    ON CONFLICT (owner_id, type, event_key) DO NOTHING RETURNING id INTO eid;
    IF eid IS NULL THEN RETURN; END IF;
    INSERT INTO public.hangtag_webhook_deliveries (owner_id, endpoint_id, event_id)
    SELECT p_owner, e.id, eid FROM public.hangtag_webhook_endpoints e WHERE e.owner_id = p_owner AND e.active AND p_type = ANY (e.events)
    ON CONFLICT (endpoint_id, event_id) DO NOTHING;
END $$;
CREATE OR REPLACE FUNCTION public.hangtag_webhook_source()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
    IF TG_TABLE_NAME = 'hangtag_sales' THEN
        IF NOT NEW.is_void THEN PERFORM public.hangtag_webhook_emit(NEW.owner_id, 'sale.completed', NEW.id, jsonb_build_object('id', NEW.id, 'bill_no', NEW.bill_no,
            'total', NEW.total, 'time', NEW.timestamp, 'customer_id', NEW.customer_id, 'order_id', NEW.order_id, 'kind', NEW.kind)); END IF;
    ELSIF TG_TABLE_NAME = 'hangtag_payments' THEN
        PERFORM public.hangtag_webhook_emit(NEW.owner_id, 'payment.recorded', NEW.id, jsonb_build_object('id', NEW.id, 'sale_id', NEW.sale_id, 'method', NEW.method,
            'amount', NEW.amount, 'verification', NEW.verification, 'time', NEW.t));
    ELSIF TG_TABLE_NAME = 'hangtag_orders' THEN
        IF TG_OP = 'INSERT' THEN PERFORM public.hangtag_webhook_emit(NEW.owner_id, 'order.created', NEW.id, jsonb_build_object('id', NEW.id, 'no', NEW.no, 'kind', NEW.kind,
            'status', NEW.status, 'total', NEW.total, 'customer_id', NEW.customer_id, 'source', NEW.source));
        ELSIF NEW.status IS DISTINCT FROM OLD.status THEN PERFORM public.hangtag_webhook_emit(NEW.owner_id, 'order.updated', NEW.id || ':' || NEW.version, jsonb_build_object('id', NEW.id,
            'no', NEW.no, 'kind', NEW.kind, 'status', NEW.status, 'previous_status', OLD.status, 'total', NEW.total)); END IF;
    ELSIF TG_TABLE_NAME = 'hangtag_stock_imports' THEN
        IF NEW.kind = 'purchase' THEN PERFORM public.hangtag_webhook_emit(NEW.owner_id, 'purchase.received', NEW.id, jsonb_build_object('id', NEW.id, 'supplier_id', NEW.supplier_id,
            'invoice_no', NEW.invoice_no, 'po_id', NEW.po_id, 'total', NEW.total_amount, 'lines', NEW.line_count, 'units', NEW.units)); END IF;
    ELSIF TG_TABLE_NAME = 'hangtag_stock_moves' THEN
        PERFORM public.hangtag_webhook_emit(NEW.owner_id, 'inventory.changed', NEW.id, jsonb_build_object('id', NEW.id, 'variant_id', NEW.variant_id, 'product_id', NEW.product_id,
            'type', NEW.type, 'qty', NEW.qty, 'time', NEW.t));
    ELSIF TG_TABLE_NAME = 'hangtag_customers' THEN
        PERFORM public.hangtag_webhook_emit(NEW.owner_id, 'customer.created', NEW.id, jsonb_build_object('id', NEW.id, 'name', NEW.name, 'type', NEW.customer_type));
    END IF;
    RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS hangtag_webhook_source ON public.hangtag_sales;
CREATE TRIGGER hangtag_webhook_source AFTER INSERT ON public.hangtag_sales FOR EACH ROW EXECUTE FUNCTION public.hangtag_webhook_source();
DROP TRIGGER IF EXISTS hangtag_webhook_source ON public.hangtag_payments;
CREATE TRIGGER hangtag_webhook_source AFTER INSERT ON public.hangtag_payments FOR EACH ROW EXECUTE FUNCTION public.hangtag_webhook_source();
DROP TRIGGER IF EXISTS hangtag_webhook_source ON public.hangtag_orders;
CREATE TRIGGER hangtag_webhook_source AFTER INSERT OR UPDATE OF status ON public.hangtag_orders FOR EACH ROW EXECUTE FUNCTION public.hangtag_webhook_source();
DROP TRIGGER IF EXISTS hangtag_webhook_source ON public.hangtag_stock_imports;
CREATE TRIGGER hangtag_webhook_source AFTER INSERT ON public.hangtag_stock_imports FOR EACH ROW EXECUTE FUNCTION public.hangtag_webhook_source();
DROP TRIGGER IF EXISTS hangtag_webhook_source ON public.hangtag_stock_moves;
CREATE TRIGGER hangtag_webhook_source AFTER INSERT ON public.hangtag_stock_moves FOR EACH ROW EXECUTE FUNCTION public.hangtag_webhook_source();
DROP TRIGGER IF EXISTS hangtag_webhook_source ON public.hangtag_customers;
CREATE TRIGGER hangtag_webhook_source AFTER INSERT ON public.hangtag_customers FOR EACH ROW EXECUTE FUNCTION public.hangtag_webhook_source();

-- The owner's controls. The secret is returned only by create and rotate.
CREATE OR REPLACE FUNCTION public.hangtag_webhook_create(p_url TEXT, p_events TEXT[], p_description TEXT DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE uid UUID := public.hangtag_shop_id(); e public.hangtag_webhook_endpoints; s TEXT := 'whsec_' || md5(gen_random_uuid()::TEXT) || md5(gen_random_uuid()::TEXT);
BEGIN
    IF auth.uid() IS NULL OR uid IS NULL OR uid <> auth.uid() THEN RAISE EXCEPTION 'Only the shop''s owner can set up webhooks.' USING ERRCODE = '42501'; END IF;
    IF (SELECT count(*) FROM public.hangtag_webhook_endpoints x WHERE x.owner_id = uid) >= 5 THEN RAISE EXCEPTION 'A shop can have up to 5 webhooks.' USING ERRCODE = 'check_violation'; END IF;
    INSERT INTO public.hangtag_webhook_endpoints (owner_id, url, events, description) VALUES (uid, btrim(p_url), p_events, NULLIF(left(btrim(COALESCE(p_description, '')), 80), ''))
    RETURNING * INTO e;
    INSERT INTO public.hangtag_webhook_secrets (endpoint_id, owner_id, secret) VALUES (e.id, uid, s);
    RETURN jsonb_build_object('ok', TRUE, 'endpoint', to_jsonb(e), 'secret', s);
END $$;
CREATE OR REPLACE FUNCTION public.hangtag_webhook_rotate(p_id UUID)
RETURNS JSONB LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE uid UUID := public.hangtag_shop_id(); s TEXT := 'whsec_' || md5(gen_random_uuid()::TEXT) || md5(gen_random_uuid()::TEXT);
BEGIN
    IF auth.uid() IS NULL OR uid IS NULL OR uid <> auth.uid() THEN RAISE EXCEPTION 'Only the shop''s owner can set up webhooks.' USING ERRCODE = '42501'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.hangtag_webhook_endpoints e WHERE e.owner_id = uid AND e.id = p_id) THEN RAISE EXCEPTION 'That webhook wasn''t found.' USING ERRCODE = '23503'; END IF;
    UPDATE public.hangtag_webhook_secrets SET secret = s, created_at = NOW() WHERE endpoint_id = p_id AND owner_id = uid;
    RETURN jsonb_build_object('ok', TRUE, 'secret', s);
END $$;
CREATE OR REPLACE FUNCTION public.hangtag_webhook_update(p_id UUID, p_url TEXT, p_events TEXT[], p_active BOOLEAN)
RETURNS JSONB LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE uid UUID := public.hangtag_shop_id(); e public.hangtag_webhook_endpoints;
BEGIN
    IF auth.uid() IS NULL OR uid IS NULL OR uid <> auth.uid() THEN RAISE EXCEPTION 'Only the shop''s owner can set up webhooks.' USING ERRCODE = '42501'; END IF;
    UPDATE public.hangtag_webhook_endpoints SET url = COALESCE(btrim(p_url), url), events = COALESCE(p_events, events), active = COALESCE(p_active, active), updated_at = NOW()
     WHERE owner_id = uid AND id = p_id RETURNING * INTO e;
    IF NOT FOUND THEN RAISE EXCEPTION 'That webhook wasn''t found.' USING ERRCODE = '23503'; END IF;
    RETURN jsonb_build_object('ok', TRUE, 'endpoint', to_jsonb(e));
END $$;
CREATE OR REPLACE FUNCTION public.hangtag_webhook_delete(p_id UUID)
RETURNS JSONB LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE uid UUID := public.hangtag_shop_id();
BEGIN
    IF auth.uid() IS NULL OR uid IS NULL OR uid <> auth.uid() THEN RAISE EXCEPTION 'Only the shop''s owner can set up webhooks.' USING ERRCODE = '42501'; END IF;
    DELETE FROM public.hangtag_webhook_endpoints WHERE owner_id = uid AND id = p_id;
    RETURN jsonb_build_object('ok', TRUE);
END $$;
-- A test delivery to one endpoint (its own event key, so it goes once per press)
CREATE OR REPLACE FUNCTION public.hangtag_webhook_test(p_id UUID)
RETURNS JSONB LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE uid UUID := public.hangtag_shop_id(); eid UUID;
BEGIN
    IF auth.uid() IS NULL OR uid IS NULL OR uid <> auth.uid() THEN RAISE EXCEPTION 'Only the shop''s owner can set up webhooks.' USING ERRCODE = '42501'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.hangtag_webhook_endpoints e WHERE e.owner_id = uid AND e.id = p_id) THEN RAISE EXCEPTION 'That webhook wasn''t found.' USING ERRCODE = '23503'; END IF;
    INSERT INTO public.hangtag_webhook_events (owner_id, type, event_key, payload) VALUES (uid, 'webhook.test', gen_random_uuid()::TEXT, jsonb_build_object('message', 'Hello from Hangtag'))
    RETURNING id INTO eid;
    INSERT INTO public.hangtag_webhook_deliveries (owner_id, endpoint_id, event_id) VALUES (uid, p_id, eid);
    RETURN jsonb_build_object('ok', TRUE, 'event', eid);
END $$;
-- For the dispatch function only (service role): due deliveries, leased for 2 minutes (a crashed run is retried), and the result.
CREATE OR REPLACE FUNCTION public.hangtag_webhook_claim(p_limit INT DEFAULT 20)
RETURNS TABLE (delivery_id UUID, owner_id UUID, endpoint_id UUID, url TEXT, secret TEXT, event_id UUID, type TEXT, payload JSONB, event_created_at TIMESTAMPTZ, attempts INT)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
BEGIN
    RETURN QUERY
    WITH due AS (
        SELECT d.owner_id AS o, d.id AS i FROM public.hangtag_webhook_deliveries d
         WHERE d.status IN ('pending','sending') AND d.next_attempt_at <= NOW()
         ORDER BY d.next_attempt_at LIMIT GREATEST(1, LEAST(p_limit, 100)) FOR UPDATE SKIP LOCKED)
    UPDATE public.hangtag_webhook_deliveries d SET status = 'sending', attempts = d.attempts + 1, next_attempt_at = NOW() + interval '2 minutes', updated_at = NOW()
      FROM due, public.hangtag_webhook_endpoints e, public.hangtag_webhook_secrets s, public.hangtag_webhook_events ev
     WHERE d.owner_id = due.o AND d.id = due.i AND e.id = d.endpoint_id AND e.active AND s.endpoint_id = e.id AND ev.id = d.event_id
    RETURNING d.id, d.owner_id, e.id, e.url, s.secret, ev.id, ev.type, ev.payload, ev.created_at, d.attempts;
END $$;
CREATE OR REPLACE FUNCTION public.hangtag_webhook_result(p_delivery UUID, p_status TEXT, p_http INT, p_error TEXT, p_retry_in INT)
RETURNS VOID LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE d public.hangtag_webhook_deliveries;
BEGIN
    IF p_status NOT IN ('delivered','pending','failed') THEN RAISE EXCEPTION 'Unknown delivery status.' USING ERRCODE = '22023'; END IF;
    UPDATE public.hangtag_webhook_deliveries x SET status = p_status, last_status = p_http, last_error = left(p_error, 300),
        next_attempt_at = CASE WHEN p_status = 'pending' THEN NOW() + make_interval(secs => GREATEST(30, COALESCE(p_retry_in, 60))) ELSE x.next_attempt_at END,
        delivered_at = CASE WHEN p_status = 'delivered' THEN NOW() ELSE x.delivered_at END, updated_at = NOW()
     WHERE x.id = p_delivery RETURNING * INTO d;
    IF FOUND THEN
        UPDATE public.hangtag_webhook_endpoints e SET last_success_at = CASE WHEN p_status = 'delivered' THEN NOW() ELSE e.last_success_at END,
            last_failure_at = CASE WHEN p_status <> 'delivered' THEN NOW() ELSE e.last_failure_at END WHERE e.id = d.endpoint_id;
    END IF;
END $$;
REVOKE ALL ON FUNCTION public.hangtag_webhook_emit(UUID,TEXT,TEXT,JSONB), public.hangtag_webhook_source(), public.hangtag_webhook_claim(INT),
    public.hangtag_webhook_result(UUID,TEXT,INT,TEXT,INT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.hangtag_webhook_create(TEXT,TEXT[],TEXT), public.hangtag_webhook_rotate(UUID), public.hangtag_webhook_update(UUID,TEXT,TEXT[],BOOLEAN),
    public.hangtag_webhook_delete(UUID), public.hangtag_webhook_test(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.hangtag_webhook_create(TEXT,TEXT[],TEXT), public.hangtag_webhook_rotate(UUID), public.hangtag_webhook_update(UUID,TEXT,TEXT[],BOOLEAN),
    public.hangtag_webhook_delete(UUID), public.hangtag_webhook_test(UUID) TO authenticated;
DO $$ BEGIN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.hangtag_webhook_claim(INT), public.hangtag_webhook_result(UUID,TEXT,INT,TEXT,INT) TO service_role';
EXCEPTION WHEN undefined_object THEN NULL;   -- a database without the service role (tests)
END $$;

-- (j) Who may use them (row security: section 5). Tables written only through the functions above are read-only here;
--     the webhook secrets are readable by nobody but the service role.
REVOKE ALL ON TABLE public.hangtag_price_lists, public.hangtag_purchase_orders, public.hangtag_einvoices, public.hangtag_eway_bills, public.hangtag_repacks,
    public.hangtag_vouchers, public.hangtag_voucher_redemptions, public.hangtag_webhook_endpoints, public.hangtag_webhook_secrets, public.hangtag_webhook_events,
    public.hangtag_webhook_deliveries FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.hangtag_price_lists TO authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.hangtag_einvoices, public.hangtag_eway_bills TO authenticated;
GRANT SELECT ON TABLE public.hangtag_purchase_orders, public.hangtag_repacks, public.hangtag_vouchers, public.hangtag_voucher_redemptions,
    public.hangtag_webhook_endpoints, public.hangtag_webhook_events, public.hangtag_webhook_deliveries TO authenticated;
ALTER TABLE public.hangtag_webhook_secrets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON FUNCTION public.hangtag_bundle_check(), public.hangtag_check_order_fulfilment(), public.hangtag_compliance_check(), public.hangtag_po_next_ok(TEXT,TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.hangtag_po_next_ok(TEXT,TEXT) TO authenticated;
-- What changed in this batch's records (a team member's phone polls it like hangtag_order_changes)
CREATE OR REPLACE FUNCTION public.hangtag_biz_changes()
RETURNS JSONB LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
    SELECT jsonb_build_object(
        'lists', (SELECT count(*) || ':' || COALESCE(sum(hashtext(l.id || '|' || l.updated_at::TEXT)), 0) FROM public.hangtag_price_lists l),
        'pos', (SELECT count(*) || ':' || COALESCE(sum(hashtext(p.id || '|' || p.version::TEXT)), 0) FROM public.hangtag_purchase_orders p),
        'vouchers', (SELECT count(*) || ':' || COALESCE(sum(hashtext(v.id || '|' || v.updated_at::TEXT)), 0) FROM public.hangtag_vouchers v),
        'gst', (SELECT count(*) || ':' || COALESCE(sum(hashtext(e.sale_id || '|' || e.updated_at::TEXT)), 0) FROM public.hangtag_einvoices e)
            || '/' || (SELECT count(*) || ':' || COALESCE(sum(hashtext(w.sale_id || '|' || w.updated_at::TEXT)), 0) FROM public.hangtag_eway_bills w))
$$;
REVOKE ALL ON FUNCTION public.hangtag_biz_changes() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.hangtag_biz_changes() TO authenticated;

-- ------------------------------------------------------------------------------
-- Row security for the tables above (the same rules section 5 of schema.sql writes)
-- ------------------------------------------------------------------------------
DO $$
DECLARE
    r RECORD; rd TEXT; shop CONSTANT TEXT := 'owner_id = (SELECT public.hangtag_shop_id())'; any_of TEXT; ops TEXT[]; w TEXT[]; i INT;
BEGIN
    FOR r IN SELECT * FROM (VALUES
        ('hangtag_price_lists',     '',                                             'manage_products'),
        ('hangtag_purchase_orders', 'create_purchase,manage_inventory,view_reports','-'),
        ('hangtag_einvoices',       'create_sale,view_reports',                     'create_sale,view_reports|create_sale,view_reports|owner'),
        ('hangtag_eway_bills',      'create_sale,view_reports',                     'create_sale,view_reports|create_sale,view_reports|owner'),
        ('hangtag_repacks',         'manage_inventory,view_reports',                '-'),
        ('hangtag_vouchers',        'create_sale,view_reports',                     '-'),
        ('hangtag_voucher_redemptions','create_sale,view_reports',                  '-'),
        ('hangtag_webhook_endpoints', NULL,                                         NULL),
        ('hangtag_webhook_events',  NULL,                                           NULL),
        ('hangtag_webhook_deliveries', NULL,                                        NULL)
    ) AS x(t, rd, wr) LOOP
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', r.t);
        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'Shop read', r.t);
        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'Shop write (add)', r.t);
        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'Shop write (change)', r.t);
        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'Shop write (remove)', r.t);
        CONTINUE WHEN r.rd IS NULL;
        SELECT string_agg(format('(SELECT public.hangtag_can(%L))', p), ' OR ') INTO any_of FROM unnest(string_to_array(NULLIF(r.rd, ''), ',')) p;
        rd := shop || COALESCE(' AND (' || any_of || ')', '');
        EXECUTE format('CREATE POLICY "Shop read" ON public.%I FOR SELECT TO authenticated USING (%s)', r.t, rd);
        CONTINUE WHEN r.wr = '-';
        ops := string_to_array(r.wr, '|');
        IF array_length(ops, 1) = 1 THEN ops := ARRAY[ops[1], ops[1], ops[1]]; END IF;
        w := ARRAY[]::TEXT[];
        FOR i IN 1..3 LOOP
            IF ops[i] = 'owner' THEN w := w || (shop || ' AND (SELECT public.hangtag_role()) = ''owner''');
            ELSE
                SELECT string_agg(format('(SELECT public.hangtag_can(%L))', p), ' OR ') INTO any_of FROM unnest(string_to_array(ops[i], ',')) p;
                w := w || (shop || ' AND (' || any_of || ')');
            END IF;
        END LOOP;
        EXECUTE format('CREATE POLICY "Shop write (add)" ON public.%I FOR INSERT TO authenticated WITH CHECK (%s)', r.t, w[1]);
        EXECUTE format('CREATE POLICY "Shop write (change)" ON public.%I FOR UPDATE TO authenticated USING (%s) WITH CHECK (%s)', r.t, w[2], w[2]);
        EXECUTE format('CREATE POLICY "Shop write (remove)" ON public.%I FOR DELETE TO authenticated USING (%s)', r.t, w[3]);
    END LOOP;
END $$;
CREATE POLICY "Shop read" ON public.hangtag_webhook_endpoints FOR SELECT TO authenticated
    USING (owner_id = (SELECT public.hangtag_shop_id()) AND (SELECT public.hangtag_role()) = 'owner');
CREATE POLICY "Shop read" ON public.hangtag_webhook_events FOR SELECT TO authenticated
    USING (owner_id = (SELECT public.hangtag_shop_id()) AND (SELECT public.hangtag_role()) = 'owner');
CREATE POLICY "Shop read" ON public.hangtag_webhook_deliveries FOR SELECT TO authenticated
    USING (owner_id = (SELECT public.hangtag_shop_id()) AND (SELECT public.hangtag_role()) = 'owner');
-- Live updates between the shop's own devices (schema.sql section 6)
DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['hangtag_price_lists','hangtag_purchase_orders','hangtag_vouchers','hangtag_einvoices','hangtag_eway_bills'] LOOP
        BEGIN EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t); EXCEPTION WHEN OTHERS THEN NULL; END;
    END LOOP;
END $$;
