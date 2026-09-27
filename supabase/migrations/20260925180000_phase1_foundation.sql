-- ==============================================================================
-- Hangtag Phase 1: new database foundation
--
--   shops ─┬─ shop_members (who can use the shop, and their role)
--          ├─ products ── product_variants (one per colour + size, with SKU and barcode)
--          ├─ stock_movements (the stock ledger: stock is the sum of these, never a stored number)
--          ├─ customers
--          ├─ bills ── bill_items (copies of product, colour, size, SKU, price and cost at the time of sale)
--          └─ returns ── return_items (always linked to the bill line they return)
--
-- How to apply: Supabase → SQL Editor → New query → paste this file → Run
-- (or `supabase db push` with the Supabase CLI). It is safe to run again.
-- It only creates new objects. The old hangtag_* tables used by the current app are not read or changed.
-- ==============================================================================

-- Stop before changing anything if one of these names is already used by something else
DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['shops','shop_members','bill_counters','products','product_variants','customers',
                             'bills','bill_items','returns','return_items','stock_movements'] LOOP
        IF to_regclass('public.' || t) IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = t
              AND column_name = CASE WHEN t = 'shops' THEN 'owner_id' ELSE 'shop_id' END
        ) THEN
            RAISE EXCEPTION 'public.% already exists and was not made by this script. Nothing was changed.', t;
        END IF;
    END LOOP;
END $$;

-- Helper functions live in a schema the API doesn't expose
CREATE SCHEMA IF NOT EXISTS private;
REVOKE ALL ON SCHEMA private FROM PUBLIC;
GRANT USAGE ON SCHEMA private TO authenticated;

