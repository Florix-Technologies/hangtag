-- ==============================================================================
-- Hangtag: the shop's own product fields and units (schema.sql section 3z)
--   fields of any kind on products (Wattage, Material, Pressing year…) with their choices and rules, and units Hangtag
--   doesn't have (Roll, Sq ft…), added by the shop with no change to the database for each one
--
-- For the live database that supabase/schema.sql builds (the hangtag_* tables). It needs everything up to section 3t
-- (plans and the plan-ended guard) already applied: run supabase/schema.sql once, or run this file after it. Safe to run again.
-- It is exactly section 3z of schema.sql plus the row security rules and grants section 5 gives these tables.
-- Requires: supabase/schema.sql (applied first)
-- Run it in the Supabase SQL Editor. Then the report at the end of schema.sql: rows 36 and 91-93.
-- ==============================================================================

-- ==============================================================================
-- 3z. The shop's own product fields and units: any kind of product, described in the shop's own words, with no change to
--     the database for a new field or unit
--   hangtag_attributes: one row per field (Wattage, Material, Pressing year…): its name (unique among the fields in use),
--   kind (text, whole number, decimal, date, yes/no, one choice, several choices), its choices, its rules (required, lowest,
--   highest, decimals, the unit after a number, longest text) and the categories it is for (none: every product).
--   A product keeps its values in hangtag_products.attrs { field id: value }, each checked here against the kind of its
--   field; a value for an archived field stays. A field in use keeps its kind and isn't removed (it is archived instead).
--   A product option can take its values from a field (options.opts[].attr: the field's id).
--   What money and stock depend on keeps its own columns and records (price, cost, stock, SKU, barcode, unit, GST, HSN,
--   serial numbers, batches, expiry dates); the app refuses a field named after one of them.
--   hangtag_units: the shop's own units (code: what follows a quantity, e.g. roll or sqft; name; decimals; GST unit code).
--   Products and bill, return and order lines take any unit code (Hangtag's nine, or the shop's own); the app keeps each
--   quantity to its unit's decimals, and so does the database for supplier bills, quotations and orders, and the online
--   store (hangtag_unit_decimals). A unit in use isn't removed (it is archived) and keeps its decimals.
-- ==============================================================================
CREATE TABLE IF NOT EXISTS public.hangtag_attributes (
    owner_id UUID NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
    id TEXT NOT NULL CHECK (id ~ '^[A-Za-z0-9_-]{1,40}$'),
    name TEXT NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 32 AND btrim(name) !~ '^#'),
    type TEXT NOT NULL CHECK (type IN ('text', 'number', 'decimal', 'date', 'yesno', 'choice', 'multi')),
    options JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(options) = 'array' AND jsonb_array_length(options) <= 100),
    rules JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(rules) = 'object'),
    categories JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(categories) = 'array' AND jsonb_array_length(categories) <= 50),
    archived BOOLEAN NOT NULL DEFAULT FALSE,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (owner_id, id)
);
-- one field of a name among those in use (any case and spacing)
CREATE UNIQUE INDEX IF NOT EXISTS uq_hangtag_attributes_name ON public.hangtag_attributes (owner_id, lower(regexp_replace(btrim(name), '\s+', ' ', 'g'))) WHERE NOT archived;

