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
--   quantity to its unit's decimals. A unit in use isn't removed (it is archived) and keeps its decimals.
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