-- ==============================================================================
-- 1. Shops and who belongs to them
-- ==============================================================================
CREATE TABLE IF NOT EXISTS public.shops (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id UUID NOT NULL DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE CASCADE,
    name TEXT NOT NULL CHECK (name = btrim(name) AND char_length(name) BETWEEN 1 AND 80),
    legal_name TEXT CHECK (char_length(legal_name) <= 120),
    gstin TEXT CHECK (gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'),
    phone TEXT CHECK (phone ~ '^\+?[0-9]{7,15}$'),
    email TEXT CHECK (char_length(email) <= 120 AND email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
    address TEXT CHECK (char_length(address) <= 300),
    city TEXT CHECK (char_length(city) <= 80),
    state TEXT CHECK (char_length(state) <= 80),
    pincode TEXT CHECK (pincode ~ '^[1-9][0-9]{5}$'),
    -- bill numbers look like INV/26-27/0001 (prefix / Indian financial year / running number)
    invoice_prefix TEXT NOT NULL DEFAULT 'INV' CHECK (invoice_prefix ~ '^[A-Z0-9]{1,5}$'),
    settings JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(settings) = 'object'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_shops_owner ON public.shops (owner_id);

-- The owner is added automatically. Managers and staff are for a later phase.
CREATE TABLE IF NOT EXISTS public.shop_members (
    shop_id UUID NOT NULL REFERENCES public.shops (id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'staff' CHECK (role IN ('owner', 'manager', 'staff')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (shop_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_shop_members_user ON public.shop_members (user_id);

-- The shops the signed-in user belongs to (used by every row security rule)
CREATE OR REPLACE FUNCTION private.my_shop_ids()
RETURNS SETOF UUID
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$ SELECT m.shop_id FROM public.shop_members m WHERE m.user_id = auth.uid() $$;

CREATE OR REPLACE FUNCTION private.is_shop_member(p_shop UUID)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$ SELECT EXISTS (SELECT 1 FROM public.shop_members m WHERE m.shop_id = p_shop AND m.user_id = auth.uid()) $$;

-- The user's shop when they belong to exactly one, so the app can leave shop_id out when adding rows
CREATE OR REPLACE FUNCTION private.default_shop_id()
RETURNS UUID
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$ SELECT CASE WHEN count(*) = 1 THEN (array_agg(m.shop_id))[1] END FROM public.shop_members m WHERE m.user_id = auth.uid() $$;

CREATE OR REPLACE FUNCTION private.touch_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = ''
AS $$ BEGIN NEW.updated_at := now(); RETURN NEW; END $$;

-- Running bill number per shop and financial year
CREATE TABLE IF NOT EXISTS public.bill_counters (
    shop_id UUID NOT NULL REFERENCES public.shops (id) ON DELETE CASCADE,
    fiscal_year TEXT NOT NULL CHECK (fiscal_year ~ '^[0-9]{2}-[0-9]{2}$'),
    last_number INTEGER NOT NULL DEFAULT 0 CHECK (last_number >= 0),
    PRIMARY KEY (shop_id, fiscal_year)
);

-- ==============================================================================
-- 2. Products and variants
--    Colour and size are not part of the product. Each colour + size is a variant.
--    A variant's price or cost, when empty, comes from its product.
-- ==============================================================================
CREATE TABLE IF NOT EXISTS public.products (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    shop_id UUID NOT NULL DEFAULT private.default_shop_id() REFERENCES public.shops (id) ON DELETE CASCADE,
    name TEXT NOT NULL CHECK (name = btrim(name) AND char_length(name) BETWEEN 1 AND 120),
    category TEXT CHECK (char_length(category) <= 60),
    brand TEXT CHECK (char_length(brand) <= 60),
    description TEXT CHECK (char_length(description) <= 2000),
    image_url TEXT CHECK (char_length(image_url) <= 2048),
    price NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (price >= 0),
    cost_price NUMERIC(12,2) CHECK (cost_price >= 0),
    gst_rate NUMERIC(5,2) CHECK (gst_rate BETWEEN 0 AND 100),
    hsn TEXT CHECK (hsn ~ '^[0-9]{4}([0-9]{2}){0,2}$'),
    is_archived BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT products_shop_id_key UNIQUE (shop_id, id)
);
CREATE INDEX IF NOT EXISTS idx_products_shop_name ON public.products (shop_id, lower(name));

CREATE TABLE IF NOT EXISTS public.product_variants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    shop_id UUID NOT NULL DEFAULT private.default_shop_id() REFERENCES public.shops (id) ON DELETE CASCADE,
    product_id UUID NOT NULL,
    color TEXT NOT NULL DEFAULT '' CHECK (color = btrim(color) AND char_length(color) <= 40),
    size TEXT NOT NULL DEFAULT '' CHECK (size = btrim(size) AND char_length(size) <= 20),
    sku TEXT CHECK (sku = btrim(sku) AND char_length(sku) BETWEEN 1 AND 64),
    barcode TEXT CHECK (barcode ~ '^[!-~]{1,64}$'),
    price NUMERIC(12,2) CHECK (price >= 0),
    cost_price NUMERIC(12,2) CHECK (cost_price >= 0),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT product_variants_shop_id_key UNIQUE (shop_id, id),
    CONSTRAINT product_variants_product_fkey FOREIGN KEY (shop_id, product_id)
        REFERENCES public.products (shop_id, id) ON DELETE CASCADE
);
-- one variant per colour + size of a product (Black and black are the same colour)
CREATE UNIQUE INDEX IF NOT EXISTS uq_product_variants_option ON public.product_variants (product_id, lower(color), lower(size));
-- SKU and barcode are unique within a shop (two shops may use the same ones)
CREATE UNIQUE INDEX IF NOT EXISTS uq_product_variants_sku ON public.product_variants (shop_id, lower(sku)) WHERE sku IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_product_variants_barcode ON public.product_variants (shop_id, barcode) WHERE barcode IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_product_variants_product ON public.product_variants (shop_id, product_id);

-- ==============================================================================
-- 3. Customers
-- ==============================================================================
CREATE TABLE IF NOT EXISTS public.customers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    shop_id UUID NOT NULL DEFAULT private.default_shop_id() REFERENCES public.shops (id) ON DELETE CASCADE,
    name TEXT NOT NULL CHECK (name = btrim(name) AND char_length(name) BETWEEN 1 AND 120),
    mobile TEXT CHECK (mobile ~ '^\+?[0-9]{7,15}$'),
    email TEXT CHECK (char_length(email) <= 120 AND email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
    gstin TEXT CHECK (gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'),
    customer_type TEXT NOT NULL DEFAULT 'individual' CHECK (customer_type IN ('individual', 'business')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT customers_shop_id_key UNIQUE (shop_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_customers_mobile ON public.customers (shop_id, mobile) WHERE mobile IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_customers_name ON public.customers (shop_id, lower(name));

-- ==============================================================================
-- 4. Bills and bill items
--    A bill is created together with its items (public.create_bill) and can't be edited afterwards:
--    only its payment details, notes and cancellation can change. Each item keeps a copy of the
--    product, colour, size, SKU, HSN, price and cost, so later product edits never change old bills.
-- ==============================================================================
CREATE TABLE IF NOT EXISTS public.bills (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    shop_id UUID NOT NULL DEFAULT private.default_shop_id() REFERENCES public.shops (id) ON DELETE CASCADE,
    bill_number TEXT NOT NULL CHECK (char_length(bill_number) BETWEEN 1 AND 32),
    customer_id UUID,
    customer_name TEXT CHECK (char_length(customer_name) <= 120),
    customer_mobile TEXT CHECK (char_length(customer_mobile) <= 16),
    customer_gstin TEXT CHECK (char_length(customer_gstin) = 15),
    subtotal NUMERIC(12,2) NOT NULL CHECK (subtotal >= 0),              -- sum of item line totals
    discount_percent NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (discount_percent BETWEEN 0 AND 100),
    discount_amount NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (discount_amount >= 0),
    taxable_amount NUMERIC(12,2) NOT NULL CHECK (taxable_amount >= 0),
    gst_amount NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (gst_amount >= 0),  -- sum of item GST
    round_off NUMERIC(4,2) NOT NULL DEFAULT 0 CHECK (round_off > -1 AND round_off < 1),
    total NUMERIC(12,2) NOT NULL CHECK (total >= 0),
    prices_include_gst BOOLEAN NOT NULL DEFAULT TRUE,
    payment_method TEXT CHECK (payment_method IN ('cash', 'upi', 'card', 'mixed', 'other')),
    payment_status TEXT NOT NULL DEFAULT 'paid' CHECK (payment_status IN ('paid', 'partial', 'unpaid')),
    status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('completed', 'cancelled')),
    cancelled_at TIMESTAMPTZ,
    cancel_reason TEXT CHECK (char_length(cancel_reason) <= 200),
    notes TEXT CHECK (char_length(notes) <= 500),
    billed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by UUID DEFAULT auth.uid(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT bills_shop_id_key UNIQUE (shop_id, id),
    CONSTRAINT bills_number_key UNIQUE (shop_id, bill_number),
    CONSTRAINT bills_customer_fkey FOREIGN KEY (shop_id, customer_id)
        REFERENCES public.customers (shop_id, id) ON DELETE SET NULL (customer_id),
    CONSTRAINT bills_discount_check CHECK (discount_amount <= subtotal),
    -- total = taxable + GST + round-off; with GST-inclusive prices the GST is inside (subtotal − discount)
    CONSTRAINT bills_amounts_check CHECK (
        total = taxable_amount + gst_amount + round_off
        AND CASE WHEN prices_include_gst THEN taxable_amount + gst_amount = subtotal - discount_amount
                 ELSE taxable_amount = subtotal - discount_amount END),
    CONSTRAINT bills_payment_check CHECK (payment_status = 'unpaid' OR payment_method IS NOT NULL),
    CONSTRAINT bills_cancel_check CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_bills_shop_time ON public.bills (shop_id, billed_at DESC);
CREATE INDEX IF NOT EXISTS idx_bills_customer ON public.bills (shop_id, customer_id);

CREATE TABLE IF NOT EXISTS public.bill_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    shop_id UUID NOT NULL DEFAULT private.default_shop_id() REFERENCES public.shops (id) ON DELETE CASCADE,
    bill_id UUID NOT NULL,
    line_no INTEGER NOT NULL CHECK (line_no >= 1),
    variant_id UUID NOT NULL,
    -- copies taken from the product and variant when the item is saved (filled in by the database)
    product_id UUID NOT NULL,
    product_name TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT '',
    size TEXT NOT NULL DEFAULT '',
    sku TEXT,
    hsn TEXT,
    cost_price NUMERIC(12,2) CHECK (cost_price >= 0),
    -- the selling price; when left out, the variant's current price is used
    unit_price NUMERIC(12,2) NOT NULL CHECK (unit_price >= 0),
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    discount_amount NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (discount_amount >= 0),
    line_total NUMERIC(12,2) GENERATED ALWAYS AS (quantity * unit_price - discount_amount) STORED,
    -- when left out, the product's GST rate is used (0 if it has none)
    gst_rate NUMERIC(5,2) NOT NULL CHECK (gst_rate BETWEEN 0 AND 100),
    gst_amount NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (gst_amount >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT bill_items_shop_id_key UNIQUE (shop_id, id),
    CONSTRAINT bill_items_bill_line_key UNIQUE (shop_id, bill_id, id),
    CONSTRAINT bill_items_line_no_key UNIQUE (bill_id, line_no),
    CONSTRAINT bill_items_discount_check CHECK (discount_amount <= quantity * unit_price),
    CONSTRAINT bill_items_bill_fkey FOREIGN KEY (shop_id, bill_id) REFERENCES public.bills (shop_id, id) ON DELETE CASCADE,
    CONSTRAINT bill_items_variant_fkey FOREIGN KEY (shop_id, variant_id) REFERENCES public.product_variants (shop_id, id),
    CONSTRAINT bill_items_product_fkey FOREIGN KEY (shop_id, product_id) REFERENCES public.products (shop_id, id)
);
CREATE INDEX IF NOT EXISTS idx_bill_items_variant ON public.bill_items (shop_id, variant_id);

-- ==============================================================================
-- 5. Returns and return items
--    A return always belongs to one bill, and each return item to one line of that bill.
--    The database refuses to return more pieces of a line than were sold, and refuses returns
--    worth more than the bill. An exchange is a return linked to the new bill (exchange_bill_id).
-- ==============================================================================
CREATE TABLE IF NOT EXISTS public.returns (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    shop_id UUID NOT NULL DEFAULT private.default_shop_id() REFERENCES public.shops (id) ON DELETE CASCADE,
    bill_id UUID NOT NULL,
    kind TEXT NOT NULL DEFAULT 'return' CHECK (kind IN ('return', 'exchange')),
    exchange_bill_id UUID,
    reason TEXT CHECK (char_length(reason) <= 200),
    total_amount NUMERIC(12,2) NOT NULL CHECK (total_amount >= 0),     -- sum of the return items' values
    refund_amount NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (refund_amount >= 0),
    refund_method TEXT CHECK (refund_method IN ('cash', 'upi', 'card', 'store_credit', 'other')),
    refund_status TEXT NOT NULL DEFAULT 'refunded' CHECK (refund_status IN ('pending', 'refunded', 'not_required')),
    refunded_at TIMESTAMPTZ,
    notes TEXT CHECK (char_length(notes) <= 500),
    returned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by UUID DEFAULT auth.uid(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT returns_shop_id_key UNIQUE (shop_id, id),
    CONSTRAINT returns_bill_return_key UNIQUE (shop_id, bill_id, id),
    CONSTRAINT returns_bill_fkey FOREIGN KEY (shop_id, bill_id) REFERENCES public.bills (shop_id, id) ON DELETE CASCADE,
    CONSTRAINT returns_exchange_bill_fkey FOREIGN KEY (shop_id, exchange_bill_id) REFERENCES public.bills (shop_id, id),
    CONSTRAINT returns_refund_check CHECK (refund_amount <= total_amount),
    CONSTRAINT returns_refunded_needs_method CHECK (refund_status <> 'refunded' OR refund_amount = 0 OR refund_method IS NOT NULL),
    CONSTRAINT returns_exchange_check CHECK (exchange_bill_id IS NULL OR (kind = 'exchange' AND exchange_bill_id <> bill_id))
);
CREATE INDEX IF NOT EXISTS idx_returns_bill ON public.returns (shop_id, bill_id);

CREATE TABLE IF NOT EXISTS public.return_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    shop_id UUID NOT NULL DEFAULT private.default_shop_id() REFERENCES public.shops (id) ON DELETE CASCADE,
    return_id UUID NOT NULL,
    bill_id UUID NOT NULL,          -- filled in from the return
    bill_item_id UUID NOT NULL,
    variant_id UUID NOT NULL,       -- filled in from the bill item
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    amount NUMERIC(12,2) NOT NULL CHECK (amount >= 0),
    restock BOOLEAN NOT NULL DEFAULT TRUE,  -- false for damaged pieces that shouldn't go back on sale
    reason TEXT CHECK (char_length(reason) <= 200),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT return_items_shop_id_key UNIQUE (shop_id, id),
    CONSTRAINT return_items_return_item_key UNIQUE (shop_id, return_id, id),
    CONSTRAINT return_items_bill_item_once_key UNIQUE (return_id, bill_item_id),
    -- both links include the bill, so an item can only come from the bill being returned
    CONSTRAINT return_items_return_fkey FOREIGN KEY (shop_id, bill_id, return_id)
        REFERENCES public.returns (shop_id, bill_id, id) ON DELETE CASCADE,
    CONSTRAINT return_items_bill_item_fkey FOREIGN KEY (shop_id, bill_id, bill_item_id)
        REFERENCES public.bill_items (shop_id, bill_id, id),
    CONSTRAINT return_items_variant_fkey FOREIGN KEY (shop_id, variant_id) REFERENCES public.product_variants (shop_id, id)
);
CREATE INDEX IF NOT EXISTS idx_return_items_bill_item ON public.return_items (bill_item_id);

-- ==============================================================================
-- 6. Stock ledger
--    Stock of a variant = sum(quantity) of its movements. Rows are never edited or deleted.
--    The app adds OPENING_STOCK, STOCK_IN and ADJUSTMENT. The database adds SALE (bill item saved),
--    CANCEL (bill cancelled) and RETURN (return item saved, when the pieces go back on sale).
-- ==============================================================================
CREATE TABLE IF NOT EXISTS public.stock_movements (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    shop_id UUID NOT NULL DEFAULT private.default_shop_id() REFERENCES public.shops (id) ON DELETE CASCADE,
    variant_id UUID NOT NULL,
    movement_type TEXT NOT NULL CHECK (movement_type IN ('OPENING_STOCK', 'STOCK_IN', 'ADJUSTMENT', 'SALE', 'RETURN', 'CANCEL')),
    quantity INTEGER NOT NULL,      -- + into stock, − out of stock
    unit_cost NUMERIC(12,2) CHECK (unit_cost >= 0),
    reason TEXT CHECK (char_length(reason) BETWEEN 1 AND 60),
    note TEXT CHECK (char_length(note) <= 500),
    bill_id UUID,
    bill_item_id UUID,
    return_id UUID,
    return_item_id UUID,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by UUID DEFAULT auth.uid(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT stock_movements_variant_fkey FOREIGN KEY (shop_id, variant_id) REFERENCES public.product_variants (shop_id, id),
    CONSTRAINT stock_movements_bill_item_fkey FOREIGN KEY (shop_id, bill_id, bill_item_id)
        REFERENCES public.bill_items (shop_id, bill_id, id),
    CONSTRAINT stock_movements_return_item_fkey FOREIGN KEY (shop_id, return_id, return_item_id)
        REFERENCES public.return_items (shop_id, return_id, id),
    CONSTRAINT stock_movements_type_check CHECK (CASE movement_type
        WHEN 'OPENING_STOCK' THEN quantity > 0 AND num_nonnulls(bill_id, bill_item_id, return_id, return_item_id) = 0
        WHEN 'STOCK_IN'      THEN quantity > 0 AND num_nonnulls(bill_id, bill_item_id, return_id, return_item_id) = 0
        WHEN 'ADJUSTMENT'    THEN quantity <> 0 AND reason IS NOT NULL AND num_nonnulls(bill_id, bill_item_id, return_id, return_item_id) = 0
        WHEN 'SALE'          THEN quantity < 0 AND bill_id IS NOT NULL AND bill_item_id IS NOT NULL AND num_nonnulls(return_id, return_item_id) = 0
        WHEN 'CANCEL'        THEN quantity > 0 AND bill_id IS NOT NULL AND bill_item_id IS NOT NULL AND num_nonnulls(return_id, return_item_id) = 0
        WHEN 'RETURN'        THEN quantity > 0 AND return_id IS NOT NULL AND return_item_id IS NOT NULL AND num_nonnulls(bill_id, bill_item_id) = 0
        ELSE FALSE END)
);
CREATE INDEX IF NOT EXISTS idx_stock_movements_variant ON public.stock_movements (shop_id, variant_id, occurred_at);
-- a bill line is taken out of stock once, put back once if the bill is cancelled; a return item once
CREATE UNIQUE INDEX IF NOT EXISTS uq_stock_movements_sale ON public.stock_movements (bill_item_id) WHERE movement_type = 'SALE';
CREATE UNIQUE INDEX IF NOT EXISTS uq_stock_movements_cancel ON public.stock_movements (bill_item_id) WHERE movement_type = 'CANCEL';
CREATE UNIQUE INDEX IF NOT EXISTS uq_stock_movements_return ON public.stock_movements (return_item_id) WHERE movement_type = 'RETURN';

-- ==============================================================================
-- 7. Rules the database enforces (triggers)
-- ==============================================================================

-- A new shop gets its owner as a member
CREATE OR REPLACE FUNCTION private.shops_after_insert()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
    INSERT INTO public.shop_members (shop_id, user_id, role) VALUES (NEW.id, NEW.owner_id, 'owner')
    ON CONFLICT (shop_id, user_id) DO UPDATE SET role = 'owner';
    RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS shops_after_insert ON public.shops;
CREATE TRIGGER shops_after_insert AFTER INSERT ON public.shops
    FOR EACH ROW EXECUTE FUNCTION private.shops_after_insert();

DROP TRIGGER IF EXISTS shops_touch ON public.shops;
CREATE TRIGGER shops_touch BEFORE UPDATE ON public.shops FOR EACH ROW EXECUTE FUNCTION private.touch_updated_at();
DROP TRIGGER IF EXISTS products_touch ON public.products;
CREATE TRIGGER products_touch BEFORE UPDATE ON public.products FOR EACH ROW EXECUTE FUNCTION private.touch_updated_at();
DROP TRIGGER IF EXISTS customers_touch ON public.customers;
CREATE TRIGGER customers_touch BEFORE UPDATE ON public.customers FOR EACH ROW EXECUTE FUNCTION private.touch_updated_at();

-- A variant stays with its product (its stock and sales history belong to that product)
CREATE OR REPLACE FUNCTION private.product_variants_before_update()
RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
    IF NEW.product_id IS DISTINCT FROM OLD.product_id THEN
        RAISE EXCEPTION 'A variant can''t be moved to another product.' USING ERRCODE = 'check_violation';
    END IF;
    NEW.updated_at := now();
    RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS product_variants_before_update ON public.product_variants;
CREATE TRIGGER product_variants_before_update BEFORE UPDATE ON public.product_variants
    FOR EACH ROW EXECUTE FUNCTION private.product_variants_before_update();

-- New bill: number it, copy the customer's details, start it as completed
CREATE OR REPLACE FUNCTION private.bills_before_insert()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
    v_prefix TEXT;
    v_local TIMESTAMP;
    v_year INTEGER;
    v_fy TEXT;
    v_n INTEGER;
BEGIN
    IF auth.uid() IS NOT NULL AND NOT private.is_shop_member(NEW.shop_id) THEN
        RAISE EXCEPTION 'You don''t have access to this shop.' USING ERRCODE = 'insufficient_privilege';
    END IF;
    NEW.status := 'completed';
    NEW.cancelled_at := NULL;
    NEW.cancel_reason := NULL;
    NEW.billed_at := COALESCE(NEW.billed_at, now());
    NEW.created_by := COALESCE(auth.uid(), NEW.created_by);
    IF NEW.customer_id IS NOT NULL THEN
        SELECT c.name, c.mobile, c.gstin INTO NEW.customer_name, NEW.customer_mobile, NEW.customer_gstin
          FROM public.customers c WHERE c.shop_id = NEW.shop_id AND c.id = NEW.customer_id;
    END IF;
    IF NEW.bill_number IS NULL THEN
        -- Indian financial year (April to March), in India time
        v_local := NEW.billed_at AT TIME ZONE 'Asia/Kolkata';
        v_year := EXTRACT(YEAR FROM v_local)::INTEGER - CASE WHEN EXTRACT(MONTH FROM v_local) < 4 THEN 1 ELSE 0 END;
        v_fy := lpad((v_year % 100)::TEXT, 2, '0') || '-' || lpad(((v_year + 1) % 100)::TEXT, 2, '0');
        SELECT s.invoice_prefix INTO v_prefix FROM public.shops s WHERE s.id = NEW.shop_id;
        INSERT INTO public.bill_counters AS bc (shop_id, fiscal_year, last_number) VALUES (NEW.shop_id, v_fy, 1)
        ON CONFLICT (shop_id, fiscal_year) DO UPDATE SET last_number = bc.last_number + 1
        RETURNING bc.last_number INTO v_n;
        NEW.bill_number := COALESCE(v_prefix, 'INV') || '/' || v_fy || '/' || lpad(v_n::TEXT, greatest(4, length(v_n::TEXT)), '0');
    END IF;
    RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS bills_before_insert ON public.bills;
CREATE TRIGGER bills_before_insert BEFORE INSERT ON public.bills
    FOR EACH ROW EXECUTE FUNCTION private.bills_before_insert();

-- Saved bills: only payment, notes and cancellation can change; a cancelled bill stays cancelled
CREATE OR REPLACE FUNCTION private.bills_before_update()
RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
    IF (NEW.id, NEW.shop_id, NEW.bill_number, NEW.customer_name, NEW.customer_mobile, NEW.customer_gstin,
        NEW.subtotal, NEW.discount_percent, NEW.discount_amount, NEW.taxable_amount, NEW.gst_amount, NEW.round_off,
        NEW.total, NEW.prices_include_gst, NEW.billed_at, NEW.created_by, NEW.created_at)
       IS DISTINCT FROM
       (OLD.id, OLD.shop_id, OLD.bill_number, OLD.customer_name, OLD.customer_mobile, OLD.customer_gstin,
        OLD.subtotal, OLD.discount_percent, OLD.discount_amount, OLD.taxable_amount, OLD.gst_amount, OLD.round_off,
        OLD.total, OLD.prices_include_gst, OLD.billed_at, OLD.created_by, OLD.created_at)
       -- the customer link may only be cleared (when the customer record is deleted; the copy stays)
       OR (NEW.customer_id IS DISTINCT FROM OLD.customer_id AND NEW.customer_id IS NOT NULL) THEN
        RAISE EXCEPTION 'Bill % can''t be edited. Only its payment, notes or cancellation can change.', OLD.bill_number
            USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.status = 'cancelled' AND NEW.status <> 'cancelled' THEN
        RAISE EXCEPTION 'Bill % is cancelled and can''t be reopened.', OLD.bill_number USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.status = 'completed' AND NEW.status = 'cancelled' THEN
        -- same lock as returns, so a cancel and a return of the same bill can't pass each other
        PERFORM pg_advisory_xact_lock(hashtextextended('hangtag.bill:' || OLD.id::TEXT, 0));
        IF EXISTS (SELECT 1 FROM public.returns r WHERE r.bill_id = OLD.id) THEN
            RAISE EXCEPTION 'Bill % has returns, so it can''t be cancelled.', OLD.bill_number USING ERRCODE = 'check_violation';
        END IF;
        NEW.cancelled_at := COALESCE(NEW.cancelled_at, now());
    ELSIF OLD.status = 'cancelled' THEN
        NEW.cancelled_at := OLD.cancelled_at;
    END IF;
    NEW.updated_at := now();
    RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS bills_before_update ON public.bills;
CREATE TRIGGER bills_before_update BEFORE UPDATE ON public.bills
    FOR EACH ROW EXECUTE FUNCTION private.bills_before_update();

-- Cancelling a bill puts its pieces back in stock
CREATE OR REPLACE FUNCTION private.bills_after_cancel()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
    INSERT INTO public.stock_movements (shop_id, variant_id, movement_type, quantity, bill_id, bill_item_id, note, occurred_at, created_by)
    SELECT i.shop_id, i.variant_id, 'CANCEL', i.quantity, i.bill_id, i.id, 'Bill ' || NEW.bill_number || ' cancelled',
           NEW.cancelled_at, auth.uid()
      FROM public.bill_items i
     WHERE i.bill_id = NEW.id
    ON CONFLICT DO NOTHING;
    RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS bills_after_cancel ON public.bills;
CREATE TRIGGER bills_after_cancel AFTER UPDATE OF status ON public.bills
    FOR EACH ROW WHEN (OLD.status = 'completed' AND NEW.status = 'cancelled')
    EXECUTE FUNCTION private.bills_after_cancel();

-- New bill item: copy the product details, cost, and (unless given) the price and GST rate
CREATE OR REPLACE FUNCTION private.bill_items_before_insert()
RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = ''
AS $$
DECLARE
    v_status TEXT;
    v_src RECORD;
BEGIN
    SELECT b.status INTO v_status FROM public.bills b WHERE b.id = NEW.bill_id AND b.shop_id = NEW.shop_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Bill % was not found in this shop.', NEW.bill_id USING ERRCODE = 'foreign_key_violation';
    END IF;
    IF v_status = 'cancelled' THEN
        RAISE EXCEPTION 'Items can''t be added to a cancelled bill.' USING ERRCODE = 'check_violation';
    END IF;
    SELECT v.product_id, p.name AS product_name, v.color, v.size, v.sku, p.hsn, p.gst_rate,
           COALESCE(v.price, p.price) AS price, COALESCE(v.cost_price, p.cost_price) AS cost_price
      INTO v_src
      FROM public.product_variants v
      JOIN public.products p ON p.shop_id = v.shop_id AND p.id = v.product_id
     WHERE v.id = NEW.variant_id AND v.shop_id = NEW.shop_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Variant % was not found in this shop.', NEW.variant_id USING ERRCODE = 'foreign_key_violation';
    END IF;
    NEW.product_id := v_src.product_id;
    NEW.product_name := v_src.product_name;
    NEW.color := v_src.color;
    NEW.size := v_src.size;
    NEW.sku := v_src.sku;
    NEW.hsn := v_src.hsn;
    NEW.cost_price := v_src.cost_price;
    NEW.unit_price := COALESCE(NEW.unit_price, v_src.price);
    NEW.gst_rate := COALESCE(NEW.gst_rate, v_src.gst_rate, 0);
    RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS bill_items_before_insert ON public.bill_items;
CREATE TRIGGER bill_items_before_insert BEFORE INSERT ON public.bill_items
    FOR EACH ROW EXECUTE FUNCTION private.bill_items_before_insert();

-- Every bill item takes its pieces out of stock
CREATE OR REPLACE FUNCTION private.bill_items_after_insert()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
    INSERT INTO public.stock_movements (shop_id, variant_id, movement_type, quantity, bill_id, bill_item_id, occurred_at, created_by)
    SELECT NEW.shop_id, NEW.variant_id, 'SALE', -NEW.quantity, NEW.bill_id, NEW.id, b.billed_at, auth.uid()
      FROM public.bills b WHERE b.id = NEW.bill_id;
    RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS bill_items_after_insert ON public.bill_items;
CREATE TRIGGER bill_items_after_insert AFTER INSERT ON public.bill_items
    FOR EACH ROW EXECUTE FUNCTION private.bill_items_after_insert();

-- Checked when the transaction ends: a bill has at least one item, and its subtotal and GST
-- equal the sums of its items. (That's why bills are created with their items in one call.)
CREATE OR REPLACE FUNCTION private.check_bill_totals()
RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = ''
AS $$
DECLARE
    v_bill_id UUID;
    v_bill RECORD;
    v_sum RECORD;
BEGIN
    IF TG_TABLE_NAME = 'bills' THEN v_bill_id := NEW.id; ELSE v_bill_id := NEW.bill_id; END IF;
    SELECT b.bill_number, b.subtotal, b.gst_amount INTO v_bill FROM public.bills b WHERE b.id = v_bill_id;
    IF NOT FOUND THEN RETURN NULL; END IF;
    SELECT count(*) AS n, COALESCE(sum(i.line_total), 0) AS subtotal, COALESCE(sum(i.gst_amount), 0) AS gst
      INTO v_sum FROM public.bill_items i WHERE i.bill_id = v_bill_id;
    IF v_sum.n = 0 THEN
        RAISE EXCEPTION 'Bill % has no items.', v_bill.bill_number USING ERRCODE = 'check_violation';
    END IF;
    IF v_sum.subtotal <> v_bill.subtotal THEN
        RAISE EXCEPTION 'Bill % subtotal is % but its items add up to %.', v_bill.bill_number, v_bill.subtotal, v_sum.subtotal
            USING ERRCODE = 'check_violation';
    END IF;
    IF v_sum.gst <> v_bill.gst_amount THEN
        RAISE EXCEPTION 'Bill % GST is % but its items add up to %.', v_bill.bill_number, v_bill.gst_amount, v_sum.gst
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS bills_check_totals ON public.bills;
CREATE CONSTRAINT TRIGGER bills_check_totals AFTER INSERT ON public.bills
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION private.check_bill_totals();
DROP TRIGGER IF EXISTS bill_items_check_totals ON public.bill_items;
CREATE CONSTRAINT TRIGGER bill_items_check_totals AFTER INSERT ON public.bill_items
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION private.check_bill_totals();

-- New return: only for a bill that isn't cancelled
CREATE OR REPLACE FUNCTION private.returns_before_insert()
RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = ''
AS $$
DECLARE v_status TEXT;
BEGIN
    SELECT b.status INTO v_status FROM public.bills b WHERE b.id = NEW.bill_id AND b.shop_id = NEW.shop_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Bill % was not found in this shop.', NEW.bill_id USING ERRCODE = 'foreign_key_violation';
    END IF;
    IF v_status = 'cancelled' THEN
        RAISE EXCEPTION 'This bill is cancelled, so nothing on it can be returned.' USING ERRCODE = 'check_violation';
    END IF;
    NEW.created_by := COALESCE(auth.uid(), NEW.created_by);
    IF NEW.refund_status = 'refunded' AND NEW.refunded_at IS NULL THEN NEW.refunded_at := now(); END IF;
    RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS returns_before_insert ON public.returns;
CREATE TRIGGER returns_before_insert BEFORE INSERT ON public.returns
    FOR EACH ROW EXECUTE FUNCTION private.returns_before_insert();

-- Saved returns: only the refund details, notes and exchange bill can change
CREATE OR REPLACE FUNCTION private.returns_before_update()
RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
    IF (NEW.id, NEW.shop_id, NEW.bill_id, NEW.kind, NEW.total_amount, NEW.returned_at, NEW.created_by, NEW.created_at)
       IS DISTINCT FROM
       (OLD.id, OLD.shop_id, OLD.bill_id, OLD.kind, OLD.total_amount, OLD.returned_at, OLD.created_by, OLD.created_at)
       OR (OLD.exchange_bill_id IS NOT NULL AND NEW.exchange_bill_id IS DISTINCT FROM OLD.exchange_bill_id) THEN
        RAISE EXCEPTION 'A saved return can''t be edited. Only its refund details, notes or exchange bill can change.'
            USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.refund_status = 'refunded' AND OLD.refund_status <> 'refunded' AND NEW.refunded_at IS NULL THEN
        NEW.refunded_at := now();
    END IF;
    NEW.updated_at := now();
    RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS returns_before_update ON public.returns;
CREATE TRIGGER returns_before_update BEFORE UPDATE ON public.returns
    FOR EACH ROW EXECUTE FUNCTION private.returns_before_update();

-- New return item: it must be a line of the returned bill, and never more pieces than were sold
CREATE OR REPLACE FUNCTION private.return_items_before_insert()
RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = ''
AS $$
DECLARE
    v_bill_id UUID;
    v_status TEXT;
    v_line RECORD;
    v_already INTEGER;
BEGIN
    SELECT r.bill_id INTO v_bill_id FROM public.returns r WHERE r.id = NEW.return_id AND r.shop_id = NEW.shop_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Return % was not found in this shop.', NEW.return_id USING ERRCODE = 'foreign_key_violation';
    END IF;
    NEW.bill_id := v_bill_id;
    -- one return (or cancel) of a bill at a time, so two devices can't both return the last piece
    PERFORM pg_advisory_xact_lock(hashtextextended('hangtag.bill:' || v_bill_id::TEXT, 0));
    SELECT b.status INTO v_status FROM public.bills b WHERE b.id = v_bill_id;
    IF v_status = 'cancelled' THEN
        RAISE EXCEPTION 'This bill is cancelled, so nothing on it can be returned.' USING ERRCODE = 'check_violation';
    END IF;
    SELECT i.variant_id, i.quantity, i.product_name, i.color, i.size INTO v_line
      FROM public.bill_items i
     WHERE i.id = NEW.bill_item_id AND i.shop_id = NEW.shop_id AND i.bill_id = v_bill_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'That item isn''t on the bill being returned.' USING ERRCODE = 'foreign_key_violation';
    END IF;
    NEW.variant_id := v_line.variant_id;
    SELECT COALESCE(sum(x.quantity), 0) INTO v_already FROM public.return_items x WHERE x.bill_item_id = NEW.bill_item_id;
    IF v_already + NEW.quantity > v_line.quantity THEN
        RAISE EXCEPTION 'Can''t return % of %: % sold, % already returned.', NEW.quantity,
            v_line.product_name || CASE WHEN v_line.color <> '' OR v_line.size <> ''
                THEN ' (' || concat_ws(' / ', NULLIF(v_line.color, ''), NULLIF(v_line.size, '')) || ')' ELSE '' END,
            v_line.quantity, v_already
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS return_items_before_insert ON public.return_items;
CREATE TRIGGER return_items_before_insert BEFORE INSERT ON public.return_items
    FOR EACH ROW EXECUTE FUNCTION private.return_items_before_insert();

-- Returned pieces go back in stock (unless marked as not for resale)
CREATE OR REPLACE FUNCTION private.return_items_after_insert()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
    IF NEW.restock THEN
        INSERT INTO public.stock_movements (shop_id, variant_id, movement_type, quantity, return_id, return_item_id, occurred_at, created_by)
        SELECT NEW.shop_id, NEW.variant_id, 'RETURN', NEW.quantity, NEW.return_id, NEW.id, r.returned_at, auth.uid()
          FROM public.returns r WHERE r.id = NEW.return_id;
    END IF;
    RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS return_items_after_insert ON public.return_items;
CREATE TRIGGER return_items_after_insert AFTER INSERT ON public.return_items
    FOR EACH ROW EXECUTE FUNCTION private.return_items_after_insert();

-- Checked when the transaction ends: a return has at least one item, its total equals its items,
-- and all returns of a bill together are never worth more than the bill
CREATE OR REPLACE FUNCTION private.check_return_totals()
RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = ''
AS $$
DECLARE
    v_return_id UUID;
    v_ret RECORD;
    v_sum RECORD;
    v_bill RECORD;
BEGIN
    IF TG_TABLE_NAME = 'returns' THEN v_return_id := NEW.id; ELSE v_return_id := NEW.return_id; END IF;
    SELECT r.bill_id, r.total_amount INTO v_ret FROM public.returns r WHERE r.id = v_return_id;
    IF NOT FOUND THEN RETURN NULL; END IF;
    SELECT count(*) AS n, COALESCE(sum(x.amount), 0) AS amount INTO v_sum FROM public.return_items x WHERE x.return_id = v_return_id;
    IF v_sum.n = 0 THEN
        RAISE EXCEPTION 'A return needs at least one item.' USING ERRCODE = 'check_violation';
    END IF;
    IF v_sum.amount <> v_ret.total_amount THEN
        RAISE EXCEPTION 'Return total is % but its items add up to %.', v_ret.total_amount, v_sum.amount USING ERRCODE = 'check_violation';
    END IF;
    SELECT b.bill_number, b.total, (SELECT COALESCE(sum(r.total_amount), 0) FROM public.returns r WHERE r.bill_id = b.id) AS returned
      INTO v_bill FROM public.bills b WHERE b.id = v_ret.bill_id;
    IF v_bill.returned > v_bill.total THEN
        RAISE EXCEPTION 'Returns on bill % would add up to %, more than the bill total of %.', v_bill.bill_number, v_bill.returned, v_bill.total
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS returns_check_totals ON public.returns;
CREATE CONSTRAINT TRIGGER returns_check_totals AFTER INSERT ON public.returns
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION private.check_return_totals();
DROP TRIGGER IF EXISTS return_items_check_totals ON public.return_items;
CREATE CONSTRAINT TRIGGER return_items_check_totals AFTER INSERT ON public.return_items
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION private.check_return_totals();

-- ==============================================================================
-- 8. Views (they follow the reader's row security)
-- ==============================================================================
CREATE OR REPLACE VIEW public.variant_stock WITH (security_invoker = true) AS
SELECT m.shop_id, m.variant_id, sum(m.quantity)::INTEGER AS on_hand, max(m.occurred_at) AS last_movement_at
  FROM public.stock_movements m
 GROUP BY m.shop_id, m.variant_id;

-- Each variant with its product, the price and cost that apply, and stock on hand
CREATE OR REPLACE VIEW public.variant_catalog WITH (security_invoker = true) AS
SELECT v.id AS variant_id, v.shop_id, v.product_id, p.name AS product_name, p.category, p.brand,
       v.color, v.size, v.sku, v.barcode,
       COALESCE(v.price, p.price) AS price,
       COALESCE(v.cost_price, p.cost_price) AS cost_price,
       p.gst_rate, p.hsn, p.image_url,
       v.is_active, p.is_archived, (v.is_active AND NOT p.is_archived) AS is_sellable,
       v.sort_order,
       COALESCE(s.on_hand, 0)::INTEGER AS on_hand
  FROM public.product_variants v
  JOIN public.products p ON p.shop_id = v.shop_id AND p.id = v.product_id
  LEFT JOIN (SELECT m.variant_id, sum(m.quantity) AS on_hand FROM public.stock_movements m GROUP BY m.variant_id) s
    ON s.variant_id = v.id;

-- ==============================================================================
-- 9. Creating bills and returns (one call saves the header and all items together)
-- ==============================================================================

-- create_bill({shop_id?, id?, customer_id?, customer_name?, customer_mobile?, subtotal, discount_percent?,
--              discount_amount?, taxable_amount, gst_amount?, round_off?, total, prices_include_gst?,
--              payment_method, payment_status?, billed_at?, notes?},
--             [{variant_id, quantity, unit_price?, discount_amount?, gst_rate?, gst_amount?, id?}, ...])
-- Sending the same bill id again returns the saved bill instead of saving it twice.
CREATE OR REPLACE FUNCTION public.create_bill(p_bill JSONB, p_items JSONB)
RETURNS public.bills
LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $$
DECLARE
    v_id UUID := COALESCE(NULLIF(p_bill ->> 'id', '')::UUID, gen_random_uuid());
    v_bill public.bills;
BEGIN
    IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' OR jsonb_array_length(p_items) = 0 THEN
        RAISE EXCEPTION 'A bill needs at least one item.' USING ERRCODE = 'check_violation';
    END IF;
    SELECT * INTO v_bill FROM public.bills WHERE id = v_id;
    IF FOUND THEN RETURN v_bill; END IF;

    INSERT INTO public.bills (id, shop_id, bill_number, customer_id, customer_name, customer_mobile, customer_gstin,
        subtotal, discount_percent, discount_amount, taxable_amount, gst_amount, round_off, total, prices_include_gst,
        payment_method, payment_status, notes, billed_at)
    VALUES (v_id,
        COALESCE(NULLIF(p_bill ->> 'shop_id', '')::UUID, private.default_shop_id()),
        NULLIF(p_bill ->> 'bill_number', ''),
        NULLIF(p_bill ->> 'customer_id', '')::UUID,
        NULLIF(p_bill ->> 'customer_name', ''), NULLIF(p_bill ->> 'customer_mobile', ''), NULLIF(p_bill ->> 'customer_gstin', ''),
        (p_bill ->> 'subtotal')::NUMERIC,
        COALESCE((p_bill ->> 'discount_percent')::NUMERIC, 0),
        COALESCE((p_bill ->> 'discount_amount')::NUMERIC, 0),
        (p_bill ->> 'taxable_amount')::NUMERIC,
        COALESCE((p_bill ->> 'gst_amount')::NUMERIC, 0),
        COALESCE((p_bill ->> 'round_off')::NUMERIC, 0),
        (p_bill ->> 'total')::NUMERIC,
        COALESCE((p_bill ->> 'prices_include_gst')::BOOLEAN, TRUE),
        p_bill ->> 'payment_method',
        COALESCE(p_bill ->> 'payment_status', 'paid'),
        p_bill ->> 'notes',
        COALESCE((p_bill ->> 'billed_at')::TIMESTAMPTZ, now()))
    RETURNING * INTO v_bill;

    INSERT INTO public.bill_items (id, shop_id, bill_id, line_no, variant_id, quantity, unit_price, discount_amount, gst_rate, gst_amount)
    SELECT COALESCE(NULLIF(it ->> 'id', '')::UUID, gen_random_uuid()), v_bill.shop_id, v_bill.id, n::INTEGER,
           (it ->> 'variant_id')::UUID, (it ->> 'quantity')::INTEGER, (it ->> 'unit_price')::NUMERIC,
           COALESCE((it ->> 'discount_amount')::NUMERIC, 0), (it ->> 'gst_rate')::NUMERIC, COALESCE((it ->> 'gst_amount')::NUMERIC, 0)
      FROM jsonb_array_elements(p_items) WITH ORDINALITY AS t(it, n);

    -- check the totals now, so a mistake comes back as this call's error
    SET CONSTRAINTS public.bills_check_totals, public.bill_items_check_totals IMMEDIATE;
    RETURN v_bill;
END $$;

-- create_return({bill_id, id?, kind?, exchange_bill_id?, reason?, total_amount?, refund_amount?, refund_method?,
--                refund_status?, returned_at?, notes?},
--               [{bill_item_id, quantity, amount, restock?, reason?, id?}, ...])
-- total_amount defaults to the sum of the items. For a plain return the refund defaults to the total.
CREATE OR REPLACE FUNCTION public.create_return(p_return JSONB, p_items JSONB)
RETURNS public.returns
LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $$
DECLARE
    v_id UUID := COALESCE(NULLIF(p_return ->> 'id', '')::UUID, gen_random_uuid());
    v_kind TEXT := COALESCE(p_return ->> 'kind', 'return');
    v_total NUMERIC;
    v_refund NUMERIC;
    v_ret public.returns;
BEGIN
    IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' OR jsonb_array_length(p_items) = 0 THEN
        RAISE EXCEPTION 'A return needs at least one item.' USING ERRCODE = 'check_violation';
    END IF;
    SELECT * INTO v_ret FROM public.returns WHERE id = v_id;
    IF FOUND THEN RETURN v_ret; END IF;

    v_total := COALESCE((p_return ->> 'total_amount')::NUMERIC,
                        (SELECT sum((it ->> 'amount')::NUMERIC) FROM jsonb_array_elements(p_items) AS t(it)));
    v_refund := COALESCE((p_return ->> 'refund_amount')::NUMERIC, CASE WHEN v_kind = 'return' THEN v_total ELSE 0 END);

    INSERT INTO public.returns (id, shop_id, bill_id, kind, exchange_bill_id, reason, total_amount, refund_amount,
        refund_method, refund_status, notes, returned_at)
    VALUES (v_id,
        COALESCE(NULLIF(p_return ->> 'shop_id', '')::UUID, private.default_shop_id()),
        (p_return ->> 'bill_id')::UUID,
        v_kind,
        NULLIF(p_return ->> 'exchange_bill_id', '')::UUID,
        p_return ->> 'reason',
        v_total,
        v_refund,
        p_return ->> 'refund_method',
        COALESCE(p_return ->> 'refund_status', CASE WHEN v_refund > 0 THEN 'refunded' ELSE 'not_required' END),
        p_return ->> 'notes',
        COALESCE((p_return ->> 'returned_at')::TIMESTAMPTZ, now()))
    RETURNING * INTO v_ret;

    INSERT INTO public.return_items (id, shop_id, return_id, bill_id, bill_item_id, quantity, amount, restock, reason)
    SELECT COALESCE(NULLIF(it ->> 'id', '')::UUID, gen_random_uuid()), v_ret.shop_id, v_ret.id, v_ret.bill_id,
           (it ->> 'bill_item_id')::UUID, (it ->> 'quantity')::INTEGER, (it ->> 'amount')::NUMERIC,
           COALESCE((it ->> 'restock')::BOOLEAN, TRUE), it ->> 'reason'
      FROM jsonb_array_elements(p_items) AS t(it);

    SET CONSTRAINTS public.returns_check_totals, public.return_items_check_totals IMMEDIATE;
    RETURN v_ret;
END $$;

-- ==============================================================================
-- 10. Row Level Security: a signed-in user reaches only the shops they are a member of
-- ==============================================================================
DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['shops','shop_members','bill_counters','products','product_variants','customers',
                             'bills','bill_items','returns','return_items','stock_movements'] LOOP
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    END LOOP;
    -- Products, variants and customers: members can read, add, change and remove
    FOREACH t IN ARRAY ARRAY['products','product_variants','customers'] LOOP
        EXECUTE format('DROP POLICY IF EXISTS "Shop members" ON public.%I', t);
        EXECUTE format('CREATE POLICY "Shop members" ON public.%I FOR ALL TO authenticated
            USING (shop_id IN (SELECT private.my_shop_ids())) WITH CHECK (shop_id IN (SELECT private.my_shop_ids()))', t);
    END LOOP;
    -- Everything with a shop_id: members can read
    FOREACH t IN ARRAY ARRAY['bill_counters','bills','bill_items','returns','return_items','stock_movements'] LOOP
        EXECUTE format('DROP POLICY IF EXISTS "Shop members read" ON public.%I', t);
        EXECUTE format('CREATE POLICY "Shop members read" ON public.%I FOR SELECT TO authenticated
            USING (shop_id IN (SELECT private.my_shop_ids()))', t);
    END LOOP;
    -- Bills, bill items, returns and return items: members can add (no deleting; edits are limited by triggers)
    FOREACH t IN ARRAY ARRAY['bills','bill_items','returns','return_items'] LOOP
        EXECUTE format('DROP POLICY IF EXISTS "Shop members add" ON public.%I', t);
        EXECUTE format('CREATE POLICY "Shop members add" ON public.%I FOR INSERT TO authenticated
            WITH CHECK (shop_id IN (SELECT private.my_shop_ids()))', t);
    END LOOP;
    FOREACH t IN ARRAY ARRAY['bills','returns'] LOOP
        EXECUTE format('DROP POLICY IF EXISTS "Shop members change" ON public.%I', t);
        EXECUTE format('CREATE POLICY "Shop members change" ON public.%I FOR UPDATE TO authenticated
            USING (shop_id IN (SELECT private.my_shop_ids())) WITH CHECK (shop_id IN (SELECT private.my_shop_ids()))', t);
    END LOOP;
END $$;

DROP POLICY IF EXISTS "Members read their shops" ON public.shops;
CREATE POLICY "Members read their shops" ON public.shops FOR SELECT TO authenticated
    USING (owner_id = (SELECT auth.uid()) OR id IN (SELECT private.my_shop_ids()));
DROP POLICY IF EXISTS "Users create their own shop" ON public.shops;
CREATE POLICY "Users create their own shop" ON public.shops FOR INSERT TO authenticated
    WITH CHECK (owner_id = (SELECT auth.uid()));
DROP POLICY IF EXISTS "Owners change their shop" ON public.shops;
CREATE POLICY "Owners change their shop" ON public.shops FOR UPDATE TO authenticated
    USING (owner_id = (SELECT auth.uid())) WITH CHECK (owner_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "Users read their memberships" ON public.shop_members;
CREATE POLICY "Users read their memberships" ON public.shop_members FOR SELECT TO authenticated
    USING (user_id = (SELECT auth.uid()));

-- The app adds only opening stock, stock in and adjustments; sales, cancels and returns come from bills and returns
DROP POLICY IF EXISTS "Shop members add stock" ON public.stock_movements;
CREATE POLICY "Shop members add stock" ON public.stock_movements FOR INSERT TO authenticated
    WITH CHECK (shop_id IN (SELECT private.my_shop_ids())
                AND movement_type IN ('OPENING_STOCK', 'STOCK_IN', 'ADJUSTMENT')
                AND created_by = (SELECT auth.uid()));

-- ==============================================================================
-- 11. Table and function access
--     Signed-out visitors get nothing. Signed-in users get only what the rules above allow,
--     and never delete bills, returns or stock history, or edit bill items and stock history.
-- ==============================================================================
REVOKE ALL ON TABLE public.shops, public.shop_members, public.bill_counters, public.products, public.product_variants,
    public.customers, public.bills, public.bill_items, public.returns, public.return_items, public.stock_movements,
    public.variant_stock, public.variant_catalog FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.shops TO authenticated;
GRANT SELECT ON TABLE public.shop_members, public.bill_counters TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.products, public.product_variants, public.customers TO authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.bills, public.returns TO authenticated;
GRANT SELECT, INSERT ON TABLE public.bill_items, public.return_items, public.stock_movements TO authenticated;
GRANT SELECT ON TABLE public.variant_stock, public.variant_catalog TO authenticated;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA private FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.my_shop_ids(), private.default_shop_id() TO authenticated;
REVOKE ALL ON FUNCTION public.create_bill(JSONB, JSONB), public.create_return(JSONB, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_bill(JSONB, JSONB), public.create_return(JSONB, JSONB) TO authenticated;

-- ==============================================================================
-- 12. Realtime: changes reach the shop's other signed-in devices (row security still applies)
-- ==============================================================================
DO $$
DECLARE t TEXT;
BEGIN
    IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
        FOREACH t IN ARRAY ARRAY['shops','products','product_variants','customers','bills','bill_items',
                                 'returns','return_items','stock_movements'] LOOP
            IF NOT EXISTS (SELECT 1 FROM pg_publication_tables
                           WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = t) THEN
                EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
            END IF;
        END LOOP;
    END IF;
END $$;