CREATE TABLE IF NOT EXISTS public.hangtag_units (
    owner_id UUID NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
    id TEXT NOT NULL CHECK (id ~ '^[a-z][a-z0-9]{0,11}$' AND id NOT IN ('pcs', 'box', 'pack', 'dozen', 'kg', 'g', 'l', 'ml', 'm')),
    label TEXT NOT NULL CHECK (char_length(btrim(label)) BETWEEN 1 AND 20),
    decimals SMALLINT NOT NULL DEFAULT 0 CHECK (decimals BETWEEN 0 AND 3),
    kind TEXT NOT NULL DEFAULT 'count' CHECK (kind IN ('count', 'measure')),
    uqc TEXT NOT NULL DEFAULT 'OTH' CHECK (uqc IN ('PCS', 'NOS', 'UNT', 'SET', 'PRS', 'DOZ', 'BOX', 'PAC', 'BAG', 'BAL', 'BDL', 'BKL', 'BOU', 'BTL', 'BUN', 'CAN',
        'CTN', 'DRM', 'GGK', 'GRS', 'ROL', 'TBS', 'TUB', 'THD', 'KGS', 'GMS', 'TGM', 'QTL', 'TON', 'MTS', 'LTR', 'MLT', 'KLR', 'CBM', 'CCM', 'MTR', 'CMS', 'KME',
        'YDS', 'GYD', 'SQF', 'SQM', 'SQY', 'UGS', 'OTH')),
    archived BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (owner_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_hangtag_units_label ON public.hangtag_units (owner_id, lower(regexp_replace(btrim(label), '\s+', ' ', 'g'))) WHERE NOT archived;
-- A product's values for the shop's fields: { field id: value } (checked by hangtag_product_attrs_check below)
ALTER TABLE public.hangtag_products ADD COLUMN IF NOT EXISTS attrs JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE public.hangtag_products DROP CONSTRAINT IF EXISTS hangtag_products_attrs_check;
ALTER TABLE public.hangtag_products ADD CONSTRAINT hangtag_products_attrs_check CHECK (jsonb_typeof(attrs) = 'object');

-- Is the text a real day, written yyyy-mm-dd?
CREATE OR REPLACE FUNCTION public.hangtag_is_day(p TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
BEGIN
    RETURN p ~ '^\d{4}-\d{2}-\d{2}$' AND to_char(p::date, 'YYYY-MM-DD') = p;
EXCEPTION WHEN OTHERS THEN
    RETURN FALSE;
END $$;
-- Does any product of the shop use the field (a value, or an option taking its values from it)?
CREATE OR REPLACE FUNCTION public.hangtag_attribute_used(p_owner UUID, p_id TEXT)
RETURNS BOOLEAN LANGUAGE sql STABLE SET search_path = '' AS $$
    SELECT EXISTS (SELECT 1 FROM public.hangtag_products p WHERE p.owner_id = p_owner
        AND (p.attrs ? p_id OR (jsonb_typeof(p.options -> 'opts') = 'array'
            AND EXISTS (SELECT 1 FROM jsonb_array_elements(p.options -> 'opts') o WHERE o ->> 'attr' = p_id))))
$$;

-- A field as saved: choices only for a field with choices (1 to 40 characters each, never twice), only the known rules,
-- each of its kind; no change of kind while products use it; at most 60 fields in use
CREATE OR REPLACE FUNCTION public.hangtag_attribute_check()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
    r JSONB := NEW.rules;
    o JSONB;
    t TEXT;
    seen TEXT[] := ARRAY[]::TEXT[];
BEGIN
    NEW.name := regexp_replace(btrim(NEW.name), '\s+', ' ', 'g');
    IF NEW.type IN ('choice', 'multi') THEN
        IF jsonb_array_length(NEW.options) = 0 THEN
            RAISE EXCEPTION 'The field % needs at least one choice', NEW.name USING ERRCODE = 'check_violation';
        END IF;
        FOR o IN SELECT e.value FROM jsonb_array_elements(NEW.options) e LOOP
            t := CASE WHEN jsonb_typeof(o) = 'string' THEN btrim(o #>> '{}') END;
            IF t IS NULL OR char_length(t) NOT BETWEEN 1 AND 40 THEN
                RAISE EXCEPTION 'The field %: each choice is text of 1 to 40 characters', NEW.name USING ERRCODE = 'check_violation';
            END IF;
            IF lower(t) = ANY (seen) THEN
                RAISE EXCEPTION 'The field % has the choice % twice', NEW.name, t USING ERRCODE = 'check_violation';
            END IF;
            seen := seen || lower(t);
        END LOOP;
    ELSIF jsonb_array_length(NEW.options) > 0 THEN
        RAISE EXCEPTION 'Only a field with choices has choices (%)', NEW.name USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_object_keys(r) k WHERE k NOT IN ('required', 'min', 'max', 'dp', 'unit', 'maxLen'))
       OR (r ? 'required' AND jsonb_typeof(r -> 'required') <> 'boolean')
       OR (r ? 'min' AND jsonb_typeof(r -> 'min') NOT IN ('number', 'null'))
       OR (r ? 'max' AND jsonb_typeof(r -> 'max') NOT IN ('number', 'null'))
       OR (jsonb_typeof(r -> 'min') = 'number' AND jsonb_typeof(r -> 'max') = 'number' AND (r ->> 'min')::NUMERIC > (r ->> 'max')::NUMERIC)
       OR (r ? 'dp' AND jsonb_typeof(r -> 'dp') <> 'null' AND (jsonb_typeof(r -> 'dp') <> 'number' OR (r ->> 'dp')::NUMERIC NOT IN (0, 1, 2, 3, 4)))
       OR (r ? 'unit' AND jsonb_typeof(r -> 'unit') <> 'null' AND (jsonb_typeof(r -> 'unit') <> 'string' OR char_length(r ->> 'unit') > 12))
       OR (r ? 'maxLen' AND jsonb_typeof(r -> 'maxLen') <> 'null' AND (jsonb_typeof(r -> 'maxLen') <> 'number'
           OR (r ->> 'maxLen')::NUMERIC NOT BETWEEN 1 AND 300 OR (r ->> 'maxLen')::NUMERIC <> trunc((r ->> 'maxLen')::NUMERIC))) THEN
        RAISE EXCEPTION 'The rules of the field % aren''t right (required, lowest, highest, decimals, unit, longest text)', NEW.name USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.categories) c WHERE jsonb_typeof(c) <> 'string' OR char_length(btrim(c #>> '{}')) NOT BETWEEN 1 AND 40) THEN
        RAISE EXCEPTION 'The field %: categories are names of 1 to 40 characters', NEW.name USING ERRCODE = 'check_violation';
    END IF;
    IF TG_OP = 'UPDATE' AND NEW.type <> OLD.type AND public.hangtag_attribute_used(NEW.owner_id, NEW.id) THEN
        RAISE EXCEPTION 'The field % is used by products, so its kind can''t change', OLD.name USING ERRCODE = 'check_violation';
    END IF;
    IF NOT NEW.archived AND (TG_OP = 'INSERT' OR OLD.archived)
       AND (SELECT count(*) FROM public.hangtag_attributes a WHERE a.owner_id = NEW.owner_id AND NOT a.archived AND a.id <> NEW.id) >= 60 THEN
        RAISE EXCEPTION 'A shop can have up to 60 fields in use' USING ERRCODE = 'check_violation';
    END IF;
    NEW.updated_at := NOW();
    RETURN NEW;
END $$;
-- A field products use is archived, not removed (its values stay with the products). Removed with the account: allowed.
CREATE OR REPLACE FUNCTION public.hangtag_attribute_delete_check()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
    IF pg_trigger_depth() = 1 AND public.hangtag_attribute_used(OLD.owner_id, OLD.id) THEN
        RAISE EXCEPTION 'The field % is used by products: archive it instead', OLD.name USING ERRCODE = 'foreign_key_violation';
    END IF;
    RETURN OLD;
END $$;
DROP TRIGGER IF EXISTS hangtag_attribute_check ON public.hangtag_attributes;
CREATE TRIGGER hangtag_attribute_check BEFORE INSERT OR UPDATE ON public.hangtag_attributes FOR EACH ROW EXECUTE FUNCTION public.hangtag_attribute_check();
DROP TRIGGER IF EXISTS hangtag_attribute_delete_check ON public.hangtag_attributes;
CREATE TRIGGER hangtag_attribute_delete_check BEFORE DELETE ON public.hangtag_attributes FOR EACH ROW EXECUTE FUNCTION public.hangtag_attribute_delete_check();

-- A unit as saved: tidy name; one products use keeps its decimals and isn't removed (archive it). Removed with the account: allowed.
CREATE OR REPLACE FUNCTION public.hangtag_unit_guard()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF pg_trigger_depth() = 1 AND EXISTS (SELECT 1 FROM public.hangtag_products p WHERE p.owner_id = OLD.owner_id AND p.unit = OLD.id) THEN
            RAISE EXCEPTION 'The unit % is used by products: archive it instead', OLD.label USING ERRCODE = 'foreign_key_violation';
        END IF;
        RETURN OLD;
    END IF;
    NEW.label := regexp_replace(btrim(NEW.label), '\s+', ' ', 'g');
    IF TG_OP = 'UPDATE' AND NEW.decimals <> OLD.decimals
       AND EXISTS (SELECT 1 FROM public.hangtag_products p WHERE p.owner_id = NEW.owner_id AND p.unit = NEW.id) THEN
        RAISE EXCEPTION 'The unit % is used by products, so its decimals can''t change', OLD.label USING ERRCODE = 'check_violation';
    END IF;
    NEW.updated_at := NOW();
    RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS hangtag_unit_guard ON public.hangtag_units;
CREATE TRIGGER hangtag_unit_guard BEFORE INSERT OR UPDATE OR DELETE ON public.hangtag_units FOR EACH ROW EXECUTE FUNCTION public.hangtag_unit_guard();

-- A product's values for the shop's fields, each of the kind of its field (the app also checks choices, limits and
-- required fields); options that take their values from a field name one the shop has
CREATE OR REPLACE FUNCTION public.hangtag_product_attrs_check()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
    k TEXT;
    v JSONB;
    a RECORD;
    o JSONB;
    ok BOOLEAN;
BEGIN
    IF TG_OP = 'UPDATE' AND NEW.attrs IS NOT DISTINCT FROM OLD.attrs AND NEW.options IS NOT DISTINCT FROM OLD.options THEN
        RETURN NEW;
    END IF;
    IF jsonb_typeof(NEW.attrs) IS DISTINCT FROM 'object' THEN
        RAISE EXCEPTION 'Product %: its field values are { field: value } (attrs_check)', NEW.name USING ERRCODE = 'check_violation';
    END IF;
    IF (SELECT count(*) FROM jsonb_object_keys(NEW.attrs)) > 60 THEN
        RAISE EXCEPTION 'A product can have up to 60 field values (%)', NEW.name USING ERRCODE = 'check_violation';
    END IF;
    FOR k, v IN SELECT e.key, e.value FROM jsonb_each(NEW.attrs) e LOOP
        SELECT x.name, x.type INTO a FROM public.hangtag_attributes x WHERE x.owner_id = NEW.owner_id AND x.id = k;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Product % has a value for a field the shop doesn''t have (%)', NEW.name, k USING ERRCODE = 'foreign_key_violation';
        END IF;
        ok := CASE a.type
            WHEN 'text' THEN jsonb_typeof(v) = 'string' AND char_length(v #>> '{}') BETWEEN 1 AND 300
            WHEN 'number' THEN jsonb_typeof(v) = 'number' AND (v #>> '{}')::NUMERIC = trunc((v #>> '{}')::NUMERIC) AND abs((v #>> '{}')::NUMERIC) <= 1e12
            WHEN 'decimal' THEN jsonb_typeof(v) = 'number' AND abs((v #>> '{}')::NUMERIC) <= 1e12
            WHEN 'date' THEN jsonb_typeof(v) = 'string' AND public.hangtag_is_day(v #>> '{}')
            WHEN 'yesno' THEN jsonb_typeof(v) = 'boolean'
            WHEN 'choice' THEN jsonb_typeof(v) = 'string' AND char_length(v #>> '{}') BETWEEN 1 AND 40
            WHEN 'multi' THEN jsonb_typeof(v) = 'array' AND jsonb_array_length(v) BETWEEN 1 AND 100
                AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v) e WHERE jsonb_typeof(e) <> 'string' OR char_length(e #>> '{}') NOT BETWEEN 1 AND 40)
            ELSE FALSE END;
        IF NOT ok THEN
            RAISE EXCEPTION 'Product %: the value of % isn''t right for a field of kind %', NEW.name, a.name, a.type USING ERRCODE = 'check_violation';
        END IF;
    END LOOP;
    IF jsonb_typeof(NEW.options -> 'opts') = 'array' THEN
        FOR o IN SELECT e.value FROM jsonb_array_elements(NEW.options -> 'opts') e LOOP
            IF jsonb_typeof(o) = 'object' AND jsonb_typeof(o -> 'attr') = 'string'
               AND NOT EXISTS (SELECT 1 FROM public.hangtag_attributes x WHERE x.owner_id = NEW.owner_id AND x.id = o ->> 'attr') THEN
                RAISE EXCEPTION 'Product %: an option takes its values from a field the shop doesn''t have (%)', NEW.name, o ->> 'attr' USING ERRCODE = 'foreign_key_violation';
            END IF;
        END LOOP;
    END IF;
    RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS hangtag_product_attrs_check ON public.hangtag_products;
CREATE TRIGGER hangtag_product_attrs_check BEFORE INSERT OR UPDATE OF attrs, options ON public.hangtag_products
    FOR EACH ROW EXECUTE FUNCTION public.hangtag_product_attrs_check();
REVOKE ALL ON FUNCTION public.hangtag_attribute_check(), public.hangtag_attribute_delete_check(), public.hangtag_unit_guard(),
    public.hangtag_product_attrs_check() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.hangtag_is_day(TEXT), public.hangtag_attribute_used(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.hangtag_is_day(TEXT), public.hangtag_attribute_used(UUID, TEXT) TO authenticated;

-- Units: any unit code on products and on bill, return and order lines (Hangtag's nine, or one of the shop's own)
ALTER TABLE public.hangtag_products DROP CONSTRAINT IF EXISTS hangtag_products_unit_check;
ALTER TABLE public.hangtag_products ADD CONSTRAINT hangtag_products_unit_check CHECK (unit ~ '^[a-z][a-z0-9]{0,11}$');
ALTER TABLE public.hangtag_sale_items DROP CONSTRAINT IF EXISTS hangtag_sale_items_unit_check;
ALTER TABLE public.hangtag_sale_items ADD CONSTRAINT hangtag_sale_items_unit_check CHECK (unit IS NULL OR unit ~ '^[a-z][a-z0-9]{0,11}$') NOT VALID;
ALTER TABLE public.hangtag_return_items DROP CONSTRAINT IF EXISTS hangtag_return_items_unit_check;
ALTER TABLE public.hangtag_return_items ADD CONSTRAINT hangtag_return_items_unit_check CHECK (unit IS NULL OR unit ~ '^[a-z][a-z0-9]{0,11}$') NOT VALID;
ALTER TABLE public.hangtag_order_items DROP CONSTRAINT IF EXISTS hangtag_order_items_unit_check;
ALTER TABLE public.hangtag_order_items ADD CONSTRAINT hangtag_order_items_unit_check CHECK (unit ~ '^[a-z][a-z0-9]{0,11}$') NOT VALID;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.hangtag_attributes, public.hangtag_units TO authenticated;
REVOKE ALL ON TABLE public.hangtag_attributes, public.hangtag_units FROM anon;
-- When the shop's plan has ended, its fields and units wait like every business record (section 3t's guard; that section
-- puts it only on the tables that existed before it)
DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['hangtag_attributes', 'hangtag_units'] LOOP
        EXECUTE format('DROP TRIGGER IF EXISTS zz_hangtag_subscription_guard ON public.%I', t);
        EXECUTE format('CREATE TRIGGER zz_hangtag_subscription_guard BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.hangtag_subscription_guard()', t);
    END LOOP;
END $$;

-- What changed in the commerce batch's records, now with the shop's fields and units (a team member's phone polls it)
CREATE OR REPLACE FUNCTION public.hangtag_biz_changes()
RETURNS JSONB LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
    SELECT jsonb_build_object(
        'lists', (SELECT count(*) || ':' || COALESCE(sum(hashtext(l.id || '|' || l.updated_at::TEXT)), 0) FROM public.hangtag_price_lists l),
        'pos', (SELECT count(*) || ':' || COALESCE(sum(hashtext(p.id || '|' || p.version::TEXT)), 0) FROM public.hangtag_purchase_orders p),
        'vouchers', (SELECT count(*) || ':' || COALESCE(sum(hashtext(v.id || '|' || v.updated_at::TEXT)), 0) FROM public.hangtag_vouchers v),
        'gst', (SELECT count(*) || ':' || COALESCE(sum(hashtext(e.sale_id || '|' || e.updated_at::TEXT)), 0) FROM public.hangtag_einvoices e)
            || '/' || (SELECT count(*) || ':' || COALESCE(sum(hashtext(w.sale_id || '|' || w.updated_at::TEXT)), 0) FROM public.hangtag_eway_bills w),
        'fields', (SELECT count(*) || ':' || COALESCE(sum(hashtext(a.id || '|' || a.updated_at::TEXT)), 0) FROM public.hangtag_attributes a),
        'units', (SELECT count(*) || ':' || COALESCE(sum(hashtext(u.id || '|' || u.updated_at::TEXT)), 0) FROM public.hangtag_units u))
$$;
REVOKE ALL ON FUNCTION public.hangtag_biz_changes() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.hangtag_biz_changes() TO authenticated;

-- How many decimal places a quantity in a unit may have: Hangtag's nine as the app keeps them, the shop's own unit as
-- saved (an archived one too: it keeps its decimals), 3 for a code the shop never made (as the app reads one)
CREATE OR REPLACE FUNCTION public.hangtag_unit_decimals(p_owner UUID, p_unit TEXT)
RETURNS INT LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
    SELECT CASE WHEN p_unit IN ('pcs', 'box', 'pack', 'dozen', 'g', 'ml') THEN 0 WHEN p_unit IN ('kg', 'l') THEN 3 WHEN p_unit = 'm' THEN 2
        ELSE COALESCE((SELECT u.decimals::INT FROM public.hangtag_units u WHERE u.owner_id = p_owner AND u.id = p_unit), 3) END
$$;
REVOKE ALL ON FUNCTION public.hangtag_unit_decimals(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.hangtag_unit_decimals(UUID, TEXT) TO authenticated;

-- Quotations and orders (section 3p), supplier bills (3p) and the online store (3r) keep each quantity to its unit's
-- decimals, the shop's own units included: 2.5 sq ft can be bought and sold, 2.5 rolls can't. Before, the database knew
-- only Hangtag's units (a supplier bill and the store took the shop's own as whole numbers; an order didn't check them).
-- Otherwise exactly as those sections define them.
CREATE OR REPLACE FUNCTION public.hangtag_save_order(p_order JSONB, p_items JSONB)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    uid UUID := public.hangtag_shop_id(); o public.hangtag_orders; cur public.hangtag_orders;
    base INT := COALESCE(NULLIF(p_order ->> 'version', '')::INT, 0);
    fp TEXT := md5((COALESCE(p_order, '{}'::jsonb) - 'version' - 'updated_t')::text || '|' || COALESCE(p_items, '[]'::jsonb)::text);
    ver INT; n INT;
BEGIN
    IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Sign in to save orders.' USING ERRCODE = '42501'; END IF;
    IF uid IS NULL OR NOT public.hangtag_can('create_order') THEN RAISE EXCEPTION 'Not allowed to save orders.' USING ERRCODE = '42501'; END IF;
    o := jsonb_populate_record(NULL::public.hangtag_orders, p_order);
    IF COALESCE(o.id, '') = '' THEN RAISE EXCEPTION 'An order has no id.' USING ERRCODE = '22023'; END IF;
    IF o.kind = 'quote' AND NOT public.hangtag_cap_on(uid, 'uses_quotations') THEN RAISE EXCEPTION 'Quotations are switched off for this shop.' USING ERRCODE = '42501'; END IF;
    IF o.kind = 'sales' AND NOT public.hangtag_cap_on(uid, 'uses_sales_orders') THEN RAISE EXCEPTION 'Sales orders are switched off for this shop.' USING ERRCODE = '42501'; END IF;
    IF o.kind = 'table' AND NOT public.hangtag_cap_on(uid, 'uses_tables') THEN RAISE EXCEPTION 'Table ordering is switched off for this shop.' USING ERRCODE = '42501'; END IF;
    IF o.kind <> 'table' AND (o.customer_id IS NULL OR COALESCE(btrim(o.customer ->> 'name'), '') = '') THEN RAISE EXCEPTION 'Choose the customer.' USING ERRCODE = 'check_violation'; END IF;
    IF o.quote_id IS NOT NULL AND (o.kind <> 'sales' OR NOT EXISTS (SELECT 1 FROM public.hangtag_orders q WHERE q.owner_id = uid AND q.id = o.quote_id AND q.kind = 'quote')) THEN
        RAISE EXCEPTION 'The source quotation was not found in this shop.' USING ERRCODE = 'foreign_key_violation';
    END IF;
    IF jsonb_typeof(COALESCE(p_items, '[]'::jsonb)) <> 'array' OR jsonb_array_length(COALESCE(p_items, '[]'::jsonb)) = 0 THEN RAISE EXCEPTION 'An order needs at least one line.' USING ERRCODE = 'check_violation'; END IF;
    IF EXISTS (SELECT 1 FROM jsonb_populate_recordset(NULL::public.hangtag_order_items, p_items) i
        WHERE i.qty <= 0 OR i.qty <> round(i.qty, public.hangtag_unit_decimals(uid, COALESCE(i.unit, 'pcs')))) THEN
        RAISE EXCEPTION 'An order line has a quantity its unit cannot use.' USING ERRCODE = 'check_violation';
    END IF;
    SELECT * INTO cur FROM public.hangtag_orders x WHERE x.owner_id = uid AND x.id = o.id FOR UPDATE;
    IF FOUND THEN
        IF cur.version <> base THEN
            IF cur.version = base + 1 AND cur.save_hash = fp THEN RETURN jsonb_build_object('status', 'saved', 'order', cur.id, 'version', cur.version,
                'lines', (SELECT count(*) FROM public.hangtag_order_items i WHERE i.owner_id = uid AND i.order_id = cur.id)); END IF;
            RAISE EXCEPTION 'Order % was changed on another device (this phone had version %, the cloud has %). Discard this change and open the order again.',
                COALESCE(cur.no, cur.id), base, cur.version USING ERRCODE = '40001';
        END IF;
        IF o.kind IS DISTINCT FROM cur.kind THEN RAISE EXCEPTION 'An order can''t change its kind.' USING ERRCODE = 'check_violation'; END IF;
        IF cur.status IN ('cancelled','converted','completed','served') THEN RAISE EXCEPTION 'Order % is % and can''t be changed.', COALESCE(cur.no, cur.id), cur.status USING ERRCODE = 'check_violation'; END IF;
        IF NOT public.hangtag_order_next_ok(cur.kind, cur.status, o.status) THEN RAISE EXCEPTION 'An order that is % can''t become %.', cur.status, o.status USING ERRCODE = 'check_violation'; END IF;
        IF EXISTS (SELECT 1 FROM public.hangtag_order_items i LEFT JOIN jsonb_populate_recordset(NULL::public.hangtag_order_items, p_items) x ON x.line_no = i.line_no
            WHERE i.owner_id = uid AND i.order_id = cur.id AND i.fulfilled_qty > 0 AND COALESCE(x.fulfilled_qty, 0) < i.fulfilled_qty) THEN
            RAISE EXCEPTION 'What was already delivered on order % can''t be taken off it.', COALESCE(cur.no, cur.id) USING ERRCODE = 'check_violation';
        END IF;
        ver := cur.version + 1;
        UPDATE public.hangtag_orders SET no=o.no,status=o.status,customer_id=o.customer_id,customer=o.customer,bill_disc=o.bill_disc,
            notes=o.notes,terms=o.terms,valid_until=o.valid_until,table_id=o.table_id,session_id=o.session_id,converted_to=o.converted_to,
            quote_id=o.quote_id,quote_no=o.quote_no,total=o.total,sale_ids=COALESCE(o.sale_ids,'{}'),version=ver,updated_t=o.updated_t,
            device_id=o.device_id,save_hash=fp,updated_at=NOW() WHERE owner_id=uid AND id=cur.id;
    ELSE
        IF base <> 0 THEN RAISE EXCEPTION 'Order % is no longer in the cloud. Discard this change.', COALESCE(o.no,o.id) USING ERRCODE = '40001'; END IF;
        ver := 1;
        INSERT INTO public.hangtag_orders (owner_id,id,kind,no,status,customer_id,customer,bill_disc,notes,terms,valid_until,table_id,session_id,
            source,converted_to,quote_id,quote_no,total,sale_ids,version,t,updated_t,device_id,user_id,save_hash)
        VALUES (uid,o.id,o.kind,o.no,o.status,o.customer_id,o.customer,o.bill_disc,o.notes,o.terms,o.valid_until,o.table_id,o.session_id,
            COALESCE(o.source,'staff'),o.converted_to,o.quote_id,o.quote_no,o.total,COALESCE(o.sale_ids,'{}'),ver,
            COALESCE(o.t,(extract(epoch FROM now())*1000)::BIGINT),o.updated_t,o.device_id,auth.uid(),fp);
    END IF;
    DELETE FROM public.hangtag_order_items i WHERE i.owner_id=uid AND i.order_id=o.id
       AND i.line_no NOT IN (SELECT (y->>'line_no')::INT FROM jsonb_array_elements(p_items) y);
    INSERT INTO public.hangtag_order_items (owner_id,order_id,line_no,product_id,variant_id,name,variant_label,unit,qty,price,disc,gst_rate,note,fulfilled_qty,serials)
    SELECT uid,o.id,i.line_no,i.product_id,i.variant_id,i.name,i.variant_label,COALESCE(i.unit,'pcs'),i.qty,COALESCE(i.price,0),i.disc,i.gst_rate,i.note,COALESCE(i.fulfilled_qty,0),i.serials
      FROM jsonb_populate_recordset(NULL::public.hangtag_order_items,p_items) i
    ON CONFLICT (owner_id,order_id,line_no) DO UPDATE SET product_id=EXCLUDED.product_id,variant_id=EXCLUDED.variant_id,name=EXCLUDED.name,
        variant_label=EXCLUDED.variant_label,unit=EXCLUDED.unit,qty=EXCLUDED.qty,price=EXCLUDED.price,disc=EXCLUDED.disc,gst_rate=EXCLUDED.gst_rate,
        note=EXCLUDED.note,fulfilled_qty=EXCLUDED.fulfilled_qty,serials=EXCLUDED.serials;
    SELECT count(*) INTO n FROM public.hangtag_order_items i WHERE i.owner_id=uid AND i.order_id=o.id;
    RETURN jsonb_build_object('status','saved','order',o.id,'version',ver,'lines',n);
END $$;
REVOKE ALL ON FUNCTION public.hangtag_save_order(JSONB, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.hangtag_save_order(JSONB, JSONB) TO authenticated;
CREATE OR REPLACE FUNCTION public.hangtag_import_stock(p_import JSONB, p_products JSONB, p_variants JSONB, p_moves JSONB, p_allow_duplicate BOOLEAN DEFAULT FALSE)
RETURNS JSONB LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE
    uid UUID := public.hangtag_shop_id(); imp TEXT := p_import->>'id'; d RECORD; r JSONB;
    n_p INT:=0; n_v INT:=0; n_m INT:=0; n_units NUMERIC:=0; q NUMERIC;
    inv TEXT:=lower(btrim(COALESCE(p_import->>'invoice_no',''))); gst TEXT:=lower(btrim(COALESCE(p_import->>'supplier_gstin',''))); sup TEXT:=lower(btrim(COALESCE(p_import->>'supplier_name','')));
    tr TEXT; u TEXT; dp INT; keeps_expiry BOOLEAN; sns TEXT[]; bno TEXT; bexp DATE;
    k TEXT:=CASE WHEN p_import->>'kind'='purchase' THEN 'purchase' ELSE 'import' END;
    sid TEXT:=NULLIF(btrim(COALESCE(p_import->>'supplier_id','')),''); ls JSONB:=COALESCE(p_import->'lines','[]'::jsonb);
    sub NUMERIC:=round(COALESCE((p_import->>'subtotal')::NUMERIC,0),2); tax NUMERIC:=round(COALESCE((p_import->>'tax_amount')::NUMERIC,0),2);
    tot NUMERIC:=round(COALESCE((p_import->>'total_amount')::NUMERIC,0),2); l_sub NUMERIC; l_tax NUMERIC; l_tot NUMERIC; l_q NUMERIC;
    bad BOOLEAN; s_name TEXT; s_gstin TEXT;
BEGIN
    IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Sign in to add stock.' USING ERRCODE='42501'; END IF;
    IF uid IS NULL OR NOT public.hangtag_can('create_purchase') THEN RAISE EXCEPTION 'Not allowed to add stock from supplier bills.' USING ERRCODE='42501'; END IF;
    IF COALESCE(imp,'')='' THEN RAISE EXCEPTION 'The import has no id.' USING ERRCODE='22023'; END IF;
    IF EXISTS (SELECT 1 FROM public.hangtag_stock_imports WHERE owner_id=uid AND id=imp) THEN RETURN jsonb_build_object('status','already_imported','import_id',imp); END IF;
    IF NOT COALESCE(p_allow_duplicate,FALSE) THEN
        SELECT id,created_at,invoice_no,supplier_name INTO d FROM public.hangtag_stock_imports WHERE owner_id=uid AND COALESCE(file_hash,'')<>'' AND file_hash=p_import->>'file_hash' ORDER BY created_at LIMIT 1;
        IF FOUND THEN RAISE EXCEPTION 'HANGTAG_DUPLICATE_FILE' USING DETAIL=jsonb_build_object('id',d.id,'created_at',d.created_at,'invoice_no',d.invoice_no,'supplier_name',d.supplier_name)::TEXT; END IF;
        IF inv<>'' THEN
            SELECT id,created_at,invoice_no,supplier_name INTO d FROM public.hangtag_stock_imports i WHERE i.owner_id=uid AND lower(btrim(COALESCE(i.invoice_no,'')))=inv
              AND CASE WHEN gst<>'' AND btrim(COALESCE(i.supplier_gstin,''))<>'' THEN lower(btrim(i.supplier_gstin))=gst ELSE lower(btrim(COALESCE(i.supplier_name,'')))=sup END ORDER BY created_at LIMIT 1;
            IF FOUND THEN RAISE EXCEPTION 'HANGTAG_DUPLICATE_INVOICE' USING DETAIL=jsonb_build_object('id',d.id,'created_at',d.created_at,'invoice_no',d.invoice_no,'supplier_name',d.supplier_name)::TEXT; END IF;
        END IF;
    END IF;
    FOR r IN SELECT * FROM jsonb_array_elements(COALESCE(p_products,'[]'::jsonb)) LOOP
        IF r->>'mode'='update_options' THEN
            IF NOT public.hangtag_cap_on(uid,'uses_variants') THEN RAISE EXCEPTION 'Product variants are switched off for this shop.' USING ERRCODE='42501'; END IF;
            UPDATE public.hangtag_products SET options=r->'options',updated_at=NOW() WHERE owner_id=uid AND id=r->>'id';
            IF NOT FOUND THEN RAISE EXCEPTION 'A product on this bill no longer exists. Check the bill again.' USING ERRCODE='23503'; END IF;
        ELSE
            tr:=COALESCE(NULLIF(r->>'tracking',''),'none'); u:=COALESCE(NULLIF(r->>'unit',''),'pcs');
            IF jsonb_array_length(COALESCE(r->'options'->'opts','[]'::jsonb))>0 AND NOT public.hangtag_cap_on(uid,'uses_variants') THEN RAISE EXCEPTION 'Product variants are switched off for this shop.' USING ERRCODE='42501'; END IF;
            IF u IN ('kg','g','l','ml') AND NOT public.hangtag_cap_on(uid,'uses_weight') THEN RAISE EXCEPTION 'Weight-based products are switched off for this shop.' USING ERRCODE='42501'; END IF;
            IF tr='serial' AND NOT public.hangtag_cap_on(uid,'uses_serials') THEN RAISE EXCEPTION 'Serial tracking is switched off for this shop.' USING ERRCODE='42501'; END IF;
            IF tr='batch' AND NOT public.hangtag_cap_on(uid,'uses_batches') THEN RAISE EXCEPTION 'Batch tracking is switched off for this shop.' USING ERRCODE='42501'; END IF;
            IF COALESCE((r->>'tracks_expiry')::BOOLEAN,FALSE) AND NOT public.hangtag_cap_on(uid,'uses_expiry') THEN RAISE EXCEPTION 'Expiry tracking is switched off for this shop.' USING ERRCODE='42501'; END IF;
            INSERT INTO public.hangtag_products (id,name,price,color,sort_order,category,brand,description,cost_price,archived,options,hsn,gst_rate,code_type,unit,tracking,tracks_expiry,low_stock)
            VALUES (r->>'id',r->>'name',COALESCE((r->>'price')::INTEGER,0),COALESCE(r->>'color','#8E8A83'),COALESCE((r->>'sort_order')::INTEGER,0),
                NULLIF(r->>'category',''),NULLIF(r->>'brand',''),NULLIF(r->>'description',''),(r->>'cost_price')::INTEGER,FALSE,COALESCE(r->'options','{}'::jsonb),
                NULLIF(r->>'hsn',''),(r->>'gst_rate')::NUMERIC,NULLIF(r->>'code_type',''),u,tr,COALESCE((r->>'tracks_expiry')::BOOLEAN,FALSE),(r->>'low_stock')::NUMERIC);
        END IF;
        n_p:=n_p+1;
    END LOOP;
    FOR r IN SELECT * FROM jsonb_array_elements(COALESCE(p_variants,'[]'::jsonb)) LOOP
        INSERT INTO public.hangtag_variants (id,product_id,option_values,color,size,sku,barcode,price,cost_price,active,sort_order)
        VALUES (r->>'id',r->>'product_id',COALESCE(r->'option_values','[]'::jsonb),COALESCE(r->>'color',''),COALESCE(r->>'size',''),NULLIF(r->>'sku',''),NULLIF(r->>'barcode',''),
            (r->>'price')::INTEGER,(r->>'cost_price')::INTEGER,COALESCE((r->>'active')::BOOLEAN,TRUE),COALESCE((r->>'sort_order')::INTEGER,0));
        n_v:=n_v+1;
    END LOOP;
    FOR r IN SELECT * FROM jsonb_array_elements(COALESCE(p_moves,'[]'::jsonb)) LOOP
        q:=round(COALESCE((r->>'qty')::NUMERIC,0),3); IF q<=0 THEN RAISE EXCEPTION 'Every line needs a quantity above 0.' USING ERRCODE='23514'; END IF;
        SELECT p.tracking,p.tracks_expiry,p.unit INTO tr,keeps_expiry,u FROM public.hangtag_variants v JOIN public.hangtag_products p ON p.owner_id=v.owner_id AND p.id=v.product_id
         WHERE v.owner_id=uid AND v.id=r->>'variant_id' AND p.id=r->>'product_id';
        IF NOT FOUND THEN RAISE EXCEPTION 'A product or variant on this bill no longer exists.' USING ERRCODE='23503'; END IF;
        dp:=public.hangtag_unit_decimals(uid,u);
        IF q<>round(q,dp) THEN RAISE EXCEPTION 'Quantity % has too many decimal places for %.',trim_scale(q),u USING ERRCODE='23514'; END IF;
        sns:=CASE WHEN jsonb_typeof(r->'serials')='array' THEN ARRAY(SELECT jsonb_array_elements_text(r->'serials')) END;
        bno:=NULLIF(upper(btrim(COALESCE(r->>'batch_no',''))),''); bexp:=NULLIF(r->>'expiry','')::DATE;
        IF tr='serial' AND (sns IS NULL OR bno IS NOT NULL) THEN RAISE EXCEPTION 'A serial-tracked line needs one serial per piece and no batch.' USING ERRCODE='23514'; END IF;
        IF tr='batch' AND (bno IS NULL OR sns IS NOT NULL OR (keeps_expiry AND bexp IS NULL)) THEN RAISE EXCEPTION 'A batch-tracked line needs its batch% and no serials.',CASE WHEN keeps_expiry THEN ' and expiry date' ELSE '' END USING ERRCODE='23514'; END IF;
        IF tr='none' AND (sns IS NOT NULL OR bno IS NOT NULL OR bexp IS NOT NULL) THEN RAISE EXCEPTION 'This product is not tracked by serial or batch.' USING ERRCODE='23514'; END IF;
        IF tr<>'batch' AND bexp IS NOT NULL THEN RAISE EXCEPTION 'Only a batch-tracked product has an expiry date.' USING ERRCODE='23514'; END IF;
        INSERT INTO public.hangtag_stock_moves (id,variant_id,product_id,type,qty,cost_price,note,t,device_id,import_id,serials,batch_no,expiry)
        VALUES (r->>'id',r->>'variant_id',r->>'product_id','RESTOCK',q,(r->>'cost_price')::INTEGER,LEFT(r->>'note',200),COALESCE((r->>'t')::BIGINT,(extract(epoch FROM now())*1000)::BIGINT),r->>'device_id',imp,sns,bno,bexp);
        n_m:=n_m+1; n_units:=n_units+q;
    END LOOP;
    -- a purchase needs stock lines; a plain import keeps the earlier rule (an import record alone is allowed)
    IF n_m=0 AND k='purchase' THEN RAISE EXCEPTION 'There is no stock to add.' USING ERRCODE='23514'; END IF;
    IF k='purchase' THEN
        IF sid IS NULL THEN RAISE EXCEPTION 'Choose the supplier for this purchase.' USING ERRCODE='23514'; END IF;
        SELECT name,gstin INTO s_name,s_gstin FROM public.hangtag_suppliers WHERE owner_id=uid AND id=sid;
        IF NOT FOUND THEN RAISE EXCEPTION 'That supplier was not found in this shop.' USING ERRCODE='23503'; END IF;
        IF jsonb_typeof(ls)<>'array' OR jsonb_array_length(ls)<>n_m THEN RAISE EXCEPTION 'The purchase lines do not match its stock-in lines.' USING ERRCODE='23514'; END IF;
        SELECT COALESCE(sum(round((x->>'tx')::NUMERIC,2)),0),COALESCE(sum(round((x->>'tax')::NUMERIC,2)),0),COALESCE(sum(round((x->>'total')::NUMERIC,2)),0),
            COALESCE(sum((x->>'q')::NUMERIC),0),COALESCE(bool_or((x->>'q')::NUMERIC<=0 OR (x->>'cost')::NUMERIC<0 OR (x->>'gst')::NUMERIC NOT BETWEEN 0 AND 100),FALSE)
          INTO l_sub,l_tax,l_tot,l_q,bad FROM jsonb_array_elements(ls) x;
        IF bad OR l_sub<>sub OR l_tax<>tax OR l_tot<>tot OR tot<>sub+tax OR round(l_q,3)<>round(n_units,3) THEN RAISE EXCEPTION 'The purchase lines, subtotal, GST and stock quantities do not add up.' USING ERRCODE='23514'; END IF;
    END IF;
    INSERT INTO public.hangtag_stock_imports (id,kind,supplier_id,file_hash,file_name,file_type,document_path,supplier_name,supplier_gstin,invoice_no,invoice_date,t,line_count,units,amount,
        subtotal,tax_amount,total_amount,paid_amount,payment_method,status,lines,extraction,device_id)
    VALUES (imp,k,CASE WHEN k='purchase' THEN sid END,NULLIF(p_import->>'file_hash',''),p_import->>'file_name',p_import->>'file_type',NULLIF(p_import->>'document_path',''),
        COALESCE(CASE WHEN k='purchase' THEN s_name END,NULLIF(p_import->>'supplier_name','')),COALESCE(CASE WHEN k='purchase' THEN s_gstin END,NULLIF(p_import->>'supplier_gstin','')),
        NULLIF(p_import->>'invoice_no',''),NULLIF(p_import->>'invoice_date','')::DATE,COALESCE((p_import->>'t')::BIGINT,(extract(epoch FROM now())*1000)::BIGINT),
        COALESCE((p_import->>'line_count')::INTEGER,n_m),n_units,COALESCE((p_import->>'amount')::NUMERIC,CASE WHEN k='purchase' THEN tot END),
        CASE WHEN k='purchase' THEN sub END,CASE WHEN k='purchase' THEN tax END,CASE WHEN k='purchase' THEN tot END,0,NULL,'posted',ls,p_import->'extraction',p_import->>'device_id');
    RETURN jsonb_build_object('status','imported','import_id',imp,'products',n_p,'variants',n_v,'moves',n_m,'units',n_units,'purchase',k='purchase');
END $$;
REVOKE ALL ON FUNCTION public.hangtag_import_stock(JSONB,JSONB,JSONB,JSONB,BOOLEAN) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.hangtag_import_stock(JSONB,JSONB,JSONB,JSONB,BOOLEAN) TO authenticated;
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
        dp := public.hangtag_unit_decimals(shop.id, COALESCE(vr.unit, 'pcs'));
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
-- The store's catalog also gives the shop's own units of the products in it, with their decimals. Otherwise exactly as
-- section 3t defines it.
CREATE OR REPLACE FUNCTION public.hangtag_mobile_catalog(p_token TEXT)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE shop RECORD; items JSONB; cats JSONB; units JSONB; logo TEXT; region TEXT; tax_on BOOLEAN := FALSE; tax_incl BOOLEAN := TRUE; default_rate NUMERIC := 5;
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
    -- the shop's own units its products here are sold in, with their decimals (the page steps and checks quantities with them)
    SELECT COALESCE(jsonb_agg(jsonb_build_object('id', u.id, 'label', u.label, 'dp', u.decimals) ORDER BY u.id), '[]'::jsonb) INTO units
      FROM public.hangtag_units u WHERE u.owner_id = shop.id
       AND EXISTS (SELECT 1 FROM public.hangtag_products p WHERE p.owner_id = u.owner_id AND p.unit = u.id AND NOT p.archived AND p.bundle IS NULL);
    -- the shop's logo (the one printed on its receipts), only when it is a picture
    SELECT CASE WHEN jsonb_typeof(m.value) = 'string' AND (m.value #>> '{}') ~ '^data:image/(png|jpeg|webp);base64,' THEN m.value #>> '{}' END
      INTO logo FROM public.hangtag_meta m WHERE m.owner_id = shop.id AND m.key = 'logo';
    RETURN jsonb_build_object('ok', TRUE, 'shop', COALESCE(NULLIF(btrim(shop.shop_name), ''), 'Shop'), 'city', NULLIF(btrim(COALESCE(shop.city, '')), ''), 'logo', logo, 'tax_on', tax_on,
        'tax_inclusive', tax_incl, 'items', items, 'categories', cats, 'units', units, 'region', COALESCE(region, 'IN'));
END $$;
REVOKE ALL ON FUNCTION public.hangtag_mobile_catalog(TEXT), public.hangtag_place_mobile_order(TEXT,JSONB,JSONB,TEXT,TEXT,TEXT,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.hangtag_mobile_catalog(TEXT), public.hangtag_place_mobile_order(TEXT,JSONB,JSONB,TEXT,TEXT,TEXT,TEXT) TO anon,authenticated;

-- Row security (section 5): everyone in the shop reads the fields and units (as they read products); they are added,
-- changed and removed with manage_products
ALTER TABLE public.hangtag_attributes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hangtag_units ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hangtag_attributes ALTER COLUMN owner_id SET DEFAULT public.hangtag_shop_id();
ALTER TABLE public.hangtag_units ALTER COLUMN owner_id SET DEFAULT public.hangtag_shop_id();
DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['hangtag_attributes', 'hangtag_units'] LOOP
        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'Shop read', t);
        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'Shop write (add)', t);
        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'Shop write (change)', t);
        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'Shop write (remove)', t);
        EXECUTE format('CREATE POLICY "Shop read" ON public.%I FOR SELECT TO authenticated USING (owner_id = (SELECT public.hangtag_shop_id()))', t);
        EXECUTE format('CREATE POLICY "Shop write (add)" ON public.%I FOR INSERT TO authenticated WITH CHECK (owner_id = (SELECT public.hangtag_shop_id()) AND ((SELECT public.hangtag_can(%L))))', t, 'manage_products');
        EXECUTE format('CREATE POLICY "Shop write (change)" ON public.%I FOR UPDATE TO authenticated USING (owner_id = (SELECT public.hangtag_shop_id()) AND ((SELECT public.hangtag_can(%L)))) WITH CHECK (owner_id = (SELECT public.hangtag_shop_id()) AND ((SELECT public.hangtag_can(%L))))', t, 'manage_products', 'manage_products');
        EXECUTE format('CREATE POLICY "Shop write (remove)" ON public.%I FOR DELETE TO authenticated USING (owner_id = (SELECT public.hangtag_shop_id()) AND ((SELECT public.hangtag_can(%L))))', t, 'manage_products');
    END LOOP;
END $$;
-- live updates between the shop's devices
DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['hangtag_attributes', 'hangtag_units'] LOOP
        BEGIN EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t); EXCEPTION WHEN OTHERS THEN NULL; END;
    END LOOP;
END $$;
