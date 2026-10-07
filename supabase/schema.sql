-- ==============================================================================
-- Hangtag Database Schema for Supabase (PostgreSQL)
-- Run this complete script in your Supabase project's SQL Editor (SQL Editor -> New Query).
-- It is safe to run again. If anything fails, nothing is changed.
--
-- Every account has its own shop: its own profile, products, variants (any options: colour, size, storage...),
-- stock history, supplier bills, bills (with their discounts, GST and payments), cash and bank books, returns,
-- customers, bills sent to customers, events, logo and settings. Nobody can see or change another account's data.
-- A shop's owner can add staff (section 3i): each works in that one shop, from enrolled devices, within its role.
-- The first run of the variant upgrade keeps a copy of the old product, size and bill tables
-- (hangtag_backup_v2_*), the first run of the options upgrade keeps a copy of products and variants
-- (hangtag_backup_v3_*), and the script ends with a migration report you can check.
--
-- Sign-in setup (do these first):
--  1. Google Cloud Console -> APIs & Services -> Credentials -> your OAuth client (Web application)
--     -> Authorized redirect URIs: https://<project-ref>.supabase.co/auth/v1/callback
--  2. Supabase -> Authentication -> Sign In / Providers -> Google: on, with that client ID and secret.
--     Other services (Microsoft, Apple, GitHub, Facebook...) show up in the app when you switch them on here.
--  3. Supabase -> Authentication -> Sign In / Providers -> Email: ON, with "Confirm email" ON.
--     The confirmation email proves the person owns the address. Without it, someone could create an
--     account with another person's email before they do, and get into their shop when they later use Google.
--  4. Supabase -> Authentication -> Emails -> SMTP Settings: set up your own email sender (for example
--     Brevo, Resend or a Gmail app password), with sender name "Hangtag". Supabase's built-in sender only
--     reaches your own team's addresses and about 2 emails an hour. Then edit the email templates' wording.
--     Optional, so links work in any browser: point the Confirm signup link at
--       {{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=email   and Reset password at
--       {{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=recovery
--  5. Supabase -> Authentication -> URL Configuration: Site URL = the app address;
--     Redirect URLs = every address the app is opened from (GitHub Pages and http://localhost:3000/).
--  6. Sign in to the app once with the owner account below, then run this script.
-- ==============================================================================

-- Existing products and bills (from before accounts were separate) go to this account.
-- Change the email if you sign in with a different one.
SELECT set_config('hangtag.owner_email', 'florixenergy@gmail.com', false);

-- ==============================================================================
-- 1. Profiles: one row per account, made automatically when someone signs in the first time
-- ==============================================================================
CREATE TABLE IF NOT EXISTS public.hangtag_profiles (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    email TEXT,
    full_name TEXT,
    avatar_url TEXT,
    shop_name TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ
);

CREATE OR REPLACE FUNCTION public.hangtag_handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
    INSERT INTO public.hangtag_profiles (id, email, full_name, avatar_url)
    VALUES (
        NEW.id,
        NEW.email,
        COALESCE(NEW.raw_user_meta_data ->> 'full_name', NEW.raw_user_meta_data ->> 'name'),
        COALESCE(NEW.raw_user_meta_data ->> 'avatar_url', NEW.raw_user_meta_data ->> 'picture')
    )
    ON CONFLICT (id) DO NOTHING;
    RETURN NEW;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.hangtag_handle_new_user() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS hangtag_on_auth_user_created ON auth.users;
CREATE TRIGGER hangtag_on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION public.hangtag_handle_new_user();

-- Shop details asked for on first sign-in (the same for Google and email accounts)
ALTER TABLE public.hangtag_profiles ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE public.hangtag_profiles ADD COLUMN IF NOT EXISTS city TEXT;
ALTER TABLE public.hangtag_profiles ADD COLUMN IF NOT EXISTS state TEXT;
ALTER TABLE public.hangtag_profiles ADD COLUMN IF NOT EXISTS address TEXT;
ALTER TABLE public.hangtag_profiles ADD COLUMN IF NOT EXISTS business_type TEXT;
ALTER TABLE public.hangtag_profiles ADD COLUMN IF NOT EXISTS gstin TEXT;
ALTER TABLE public.hangtag_profiles ADD COLUMN IF NOT EXISTS onboarded_at TIMESTAMPTZ;
ALTER TABLE public.hangtag_profiles ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hangtag_profiles_sizes_check') THEN
        ALTER TABLE public.hangtag_profiles ADD CONSTRAINT hangtag_profiles_sizes_check CHECK (
            coalesce(char_length(full_name), 0) <= 80 AND coalesce(char_length(shop_name), 0) <= 80 AND
            coalesce(char_length(phone), 0) <= 20 AND coalesce(char_length(city), 0) <= 60 AND
            coalesce(char_length(state), 0) <= 60 AND coalesce(char_length(address), 0) <= 200 AND
            coalesce(char_length(business_type), 0) <= 40 AND coalesce(char_length(avatar_url), 0) <= 500 AND
            (gstin IS NULL OR gstin ~ '^[0-9]{2}[A-Z0-9]{10}[0-9A-Z]{3}$'));
    END IF;
END $$;

-- How an email address signs in today, so the app can send a Google user to Google instead of making a
-- second account. Returns e.g. {google}, {email}, {email,google}, or {} for someone new.
-- Note: this lets anyone check whether an email has a Hangtag account (the app needs it before sign-in).
CREATE OR REPLACE FUNCTION public.hangtag_sign_in_methods(p_email TEXT)
RETURNS TEXT[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
    SELECT coalesce(array_agg(DISTINCT i.provider ORDER BY i.provider), '{}'::TEXT[])
    FROM auth.users u
    JOIN auth.identities i ON i.user_id = u.id
    WHERE lower(u.email) = lower(btrim(p_email));
$$;
REVOKE EXECUTE ON FUNCTION public.hangtag_sign_in_methods(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.hangtag_sign_in_methods(TEXT) TO anon, authenticated;

-- Profiles for accounts that already exist
INSERT INTO public.hangtag_profiles (id, email, full_name, avatar_url)
SELECT u.id, u.email,
       COALESCE(u.raw_user_meta_data ->> 'full_name', u.raw_user_meta_data ->> 'name'),
       COALESCE(u.raw_user_meta_data ->> 'avatar_url', u.raw_user_meta_data ->> 'picture')
FROM auth.users u
ON CONFLICT (id) DO NOTHING;

-- ==============================================================================
-- 2. Shop tables. Every row has an owner_id: the account it belongs to.
--    owner_id fills itself in from the signed-in account, so the app never sends it.
-- ==============================================================================
CREATE TABLE IF NOT EXISTS public.hangtag_products (
    owner_id UUID NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    name TEXT NOT NULL,
    price INTEGER NOT NULL DEFAULT 0,
    color TEXT DEFAULT '#8E8A83',
    sort_order INTEGER DEFAULT 0,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (owner_id, id)
);

-- Sizes and how many pieces were received
CREATE TABLE IF NOT EXISTS public.hangtag_sizes (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    owner_id UUID NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
    product_id TEXT NOT NULL,
    size TEXT NOT NULL,
    stock INTEGER NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT hangtag_sizes_owner_product_size_key UNIQUE (owner_id, product_id, size),
    CONSTRAINT hangtag_sizes_product_fkey FOREIGN KEY (owner_id, product_id)
        REFERENCES public.hangtag_products (owner_id, id) ON DELETE CASCADE
);

-- Product photos (small thumbnails stored as data URLs)
CREATE TABLE IF NOT EXISTS public.hangtag_images (
    owner_id UUID NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
    product_id TEXT NOT NULL,
    image_data TEXT NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (owner_id, product_id),
    CONSTRAINT hangtag_images_product_fkey FOREIGN KEY (owner_id, product_id)
        REFERENCES public.hangtag_products (owner_id, id) ON DELETE CASCADE
);

-- Bills
CREATE TABLE IF NOT EXISTS public.hangtag_sales (
    owner_id UUID NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    timestamp BIGINT NOT NULL,
    subtotal INTEGER NOT NULL DEFAULT 0,
    discount INTEGER NOT NULL DEFAULT 0,
    total INTEGER NOT NULL DEFAULT 0,
    payment_method TEXT NOT NULL,
    device_id TEXT,
    is_void BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (owner_id, id)
);

-- Bill lines. line_no keeps one row per line, so uploading a bill twice never duplicates it.
CREATE TABLE IF NOT EXISTS public.hangtag_sale_items (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    owner_id UUID NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
    sale_id TEXT NOT NULL,
    line_no INTEGER NOT NULL DEFAULT 0,
    product_id TEXT NOT NULL,
    product_name TEXT NOT NULL,
    size TEXT NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 1,
    unit_price INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT hangtag_sale_items_owner_sale_line_key UNIQUE (owner_id, sale_id, line_no),
    CONSTRAINT hangtag_sale_items_sale_fkey FOREIGN KEY (owner_id, sale_id)
        REFERENCES public.hangtag_sales (owner_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS public.hangtag_meta (
    owner_id UUID NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    value JSONB,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (owner_id, key)
);

-- ==============================================================================
-- 3. Upgrade a database made by an older version of this script (does nothing on a new one)
-- ==============================================================================
ALTER TABLE public.hangtag_sale_items ADD COLUMN IF NOT EXISTS line_no INTEGER NOT NULL DEFAULT 0;
ALTER TABLE public.hangtag_products   ADD COLUMN IF NOT EXISTS owner_id UUID;
ALTER TABLE public.hangtag_sizes      ADD COLUMN IF NOT EXISTS owner_id UUID;
ALTER TABLE public.hangtag_images     ADD COLUMN IF NOT EXISTS owner_id UUID;
ALTER TABLE public.hangtag_sales      ADD COLUMN IF NOT EXISTS owner_id UUID;
ALTER TABLE public.hangtag_sale_items ADD COLUMN IF NOT EXISTS owner_id UUID;
ALTER TABLE public.hangtag_meta       ADD COLUMN IF NOT EXISTS owner_id UUID;

-- Give rows with no owner to the owner account named at the top
DO $$
DECLARE
    t TEXT;
    n BIGINT;
    missing BIGINT := 0;
    v_email TEXT := current_setting('hangtag.owner_email', true);
    v_owner UUID;
BEGIN
    FOREACH t IN ARRAY ARRAY['hangtag_products','hangtag_sizes','hangtag_images','hangtag_sales','hangtag_sale_items','hangtag_meta'] LOOP
        EXECUTE format('SELECT count(*) FROM public.%I WHERE owner_id IS NULL', t) INTO n;
        missing := missing + n;
    END LOOP;
    IF missing > 0 THEN
        SELECT id INTO v_owner FROM auth.users WHERE lower(email) = lower(v_email) ORDER BY created_at LIMIT 1;
        IF v_owner IS NULL THEN
            RAISE EXCEPTION 'Your existing products and bills need an owner, but no account with the email % has signed in yet. Sign in to Hangtag once with that account (or change the email at the top of this script), then run it again. Nothing was changed.', v_email;
        END IF;
        FOREACH t IN ARRAY ARRAY['hangtag_products','hangtag_sizes','hangtag_images','hangtag_sales','hangtag_sale_items','hangtag_meta'] LOOP
            EXECUTE format('UPDATE public.%I SET owner_id = $1 WHERE owner_id IS NULL', t) USING v_owner;
        END LOOP;
        RAISE NOTICE 'Gave % existing rows to %', missing, v_email;
    END IF;
END $$;

-- owner_id: required, filled from the signed-in account, removed with the account
DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['hangtag_products','hangtag_sizes','hangtag_images','hangtag_sales','hangtag_sale_items','hangtag_meta'] LOOP
        EXECUTE format('ALTER TABLE public.%I ALTER COLUMN owner_id SET DEFAULT auth.uid(), ALTER COLUMN owner_id SET NOT NULL', t);
        IF NOT EXISTS (
            SELECT 1 FROM pg_constraint c
            WHERE c.conrelid = format('public.%I', t)::regclass AND c.contype = 'f'
              AND c.confrelid = 'auth.users'::regclass
        ) THEN
            EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (owner_id) REFERENCES auth.users(id) ON DELETE CASCADE', t, t || '_owner_fkey');
        END IF;
    END LOOP;
END $$;

-- Swap the old one-shop keys for per-account keys
DO $$
DECLARE t TEXT;
BEGIN
    -- Old links between tables (they block the key change)
    ALTER TABLE public.hangtag_sizes      DROP CONSTRAINT IF EXISTS hangtag_sizes_product_id_fkey;
    ALTER TABLE public.hangtag_sizes      DROP CONSTRAINT IF EXISTS hangtag_sizes_product_id_size_key;
    ALTER TABLE public.hangtag_images     DROP CONSTRAINT IF EXISTS hangtag_images_product_id_fkey;
    ALTER TABLE public.hangtag_sale_items DROP CONSTRAINT IF EXISTS hangtag_sale_items_sale_id_fkey;
    DROP INDEX IF EXISTS public.uq_hangtag_sale_items_line;

    -- Primary keys that don't include owner_id yet
    FOREACH t IN ARRAY ARRAY['hangtag_products','hangtag_images','hangtag_sales','hangtag_meta'] LOOP
        IF NOT EXISTS (
            SELECT 1 FROM pg_index i
            JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
            WHERE i.indrelid = format('public.%I', t)::regclass AND i.indisprimary AND a.attname = 'owner_id'
        ) THEN
            EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT IF EXISTS %I', t, t || '_pkey');
            EXECUTE format('ALTER TABLE public.%I ADD PRIMARY KEY (owner_id, %I)', t,
                CASE t WHEN 'hangtag_images' THEN 'product_id' WHEN 'hangtag_meta' THEN 'key' ELSE 'id' END);
        END IF;
    END LOOP;

    -- New per-account links and unique rules
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hangtag_sizes_owner_product_size_key') THEN
        ALTER TABLE public.hangtag_sizes ADD CONSTRAINT hangtag_sizes_owner_product_size_key UNIQUE (owner_id, product_id, size);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hangtag_sizes_product_fkey') THEN
        ALTER TABLE public.hangtag_sizes ADD CONSTRAINT hangtag_sizes_product_fkey FOREIGN KEY (owner_id, product_id)
            REFERENCES public.hangtag_products (owner_id, id) ON DELETE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hangtag_images_product_fkey') THEN
        ALTER TABLE public.hangtag_images ADD CONSTRAINT hangtag_images_product_fkey FOREIGN KEY (owner_id, product_id)
            REFERENCES public.hangtag_products (owner_id, id) ON DELETE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hangtag_sale_items_owner_sale_line_key') THEN
        ALTER TABLE public.hangtag_sale_items ADD CONSTRAINT hangtag_sale_items_owner_sale_line_key UNIQUE (owner_id, sale_id, line_no);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hangtag_sale_items_sale_fkey') THEN
        ALTER TABLE public.hangtag_sale_items ADD CONSTRAINT hangtag_sale_items_sale_fkey FOREIGN KEY (owner_id, sale_id)
            REFERENCES public.hangtag_sales (owner_id, id) ON DELETE CASCADE;
    END IF;
END $$;

-- ==============================================================================
-- 3b. Variants (every colour + size), stock history, customers, returns and exchanges
--     Stock is never stored as a single number that could drift. For each variant it is:
--       opening + stock in + adjustments (hangtag_stock_moves)
--       − pieces on bills that aren't cancelled (hangtag_sale_items)
--       + pieces returned (hangtag_return_items)
-- ==============================================================================

-- Safety copy of the tables this upgrade changes, made once, the first time it runs.
-- These copies can't be read through the app or the API (row security on, no rules).
DO $$
BEGIN
    IF to_regclass('public.hangtag_backup_v2_products') IS NULL THEN
        CREATE TABLE public.hangtag_backup_v2_products AS TABLE public.hangtag_products;
        CREATE TABLE public.hangtag_backup_v2_sizes AS TABLE public.hangtag_sizes;
        CREATE TABLE public.hangtag_backup_v2_sales AS TABLE public.hangtag_sales;
        CREATE TABLE public.hangtag_backup_v2_sale_items AS TABLE public.hangtag_sale_items;
        ALTER TABLE public.hangtag_backup_v2_products ENABLE ROW LEVEL SECURITY;
        ALTER TABLE public.hangtag_backup_v2_sizes ENABLE ROW LEVEL SECURITY;
        ALTER TABLE public.hangtag_backup_v2_sales ENABLE ROW LEVEL SECURITY;
        ALTER TABLE public.hangtag_backup_v2_sale_items ENABLE ROW LEVEL SECURITY;
        REVOKE ALL ON TABLE public.hangtag_backup_v2_products, public.hangtag_backup_v2_sizes,
            public.hangtag_backup_v2_sales, public.hangtag_backup_v2_sale_items FROM anon, authenticated;
    END IF;
END $$;

-- Products: category, brand, description, cost price, archive, and the order of colours and sizes
ALTER TABLE public.hangtag_products ADD COLUMN IF NOT EXISTS category TEXT;
ALTER TABLE public.hangtag_products ADD COLUMN IF NOT EXISTS brand TEXT;
ALTER TABLE public.hangtag_products ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE public.hangtag_products ADD COLUMN IF NOT EXISTS cost_price INTEGER;
ALTER TABLE public.hangtag_products ADD COLUMN IF NOT EXISTS archived BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE public.hangtag_products ADD COLUMN IF NOT EXISTS options JSONB NOT NULL DEFAULT '{}'::jsonb;

-- One row per colour + size of a product. SKU and barcode belong to the variant.
CREATE TABLE IF NOT EXISTS public.hangtag_variants (
    owner_id UUID NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    product_id TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT '',
    size TEXT NOT NULL DEFAULT '',
    sku TEXT,
    barcode TEXT,
    price INTEGER CHECK (price IS NULL OR price >= 0),
    cost_price INTEGER CHECK (cost_price IS NULL OR cost_price >= 0),
    active BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order INTEGER DEFAULT 0,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (owner_id, id),
    CONSTRAINT hangtag_variants_product_fkey FOREIGN KEY (owner_id, product_id)
        REFERENCES public.hangtag_products (owner_id, id) ON DELETE CASCADE
);
-- SKU and barcode are unique within each shop (not across shops)
CREATE UNIQUE INDEX IF NOT EXISTS uq_hangtag_variants_sku ON public.hangtag_variants (owner_id, lower(sku)) WHERE sku IS NOT NULL AND sku <> '';
CREATE UNIQUE INDEX IF NOT EXISTS uq_hangtag_variants_barcode ON public.hangtag_variants (owner_id, barcode) WHERE barcode IS NOT NULL AND barcode <> '';
-- One variant per combination of option values: uq_hangtag_variants_options (section 3c). It replaced the
-- colour + size rule, which can't hold once products have other options (e.g. Storage: 64 GB, 128 GB).
CREATE INDEX IF NOT EXISTS idx_hangtag_variants_product ON public.hangtag_variants (owner_id, product_id);

-- Stock history: opening stock, stock in (with optional cost), adjustments (with a reason)
CREATE TABLE IF NOT EXISTS public.hangtag_stock_moves (
    owner_id UUID NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    variant_id TEXT NOT NULL,
    product_id TEXT,
    type TEXT NOT NULL CHECK (type IN ('OPENING','RESTOCK','ADJUST')),
    qty INTEGER NOT NULL,
    cost_price INTEGER CHECK (cost_price IS NULL OR cost_price >= 0),
    note TEXT CHECK (note IS NULL OR char_length(note) <= 200),
    t BIGINT NOT NULL,
    device_id TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (owner_id, id),
    CONSTRAINT hangtag_stock_moves_variant_fkey FOREIGN KEY (owner_id, variant_id)
        REFERENCES public.hangtag_variants (owner_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_hangtag_moves_variant ON public.hangtag_stock_moves (owner_id, variant_id);

-- Bills: number, customer, GST, and exchange details. Bill lines: the exact variant, plus copies of
-- colour, SKU and cost at the time of sale, so old bills and profit never change when products are edited.
ALTER TABLE public.hangtag_sales ADD COLUMN IF NOT EXISTS bill_no TEXT;
ALTER TABLE public.hangtag_sales ADD COLUMN IF NOT EXISTS customer_id TEXT;
ALTER TABLE public.hangtag_sales ADD COLUMN IF NOT EXISTS customer_name TEXT;
ALTER TABLE public.hangtag_sales ADD COLUMN IF NOT EXISTS customer_phone TEXT;
ALTER TABLE public.hangtag_sales ADD COLUMN IF NOT EXISTS tax_rate NUMERIC(5,2) NOT NULL DEFAULT 0;
ALTER TABLE public.hangtag_sales ADD COLUMN IF NOT EXISTS tax_amount INTEGER NOT NULL DEFAULT 0;
ALTER TABLE public.hangtag_sales ADD COLUMN IF NOT EXISTS tax_inclusive BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE public.hangtag_sales ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'sale';
ALTER TABLE public.hangtag_sales ADD COLUMN IF NOT EXISTS exchange_id TEXT;
ALTER TABLE public.hangtag_sales ADD COLUMN IF NOT EXISTS credit INTEGER NOT NULL DEFAULT 0;
ALTER TABLE public.hangtag_sale_items ADD COLUMN IF NOT EXISTS variant_id TEXT;
ALTER TABLE public.hangtag_sale_items ADD COLUMN IF NOT EXISTS color TEXT NOT NULL DEFAULT '';
ALTER TABLE public.hangtag_sale_items ADD COLUMN IF NOT EXISTS sku TEXT;
ALTER TABLE public.hangtag_sale_items ADD COLUMN IF NOT EXISTS cost_price INTEGER;
CREATE INDEX IF NOT EXISTS idx_hangtag_sale_items_variant ON public.hangtag_sale_items (owner_id, variant_id);
CREATE INDEX IF NOT EXISTS idx_hangtag_sales_customer ON public.hangtag_sales (owner_id, customer_id);

-- Customers (optional on a bill)
CREATE TABLE IF NOT EXISTS public.hangtag_customers (
    owner_id UUID NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
    phone TEXT CHECK (phone IS NULL OR char_length(phone) <= 20),
    email TEXT CHECK (email IS NULL OR char_length(email) <= 120),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (owner_id, id)
);
CREATE INDEX IF NOT EXISTS idx_hangtag_customers_phone ON public.hangtag_customers (owner_id, phone);

-- Returns and exchanges, always linked to the original bill
CREATE TABLE IF NOT EXISTS public.hangtag_returns (
    owner_id UUID NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    sale_id TEXT NOT NULL,
    t BIGINT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'return' CHECK (kind IN ('return','exchange')),
    exchange_id TEXT,
    refund_amount INTEGER NOT NULL DEFAULT 0 CHECK (refund_amount >= 0),
    refund_method TEXT,
    value INTEGER NOT NULL DEFAULT 0 CHECK (value >= 0),
    note TEXT CHECK (note IS NULL OR char_length(note) <= 200),
    device_id TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (owner_id, id),
    CONSTRAINT hangtag_returns_sale_fkey FOREIGN KEY (owner_id, sale_id)
        REFERENCES public.hangtag_sales (owner_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_hangtag_returns_sale ON public.hangtag_returns (owner_id, sale_id);
CREATE TABLE IF NOT EXISTS public.hangtag_return_items (
    owner_id UUID NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
    return_id TEXT NOT NULL,
    line_no INTEGER NOT NULL,
    sale_id TEXT NOT NULL,
    sale_line_no INTEGER NOT NULL,
    variant_id TEXT,
    product_id TEXT,
    product_name TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT '',
    size TEXT NOT NULL DEFAULT '',
    sku TEXT,
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    unit_price NUMERIC(12,2) NOT NULL DEFAULT 0,
    value INTEGER NOT NULL DEFAULT 0,
    cost_price INTEGER,
    PRIMARY KEY (owner_id, return_id, line_no),
    CONSTRAINT hangtag_return_items_return_fkey FOREIGN KEY (owner_id, return_id)
        REFERENCES public.hangtag_returns (owner_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_hangtag_return_items_line ON public.hangtag_return_items (owner_id, sale_id, sale_line_no);

-- The database itself refuses to return more of a bill line than was bought
CREATE OR REPLACE FUNCTION public.hangtag_check_return_qty()
RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = ''
AS $$
DECLARE
    bought INTEGER;
    already INTEGER;
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
        RAISE EXCEPTION 'Can''t return % piece(s): % bought, % already returned', NEW.quantity, bought, already USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS hangtag_return_qty ON public.hangtag_return_items;
CREATE TRIGGER hangtag_return_qty BEFORE INSERT OR UPDATE ON public.hangtag_return_items
    FOR EACH ROW EXECUTE FUNCTION public.hangtag_check_return_qty();

-- ---------- Move existing size-based products to variants (only products that have no variants yet) ----------
-- Each old size becomes a variant with id "<product id>:<size>" and no colour; its stock becomes an opening
-- stock record. The app on each device uses the same ids, so nothing is counted twice.
INSERT INTO public.hangtag_variants (owner_id, id, product_id, color, size, sort_order)
SELECT s.owner_id, s.product_id || ':' || s.size, s.product_id, '', s.size,
       row_number() OVER (PARTITION BY s.owner_id, s.product_id ORDER BY s.size)
FROM public.hangtag_sizes s
JOIN public.hangtag_products p ON p.owner_id = s.owner_id AND p.id = s.product_id
WHERE NOT EXISTS (SELECT 1 FROM public.hangtag_variants v WHERE v.owner_id = s.owner_id AND v.product_id = s.product_id)
ON CONFLICT DO NOTHING;
-- products that had no sizes at all get one plain variant
INSERT INTO public.hangtag_variants (owner_id, id, product_id, color, size)
SELECT p.owner_id, p.id || ':', p.id, '', ''
FROM public.hangtag_products p
WHERE NOT EXISTS (SELECT 1 FROM public.hangtag_variants v WHERE v.owner_id = p.owner_id AND v.product_id = p.id)
ON CONFLICT DO NOTHING;
-- size order for migrated products (S, M, L … then numbers, then anything else)
-- (a product with no option lists whose variants have colours or are switched off gets its lists in 3c instead)
UPDATE public.hangtag_products p
SET options = jsonb_build_object('colors', '[]'::jsonb, 'sizes', COALESCE((
        SELECT jsonb_agg(v.size ORDER BY COALESCE(array_position(ARRAY['XXS','XS','S','M','L','XL','XXL','2XL','XXXL','3XL','4XL','5XL'], upper(v.size))::numeric,
                                                   CASE WHEN v.size ~ '^[0-9]+(\.[0-9]+)?$' THEN 100 + v.size::numeric ELSE 1000 END), v.size)
        FROM public.hangtag_variants v WHERE v.owner_id = p.owner_id AND v.product_id = p.id AND v.size <> ''), '[]'::jsonb))
WHERE (p.options IS NULL OR p.options = '{}'::jsonb)
  AND NOT EXISTS (SELECT 1 FROM public.hangtag_variants v WHERE v.owner_id = p.owner_id AND v.product_id = p.id AND (v.color <> '' OR NOT v.active));
-- opening stock = pieces received under the old size list (so pieces in hand stay exactly the same)
INSERT INTO public.hangtag_stock_moves (owner_id, id, variant_id, product_id, type, qty, note, t)
SELECT s.owner_id, 'open:' || s.product_id || ':' || s.size, s.product_id || ':' || s.size, s.product_id, 'OPENING', s.stock,
       'Opening stock (moved from the old size list)', (extract(epoch FROM now()) * 1000)::bigint
FROM public.hangtag_sizes s
WHERE s.stock <> 0
  AND EXISTS (SELECT 1 FROM public.hangtag_variants v WHERE v.owner_id = s.owner_id AND v.id = s.product_id || ':' || s.size)
ON CONFLICT DO NOTHING;
-- old bill lines point at their variant (names, sizes and prices on the bill are not touched)
UPDATE public.hangtag_sale_items si
SET variant_id = si.product_id || ':' || si.size
WHERE si.variant_id IS NULL
  AND EXISTS (SELECT 1 FROM public.hangtag_variants v WHERE v.owner_id = si.owner_id AND v.id = si.product_id || ':' || si.size);

-- ==============================================================================
-- 3c. Any options (colour, size, storage, RAM …), HSN / GST rate, barcode or QR code, supplier bills
--     A product has up to 3 options; each variant stores its values in option_values (["Black","M"]), in the order of
--     the product's options (options.opts). color/size stay as copies for older app versions still open on a phone.
-- ==============================================================================
DO $$
BEGIN
    IF to_regclass('public.hangtag_backup_v3_products') IS NULL
       AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'hangtag_variants' AND column_name = 'option_values') THEN
        CREATE TABLE public.hangtag_backup_v3_products AS TABLE public.hangtag_products;
        CREATE TABLE public.hangtag_backup_v3_variants AS TABLE public.hangtag_variants;
        ALTER TABLE public.hangtag_backup_v3_products ENABLE ROW LEVEL SECURITY;
        ALTER TABLE public.hangtag_backup_v3_variants ENABLE ROW LEVEL SECURITY;
        REVOKE ALL ON TABLE public.hangtag_backup_v3_products, public.hangtag_backup_v3_variants FROM anon, authenticated;
    END IF;
END $$;

ALTER TABLE public.hangtag_products ADD COLUMN IF NOT EXISTS hsn TEXT;
ALTER TABLE public.hangtag_products ADD COLUMN IF NOT EXISTS gst_rate NUMERIC(5,2);
ALTER TABLE public.hangtag_products ADD COLUMN IF NOT EXISTS code_type TEXT;
ALTER TABLE public.hangtag_products DROP CONSTRAINT IF EXISTS hangtag_products_hsn_check;
ALTER TABLE public.hangtag_products ADD CONSTRAINT hangtag_products_hsn_check CHECK (hsn IS NULL OR hsn ~ '^[0-9]{4}([0-9]{2}){0,2}$');
ALTER TABLE public.hangtag_products DROP CONSTRAINT IF EXISTS hangtag_products_gst_rate_check;
ALTER TABLE public.hangtag_products ADD CONSTRAINT hangtag_products_gst_rate_check CHECK (gst_rate IS NULL OR gst_rate BETWEEN 0 AND 100);
ALTER TABLE public.hangtag_products DROP CONSTRAINT IF EXISTS hangtag_products_code_type_check;
ALTER TABLE public.hangtag_products ADD CONSTRAINT hangtag_products_code_type_check CHECK (code_type IS NULL OR code_type IN ('barcode','qr'));

ALTER TABLE public.hangtag_variants ADD COLUMN IF NOT EXISTS option_values JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE public.hangtag_variants DROP CONSTRAINT IF EXISTS hangtag_variants_option_values_check;
ALTER TABLE public.hangtag_variants ADD CONSTRAINT hangtag_variants_option_values_check CHECK (jsonb_typeof(option_values) = 'array');
DROP INDEX IF EXISTS public.uq_hangtag_variants_combo;

-- Products saved before options existed: colours (then sizes) become options. Same rules as the app's own upgrade:
-- a variant fits ("aligned") when it has a colour exactly when the product has colours, and a size exactly when it has
-- sizes; a variant for sale whose value is missing from the list adds it. A variant that doesn't fit keeps its non-empty
-- values and is switched off (it was already a leftover kept for its history). A clash gets " (2)" on its last value.
DO $$
DECLARE
    p RECORD; v RECORD;
    cl TEXT[]; sl TEXT[]; has_c BOOLEAN; has_s BOOLEAN; c TEXT; s TEXT; ov TEXT[]; act BOOLEAN; seen TEXT[]; k INT;
BEGIN
    FOR p IN SELECT * FROM public.hangtag_products WHERE NOT (COALESCE(options, '{}'::jsonb) ? 'opts') LOOP
        IF NOT (COALESCE(p.options, '{}'::jsonb) ? 'colors') AND NOT (COALESCE(p.options, '{}'::jsonb) ? 'sizes') THEN
            SELECT COALESCE(array_agg(x ORDER BY o), '{}') INTO cl FROM (
                SELECT DISTINCT ON (lower(x)) x, o FROM (
                    SELECT btrim(regexp_replace(color, '\s+', ' ', 'g')) AS x, row_number() OVER (ORDER BY sort_order, id) AS o
                    FROM public.hangtag_variants WHERE owner_id = p.owner_id AND product_id = p.id AND active) a
                WHERE x <> '' ORDER BY lower(x), o) d;
            SELECT COALESCE(array_agg(x ORDER BY o), '{}') INTO sl FROM (
                SELECT DISTINCT ON (lower(x)) x, o FROM (
                    SELECT btrim(regexp_replace(size, '\s+', ' ', 'g')) AS x, row_number() OVER (ORDER BY sort_order, id) AS o
                    FROM public.hangtag_variants WHERE owner_id = p.owner_id AND product_id = p.id AND active) a
                WHERE x <> '' ORDER BY lower(x), o) d;
        ELSE
            SELECT COALESCE(array_agg(x ORDER BY o), '{}') INTO cl FROM (
                SELECT DISTINCT ON (lower(x)) x, o FROM (
                    SELECT btrim(regexp_replace(e, '\s+', ' ', 'g')) AS x, o FROM jsonb_array_elements_text(
                        CASE WHEN jsonb_typeof(p.options -> 'colors') = 'array' THEN p.options -> 'colors' ELSE '[]'::jsonb END) WITH ORDINALITY AS t(e, o)) a
                WHERE x <> '' ORDER BY lower(x), o) d;
            SELECT COALESCE(array_agg(x ORDER BY o), '{}') INTO sl FROM (
                SELECT DISTINCT ON (lower(x)) x, o FROM (
                    SELECT btrim(regexp_replace(e, '\s+', ' ', 'g')) AS x, o FROM jsonb_array_elements_text(
                        CASE WHEN jsonb_typeof(p.options -> 'sizes') = 'array' THEN p.options -> 'sizes' ELSE '[]'::jsonb END) WITH ORDINALITY AS t(e, o)) a
                WHERE x <> '' ORDER BY lower(x), o) d;
        END IF;
        has_c := cardinality(cl) > 0; has_s := cardinality(sl) > 0;
        -- values of variants for sale that the lists miss
        FOR v IN SELECT * FROM public.hangtag_variants WHERE owner_id = p.owner_id AND product_id = p.id AND active ORDER BY sort_order, id LOOP
            c := btrim(regexp_replace(v.color, '\s+', ' ', 'g')); s := btrim(regexp_replace(v.size, '\s+', ' ', 'g'));
            IF has_c = (c <> '') AND has_s = (s <> '') THEN
                IF has_c AND NOT lower(c) = ANY (SELECT lower(x) FROM unnest(cl) x) THEN cl := cl || c; END IF;
                IF has_s AND NOT lower(s) = ANY (SELECT lower(x) FROM unnest(sl) x) THEN sl := sl || s; END IF;
            END IF;
        END LOOP;
        -- tuples: variants for sale first, then switched-off ones that fit, then leftovers
        seen := '{}';
        FOR v IN
            SELECT w.*, CASE WHEN NOT w.al THEN 2 WHEN w.active AND w.fit THEN 0 WHEN w.fit THEN 1 ELSE 2 END AS rk FROM (
                SELECT x.*, (has_c = (x.cc <> '') AND has_s = (x.ss <> '')) AS al,
                       ((NOT has_c OR lower(x.cc) = ANY (SELECT lower(y) FROM unnest(cl) y)) AND (NOT has_s OR lower(x.ss) = ANY (SELECT lower(y) FROM unnest(sl) y))) AS fit
                FROM (SELECT *, btrim(regexp_replace(color, '\s+', ' ', 'g')) AS cc, btrim(regexp_replace(size, '\s+', ' ', 'g')) AS ss
                      FROM public.hangtag_variants WHERE owner_id = p.owner_id AND product_id = p.id) x) w
            ORDER BY rk, sort_order, id
        LOOP
            IF v.al THEN
                ov := '{}';
                IF has_c THEN ov := ov || COALESCE((SELECT y FROM unnest(cl) y WHERE lower(y) = lower(v.cc) LIMIT 1), v.cc); END IF;
                IF has_s THEN ov := ov || COALESCE((SELECT y FROM unnest(sl) y WHERE lower(y) = lower(v.ss) LIMIT 1), v.ss); END IF;
                act := v.active AND v.fit;
            ELSE
                ov := array_remove(ARRAY[v.cc, v.ss], ''); act := FALSE;
            END IF;
            IF lower(array_to_string(ov, chr(1))) = ANY (seen) THEN
                k := 2;
                LOOP
                    EXIT WHEN NOT (lower(array_to_string(
                        CASE WHEN cardinality(ov) = 0 THEN ARRAY['(' || k || ')'] ELSE ov[1:cardinality(ov) - 1] || (ov[cardinality(ov)] || ' (' || k || ')') END, chr(1))) = ANY (seen));
                    k := k + 1;
                END LOOP;
                ov := CASE WHEN cardinality(ov) = 0 THEN ARRAY['(' || k || ')'] ELSE ov[1:cardinality(ov) - 1] || (ov[cardinality(ov)] || ' (' || k || ')') END;
                act := FALSE;
            END IF;
            seen := seen || lower(array_to_string(ov, chr(1)));
            UPDATE public.hangtag_variants SET option_values = to_jsonb(ov), active = act WHERE owner_id = v.owner_id AND id = v.id;
        END LOOP;
        UPDATE public.hangtag_products SET options = jsonb_build_object(
                'opts', (CASE WHEN has_c THEN jsonb_build_array(jsonb_build_object('name', 'Colour', 'values', to_jsonb(cl))) ELSE '[]'::jsonb END)
                     || (CASE WHEN has_s THEN jsonb_build_array(jsonb_build_object('name', 'Size', 'values', to_jsonb(sl))) ELSE '[]'::jsonb END),
                'colors', to_jsonb(cl), 'sizes', to_jsonb(sl))
        WHERE owner_id = p.owner_id AND id = p.id;
    END LOOP;
END $$;

-- One variant per combination of values in each product (case doesn't matter)
CREATE UNIQUE INDEX IF NOT EXISTS uq_hangtag_variants_options ON public.hangtag_variants (owner_id, product_id, lower(option_values::text));

-- An older app version still open on a phone writes only color/size: fill option_values from them
CREATE OR REPLACE FUNCTION public.hangtag_variants_fill_options()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
    IF NEW.option_values = '[]'::jsonb AND (COALESCE(NEW.color, '') <> '' OR COALESCE(NEW.size, '') <> '') THEN
        NEW.option_values := to_jsonb(array_remove(ARRAY[COALESCE(NEW.color, ''), COALESCE(NEW.size, '')], ''));
    END IF;
    RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS hangtag_variants_fill_options ON public.hangtag_variants;
CREATE TRIGGER hangtag_variants_fill_options BEFORE INSERT OR UPDATE ON public.hangtag_variants
    FOR EACH ROW EXECUTE FUNCTION public.hangtag_variants_fill_options();

-- Bill and return lines remember the variant's name and options as sold ("64 GB / Blue")
ALTER TABLE public.hangtag_sale_items ADD COLUMN IF NOT EXISTS variant_label TEXT;
ALTER TABLE public.hangtag_sale_items ADD COLUMN IF NOT EXISTS options JSONB;
ALTER TABLE public.hangtag_return_items ADD COLUMN IF NOT EXISTS variant_label TEXT;
ALTER TABLE public.hangtag_return_items ADD COLUMN IF NOT EXISTS options JSONB;

-- Stock added from a supplier bill points at its import
ALTER TABLE public.hangtag_stock_moves ADD COLUMN IF NOT EXISTS import_id TEXT;
CREATE INDEX IF NOT EXISTS idx_hangtag_moves_import ON public.hangtag_stock_moves (owner_id, import_id);

-- Supplier bills added to stock: one row per confirmed bill (the file's fingerprint and the invoice number spot repeats)
CREATE TABLE IF NOT EXISTS public.hangtag_stock_imports (
    owner_id UUID NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    file_hash TEXT,
    file_name TEXT,
    file_type TEXT,
    supplier_name TEXT,
    supplier_gstin TEXT,
    invoice_no TEXT,
    invoice_date DATE,
    line_count INTEGER NOT NULL DEFAULT 0,
    units INTEGER NOT NULL DEFAULT 0,
    amount NUMERIC(12,2),
    lines JSONB NOT NULL DEFAULT '[]'::jsonb,
    extraction JSONB,
    device_id TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (owner_id, id)
);
CREATE INDEX IF NOT EXISTS idx_hangtag_imports_hash ON public.hangtag_stock_imports (owner_id, file_hash);
CREATE INDEX IF NOT EXISTS idx_hangtag_imports_invoice ON public.hangtag_stock_imports (owner_id, lower(invoice_no));

-- Adds a confirmed supplier bill in one step: new products, new variants, stock-in records and the import row are all
-- saved, or none are (any error undoes everything). Runs with the caller's own rights, so row security applies; the shop is
-- public.hangtag_shop_id() (section 3i) and the caller needs create_purchase.
-- The same import id twice is a safe retry. The same file, or the same supplier + invoice number, is refused as a
-- likely repeat unless p_allow_duplicate is true.
CREATE OR REPLACE FUNCTION public.hangtag_import_stock(p_import JSONB, p_products JSONB, p_variants JSONB, p_moves JSONB, p_allow_duplicate BOOLEAN DEFAULT FALSE)
RETURNS JSONB LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE
    uid UUID := public.hangtag_shop_id(); imp TEXT := p_import ->> 'id'; d RECORD; r JSONB;
    n_p INT := 0; n_v INT := 0; n_m INT := 0; n_units INT := 0;
    inv TEXT := lower(btrim(COALESCE(p_import ->> 'invoice_no', '')));
    gst TEXT := lower(btrim(COALESCE(p_import ->> 'supplier_gstin', '')));
    sup TEXT := lower(btrim(COALESCE(p_import ->> 'supplier_name', '')));
BEGIN
    IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Sign in to add stock.' USING ERRCODE = '42501'; END IF;
    IF uid IS NULL OR NOT public.hangtag_can('create_purchase') THEN RAISE EXCEPTION 'Not allowed to add stock from supplier bills.' USING ERRCODE = '42501'; END IF;
    IF COALESCE(imp, '') = '' THEN RAISE EXCEPTION 'The import has no id.' USING ERRCODE = '22023'; END IF;
    IF EXISTS (SELECT 1 FROM public.hangtag_stock_imports WHERE owner_id = uid AND id = imp) THEN
        RETURN jsonb_build_object('status', 'already_imported', 'import_id', imp);
    END IF;
    IF NOT COALESCE(p_allow_duplicate, FALSE) THEN
        SELECT id, created_at, invoice_no, supplier_name INTO d FROM public.hangtag_stock_imports
        WHERE owner_id = uid AND COALESCE(file_hash, '') <> '' AND file_hash = p_import ->> 'file_hash' ORDER BY created_at LIMIT 1;
        IF FOUND THEN
            RAISE EXCEPTION 'HANGTAG_DUPLICATE_FILE' USING DETAIL = jsonb_build_object('id', d.id, 'created_at', d.created_at, 'invoice_no', d.invoice_no, 'supplier_name', d.supplier_name)::text;
        END IF;
        IF inv <> '' THEN
            SELECT id, created_at, invoice_no, supplier_name INTO d FROM public.hangtag_stock_imports i
            WHERE i.owner_id = uid AND lower(btrim(COALESCE(i.invoice_no, ''))) = inv
              AND CASE WHEN gst <> '' AND btrim(COALESCE(i.supplier_gstin, '')) <> '' THEN lower(btrim(i.supplier_gstin)) = gst
                       ELSE lower(btrim(COALESCE(i.supplier_name, ''))) = sup END
            ORDER BY created_at LIMIT 1;
            IF FOUND THEN
                RAISE EXCEPTION 'HANGTAG_DUPLICATE_INVOICE' USING DETAIL = jsonb_build_object('id', d.id, 'created_at', d.created_at, 'invoice_no', d.invoice_no, 'supplier_name', d.supplier_name)::text;
            END IF;
        END IF;
    END IF;
    FOR r IN SELECT * FROM jsonb_array_elements(COALESCE(p_products, '[]'::jsonb)) LOOP
        IF r ->> 'mode' = 'update_options' THEN
            UPDATE public.hangtag_products SET options = r -> 'options', updated_at = NOW() WHERE owner_id = uid AND id = r ->> 'id';
            IF NOT FOUND THEN RAISE EXCEPTION 'A product on this bill no longer exists. Check the bill again.' USING ERRCODE = '23503'; END IF;
        ELSE
            INSERT INTO public.hangtag_products (id, name, price, color, sort_order, category, brand, description, cost_price, archived, options, hsn, gst_rate, code_type)
            VALUES (r ->> 'id', r ->> 'name', COALESCE((r ->> 'price')::INTEGER, 0), COALESCE(r ->> 'color', '#8E8A83'), COALESCE((r ->> 'sort_order')::INTEGER, 0),
                    NULLIF(r ->> 'category', ''), NULLIF(r ->> 'brand', ''), NULLIF(r ->> 'description', ''), (r ->> 'cost_price')::INTEGER, FALSE,
                    COALESCE(r -> 'options', '{}'::jsonb), NULLIF(r ->> 'hsn', ''), (r ->> 'gst_rate')::NUMERIC, NULLIF(r ->> 'code_type', ''));
        END IF;
        n_p := n_p + 1;
    END LOOP;
    FOR r IN SELECT * FROM jsonb_array_elements(COALESCE(p_variants, '[]'::jsonb)) LOOP
        INSERT INTO public.hangtag_variants (id, product_id, option_values, color, size, sku, barcode, price, cost_price, active, sort_order)
        VALUES (r ->> 'id', r ->> 'product_id', COALESCE(r -> 'option_values', '[]'::jsonb), COALESCE(r ->> 'color', ''), COALESCE(r ->> 'size', ''),
                NULLIF(r ->> 'sku', ''), NULLIF(r ->> 'barcode', ''), (r ->> 'price')::INTEGER, (r ->> 'cost_price')::INTEGER,
                COALESCE((r ->> 'active')::BOOLEAN, TRUE), COALESCE((r ->> 'sort_order')::INTEGER, 0));
        n_v := n_v + 1;
    END LOOP;
    FOR r IN SELECT * FROM jsonb_array_elements(COALESCE(p_moves, '[]'::jsonb)) LOOP
        IF COALESCE((r ->> 'qty')::INTEGER, 0) <= 0 THEN RAISE EXCEPTION 'Every line needs a quantity of 1 or more.' USING ERRCODE = '23514'; END IF;
        INSERT INTO public.hangtag_stock_moves (id, variant_id, product_id, type, qty, cost_price, note, t, device_id, import_id)
        VALUES (r ->> 'id', r ->> 'variant_id', r ->> 'product_id', 'RESTOCK', (r ->> 'qty')::INTEGER, (r ->> 'cost_price')::INTEGER,
                LEFT(r ->> 'note', 200), COALESCE((r ->> 't')::BIGINT, (extract(epoch FROM now()) * 1000)::BIGINT), r ->> 'device_id', imp);
        n_m := n_m + 1; n_units := n_units + (r ->> 'qty')::INTEGER;
    END LOOP;
    INSERT INTO public.hangtag_stock_imports (id, file_hash, file_name, file_type, supplier_name, supplier_gstin, invoice_no, invoice_date,
                                              line_count, units, amount, lines, extraction, device_id)
    VALUES (imp, NULLIF(p_import ->> 'file_hash', ''), p_import ->> 'file_name', p_import ->> 'file_type', NULLIF(p_import ->> 'supplier_name', ''),
            NULLIF(p_import ->> 'supplier_gstin', ''), NULLIF(p_import ->> 'invoice_no', ''), NULLIF(p_import ->> 'invoice_date', '')::DATE,
            COALESCE((p_import ->> 'line_count')::INTEGER, 0), n_units, (p_import ->> 'amount')::NUMERIC,
            COALESCE(p_import -> 'lines', '[]'::jsonb), p_import -> 'extraction', p_import ->> 'device_id');
    RETURN jsonb_build_object('status', 'imported', 'import_id', imp, 'products', n_p, 'variants', n_v, 'moves', n_m, 'units', n_units);
END $$;
REVOKE ALL ON FUNCTION public.hangtag_import_stock(JSONB, JSONB, JSONB, JSONB, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.hangtag_import_stock(JSONB, JSONB, JSONB, JSONB, BOOLEAN) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.hangtag_variants_fill_options() FROM PUBLIC, anon;

-- ==============================================================================
-- 3d. Customer details: GSTIN and customer type (an individual or a business). Existing customers become individuals.
-- ==============================================================================
ALTER TABLE public.hangtag_customers ADD COLUMN IF NOT EXISTS gstin TEXT;
ALTER TABLE public.hangtag_customers ADD COLUMN IF NOT EXISTS customer_type TEXT NOT NULL DEFAULT 'individual';
ALTER TABLE public.hangtag_customers DROP CONSTRAINT IF EXISTS hangtag_customers_gstin_check;
ALTER TABLE public.hangtag_customers ADD CONSTRAINT hangtag_customers_gstin_check CHECK (gstin IS NULL OR gstin ~ '^[0-9]{2}[A-Z0-9]{10}[0-9A-Z]{3}$');
ALTER TABLE public.hangtag_customers DROP CONSTRAINT IF EXISTS hangtag_customers_type_check;
ALTER TABLE public.hangtag_customers ADD CONSTRAINT hangtag_customers_type_check CHECK (customer_type IN ('individual','business'));
CREATE INDEX IF NOT EXISTS idx_hangtag_customers_name ON public.hangtag_customers (owner_id, lower(name));

-- ==============================================================================
-- 3e. Discounts, GST, payments and the money books
--   Bills keep their discounts (on lines and on the whole bill), their GST split (CGST + SGST inside the state, IGST
--   across states; on each line and in total) and the round off. Payments are a table of their own: one row per bill
--   and method (cash, UPI, card), so a bill can be split, and together they must equal what was due.
--   Every payment and every refund posts one financial transaction pointing at its bill, and every transaction one
--   cash book entry (cash) or bank book entry (UPI, card). Only the database writes transactions and book entries
--   (the app can read them); their ids come from the payment or return id, so posting again never duplicates.
--   Cancelling a bill marks its payments, transactions and entries cancelled (restoring it posts them again).
--   Bills saved before this get their payment (the method they were paid by, for what was due) and are posted too.
-- ==============================================================================
-- Discounts and GST can have paise now
ALTER TABLE public.hangtag_sales ALTER COLUMN discount TYPE NUMERIC(12,2);
ALTER TABLE public.hangtag_sales ALTER COLUMN tax_amount TYPE NUMERIC(12,2);
ALTER TABLE public.hangtag_sales ADD COLUMN IF NOT EXISTS item_discount NUMERIC(12,2) NOT NULL DEFAULT 0;
ALTER TABLE public.hangtag_sales ADD COLUMN IF NOT EXISTS bill_discount NUMERIC(12,2) NOT NULL DEFAULT 0;
ALTER TABLE public.hangtag_sales ADD COLUMN IF NOT EXISTS bill_discount_type TEXT;
ALTER TABLE public.hangtag_sales ADD COLUMN IF NOT EXISTS bill_discount_value NUMERIC(12,2);
ALTER TABLE public.hangtag_sales ADD COLUMN IF NOT EXISTS taxable_amount NUMERIC(12,2);
ALTER TABLE public.hangtag_sales ADD COLUMN IF NOT EXISTS cgst_amount NUMERIC(12,2) NOT NULL DEFAULT 0;
ALTER TABLE public.hangtag_sales ADD COLUMN IF NOT EXISTS sgst_amount NUMERIC(12,2) NOT NULL DEFAULT 0;
ALTER TABLE public.hangtag_sales ADD COLUMN IF NOT EXISTS igst_amount NUMERIC(12,2) NOT NULL DEFAULT 0;
ALTER TABLE public.hangtag_sales ADD COLUMN IF NOT EXISTS round_off NUMERIC(4,2) NOT NULL DEFAULT 0;
ALTER TABLE public.hangtag_sales ADD COLUMN IF NOT EXISTS gst_mode TEXT;           -- none | intra (CGST + SGST) | inter (IGST); empty = saved by an older app
ALTER TABLE public.hangtag_sales ADD COLUMN IF NOT EXISTS place_of_supply TEXT;    -- GST state code, e.g. 27
ALTER TABLE public.hangtag_sales ADD COLUMN IF NOT EXISTS customer_gstin TEXT;
ALTER TABLE public.hangtag_sales ADD COLUMN IF NOT EXISTS customer_type TEXT;
-- Bills saved before: their discount was on the whole bill, and their GST counts as CGST + SGST halves
UPDATE public.hangtag_sales
   SET bill_discount = discount, item_discount = 0, taxable_amount = total - tax_amount,
       gst_mode = CASE WHEN tax_amount > 0 THEN 'intra' ELSE 'none' END,
       cgst_amount = round(tax_amount / 2, 2), sgst_amount = tax_amount - round(tax_amount / 2, 2), igst_amount = 0
 WHERE gst_mode IS NULL;
-- (NOT VALID: checked for every new or changed bill, without re-reading old ones)
ALTER TABLE public.hangtag_sales DROP CONSTRAINT IF EXISTS hangtag_sales_money_check;
ALTER TABLE public.hangtag_sales ADD CONSTRAINT hangtag_sales_money_check CHECK (
    discount >= 0 AND discount <= subtotal AND item_discount >= 0 AND bill_discount >= 0 AND tax_amount >= 0 AND total >= 0
    AND cgst_amount >= 0 AND sgst_amount >= 0 AND igst_amount >= 0 AND round_off BETWEEN -0.5 AND 0.5) NOT VALID;
ALTER TABLE public.hangtag_sales DROP CONSTRAINT IF EXISTS hangtag_sales_gst_check;
ALTER TABLE public.hangtag_sales ADD CONSTRAINT hangtag_sales_gst_check CHECK (gst_mode IS NULL OR (
    gst_mode IN ('none','intra','inter') AND tax_amount = cgst_amount + sgst_amount + igst_amount AND discount = item_discount + bill_discount
    AND (gst_mode <> 'none' OR tax_amount = 0) AND (gst_mode <> 'intra' OR igst_amount = 0)
    AND (gst_mode <> 'inter' OR (cgst_amount = 0 AND sgst_amount = 0)))) NOT VALID;
ALTER TABLE public.hangtag_sales DROP CONSTRAINT IF EXISTS hangtag_sales_bill_discount_check;
ALTER TABLE public.hangtag_sales ADD CONSTRAINT hangtag_sales_bill_discount_check CHECK ((bill_discount_type IS NULL AND bill_discount_value IS NULL)
    OR (bill_discount_type IN ('percent','fixed') AND bill_discount_value > 0 AND (bill_discount_type <> 'percent' OR bill_discount_value <= 100)));
ALTER TABLE public.hangtag_sales DROP CONSTRAINT IF EXISTS hangtag_sales_supply_check;
ALTER TABLE public.hangtag_sales ADD CONSTRAINT hangtag_sales_supply_check CHECK ((place_of_supply IS NULL OR place_of_supply ~ '^[0-9]{2}$')
    AND (customer_gstin IS NULL OR customer_gstin ~ '^[0-9]{2}[A-Z0-9]{10}[0-9A-Z]{3}$') AND (customer_type IS NULL OR customer_type IN ('individual','business')));
ALTER TABLE public.hangtag_sales DROP CONSTRAINT IF EXISTS hangtag_sales_payment_method_check;
ALTER TABLE public.hangtag_sales ADD CONSTRAINT hangtag_sales_payment_method_check CHECK (payment_method IN ('cash','upi','card','split')) NOT VALID;

-- Bill lines: the line discount, its share of the bill discount, and its GST
ALTER TABLE public.hangtag_sale_items ADD COLUMN IF NOT EXISTS discount_type TEXT;
ALTER TABLE public.hangtag_sale_items ADD COLUMN IF NOT EXISTS discount_value NUMERIC(12,2);
ALTER TABLE public.hangtag_sale_items ADD COLUMN IF NOT EXISTS discount_amount NUMERIC(12,2) NOT NULL DEFAULT 0;
ALTER TABLE public.hangtag_sale_items ADD COLUMN IF NOT EXISTS bill_discount_share NUMERIC(12,2) NOT NULL DEFAULT 0;
ALTER TABLE public.hangtag_sale_items ADD COLUMN IF NOT EXISTS taxable_value NUMERIC(12,2);
ALTER TABLE public.hangtag_sale_items ADD COLUMN IF NOT EXISTS gst_rate NUMERIC(5,2);
ALTER TABLE public.hangtag_sale_items ADD COLUMN IF NOT EXISTS cgst_amount NUMERIC(12,2) NOT NULL DEFAULT 0;
ALTER TABLE public.hangtag_sale_items ADD COLUMN IF NOT EXISTS sgst_amount NUMERIC(12,2) NOT NULL DEFAULT 0;
ALTER TABLE public.hangtag_sale_items ADD COLUMN IF NOT EXISTS igst_amount NUMERIC(12,2) NOT NULL DEFAULT 0;
ALTER TABLE public.hangtag_sale_items ADD COLUMN IF NOT EXISTS line_total NUMERIC(12,2);
ALTER TABLE public.hangtag_sale_items ADD COLUMN IF NOT EXISTS hsn TEXT;
ALTER TABLE public.hangtag_sale_items DROP CONSTRAINT IF EXISTS hangtag_sale_items_discount_check;
ALTER TABLE public.hangtag_sale_items ADD CONSTRAINT hangtag_sale_items_discount_check CHECK ((discount_type IS NULL AND discount_value IS NULL)
    OR (discount_type IN ('percent','fixed') AND discount_value > 0 AND (discount_type <> 'percent' OR discount_value <= 100)));
ALTER TABLE public.hangtag_sale_items DROP CONSTRAINT IF EXISTS hangtag_sale_items_money_check;
ALTER TABLE public.hangtag_sale_items ADD CONSTRAINT hangtag_sale_items_money_check CHECK (discount_amount >= 0 AND bill_discount_share >= 0
    AND discount_amount + bill_discount_share <= quantity * unit_price AND cgst_amount >= 0 AND sgst_amount >= 0 AND igst_amount >= 0
    AND (gst_rate IS NULL OR gst_rate BETWEEN 0 AND 100)) NOT VALID;

-- Payments: one per bill and method
CREATE TABLE IF NOT EXISTS public.hangtag_payments (
    owner_id UUID NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
    id TEXT NOT NULL,                              -- "<bill id>:<method>"
    sale_id TEXT NOT NULL,
    method TEXT NOT NULL CHECK (method IN ('cash','upi','card')),
    amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
    tendered NUMERIC(12,2),                        -- cash handed over (cash only)
    change_given NUMERIC(12,2) NOT NULL DEFAULT 0,
    reference TEXT CHECK (reference IS NULL OR char_length(reference) <= 40),
    provider_fee NUMERIC(12,2),                    -- fee/MDR reported by the trusted payment provider, never estimated
    status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('completed','cancelled')),
    t BIGINT NOT NULL,
    device_id TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (owner_id, id),
    -- one row per method on a bill (no duplicate allocation); its index also finds a bill's payments
    CONSTRAINT hangtag_payments_sale_method_key UNIQUE (owner_id, sale_id, method),
    -- the id is always made from the bill and the method, so a payment can never be pointed at another bill
    CONSTRAINT hangtag_payments_id_check CHECK (id = sale_id || ':' || method),
    CONSTRAINT hangtag_payments_cash_check CHECK ((method = 'cash' AND tendered >= amount AND change_given = tendered - amount)
                                               OR (method <> 'cash' AND tendered IS NULL AND change_given = 0)),
    CONSTRAINT hangtag_payments_provider_fee_check CHECK (provider_fee IS NULL OR provider_fee >= 0),
    CONSTRAINT hangtag_payments_sale_fkey FOREIGN KEY (owner_id, sale_id) REFERENCES public.hangtag_sales (owner_id, id) ON DELETE CASCADE
);
-- Financial transactions: money in (a payment on a bill) or out (a refund on a return), always pointing at the bill
CREATE TABLE IF NOT EXISTS public.hangtag_fin_txns (
    owner_id UUID NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
    id TEXT NOT NULL,                              -- "ft:<payment id>" or "ft:<return id>"
    kind TEXT NOT NULL CHECK (kind IN ('sale_receipt','refund')),
    direction TEXT NOT NULL CHECK (direction IN ('in','out')),
    method TEXT NOT NULL CHECK (method IN ('cash','upi','card')),
    amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
    sale_id TEXT NOT NULL,
    payment_id TEXT,
    return_id TEXT,
    reference TEXT,
    status TEXT NOT NULL DEFAULT 'posted' CHECK (status IN ('posted','cancelled')),
    t BIGINT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (owner_id, id),
    CONSTRAINT hangtag_fin_txns_payment_key UNIQUE (owner_id, payment_id),
    CONSTRAINT hangtag_fin_txns_return_key UNIQUE (owner_id, return_id),
    CONSTRAINT hangtag_fin_txns_source_check CHECK ((kind = 'sale_receipt' AND direction = 'in' AND payment_id IS NOT NULL AND return_id IS NULL)
                                                 OR (kind = 'refund' AND direction = 'out' AND return_id IS NOT NULL AND payment_id IS NULL)),
    CONSTRAINT hangtag_fin_txns_sale_fkey FOREIGN KEY (owner_id, sale_id) REFERENCES public.hangtag_sales (owner_id, id) ON DELETE CASCADE,
    CONSTRAINT hangtag_fin_txns_payment_fkey FOREIGN KEY (owner_id, payment_id) REFERENCES public.hangtag_payments (owner_id, id) ON DELETE CASCADE,
    CONSTRAINT hangtag_fin_txns_return_fkey FOREIGN KEY (owner_id, return_id) REFERENCES public.hangtag_returns (owner_id, id) ON DELETE CASCADE
);
-- reconciliation reads a bill's transactions, and cancelling a bill updates them
CREATE INDEX IF NOT EXISTS idx_hangtag_fin_txns_sale ON public.hangtag_fin_txns (owner_id, sale_id);
-- Cash book: cash transactions (cash sales in, cash refunds out)
CREATE TABLE IF NOT EXISTS public.hangtag_cash_book (
    owner_id UUID NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
    id TEXT NOT NULL,                              -- "cb:<transaction id>"
    fin_txn_id TEXT NOT NULL,
    sale_id TEXT NOT NULL,
    entry_type TEXT NOT NULL CHECK (entry_type IN ('cash_sale','cash_refund')),
    amount_in NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (amount_in >= 0),
    amount_out NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (amount_out >= 0),
    cash_received NUMERIC(12,2),
    change_given NUMERIC(12,2) NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'posted' CHECK (status IN ('posted','cancelled')),
    t BIGINT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (owner_id, id),
    CONSTRAINT hangtag_cash_book_txn_key UNIQUE (owner_id, fin_txn_id),
    CONSTRAINT hangtag_cash_book_side_check CHECK ((amount_in > 0) <> (amount_out > 0)),
    CONSTRAINT hangtag_cash_book_txn_fkey FOREIGN KEY (owner_id, fin_txn_id) REFERENCES public.hangtag_fin_txns (owner_id, id) ON DELETE CASCADE
);
-- the book is read in date order, with a running balance
CREATE INDEX IF NOT EXISTS idx_hangtag_cash_book_time ON public.hangtag_cash_book (owner_id, t);
-- Bank book: UPI and card transactions
CREATE TABLE IF NOT EXISTS public.hangtag_bank_book (
    owner_id UUID NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
    id TEXT NOT NULL,                              -- "bb:<transaction id>"
    fin_txn_id TEXT NOT NULL,
    sale_id TEXT NOT NULL,
    method TEXT NOT NULL CHECK (method IN ('upi','card')),
    entry_type TEXT NOT NULL CHECK (entry_type IN ('receipt','refund')),
    reference TEXT,
    amount_in NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (amount_in >= 0),
    amount_out NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (amount_out >= 0),
    status TEXT NOT NULL DEFAULT 'posted' CHECK (status IN ('posted','cancelled')),
    t BIGINT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (owner_id, id),
    CONSTRAINT hangtag_bank_book_txn_key UNIQUE (owner_id, fin_txn_id),
    CONSTRAINT hangtag_bank_book_side_check CHECK ((amount_in > 0) <> (amount_out > 0)),
    CONSTRAINT hangtag_bank_book_txn_fkey FOREIGN KEY (owner_id, fin_txn_id) REFERENCES public.hangtag_fin_txns (owner_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_hangtag_bank_book_time ON public.hangtag_bank_book (owner_id, t);
-- whether a UPI receipt was verified by the payment provider (section 3h), copied from the payment
ALTER TABLE public.hangtag_bank_book ADD COLUMN IF NOT EXISTS verification TEXT;

-- A bill's payments never add up to more than was due (the total less any exchange credit)
CREATE OR REPLACE FUNCTION public.hangtag_payments_check()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
    due NUMERIC;
    other NUMERIC;
BEGIN
    SELECT GREATEST(s.total - s.credit, 0) INTO due FROM public.hangtag_sales s WHERE s.owner_id = NEW.owner_id AND s.id = NEW.sale_id;
    IF due IS NULL THEN
        RAISE EXCEPTION 'Bill % was not found', NEW.sale_id USING ERRCODE = 'foreign_key_violation';
    END IF;
    SELECT COALESCE(SUM(amount), 0) INTO other FROM public.hangtag_payments
     WHERE owner_id = NEW.owner_id AND sale_id = NEW.sale_id AND id <> NEW.id;
    IF other + NEW.amount > due THEN
        RAISE EXCEPTION 'Payments on this bill would come to % but only % is due', other + NEW.amount, due USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS hangtag_payments_check ON public.hangtag_payments;
CREATE TRIGGER hangtag_payments_check BEFORE INSERT OR UPDATE ON public.hangtag_payments
    FOR EACH ROW EXECUTE FUNCTION public.hangtag_payments_check();

-- Posting runs as the database owner, so the app can't write transactions or book entries itself. The owner_id always
-- comes from the payment or return row, which row security has already checked.
CREATE OR REPLACE FUNCTION public.hangtag_post_payment()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    ft TEXT := 'ft:' || NEW.id;
    voided BOOLEAN;
    st TEXT;
BEGIN
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
DROP TRIGGER IF EXISTS hangtag_post_payment ON public.hangtag_payments;
CREATE TRIGGER hangtag_post_payment AFTER INSERT OR UPDATE ON public.hangtag_payments
    FOR EACH ROW EXECUTE FUNCTION public.hangtag_post_payment();

CREATE OR REPLACE FUNCTION public.hangtag_post_refund()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    ft TEXT := 'ft:' || NEW.id;
    voided BOOLEAN;
    st TEXT;
BEGIN
    IF COALESCE(NEW.refund_amount, 0) <= 0 OR COALESCE(NEW.refund_method, '') NOT IN ('cash','upi','card') THEN
        DELETE FROM public.hangtag_fin_txns WHERE owner_id = NEW.owner_id AND id = ft;
        RETURN NULL;
    END IF;
    SELECT is_void INTO voided FROM public.hangtag_sales WHERE owner_id = NEW.owner_id AND id = NEW.sale_id;
    st := CASE WHEN COALESCE(voided, FALSE) THEN 'cancelled' ELSE 'posted' END;
    INSERT INTO public.hangtag_fin_txns (owner_id, id, kind, direction, method, amount, sale_id, return_id, status, t)
    VALUES (NEW.owner_id, ft, 'refund', 'out', NEW.refund_method, NEW.refund_amount, NEW.sale_id, NEW.id, st, NEW.t)
    ON CONFLICT (owner_id, id) DO UPDATE SET method = EXCLUDED.method, amount = EXCLUDED.amount, status = EXCLUDED.status, t = EXCLUDED.t;
    IF NEW.refund_method = 'cash' THEN
        DELETE FROM public.hangtag_bank_book WHERE owner_id = NEW.owner_id AND fin_txn_id = ft;
        INSERT INTO public.hangtag_cash_book (owner_id, id, fin_txn_id, sale_id, entry_type, amount_out, status, t)
        VALUES (NEW.owner_id, 'cb:' || ft, ft, NEW.sale_id, 'cash_refund', NEW.refund_amount, st, NEW.t)
        ON CONFLICT (owner_id, id) DO UPDATE SET amount_out = EXCLUDED.amount_out, status = EXCLUDED.status, t = EXCLUDED.t;
    ELSE
        DELETE FROM public.hangtag_cash_book WHERE owner_id = NEW.owner_id AND fin_txn_id = ft;
        INSERT INTO public.hangtag_bank_book (owner_id, id, fin_txn_id, sale_id, method, entry_type, amount_out, status, t)
        VALUES (NEW.owner_id, 'bb:' || ft, ft, NEW.sale_id, NEW.refund_method, 'refund', NEW.refund_amount, st, NEW.t)
        ON CONFLICT (owner_id, id) DO UPDATE SET method = EXCLUDED.method, amount_out = EXCLUDED.amount_out, status = EXCLUDED.status, t = EXCLUDED.t;
    END IF;
    RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS hangtag_post_refund ON public.hangtag_returns;
CREATE TRIGGER hangtag_post_refund AFTER INSERT OR UPDATE ON public.hangtag_returns
    FOR EACH ROW EXECUTE FUNCTION public.hangtag_post_refund();

-- Cancelling (or restoring) a bill cancels (or re-posts) its payments, transactions and book entries
CREATE OR REPLACE FUNCTION public.hangtag_sale_status()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    st TEXT := CASE WHEN NEW.is_void THEN 'cancelled' ELSE 'posted' END;
BEGIN
    UPDATE public.hangtag_payments SET status = CASE WHEN NEW.is_void THEN 'cancelled' ELSE 'completed' END
     WHERE owner_id = NEW.owner_id AND sale_id = NEW.id;
    UPDATE public.hangtag_fin_txns SET status = st WHERE owner_id = NEW.owner_id AND sale_id = NEW.id;
    UPDATE public.hangtag_cash_book SET status = st
     WHERE owner_id = NEW.owner_id AND fin_txn_id IN (SELECT id FROM public.hangtag_fin_txns WHERE owner_id = NEW.owner_id AND sale_id = NEW.id);
    UPDATE public.hangtag_bank_book SET status = st
     WHERE owner_id = NEW.owner_id AND fin_txn_id IN (SELECT id FROM public.hangtag_fin_txns WHERE owner_id = NEW.owner_id AND sale_id = NEW.id);
    RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS hangtag_sale_status ON public.hangtag_sales;
CREATE TRIGGER hangtag_sale_status AFTER UPDATE OF is_void ON public.hangtag_sales
    FOR EACH ROW WHEN (OLD.is_void IS DISTINCT FROM NEW.is_void) EXECUTE FUNCTION public.hangtag_sale_status();

-- A bill saved by an older app version (it sends no payments) gets its one payment when the saving transaction ends
CREATE OR REPLACE FUNCTION public.hangtag_sale_default_payment()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
    s public.hangtag_sales;
BEGIN
    SELECT * INTO s FROM public.hangtag_sales WHERE owner_id = NEW.owner_id AND id = NEW.id;
    IF FOUND AND s.total - s.credit > 0 AND s.payment_method IN ('cash','upi','card')
       AND NOT EXISTS (SELECT 1 FROM public.hangtag_payments p WHERE p.owner_id = s.owner_id AND p.sale_id = s.id) THEN
        INSERT INTO public.hangtag_payments (owner_id, id, sale_id, method, amount, tendered, change_given, status, t, device_id)
        VALUES (s.owner_id, s.id || ':' || s.payment_method, s.id, s.payment_method, s.total - s.credit,
                CASE WHEN s.payment_method = 'cash' THEN s.total - s.credit END, 0,
                CASE WHEN s.is_void THEN 'cancelled' ELSE 'completed' END, s.timestamp, s.device_id)
        ON CONFLICT DO NOTHING;
    END IF;
    RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS hangtag_sale_default_payment ON public.hangtag_sales;
CREATE CONSTRAINT TRIGGER hangtag_sale_default_payment AFTER INSERT ON public.hangtag_sales
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.hangtag_sale_default_payment();

-- Saves bills with their lines and payments, all or nothing. Runs with the caller's own rights (row security applies);
-- the shop is public.hangtag_shop_id() (section 3i) and the caller needs create_sale (and apply_discount for a discount).
-- p_bills: [{ sale: {hangtag_sales columns}, items: [{hangtag_sale_items columns}], payments: [{hangtag_payments columns}] }]
-- The owner saving the same bill again updates it (a safe retry), and payments no longer on it are removed. A team member
-- only adds bills: one already saved is left exactly as it is (its retry saves nothing new; section 3i (f)). Each bill's
-- payments must add up to exactly what was due, or nothing is saved.
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
            round_off, gst_mode, place_of_supply, customer_gstin, customer_type, event_id)
        VALUES (s.id, s.timestamp, COALESCE(s.subtotal, 0), COALESCE(s.discount, 0), COALESCE(s.total, 0), s.payment_method, s.device_id,
            COALESCE(s.is_void, FALSE), s.bill_no, s.customer_id, s.customer_name, s.customer_phone, COALESCE(s.tax_rate, 0),
            COALESCE(s.tax_amount, 0), COALESCE(s.tax_inclusive, TRUE), COALESCE(s.kind, 'sale'), s.exchange_id, COALESCE(s.credit, 0),
            COALESCE(s.item_discount, 0), COALESCE(s.bill_discount, 0), s.bill_discount_type, s.bill_discount_value, s.taxable_amount,
            COALESCE(s.cgst_amount, 0), COALESCE(s.sgst_amount, 0), COALESCE(s.igst_amount, 0), COALESCE(s.round_off, 0),
            s.gst_mode, s.place_of_supply, s.customer_gstin, s.customer_type, s.event_id)
        ON CONFLICT (owner_id, id) DO UPDATE SET timestamp = EXCLUDED.timestamp, subtotal = EXCLUDED.subtotal, discount = EXCLUDED.discount,
            total = EXCLUDED.total, payment_method = EXCLUDED.payment_method, device_id = EXCLUDED.device_id, is_void = EXCLUDED.is_void, void_reason = CASE WHEN EXCLUDED.is_void THEN hangtag_sales.void_reason END,
            bill_no = EXCLUDED.bill_no, customer_id = EXCLUDED.customer_id, customer_name = EXCLUDED.customer_name,
            customer_phone = EXCLUDED.customer_phone, tax_rate = EXCLUDED.tax_rate, tax_amount = EXCLUDED.tax_amount,
            tax_inclusive = EXCLUDED.tax_inclusive, kind = EXCLUDED.kind, exchange_id = EXCLUDED.exchange_id, credit = EXCLUDED.credit,
            item_discount = EXCLUDED.item_discount, bill_discount = EXCLUDED.bill_discount, bill_discount_type = EXCLUDED.bill_discount_type,
            bill_discount_value = EXCLUDED.bill_discount_value, taxable_amount = EXCLUDED.taxable_amount, cgst_amount = EXCLUDED.cgst_amount,
            sgst_amount = EXCLUDED.sgst_amount, igst_amount = EXCLUDED.igst_amount, round_off = EXCLUDED.round_off, gst_mode = EXCLUDED.gst_mode,
            place_of_supply = EXCLUDED.place_of_supply, customer_gstin = EXCLUDED.customer_gstin, customer_type = EXCLUDED.customer_type,
            event_id = EXCLUDED.event_id;
        INSERT INTO public.hangtag_sale_items (sale_id, line_no, product_id, product_name, size, quantity, unit_price, variant_id, color, sku,
            cost_price, variant_label, options, discount_type, discount_value, discount_amount, bill_discount_share, taxable_value, gst_rate,
            cgst_amount, sgst_amount, igst_amount, line_total, hsn)
        SELECT s.id, i.line_no, i.product_id, i.product_name, COALESCE(i.size, ''), COALESCE(i.quantity, 1), COALESCE(i.unit_price, 0),
            i.variant_id, COALESCE(i.color, ''), i.sku, i.cost_price, i.variant_label, i.options, i.discount_type, i.discount_value,
            COALESCE(i.discount_amount, 0), COALESCE(i.bill_discount_share, 0), i.taxable_value, i.gst_rate, COALESCE(i.cgst_amount, 0),
            COALESCE(i.sgst_amount, 0), COALESCE(i.igst_amount, 0), i.line_total, i.hsn
        FROM jsonb_populate_recordset(NULL::public.hangtag_sale_items, COALESCE(b -> 'items', '[]'::jsonb)) i
        ON CONFLICT (owner_id, sale_id, line_no) DO UPDATE SET product_id = EXCLUDED.product_id, product_name = EXCLUDED.product_name,
            size = EXCLUDED.size, quantity = EXCLUDED.quantity, unit_price = EXCLUDED.unit_price, variant_id = EXCLUDED.variant_id,
            color = EXCLUDED.color, sku = EXCLUDED.sku, cost_price = EXCLUDED.cost_price, variant_label = EXCLUDED.variant_label,
            options = EXCLUDED.options, discount_type = EXCLUDED.discount_type, discount_value = EXCLUDED.discount_value,
            discount_amount = EXCLUDED.discount_amount, bill_discount_share = EXCLUDED.bill_discount_share, taxable_value = EXCLUDED.taxable_value,
            gst_rate = EXCLUDED.gst_rate, cgst_amount = EXCLUDED.cgst_amount, sgst_amount = EXCLUDED.sgst_amount,
            igst_amount = EXCLUDED.igst_amount, line_total = EXCLUDED.line_total, hsn = EXCLUDED.hsn;
        SELECT x.is_void, GREATEST(x.total - x.credit, 0) INTO voided, due FROM public.hangtag_sales x WHERE x.owner_id = uid AND x.id = s.id;
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
            -- a payment the provider verified (section 3h) stays verified when the phone uploads the bill again
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
REVOKE EXECUTE ON FUNCTION public.hangtag_payments_check(), public.hangtag_post_payment(), public.hangtag_post_refund(),
    public.hangtag_sale_status(), public.hangtag_sale_default_payment() FROM PUBLIC, anon;

-- Bills saved before: the payment each was made with, for what was due (the triggers above post it)
INSERT INTO public.hangtag_payments (owner_id, id, sale_id, method, amount, tendered, change_given, status, t, device_id)
SELECT s.owner_id, s.id || ':' || s.payment_method, s.id, s.payment_method, s.total - s.credit,
       CASE WHEN s.payment_method = 'cash' THEN s.total - s.credit END, 0,
       CASE WHEN s.is_void THEN 'cancelled' ELSE 'completed' END, s.timestamp, s.device_id
FROM public.hangtag_sales s
WHERE s.total - s.credit > 0 AND s.payment_method IN ('cash','upi','card')
  AND NOT EXISTS (SELECT 1 FROM public.hangtag_payments p WHERE p.owner_id = s.owner_id AND p.sale_id = s.id)
ON CONFLICT DO NOTHING;
-- Refunds on returns saved before (touching the row posts it)
UPDATE public.hangtag_returns r SET refund_amount = r.refund_amount
 WHERE r.refund_amount > 0 AND NOT EXISTS (SELECT 1 FROM public.hangtag_fin_txns f WHERE f.owner_id = r.owner_id AND f.return_id = r.id);

-- ==============================================================================
-- 3f. Bills sent to customers, and the shop logo
--   Every email, WhatsApp or SMS sent from a bill is one row, written only by the send-receipt Edge Function (the app
--   can read them). The function writes it as "pending" before calling the provider (the hourly limit counts these
--   rows), then "sent" (always with the provider's message id: nothing is recorded as sent without it) or "failed".
--   Deleting a bill keeps its delivery records (sale_id is cleared), so the log and the limit can't be erased that way.
--   The shop logo printed on receipts is kept in hangtag_meta under the key 'logo' (a small picture, size-limited).
-- ==============================================================================
CREATE TABLE IF NOT EXISTS public.hangtag_deliveries (
    owner_id UUID NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
    id UUID NOT NULL DEFAULT gen_random_uuid(),
    sale_id TEXT,
    channel TEXT NOT NULL CHECK (channel IN ('email','whatsapp','sms')),
    recipient TEXT NOT NULL CHECK (char_length(recipient) BETWEEN 3 AND 200),
    status TEXT NOT NULL CHECK (status IN ('pending','sent','failed')),
    provider TEXT CHECK (provider IS NULL OR char_length(provider) <= 40),
    provider_message_id TEXT CHECK (provider_message_id IS NULL OR char_length(provider_message_id) <= 200),
    error TEXT CHECK (error IS NULL OR char_length(error) <= 300),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (owner_id, id),
    CONSTRAINT hangtag_deliveries_sent_check CHECK (status <> 'sent' OR provider_message_id IS NOT NULL),
    CONSTRAINT hangtag_deliveries_sale_fkey FOREIGN KEY (owner_id, sale_id) REFERENCES public.hangtag_sales (owner_id, id) ON DELETE SET NULL (sale_id)
);
-- a bill's messages, newest first (the bill view)
CREATE INDEX IF NOT EXISTS idx_hangtag_deliveries_sale ON public.hangtag_deliveries (owner_id, sale_id, created_at DESC);
-- the function's limit of messages per shop per hour
CREATE INDEX IF NOT EXISTS idx_hangtag_deliveries_time ON public.hangtag_deliveries (owner_id, created_at DESC);
-- the logo is a small picture: at most about 300 KB
ALTER TABLE public.hangtag_meta DROP CONSTRAINT IF EXISTS hangtag_meta_logo_size_check;
ALTER TABLE public.hangtag_meta ADD CONSTRAINT hangtag_meta_logo_size_check CHECK (key <> 'logo' OR octet_length(value::text) <= 400000) NOT VALID;

-- ==============================================================================
-- 3g. Returns with credit notes, and events (Phases 17-22)
--   Returns keep paise (their refund and value were whole rupees), their credit note number, and the round off given back
--   when a whole bill is returned. Return lines keep the GST reversed (taxable value, rate, CGST / SGST / IGST, HSN) and
--   whether the piece went back on the shelf (restock false: "not for resale", recorded without adding stock).
--   A return is saved with its lines in one step (RPC hangtag_save_return): never on a cancelled bill, never more pieces
--   than a bill line has left (the trigger above), and its value is always its lines plus its round off.
--   Events (Event Mode): a named, dated selling occasion. Bills made at one carry its id (hangtag_sales.event_id); returns
--   follow their bill. An event with bills can't be deleted, only closed.
-- ==============================================================================
ALTER TABLE public.hangtag_returns ALTER COLUMN refund_amount TYPE NUMERIC(12,2);
ALTER TABLE public.hangtag_returns ALTER COLUMN value TYPE NUMERIC(12,2);
ALTER TABLE public.hangtag_returns ADD COLUMN IF NOT EXISTS round_off NUMERIC(12,2) NOT NULL DEFAULT 0;
ALTER TABLE public.hangtag_returns ADD COLUMN IF NOT EXISTS credit_no TEXT;
ALTER TABLE public.hangtag_returns DROP CONSTRAINT IF EXISTS hangtag_returns_money_check;
ALTER TABLE public.hangtag_returns ADD CONSTRAINT hangtag_returns_money_check CHECK (refund_amount <= value AND round_off BETWEEN -1 AND 1
    AND (credit_no IS NULL OR char_length(credit_no) <= 40) AND (refund_method IS NULL OR refund_method IN ('cash','upi','card'))) NOT VALID;
ALTER TABLE public.hangtag_return_items ALTER COLUMN value TYPE NUMERIC(12,2);
ALTER TABLE public.hangtag_return_items ADD COLUMN IF NOT EXISTS restock BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE public.hangtag_return_items ADD COLUMN IF NOT EXISTS taxable_value NUMERIC(12,2);
ALTER TABLE public.hangtag_return_items ADD COLUMN IF NOT EXISTS gst_rate NUMERIC(5,2);
ALTER TABLE public.hangtag_return_items ADD COLUMN IF NOT EXISTS cgst_amount NUMERIC(12,2) NOT NULL DEFAULT 0;
ALTER TABLE public.hangtag_return_items ADD COLUMN IF NOT EXISTS sgst_amount NUMERIC(12,2) NOT NULL DEFAULT 0;
ALTER TABLE public.hangtag_return_items ADD COLUMN IF NOT EXISTS igst_amount NUMERIC(12,2) NOT NULL DEFAULT 0;
ALTER TABLE public.hangtag_return_items ADD COLUMN IF NOT EXISTS hsn TEXT;
ALTER TABLE public.hangtag_return_items DROP CONSTRAINT IF EXISTS hangtag_return_items_money_check;
ALTER TABLE public.hangtag_return_items ADD CONSTRAINT hangtag_return_items_money_check CHECK (value >= 0 AND cgst_amount >= 0 AND sgst_amount >= 0
    AND igst_amount >= 0 AND (gst_rate IS NULL OR gst_rate BETWEEN 0 AND 100)) NOT VALID;

-- Saves a return with its lines, all or nothing. Runs with the caller's own rights (row security applies);
-- the shop is public.hangtag_shop_id() (section 3i) and the caller needs perform_return.
-- p_return: {hangtag_returns columns} · p_items: [{hangtag_return_items columns}]
-- Saving the same return again updates it (a safe retry); lines no longer on it are removed.
CREATE OR REPLACE FUNCTION public.hangtag_save_return(p_return JSONB, p_items JSONB)
RETURNS JSONB LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE
    uid UUID := public.hangtag_shop_id();
    r public.hangtag_returns;
    voided BOOLEAN;
    lines_value NUMERIC;
    n INT;
BEGIN
    IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Sign in to save returns.' USING ERRCODE = '42501'; END IF;
    IF uid IS NULL OR NOT public.hangtag_can('perform_return') THEN RAISE EXCEPTION 'Not allowed to save returns.' USING ERRCODE = '42501'; END IF;
    r := jsonb_populate_record(NULL::public.hangtag_returns, p_return);
    IF COALESCE(r.id, '') = '' THEN RAISE EXCEPTION 'A return has no id.' USING ERRCODE = '22023'; END IF;
    -- a team member only adds returns: one already saved stays exactly as it is (its retry saves nothing new)
    IF uid <> auth.uid() AND EXISTS (SELECT 1 FROM public.hangtag_returns x WHERE x.owner_id = uid AND x.id = r.id) THEN
        RETURN jsonb_build_object('status', 'saved', 'return', r.id, 'lines', (SELECT count(*) FROM public.hangtag_return_items i WHERE i.owner_id = uid AND i.return_id = r.id));
    END IF;
    SELECT is_void INTO voided FROM public.hangtag_sales WHERE owner_id = uid AND id = r.sale_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Bill % was not found', r.sale_id USING ERRCODE = 'foreign_key_violation';
    END IF;
    IF voided THEN
        RAISE EXCEPTION 'That bill is cancelled, so it can''t have a return' USING ERRCODE = 'check_violation';
    END IF;
    INSERT INTO public.hangtag_returns (id, sale_id, t, kind, exchange_id, refund_amount, refund_method, value, round_off, credit_no, note, device_id)
    VALUES (r.id, r.sale_id, r.t, COALESCE(r.kind, 'return'), r.exchange_id, COALESCE(r.refund_amount, 0), r.refund_method, COALESCE(r.value, 0),
        COALESCE(r.round_off, 0), r.credit_no, r.note, r.device_id)
    ON CONFLICT (owner_id, id) DO UPDATE SET sale_id = EXCLUDED.sale_id, t = EXCLUDED.t, kind = EXCLUDED.kind, exchange_id = EXCLUDED.exchange_id,
        refund_amount = EXCLUDED.refund_amount, refund_method = EXCLUDED.refund_method, value = EXCLUDED.value, round_off = EXCLUDED.round_off,
        credit_no = EXCLUDED.credit_no, note = EXCLUDED.note, device_id = EXCLUDED.device_id;
    DELETE FROM public.hangtag_return_items i WHERE i.owner_id = uid AND i.return_id = r.id
       AND i.line_no NOT IN (SELECT (y ->> 'line_no')::int FROM jsonb_array_elements(COALESCE(p_items, '[]'::jsonb)) y);
    INSERT INTO public.hangtag_return_items (return_id, line_no, sale_id, sale_line_no, variant_id, product_id, product_name, color, size, sku,
        quantity, unit_price, value, cost_price, variant_label, options, restock, taxable_value, gst_rate, cgst_amount, sgst_amount, igst_amount, hsn)
    SELECT r.id, i.line_no, r.sale_id, i.sale_line_no, i.variant_id, i.product_id, i.product_name, COALESCE(i.color, ''), COALESCE(i.size, ''), i.sku,
        i.quantity, COALESCE(i.unit_price, 0), COALESCE(i.value, 0), i.cost_price, i.variant_label, i.options, COALESCE(i.restock, TRUE), i.taxable_value,
        i.gst_rate, COALESCE(i.cgst_amount, 0), COALESCE(i.sgst_amount, 0), COALESCE(i.igst_amount, 0), i.hsn
    FROM jsonb_populate_recordset(NULL::public.hangtag_return_items, COALESCE(p_items, '[]'::jsonb)) i
    ON CONFLICT (owner_id, return_id, line_no) DO UPDATE SET sale_id = EXCLUDED.sale_id, sale_line_no = EXCLUDED.sale_line_no,
        variant_id = EXCLUDED.variant_id, product_id = EXCLUDED.product_id, product_name = EXCLUDED.product_name, color = EXCLUDED.color,
        size = EXCLUDED.size, sku = EXCLUDED.sku, quantity = EXCLUDED.quantity, unit_price = EXCLUDED.unit_price, value = EXCLUDED.value,
        cost_price = EXCLUDED.cost_price, variant_label = EXCLUDED.variant_label, options = EXCLUDED.options, restock = EXCLUDED.restock,
        taxable_value = EXCLUDED.taxable_value, gst_rate = EXCLUDED.gst_rate, cgst_amount = EXCLUDED.cgst_amount, sgst_amount = EXCLUDED.sgst_amount,
        igst_amount = EXCLUDED.igst_amount, hsn = EXCLUDED.hsn;
    SELECT count(*), COALESCE(SUM(value), 0) INTO n, lines_value FROM public.hangtag_return_items WHERE owner_id = uid AND return_id = r.id;
    IF n = 0 THEN RAISE EXCEPTION 'A return needs at least one line' USING ERRCODE = 'check_violation'; END IF;
    IF COALESCE(r.value, 0) <> lines_value + COALESCE(r.round_off, 0) THEN
        RAISE EXCEPTION 'Return % is worth % but its lines come to %', COALESCE(r.credit_no, r.id), r.value, lines_value + COALESCE(r.round_off, 0)
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN jsonb_build_object('status', 'saved', 'return', r.id, 'lines', n);
END $$;
REVOKE ALL ON FUNCTION public.hangtag_save_return(JSONB, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.hangtag_save_return(JSONB, JSONB) TO authenticated;

-- Events and the bills made at them
CREATE TABLE IF NOT EXISTS public.hangtag_events (
    owner_id UUID NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    name TEXT NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    location TEXT CHECK (location IS NULL OR char_length(location) <= 120),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','closed')),
    created_t BIGINT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (owner_id, id),
    CONSTRAINT hangtag_events_dates_check CHECK (end_date >= start_date)
);
ALTER TABLE public.hangtag_sales ADD COLUMN IF NOT EXISTS event_id TEXT;
CREATE INDEX IF NOT EXISTS idx_hangtag_sales_event ON public.hangtag_sales (owner_id, event_id) WHERE event_id IS NOT NULL;
-- An event with bills can't be deleted (close it instead). Deleting the whole account still removes everything: the check
-- only applies while the account exists.
CREATE OR REPLACE FUNCTION public.hangtag_event_delete_check()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM auth.users u WHERE u.id = OLD.owner_id)
       AND EXISTS (SELECT 1 FROM public.hangtag_sales s WHERE s.owner_id = OLD.owner_id AND s.event_id = OLD.id) THEN
        RAISE EXCEPTION 'The event "%" has bills, so it can''t be deleted. Close it instead.', OLD.name USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
END $$;
DROP TRIGGER IF EXISTS hangtag_event_delete_check ON public.hangtag_events;
CREATE TRIGGER hangtag_event_delete_check BEFORE DELETE ON public.hangtag_events
    FOR EACH ROW EXECUTE FUNCTION public.hangtag_event_delete_check();
REVOKE EXECUTE ON FUNCTION public.hangtag_event_delete_check() FROM PUBLIC, anon;

-- ------------------------------------------------------------------------------
-- 3h. Verified payments, unmatched receipts, automatic receipt delivery, invoice links
-- ------------------------------------------------------------------------------
-- Payment intents at the provider: a single-use UPI QR or a card payment link for an exact amount. Written only by the
-- payment-gateway and payment-webhook Edge Functions (read-only for the app). A QR being shown is never a payment:
-- "verified" means the provider confirmed a captured payment of exactly the amount; money for a cancelled or expired
-- intent, or of another amount, is "unmatched" until the shop refunds or allocates it. kind 'match' records a UPI
-- payment checked by hand that was later matched to the provider's payment.
CREATE TABLE IF NOT EXISTS public.hangtag_payment_intents (
    id UUID PRIMARY KEY,
    owner_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    client_sale_id TEXT,
    amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
    method TEXT NOT NULL,
    provider TEXT NOT NULL,
    provider_intent_id TEXT NOT NULL,
    provider_payment_id TEXT,
    provider_fee NUMERIC(12,2),
    reference TEXT NOT NULL,
    status TEXT NOT NULL,
    qr_url TEXT,
    expires_at TIMESTAMPTZ,
    checked_at TIMESTAMPTZ,
    provider_response JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (owner_id, provider, provider_intent_id)
);
ALTER TABLE public.hangtag_payment_intents ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'qr';
ALTER TABLE public.hangtag_payment_intents ADD COLUMN IF NOT EXISTS link_url TEXT;
ALTER TABLE public.hangtag_payment_intents ADD COLUMN IF NOT EXISTS paid_amount NUMERIC(12,2);
ALTER TABLE public.hangtag_payment_intents ADD COLUMN IF NOT EXISTS provider_fee NUMERIC(12,2);
ALTER TABLE public.hangtag_payment_intents ADD COLUMN IF NOT EXISTS resolution TEXT NOT NULL DEFAULT 'open';
ALTER TABLE public.hangtag_payment_intents ADD COLUMN IF NOT EXISTS resolution_note TEXT;
ALTER TABLE public.hangtag_payment_intents ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;
ALTER TABLE public.hangtag_payment_intents ADD COLUMN IF NOT EXISTS refund_id TEXT;
ALTER TABLE public.hangtag_payment_intents ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE public.hangtag_payment_intents DROP CONSTRAINT IF EXISTS hangtag_payment_intents_status_check;
ALTER TABLE public.hangtag_payment_intents DROP CONSTRAINT IF EXISTS hangtag_payment_intents_method_check;
ALTER TABLE public.hangtag_payment_intents DROP CONSTRAINT IF EXISTS hangtag_payment_intents_provider_check;
ALTER TABLE public.hangtag_payment_intents DROP CONSTRAINT IF EXISTS hangtag_payment_intents_state_check;
ALTER TABLE public.hangtag_payment_intents ADD CONSTRAINT hangtag_payment_intents_state_check CHECK (
    status IN ('created','pending','verified','failed','cancelled','expired','unmatched')
    AND method IN ('upi','card') AND provider IN ('razorpay') AND kind IN ('qr','link','match')
    AND resolution IN ('open','refunded','allocated')
    AND (status NOT IN ('verified','unmatched') OR paid_amount IS NOT NULL)
    AND (resolution = 'open' OR status = 'unmatched')
    AND (provider_fee IS NULL OR provider_fee >= 0)
    AND char_length(reference) <= 64 AND (client_sale_id IS NULL OR char_length(client_sale_id) <= 64)
    AND (resolution_note IS NULL OR char_length(resolution_note) <= 200));
-- the webhook finds an intent by the provider's id
CREATE INDEX IF NOT EXISTS idx_hangtag_payment_intents_provider ON public.hangtag_payment_intents (provider, provider_intent_id);
CREATE INDEX IF NOT EXISTS idx_hangtag_payment_intents_owner_created ON public.hangtag_payment_intents (owner_id, created_at DESC);

-- How each payment part was confirmed: verified (by the provider), recorded (cash; card machine with its reference) or
-- unverified (UPI checked by hand, with the UTR). Never a card number: at most the last 4 digits.
ALTER TABLE public.hangtag_payments ADD COLUMN IF NOT EXISTS verification TEXT NOT NULL DEFAULT 'recorded';
ALTER TABLE public.hangtag_payments ADD COLUMN IF NOT EXISTS via TEXT;
ALTER TABLE public.hangtag_payments ADD COLUMN IF NOT EXISTS intent_id UUID;
ALTER TABLE public.hangtag_payments ADD COLUMN IF NOT EXISTS provider_payment_id TEXT;
ALTER TABLE public.hangtag_payments ADD COLUMN IF NOT EXISTS card_last4 TEXT;
ALTER TABLE public.hangtag_payments ADD COLUMN IF NOT EXISTS provider_fee NUMERIC(12,2);
ALTER TABLE public.hangtag_payments DROP CONSTRAINT IF EXISTS hangtag_payments_verification_check;
ALTER TABLE public.hangtag_payments ADD CONSTRAINT hangtag_payments_verification_check CHECK (
    verification IN ('verified','recorded','unverified')
    AND (via IS NULL OR (method = 'upi' AND via IN ('manual','qr')) OR (method = 'card' AND via IN ('terminal','link')))
    AND (method <> 'cash' OR (via IS NULL AND verification = 'recorded'))
    AND (verification <> 'unverified' OR method = 'upi')
    AND (verification <> 'verified' OR intent_id IS NOT NULL)
    AND (card_last4 IS NULL OR (method = 'card' AND card_last4 ~ '^[0-9]{4}$'))
    AND (provider_fee IS NULL OR (verification = 'verified' AND provider_fee >= 0))
    AND (provider_payment_id IS NULL OR char_length(provider_payment_id) <= 64)) NOT VALID;
-- one provider payment pays one bill part, once
CREATE UNIQUE INDEX IF NOT EXISTS hangtag_payments_intent_key ON public.hangtag_payments (owner_id, intent_id) WHERE intent_id IS NOT NULL;
-- "verified" only with a verified intent of this shop for the same method and amount: the app can't make it up
CREATE OR REPLACE FUNCTION public.hangtag_payment_verified_check()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE trusted_fee NUMERIC;
BEGIN
    IF NEW.verification = 'verified' THEN
        SELECT i.provider_fee INTO trusted_fee FROM public.hangtag_payment_intents i
         WHERE i.owner_id = NEW.owner_id AND i.id = NEW.intent_id AND i.status = 'verified' AND i.method = NEW.method AND i.amount = NEW.amount;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Payment % is marked verified but the payment provider has not confirmed it', NEW.id USING ERRCODE = 'check_violation';
        END IF;
        -- Fee/MDR is informational but still comes only from the server-owned intent; never trust a value uploaded by a phone.
        NEW.provider_fee := trusted_fee;
    ELSE
        NEW.provider_fee := NULL;
    END IF;
    RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS hangtag_payment_verified_check ON public.hangtag_payments;
CREATE TRIGGER hangtag_payment_verified_check BEFORE INSERT OR UPDATE ON public.hangtag_payments
    FOR EACH ROW EXECUTE FUNCTION public.hangtag_payment_verified_check();
UPDATE public.hangtag_payments p SET provider_fee = i.provider_fee
  FROM public.hangtag_payment_intents i
 WHERE p.owner_id = i.owner_id AND p.intent_id = i.id AND p.verification = 'verified'
   AND p.provider_fee IS DISTINCT FROM i.provider_fee;
REVOKE EXECUTE ON FUNCTION public.hangtag_payment_verified_check() FROM PUBLIC, anon;

-- Receipts sent automatically when a bill completes go once per bill and channel, however often the phone retries
ALTER TABLE public.hangtag_deliveries ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE public.hangtag_deliveries ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ;
ALTER TABLE public.hangtag_deliveries ADD COLUMN IF NOT EXISTS checked_at TIMESTAMPTZ;
ALTER TABLE public.hangtag_deliveries DROP CONSTRAINT IF EXISTS hangtag_deliveries_status_check;
ALTER TABLE public.hangtag_deliveries ADD CONSTRAINT hangtag_deliveries_status_check CHECK (status IN ('pending','sent','delivered','failed'));
ALTER TABLE public.hangtag_deliveries DROP CONSTRAINT IF EXISTS hangtag_deliveries_sent_check;
ALTER TABLE public.hangtag_deliveries ADD CONSTRAINT hangtag_deliveries_sent_check CHECK (status NOT IN ('sent','delivered') OR provider_message_id IS NOT NULL);
ALTER TABLE public.hangtag_deliveries DROP CONSTRAINT IF EXISTS hangtag_deliveries_mode_check;
ALTER TABLE public.hangtag_deliveries ADD CONSTRAINT hangtag_deliveries_mode_check CHECK (mode IN ('manual','auto'));
CREATE UNIQUE INDEX IF NOT EXISTS hangtag_deliveries_auto_once ON public.hangtag_deliveries (owner_id, sale_id, channel)
    WHERE mode = 'auto' AND status IN ('pending','sent','delivered');

-- Secure invoice links (in SMS and WhatsApp receipts): an unguessable token shows that one bill only, for 12 months,
-- until the shop revokes it. Written by the send-receipt function and read by the receipt function; the app may read
-- its own links and revoke them.
CREATE TABLE IF NOT EXISTS public.hangtag_invoice_links (
    token TEXT PRIMARY KEY CHECK (token ~ '^[A-Za-z0-9_-]{32,64}$'),
    owner_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    sale_id TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    views INTEGER NOT NULL DEFAULT 0,
    last_viewed_at TIMESTAMPTZ,
    CONSTRAINT hangtag_invoice_links_sale_fkey FOREIGN KEY (owner_id, sale_id) REFERENCES public.hangtag_sales (owner_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_hangtag_invoice_links_sale ON public.hangtag_invoice_links (owner_id, sale_id);

-- A return refunded through the payment provider keeps the provider's refund id (written by payment-gateway only;
-- RPC hangtag_save_return leaves it alone), so the same refund is never sent twice
ALTER TABLE public.hangtag_returns ADD COLUMN IF NOT EXISTS provider_refund_id TEXT;

-- A cancelled bill keeps why it was cancelled (spec 006: a reason is required); restoring the bill clears it
ALTER TABLE public.hangtag_sales ADD COLUMN IF NOT EXISTS void_reason TEXT;
ALTER TABLE public.hangtag_sales DROP CONSTRAINT IF EXISTS hangtag_sales_void_reason_check;
ALTER TABLE public.hangtag_sales ADD CONSTRAINT hangtag_sales_void_reason_check CHECK (void_reason IS NULL OR (is_void AND char_length(void_reason) <= 200)) NOT VALID;

-- Cash without a bill (spec 007): opening float, cash in, cash out, expenses and reversals. Entries are never changed or
-- deleted (the app may only add them); a mistake is put right by one reversal entry that names it. The app adds these
-- to its cash book next to the cash sales and refunds of section 3e.
CREATE TABLE IF NOT EXISTS public.hangtag_cash_moves (
    owner_id UUID NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
    id TEXT NOT NULL CHECK (char_length(id) BETWEEN 1 AND 64),
    type TEXT NOT NULL CHECK (type IN ('opening','in','out','expense','reversal')),
    amount NUMERIC(12,2) NOT NULL CHECK (amount > 0 AND amount <= 1000000),
    reason TEXT NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 200),
    category TEXT CHECK (category IS NULL OR char_length(category) BETWEEN 1 AND 40),
    reverses TEXT,
    t BIGINT NOT NULL,
    device_id TEXT,
    event_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (owner_id, id),
    CONSTRAINT hangtag_cash_moves_kind_check CHECK ((type = 'expense') = (category IS NOT NULL) AND (type = 'reversal') = (reverses IS NOT NULL)),
    CONSTRAINT hangtag_cash_moves_reverses_fkey FOREIGN KEY (owner_id, reverses) REFERENCES public.hangtag_cash_moves (owner_id, id) ON DELETE CASCADE
);
-- an entry is reversed at most once
CREATE UNIQUE INDEX IF NOT EXISTS hangtag_cash_moves_reversed_once ON public.hangtag_cash_moves (owner_id, reverses) WHERE reverses IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_hangtag_cash_moves_time ON public.hangtag_cash_moves (owner_id, t);
-- a reversal is for the same amount as its entry, and never of another reversal
CREATE OR REPLACE FUNCTION public.hangtag_cash_move_check()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE o RECORD;
BEGIN
    IF NEW.type = 'reversal' THEN
        SELECT type, amount INTO o FROM public.hangtag_cash_moves WHERE owner_id = NEW.owner_id AND id = NEW.reverses;
        IF o.type IS NULL THEN RAISE EXCEPTION 'Cash entry % was not found', NEW.reverses USING ERRCODE = 'foreign_key_violation'; END IF;
        IF o.type = 'reversal' OR o.amount <> NEW.amount THEN
            RAISE EXCEPTION 'A reversal must be for the whole of an entry that is not itself a reversal' USING ERRCODE = 'check_violation';
        END IF;
    END IF;
    RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS hangtag_cash_move_check ON public.hangtag_cash_moves;
CREATE TRIGGER hangtag_cash_move_check BEFORE INSERT ON public.hangtag_cash_moves FOR EACH ROW EXECUTE FUNCTION public.hangtag_cash_move_check();
REVOKE EXECUTE ON FUNCTION public.hangtag_cash_move_check() FROM PUBLIC, anon;
-- Day closes: what the drawer should hold, what was counted, the difference (per day, for the shop or one device)
CREATE TABLE IF NOT EXISTS public.hangtag_day_closes (
    owner_id UUID NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
    id TEXT NOT NULL CHECK (char_length(id) BETWEEN 1 AND 80),
    day DATE NOT NULL,
    scope TEXT NOT NULL CHECK (char_length(scope) BETWEEN 1 AND 40),
    expected NUMERIC(12,2) NOT NULL,
    counted NUMERIC(12,2) NOT NULL CHECK (counted >= 0),
    difference NUMERIC(12,2) NOT NULL,
    note TEXT CHECK (note IS NULL OR char_length(note) <= 200),
    t BIGINT NOT NULL,
    device_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (owner_id, id),
    CONSTRAINT hangtag_day_closes_diff_check CHECK (difference = counted - expected),
    CONSTRAINT hangtag_day_closes_one UNIQUE (owner_id, day, scope)
);

-- ==============================================================================
-- 3i. Team, roles, devices, audit
--   The shop is the owner's account: every owner_id column means "the shop" (as before). Staff are accounts of their
--   own, each a member of exactly one shop (hangtag_members) with a role. A role's permissions are the defaults below
--   unless the owner changed them (hangtag_roles). A member reaches the shop only from an enrolled device: the app sends
--   the device key in the x-hangtag-device header on every request, and public.hangtag_shop_id() gives the member's
--   shop only while the member is active and that key's hash matches one of the member's active devices. Otherwise the
--   member sees nothing and can change nothing. Every account that is not a member is an owner: hangtag_shop_id() is its
--   own id and it may do everything, exactly as before.
--   Members, devices and enrollments are written by the team Edge Function (service role). The owner may also rename a
--   member, change the role or status, rename, revoke or remove a device, and edit role permissions. The audit log is
--   written only by the triggers below (the app can read it with view_reports). Bills, returns and stock records are
--   history for a member: it adds them, never rewrites or removes them (f). The team function ends a member's sign-ins
--   on reset, revoke and switch-off (g). A member's phone polls what changed instead of downloading everything (h).
-- ==============================================================================
-- (a) Team members and their devices
CREATE TABLE IF NOT EXISTS public.hangtag_members (
    user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    shop_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    name TEXT NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
    username TEXT NOT NULL CHECK (username ~ '^[a-z0-9._-]{3,30}$'),
    role TEXT NOT NULL CHECK (role ~ '^[a-z][a-z0-9_]{1,29}$' AND role <> 'owner'),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by UUID,
    last_seen_at TIMESTAMPTZ,
    CONSTRAINT hangtag_members_shop_username_key UNIQUE (shop_id, username),
    CONSTRAINT hangtag_members_user_shop_key UNIQUE (user_id, shop_id),
    CONSTRAINT hangtag_members_not_owner_check CHECK (user_id <> shop_id)
);
-- when the owner last reset or switched off the member's access (a phone added with a password must be signed in after
-- it), whether the owner gave the member a password (else it joins phones by QR only), and who last changed the row (the
-- team Edge Function writes with the service role, so the audit log reads the owner from here)
ALTER TABLE public.hangtag_members ADD COLUMN IF NOT EXISTS access_reset_at TIMESTAMPTZ;
ALTER TABLE public.hangtag_members ADD COLUMN IF NOT EXISTS password_signin BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE public.hangtag_members ADD COLUMN IF NOT EXISTS changed_by UUID;
-- A device of a member: only the hash of its key is kept (the key itself lives only on the device)
CREATE TABLE IF NOT EXISTS public.hangtag_devices (
    owner_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    id TEXT NOT NULL CHECK (id ~ '^[A-Za-z0-9_-]{8,64}$'),
    user_id UUID NOT NULL,
    name TEXT NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 60),
    platform TEXT CHECK (platform IS NULL OR char_length(platform) <= 40),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
    key_hash TEXT NOT NULL CHECK (key_hash ~ '^[0-9a-f]{64}$'),
    enrolled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    PRIMARY KEY (owner_id, id),
    CONSTRAINT hangtag_devices_key_hash_key UNIQUE (key_hash),
    CONSTRAINT hangtag_devices_revoked_check CHECK ((status = 'revoked') = (revoked_at IS NOT NULL)),
    -- a device belongs to a member of the same shop, and goes with the member
    CONSTRAINT hangtag_devices_member_fkey FOREIGN KEY (user_id, owner_id) REFERENCES public.hangtag_members (user_id, shop_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_hangtag_devices_user ON public.hangtag_devices (user_id);
ALTER TABLE public.hangtag_devices ADD COLUMN IF NOT EXISTS changed_by UUID;   -- who enrolled, revoked or removed it (for the audit log)

-- (b) Who is asking: the shop, the role and the permissions of the signed-in account
-- The permissions of each role when the shop hasn't changed them (the same lists as src/domain/shop/permissions.js and
-- supabase/functions/team/core.js)
CREATE OR REPLACE FUNCTION public.hangtag_default_permissions(p_role TEXT)
RETURNS TEXT[] LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
    SELECT CASE p_role
        WHEN 'owner' THEN ARRAY['view_products','manage_products','manage_inventory','create_purchase','create_sale','apply_discount',
            'view_reports','perform_return','collect_credit','manage_users','manage_devices','manage_tables','create_order',
            'send_to_kitchen','manage_kitchen','manage_settings']
        WHEN 'manager' THEN ARRAY['view_products','manage_products','manage_inventory','create_purchase','create_sale','apply_discount',
            'view_reports','perform_return','collect_credit','manage_tables','create_order','send_to_kitchen','manage_kitchen','manage_settings']
        WHEN 'cashier' THEN ARRAY['view_products','create_sale','apply_discount','perform_return','collect_credit','create_order',
            'send_to_kitchen','manage_tables']
        WHEN 'server' THEN ARRAY['view_products','create_order','send_to_kitchen','manage_tables']
        WHEN 'kitchen' THEN ARRAY['manage_kitchen']
        ELSE '{}'::TEXT[] END
$$;
-- The hash of this request's device key (PostgREST puts the request's headers in request.headers), or NULL
CREATE OR REPLACE FUNCTION public.hangtag_request_device()
RETURNS TEXT LANGUAGE sql STABLE SET search_path = '' AS $$
    SELECT CASE WHEN k IS NOT NULL AND char_length(k) BETWEEN 20 AND 200 THEN encode(sha256(convert_to(k, 'UTF8')), 'hex') END
    FROM (SELECT CASE WHEN h LIKE '{%' THEN h::json ->> 'x-hangtag-device' END AS k
          FROM (SELECT current_setting('request.headers', true) AS h) a) b
$$;
-- The shop of the signed-in account: NULL when signed out; the account itself when it is not a team member (an owner);
-- for a member, its shop only while it is active and asks from one of its active devices (else NULL: nothing at all).
-- These three are plpgsql (not sql): row security calls them in every statement, and a SECURITY DEFINER sql function is
-- planned again on every call, while plpgsql keeps its plans for the session. Each reads the member row once.
CREATE OR REPLACE FUNCTION public.hangtag_shop_id()
RETURNS UUID LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    u UUID := auth.uid();
    m RECORD;
BEGIN
    IF u IS NULL THEN RETURN NULL; END IF;
    SELECT x.shop_id, x.status INTO m FROM public.hangtag_members x WHERE x.user_id = u;
    IF NOT FOUND THEN RETURN u; END IF;
    IF m.status = 'active' AND EXISTS (SELECT 1 FROM public.hangtag_devices d
        WHERE d.key_hash = public.hangtag_request_device() AND d.owner_id = m.shop_id AND d.user_id = u AND d.status = 'active') THEN
        RETURN m.shop_id;
    END IF;
    RETURN NULL;
END $$;
-- 'owner', the member's role, or NULL (no shop)
CREATE OR REPLACE FUNCTION public.hangtag_role()
RETURNS TEXT LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    u UUID := auth.uid();
    m RECORD;
BEGIN
    IF u IS NULL THEN RETURN NULL; END IF;
    SELECT x.shop_id, x.status, x.role INTO m FROM public.hangtag_members x WHERE x.user_id = u;
    IF NOT FOUND THEN RETURN 'owner'; END IF;
    IF m.status = 'active' AND EXISTS (SELECT 1 FROM public.hangtag_devices d
        WHERE d.key_hash = public.hangtag_request_device() AND d.owner_id = m.shop_id AND d.user_id = u AND d.status = 'active') THEN
        RETURN m.role;
    END IF;
    RETURN NULL;
END $$;

-- A shop's own permissions for a role (no row = the defaults above)
CREATE TABLE IF NOT EXISTS public.hangtag_roles (
    owner_id UUID NOT NULL DEFAULT public.hangtag_shop_id() REFERENCES auth.users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role ~ '^[a-z][a-z0-9_]{1,29}$' AND role <> 'owner'),
    label TEXT CHECK (label IS NULL OR char_length(btrim(label)) BETWEEN 1 AND 40),
    permissions TEXT[] NOT NULL DEFAULT '{}',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (owner_id, role),
    -- only known permissions (the owner's list is all of them)
    CONSTRAINT hangtag_roles_permissions_check CHECK (permissions <@ public.hangtag_default_permissions('owner'))
);
-- Whether the signed-in account may do p in its shop: an owner may do everything; a member what its role allows
CREATE OR REPLACE FUNCTION public.hangtag_can(p TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    u UUID := auth.uid();
    m RECORD;
    perms TEXT[];
BEGIN
    IF u IS NULL THEN RETURN FALSE; END IF;
    SELECT x.shop_id, x.status, x.role INTO m FROM public.hangtag_members x WHERE x.user_id = u;
    IF NOT FOUND THEN RETURN TRUE; END IF;   -- an owner may do everything
    IF m.status <> 'active' OR NOT EXISTS (SELECT 1 FROM public.hangtag_devices d
        WHERE d.key_hash = public.hangtag_request_device() AND d.owner_id = m.shop_id AND d.user_id = u AND d.status = 'active') THEN
        RETURN FALSE;
    END IF;
    SELECT r.permissions INTO perms FROM public.hangtag_roles r WHERE r.owner_id = m.shop_id AND r.role = m.role;
    RETURN COALESCE(p = ANY (COALESCE(perms, public.hangtag_default_permissions(m.role))), FALSE);
END $$;

-- (c) Enrolling a device: a single-use QR token for one member, valid 10 minutes (only its hash is kept)
CREATE TABLE IF NOT EXISTS public.hangtag_enrollments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id UUID NOT NULL DEFAULT public.hangtag_shop_id() REFERENCES auth.users(id) ON DELETE CASCADE,
    user_id UUID NOT NULL,
    token_hash TEXT NOT NULL CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + interval '10 minutes'),
    used_at TIMESTAMPTZ,
    device_id TEXT,
    created_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT hangtag_enrollments_token_key UNIQUE (token_hash),
    CONSTRAINT hangtag_enrollments_expiry_check CHECK (expires_at <= created_at + interval '10 minutes'),
    CONSTRAINT hangtag_enrollments_member_fkey FOREIGN KEY (user_id, owner_id) REFERENCES public.hangtag_members (user_id, shop_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_hangtag_enrollments_member ON public.hangtag_enrollments (owner_id, user_id);

-- (d) The audit log: who did what, from which device. Written only by public.hangtag_audit() (a trigger); small rows.
CREATE TABLE IF NOT EXISTS public.hangtag_audit_log (
    owner_id UUID NOT NULL DEFAULT public.hangtag_shop_id() REFERENCES auth.users(id) ON DELETE CASCADE,
    id BIGSERIAL,
    t TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    user_id UUID,                                  -- no link: the log outlives a removed member
    device_id TEXT,
    action TEXT NOT NULL,                          -- insert | update | delete | void | restore | archive | unarchive | revoke | disable | enable
    entity TEXT NOT NULL,                          -- the table without "hangtag_" (sales, returns, stock_moves …)
    entity_id TEXT,
    summary JSONB NOT NULL DEFAULT '{}'::jsonb,    -- a few fields of the row (and the names of the changed columns)
    PRIMARY KEY (owner_id, id)
);
CREATE INDEX IF NOT EXISTS idx_hangtag_audit_time ON public.hangtag_audit_log (owner_id, t DESC);

-- A member's device calls this when the app opens and now and then: it keeps "last seen" and tells the app whether it
-- still reaches the shop ({shop_id, role, device_id}; shop_id null = signed out of the shop: disabled, revoked or no key)
CREATE OR REPLACE FUNCTION public.hangtag_touch_device()
RETURNS JSONB LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    shop UUID := public.hangtag_shop_id();
    dev TEXT;
BEGIN
    IF shop IS NULL THEN RETURN jsonb_build_object('shop_id', NULL, 'role', NULL, 'device_id', NULL); END IF;
    IF shop <> auth.uid() THEN
        UPDATE public.hangtag_devices SET last_seen_at = NOW()
         WHERE key_hash = public.hangtag_request_device() AND owner_id = shop AND user_id = auth.uid() AND status = 'active'
        RETURNING id INTO dev;
        UPDATE public.hangtag_members SET last_seen_at = NOW() WHERE user_id = auth.uid();
    END IF;
    RETURN jsonb_build_object('shop_id', shop, 'role', public.hangtag_role(), 'device_id', dev);
END $$;

-- A member stays in its shop, never runs a shop of its own, and a shop is never itself a member
CREATE OR REPLACE FUNCTION public.hangtag_member_check()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
    IF TG_OP = 'UPDATE' AND (NEW.user_id <> OLD.user_id OR NEW.shop_id <> OLD.shop_id) THEN
        RAISE EXCEPTION 'A team member stays in its shop' USING ERRCODE = 'check_violation';
    END IF;
    IF TG_OP = 'INSERT' AND (EXISTS (SELECT 1 FROM public.hangtag_members m WHERE m.shop_id = NEW.user_id)
        OR EXISTS (SELECT 1 FROM public.hangtag_products p WHERE p.owner_id = NEW.user_id)
        OR EXISTS (SELECT 1 FROM public.hangtag_sales s WHERE s.owner_id = NEW.user_id)) THEN
        RAISE EXCEPTION 'That account runs a shop of its own, so it can''t join another one' USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM public.hangtag_members m WHERE m.user_id = NEW.shop_id) THEN
        RAISE EXCEPTION 'A team member can''t have a team of its own' USING ERRCODE = 'check_violation';
    END IF;
    -- switched off: a phone can be added again only with a password sign-in made after now (the team function checks it)
    IF TG_OP = 'UPDATE' AND NEW.status = 'disabled' AND OLD.status <> 'disabled' THEN NEW.access_reset_at := NOW(); END IF;
    RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS hangtag_member_check ON public.hangtag_members;
CREATE TRIGGER hangtag_member_check BEFORE INSERT OR UPDATE ON public.hangtag_members
    FOR EACH ROW EXECUTE FUNCTION public.hangtag_member_check();
-- A device keeps its shop, member and key; a revoked device stays revoked (enroll the phone again instead)
CREATE OR REPLACE FUNCTION public.hangtag_device_check()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
    IF NEW.owner_id <> OLD.owner_id OR NEW.user_id <> OLD.user_id OR NEW.key_hash <> OLD.key_hash THEN
        RAISE EXCEPTION 'A device keeps its shop, member and key' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.status = 'revoked' AND NEW.status <> 'revoked' THEN
        RAISE EXCEPTION 'A revoked device can''t be switched back on. Enroll it again.' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS hangtag_device_check ON public.hangtag_devices;
CREATE TRIGGER hangtag_device_check BEFORE UPDATE ON public.hangtag_devices
    FOR EACH ROW EXECUTE FUNCTION public.hangtag_device_check();

-- (e) Audit: one small row per change worth knowing about (bills cancelled, restored, changed or removed, their lines and
-- payments changed or removed, returns, stock adjustments and any stock record changed or removed, cash entries, day
-- closes, customers, team, roles, devices, events, products added, removed or archived). A change of "last seen" or
-- "updated at" only is not logged, nor is a shop whose account is being deleted. Who: the signed-in account; for a
-- change the team Edge Function made (service role), the owner it names in changed_by (or created_by).
CREATE OR REPLACE FUNCTION public.hangtag_audit()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    r JSONB;
    o JSONB;
    shop UUID;
    act TEXT := lower(TG_OP);
    changed TEXT[];
    dev TEXT;
    summary JSONB;
    keep CONSTANT TEXT[] := ARRAY['status','name','username','role','label','permissions','type','qty','amount','reason','category',
        'reverses','refund_amount','refund_method','value','credit_no','bill_no','total','is_void','void_reason','kind','sale_id',
        'variant_id','product_id','note','day','scope','expected','counted','difference','archived','platform','user_id',
        'start_date','end_date','method','credit','discount','quantity','unit_price','line_no','return_id'];
BEGIN
    IF TG_OP = 'DELETE' THEN r := to_jsonb(OLD); ELSE r := to_jsonb(NEW); END IF;
    shop := COALESCE(r ->> 'owner_id', r ->> 'shop_id')::UUID;
    IF shop IS NULL OR NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = shop) THEN RETURN NULL; END IF;
    IF TG_OP = 'UPDATE' THEN
        o := to_jsonb(OLD);
        SELECT array_agg(k ORDER BY k) INTO changed FROM jsonb_object_keys(r) k
         WHERE k NOT IN ('updated_at','last_seen_at','created_at','changed_by') AND (r -> k) IS DISTINCT FROM (o -> k);
        IF changed IS NULL THEN RETURN NULL; END IF;
        act := CASE
            WHEN TG_TABLE_NAME = 'hangtag_sales' AND 'is_void' = ANY (changed) THEN CASE WHEN (r ->> 'is_void')::BOOLEAN THEN 'void' ELSE 'restore' END
            WHEN TG_TABLE_NAME = 'hangtag_products' AND 'archived' = ANY (changed) THEN CASE WHEN (r ->> 'archived')::BOOLEAN THEN 'archive' ELSE 'unarchive' END
            WHEN TG_TABLE_NAME = 'hangtag_devices' AND 'status' = ANY (changed) AND r ->> 'status' = 'revoked' THEN 'revoke'
            WHEN TG_TABLE_NAME = 'hangtag_members' AND 'status' = ANY (changed) THEN CASE WHEN r ->> 'status' = 'disabled' THEN 'disable' ELSE 'enable' END
            WHEN TG_TABLE_NAME = 'hangtag_members' AND 'access_reset_at' = ANY (changed) THEN 'reset'
            ELSE 'update' END;
    END IF;
    -- the member's device that made the change (the owner has none: then the device the row names, if any)
    SELECT d.id INTO dev FROM public.hangtag_devices d
     WHERE d.key_hash = public.hangtag_request_device() AND d.user_id = auth.uid() AND d.status = 'active';
    SELECT COALESCE(jsonb_object_agg(e.key, CASE WHEN jsonb_typeof(e.value) = 'string' THEN to_jsonb(left(e.value #>> '{}', 80)) ELSE e.value END), '{}'::jsonb)
      INTO summary FROM jsonb_each(r) e WHERE e.key = ANY (keep) AND e.value <> 'null'::jsonb;
    IF changed IS NOT NULL THEN summary := summary || jsonb_build_object('changed', to_jsonb(changed[1:20])); END IF;
    INSERT INTO public.hangtag_audit_log (owner_id, user_id, device_id, action, entity, entity_id, summary)
    VALUES (shop, COALESCE(auth.uid(), (r ->> 'changed_by')::UUID, (r ->> 'created_by')::UUID), left(COALESCE(dev, r ->> 'device_id'), 80), act,
            regexp_replace(TG_TABLE_NAME, '^hangtag_', ''), left(COALESCE(r ->> 'id', r ->> 'user_id', r ->> 'role'), 100), summary);
    RETURN NULL;
END $$;
-- bills, their lines and payments: a new bill is its own record (not logged); cancelling, restoring, any change of a saved
-- bill, line or payment (re-uploading the same bill changes nothing, so logs nothing; a payment's status follows the bill)
-- and any removal are logged
DROP TRIGGER IF EXISTS hangtag_audit_change ON public.hangtag_sales;
CREATE TRIGGER hangtag_audit_change AFTER UPDATE ON public.hangtag_sales FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION public.hangtag_audit();
DROP TRIGGER IF EXISTS hangtag_audit_change ON public.hangtag_sale_items;
CREATE TRIGGER hangtag_audit_change AFTER UPDATE ON public.hangtag_sale_items FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION public.hangtag_audit();
DROP TRIGGER IF EXISTS hangtag_audit_change ON public.hangtag_payments;
CREATE TRIGGER hangtag_audit_change AFTER UPDATE OF sale_id, method, amount, tendered, change_given, reference, verification, card_last4 ON public.hangtag_payments FOR EACH ROW
    WHEN ((OLD.sale_id, OLD.method, OLD.amount, OLD.tendered, OLD.change_given, OLD.reference, OLD.verification, OLD.card_last4)
          IS DISTINCT FROM (NEW.sale_id, NEW.method, NEW.amount, NEW.tendered, NEW.change_given, NEW.reference, NEW.verification, NEW.card_last4))
    EXECUTE FUNCTION public.hangtag_audit();
-- stock: adjustments added, and any stock record changed or removed (opening stock and stock in are their own record)
DROP TRIGGER IF EXISTS hangtag_audit ON public.hangtag_stock_moves;
CREATE TRIGGER hangtag_audit AFTER INSERT ON public.hangtag_stock_moves FOR EACH ROW WHEN (NEW.type = 'ADJUST') EXECUTE FUNCTION public.hangtag_audit();
DROP TRIGGER IF EXISTS hangtag_audit_change ON public.hangtag_stock_moves;
CREATE TRIGGER hangtag_audit_change AFTER UPDATE ON public.hangtag_stock_moves FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION public.hangtag_audit();
-- removed: bills, lines, payments, return lines, stock records
DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['hangtag_sales','hangtag_sale_items','hangtag_payments','hangtag_return_items','hangtag_stock_moves'] LOOP
        EXECUTE format('DROP TRIGGER IF EXISTS hangtag_audit_remove ON public.%I', t);
        EXECUTE format('CREATE TRIGGER hangtag_audit_remove AFTER DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.hangtag_audit()', t);
    END LOOP;
END $$;
DROP TRIGGER IF EXISTS hangtag_audit_change ON public.hangtag_return_items;
CREATE TRIGGER hangtag_audit_change AFTER UPDATE ON public.hangtag_return_items FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION public.hangtag_audit();
-- products: added, removed, archived or brought back
DROP TRIGGER IF EXISTS hangtag_audit ON public.hangtag_products;
CREATE TRIGGER hangtag_audit AFTER INSERT OR DELETE ON public.hangtag_products FOR EACH ROW EXECUTE FUNCTION public.hangtag_audit();
DROP TRIGGER IF EXISTS hangtag_audit_change ON public.hangtag_products;
CREATE TRIGGER hangtag_audit_change AFTER UPDATE OF archived ON public.hangtag_products FOR EACH ROW
    WHEN (OLD.archived IS DISTINCT FROM NEW.archived) EXECUTE FUNCTION public.hangtag_audit();
-- cash entries are only ever added
DROP TRIGGER IF EXISTS hangtag_audit ON public.hangtag_cash_moves;
CREATE TRIGGER hangtag_audit AFTER INSERT OR DELETE ON public.hangtag_cash_moves FOR EACH ROW EXECUTE FUNCTION public.hangtag_audit();
-- everything else: added, changed (really changed) or removed
DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['hangtag_returns','hangtag_day_closes','hangtag_customers','hangtag_members','hangtag_roles','hangtag_devices','hangtag_events'] LOOP
        EXECUTE format('DROP TRIGGER IF EXISTS hangtag_audit ON public.%I', t);
        EXECUTE format('CREATE TRIGGER hangtag_audit AFTER INSERT OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.hangtag_audit()', t);
        EXECUTE format('DROP TRIGGER IF EXISTS hangtag_audit_change ON public.%I', t);
        EXECUTE format('CREATE TRIGGER hangtag_audit_change AFTER UPDATE ON public.%I FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION public.hangtag_audit()', t);
    END LOOP;
END $$;

-- (f) What a team member may write beyond row security. Bills with their lines and payments, returns with their lines, and
-- stock records are history: a member adds them, and cancels or restores a bill with perform_return or manage_settings,
-- but never rewrites one. A change to a saved row is refused unless it changes nothing (an upload sent twice); a member's
-- new bill lines and payments go only onto a bill made in the same save (return lines likewise), and removing any of them
-- is the owner's alone (section 5). A stock record changes only with manage_inventory. Discounts need apply_discount (the
-- app hides them too; a price typed lower is not checked here). The owner, the database's own SECURITY DEFINER functions
-- (posting, cancelling a bill's payments) and the Edge Functions (service role) are not limited by this.
CREATE OR REPLACE FUNCTION public.hangtag_member_write_check()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
    n JSONB;
    o JSONB;
BEGIN
    IF current_user <> 'authenticated' OR NEW.owner_id = auth.uid() THEN RETURN NEW; END IF;
    IF TG_OP = 'INSERT' THEN
        IF TG_TABLE_NAME = 'hangtag_sales' THEN
            NEW.created_at := NOW();   -- "made in this save": its lines and payments check it
            IF (COALESCE(NEW.discount, 0) > 0 OR COALESCE(NEW.item_discount, 0) > 0 OR COALESCE(NEW.bill_discount, 0) > 0)
               AND NOT public.hangtag_can('apply_discount') THEN
                RAISE EXCEPTION 'Not allowed to give discounts.' USING ERRCODE = '42501';
            END IF;
        ELSIF TG_TABLE_NAME = 'hangtag_returns' THEN
            NEW.created_at := NOW();
        ELSIF TG_TABLE_NAME = 'hangtag_sale_items' THEN
            IF NOT EXISTS (SELECT 1 FROM public.hangtag_sales s WHERE s.owner_id = NEW.owner_id AND s.id = NEW.sale_id AND s.created_at = NOW()) THEN
                RAISE EXCEPTION 'Only the owner can change a saved bill.' USING ERRCODE = '42501';
            END IF;
            IF (COALESCE(NEW.discount_amount, 0) > 0 OR COALESCE(NEW.bill_discount_share, 0) > 0) AND NOT public.hangtag_can('apply_discount') THEN
                RAISE EXCEPTION 'Not allowed to give discounts.' USING ERRCODE = '42501';
            END IF;
        ELSIF TG_TABLE_NAME = 'hangtag_payments' THEN
            IF NOT EXISTS (SELECT 1 FROM public.hangtag_sales s WHERE s.owner_id = NEW.owner_id AND s.id = NEW.sale_id AND s.created_at = NOW()) THEN
                RAISE EXCEPTION 'Only the owner can change a saved bill.' USING ERRCODE = '42501';
            END IF;
        ELSIF TG_TABLE_NAME = 'hangtag_return_items' THEN
            IF NOT EXISTS (SELECT 1 FROM public.hangtag_returns x WHERE x.owner_id = NEW.owner_id AND x.id = NEW.return_id AND x.created_at = NOW()) THEN
                RAISE EXCEPTION 'Only the owner can change a saved return.' USING ERRCODE = '42501';
            END IF;
        END IF;
        RETURN NEW;
    END IF;
    n := to_jsonb(NEW); o := to_jsonb(OLD);
    IF n = o THEN RETURN NEW; END IF;   -- the same row again (an upload sent twice): nothing changes
    IF TG_TABLE_NAME = 'hangtag_sales' AND (n - 'is_void' - 'void_reason') = (o - 'is_void' - 'void_reason') THEN
        -- cancelling or restoring a bill (and its reason)
        IF public.hangtag_can('perform_return') OR public.hangtag_can('manage_settings') THEN RETURN NEW; END IF;
        RAISE EXCEPTION 'Not allowed to cancel bills.' USING ERRCODE = '42501';
    END IF;
    IF TG_TABLE_NAME = 'hangtag_stock_moves' THEN
        IF public.hangtag_can('manage_inventory') THEN RETURN NEW; END IF;
        RAISE EXCEPTION 'Only the owner, or a role with stock adjustments, can change saved stock records.' USING ERRCODE = '42501';
    END IF;
    RAISE EXCEPTION '%', CASE WHEN TG_TABLE_NAME IN ('hangtag_returns','hangtag_return_items') THEN 'Only the owner can change a saved return.'
        ELSE 'Only the owner can change a saved bill.' END USING ERRCODE = '42501';
END $$;
DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['hangtag_sales','hangtag_sale_items','hangtag_payments','hangtag_returns','hangtag_return_items','hangtag_stock_moves'] LOOP
        EXECUTE format('DROP TRIGGER IF EXISTS hangtag_member_write_check ON public.%I', t);
        EXECUTE format('CREATE TRIGGER hangtag_member_write_check BEFORE INSERT OR UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.hangtag_member_write_check()', t);
    END LOOP;
END $$;

-- (g) Ending a member's sign-ins (the team Edge Function, service role only): on reset, revoke and switch-off every
-- session and refresh token of the member goes, so no phone gets a new token. -> true when done; false when the database
-- doesn't allow it (the member's devices are revoked anyway, so an old token reaches nothing, and adding a phone needs a
-- password sign-in made after the reset). Never for an owner.
CREATE OR REPLACE FUNCTION public.hangtag_end_sessions(p_user UUID)
RETURNS BOOLEAN LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
    IF p_user IS NULL OR NOT EXISTS (SELECT 1 FROM public.hangtag_members m WHERE m.user_id = p_user) THEN RETURN FALSE; END IF;
    DELETE FROM auth.sessions WHERE user_id = p_user;
    RETURN TRUE;
EXCEPTION WHEN undefined_table OR undefined_column OR insufficient_privilege THEN
    RETURN FALSE;
END $$;

-- (h) What changed in the shop, cheaply: a member's phone gets no live updates, so every 30 s it asks for one small
-- fingerprint per part of the shop and downloads only the parts whose fingerprint changed (and only the bills made since
-- its last look). Runs with the caller's rights: row security decides what each part counts.
CREATE OR REPLACE FUNCTION public.hangtag_shop_changes()
RETURNS JSONB LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
    SELECT jsonb_build_object(
        'catalog', (SELECT count(*) || ':' || COALESCE(sum(hashtext(p.id || '|' || COALESCE(p.updated_at::text, ''))), 0) FROM public.hangtag_products p)
                || '/' || (SELECT count(*) || ':' || COALESCE(sum(hashtext(v.id || '|' || COALESCE(v.updated_at::text, ''))), 0) FROM public.hangtag_variants v),
        'images', (SELECT count(*) || ':' || COALESCE(sum(hashtext(i.product_id || '|' || COALESCE(i.updated_at::text, ''))), 0) FROM public.hangtag_images i),
        'moves', (SELECT count(*) || ':' || COALESCE(sum(hashtext(m.id || '|' || COALESCE(m.variant_id, '') || '|' || COALESCE(m.product_id, '') || '|' || m.qty::text)), 0) FROM public.hangtag_stock_moves m),
        'returns', (SELECT count(*) || ':' || COALESCE(sum(hashtext(r.id)), 0) FROM public.hangtag_returns r),
        'customers', (SELECT count(*) || ':' || COALESCE(sum(hashtext(c.id || '|' || COALESCE(c.updated_at::text, ''))), 0) FROM public.hangtag_customers c),
        'events', (SELECT count(*) || ':' || COALESCE(sum(hashtext(e.id || '|' || e.status || '|' || COALESCE(e.updated_at::text, ''))), 0) FROM public.hangtag_events e),
        'cash', (SELECT count(*) || ':' || COALESCE(sum(hashtext(c.id)), 0) FROM public.hangtag_cash_moves c)
                || '/' || (SELECT count(*) || ':' || COALESCE(sum(hashtext(d.id || '|' || d.counted::text || '|' || d.t::text)), 0) FROM public.hangtag_day_closes d),
        'settings', (SELECT count(*) || ':' || COALESCE(sum(hashtext(x.key || '|' || COALESCE(x.updated_at::text, ''))), 0) FROM public.hangtag_meta x),
        -- bills: how many, when the newest was saved (the database's time: the phone fetches those saved since), which are cancelled
        'sales', b.n || '|' || COALESCE(b.since::text, '') || '|' || b.voids,
        'sales_count', b.n, 'sales_since', b.since, 'sales_voids', b.voids)
    FROM (SELECT count(*) AS n, max(s.created_at) AS since,
                 COALESCE(sum(hashtext(s.id || '|' || COALESCE(s.void_reason, ''))) FILTER (WHERE s.is_void), 0)::text AS voids
          FROM public.hangtag_sales s) b
$$;

REVOKE ALL ON FUNCTION public.hangtag_shop_id(), public.hangtag_role(), public.hangtag_can(TEXT), public.hangtag_default_permissions(TEXT),
    public.hangtag_touch_device(), public.hangtag_shop_changes() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.hangtag_shop_id(), public.hangtag_role(), public.hangtag_can(TEXT), public.hangtag_default_permissions(TEXT),
    public.hangtag_touch_device(), public.hangtag_shop_changes() TO authenticated;
REVOKE ALL ON FUNCTION public.hangtag_request_device(), public.hangtag_audit(), public.hangtag_member_check(), public.hangtag_device_check(),
    public.hangtag_member_write_check(), public.hangtag_end_sessions(UUID) FROM PUBLIC, anon, authenticated;
-- the team Edge Function (service role) ends sign-ins; nobody else may
DO $$ BEGIN
    GRANT EXECUTE ON FUNCTION public.hangtag_end_sessions(UUID) TO service_role;
EXCEPTION WHEN undefined_object THEN NULL;   -- a database without Supabase's roles (tests)
END $$;

-- ------------------------------------------------------------------------------
-- 3j. Business profile and capabilities (F2)
-- ------------------------------------------------------------------------------
-- The type of business is the shop profile's business_type: 'retail', 'grocery', 'restaurant' (Hotel / Restaurant),
-- 'electronics' or 'other' (domain/shop/capabilities.js). Profiles saved before these keys keep their value: Clothing
-- boutique, Pop-up or exhibition stall, Retail store, Online seller and Wholesale count as retail, Other as other, none as
-- retail — nothing is rewritten, and an older app version can still save its own values.
-- Capabilities ("does this shop use variants, serial numbers, tables …") are part of the shop's synced settings
-- (hangtag_meta 'settings': value.caps = { "uses_x": true|false } where the shop differs from its type's defaults,
-- value.capsAt = when they last changed, ms). They only decide what the app shows: what a person may do stays its role's
-- permissions (section 3i), and no capability is checked here.

-- a value no app version wrote (only possible through the API) becomes the nearest type, so the rule below holds
UPDATE public.hangtag_profiles SET business_type = CASE
        WHEN btrim(business_type) = '' THEN NULL
        WHEN lower(business_type) ~ '(restaurant|hotel|cafe|café|food)' THEN 'restaurant'
        WHEN lower(business_type) ~ '(grocer|kirana|supermarket)' THEN 'grocery'
        WHEN lower(business_type) ~ '(electronic|mobile)' THEN 'electronics'
        WHEN lower(btrim(business_type)) = 'other' THEN 'other'
        ELSE 'retail' END
    WHERE business_type IS NOT NULL AND business_type NOT IN ('retail', 'grocery', 'restaurant', 'electronics', 'other',
        'Clothing boutique', 'Pop-up or exhibition stall', 'Retail store', 'Online seller', 'Wholesale', 'Other');
ALTER TABLE public.hangtag_profiles DROP CONSTRAINT IF EXISTS hangtag_profiles_business_type_check;
ALTER TABLE public.hangtag_profiles ADD CONSTRAINT hangtag_profiles_business_type_check CHECK (business_type IS NULL OR business_type IN
    ('retail', 'grocery', 'restaurant', 'electronics', 'other',
     'Clothing boutique', 'Pop-up or exhibition stall', 'Retail store', 'Online seller', 'Wholesale', 'Other'));

-- How a product's pieces are told apart: 'none' (just a count), 'serial' (each piece's serial / IMEI number) or 'batch'
-- (batch or lot numbers). Chosen in the product form when the shop uses serials or batches; what it does comes with the
-- serial / batch batch (section 3n).
ALTER TABLE public.hangtag_products ADD COLUMN IF NOT EXISTS tracking TEXT NOT NULL DEFAULT 'none';
ALTER TABLE public.hangtag_products DROP CONSTRAINT IF EXISTS hangtag_products_tracking_check;
ALTER TABLE public.hangtag_products ADD CONSTRAINT hangtag_products_tracking_check CHECK (tracking IN ('none', 'serial', 'batch'));

-- The shop's capability choices survive a phone that uploads an older copy of the settings (it was offline when they
-- changed, or runs an app version that doesn't know them): the choices changed last win. Also checks their shape.
-- The app does the same with what it downloads (capabilities.js keepNewerCaps).
CREATE OR REPLACE FUNCTION public.hangtag_settings_keep_caps()
RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = ''
AS $$
DECLARE
    kept_at NUMERIC;
    new_at NUMERIC;
BEGIN
    IF NEW.key IS DISTINCT FROM 'settings' OR NEW.value IS NULL OR jsonb_typeof(NEW.value) <> 'object' THEN
        RETURN NEW;
    END IF;
    IF NEW.value ? 'caps' AND (jsonb_typeof(NEW.value -> 'caps') <> 'object'
        OR EXISTS (SELECT 1 FROM jsonb_each(NEW.value -> 'caps') c WHERE jsonb_typeof(c.value) <> 'boolean')) THEN
        RAISE EXCEPTION 'A capability is either on or off.' USING ERRCODE = '23514';
    END IF;
    IF NEW.value ? 'capsAt' AND jsonb_typeof(NEW.value -> 'capsAt') <> 'number' THEN
        RAISE EXCEPTION 'When the capabilities changed must be a time.' USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'UPDATE' AND OLD.value IS NOT NULL AND jsonb_typeof(OLD.value) = 'object' AND jsonb_typeof(OLD.value -> 'caps') = 'object' THEN
        kept_at := CASE WHEN jsonb_typeof(OLD.value -> 'capsAt') = 'number' THEN (OLD.value ->> 'capsAt')::NUMERIC ELSE 0 END;
        new_at := CASE WHEN jsonb_typeof(NEW.value -> 'capsAt') = 'number' THEN (NEW.value ->> 'capsAt')::NUMERIC ELSE -1 END;
        IF NOT (NEW.value ? 'caps') OR new_at < kept_at THEN
            NEW.value := (NEW.value - 'capsAt') || jsonb_build_object('caps', OLD.value -> 'caps')
                || CASE WHEN OLD.value ? 'capsAt' THEN jsonb_build_object('capsAt', OLD.value -> 'capsAt') ELSE '{}'::JSONB END;
        END IF;
    END IF;
    RETURN NEW;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.hangtag_settings_keep_caps() FROM PUBLIC;
DROP TRIGGER IF EXISTS hangtag_settings_keep_caps ON public.hangtag_meta;
CREATE TRIGGER hangtag_settings_keep_caps BEFORE INSERT OR UPDATE ON public.hangtag_meta
    FOR EACH ROW EXECUTE FUNCTION public.hangtag_settings_keep_caps();

-- ------------------------------------------------------------------------------
-- 3k. Units, decimal quantities, device-scoped numbers, weighing (T1)
--   A product is sold in a unit: pcs, box, pack, dozen, kg, g, l, ml or m. Quantities on bill lines, return lines, stock
--   records and supplier bills keep up to 3 decimals (2.5 kg sold, 0.75 kg back), so a bill's subtotal can have paise.
--   Bill and return lines keep the unit they were sold in (the product's, when the phone didn't send it).
--   Bill numbers are made per device: {prefix}{yymmdd}-{device code}{running number}, so two phones selling offline never
--   make the same one. A number another bill of the shop already has is refused (credit notes likewise), for a new bill or
--   a changed number only: numbers saved before stay as they are, even the same twice. The phone shows the refusal in its
--   sync review.
--   Who made a bill, return, stock record or cash entry: user_id, always the signed-in account (the database sets it).
-- ------------------------------------------------------------------------------
-- Quantities with decimals (and a subtotal with paise: 2.5 kg × ₹43 = ₹107.50). Changed once; a second run finds them done.
DO $$
DECLARE c RECORD;
BEGIN
    FOR c IN SELECT * FROM (VALUES ('hangtag_sale_items', 'quantity', 'NUMERIC(12,3)', 3), ('hangtag_return_items', 'quantity', 'NUMERIC(12,3)', 3),
        ('hangtag_stock_moves', 'qty', 'NUMERIC(12,3)', 3), ('hangtag_stock_imports', 'units', 'NUMERIC(12,3)', 3), ('hangtag_sales', 'subtotal', 'NUMERIC(12,2)', 2)) AS x(t, col, ty, sc)
    LOOP
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = c.t AND column_name = c.col
                         AND data_type = 'numeric' AND numeric_scale = c.sc) THEN
            EXECUTE format('ALTER TABLE public.%I ALTER COLUMN %I TYPE %s', c.t, c.col, c.ty);
        END IF;
    END LOOP;
END $$;
ALTER TABLE public.hangtag_sale_items DROP CONSTRAINT IF EXISTS hangtag_sale_items_quantity_check;
ALTER TABLE public.hangtag_sale_items ADD CONSTRAINT hangtag_sale_items_quantity_check CHECK (quantity > 0) NOT VALID;
-- a line's discounts never take off more than the line (q × price, to the paisa: 0.333 kg × ₹43 = ₹14.32)
ALTER TABLE public.hangtag_sale_items DROP CONSTRAINT IF EXISTS hangtag_sale_items_money_check;
ALTER TABLE public.hangtag_sale_items ADD CONSTRAINT hangtag_sale_items_money_check CHECK (discount_amount >= 0 AND bill_discount_share >= 0
    AND discount_amount + bill_discount_share <= round(quantity * unit_price, 2) AND cgst_amount >= 0 AND sgst_amount >= 0 AND igst_amount >= 0
    AND (gst_rate IS NULL OR gst_rate BETWEEN 0 AND 100)) NOT VALID;

-- The unit a product is sold in (every product saved before is sold by the piece)
ALTER TABLE public.hangtag_products ADD COLUMN IF NOT EXISTS unit TEXT NOT NULL DEFAULT 'pcs';
UPDATE public.hangtag_products SET unit = 'pcs' WHERE unit IS NULL;
ALTER TABLE public.hangtag_products ALTER COLUMN unit SET DEFAULT 'pcs', ALTER COLUMN unit SET NOT NULL;
ALTER TABLE public.hangtag_products DROP CONSTRAINT IF EXISTS hangtag_products_unit_check;
ALTER TABLE public.hangtag_products ADD CONSTRAINT hangtag_products_unit_check CHECK (unit IN ('pcs','box','pack','dozen','kg','g','l','ml','m'));
-- Bill and return lines: the unit as sold (empty on lines saved before: pieces)
ALTER TABLE public.hangtag_sale_items ADD COLUMN IF NOT EXISTS unit TEXT;
ALTER TABLE public.hangtag_return_items ADD COLUMN IF NOT EXISTS unit TEXT;
ALTER TABLE public.hangtag_sale_items DROP CONSTRAINT IF EXISTS hangtag_sale_items_unit_check;
ALTER TABLE public.hangtag_sale_items ADD CONSTRAINT hangtag_sale_items_unit_check CHECK (unit IS NULL OR unit IN ('pcs','box','pack','dozen','kg','g','l','ml','m')) NOT VALID;
ALTER TABLE public.hangtag_return_items DROP CONSTRAINT IF EXISTS hangtag_return_items_unit_check;
ALTER TABLE public.hangtag_return_items ADD CONSTRAINT hangtag_return_items_unit_check CHECK (unit IS NULL OR unit IN ('pcs','box','pack','dozen','kg','g','l','ml','m')) NOT VALID;
-- A new line without its unit gets the one it was sold in: a return line its bill line's, else the product's
CREATE OR REPLACE FUNCTION public.hangtag_line_unit()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
    IF NEW.unit IS NULL AND TG_TABLE_NAME = 'hangtag_return_items' THEN
        SELECT i.unit INTO NEW.unit FROM public.hangtag_sale_items i WHERE i.owner_id = NEW.owner_id AND i.sale_id = NEW.sale_id AND i.line_no = NEW.sale_line_no;
    END IF;
    IF NEW.unit IS NULL THEN
        SELECT p.unit INTO NEW.unit FROM public.hangtag_products p WHERE p.owner_id = NEW.owner_id AND p.id = NEW.product_id;
    END IF;
    NEW.unit := COALESCE(NEW.unit, 'pcs');
    RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS hangtag_line_unit ON public.hangtag_sale_items;
CREATE TRIGGER hangtag_line_unit BEFORE INSERT ON public.hangtag_sale_items FOR EACH ROW EXECUTE FUNCTION public.hangtag_line_unit();
DROP TRIGGER IF EXISTS hangtag_line_unit ON public.hangtag_return_items;
CREATE TRIGGER hangtag_line_unit BEFORE INSERT ON public.hangtag_return_items FOR EACH ROW EXECUTE FUNCTION public.hangtag_line_unit();

-- Never more of a bill line back than was bought, now in any unit (0.75 kg of 2.5 kg)
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

-- Supplier bills (section 3c) with quantities in any unit: 12.5 kg in
CREATE OR REPLACE FUNCTION public.hangtag_import_stock(p_import JSONB, p_products JSONB, p_variants JSONB, p_moves JSONB, p_allow_duplicate BOOLEAN DEFAULT FALSE)
RETURNS JSONB LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE
    uid UUID := public.hangtag_shop_id(); imp TEXT := p_import ->> 'id'; d RECORD; r JSONB;
    n_p INT := 0; n_v INT := 0; n_m INT := 0; n_units NUMERIC := 0; q NUMERIC;
    inv TEXT := lower(btrim(COALESCE(p_import ->> 'invoice_no', '')));
    gst TEXT := lower(btrim(COALESCE(p_import ->> 'supplier_gstin', '')));
    sup TEXT := lower(btrim(COALESCE(p_import ->> 'supplier_name', '')));
BEGIN
    IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Sign in to add stock.' USING ERRCODE = '42501'; END IF;
    IF uid IS NULL OR NOT public.hangtag_can('create_purchase') THEN RAISE EXCEPTION 'Not allowed to add stock from supplier bills.' USING ERRCODE = '42501'; END IF;
    IF COALESCE(imp, '') = '' THEN RAISE EXCEPTION 'The import has no id.' USING ERRCODE = '22023'; END IF;
    IF EXISTS (SELECT 1 FROM public.hangtag_stock_imports WHERE owner_id = uid AND id = imp) THEN
        RETURN jsonb_build_object('status', 'already_imported', 'import_id', imp);
    END IF;
    IF NOT COALESCE(p_allow_duplicate, FALSE) THEN
        SELECT id, created_at, invoice_no, supplier_name INTO d FROM public.hangtag_stock_imports
        WHERE owner_id = uid AND COALESCE(file_hash, '') <> '' AND file_hash = p_import ->> 'file_hash' ORDER BY created_at LIMIT 1;
        IF FOUND THEN
            RAISE EXCEPTION 'HANGTAG_DUPLICATE_FILE' USING DETAIL = jsonb_build_object('id', d.id, 'created_at', d.created_at, 'invoice_no', d.invoice_no, 'supplier_name', d.supplier_name)::text;
        END IF;
        IF inv <> '' THEN
            SELECT id, created_at, invoice_no, supplier_name INTO d FROM public.hangtag_stock_imports i
            WHERE i.owner_id = uid AND lower(btrim(COALESCE(i.invoice_no, ''))) = inv
              AND CASE WHEN gst <> '' AND btrim(COALESCE(i.supplier_gstin, '')) <> '' THEN lower(btrim(i.supplier_gstin)) = gst
                       ELSE lower(btrim(COALESCE(i.supplier_name, ''))) = sup END
            ORDER BY created_at LIMIT 1;
            IF FOUND THEN
                RAISE EXCEPTION 'HANGTAG_DUPLICATE_INVOICE' USING DETAIL = jsonb_build_object('id', d.id, 'created_at', d.created_at, 'invoice_no', d.invoice_no, 'supplier_name', d.supplier_name)::text;
            END IF;
        END IF;
    END IF;
    FOR r IN SELECT * FROM jsonb_array_elements(COALESCE(p_products, '[]'::jsonb)) LOOP
        IF r ->> 'mode' = 'update_options' THEN
            UPDATE public.hangtag_products SET options = r -> 'options', updated_at = NOW() WHERE owner_id = uid AND id = r ->> 'id';
            IF NOT FOUND THEN RAISE EXCEPTION 'A product on this bill no longer exists. Check the bill again.' USING ERRCODE = '23503'; END IF;
        ELSE
            INSERT INTO public.hangtag_products (id, name, price, color, sort_order, category, brand, description, cost_price, archived, options, hsn, gst_rate, code_type, unit)
            VALUES (r ->> 'id', r ->> 'name', COALESCE((r ->> 'price')::INTEGER, 0), COALESCE(r ->> 'color', '#8E8A83'), COALESCE((r ->> 'sort_order')::INTEGER, 0),
                    NULLIF(r ->> 'category', ''), NULLIF(r ->> 'brand', ''), NULLIF(r ->> 'description', ''), (r ->> 'cost_price')::INTEGER, FALSE,
                    COALESCE(r -> 'options', '{}'::jsonb), NULLIF(r ->> 'hsn', ''), (r ->> 'gst_rate')::NUMERIC, NULLIF(r ->> 'code_type', ''), COALESCE(NULLIF(r ->> 'unit', ''), 'pcs'));
        END IF;
        n_p := n_p + 1;
    END LOOP;
    FOR r IN SELECT * FROM jsonb_array_elements(COALESCE(p_variants, '[]'::jsonb)) LOOP
        INSERT INTO public.hangtag_variants (id, product_id, option_values, color, size, sku, barcode, price, cost_price, active, sort_order)
        VALUES (r ->> 'id', r ->> 'product_id', COALESCE(r -> 'option_values', '[]'::jsonb), COALESCE(r ->> 'color', ''), COALESCE(r ->> 'size', ''),
                NULLIF(r ->> 'sku', ''), NULLIF(r ->> 'barcode', ''), (r ->> 'price')::INTEGER, (r ->> 'cost_price')::INTEGER,
                COALESCE((r ->> 'active')::BOOLEAN, TRUE), COALESCE((r ->> 'sort_order')::INTEGER, 0));
        n_v := n_v + 1;
    END LOOP;
    FOR r IN SELECT * FROM jsonb_array_elements(COALESCE(p_moves, '[]'::jsonb)) LOOP
        q := round(COALESCE((r ->> 'qty')::NUMERIC, 0), 3);
        IF q <= 0 THEN RAISE EXCEPTION 'Every line needs a quantity above 0.' USING ERRCODE = '23514'; END IF;
        INSERT INTO public.hangtag_stock_moves (id, variant_id, product_id, type, qty, cost_price, note, t, device_id, import_id)
        VALUES (r ->> 'id', r ->> 'variant_id', r ->> 'product_id', 'RESTOCK', q, (r ->> 'cost_price')::INTEGER,
                LEFT(r ->> 'note', 200), COALESCE((r ->> 't')::BIGINT, (extract(epoch FROM now()) * 1000)::BIGINT), r ->> 'device_id', imp);
        n_m := n_m + 1; n_units := n_units + q;
    END LOOP;
    INSERT INTO public.hangtag_stock_imports (id, file_hash, file_name, file_type, supplier_name, supplier_gstin, invoice_no, invoice_date,
                                              line_count, units, amount, lines, extraction, device_id)
    VALUES (imp, NULLIF(p_import ->> 'file_hash', ''), p_import ->> 'file_name', p_import ->> 'file_type', NULLIF(p_import ->> 'supplier_name', ''),
            NULLIF(p_import ->> 'supplier_gstin', ''), NULLIF(p_import ->> 'invoice_no', ''), NULLIF(p_import ->> 'invoice_date', '')::DATE,
            COALESCE((p_import ->> 'line_count')::INTEGER, 0), n_units, (p_import ->> 'amount')::NUMERIC,
            COALESCE(p_import -> 'lines', '[]'::jsonb), p_import -> 'extraction', p_import ->> 'device_id');
    RETURN jsonb_build_object('status', 'imported', 'import_id', imp, 'products', n_p, 'variants', n_v, 'moves', n_m, 'units', n_units);
END $$;
REVOKE ALL ON FUNCTION public.hangtag_import_stock(JSONB, JSONB, JSONB, JSONB, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.hangtag_import_stock(JSONB, JSONB, JSONB, JSONB, BOOLEAN) TO authenticated;

-- A bill number (or credit note number) is used once in a shop: a new bill, or a bill given another number, can't take one
-- another bill already has. The same bill saved again keeps its number, so an upload sent twice (and two bills that got the
-- same number before this rule) are left alone. Runs with the caller's rights: it looks only at the caller's own shop.
CREATE INDEX IF NOT EXISTS idx_hangtag_sales_bill_no ON public.hangtag_sales (owner_id, bill_no) WHERE bill_no IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_hangtag_returns_credit_no ON public.hangtag_returns (owner_id, credit_no) WHERE credit_no IS NOT NULL;
CREATE OR REPLACE FUNCTION public.hangtag_doc_no_check()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
    no TEXT;
    before TEXT;
    taken BOOLEAN;
BEGIN
    IF TG_TABLE_NAME = 'hangtag_sales' THEN
        no := NEW.bill_no;
        IF COALESCE(btrim(no), '') = '' THEN RETURN NEW; END IF;
        IF TG_OP = 'UPDATE' THEN before := OLD.bill_no;
        ELSE SELECT s.bill_no INTO before FROM public.hangtag_sales s WHERE s.owner_id = NEW.owner_id AND s.id = NEW.id; END IF;
        IF before IS NOT DISTINCT FROM no THEN RETURN NEW; END IF;
        SELECT EXISTS (SELECT 1 FROM public.hangtag_sales s WHERE s.owner_id = NEW.owner_id AND s.bill_no = no AND s.id <> NEW.id) INTO taken;
        IF taken THEN
            RAISE EXCEPTION 'Bill number % is already used by another bill of this shop.', no USING ERRCODE = 'unique_violation';
        END IF;
    ELSE
        no := NEW.credit_no;
        IF COALESCE(btrim(no), '') = '' THEN RETURN NEW; END IF;
        IF TG_OP = 'UPDATE' THEN before := OLD.credit_no;
        ELSE SELECT r.credit_no INTO before FROM public.hangtag_returns r WHERE r.owner_id = NEW.owner_id AND r.id = NEW.id; END IF;
        IF before IS NOT DISTINCT FROM no THEN RETURN NEW; END IF;
        SELECT EXISTS (SELECT 1 FROM public.hangtag_returns r WHERE r.owner_id = NEW.owner_id AND r.credit_no = no AND r.id <> NEW.id) INTO taken;
        IF taken THEN
            RAISE EXCEPTION 'Credit note number % is already used by another return of this shop.', no USING ERRCODE = 'unique_violation';
        END IF;
    END IF;
    RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS hangtag_doc_no_check ON public.hangtag_sales;
CREATE TRIGGER hangtag_doc_no_check BEFORE INSERT OR UPDATE OF bill_no ON public.hangtag_sales FOR EACH ROW EXECUTE FUNCTION public.hangtag_doc_no_check();
DROP TRIGGER IF EXISTS hangtag_doc_no_check ON public.hangtag_returns;
CREATE TRIGGER hangtag_doc_no_check BEFORE INSERT OR UPDATE OF credit_no ON public.hangtag_returns FOR EACH ROW EXECUTE FUNCTION public.hangtag_doc_no_check();

-- Who made it: the signed-in account (the app shows it; what a phone sends is never trusted). Rows saved before: unknown.
ALTER TABLE public.hangtag_sales ADD COLUMN IF NOT EXISTS user_id UUID;
ALTER TABLE public.hangtag_returns ADD COLUMN IF NOT EXISTS user_id UUID;
ALTER TABLE public.hangtag_stock_moves ADD COLUMN IF NOT EXISTS user_id UUID;
ALTER TABLE public.hangtag_cash_moves ADD COLUMN IF NOT EXISTS user_id UUID;
CREATE OR REPLACE FUNCTION public.hangtag_by_user()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
    -- the app's requests (a signed-in account): the account adding the row; a change keeps who made it. The Edge Functions
    -- (service role) and the database's own functions keep what they set.
    IF current_user = 'authenticated' THEN
        IF TG_OP = 'INSERT' THEN NEW.user_id := auth.uid(); ELSE NEW.user_id := OLD.user_id; END IF;
    END IF;
    RETURN NEW;
END $$;
DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['hangtag_sales','hangtag_returns','hangtag_stock_moves','hangtag_cash_moves'] LOOP
        EXECUTE format('ALTER TABLE public.%I ALTER COLUMN user_id SET DEFAULT auth.uid()', t);
        EXECUTE format('DROP TRIGGER IF EXISTS hangtag_by_user ON public.%I', t);
        EXECUTE format('CREATE TRIGGER hangtag_by_user BEFORE INSERT OR UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.hangtag_by_user()', t);
    END LOOP;
END $$;
REVOKE ALL ON FUNCTION public.hangtag_line_unit(), public.hangtag_doc_no_check(), public.hangtag_by_user() FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------------------------
-- 3l. Suppliers, purchases, bulk import, stock count (T2)
-- ------------------------------------------------------------------------------
-- Suppliers (who the shop buys from), purchases from them (a supplier's invoice: its lines add stock through RESTOCK
-- records; cash paid out of the drawer goes to the cash book), later payments to a supplier, a low-stock level per product
-- (bulk product import sets it; the stock page uses it) and stock counts (ADJUST records, audited like every adjustment).
-- Stock is never stored as a number: a purchase adds stock-in records that point at it (import_id) and carry the cost;
-- cancelling it adds the opposite adjustments. What a supplier is owed is worked out from the purchases and payments.

-- (a) Suppliers. Never deleted (switched off with active = false), so their purchases and payments keep them.
CREATE TABLE IF NOT EXISTS public.hangtag_suppliers (
    owner_id UUID NOT NULL DEFAULT public.hangtag_shop_id() REFERENCES auth.users(id) ON DELETE CASCADE,
    id TEXT NOT NULL CHECK (char_length(id) BETWEEN 1 AND 64),
    name TEXT NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
    phone TEXT CHECK (phone IS NULL OR char_length(phone) <= 20),
    email TEXT CHECK (email IS NULL OR char_length(email) <= 120),
    address TEXT CHECK (address IS NULL OR char_length(address) <= 300),
    gstin TEXT CHECK (gstin IS NULL OR gstin ~ '^[0-9]{2}[A-Z0-9]{10}[0-9A-Z]{3}$'),
    notes TEXT CHECK (notes IS NULL OR char_length(notes) <= 500),
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (owner_id, id)
);
CREATE INDEX IF NOT EXISTS idx_hangtag_suppliers_name ON public.hangtag_suppliers (owner_id, lower(name));

-- (b) Purchases are rows of hangtag_stock_imports with kind 'purchase' (supplier bills read from a file stay kind 'import').
--     Money in rupees: total = subtotal + GST; paid at the time of purchase (0 … total) with its method; later payments
--     are hangtag_supplier_payments. A purchase is history: it is never changed or removed, only cancelled (status
--     'cancelled', through hangtag_cancel_purchase, which also takes its stock back). user_id: who recorded it.
ALTER TABLE public.hangtag_stock_imports ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'import';
ALTER TABLE public.hangtag_stock_imports ADD COLUMN IF NOT EXISTS supplier_id TEXT;
ALTER TABLE public.hangtag_stock_imports ADD COLUMN IF NOT EXISTS t BIGINT;
ALTER TABLE public.hangtag_stock_imports ADD COLUMN IF NOT EXISTS subtotal NUMERIC(12,2);
ALTER TABLE public.hangtag_stock_imports ADD COLUMN IF NOT EXISTS tax_amount NUMERIC(12,2);
ALTER TABLE public.hangtag_stock_imports ADD COLUMN IF NOT EXISTS total_amount NUMERIC(12,2);
ALTER TABLE public.hangtag_stock_imports ADD COLUMN IF NOT EXISTS paid_amount NUMERIC(12,2) NOT NULL DEFAULT 0;
ALTER TABLE public.hangtag_stock_imports ADD COLUMN IF NOT EXISTS payment_method TEXT;
ALTER TABLE public.hangtag_stock_imports ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'posted';
ALTER TABLE public.hangtag_stock_imports ADD COLUMN IF NOT EXISTS note TEXT;
ALTER TABLE public.hangtag_stock_imports ADD COLUMN IF NOT EXISTS user_id UUID DEFAULT auth.uid();
ALTER TABLE public.hangtag_stock_imports ADD COLUMN IF NOT EXISTS cancel_reason TEXT;
ALTER TABLE public.hangtag_stock_imports ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
-- supplier bills saved before: their time is when they were saved; new ones get it by themselves
UPDATE public.hangtag_stock_imports SET t = (extract(epoch FROM created_at) * 1000)::BIGINT WHERE t IS NULL AND created_at IS NOT NULL;
ALTER TABLE public.hangtag_stock_imports ALTER COLUMN t SET DEFAULT (extract(epoch FROM now()) * 1000)::BIGINT;
ALTER TABLE public.hangtag_stock_imports DROP CONSTRAINT IF EXISTS hangtag_stock_imports_kind_check;
ALTER TABLE public.hangtag_stock_imports ADD CONSTRAINT hangtag_stock_imports_kind_check CHECK (kind IN ('import','purchase'));
ALTER TABLE public.hangtag_stock_imports DROP CONSTRAINT IF EXISTS hangtag_stock_imports_status_check;
ALTER TABLE public.hangtag_stock_imports ADD CONSTRAINT hangtag_stock_imports_status_check CHECK (status IN ('posted','cancelled')
    AND (status = 'posted' OR (kind = 'purchase' AND char_length(btrim(COALESCE(cancel_reason, ''))) BETWEEN 3 AND 200 AND cancelled_at IS NOT NULL)));
ALTER TABLE public.hangtag_stock_imports DROP CONSTRAINT IF EXISTS hangtag_stock_imports_note_check;
ALTER TABLE public.hangtag_stock_imports ADD CONSTRAINT hangtag_stock_imports_note_check CHECK (note IS NULL OR char_length(note) <= 200);
ALTER TABLE public.hangtag_stock_imports DROP CONSTRAINT IF EXISTS hangtag_stock_imports_method_check;
ALTER TABLE public.hangtag_stock_imports ADD CONSTRAINT hangtag_stock_imports_method_check CHECK (payment_method IS NULL OR payment_method IN ('cash','upi','card','bank','cheque'));
-- a purchase's money adds up; a method goes with money paid (and only then); cash out of the drawer is at most one cash entry
ALTER TABLE public.hangtag_stock_imports DROP CONSTRAINT IF EXISTS hangtag_stock_imports_money_check;
ALTER TABLE public.hangtag_stock_imports ADD CONSTRAINT hangtag_stock_imports_money_check CHECK (kind <> 'purchase' OR (
    t IS NOT NULL AND char_length(id) <= 58 AND subtotal >= 0 AND tax_amount >= 0 AND total_amount = subtotal + tax_amount
    AND paid_amount >= 0 AND paid_amount <= total_amount AND (paid_amount = 0) = (payment_method IS NULL)
    AND (payment_method IS DISTINCT FROM 'cash' OR paid_amount <= 1000000)));
ALTER TABLE public.hangtag_stock_imports DROP CONSTRAINT IF EXISTS hangtag_stock_imports_supplier_fkey;
ALTER TABLE public.hangtag_stock_imports ADD CONSTRAINT hangtag_stock_imports_supplier_fkey FOREIGN KEY (owner_id, supplier_id) REFERENCES public.hangtag_suppliers (owner_id, id);
CREATE INDEX IF NOT EXISTS idx_hangtag_imports_supplier ON public.hangtag_stock_imports (owner_id, supplier_id) WHERE supplier_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_hangtag_imports_time ON public.hangtag_stock_imports (owner_id, t);

-- Purchases are history. Nobody changes a saved one (a re-upload of the same row changes nothing); it is cancelled only
-- through hangtag_cancel_purchase (which takes its stock back), and a cancelled one stays cancelled. It is removed only
-- with its shop's account. The database, not the phone, says who recorded it. SECURITY DEFINER: it reads whether the
-- shop's account still exists (auth.users); it changes nothing itself.
CREATE OR REPLACE FUNCTION public.hangtag_purchase_check()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD.kind = 'purchase' AND EXISTS (SELECT 1 FROM auth.users u WHERE u.id = OLD.owner_id) THEN
            RAISE EXCEPTION 'A purchase can''t be removed. Cancel it instead.' USING ERRCODE = '42501';
        END IF;
        RETURN OLD;
    END IF;
    IF TG_OP = 'INSERT' THEN
        IF NEW.kind = 'purchase' THEN
            IF auth.uid() IS NOT NULL THEN NEW.user_id := auth.uid(); END IF;
            IF NEW.status <> 'posted' THEN RAISE EXCEPTION 'A new purchase is saved as posted.' USING ERRCODE = 'check_violation'; END IF;
        END IF;
        RETURN NEW;
    END IF;
    IF OLD.kind = 'purchase' OR NEW.kind = 'purchase' THEN
        IF (to_jsonb(NEW) - 'status' - 'cancel_reason' - 'cancelled_at') IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'cancel_reason' - 'cancelled_at') THEN
            RAISE EXCEPTION 'A saved purchase can''t be changed. Cancel it and enter it again.' USING ERRCODE = '42501';
        END IF;
        IF (NEW.status, NEW.cancel_reason, NEW.cancelled_at) IS DISTINCT FROM (OLD.status, OLD.cancel_reason, OLD.cancelled_at)
           AND (OLD.status <> 'posted' OR COALESCE(current_setting('hangtag.cancel_purchase', true), '') <> OLD.id) THEN
            RAISE EXCEPTION 'A purchase is cancelled only with Cancel purchase (it takes its stock back), and only once.' USING ERRCODE = '42501';
        END IF;
    END IF;
    RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS hangtag_purchase_check ON public.hangtag_stock_imports;
CREATE TRIGGER hangtag_purchase_check BEFORE INSERT OR UPDATE OR DELETE ON public.hangtag_stock_imports FOR EACH ROW EXECUTE FUNCTION public.hangtag_purchase_check();

-- (c) Payments to a supplier after the purchase (the part paid at the time is on the purchase). Never changed or deleted:
--     a mistake gets one reversal for the whole payment, with a reason. purchase_id: the invoice it was for (optional).
CREATE TABLE IF NOT EXISTS public.hangtag_supplier_payments (
    owner_id UUID NOT NULL DEFAULT public.hangtag_shop_id() REFERENCES auth.users(id) ON DELETE CASCADE,
    id TEXT NOT NULL CHECK (char_length(id) BETWEEN 1 AND 58),
    supplier_id TEXT NOT NULL,
    purchase_id TEXT,
    amount NUMERIC(12,2) NOT NULL CHECK (amount > 0 AND amount <= 100000000),
    method TEXT NOT NULL CHECK (method IN ('cash','upi','card','bank','cheque')),
    reference TEXT CHECK (reference IS NULL OR char_length(reference) <= 60),
    note TEXT CHECK (note IS NULL OR char_length(note) <= 200),
    reverses TEXT,
    t BIGINT NOT NULL,
    device_id TEXT,
    user_id UUID DEFAULT auth.uid(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (owner_id, id),
    CONSTRAINT hangtag_supplier_payments_cash_check CHECK (method <> 'cash' OR amount <= 1000000),
    CONSTRAINT hangtag_supplier_payments_supplier_fkey FOREIGN KEY (owner_id, supplier_id) REFERENCES public.hangtag_suppliers (owner_id, id),
    CONSTRAINT hangtag_supplier_payments_purchase_fkey FOREIGN KEY (owner_id, purchase_id) REFERENCES public.hangtag_stock_imports (owner_id, id),
    CONSTRAINT hangtag_supplier_payments_reverses_fkey FOREIGN KEY (owner_id, reverses) REFERENCES public.hangtag_supplier_payments (owner_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS hangtag_supplier_payments_reversed_once ON public.hangtag_supplier_payments (owner_id, reverses) WHERE reverses IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_hangtag_supplier_payments_supplier ON public.hangtag_supplier_payments (owner_id, supplier_id, t);
-- a reversal is for the whole of a payment to the same supplier (same method and invoice), never of another reversal, with a reason;
-- a payment for an invoice names a purchase from that supplier; the database says who recorded it
CREATE OR REPLACE FUNCTION public.hangtag_supplier_payment_check()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE o RECORD;
BEGIN
    IF auth.uid() IS NOT NULL THEN NEW.user_id := auth.uid(); END IF;
    IF NEW.reverses IS NOT NULL THEN
        SELECT supplier_id, purchase_id, amount, method, reverses INTO o FROM public.hangtag_supplier_payments WHERE owner_id = NEW.owner_id AND id = NEW.reverses;
        IF NOT FOUND THEN RAISE EXCEPTION 'Supplier payment % was not found', NEW.reverses USING ERRCODE = 'foreign_key_violation'; END IF;
        IF o.reverses IS NOT NULL OR o.amount <> NEW.amount OR o.supplier_id <> NEW.supplier_id OR o.method <> NEW.method OR o.purchase_id IS DISTINCT FROM NEW.purchase_id THEN
            RAISE EXCEPTION 'A reversal must be for the whole of a payment to the same supplier, and not of another reversal' USING ERRCODE = 'check_violation';
        END IF;
        IF char_length(btrim(COALESCE(NEW.note, ''))) < 3 THEN RAISE EXCEPTION 'Say why the payment is reversed.' USING ERRCODE = 'check_violation'; END IF;
    END IF;
    IF NEW.purchase_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.hangtag_stock_imports p
        WHERE p.owner_id = NEW.owner_id AND p.id = NEW.purchase_id AND p.kind = 'purchase' AND p.supplier_id = NEW.supplier_id) THEN
        RAISE EXCEPTION 'That purchase is not one from this supplier.' USING ERRCODE = 'check_violation';
    END IF;
    -- a payment for an invoice: never for a cancelled one, never more than is still owed on it
    IF NEW.purchase_id IS NOT NULL AND NEW.reverses IS NULL THEN
        SELECT p.status, p.total_amount - p.paid_amount - COALESCE((SELECT sum(CASE WHEN x.reverses IS NULL THEN x.amount ELSE -x.amount END)
                 FROM public.hangtag_supplier_payments x WHERE x.owner_id = p.owner_id AND x.purchase_id = p.id), 0) AS due
          INTO o FROM public.hangtag_stock_imports p WHERE p.owner_id = NEW.owner_id AND p.id = NEW.purchase_id;
        IF o.status <> 'posted' THEN RAISE EXCEPTION 'That purchase is cancelled: nothing is owed on it.' USING ERRCODE = 'check_violation'; END IF;
        IF NEW.amount > o.due THEN RAISE EXCEPTION 'That is more than is still owed on this purchase (₹%).', o.due USING ERRCODE = 'check_violation'; END IF;
    END IF;
    RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS hangtag_supplier_payment_check ON public.hangtag_supplier_payments;
CREATE TRIGGER hangtag_supplier_payment_check BEFORE INSERT ON public.hangtag_supplier_payments FOR EACH ROW EXECUTE FUNCTION public.hangtag_supplier_payment_check();

-- (d) Cash paid to a supplier leaves the drawer: the database adds the cash book's "Cash out" entry itself (ids
--     'pur:<purchase>' and 'spay:<payment>'; the phone shows the same entry at once, under the same id), and its reversal
--     when the purchase is cancelled ('purx:<purchase>') or the payment reversed. SECURITY DEFINER: a role may buy stock
--     without recording other cash; the owner comes from the row that row security already checked.
CREATE OR REPLACE FUNCTION public.hangtag_post_purchase_cash()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
    IF NEW.kind <> 'purchase' OR NEW.payment_method IS DISTINCT FROM 'cash' OR NEW.paid_amount <= 0 THEN RETURN NULL; END IF;
    IF TG_OP = 'INSERT' THEN
        INSERT INTO public.hangtag_cash_moves (owner_id, id, type, amount, reason, t, device_id)
        VALUES (NEW.owner_id, 'pur:' || NEW.id, 'out', NEW.paid_amount,
                left('Paid supplier ' || COALESCE(NULLIF(btrim(NEW.supplier_name), ''), 'for stock') || COALESCE(' · ' || NULLIF(btrim(NEW.invoice_no), ''), ''), 200),
                NEW.t, NEW.device_id)
        ON CONFLICT DO NOTHING;
    ELSIF OLD.status = 'posted' AND NEW.status = 'cancelled' THEN
        INSERT INTO public.hangtag_cash_moves (owner_id, id, type, amount, reason, reverses, t, device_id)
        SELECT c.owner_id, 'purx:' || NEW.id, 'reversal', c.amount, left('Purchase cancelled: ' || btrim(NEW.cancel_reason), 200), c.id,
               (extract(epoch FROM NEW.cancelled_at) * 1000)::BIGINT, NEW.device_id
        FROM public.hangtag_cash_moves c
        WHERE c.owner_id = NEW.owner_id AND c.id = 'pur:' || NEW.id AND NOT EXISTS (SELECT 1 FROM public.hangtag_cash_moves r WHERE r.owner_id = c.owner_id AND r.reverses = c.id)
        ON CONFLICT DO NOTHING;
    END IF;
    RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS hangtag_post_purchase_cash ON public.hangtag_stock_imports;
CREATE TRIGGER hangtag_post_purchase_cash AFTER INSERT OR UPDATE OF status ON public.hangtag_stock_imports FOR EACH ROW EXECUTE FUNCTION public.hangtag_post_purchase_cash();
CREATE OR REPLACE FUNCTION public.hangtag_post_supplier_payment_cash()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s TEXT;
BEGIN
    IF NEW.method <> 'cash' THEN RETURN NULL; END IF;
    SELECT name INTO s FROM public.hangtag_suppliers WHERE owner_id = NEW.owner_id AND id = NEW.supplier_id;
    IF NEW.reverses IS NULL THEN
        INSERT INTO public.hangtag_cash_moves (owner_id, id, type, amount, reason, t, device_id)
        VALUES (NEW.owner_id, 'spay:' || NEW.id, 'out', NEW.amount, left('Paid supplier ' || COALESCE(NULLIF(btrim(s), ''), NEW.supplier_id), 200), NEW.t, NEW.device_id)
        ON CONFLICT DO NOTHING;
    ELSE
        INSERT INTO public.hangtag_cash_moves (owner_id, id, type, amount, reason, reverses, t, device_id)
        SELECT c.owner_id, 'spay:' || NEW.id, 'reversal', c.amount, left('Supplier payment reversed: ' || btrim(NEW.note), 200), c.id, NEW.t, NEW.device_id
        FROM public.hangtag_cash_moves c
        WHERE c.owner_id = NEW.owner_id AND c.id = 'spay:' || NEW.reverses AND NOT EXISTS (SELECT 1 FROM public.hangtag_cash_moves r WHERE r.owner_id = c.owner_id AND r.reverses = c.id)
        ON CONFLICT DO NOTHING;
    END IF;
    RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS hangtag_post_supplier_payment_cash ON public.hangtag_supplier_payments;
CREATE TRIGGER hangtag_post_supplier_payment_cash AFTER INSERT ON public.hangtag_supplier_payments FOR EACH ROW EXECUTE FUNCTION public.hangtag_post_supplier_payment_cash();

-- (e) Saves a purchase in one step: the purchase row and its stock-in records (RESTOCK, import_id = the purchase, cost per
--     piece) are all saved, or none are; the cash entry follows by itself. Runs with the caller's rights (row security
--     applies); the shop is public.hangtag_shop_id() and the caller needs create_purchase. The same purchase id again is a
--     safe retry (nothing changes). p_purchase: { id, supplier_id, supplier_name, supplier_gstin, invoice_no, invoice_date,
--     t, lines [{ p, v, n, vl, sku, q, cost, gst, tx, tax, total, serials?, batch? }], subtotal, tax_amount, total_amount,
--     paid_amount, payment_method, note, device_id }; p_moves: [{ id, variant_id, product_id, qty, cost_price, note, t,
--     device_id }]. p_tracking: serial numbers and batches of the lines (a later batch); not used yet.
CREATE OR REPLACE FUNCTION public.hangtag_save_purchase(p_purchase JSONB, p_moves JSONB, p_tracking JSONB DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE
    uid UUID := public.hangtag_shop_id(); pid TEXT := btrim(COALESCE(p_purchase ->> 'id', ''));
    lines JSONB := COALESCE(p_purchase -> 'lines', '[]'::jsonb); sid TEXT := NULLIF(btrim(COALESCE(p_purchase ->> 'supplier_id', '')), '');
    sub NUMERIC := round(COALESCE((p_purchase ->> 'subtotal')::NUMERIC, 0), 2); tax NUMERIC := round(COALESCE((p_purchase ->> 'tax_amount')::NUMERIC, 0), 2);
    l_sub NUMERIC; l_tax NUMERIC; l_q NUMERIC; n_m INT; m_q NUMERIC; bad BOOLEAN; s_name TEXT; s_gstin TEXT;
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
    IF sid IS NOT NULL THEN SELECT name, gstin INTO s_name, s_gstin FROM public.hangtag_suppliers WHERE owner_id = uid AND id = sid; END IF;
    INSERT INTO public.hangtag_stock_imports (id, kind, supplier_id, supplier_name, supplier_gstin, invoice_no, invoice_date, t, line_count, units, amount,
                                              subtotal, tax_amount, total_amount, paid_amount, payment_method, status, note, lines, device_id)
    VALUES (pid, 'purchase', sid, COALESCE(NULLIF(btrim(p_purchase ->> 'supplier_name'), ''), s_name), COALESCE(NULLIF(btrim(p_purchase ->> 'supplier_gstin'), ''), s_gstin),
            NULLIF(btrim(COALESCE(p_purchase ->> 'invoice_no', '')), ''), NULLIF(p_purchase ->> 'invoice_date', '')::DATE,
            COALESCE((p_purchase ->> 't')::BIGINT, (extract(epoch FROM now()) * 1000)::BIGINT), jsonb_array_length(lines), m_q,
            round(COALESCE((p_purchase ->> 'total_amount')::NUMERIC, 0), 2), sub, tax, round(COALESCE((p_purchase ->> 'total_amount')::NUMERIC, 0), 2),
            round(COALESCE((p_purchase ->> 'paid_amount')::NUMERIC, 0), 2), NULLIF(p_purchase ->> 'payment_method', ''), 'posted',
            NULLIF(left(btrim(COALESCE(p_purchase ->> 'note', '')), 200), ''), lines, p_purchase ->> 'device_id');
    INSERT INTO public.hangtag_stock_moves (id, variant_id, product_id, type, qty, cost_price, note, t, device_id, import_id)
    SELECT x ->> 'id', x ->> 'variant_id', x ->> 'product_id', 'RESTOCK', (x ->> 'qty')::NUMERIC, round((x ->> 'cost_price')::NUMERIC)::INTEGER, left(x ->> 'note', 200),
           COALESCE((x ->> 't')::BIGINT, (p_purchase ->> 't')::BIGINT, (extract(epoch FROM now()) * 1000)::BIGINT), COALESCE(x ->> 'device_id', p_purchase ->> 'device_id'), pid
    FROM jsonb_array_elements(p_moves) x
    ON CONFLICT (owner_id, id) DO NOTHING;   -- a stock-in record already sent on its own (a full re-upload) stays as it is
    RETURN jsonb_build_object('status', 'saved', 'purchase_id', pid, 'moves', n_m);
END $$;

-- (f) Cancels a purchase in one step: it is marked cancelled with the reason, and each of its stock-in records gets the
--     opposite adjustment (id 'pcx:<record>', import_id = the purchase), so its stock leaves the shelf again; cash paid at the
--     time comes back into the drawer (the trigger above). Needs create_purchase and manage_inventory. Again: nothing changes.
DROP FUNCTION IF EXISTS public.hangtag_cancel_purchase(TEXT, TEXT, TEXT);   -- an early draft without p_t
CREATE OR REPLACE FUNCTION public.hangtag_cancel_purchase(p_id TEXT, p_reason TEXT, p_device TEXT DEFAULT NULL, p_t BIGINT DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE uid UUID := public.hangtag_shop_id(); p RECORD; why TEXT := btrim(COALESCE(p_reason, '')); n INT;
BEGIN
    IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Sign in to cancel purchases.' USING ERRCODE = '42501'; END IF;
    IF uid IS NULL OR NOT public.hangtag_can('create_purchase') OR NOT public.hangtag_can('manage_inventory') THEN
        RAISE EXCEPTION 'Not allowed to cancel purchases.' USING ERRCODE = '42501';
    END IF;
    SELECT id, status INTO p FROM public.hangtag_stock_imports WHERE owner_id = uid AND id = p_id AND kind = 'purchase';
    IF NOT FOUND THEN RAISE EXCEPTION 'That purchase isn''t in the cloud yet.' USING ERRCODE = '23503'; END IF;
    IF p.status = 'cancelled' THEN RETURN jsonb_build_object('status', 'already_cancelled', 'purchase_id', p_id); END IF;
    IF char_length(why) < 3 THEN RAISE EXCEPTION 'Say why the purchase is cancelled (at least 3 characters).' USING ERRCODE = '23514'; END IF;
    PERFORM set_config('hangtag.cancel_purchase', p_id, true);
    UPDATE public.hangtag_stock_imports SET status = 'cancelled', cancel_reason = left(why, 200), cancelled_at = now() WHERE owner_id = uid AND id = p_id;
    PERFORM set_config('hangtag.cancel_purchase', '', true);
    INSERT INTO public.hangtag_stock_moves (id, variant_id, product_id, type, qty, cost_price, note, t, device_id, import_id)
    SELECT 'pcx:' || m.id, m.variant_id, m.product_id, 'ADJUST', -m.qty, NULL, left('Purchase cancelled: ' || why, 200), COALESCE(p_t, (extract(epoch FROM now()) * 1000)::BIGINT), p_device, p_id
    FROM public.hangtag_stock_moves m WHERE m.owner_id = uid AND m.import_id = p_id AND m.type = 'RESTOCK'
    ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN jsonb_build_object('status', 'cancelled', 'purchase_id', p_id, 'moves', n);
END $$;

-- (g) What changed in suppliers, purchases and supplier payments (a team member's phone gets no live updates: it asks this
--     next to hangtag_shop_changes and downloads them only when this changed). Row security decides what is counted.
CREATE OR REPLACE FUNCTION public.hangtag_purchase_changes()
RETURNS TEXT LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
    SELECT (SELECT count(*) || ':' || COALESCE(sum(hashtext(s.id || '|' || s.updated_at::text || '|' || s.active::text)), 0) FROM public.hangtag_suppliers s)
        || '/' || (SELECT count(*) || ':' || COALESCE(sum(hashtext(p.id || '|' || p.status)), 0) FROM public.hangtag_stock_imports p WHERE p.kind = 'purchase')
        || '/' || (SELECT count(*) || ':' || COALESCE(sum(hashtext(x.id)), 0) FROM public.hangtag_supplier_payments x)
$$;

-- (h) Low-stock level of one product (bulk import and the product form set it; empty = the shop's level from settings)
ALTER TABLE public.hangtag_products ADD COLUMN IF NOT EXISTS low_stock INTEGER;
ALTER TABLE public.hangtag_products DROP CONSTRAINT IF EXISTS hangtag_products_low_stock_check;
ALTER TABLE public.hangtag_products ADD CONSTRAINT hangtag_products_low_stock_check CHECK (low_stock IS NULL OR low_stock BETWEEN 0 AND 100000);

-- (i) Audit (section 3i): suppliers added / changed; purchases cancelled (or removed with the account); supplier payments
--     and their reversals. A new purchase is its own record, like a bill. Stock counts are ADJUST records (logged there).
DROP TRIGGER IF EXISTS hangtag_audit ON public.hangtag_suppliers;
CREATE TRIGGER hangtag_audit AFTER INSERT OR DELETE ON public.hangtag_suppliers FOR EACH ROW EXECUTE FUNCTION public.hangtag_audit();
DROP TRIGGER IF EXISTS hangtag_audit_change ON public.hangtag_suppliers;
CREATE TRIGGER hangtag_audit_change AFTER UPDATE ON public.hangtag_suppliers FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION public.hangtag_audit();
DROP TRIGGER IF EXISTS hangtag_audit_change ON public.hangtag_stock_imports;
CREATE TRIGGER hangtag_audit_change AFTER UPDATE ON public.hangtag_stock_imports FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION public.hangtag_audit();
DROP TRIGGER IF EXISTS hangtag_audit_remove ON public.hangtag_stock_imports;
CREATE TRIGGER hangtag_audit_remove AFTER DELETE ON public.hangtag_stock_imports FOR EACH ROW EXECUTE FUNCTION public.hangtag_audit();
DROP TRIGGER IF EXISTS hangtag_audit ON public.hangtag_supplier_payments;
CREATE TRIGGER hangtag_audit AFTER INSERT OR DELETE ON public.hangtag_supplier_payments FOR EACH ROW EXECUTE FUNCTION public.hangtag_audit();

-- (j) Who may use them: row security is in section 5 (read: create_purchase, manage_inventory or view_reports; suppliers
--     are written with create_purchase or manage_inventory, payments with create_purchase). Suppliers are never deleted
--     (switched off instead); supplier payments are only ever added.
REVOKE ALL ON TABLE public.hangtag_suppliers, public.hangtag_supplier_payments FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.hangtag_suppliers TO authenticated;
GRANT SELECT, INSERT ON TABLE public.hangtag_supplier_payments TO authenticated;
REVOKE ALL ON FUNCTION public.hangtag_save_purchase(JSONB, JSONB, JSONB), public.hangtag_cancel_purchase(TEXT, TEXT, TEXT, BIGINT), public.hangtag_purchase_changes() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.hangtag_save_purchase(JSONB, JSONB, JSONB), public.hangtag_cancel_purchase(TEXT, TEXT, TEXT, BIGINT), public.hangtag_purchase_changes() TO authenticated;
REVOKE ALL ON FUNCTION public.hangtag_purchase_check(), public.hangtag_supplier_payment_check(), public.hangtag_post_purchase_cash(),
    public.hangtag_post_supplier_payment_cash() FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------------------------
-- 3m. Customer credit, held carts, orders engine (T3)
-- ------------------------------------------------------------------------------
--   (a) Customer credit ("on account"): a bill may leave part of its total, or all of it, for later, only for a saved
--       customer (hangtag_sales.due_amount). Its payments then come to total − exchange credit − due_amount. What a
--       customer owes = the amounts on account of their bills − returns refunded to their account (refund_method 'due',
--       never more than that bill still has on account) − payments collected later (hangtag_collections). A collection
--       posts one financial transaction (kind 'collection') and one cash or bank book entry, like a payment on a bill.
--       Selling on account and collecting need collect_credit.
--   (b) Held carts: a bill put aside to finish later, on any till of the shop (never touches stock). create_sale.
--   (c) Orders: ONE engine for quotations, sales orders and (later) table orders. Saved only through RPC hangtag_save_order,
--       all or nothing, with optimistic concurrency: the phone sends the version it last saw; a different stored version
--       is refused (40001, "changed on another device") instead of overwriting; each save adds one to the version. Orders
--       never change stock: a bill made from one (hangtag_sales.order_id) does. create_order.
-- ------------------------------------------------------------------------------
-- (a) Customer credit
ALTER TABLE public.hangtag_sales ADD COLUMN IF NOT EXISTS due_amount NUMERIC(12,2) NOT NULL DEFAULT 0;
ALTER TABLE public.hangtag_sales ADD COLUMN IF NOT EXISTS order_id TEXT;
CREATE INDEX IF NOT EXISTS idx_hangtag_sales_order ON public.hangtag_sales (owner_id, order_id) WHERE order_id IS NOT NULL;
ALTER TABLE public.hangtag_sales DROP CONSTRAINT IF EXISTS hangtag_sales_due_check;
ALTER TABLE public.hangtag_sales ADD CONSTRAINT hangtag_sales_due_check CHECK (due_amount >= 0 AND due_amount <= GREATEST(total - credit, 0)
    AND (due_amount = 0 OR customer_id IS NOT NULL)) NOT VALID;
-- a bill with nothing paid now is "credit"
ALTER TABLE public.hangtag_sales DROP CONSTRAINT IF EXISTS hangtag_sales_payment_method_check;
ALTER TABLE public.hangtag_sales ADD CONSTRAINT hangtag_sales_payment_method_check CHECK (payment_method IN ('cash','upi','card','split','credit')) NOT VALID;
-- a return refunded to the customer's account ('due') takes off what they owe: no money moves, so no book entry
ALTER TABLE public.hangtag_returns DROP CONSTRAINT IF EXISTS hangtag_returns_money_check;
ALTER TABLE public.hangtag_returns ADD CONSTRAINT hangtag_returns_money_check CHECK (refund_amount <= value AND round_off BETWEEN -1 AND 1
    AND (credit_no IS NULL OR char_length(credit_no) <= 40) AND (refund_method IS NULL OR refund_method IN ('cash','upi','card','due'))) NOT VALID;

-- A bill's payments never add up to more than is due now (the total less any exchange credit and the part on account)
CREATE OR REPLACE FUNCTION public.hangtag_payments_check()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
    due NUMERIC;
    other NUMERIC;
BEGIN
    SELECT GREATEST(s.total - s.credit - s.due_amount, 0) INTO due FROM public.hangtag_sales s WHERE s.owner_id = NEW.owner_id AND s.id = NEW.sale_id;
    IF due IS NULL THEN
        RAISE EXCEPTION 'Bill % was not found', NEW.sale_id USING ERRCODE = 'foreign_key_violation';
    END IF;
    SELECT COALESCE(SUM(amount), 0) INTO other FROM public.hangtag_payments
     WHERE owner_id = NEW.owner_id AND sale_id = NEW.sale_id AND id <> NEW.id;
    IF other + NEW.amount > due THEN
        RAISE EXCEPTION 'Payments on this bill would come to % but only % is due', other + NEW.amount, due USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$;
-- A bill saved by an older app version (it sends no payments) gets its one payment for what is due now
CREATE OR REPLACE FUNCTION public.hangtag_sale_default_payment()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
    s public.hangtag_sales;
BEGIN
    SELECT * INTO s FROM public.hangtag_sales WHERE owner_id = NEW.owner_id AND id = NEW.id;
    IF FOUND AND s.total - s.credit - s.due_amount > 0 AND s.payment_method IN ('cash','upi','card')
       AND NOT EXISTS (SELECT 1 FROM public.hangtag_payments p WHERE p.owner_id = s.owner_id AND p.sale_id = s.id) THEN
        INSERT INTO public.hangtag_payments (owner_id, id, sale_id, method, amount, tendered, change_given, status, t, device_id)
        VALUES (s.owner_id, s.id || ':' || s.payment_method, s.id, s.payment_method, s.total - s.credit - s.due_amount,
                CASE WHEN s.payment_method = 'cash' THEN s.total - s.credit - s.due_amount END, 0,
                CASE WHEN s.is_void THEN 'cancelled' ELSE 'completed' END, s.timestamp, s.device_id)
        ON CONFLICT DO NOTHING;
    END IF;
    RETURN NULL;
END $$;

-- Saves bills with their lines and payments, all or nothing (as section 3e, now with the part on account and the order a
-- bill was made from). The caller needs create_sale (apply_discount for a discount, collect_credit for an amount on account:
-- hangtag_credit_check below). Each bill's payments must add up to exactly total − credit − due_amount, or nothing is saved.
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
            round_off, gst_mode, place_of_supply, customer_gstin, customer_type, event_id, due_amount, order_id)
        VALUES (s.id, s.timestamp, COALESCE(s.subtotal, 0), COALESCE(s.discount, 0), COALESCE(s.total, 0), s.payment_method, s.device_id,
            COALESCE(s.is_void, FALSE), s.bill_no, s.customer_id, s.customer_name, s.customer_phone, COALESCE(s.tax_rate, 0),
            COALESCE(s.tax_amount, 0), COALESCE(s.tax_inclusive, TRUE), COALESCE(s.kind, 'sale'), s.exchange_id, COALESCE(s.credit, 0),
            COALESCE(s.item_discount, 0), COALESCE(s.bill_discount, 0), s.bill_discount_type, s.bill_discount_value, s.taxable_amount,
            COALESCE(s.cgst_amount, 0), COALESCE(s.sgst_amount, 0), COALESCE(s.igst_amount, 0), COALESCE(s.round_off, 0),
            s.gst_mode, s.place_of_supply, s.customer_gstin, s.customer_type, s.event_id, COALESCE(s.due_amount, 0), s.order_id)
        ON CONFLICT (owner_id, id) DO UPDATE SET timestamp = EXCLUDED.timestamp, subtotal = EXCLUDED.subtotal, discount = EXCLUDED.discount,
            total = EXCLUDED.total, payment_method = EXCLUDED.payment_method, device_id = EXCLUDED.device_id, is_void = EXCLUDED.is_void, void_reason = CASE WHEN EXCLUDED.is_void THEN hangtag_sales.void_reason END,
            bill_no = EXCLUDED.bill_no, customer_id = EXCLUDED.customer_id, customer_name = EXCLUDED.customer_name,
            customer_phone = EXCLUDED.customer_phone, tax_rate = EXCLUDED.tax_rate, tax_amount = EXCLUDED.tax_amount,
            tax_inclusive = EXCLUDED.tax_inclusive, kind = EXCLUDED.kind, exchange_id = EXCLUDED.exchange_id, credit = EXCLUDED.credit,
            item_discount = EXCLUDED.item_discount, bill_discount = EXCLUDED.bill_discount, bill_discount_type = EXCLUDED.bill_discount_type,
            bill_discount_value = EXCLUDED.bill_discount_value, taxable_amount = EXCLUDED.taxable_amount, cgst_amount = EXCLUDED.cgst_amount,
            sgst_amount = EXCLUDED.sgst_amount, igst_amount = EXCLUDED.igst_amount, round_off = EXCLUDED.round_off, gst_mode = EXCLUDED.gst_mode,
            place_of_supply = EXCLUDED.place_of_supply, customer_gstin = EXCLUDED.customer_gstin, customer_type = EXCLUDED.customer_type,
            event_id = EXCLUDED.event_id, due_amount = EXCLUDED.due_amount, order_id = EXCLUDED.order_id;
        INSERT INTO public.hangtag_sale_items (sale_id, line_no, product_id, product_name, size, quantity, unit_price, variant_id, color, sku,
            cost_price, variant_label, options, discount_type, discount_value, discount_amount, bill_discount_share, taxable_value, gst_rate,
            cgst_amount, sgst_amount, igst_amount, line_total, hsn)
        SELECT s.id, i.line_no, i.product_id, i.product_name, COALESCE(i.size, ''), COALESCE(i.quantity, 1), COALESCE(i.unit_price, 0),
            i.variant_id, COALESCE(i.color, ''), i.sku, i.cost_price, i.variant_label, i.options, i.discount_type, i.discount_value,
            COALESCE(i.discount_amount, 0), COALESCE(i.bill_discount_share, 0), i.taxable_value, i.gst_rate, COALESCE(i.cgst_amount, 0),
            COALESCE(i.sgst_amount, 0), COALESCE(i.igst_amount, 0), i.line_total, i.hsn
        FROM jsonb_populate_recordset(NULL::public.hangtag_sale_items, COALESCE(b -> 'items', '[]'::jsonb)) i
        ON CONFLICT (owner_id, sale_id, line_no) DO UPDATE SET product_id = EXCLUDED.product_id, product_name = EXCLUDED.product_name,
            size = EXCLUDED.size, quantity = EXCLUDED.quantity, unit_price = EXCLUDED.unit_price, variant_id = EXCLUDED.variant_id,
            color = EXCLUDED.color, sku = EXCLUDED.sku, cost_price = EXCLUDED.cost_price, variant_label = EXCLUDED.variant_label,
            options = EXCLUDED.options, discount_type = EXCLUDED.discount_type, discount_value = EXCLUDED.discount_value,
            discount_amount = EXCLUDED.discount_amount, bill_discount_share = EXCLUDED.bill_discount_share, taxable_value = EXCLUDED.taxable_value,
            gst_rate = EXCLUDED.gst_rate, cgst_amount = EXCLUDED.cgst_amount, sgst_amount = EXCLUDED.sgst_amount,
            igst_amount = EXCLUDED.igst_amount, line_total = EXCLUDED.line_total, hsn = EXCLUDED.hsn;
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
            -- a payment the provider verified (section 3h) stays verified when the phone uploads the bill again
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

-- A team member puts an amount on a customer's account only with collect_credit (the owner, the database's own functions
-- and the Edge Functions are not limited by this)
CREATE OR REPLACE FUNCTION public.hangtag_credit_check()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
    IF current_user <> 'authenticated' OR NEW.owner_id = auth.uid() THEN RETURN NEW; END IF;
    IF COALESCE(NEW.due_amount, 0) > 0 AND (TG_OP = 'INSERT' OR NEW.due_amount IS DISTINCT FROM OLD.due_amount)
       AND NOT public.hangtag_can('collect_credit') THEN
        RAISE EXCEPTION 'Not allowed to sell on credit.' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS hangtag_credit_check ON public.hangtag_sales;
CREATE TRIGGER hangtag_credit_check BEFORE INSERT OR UPDATE OF due_amount ON public.hangtag_sales
    FOR EACH ROW EXECUTE FUNCTION public.hangtag_credit_check();

-- A refund to the customer's account takes off at most what that bill still has on account (other returns to the account
-- of the same bill count too). Reads the bill whatever the caller's role may read (the row is the caller's own shop's).
CREATE OR REPLACE FUNCTION public.hangtag_due_refund_check()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    owed NUMERIC;
    taken NUMERIC;
BEGIN
    IF COALESCE(NEW.refund_method, '') <> 'due' OR COALESCE(NEW.refund_amount, 0) <= 0 THEN RETURN NEW; END IF;
    SELECT s.due_amount INTO owed FROM public.hangtag_sales s WHERE s.owner_id = NEW.owner_id AND s.id = NEW.sale_id;
    SELECT COALESCE(SUM(r.refund_amount), 0) INTO taken FROM public.hangtag_returns r
     WHERE r.owner_id = NEW.owner_id AND r.sale_id = NEW.sale_id AND r.refund_method = 'due' AND r.id <> NEW.id;
    IF taken + NEW.refund_amount > COALESCE(owed, 0) THEN
        RAISE EXCEPTION 'A refund to the customer''s account can take off at most % (what this bill still has on account)', GREATEST(COALESCE(owed, 0) - taken, 0)
            USING ERRCODE = 'check_violation';
    END IF;
    -- a team member (signed in, not the shop's owner) needs collect_credit; this runs as the database owner, so the caller is
    -- told apart by its sign-in, not by current_user
    IF auth.uid() IS NOT NULL AND NEW.owner_id <> auth.uid() AND NOT public.hangtag_can('collect_credit') THEN
        RAISE EXCEPTION 'Not allowed to change what customers owe.' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS hangtag_due_refund_check ON public.hangtag_returns;
CREATE TRIGGER hangtag_due_refund_check BEFORE INSERT OR UPDATE ON public.hangtag_returns
    FOR EACH ROW EXECUTE FUNCTION public.hangtag_due_refund_check();

-- The account that wrote a row is the signed-in one, whatever the app sends (the device sends it only for display)
CREATE OR REPLACE FUNCTION public.hangtag_stamp_user_id()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
    IF auth.uid() IS NOT NULL THEN NEW.user_id := auth.uid(); END IF;
    RETURN NEW;
END $$;

-- Money a customer pays towards what they owe. Entries are added, never changed (the owner may cancel one: its book entry
-- then leaves the balances).
CREATE TABLE IF NOT EXISTS public.hangtag_collections (
    owner_id UUID NOT NULL DEFAULT public.hangtag_shop_id() REFERENCES auth.users(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    customer_id TEXT NOT NULL,
    amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
    method TEXT NOT NULL CHECK (method IN ('cash','upi','card')),
    reference TEXT CHECK (reference IS NULL OR char_length(reference) <= 40),
    verification TEXT NOT NULL DEFAULT 'recorded' CHECK (verification IN ('recorded','unverified')),
    t BIGINT NOT NULL,
    device_id TEXT,
    user_id UUID DEFAULT auth.uid(),
    note TEXT CHECK (note IS NULL OR char_length(note) <= 200),
    status TEXT NOT NULL DEFAULT 'posted' CHECK (status IN ('posted','cancelled')),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (owner_id, id),
    -- UPI and card need the transaction / card machine reference (never a card number: the app refuses one)
    CONSTRAINT hangtag_collections_ref_check CHECK (method = 'cash' OR reference IS NOT NULL),
    CONSTRAINT hangtag_collections_customer_fkey FOREIGN KEY (owner_id, customer_id) REFERENCES public.hangtag_customers (owner_id, id)
);
CREATE INDEX IF NOT EXISTS idx_hangtag_collections_customer ON public.hangtag_collections (owner_id, customer_id);
DROP TRIGGER IF EXISTS hangtag_stamp_user_id ON public.hangtag_collections;
CREATE TRIGGER hangtag_stamp_user_id BEFORE INSERT ON public.hangtag_collections FOR EACH ROW EXECUTE FUNCTION public.hangtag_stamp_user_id();
-- only the status and note of an entry can change; the amount, method and customer never do
CREATE OR REPLACE FUNCTION public.hangtag_collection_check()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
    IF (NEW.customer_id, NEW.amount, NEW.method, NEW.reference, NEW.t) IS DISTINCT FROM (OLD.customer_id, OLD.amount, OLD.method, OLD.reference, OLD.t) THEN
        RAISE EXCEPTION 'A payment collected can''t be changed; cancel it and record it again.' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS hangtag_collection_check ON public.hangtag_collections;
CREATE TRIGGER hangtag_collection_check BEFORE UPDATE ON public.hangtag_collections FOR EACH ROW EXECUTE FUNCTION public.hangtag_collection_check();

-- Financial transactions and book entries of collections: kind / entry type 'collection', no bill
ALTER TABLE public.hangtag_fin_txns ADD COLUMN IF NOT EXISTS collection_id TEXT;
ALTER TABLE public.hangtag_fin_txns ADD COLUMN IF NOT EXISTS customer_id TEXT;
ALTER TABLE public.hangtag_fin_txns ALTER COLUMN sale_id DROP NOT NULL;
ALTER TABLE public.hangtag_fin_txns DROP CONSTRAINT IF EXISTS hangtag_fin_txns_kind_check;
ALTER TABLE public.hangtag_fin_txns ADD CONSTRAINT hangtag_fin_txns_kind_check CHECK (kind IN ('sale_receipt','refund','collection'));
ALTER TABLE public.hangtag_fin_txns DROP CONSTRAINT IF EXISTS hangtag_fin_txns_source_check;
ALTER TABLE public.hangtag_fin_txns ADD CONSTRAINT hangtag_fin_txns_source_check CHECK (
       (kind = 'sale_receipt' AND direction = 'in' AND payment_id IS NOT NULL AND return_id IS NULL AND collection_id IS NULL AND sale_id IS NOT NULL)
    OR (kind = 'refund' AND direction = 'out' AND return_id IS NOT NULL AND payment_id IS NULL AND collection_id IS NULL AND sale_id IS NOT NULL)
    OR (kind = 'collection' AND direction = 'in' AND collection_id IS NOT NULL AND payment_id IS NULL AND return_id IS NULL AND sale_id IS NULL));
ALTER TABLE public.hangtag_fin_txns DROP CONSTRAINT IF EXISTS hangtag_fin_txns_collection_fkey;
ALTER TABLE public.hangtag_fin_txns ADD CONSTRAINT hangtag_fin_txns_collection_fkey FOREIGN KEY (owner_id, collection_id)
    REFERENCES public.hangtag_collections (owner_id, id) ON DELETE CASCADE;
CREATE UNIQUE INDEX IF NOT EXISTS hangtag_fin_txns_collection_key ON public.hangtag_fin_txns (owner_id, collection_id);
ALTER TABLE public.hangtag_cash_book ALTER COLUMN sale_id DROP NOT NULL;
ALTER TABLE public.hangtag_cash_book DROP CONSTRAINT IF EXISTS hangtag_cash_book_entry_type_check;
ALTER TABLE public.hangtag_cash_book ADD CONSTRAINT hangtag_cash_book_entry_type_check CHECK (entry_type IN ('cash_sale','cash_refund','collection'));
ALTER TABLE public.hangtag_bank_book ALTER COLUMN sale_id DROP NOT NULL;
ALTER TABLE public.hangtag_bank_book DROP CONSTRAINT IF EXISTS hangtag_bank_book_entry_type_check;
ALTER TABLE public.hangtag_bank_book ADD CONSTRAINT hangtag_bank_book_entry_type_check CHECK (entry_type IN ('receipt','refund','collection'));
-- Posting runs as the database owner (the app can't write transactions or book entries); the owner_id comes from the
-- collection row, which row security has already checked. Ids come from the collection id: posting again never duplicates.
CREATE OR REPLACE FUNCTION public.hangtag_post_collection()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    ft TEXT := 'ft:' || NEW.id;
    st TEXT := CASE WHEN NEW.status = 'posted' THEN 'posted' ELSE 'cancelled' END;
BEGIN
    INSERT INTO public.hangtag_fin_txns (owner_id, id, kind, direction, method, amount, sale_id, collection_id, customer_id, reference, status, t)
    VALUES (NEW.owner_id, ft, 'collection', 'in', NEW.method, NEW.amount, NULL, NEW.id, NEW.customer_id, NEW.reference, st, NEW.t)
    ON CONFLICT (owner_id, id) DO UPDATE SET method = EXCLUDED.method, amount = EXCLUDED.amount, reference = EXCLUDED.reference,
        customer_id = EXCLUDED.customer_id, status = EXCLUDED.status, t = EXCLUDED.t;
    IF NEW.method = 'cash' THEN
        DELETE FROM public.hangtag_bank_book WHERE owner_id = NEW.owner_id AND fin_txn_id = ft;
        INSERT INTO public.hangtag_cash_book (owner_id, id, fin_txn_id, sale_id, entry_type, amount_in, cash_received, change_given, status, t)
        VALUES (NEW.owner_id, 'cb:' || ft, ft, NULL, 'collection', NEW.amount, NEW.amount, 0, st, NEW.t)
        ON CONFLICT (owner_id, id) DO UPDATE SET amount_in = EXCLUDED.amount_in, cash_received = EXCLUDED.cash_received, status = EXCLUDED.status, t = EXCLUDED.t;
    ELSE
        DELETE FROM public.hangtag_cash_book WHERE owner_id = NEW.owner_id AND fin_txn_id = ft;
        INSERT INTO public.hangtag_bank_book (owner_id, id, fin_txn_id, sale_id, method, entry_type, reference, amount_in, status, t, verification)
        VALUES (NEW.owner_id, 'bb:' || ft, ft, NULL, NEW.method, 'collection', NEW.reference, NEW.amount, st, NEW.t, NEW.verification)
        ON CONFLICT (owner_id, id) DO UPDATE SET method = EXCLUDED.method, reference = EXCLUDED.reference, amount_in = EXCLUDED.amount_in,
            status = EXCLUDED.status, t = EXCLUDED.t, verification = EXCLUDED.verification;
    END IF;
    RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS hangtag_post_collection ON public.hangtag_collections;
CREATE TRIGGER hangtag_post_collection AFTER INSERT OR UPDATE ON public.hangtag_collections
    FOR EACH ROW EXECUTE FUNCTION public.hangtag_post_collection();

-- (b) Held carts (the cart lines, discount, customer and a note, as the app keeps them)
CREATE TABLE IF NOT EXISTS public.hangtag_held_carts (
    owner_id UUID NOT NULL DEFAULT public.hangtag_shop_id() REFERENCES auth.users(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    name TEXT NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 60),
    data JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(data) = 'object' AND octet_length(data::text) <= 200000),
    device_id TEXT,
    user_id UUID DEFAULT auth.uid(),
    t BIGINT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (owner_id, id)
);
DROP TRIGGER IF EXISTS hangtag_stamp_user_id ON public.hangtag_held_carts;
CREATE TRIGGER hangtag_stamp_user_id BEFORE INSERT ON public.hangtag_held_carts FOR EACH ROW EXECUTE FUNCTION public.hangtag_stamp_user_id();

-- (c) Orders: quotations, sales orders, table orders
CREATE TABLE IF NOT EXISTS public.hangtag_orders (
    owner_id UUID NOT NULL DEFAULT public.hangtag_shop_id() REFERENCES auth.users(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('quote','sales','table')),
    no TEXT CHECK (no IS NULL OR char_length(no) <= 40),
    status TEXT NOT NULL,
    customer_id TEXT,
    customer JSONB,
    bill_disc JSONB,
    notes TEXT CHECK (notes IS NULL OR char_length(notes) <= 500),
    valid_until DATE,
    table_id TEXT,
    session_id TEXT,
    source TEXT NOT NULL DEFAULT 'staff' CHECK (source IN ('staff','customer')),
    converted_to TEXT,
    sale_ids TEXT[] NOT NULL DEFAULT '{}',
    version INT NOT NULL DEFAULT 1 CHECK (version >= 1),
    t BIGINT NOT NULL,
    updated_t BIGINT,
    device_id TEXT,
    user_id UUID DEFAULT auth.uid(),
    save_hash TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (owner_id, id),
    CONSTRAINT hangtag_orders_status_check CHECK ((kind = 'quote' AND status IN ('draft','sent','accepted','expired','cancelled','converted'))
        OR (kind = 'sales' AND status IN ('draft','confirmed','partial','completed','cancelled'))
        OR (kind = 'table' AND status IN ('new','accepted','preparing','ready','served','cancelled')))
);
CREATE INDEX IF NOT EXISTS idx_hangtag_orders_kind ON public.hangtag_orders (owner_id, kind, status);
CREATE TABLE IF NOT EXISTS public.hangtag_order_items (
    owner_id UUID NOT NULL DEFAULT public.hangtag_shop_id() REFERENCES auth.users(id) ON DELETE CASCADE,
    order_id TEXT NOT NULL,
    line_no INTEGER NOT NULL CHECK (line_no >= 0),
    product_id TEXT,
    variant_id TEXT,
    name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
    variant_label TEXT,
    qty NUMERIC(12,3) NOT NULL CHECK (qty > 0),
    price NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (price >= 0),
    disc JSONB,
    gst_rate NUMERIC(5,2) CHECK (gst_rate IS NULL OR gst_rate BETWEEN 0 AND 100),
    note TEXT CHECK (note IS NULL OR char_length(note) <= 200),
    fulfilled_qty NUMERIC(12,3) NOT NULL DEFAULT 0 CHECK (fulfilled_qty >= 0),
    serials TEXT[],
    PRIMARY KEY (owner_id, order_id, line_no),
    CONSTRAINT hangtag_order_items_fulfilled_check CHECK (fulfilled_qty <= qty),
    CONSTRAINT hangtag_order_items_order_fkey FOREIGN KEY (owner_id, order_id) REFERENCES public.hangtag_orders (owner_id, id) ON DELETE CASCADE
);
-- Which status an order may move to (the same lists as src/domain/orders/orders.js ORDER_NEXT). Cancelled, converted,
-- completed and served orders are final.
CREATE OR REPLACE FUNCTION public.hangtag_order_next_ok(p_kind TEXT, p_from TEXT, p_to TEXT)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
    SELECT p_from = p_to OR (p_kind, p_from, p_to) IN (
        ('quote','draft','sent'), ('quote','draft','accepted'), ('quote','draft','cancelled'), ('quote','draft','converted'), ('quote','draft','expired'),
        ('quote','sent','draft'), ('quote','sent','accepted'), ('quote','sent','cancelled'), ('quote','sent','converted'), ('quote','sent','expired'),
        ('quote','accepted','converted'), ('quote','accepted','cancelled'),
        ('quote','expired','draft'), ('quote','expired','sent'), ('quote','expired','cancelled'),
        ('sales','draft','confirmed'), ('sales','draft','partial'), ('sales','draft','completed'), ('sales','draft','cancelled'),
        ('sales','confirmed','partial'), ('sales','confirmed','completed'), ('sales','confirmed','cancelled'),
        ('sales','partial','completed'), ('sales','partial','cancelled'),
        ('table','new','accepted'), ('table','new','preparing'), ('table','new','cancelled'),
        ('table','accepted','preparing'), ('table','accepted','ready'), ('table','accepted','served'), ('table','accepted','cancelled'),
        ('table','preparing','ready'), ('table','preparing','served'), ('table','preparing','cancelled'),
        ('table','ready','served'), ('table','ready','cancelled'))
$$;
-- Saves an order with its lines, all or nothing. p_order: {hangtag_orders columns, version = the version the phone last
-- saw (0 for a new order)} · p_items: [{hangtag_order_items columns}]. The shop is public.hangtag_shop_id() and the caller
-- needs create_order. Another version in the cloud means someone else changed the order meanwhile: refused (40001) rather
-- than overwritten, except the very same save sent again (a retry: its fingerprint matches), which answers "saved". A
-- final order (cancelled, converted, completed, served) doesn't change; the kind never does; a delivered quantity never
-- goes down. -> { status, order, version, lines }
CREATE OR REPLACE FUNCTION public.hangtag_save_order(p_order JSONB, p_items JSONB)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    uid UUID := public.hangtag_shop_id();
    o public.hangtag_orders;
    cur public.hangtag_orders;
    base INT := COALESCE(NULLIF(p_order ->> 'version', '')::INT, 0);
    fp TEXT := md5((COALESCE(p_order, '{}'::jsonb) - 'version' - 'updated_t')::text || '|' || COALESCE(p_items, '[]'::jsonb)::text);
    ver INT;
    n INT;
BEGIN
    IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Sign in to save orders.' USING ERRCODE = '42501'; END IF;
    IF uid IS NULL OR NOT public.hangtag_can('create_order') THEN RAISE EXCEPTION 'Not allowed to save orders.' USING ERRCODE = '42501'; END IF;
    o := jsonb_populate_record(NULL::public.hangtag_orders, p_order);
    IF COALESCE(o.id, '') = '' THEN RAISE EXCEPTION 'An order has no id.' USING ERRCODE = '22023'; END IF;
    IF jsonb_typeof(COALESCE(p_items, '[]'::jsonb)) <> 'array' OR jsonb_array_length(COALESCE(p_items, '[]'::jsonb)) = 0 THEN
        RAISE EXCEPTION 'An order needs at least one line.' USING ERRCODE = 'check_violation';
    END IF;
    SELECT * INTO cur FROM public.hangtag_orders x WHERE x.owner_id = uid AND x.id = o.id FOR UPDATE;
    IF FOUND THEN
        IF cur.version <> base THEN
            -- the same save again (its answer was lost): nothing to do
            IF cur.version = base + 1 AND cur.save_hash = fp THEN
                RETURN jsonb_build_object('status', 'saved', 'order', cur.id, 'version', cur.version,
                    'lines', (SELECT count(*) FROM public.hangtag_order_items i WHERE i.owner_id = uid AND i.order_id = cur.id));
            END IF;
            RAISE EXCEPTION 'Order % was changed on another device (this phone had version %, the cloud has %). Discard this change and open the order again.',
                COALESCE(cur.no, cur.id), base, cur.version USING ERRCODE = '40001';
        END IF;
        IF o.kind IS DISTINCT FROM cur.kind THEN RAISE EXCEPTION 'An order can''t change its kind.' USING ERRCODE = 'check_violation'; END IF;
        IF cur.status IN ('cancelled','converted','completed','served') THEN
            RAISE EXCEPTION 'Order % is % and can''t be changed.', COALESCE(cur.no, cur.id), cur.status USING ERRCODE = 'check_violation';
        END IF;
        IF NOT public.hangtag_order_next_ok(cur.kind, cur.status, o.status) THEN
            RAISE EXCEPTION 'An order that is % can''t become %.', cur.status, o.status USING ERRCODE = 'check_violation';
        END IF;
        IF EXISTS (SELECT 1 FROM public.hangtag_order_items i
             LEFT JOIN jsonb_populate_recordset(NULL::public.hangtag_order_items, p_items) x ON x.line_no = i.line_no
             WHERE i.owner_id = uid AND i.order_id = cur.id AND i.fulfilled_qty > 0 AND COALESCE(x.fulfilled_qty, 0) < i.fulfilled_qty) THEN
            RAISE EXCEPTION 'What was already delivered on order % can''t be taken off it.', COALESCE(cur.no, cur.id) USING ERRCODE = 'check_violation';
        END IF;
        ver := cur.version + 1;
        UPDATE public.hangtag_orders SET no = o.no, status = o.status, customer_id = o.customer_id, customer = o.customer, bill_disc = o.bill_disc,
            notes = o.notes, valid_until = o.valid_until, table_id = o.table_id, session_id = o.session_id, converted_to = o.converted_to,
            sale_ids = COALESCE(o.sale_ids, '{}'), version = ver, updated_t = o.updated_t, device_id = o.device_id, save_hash = fp, updated_at = NOW()
         WHERE owner_id = uid AND id = cur.id;
    ELSE
        IF base <> 0 THEN
            RAISE EXCEPTION 'Order % is no longer in the cloud. Discard this change.', COALESCE(o.no, o.id) USING ERRCODE = '40001';
        END IF;
        ver := 1;
        INSERT INTO public.hangtag_orders (owner_id, id, kind, no, status, customer_id, customer, bill_disc, notes, valid_until, table_id, session_id,
            source, converted_to, sale_ids, version, t, updated_t, device_id, user_id, save_hash)
        VALUES (uid, o.id, o.kind, o.no, o.status, o.customer_id, o.customer, o.bill_disc, o.notes, o.valid_until, o.table_id, o.session_id,
            COALESCE(o.source, 'staff'), o.converted_to, COALESCE(o.sale_ids, '{}'), ver, COALESCE(o.t, (extract(epoch FROM now()) * 1000)::BIGINT),
            o.updated_t, o.device_id, auth.uid(), fp);
    END IF;
    DELETE FROM public.hangtag_order_items i WHERE i.owner_id = uid AND i.order_id = o.id
       AND i.line_no NOT IN (SELECT (y ->> 'line_no')::INT FROM jsonb_array_elements(p_items) y);
    INSERT INTO public.hangtag_order_items (owner_id, order_id, line_no, product_id, variant_id, name, variant_label, qty, price, disc, gst_rate,
        note, fulfilled_qty, serials)
    SELECT uid, o.id, i.line_no, i.product_id, i.variant_id, i.name, i.variant_label, i.qty, COALESCE(i.price, 0), i.disc, i.gst_rate, i.note,
        COALESCE(i.fulfilled_qty, 0), i.serials
    FROM jsonb_populate_recordset(NULL::public.hangtag_order_items, p_items) i
    ON CONFLICT (owner_id, order_id, line_no) DO UPDATE SET product_id = EXCLUDED.product_id, variant_id = EXCLUDED.variant_id, name = EXCLUDED.name,
        variant_label = EXCLUDED.variant_label, qty = EXCLUDED.qty, price = EXCLUDED.price, disc = EXCLUDED.disc, gst_rate = EXCLUDED.gst_rate,
        note = EXCLUDED.note, fulfilled_qty = EXCLUDED.fulfilled_qty, serials = EXCLUDED.serials;
    SELECT count(*) INTO n FROM public.hangtag_order_items i WHERE i.owner_id = uid AND i.order_id = o.id;
    RETURN jsonb_build_object('status', 'saved', 'order', o.id, 'version', ver, 'lines', n);
END $$;
REVOKE ALL ON FUNCTION public.hangtag_save_order(JSONB, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.hangtag_save_order(JSONB, JSONB) TO authenticated;

-- What changed in credit, held carts and orders (a team member's phone polls it with hangtag_shop_changes, section 3i (h))
CREATE OR REPLACE FUNCTION public.hangtag_order_changes()
RETURNS JSONB LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
    SELECT jsonb_build_object(
        'orders', (SELECT count(*) || ':' || COALESCE(sum(hashtext(o.id || '|' || o.version::text)), 0) FROM public.hangtag_orders o),
        'held', (SELECT count(*) || ':' || COALESCE(sum(hashtext(h.id || '|' || h.t::text)), 0) FROM public.hangtag_held_carts h),
        'credit', (SELECT count(*) || ':' || COALESCE(sum(hashtext(c.id || '|' || c.status)), 0) FROM public.hangtag_collections c))
$$;
REVOKE ALL ON FUNCTION public.hangtag_order_changes(), public.hangtag_order_next_ok(TEXT, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.hangtag_order_changes(), public.hangtag_order_next_ok(TEXT, TEXT, TEXT) TO authenticated;
REVOKE ALL ON FUNCTION public.hangtag_credit_check(), public.hangtag_due_refund_check(), public.hangtag_stamp_user_id(), public.hangtag_collection_check(),
    public.hangtag_post_collection() FROM PUBLIC, anon, authenticated;

-- Audit (section 3i (e)): collections added, cancelled or removed; orders added, removed or moved to another status
DROP TRIGGER IF EXISTS hangtag_audit ON public.hangtag_collections;
CREATE TRIGGER hangtag_audit AFTER INSERT OR DELETE ON public.hangtag_collections FOR EACH ROW EXECUTE FUNCTION public.hangtag_audit();
DROP TRIGGER IF EXISTS hangtag_audit_change ON public.hangtag_collections;
CREATE TRIGGER hangtag_audit_change AFTER UPDATE ON public.hangtag_collections FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION public.hangtag_audit();
DROP TRIGGER IF EXISTS hangtag_audit ON public.hangtag_orders;
CREATE TRIGGER hangtag_audit AFTER INSERT OR DELETE ON public.hangtag_orders FOR EACH ROW EXECUTE FUNCTION public.hangtag_audit();
DROP TRIGGER IF EXISTS hangtag_audit_change ON public.hangtag_orders;
CREATE TRIGGER hangtag_audit_change AFTER UPDATE OF status ON public.hangtag_orders FOR EACH ROW
    WHEN (OLD.status IS DISTINCT FROM NEW.status) EXECUTE FUNCTION public.hangtag_audit();

-- Who may touch these tables (row security, section 5, decides which rows): signed-out visitors nothing; orders only
-- through hangtag_save_order; collections are added (the owner may cancel one); held carts are added, changed, removed
REVOKE ALL ON TABLE public.hangtag_collections, public.hangtag_held_carts, public.hangtag_orders, public.hangtag_order_items FROM anon, authenticated;
GRANT SELECT, INSERT ON TABLE public.hangtag_collections TO authenticated;
GRANT UPDATE (status, note) ON TABLE public.hangtag_collections TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.hangtag_held_carts TO authenticated;
GRANT SELECT ON TABLE public.hangtag_orders, public.hangtag_order_items TO authenticated;
-- live updates between the shop's own tills (held carts, orders, collections)
DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['hangtag_held_carts','hangtag_orders','hangtag_collections'] LOOP
        BEGIN
            EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
        EXCEPTION WHEN OTHERS THEN
            NULL; -- already added (or realtime not available)
        END;
    END LOOP;
END $$;

-- ------------------------------------------------------------------------------
-- 3n. Serials, batches, expiry (W2-A)
-- ------------------------------------------------------------------------------
--   Serial numbers and batches ride on the records that already make stock (section 3b): nothing is a second stock.
--   · A stock record (hangtag_stock_moves) may name the serials of its pieces (serials: one per piece, whole quantity) or its
--     batch (batch_no, with the batch's expiry date): a record adding stock brings them in; one taking stock out writes them
--     off (a cancelled purchase, "pcx:" records: cancels them) or takes from that batch.
--   · A bill line names the serials it sold (serials) and what it took from each batch (batches: [{ "b", "q" }]); a return
--     line the serials coming back and the batches they go back into.
--   · hangtag_serials: one row per serial number of the shop (unique in the shop), its state — IN_STOCK, SOLD, RETURNED (back
--     on the shelf), DAMAGED (written off, or returned not for resale), CANCELLED (its purchase was cancelled) — and where it
--     came from, which bill sold it and which return brought it back. Kept only by the triggers below, from those records;
--     the app reads it. A serial can't be sold twice: a bill line naming one that isn't ready to sell is refused, on any
--     device; cancelling the bill puts it back, restoring the bill needs it still free.
--   · hangtag_batches: one row per batch of a variant (its expiry date, the stock-in that created it). A batch's stock is
--     worked out from the records (public.hangtag_batch_left); a record taking stock out of a batch can't take more than it
--     has. A batch keeps one expiry date.
--   · hangtag_products.tracks_expiry: its batches keep expiry dates (the app asks for them). What is "expiring soon" and
--     whether expired stock may be sold are the shop's settings (hangtag_meta 'settings': expiryDays, sellExpired).
--   Records saved before (no serials or batches) are untouched. Serials and batch numbers are kept in capitals, trimmed.
ALTER TABLE public.hangtag_products ADD COLUMN IF NOT EXISTS tracks_expiry BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE public.hangtag_stock_moves ADD COLUMN IF NOT EXISTS serials TEXT[];
ALTER TABLE public.hangtag_stock_moves ADD COLUMN IF NOT EXISTS batch_no TEXT;
ALTER TABLE public.hangtag_stock_moves ADD COLUMN IF NOT EXISTS expiry DATE;
ALTER TABLE public.hangtag_sale_items ADD COLUMN IF NOT EXISTS serials TEXT[];
ALTER TABLE public.hangtag_sale_items ADD COLUMN IF NOT EXISTS batches JSONB;
ALTER TABLE public.hangtag_return_items ADD COLUMN IF NOT EXISTS serials TEXT[];
ALTER TABLE public.hangtag_return_items ADD COLUMN IF NOT EXISTS batches JSONB;
ALTER TABLE public.hangtag_stock_moves DROP CONSTRAINT IF EXISTS hangtag_stock_moves_batch_check;
ALTER TABLE public.hangtag_stock_moves ADD CONSTRAINT hangtag_stock_moves_batch_check CHECK ((batch_no IS NULL OR batch_no ~ '^[A-Z0-9][A-Z0-9 ./_:#-]{0,39}$')
    AND (expiry IS NULL OR batch_no IS NOT NULL) AND (serials IS NULL OR batch_no IS NULL));
CREATE INDEX IF NOT EXISTS idx_hangtag_moves_batch ON public.hangtag_stock_moves (owner_id, variant_id, batch_no) WHERE batch_no IS NOT NULL;

-- (a) The serial register and the batches (written only by the triggers below)
CREATE TABLE IF NOT EXISTS public.hangtag_serials (
    owner_id UUID NOT NULL DEFAULT public.hangtag_shop_id() REFERENCES auth.users(id) ON DELETE CASCADE,
    serial TEXT NOT NULL CHECK (serial ~ '^[A-Z0-9][A-Z0-9./_:#-]{0,59}$'),
    variant_id TEXT NOT NULL,
    product_id TEXT,
    status TEXT NOT NULL CHECK (status IN ('IN_STOCK','SOLD','RETURNED','DAMAGED','CANCELLED')),
    move_id TEXT,                                  -- the stock record that brought it in
    import_id TEXT,                                -- its purchase (or supplier bill)
    sale_id TEXT,                                  -- the bill that sold it (kept after a return, for its history)
    sale_line_no INTEGER,
    return_id TEXT,                                -- the return that brought it back
    out_move_id TEXT,                              -- the stock record that wrote it off or cancelled it
    t BIGINT,                                      -- when it last changed (the record's time, ms)
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (owner_id, serial),
    CONSTRAINT hangtag_serials_sold_check CHECK (status <> 'SOLD' OR sale_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_hangtag_serials_variant ON public.hangtag_serials (owner_id, variant_id, status);
CREATE INDEX IF NOT EXISTS idx_hangtag_serials_sale ON public.hangtag_serials (owner_id, sale_id) WHERE sale_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS public.hangtag_batches (
    owner_id UUID NOT NULL DEFAULT public.hangtag_shop_id() REFERENCES auth.users(id) ON DELETE CASCADE,
    variant_id TEXT NOT NULL,
    batch_no TEXT NOT NULL CHECK (batch_no ~ '^[A-Z0-9][A-Z0-9 ./_:#-]{0,39}$'),
    product_id TEXT,
    expiry DATE,
    move_id TEXT,                                  -- the stock record that first brought it in
    import_id TEXT,                                -- its purchase (or supplier bill)
    t BIGINT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (owner_id, variant_id, batch_no)
);
CREATE INDEX IF NOT EXISTS idx_hangtag_batches_expiry ON public.hangtag_batches (owner_id, expiry) WHERE expiry IS NOT NULL;

-- A batch's stock now: its stock records, less what bills that aren't cancelled took from it, plus returns put back on the shelf
CREATE OR REPLACE FUNCTION public.hangtag_batch_left(p_owner UUID, p_variant TEXT, p_batch TEXT)
RETURNS NUMERIC LANGUAGE sql STABLE SET search_path = '' AS $$
    SELECT COALESCE((SELECT sum(m.qty) FROM public.hangtag_stock_moves m WHERE m.owner_id = p_owner AND m.variant_id = p_variant AND m.batch_no = p_batch), 0)
         - COALESCE((SELECT sum((a ->> 'q')::NUMERIC) FROM public.hangtag_sale_items i
                       JOIN public.hangtag_sales s ON s.owner_id = i.owner_id AND s.id = i.sale_id AND NOT s.is_void
                       CROSS JOIN LATERAL jsonb_array_elements(i.batches) a
                      WHERE i.owner_id = p_owner AND i.variant_id = p_variant AND i.batches IS NOT NULL AND a ->> 'b' = p_batch), 0)
         + COALESCE((SELECT sum((a ->> 'q')::NUMERIC) FROM public.hangtag_return_items r
                       JOIN public.hangtag_sales s ON s.owner_id = r.owner_id AND s.id = r.sale_id AND NOT s.is_void
                       CROSS JOIN LATERAL jsonb_array_elements(r.batches) a
                      WHERE r.owner_id = p_owner AND r.variant_id = p_variant AND r.restock AND r.batches IS NOT NULL AND a ->> 'b' = p_batch), 0)
$$;

-- (b) The shape of serials and batches on a record: one serial per piece (whole pieces, each once, in capitals); a line's
--     batches add up to its quantity. They never change once saved (an upload sent twice changes nothing).
CREATE OR REPLACE FUNCTION public.hangtag_tracking_shape()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
    q NUMERIC;
    n INT;
    s TEXT;
    a JSONB;
    tot NUMERIC := 0;
BEGIN
    IF NEW.serials IS NOT NULL AND cardinality(NEW.serials) = 0 THEN NEW.serials := NULL; END IF;
    IF TG_TABLE_NAME = 'hangtag_stock_moves' THEN q := abs(NEW.qty); ELSE q := NEW.quantity; END IF;
    IF NEW.serials IS NOT NULL THEN
        n := cardinality(NEW.serials);
        IF q <> trunc(q) OR n <> q THEN
            RAISE EXCEPTION '% piece(s) but % serial number(s): one serial number per piece.', trim_scale(q), n USING ERRCODE = 'check_violation';
        END IF;
        FOREACH s IN ARRAY NEW.serials LOOP
            IF s IS NULL OR s !~ '^[A-Z0-9][A-Z0-9./_:#-]{0,59}$' THEN
                RAISE EXCEPTION '"%" isn''t a serial number (letters, digits and . / _ : # -, up to 60, in capitals).', left(COALESCE(s, ''), 60) USING ERRCODE = 'check_violation';
            END IF;
        END LOOP;
        IF (SELECT count(DISTINCT x) FROM unnest(NEW.serials) x) <> n THEN
            RAISE EXCEPTION 'A serial number is on this record twice.' USING ERRCODE = 'check_violation';
        END IF;
    END IF;
    IF TG_TABLE_NAME <> 'hangtag_stock_moves' THEN
        IF NEW.batches IS NOT NULL AND jsonb_typeof(NEW.batches) = 'array' AND jsonb_array_length(NEW.batches) = 0 THEN NEW.batches := NULL; END IF;
        IF NEW.batches IS NOT NULL THEN
            IF jsonb_typeof(NEW.batches) <> 'array' THEN RAISE EXCEPTION 'A line''s batches are a list.' USING ERRCODE = 'check_violation'; END IF;
            FOR a IN SELECT x FROM jsonb_array_elements(NEW.batches) x LOOP
                IF jsonb_typeof(a) <> 'object' OR COALESCE(a ->> 'b', '') !~ '^[A-Z0-9][A-Z0-9 ./_:#-]{0,39}$' OR jsonb_typeof(a -> 'q') IS DISTINCT FROM 'number'
                   OR (a ->> 'q')::NUMERIC <= 0 THEN
                    RAISE EXCEPTION 'Each batch on a line needs its number and a quantity above 0.' USING ERRCODE = 'check_violation';
                END IF;
                tot := tot + (a ->> 'q')::NUMERIC;
            END LOOP;
            IF round(tot, 3) <> round(q, 3) THEN
                RAISE EXCEPTION 'The batches of a line come to % but the line has %.', trim_scale(round(tot, 3)), trim_scale(q) USING ERRCODE = 'check_violation';
            END IF;
        END IF;
    END IF;
    IF TG_OP = 'UPDATE' THEN
        IF NEW.serials IS DISTINCT FROM OLD.serials THEN
            RAISE EXCEPTION 'The serial numbers of a saved record don''t change.' USING ERRCODE = 'check_violation';
        END IF;
        IF TG_TABLE_NAME = 'hangtag_stock_moves' THEN
            IF NEW.batch_no IS DISTINCT FROM OLD.batch_no OR NEW.expiry IS DISTINCT FROM OLD.expiry THEN
                RAISE EXCEPTION 'The batch of a saved stock record doesn''t change.' USING ERRCODE = 'check_violation';
            END IF;
        ELSIF NEW.batches IS DISTINCT FROM OLD.batches THEN
            RAISE EXCEPTION 'The batches of a saved line don''t change.' USING ERRCODE = 'check_violation';
        END IF;
    END IF;
    RETURN NEW;
END $$;
DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['hangtag_stock_moves','hangtag_sale_items','hangtag_return_items'] LOOP
        EXECUTE format('DROP TRIGGER IF EXISTS hangtag_tracking_shape ON public.%I', t);
        EXECUTE format('CREATE TRIGGER hangtag_tracking_shape BEFORE INSERT OR UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.hangtag_tracking_shape()', t);
    END LOOP;
END $$;

-- (c) Stock records: serials in (unique: one not already in stock or on a bill; one written off or cancelled before may come
--     back) or out (only pieces in stock, of that variant); a batch created with its first stock-in (one expiry date), and
--     never taken below zero. SECURITY DEFINER: only these triggers write the register; the owner comes from the record,
--     which row security has already checked.
CREATE OR REPLACE FUNCTION public.hangtag_track_move()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    s TEXT;
    cur public.hangtag_serials;
    known DATE;
    left_now NUMERIC;
BEGIN
    IF TG_OP = 'DELETE' THEN
        -- a stock record removed (the owner, or its variant deleted): its serials go with it
        IF OLD.serials IS NOT NULL THEN
            IF OLD.qty > 0 THEN
                UPDATE public.hangtag_serials SET status = 'CANCELLED', out_move_id = OLD.id, updated_at = NOW()
                 WHERE owner_id = OLD.owner_id AND serial = ANY (OLD.serials) AND move_id = OLD.id AND status IN ('IN_STOCK','RETURNED');
            ELSE
                UPDATE public.hangtag_serials SET status = 'IN_STOCK', out_move_id = NULL, updated_at = NOW()
                 WHERE owner_id = OLD.owner_id AND serial = ANY (OLD.serials) AND out_move_id = OLD.id AND status IN ('DAMAGED','CANCELLED');
            END IF;
        END IF;
        RETURN NULL;
    END IF;
    IF NEW.serials IS NOT NULL THEN
        FOREACH s IN ARRAY NEW.serials LOOP
            SELECT * INTO cur FROM public.hangtag_serials WHERE owner_id = NEW.owner_id AND serial = s FOR UPDATE;
            IF NEW.qty > 0 THEN
                IF FOUND AND cur.status IN ('IN_STOCK','RETURNED') THEN
                    RAISE EXCEPTION 'Serial % is already in stock.', s USING ERRCODE = 'unique_violation';
                ELSIF FOUND AND cur.status = 'SOLD' THEN
                    RAISE EXCEPTION 'Serial % is on a bill (sold). Take it back with a return instead.', s USING ERRCODE = 'unique_violation';
                END IF;
                INSERT INTO public.hangtag_serials (owner_id, serial, variant_id, product_id, status, move_id, import_id, t)
                VALUES (NEW.owner_id, s, NEW.variant_id, NEW.product_id, 'IN_STOCK', NEW.id, NEW.import_id, NEW.t)
                ON CONFLICT (owner_id, serial) DO UPDATE SET variant_id = EXCLUDED.variant_id, product_id = EXCLUDED.product_id, status = 'IN_STOCK',
                    move_id = EXCLUDED.move_id, import_id = EXCLUDED.import_id, sale_id = NULL, sale_line_no = NULL, return_id = NULL, out_move_id = NULL,
                    t = EXCLUDED.t, updated_at = NOW();
            ELSE
                IF NOT FOUND OR cur.variant_id <> NEW.variant_id OR cur.status NOT IN ('IN_STOCK','RETURNED') THEN
                    RAISE EXCEPTION 'Serial % isn''t in stock%.', s, CASE WHEN FOUND AND cur.status = 'SOLD' THEN ' (it is sold)' ELSE '' END USING ERRCODE = 'check_violation';
                END IF;
                UPDATE public.hangtag_serials SET status = CASE WHEN NEW.id LIKE 'pcx:%' THEN 'CANCELLED' ELSE 'DAMAGED' END, out_move_id = NEW.id, t = NEW.t, updated_at = NOW()
                 WHERE owner_id = NEW.owner_id AND serial = s;
            END IF;
        END LOOP;
    END IF;
    IF NEW.batch_no IS NOT NULL THEN
        IF NEW.qty > 0 THEN
            INSERT INTO public.hangtag_batches (owner_id, variant_id, batch_no, product_id, expiry, move_id, import_id, t)
            VALUES (NEW.owner_id, NEW.variant_id, NEW.batch_no, NEW.product_id, NEW.expiry, NEW.id, NEW.import_id, NEW.t)
            ON CONFLICT (owner_id, variant_id, batch_no) DO NOTHING;
            SELECT expiry INTO known FROM public.hangtag_batches WHERE owner_id = NEW.owner_id AND variant_id = NEW.variant_id AND batch_no = NEW.batch_no;
            IF NEW.expiry IS NOT NULL THEN
                IF known IS NULL THEN
                    UPDATE public.hangtag_batches SET expiry = NEW.expiry WHERE owner_id = NEW.owner_id AND variant_id = NEW.variant_id AND batch_no = NEW.batch_no;
                ELSIF known <> NEW.expiry THEN
                    RAISE EXCEPTION 'Batch % already has the expiry date %.', NEW.batch_no, known USING ERRCODE = 'check_violation';
                END IF;
            END IF;
        ELSIF NEW.qty < 0 THEN
            IF NOT EXISTS (SELECT 1 FROM public.hangtag_batches WHERE owner_id = NEW.owner_id AND variant_id = NEW.variant_id AND batch_no = NEW.batch_no) THEN
                RAISE EXCEPTION 'Batch % of this item isn''t in stock.', NEW.batch_no USING ERRCODE = 'check_violation';
            END IF;
            left_now := public.hangtag_batch_left(NEW.owner_id, NEW.variant_id, NEW.batch_no);
            IF left_now < 0 THEN
                RAISE EXCEPTION 'Batch % has only % left.', NEW.batch_no, trim_scale(left_now - NEW.qty) USING ERRCODE = 'check_violation';
            END IF;
        END IF;
    END IF;
    RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS hangtag_track_move ON public.hangtag_stock_moves;
CREATE TRIGGER hangtag_track_move AFTER INSERT OR DELETE ON public.hangtag_stock_moves FOR EACH ROW EXECUTE FUNCTION public.hangtag_track_move();

-- (d) Bill lines: each serial sold must be of the line's variant and ready to sell (in stock or back from a return); a bill
--     line removed puts its serials back
CREATE OR REPLACE FUNCTION public.hangtag_track_sale_item()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    s TEXT;
    cur public.hangtag_serials;
    sale public.hangtag_sales;
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD.serials IS NOT NULL THEN
            UPDATE public.hangtag_serials SET status = 'IN_STOCK', sale_id = NULL, sale_line_no = NULL, updated_at = NOW()
             WHERE owner_id = OLD.owner_id AND sale_id = OLD.sale_id AND sale_line_no = OLD.line_no AND status = 'SOLD';
        END IF;
        RETURN NULL;
    END IF;
    IF NEW.serials IS NULL THEN RETURN NULL; END IF;
    SELECT * INTO sale FROM public.hangtag_sales WHERE owner_id = NEW.owner_id AND id = NEW.sale_id;
    IF NOT FOUND OR sale.is_void THEN RETURN NULL; END IF;   -- a bill saved already cancelled sells nothing
    FOREACH s IN ARRAY NEW.serials LOOP
        SELECT * INTO cur FROM public.hangtag_serials WHERE owner_id = NEW.owner_id AND serial = s FOR UPDATE;
        IF NOT FOUND OR cur.variant_id IS DISTINCT FROM NEW.variant_id THEN
            RAISE EXCEPTION 'Serial % isn''t in stock for %.', s, NEW.product_name USING ERRCODE = 'check_violation';
        END IF;
        IF cur.status NOT IN ('IN_STOCK','RETURNED') THEN
            RAISE EXCEPTION 'Serial % is %: it can''t be sold again.', s, CASE cur.status WHEN 'SOLD' THEN 'already sold' WHEN 'DAMAGED' THEN 'written off' ELSE 'cancelled' END
                USING ERRCODE = 'unique_violation';
        END IF;
        UPDATE public.hangtag_serials SET status = 'SOLD', sale_id = NEW.sale_id, sale_line_no = NEW.line_no, return_id = NULL, t = sale.timestamp, updated_at = NOW()
         WHERE owner_id = NEW.owner_id AND serial = s;
    END LOOP;
    RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS hangtag_track_sale_item ON public.hangtag_sale_items;
CREATE TRIGGER hangtag_track_sale_item AFTER INSERT OR DELETE ON public.hangtag_sale_items FOR EACH ROW EXECUTE FUNCTION public.hangtag_track_sale_item();

-- (e) Cancelling a bill puts its serials back in stock; restoring it sells them again — only while they are still free
CREATE OR REPLACE FUNCTION public.hangtag_track_sale_status()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    i RECORD;
    s TEXT;
    cur public.hangtag_serials;
BEGIN
    IF NEW.is_void THEN
        UPDATE public.hangtag_serials SET status = 'IN_STOCK', sale_id = NULL, sale_line_no = NULL, updated_at = NOW()
         WHERE owner_id = NEW.owner_id AND sale_id = NEW.id AND status = 'SOLD';
        RETURN NULL;
    END IF;
    FOR i IN SELECT line_no, variant_id, serials FROM public.hangtag_sale_items WHERE owner_id = NEW.owner_id AND sale_id = NEW.id AND serials IS NOT NULL LOOP
        FOREACH s IN ARRAY i.serials LOOP
            SELECT * INTO cur FROM public.hangtag_serials WHERE owner_id = NEW.owner_id AND serial = s FOR UPDATE;
            IF NOT FOUND OR cur.variant_id IS DISTINCT FROM i.variant_id OR cur.status NOT IN ('IN_STOCK','RETURNED') THEN
                RAISE EXCEPTION 'Serial % of bill % was sold again or isn''t in stock any more, so the bill can''t be restored.', s, COALESCE(NEW.bill_no, NEW.id)
                    USING ERRCODE = 'check_violation';
            END IF;
            UPDATE public.hangtag_serials SET status = 'SOLD', sale_id = NEW.id, sale_line_no = i.line_no, return_id = NULL, t = NEW.timestamp, updated_at = NOW()
             WHERE owner_id = NEW.owner_id AND serial = s;
        END LOOP;
    END LOOP;
    RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS hangtag_track_sale_status ON public.hangtag_sales;
CREATE TRIGGER hangtag_track_sale_status AFTER UPDATE OF is_void ON public.hangtag_sales
    FOR EACH ROW WHEN (OLD.is_void IS DISTINCT FROM NEW.is_void) EXECUTE FUNCTION public.hangtag_track_sale_status();

-- (f) Return lines: only serials sold on that bill line and not back already; they come back on the shelf (RETURNED) or, not
--     for resale, written off (DAMAGED). The batches a line goes back into: batches it took from, never more than it took.
CREATE OR REPLACE FUNCTION public.hangtag_track_return_item()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    s TEXT;
    cur public.hangtag_serials;
    line public.hangtag_sale_items;
    a JSONB;
    took NUMERIC;
    back NUMERIC;
    rt BIGINT;
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD.serials IS NOT NULL THEN
            UPDATE public.hangtag_serials SET status = 'SOLD', return_id = NULL, updated_at = NOW()
             WHERE owner_id = OLD.owner_id AND serial = ANY (OLD.serials) AND return_id = OLD.return_id AND status IN ('RETURNED','DAMAGED');
        END IF;
        RETURN NULL;
    END IF;
    IF NEW.serials IS NULL AND NEW.batches IS NULL THEN RETURN NULL; END IF;
    SELECT * INTO line FROM public.hangtag_sale_items WHERE owner_id = NEW.owner_id AND sale_id = NEW.sale_id AND line_no = NEW.sale_line_no;
    SELECT t INTO rt FROM public.hangtag_returns WHERE owner_id = NEW.owner_id AND id = NEW.return_id;
    IF NEW.serials IS NOT NULL THEN
        FOREACH s IN ARRAY NEW.serials LOOP
            IF line.serials IS NULL OR NOT (s = ANY (line.serials)) THEN
                RAISE EXCEPTION 'Serial % wasn''t sold on that bill line.', s USING ERRCODE = 'check_violation';
            END IF;
            SELECT * INTO cur FROM public.hangtag_serials WHERE owner_id = NEW.owner_id AND serial = s FOR UPDATE;
            IF NOT FOUND OR cur.status <> 'SOLD' OR cur.sale_id IS DISTINCT FROM NEW.sale_id THEN
                RAISE EXCEPTION 'Serial % has already come back, or isn''t on that bill any more.', s USING ERRCODE = 'check_violation';
            END IF;
            UPDATE public.hangtag_serials SET status = CASE WHEN NEW.restock THEN 'RETURNED' ELSE 'DAMAGED' END, return_id = NEW.return_id, t = rt, updated_at = NOW()
             WHERE owner_id = NEW.owner_id AND serial = s;
        END LOOP;
    END IF;
    IF NEW.batches IS NOT NULL THEN
        FOR a IN SELECT x FROM jsonb_array_elements(NEW.batches) x LOOP
            SELECT COALESCE(sum((y ->> 'q')::NUMERIC), 0) INTO took FROM jsonb_array_elements(COALESCE(line.batches, '[]'::jsonb)) y WHERE y ->> 'b' = a ->> 'b';
            SELECT COALESCE(sum((y ->> 'q')::NUMERIC), 0) INTO back FROM public.hangtag_return_items r CROSS JOIN LATERAL jsonb_array_elements(r.batches) y
             WHERE r.owner_id = NEW.owner_id AND r.sale_id = NEW.sale_id AND r.sale_line_no = NEW.sale_line_no AND r.batches IS NOT NULL AND y ->> 'b' = a ->> 'b';
            IF back > took THEN
                RAISE EXCEPTION 'More of batch % would come back than that bill line took from it (%).', a ->> 'b', trim_scale(took) USING ERRCODE = 'check_violation';
            END IF;
        END LOOP;
    END IF;
    RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS hangtag_track_return_item ON public.hangtag_return_items;
CREATE TRIGGER hangtag_track_return_item AFTER INSERT OR DELETE ON public.hangtag_return_items FOR EACH ROW EXECUTE FUNCTION public.hangtag_track_return_item();

-- (g) Saving bills (as section 3m) now keeps each line's serials and batches
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
            round_off, gst_mode, place_of_supply, customer_gstin, customer_type, event_id, due_amount, order_id)
        VALUES (s.id, s.timestamp, COALESCE(s.subtotal, 0), COALESCE(s.discount, 0), COALESCE(s.total, 0), s.payment_method, s.device_id,
            COALESCE(s.is_void, FALSE), s.bill_no, s.customer_id, s.customer_name, s.customer_phone, COALESCE(s.tax_rate, 0),
            COALESCE(s.tax_amount, 0), COALESCE(s.tax_inclusive, TRUE), COALESCE(s.kind, 'sale'), s.exchange_id, COALESCE(s.credit, 0),
            COALESCE(s.item_discount, 0), COALESCE(s.bill_discount, 0), s.bill_discount_type, s.bill_discount_value, s.taxable_amount,
            COALESCE(s.cgst_amount, 0), COALESCE(s.sgst_amount, 0), COALESCE(s.igst_amount, 0), COALESCE(s.round_off, 0),
            s.gst_mode, s.place_of_supply, s.customer_gstin, s.customer_type, s.event_id, COALESCE(s.due_amount, 0), s.order_id)
        ON CONFLICT (owner_id, id) DO UPDATE SET timestamp = EXCLUDED.timestamp, subtotal = EXCLUDED.subtotal, discount = EXCLUDED.discount,
            total = EXCLUDED.total, payment_method = EXCLUDED.payment_method, device_id = EXCLUDED.device_id, is_void = EXCLUDED.is_void, void_reason = CASE WHEN EXCLUDED.is_void THEN hangtag_sales.void_reason END,
            bill_no = EXCLUDED.bill_no, customer_id = EXCLUDED.customer_id, customer_name = EXCLUDED.customer_name,
            customer_phone = EXCLUDED.customer_phone, tax_rate = EXCLUDED.tax_rate, tax_amount = EXCLUDED.tax_amount,
            tax_inclusive = EXCLUDED.tax_inclusive, kind = EXCLUDED.kind, exchange_id = EXCLUDED.exchange_id, credit = EXCLUDED.credit,
            item_discount = EXCLUDED.item_discount, bill_discount = EXCLUDED.bill_discount, bill_discount_type = EXCLUDED.bill_discount_type,
            bill_discount_value = EXCLUDED.bill_discount_value, taxable_amount = EXCLUDED.taxable_amount, cgst_amount = EXCLUDED.cgst_amount,
            sgst_amount = EXCLUDED.sgst_amount, igst_amount = EXCLUDED.igst_amount, round_off = EXCLUDED.round_off, gst_mode = EXCLUDED.gst_mode,
            place_of_supply = EXCLUDED.place_of_supply, customer_gstin = EXCLUDED.customer_gstin, customer_type = EXCLUDED.customer_type,
            event_id = EXCLUDED.event_id, due_amount = EXCLUDED.due_amount, order_id = EXCLUDED.order_id;
        INSERT INTO public.hangtag_sale_items (sale_id, line_no, product_id, product_name, size, quantity, unit_price, variant_id, color, sku,
            cost_price, variant_label, options, discount_type, discount_value, discount_amount, bill_discount_share, taxable_value, gst_rate,
            cgst_amount, sgst_amount, igst_amount, line_total, hsn, serials, batches)
        SELECT s.id, i.line_no, i.product_id, i.product_name, COALESCE(i.size, ''), COALESCE(i.quantity, 1), COALESCE(i.unit_price, 0),
            i.variant_id, COALESCE(i.color, ''), i.sku, i.cost_price, i.variant_label, i.options, i.discount_type, i.discount_value,
            COALESCE(i.discount_amount, 0), COALESCE(i.bill_discount_share, 0), i.taxable_value, i.gst_rate, COALESCE(i.cgst_amount, 0),
            COALESCE(i.sgst_amount, 0), COALESCE(i.igst_amount, 0), i.line_total, i.hsn, i.serials, i.batches
        FROM jsonb_populate_recordset(NULL::public.hangtag_sale_items, COALESCE(b -> 'items', '[]'::jsonb)) i
        ON CONFLICT (owner_id, sale_id, line_no) DO UPDATE SET product_id = EXCLUDED.product_id, product_name = EXCLUDED.product_name,
            size = EXCLUDED.size, quantity = EXCLUDED.quantity, unit_price = EXCLUDED.unit_price, variant_id = EXCLUDED.variant_id,
            color = EXCLUDED.color, sku = EXCLUDED.sku, cost_price = EXCLUDED.cost_price, variant_label = EXCLUDED.variant_label,
            options = EXCLUDED.options, discount_type = EXCLUDED.discount_type, discount_value = EXCLUDED.discount_value,
            discount_amount = EXCLUDED.discount_amount, bill_discount_share = EXCLUDED.bill_discount_share, taxable_value = EXCLUDED.taxable_value,
            gst_rate = EXCLUDED.gst_rate, cgst_amount = EXCLUDED.cgst_amount, sgst_amount = EXCLUDED.sgst_amount,
            igst_amount = EXCLUDED.igst_amount, line_total = EXCLUDED.line_total, hsn = EXCLUDED.hsn, serials = EXCLUDED.serials, batches = EXCLUDED.batches;
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
            -- a payment the provider verified (section 3h) stays verified when the phone uploads the bill again
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

-- (h) Saving a return (as section 3g) now keeps each line's serials and batches
CREATE OR REPLACE FUNCTION public.hangtag_save_return(p_return JSONB, p_items JSONB)
RETURNS JSONB LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE
    uid UUID := public.hangtag_shop_id();
    r public.hangtag_returns;
    voided BOOLEAN;
    lines_value NUMERIC;
    n INT;
BEGIN
    IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Sign in to save returns.' USING ERRCODE = '42501'; END IF;
    IF uid IS NULL OR NOT public.hangtag_can('perform_return') THEN RAISE EXCEPTION 'Not allowed to save returns.' USING ERRCODE = '42501'; END IF;
    r := jsonb_populate_record(NULL::public.hangtag_returns, p_return);
    IF COALESCE(r.id, '') = '' THEN RAISE EXCEPTION 'A return has no id.' USING ERRCODE = '22023'; END IF;
    -- a team member only adds returns: one already saved stays exactly as it is (its retry saves nothing new)
    IF uid <> auth.uid() AND EXISTS (SELECT 1 FROM public.hangtag_returns x WHERE x.owner_id = uid AND x.id = r.id) THEN
        RETURN jsonb_build_object('status', 'saved', 'return', r.id, 'lines', (SELECT count(*) FROM public.hangtag_return_items i WHERE i.owner_id = uid AND i.return_id = r.id));
    END IF;
    SELECT is_void INTO voided FROM public.hangtag_sales WHERE owner_id = uid AND id = r.sale_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Bill % was not found', r.sale_id USING ERRCODE = 'foreign_key_violation';
    END IF;
    IF voided THEN
        RAISE EXCEPTION 'That bill is cancelled, so it can''t have a return' USING ERRCODE = 'check_violation';
    END IF;
    INSERT INTO public.hangtag_returns (id, sale_id, t, kind, exchange_id, refund_amount, refund_method, value, round_off, credit_no, note, device_id)
    VALUES (r.id, r.sale_id, r.t, COALESCE(r.kind, 'return'), r.exchange_id, COALESCE(r.refund_amount, 0), r.refund_method, COALESCE(r.value, 0),
        COALESCE(r.round_off, 0), r.credit_no, r.note, r.device_id)
    ON CONFLICT (owner_id, id) DO UPDATE SET sale_id = EXCLUDED.sale_id, t = EXCLUDED.t, kind = EXCLUDED.kind, exchange_id = EXCLUDED.exchange_id,
        refund_amount = EXCLUDED.refund_amount, refund_method = EXCLUDED.refund_method, value = EXCLUDED.value, round_off = EXCLUDED.round_off,
        credit_no = EXCLUDED.credit_no, note = EXCLUDED.note, device_id = EXCLUDED.device_id;
    DELETE FROM public.hangtag_return_items i WHERE i.owner_id = uid AND i.return_id = r.id
       AND i.line_no NOT IN (SELECT (y ->> 'line_no')::int FROM jsonb_array_elements(COALESCE(p_items, '[]'::jsonb)) y);
    INSERT INTO public.hangtag_return_items (return_id, line_no, sale_id, sale_line_no, variant_id, product_id, product_name, color, size, sku,
        quantity, unit_price, value, cost_price, variant_label, options, restock, taxable_value, gst_rate, cgst_amount, sgst_amount, igst_amount, hsn, serials, batches)
    SELECT r.id, i.line_no, r.sale_id, i.sale_line_no, i.variant_id, i.product_id, i.product_name, COALESCE(i.color, ''), COALESCE(i.size, ''), i.sku,
        i.quantity, COALESCE(i.unit_price, 0), COALESCE(i.value, 0), i.cost_price, i.variant_label, i.options, COALESCE(i.restock, TRUE), i.taxable_value,
        i.gst_rate, COALESCE(i.cgst_amount, 0), COALESCE(i.sgst_amount, 0), COALESCE(i.igst_amount, 0), i.hsn, i.serials, i.batches
    FROM jsonb_populate_recordset(NULL::public.hangtag_return_items, COALESCE(p_items, '[]'::jsonb)) i
    ON CONFLICT (owner_id, return_id, line_no) DO UPDATE SET sale_id = EXCLUDED.sale_id, sale_line_no = EXCLUDED.sale_line_no,
        variant_id = EXCLUDED.variant_id, product_id = EXCLUDED.product_id, product_name = EXCLUDED.product_name, color = EXCLUDED.color,
        size = EXCLUDED.size, sku = EXCLUDED.sku, quantity = EXCLUDED.quantity, unit_price = EXCLUDED.unit_price, value = EXCLUDED.value,
        cost_price = EXCLUDED.cost_price, variant_label = EXCLUDED.variant_label, options = EXCLUDED.options, restock = EXCLUDED.restock,
        taxable_value = EXCLUDED.taxable_value, gst_rate = EXCLUDED.gst_rate, cgst_amount = EXCLUDED.cgst_amount, sgst_amount = EXCLUDED.sgst_amount,
        igst_amount = EXCLUDED.igst_amount, hsn = EXCLUDED.hsn, serials = EXCLUDED.serials, batches = EXCLUDED.batches;
    SELECT count(*), COALESCE(SUM(value), 0) INTO n, lines_value FROM public.hangtag_return_items WHERE owner_id = uid AND return_id = r.id;
    IF n = 0 THEN RAISE EXCEPTION 'A return needs at least one line' USING ERRCODE = 'check_violation'; END IF;
    IF COALESCE(r.value, 0) <> lines_value + COALESCE(r.round_off, 0) THEN
        RAISE EXCEPTION 'Return % is worth % but its lines come to %', COALESCE(r.credit_no, r.id), r.value, lines_value + COALESCE(r.round_off, 0)
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN jsonb_build_object('status', 'saved', 'return', r.id, 'lines', n);
END $$;
REVOKE ALL ON FUNCTION public.hangtag_save_return(JSONB, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.hangtag_save_return(JSONB, JSONB) TO authenticated;

-- (i) Saving a purchase (as section 3l): its stock-in records carry their serials, or their batch and expiry date. p_tracking
--     stays accepted and unused (the stock-in records carry everything).
CREATE OR REPLACE FUNCTION public.hangtag_save_purchase(p_purchase JSONB, p_moves JSONB, p_tracking JSONB DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE
    uid UUID := public.hangtag_shop_id(); pid TEXT := btrim(COALESCE(p_purchase ->> 'id', ''));
    lines JSONB := COALESCE(p_purchase -> 'lines', '[]'::jsonb); sid TEXT := NULLIF(btrim(COALESCE(p_purchase ->> 'supplier_id', '')), '');
    sub NUMERIC := round(COALESCE((p_purchase ->> 'subtotal')::NUMERIC, 0), 2); tax NUMERIC := round(COALESCE((p_purchase ->> 'tax_amount')::NUMERIC, 0), 2);
    l_sub NUMERIC; l_tax NUMERIC; l_q NUMERIC; n_m INT; m_q NUMERIC; bad BOOLEAN; s_name TEXT; s_gstin TEXT;
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
    IF sid IS NOT NULL THEN SELECT name, gstin INTO s_name, s_gstin FROM public.hangtag_suppliers WHERE owner_id = uid AND id = sid; END IF;
    INSERT INTO public.hangtag_stock_imports (id, kind, supplier_id, supplier_name, supplier_gstin, invoice_no, invoice_date, t, line_count, units, amount,
                                              subtotal, tax_amount, total_amount, paid_amount, payment_method, status, note, lines, device_id)
    VALUES (pid, 'purchase', sid, COALESCE(NULLIF(btrim(p_purchase ->> 'supplier_name'), ''), s_name), COALESCE(NULLIF(btrim(p_purchase ->> 'supplier_gstin'), ''), s_gstin),
            NULLIF(btrim(COALESCE(p_purchase ->> 'invoice_no', '')), ''), NULLIF(p_purchase ->> 'invoice_date', '')::DATE,
            COALESCE((p_purchase ->> 't')::BIGINT, (extract(epoch FROM now()) * 1000)::BIGINT), jsonb_array_length(lines), m_q,
            round(COALESCE((p_purchase ->> 'total_amount')::NUMERIC, 0), 2), sub, tax, round(COALESCE((p_purchase ->> 'total_amount')::NUMERIC, 0), 2),
            round(COALESCE((p_purchase ->> 'paid_amount')::NUMERIC, 0), 2), NULLIF(p_purchase ->> 'payment_method', ''), 'posted',
            NULLIF(left(btrim(COALESCE(p_purchase ->> 'note', '')), 200), ''), lines, p_purchase ->> 'device_id');
    INSERT INTO public.hangtag_stock_moves (id, variant_id, product_id, type, qty, cost_price, note, t, device_id, import_id, serials, batch_no, expiry)
    SELECT x ->> 'id', x ->> 'variant_id', x ->> 'product_id', 'RESTOCK', (x ->> 'qty')::NUMERIC, round((x ->> 'cost_price')::NUMERIC)::INTEGER, left(x ->> 'note', 200),
           COALESCE((x ->> 't')::BIGINT, (p_purchase ->> 't')::BIGINT, (extract(epoch FROM now()) * 1000)::BIGINT), COALESCE(x ->> 'device_id', p_purchase ->> 'device_id'), pid,
           CASE WHEN jsonb_typeof(x -> 'serials') = 'array' THEN ARRAY(SELECT jsonb_array_elements_text(x -> 'serials')) END,
           NULLIF(x ->> 'batch_no', ''), NULLIF(x ->> 'expiry', '')::DATE
    FROM jsonb_array_elements(p_moves) x
    ON CONFLICT (owner_id, id) DO NOTHING;   -- a stock-in record already sent on its own (a full re-upload) stays as it is
    RETURN jsonb_build_object('status', 'saved', 'purchase_id', pid, 'moves', n_m);
END $$;

-- (j) Cancelling a purchase (as section 3l): its serials and batch stock leave with it — refused while one of its serials is
--     sold (or written off) or its batch no longer holds what it brought in
CREATE OR REPLACE FUNCTION public.hangtag_cancel_purchase(p_id TEXT, p_reason TEXT, p_device TEXT DEFAULT NULL, p_t BIGINT DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE uid UUID := public.hangtag_shop_id(); p RECORD; why TEXT := btrim(COALESCE(p_reason, '')); n INT;
BEGIN
    IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Sign in to cancel purchases.' USING ERRCODE = '42501'; END IF;
    IF uid IS NULL OR NOT public.hangtag_can('create_purchase') OR NOT public.hangtag_can('manage_inventory') THEN
        RAISE EXCEPTION 'Not allowed to cancel purchases.' USING ERRCODE = '42501';
    END IF;
    SELECT id, status INTO p FROM public.hangtag_stock_imports WHERE owner_id = uid AND id = p_id AND kind = 'purchase';
    IF NOT FOUND THEN RAISE EXCEPTION 'That purchase isn''t in the cloud yet.' USING ERRCODE = '23503'; END IF;
    IF p.status = 'cancelled' THEN RETURN jsonb_build_object('status', 'already_cancelled', 'purchase_id', p_id); END IF;
    IF char_length(why) < 3 THEN RAISE EXCEPTION 'Say why the purchase is cancelled (at least 3 characters).' USING ERRCODE = '23514'; END IF;
    PERFORM set_config('hangtag.cancel_purchase', p_id, true);
    UPDATE public.hangtag_stock_imports SET status = 'cancelled', cancel_reason = left(why, 200), cancelled_at = now() WHERE owner_id = uid AND id = p_id;
    PERFORM set_config('hangtag.cancel_purchase', '', true);
    INSERT INTO public.hangtag_stock_moves (id, variant_id, product_id, type, qty, cost_price, note, t, device_id, import_id, serials, batch_no)
    SELECT 'pcx:' || m.id, m.variant_id, m.product_id, 'ADJUST', -m.qty, NULL, left('Purchase cancelled: ' || why, 200), COALESCE(p_t, (extract(epoch FROM now()) * 1000)::BIGINT), p_device, p_id,
           m.serials, m.batch_no
    FROM public.hangtag_stock_moves m WHERE m.owner_id = uid AND m.import_id = p_id AND m.type = 'RESTOCK'
    ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN jsonb_build_object('status', 'cancelled', 'purchase_id', p_id, 'moves', n);
END $$;
REVOKE ALL ON FUNCTION public.hangtag_save_purchase(JSONB, JSONB, JSONB), public.hangtag_cancel_purchase(TEXT, TEXT, TEXT, BIGINT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.hangtag_save_purchase(JSONB, JSONB, JSONB), public.hangtag_cancel_purchase(TEXT, TEXT, TEXT, BIGINT) TO authenticated;

-- (k) Audit (section 3i (e)), as before, and now: a serial assigned (in), sold, returned, written off, cancelled or back in
--     stock; a batch created; every stock record with serials or a batch (not only adjustments). The summary keeps at most 20
--     entries of a list (serial numbers).
CREATE OR REPLACE FUNCTION public.hangtag_audit()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    r JSONB;
    o JSONB;
    shop UUID;
    act TEXT := lower(TG_OP);
    changed TEXT[];
    dev TEXT;
    summary JSONB;
    keep CONSTANT TEXT[] := ARRAY['status','name','username','role','label','permissions','type','qty','amount','reason','category',
        'reverses','refund_amount','refund_method','value','credit_no','bill_no','total','is_void','void_reason','kind','sale_id',
        'variant_id','product_id','note','day','scope','expected','counted','difference','archived','platform','user_id',
        'start_date','end_date','method','credit','discount','quantity','unit_price','line_no','return_id',
        'serial','serials','batch_no','batches','expiry','import_id','move_id','out_move_id'];
BEGIN
    IF TG_OP = 'DELETE' THEN r := to_jsonb(OLD); ELSE r := to_jsonb(NEW); END IF;
    shop := COALESCE(r ->> 'owner_id', r ->> 'shop_id')::UUID;
    IF shop IS NULL OR NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = shop) THEN RETURN NULL; END IF;
    IF TG_OP = 'UPDATE' THEN
        o := to_jsonb(OLD);
        SELECT array_agg(k ORDER BY k) INTO changed FROM jsonb_object_keys(r) k
         WHERE k NOT IN ('updated_at','last_seen_at','created_at','changed_by') AND (r -> k) IS DISTINCT FROM (o -> k);
        IF changed IS NULL THEN RETURN NULL; END IF;
        act := CASE
            WHEN TG_TABLE_NAME = 'hangtag_sales' AND 'is_void' = ANY (changed) THEN CASE WHEN (r ->> 'is_void')::BOOLEAN THEN 'void' ELSE 'restore' END
            WHEN TG_TABLE_NAME = 'hangtag_products' AND 'archived' = ANY (changed) THEN CASE WHEN (r ->> 'archived')::BOOLEAN THEN 'archive' ELSE 'unarchive' END
            WHEN TG_TABLE_NAME = 'hangtag_devices' AND 'status' = ANY (changed) AND r ->> 'status' = 'revoked' THEN 'revoke'
            WHEN TG_TABLE_NAME = 'hangtag_members' AND 'status' = ANY (changed) THEN CASE WHEN r ->> 'status' = 'disabled' THEN 'disable' ELSE 'enable' END
            WHEN TG_TABLE_NAME = 'hangtag_members' AND 'access_reset_at' = ANY (changed) THEN 'reset'
            WHEN TG_TABLE_NAME = 'hangtag_serials' AND 'status' = ANY (changed) THEN CASE r ->> 'status' WHEN 'SOLD' THEN 'sold' WHEN 'RETURNED' THEN 'returned'
                WHEN 'DAMAGED' THEN 'written_off' WHEN 'CANCELLED' THEN 'cancelled' ELSE 'in_stock' END
            ELSE 'update' END;
    END IF;
    -- the member's device that made the change (the owner has none: then the device the row names, if any)
    SELECT d.id INTO dev FROM public.hangtag_devices d
     WHERE d.key_hash = public.hangtag_request_device() AND d.user_id = auth.uid() AND d.status = 'active';
    SELECT COALESCE(jsonb_object_agg(e.key, CASE WHEN jsonb_typeof(e.value) = 'string' THEN to_jsonb(left(e.value #>> '{}', 80))
            WHEN jsonb_typeof(e.value) = 'array' AND jsonb_array_length(e.value) > 20 THEN (SELECT jsonb_agg(x.v) FROM jsonb_array_elements(e.value) WITH ORDINALITY x(v, i) WHERE x.i <= 20)
            ELSE e.value END), '{}'::jsonb)
      INTO summary FROM jsonb_each(r) e WHERE e.key = ANY (keep) AND e.value <> 'null'::jsonb;
    IF changed IS NOT NULL THEN summary := summary || jsonb_build_object('changed', to_jsonb(changed[1:20])); END IF;
    INSERT INTO public.hangtag_audit_log (owner_id, user_id, device_id, action, entity, entity_id, summary)
    VALUES (shop, COALESCE(auth.uid(), (r ->> 'changed_by')::UUID, (r ->> 'created_by')::UUID), left(COALESCE(dev, r ->> 'device_id'), 80), act,
            regexp_replace(TG_TABLE_NAME, '^hangtag_', ''),
            left(CASE TG_TABLE_NAME WHEN 'hangtag_serials' THEN r ->> 'serial' WHEN 'hangtag_batches' THEN (r ->> 'batch_no') || ' · ' || (r ->> 'variant_id')
                 ELSE COALESCE(r ->> 'id', r ->> 'user_id', r ->> 'role') END, 100), summary);
    RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS hangtag_audit ON public.hangtag_stock_moves;
CREATE TRIGGER hangtag_audit AFTER INSERT ON public.hangtag_stock_moves FOR EACH ROW
    WHEN (NEW.type = 'ADJUST' OR NEW.batch_no IS NOT NULL OR NEW.serials IS NOT NULL) EXECUTE FUNCTION public.hangtag_audit();
DROP TRIGGER IF EXISTS hangtag_audit ON public.hangtag_serials;
CREATE TRIGGER hangtag_audit AFTER INSERT ON public.hangtag_serials FOR EACH ROW EXECUTE FUNCTION public.hangtag_audit();
DROP TRIGGER IF EXISTS hangtag_audit_change ON public.hangtag_serials;
CREATE TRIGGER hangtag_audit_change AFTER UPDATE OF status ON public.hangtag_serials FOR EACH ROW
    WHEN (OLD.status IS DISTINCT FROM NEW.status) EXECUTE FUNCTION public.hangtag_audit();
DROP TRIGGER IF EXISTS hangtag_audit ON public.hangtag_batches;
CREATE TRIGGER hangtag_audit AFTER INSERT ON public.hangtag_batches FOR EACH ROW EXECUTE FUNCTION public.hangtag_audit();

-- (l) Who may use them: the register and the batches are read by the shop (row security, section 5) and written only here
REVOKE ALL ON TABLE public.hangtag_serials, public.hangtag_batches FROM anon, authenticated;
GRANT SELECT ON TABLE public.hangtag_serials, public.hangtag_batches TO authenticated;
REVOKE ALL ON FUNCTION public.hangtag_batch_left(UUID, TEXT, TEXT), public.hangtag_tracking_shape(), public.hangtag_track_move(), public.hangtag_track_sale_item(),
    public.hangtag_track_sale_status(), public.hangtag_track_return_item() FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------------------------
-- 3o. Restaurant: tables, sessions, table orders, kitchen (W2-B)
-- ------------------------------------------------------------------------------
--   A restaurant's tables, the sessions at them (guests seated until their bill is paid) and the kitchen. Nothing here is a
--   second billing engine: a table's orders are orders of kind 'table' (section 3m: new → accepted → preparing → ready →
--   served, or cancelled), they never change stock, and the bill is the ordinary bill (hangtag_sales, now with the table
--   and session it was for); paying it closes the session, so the table is free again.
--   · hangtag_tables: name, area, seats, in use or not, and qr_token — what the table's QR code carries: it identifies the
--     shop's table and nothing else (no password or key). A new token makes the old QR stop working.
--   · hangtag_table_sessions: open → billing → closed (with the bill). A closed session stays closed.
--   · RPC hangtag_order_status: the kitchen moves a table order along (forward only; any step not yet served can be
--     cancelled) without being able to edit it; a step another screen already passed changes nothing.
--   · Guests ordering from the table's QR (no sign-in): RPC hangtag_table_menu (the menu: names, options, prices — never
--     stock, costs, suppliers or anything else of the shop) and RPC hangtag_place_table_order (a table order for the
--     table's session, priced from the catalog, at most 10 orders per table in 10 minutes). Both only while the shop has
--     the capabilities on (public.hangtag_cap_on: the business type's defaults with the shop's own choices, section 3j).
-- (a) Tables and their sessions
CREATE TABLE IF NOT EXISTS public.hangtag_tables (
    owner_id UUID NOT NULL DEFAULT public.hangtag_shop_id() REFERENCES auth.users(id) ON DELETE CASCADE,
    id TEXT NOT NULL CHECK (char_length(id) BETWEEN 1 AND 64),
    name TEXT NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 20),
    area TEXT CHECK (area IS NULL OR char_length(area) <= 30),
    seats INTEGER CHECK (seats IS NULL OR seats BETWEEN 1 AND 99),
    sort_order INTEGER NOT NULL DEFAULT 0,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    qr_token TEXT NOT NULL CHECK (qr_token ~ '^[A-Za-z0-9_-]{32,64}$'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (owner_id, id),
    CONSTRAINT hangtag_tables_qr_key UNIQUE (qr_token)
);
-- a name is used once among the tables in use
CREATE UNIQUE INDEX IF NOT EXISTS uq_hangtag_tables_name ON public.hangtag_tables (owner_id, lower(btrim(name))) WHERE active;
CREATE TABLE IF NOT EXISTS public.hangtag_table_sessions (
    owner_id UUID NOT NULL DEFAULT public.hangtag_shop_id() REFERENCES auth.users(id) ON DELETE CASCADE,
    id TEXT NOT NULL CHECK (char_length(id) BETWEEN 1 AND 64),
    table_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','billing','closed')),
    opened_t BIGINT NOT NULL,
    closed_t BIGINT,
    sale_id TEXT,
    guests INTEGER CHECK (guests IS NULL OR guests BETWEEN 1 AND 99),
    device_id TEXT,
    user_id UUID DEFAULT auth.uid(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (owner_id, id),
    CONSTRAINT hangtag_table_sessions_table_fkey FOREIGN KEY (owner_id, table_id) REFERENCES public.hangtag_tables (owner_id, id),
    CONSTRAINT hangtag_table_sessions_closed_check CHECK ((status = 'closed') = (closed_t IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_hangtag_table_sessions_live ON public.hangtag_table_sessions (owner_id, table_id) WHERE status <> 'closed';
CREATE INDEX IF NOT EXISTS idx_hangtag_table_sessions_closed ON public.hangtag_table_sessions (owner_id, closed_t) WHERE closed_t IS NOT NULL;
DROP TRIGGER IF EXISTS hangtag_stamp_user_id ON public.hangtag_table_sessions;
CREATE TRIGGER hangtag_stamp_user_id BEFORE INSERT ON public.hangtag_table_sessions FOR EACH ROW EXECUTE FUNCTION public.hangtag_stamp_user_id();
-- a closed session stays as it was closed (a phone uploading an older copy changes nothing); a session keeps its table
CREATE OR REPLACE FUNCTION public.hangtag_session_check()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
    IF OLD.status = 'closed' THEN RETURN OLD; END IF;
    IF NEW.table_id <> OLD.table_id THEN RAISE EXCEPTION 'A table session keeps its table.' USING ERRCODE = 'check_violation'; END IF;
    NEW.user_id := OLD.user_id;
    RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS hangtag_session_check ON public.hangtag_table_sessions;
CREATE TRIGGER hangtag_session_check BEFORE UPDATE ON public.hangtag_table_sessions FOR EACH ROW EXECUTE FUNCTION public.hangtag_session_check();
-- the orders of a table's session are found by it
CREATE INDEX IF NOT EXISTS idx_hangtag_orders_session ON public.hangtag_orders (owner_id, session_id) WHERE session_id IS NOT NULL;

-- (b) Bills of a table: the table and session they were for
ALTER TABLE public.hangtag_sales ADD COLUMN IF NOT EXISTS table_id TEXT;
ALTER TABLE public.hangtag_sales ADD COLUMN IF NOT EXISTS session_id TEXT;
CREATE INDEX IF NOT EXISTS idx_hangtag_sales_session ON public.hangtag_sales (owner_id, session_id) WHERE session_id IS NOT NULL;
-- Saving bills (as section 3n) now keeps the table and session of a table's bill
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
            cgst_amount, sgst_amount, igst_amount, line_total, hsn, serials, batches)
        SELECT s.id, i.line_no, i.product_id, i.product_name, COALESCE(i.size, ''), COALESCE(i.quantity, 1), COALESCE(i.unit_price, 0),
            i.variant_id, COALESCE(i.color, ''), i.sku, i.cost_price, i.variant_label, i.options, i.discount_type, i.discount_value,
            COALESCE(i.discount_amount, 0), COALESCE(i.bill_discount_share, 0), i.taxable_value, i.gst_rate, COALESCE(i.cgst_amount, 0),
            COALESCE(i.sgst_amount, 0), COALESCE(i.igst_amount, 0), i.line_total, i.hsn, i.serials, i.batches
        FROM jsonb_populate_recordset(NULL::public.hangtag_sale_items, COALESCE(b -> 'items', '[]'::jsonb)) i
        ON CONFLICT (owner_id, sale_id, line_no) DO UPDATE SET product_id = EXCLUDED.product_id, product_name = EXCLUDED.product_name,
            size = EXCLUDED.size, quantity = EXCLUDED.quantity, unit_price = EXCLUDED.unit_price, variant_id = EXCLUDED.variant_id,
            color = EXCLUDED.color, sku = EXCLUDED.sku, cost_price = EXCLUDED.cost_price, variant_label = EXCLUDED.variant_label,
            options = EXCLUDED.options, discount_type = EXCLUDED.discount_type, discount_value = EXCLUDED.discount_value,
            discount_amount = EXCLUDED.discount_amount, bill_discount_share = EXCLUDED.bill_discount_share, taxable_value = EXCLUDED.taxable_value,
            gst_rate = EXCLUDED.gst_rate, cgst_amount = EXCLUDED.cgst_amount, sgst_amount = EXCLUDED.sgst_amount,
            igst_amount = EXCLUDED.igst_amount, line_total = EXCLUDED.line_total, hsn = EXCLUDED.hsn, serials = EXCLUDED.serials, batches = EXCLUDED.batches;
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
            -- a payment the provider verified (section 3h) stays verified when the phone uploads the bill again
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

-- (c) Is a capability on for a shop? The business type's defaults (domain/shop/capabilities.js DEFAULT_CAPS: the restaurant
--     ones are on for a hotel / restaurant) with the shop's own choices (hangtag_meta 'settings' value.caps), and one that
--     builds on another is off while that one is (Table QR needs Table ordering; guests ordering needs Table QR; server
--     ordering needs Table ordering). Only the restaurant capabilities are known here (the database checks only those).
CREATE OR REPLACE FUNCTION public.hangtag_cap_on(p_owner UUID, p_cap TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    kind TEXT;
    caps JSONB;
    v BOOLEAN;
    need TEXT;
BEGIN
    SELECT CASE WHEN lower(btrim(COALESCE(business_type, ''))) = 'restaurant' OR lower(COALESCE(business_type, '')) ~ '(restaurant|hotel|cafe|café|food)'
                THEN 'restaurant' ELSE 'other' END INTO kind
      FROM public.hangtag_profiles WHERE id = p_owner;
    SELECT m.value -> 'caps' INTO caps FROM public.hangtag_meta m WHERE m.owner_id = p_owner AND m.key = 'settings';
    IF caps IS NOT NULL AND jsonb_typeof(caps) = 'object' AND jsonb_typeof(caps -> p_cap) = 'boolean' THEN v := (caps ->> p_cap)::BOOLEAN;
    ELSE v := COALESCE(kind, 'other') = 'restaurant' AND p_cap IN ('uses_tables','uses_table_qr','uses_customer_ordering','uses_server_ordering','uses_kitchen');
    END IF;
    need := CASE p_cap WHEN 'uses_table_qr' THEN 'uses_tables' WHEN 'uses_customer_ordering' THEN 'uses_table_qr' WHEN 'uses_server_ordering' THEN 'uses_tables' END;
    IF v AND need IS NOT NULL THEN v := public.hangtag_cap_on(p_owner, need); END IF;
    RETURN COALESCE(v, FALSE);
END $$;

-- (d) The kitchen moves a table order along (or a server marks it served, or it is cancelled). Forward only: new →
--     accepted → preparing → ready → served (a step may be skipped); any step not yet served can be cancelled. A step the
--     order already passed (another screen was quicker) changes nothing. Kitchen steps need manage_kitchen or create_order;
--     served and cancelled also send_to_kitchen. → { status, version }
CREATE OR REPLACE FUNCTION public.hangtag_order_status(p_id TEXT, p_status TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    uid UUID := public.hangtag_shop_id();
    o public.hangtag_orders;
    flow CONSTANT TEXT[] := ARRAY['new','accepted','preparing','ready','served'];
    a INT;
    b INT;
    ver INT;
BEGIN
    IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Sign in to change orders.' USING ERRCODE = '42501'; END IF;
    IF uid IS NULL OR NOT (public.hangtag_can('manage_kitchen') OR public.hangtag_can('create_order') OR public.hangtag_can('send_to_kitchen')) THEN
        RAISE EXCEPTION 'Not allowed to change table orders.' USING ERRCODE = '42501';
    END IF;
    IF p_status IN ('accepted','preparing','ready') AND NOT (public.hangtag_can('manage_kitchen') OR public.hangtag_can('create_order')) THEN
        RAISE EXCEPTION 'Not allowed to move orders in the kitchen.' USING ERRCODE = '42501';
    END IF;
    IF p_status IS NULL OR NOT (p_status = ANY (flow) OR p_status = 'cancelled') THEN RAISE EXCEPTION 'Unknown step: %', p_status USING ERRCODE = '22023'; END IF;
    SELECT * INTO o FROM public.hangtag_orders WHERE owner_id = uid AND id = p_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'That order isn''t in the cloud yet.' USING ERRCODE = '23503'; END IF;
    IF o.kind <> 'table' THEN RAISE EXCEPTION 'Only table orders go through the kitchen.' USING ERRCODE = 'check_violation'; END IF;
    a := array_position(flow, o.status); b := array_position(flow, p_status);
    IF o.status = p_status OR o.status IN ('served','cancelled') OR (p_status <> 'cancelled' AND (a IS NULL OR b <= a)) THEN
        RETURN jsonb_build_object('status', o.status, 'version', o.version, 'changed', false);
    END IF;
    UPDATE public.hangtag_orders SET status = p_status, version = version + 1, updated_t = (extract(epoch FROM now()) * 1000)::BIGINT, updated_at = NOW()
     WHERE owner_id = uid AND id = p_id RETURNING version INTO ver;
    RETURN jsonb_build_object('status', p_status, 'version', ver, 'changed', true);
END $$;

-- (e) Guests ordering from the table's QR code (no sign-in: the token is the table). The menu: what is on sale, with its
--     options and price — nothing about stock, costs, suppliers, staff or money. → { ok, shop, table, ordering, items, categories }
CREATE OR REPLACE FUNCTION public.hangtag_table_menu(p_token TEXT)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    tb public.hangtag_tables;
    shop TEXT;
    items JSONB;
    cats JSONB;
BEGIN
    IF p_token IS NULL OR p_token !~ '^[A-Za-z0-9_-]{32,64}$' THEN
        RETURN jsonb_build_object('ok', false, 'message', 'This table''s QR code isn''t valid. Please ask the staff.');
    END IF;
    SELECT * INTO tb FROM public.hangtag_tables WHERE qr_token = p_token AND active;
    IF NOT FOUND OR NOT public.hangtag_cap_on(tb.owner_id, 'uses_table_qr') THEN
        RETURN jsonb_build_object('ok', false, 'message', 'This QR code isn''t in use any more. Please ask the staff.');
    END IF;
    SELECT shop_name INTO shop FROM public.hangtag_profiles WHERE id = tb.owner_id;
    SELECT COALESCE(jsonb_agg(x.j ORDER BY x.o), '[]'::jsonb) INTO items FROM (
        SELECT jsonb_build_object('v', v.id, 'name', p.name,
                   'vl', (SELECT string_agg(e.x, ' / ' ORDER BY e.o) FROM jsonb_array_elements_text(v.option_values) WITH ORDINALITY AS e(x, o)),
                   'price', COALESCE(v.price, p.price), 'cat', NULLIF(btrim(COALESCE(p.category, '')), '')) AS j,
               row_number() OVER (ORDER BY lower(COALESCE(p.category, 'zzz')), p.sort_order, lower(p.name), v.sort_order, v.id) AS o
          FROM public.hangtag_products p JOIN public.hangtag_variants v ON v.owner_id = p.owner_id AND v.product_id = p.id
         WHERE p.owner_id = tb.owner_id AND NOT p.archived AND v.active
         LIMIT 1000) x;
    SELECT COALESCE(jsonb_agg(c ORDER BY lower(c)), '[]'::jsonb) INTO cats FROM (
        SELECT DISTINCT btrim(p.category) AS c FROM public.hangtag_products p WHERE p.owner_id = tb.owner_id AND NOT p.archived AND btrim(COALESCE(p.category, '')) <> '') z;
    RETURN jsonb_build_object('ok', true, 'shop', COALESCE(NULLIF(btrim(shop), ''), 'Menu'), 'table', tb.name,
        'ordering', public.hangtag_cap_on(tb.owner_id, 'uses_customer_ordering'), 'items', items, 'categories', cats);
END $$;
-- A guest's order: items [{ v (a variant on sale), q (1-50), note? }], priced from the catalog (never from the phone);
-- it joins the table's session (a new one when nobody is seated). → { ok, order_no, table } or { ok: false, message }
CREATE OR REPLACE FUNCTION public.hangtag_place_table_order(p_token TEXT, p_items JSONB, p_note TEXT DEFAULT NULL, p_name TEXT DEFAULT NULL, p_phone TEXT DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    tb public.hangtag_tables;
    sid TEXT;
    oid TEXT := 'oq' || substr(md5(random()::text || clock_timestamp()::text), 1, 24);
    now_ms BIGINT := (extract(epoch FROM now()) * 1000)::BIGINT;
    it JSONB;
    q NUMERIC;
    vr RECORD;
    ln INT := 0;
    n INT;
    no TEXT;
    nm TEXT := left(btrim(regexp_replace(COALESCE(p_name, ''), '[[:cntrl:]]', ' ', 'g')), 60);
    ph TEXT := left(regexp_replace(COALESCE(p_phone, ''), '[^0-9+]', '', 'g'), 15);
BEGIN
    IF p_token IS NULL OR p_token !~ '^[A-Za-z0-9_-]{32,64}$' THEN
        RETURN jsonb_build_object('ok', false, 'message', 'This table''s QR code isn''t valid. Please ask the staff.');
    END IF;
    -- Serialize guest orders for this table. The lock covers throttling and session selection, so concurrent scans
    -- cannot bypass the per-table rate limit or open duplicate QR sessions.
    SELECT * INTO tb FROM public.hangtag_tables WHERE qr_token = p_token AND active FOR UPDATE;
    IF NOT FOUND OR NOT public.hangtag_cap_on(tb.owner_id, 'uses_customer_ordering') THEN
        RETURN jsonb_build_object('ok', false, 'message', 'Ordering from your phone isn''t available here. Please order with the staff.');
    END IF;
    IF jsonb_typeof(COALESCE(p_items, 'null'::jsonb)) <> 'array' OR jsonb_array_length(p_items) NOT BETWEEN 1 AND 50 THEN
        RETURN jsonb_build_object('ok', false, 'message', 'Add from 1 to 50 items to your order.');
    END IF;
    IF EXISTS (
        SELECT 1 FROM jsonb_array_elements(p_items) AS x(item)
         GROUP BY x.item ->> 'v'
        HAVING count(*) > 1
    ) THEN
        RETURN jsonb_build_object('ok', false, 'message', 'Choose each menu item only once.');
    END IF;
    IF (SELECT count(*) FROM public.hangtag_orders o WHERE o.owner_id = tb.owner_id AND o.table_id = tb.id AND o.source = 'customer' AND o.created_at > NOW() - interval '10 minutes') >= 10 THEN
        RETURN jsonb_build_object('ok', false, 'message', 'Many orders came from this table just now. Please ask the staff.');
    END IF;
    -- Once staff start billing, the bill's line snapshot is already fixed. A new guest order must not be attached to that
    -- session (or be closed by its sale without being charged).
    IF EXISTS (SELECT 1 FROM public.hangtag_table_sessions s WHERE s.owner_id = tb.owner_id AND s.table_id = tb.id AND s.status = 'billing') THEN
        RETURN jsonb_build_object('ok', false, 'message', 'This table is being billed. Please ask the staff.');
    END IF;
    SELECT s.id INTO sid FROM public.hangtag_table_sessions s WHERE s.owner_id = tb.owner_id AND s.table_id = tb.id AND s.status = 'open' ORDER BY s.opened_t LIMIT 1;
    IF sid IS NULL THEN
        sid := 'tsq' || substr(md5(random()::text || clock_timestamp()::text), 1, 24);
        INSERT INTO public.hangtag_table_sessions (owner_id, id, table_id, status, opened_t, device_id) VALUES (tb.owner_id, sid, tb.id, 'open', now_ms, 'qr');
    END IF;
    SELECT count(*) + 1 INTO n FROM public.hangtag_orders o WHERE o.owner_id = tb.owner_id AND o.source = 'customer' AND o.created_at >= date_trunc('day', NOW());
    no := 'QR-' || to_char(NOW() AT TIME ZONE 'Asia/Kolkata', 'YYMMDD') || '-' || lpad(n::text, 3, '0');
    INSERT INTO public.hangtag_orders (owner_id, id, kind, no, status, customer, notes, table_id, session_id, source, version, t, updated_t, device_id, user_id)
    VALUES (tb.owner_id, oid, 'table', no, 'new', CASE WHEN nm <> '' OR ph <> '' THEN jsonb_build_object('name', nm, 'phone', ph) END,
            NULLIF(left(btrim(regexp_replace(COALESCE(p_note, ''), '[[:cntrl:]]', ' ', 'g')), 200), ''), tb.id, sid, 'customer', 1, now_ms, now_ms, 'qr', NULL);
    FOR it IN SELECT x FROM jsonb_array_elements(p_items) x LOOP
        q := CASE WHEN jsonb_typeof(it -> 'q') = 'number' THEN (it ->> 'q')::NUMERIC END;
        IF q IS NULL OR q <= 0 OR q > 50 OR q <> round(q, 3) THEN RAISE EXCEPTION 'Choose from 1 to 50 of each item.' USING ERRCODE = 'check_violation'; END IF;
        q := round(q, 3);
        SELECT v.id, v.product_id, p.name, COALESCE(v.price, p.price) AS price, p.gst_rate,
               (SELECT string_agg(e.x, ' / ' ORDER BY e.o) FROM jsonb_array_elements_text(v.option_values) WITH ORDINALITY AS e(x, o)) AS vl
          INTO vr FROM public.hangtag_variants v JOIN public.hangtag_products p ON p.owner_id = v.owner_id AND p.id = v.product_id
         WHERE v.owner_id = tb.owner_id AND v.id = it ->> 'v' AND v.active AND NOT p.archived;
        IF NOT FOUND THEN RAISE EXCEPTION 'An item on your order isn''t available any more. Please look at the menu again.' USING ERRCODE = 'check_violation'; END IF;
        INSERT INTO public.hangtag_order_items (owner_id, order_id, line_no, product_id, variant_id, name, variant_label, qty, price, gst_rate, note)
        VALUES (tb.owner_id, oid, ln, vr.product_id, vr.id, vr.name, vr.vl, q, vr.price, vr.gst_rate,
                NULLIF(left(btrim(regexp_replace(COALESCE(it ->> 'note', ''), '[[:cntrl:]]', ' ', 'g')), 120), ''));
        ln := ln + 1;
    END LOOP;
    RETURN jsonb_build_object('ok', true, 'order_no', no, 'table', tb.name);
END $$;

-- (f) What changed in credit, held carts, orders and now tables (a team member's phone polls it: section 3i (h))
CREATE OR REPLACE FUNCTION public.hangtag_order_changes()
RETURNS JSONB LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
    SELECT jsonb_build_object(
        'orders', (SELECT count(*) || ':' || COALESCE(sum(hashtext(o.id || '|' || o.version::text || '|' || o.status)), 0) FROM public.hangtag_orders o),
        'held', (SELECT count(*) || ':' || COALESCE(sum(hashtext(h.id || '|' || h.t::text)), 0) FROM public.hangtag_held_carts h),
        'credit', (SELECT count(*) || ':' || COALESCE(sum(hashtext(c.id || '|' || c.status)), 0) FROM public.hangtag_collections c),
        'tables', (SELECT count(*) || ':' || COALESCE(sum(hashtext(t.id || '|' || t.updated_at::text)), 0) FROM public.hangtag_tables t)
                || '/' || (SELECT count(*) || ':' || COALESCE(sum(hashtext(s.id || '|' || s.status)), 0) FROM public.hangtag_table_sessions s WHERE s.status <> 'closed'))
$$;

-- (g) Audit (section 3i (e)): tables added, changed or removed; sessions opened and closed
DROP TRIGGER IF EXISTS hangtag_audit ON public.hangtag_tables;
CREATE TRIGGER hangtag_audit AFTER INSERT OR DELETE ON public.hangtag_tables FOR EACH ROW EXECUTE FUNCTION public.hangtag_audit();
DROP TRIGGER IF EXISTS hangtag_audit_change ON public.hangtag_tables;
CREATE TRIGGER hangtag_audit_change AFTER UPDATE ON public.hangtag_tables FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION public.hangtag_audit();
DROP TRIGGER IF EXISTS hangtag_audit_change ON public.hangtag_table_sessions;
CREATE TRIGGER hangtag_audit_change AFTER UPDATE OF status ON public.hangtag_table_sessions FOR EACH ROW
    WHEN (OLD.status IS DISTINCT FROM NEW.status) EXECUTE FUNCTION public.hangtag_audit();

-- (h) Who may use them (row security: section 5): the shop reads its tables and sessions; tables are set up with
--     manage_settings; sessions are opened and closed by whoever seats guests, takes orders or bills. Signed-out visitors
--     reach only the two guest functions.
REVOKE ALL ON TABLE public.hangtag_tables, public.hangtag_table_sessions FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.hangtag_tables, public.hangtag_table_sessions TO authenticated;
REVOKE ALL ON FUNCTION public.hangtag_order_status(TEXT, TEXT), public.hangtag_order_changes() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.hangtag_order_status(TEXT, TEXT), public.hangtag_order_changes() TO authenticated;
REVOKE ALL ON FUNCTION public.hangtag_table_menu(TEXT), public.hangtag_place_table_order(TEXT, JSONB, TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.hangtag_table_menu(TEXT), public.hangtag_place_table_order(TEXT, JSONB, TEXT, TEXT, TEXT) TO anon, authenticated;
REVOKE ALL ON FUNCTION public.hangtag_cap_on(UUID, TEXT), public.hangtag_session_check() FROM PUBLIC, anon, authenticated;
DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['hangtag_tables','hangtag_table_sessions'] LOOP
        BEGIN
            EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
        EXCEPTION WHEN OTHERS THEN
            NULL; -- already added (or realtime not available)
        END;
    END LOOP;
END $$;

-- ------------------------------------------------------------------------------
-- 3p. Wave 3 completion: commercial documents and supplier-bill originals
-- ------------------------------------------------------------------------------
-- Additive and rerunnable. Quotations and sales orders keep their commercial snapshots; imports still add stock only
-- through ledger moves; table bills still use the existing billing engine.

-- (a) Capabilities in database entry points. These are the same business defaults and dependencies as the client.
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
        ELSE FALSE END;
    END IF;
    need := CASE p_cap WHEN 'uses_mobile_store' THEN 'uses_sales_orders'
        WHEN 'uses_table_qr' THEN 'uses_tables' WHEN 'uses_customer_ordering' THEN 'uses_table_qr'
        WHEN 'uses_server_ordering' THEN 'uses_tables' WHEN 'uses_kitchen' THEN 'uses_tables' END;
    IF v AND need IS NOT NULL THEN v := public.hangtag_cap_on(p_owner, need); END IF;
    RETURN COALESCE(v, FALSE);
END $$;

-- (b) Quotations and sales orders: terms, their source quotation, and the agreed unit on every line.
ALTER TABLE public.hangtag_orders ADD COLUMN IF NOT EXISTS terms TEXT;
ALTER TABLE public.hangtag_orders ADD COLUMN IF NOT EXISTS quote_id TEXT;
ALTER TABLE public.hangtag_orders ADD COLUMN IF NOT EXISTS quote_no TEXT;
ALTER TABLE public.hangtag_orders DROP CONSTRAINT IF EXISTS hangtag_orders_terms_check;
ALTER TABLE public.hangtag_orders ADD CONSTRAINT hangtag_orders_terms_check CHECK (terms IS NULL OR char_length(terms) <= 2000) NOT VALID;
ALTER TABLE public.hangtag_orders DROP CONSTRAINT IF EXISTS hangtag_orders_quote_check;
ALTER TABLE public.hangtag_orders ADD CONSTRAINT hangtag_orders_quote_check CHECK ((quote_id IS NULL AND quote_no IS NULL) OR kind = 'sales') NOT VALID;
ALTER TABLE public.hangtag_order_items ADD COLUMN IF NOT EXISTS unit TEXT NOT NULL DEFAULT 'pcs';
-- the order's total as the app's one bill calculation gave it (what a quotation sent to a customer says it comes to)
ALTER TABLE public.hangtag_orders ADD COLUMN IF NOT EXISTS total NUMERIC(12,2);
ALTER TABLE public.hangtag_orders DROP CONSTRAINT IF EXISTS hangtag_orders_total_check;
ALTER TABLE public.hangtag_orders ADD CONSTRAINT hangtag_orders_total_check CHECK (total IS NULL OR total >= 0) NOT VALID;
UPDATE public.hangtag_order_items SET unit = 'pcs' WHERE unit IS NULL;
ALTER TABLE public.hangtag_order_items DROP CONSTRAINT IF EXISTS hangtag_order_items_unit_check;
ALTER TABLE public.hangtag_order_items ADD CONSTRAINT hangtag_order_items_unit_check CHECK (unit IN ('pcs','box','pack','dozen','kg','g','l','ml','m')) NOT VALID;

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
        WHERE i.qty <= 0 OR (i.unit IN ('pcs','box','pack','dozen','g','ml') AND i.qty <> trunc(i.qty))
           OR (i.unit = 'm' AND i.qty <> round(i.qty, 2)) OR (i.unit IN ('kg','l') AND i.qty <> round(i.qty, 3))) THEN
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

-- (c) A supplier bill's original is private and belongs to the same shop folder as its import record.
ALTER TABLE public.hangtag_stock_imports ADD COLUMN IF NOT EXISTS document_path TEXT;
ALTER TABLE public.hangtag_stock_imports DROP CONSTRAINT IF EXISTS hangtag_stock_imports_document_check;
ALTER TABLE public.hangtag_stock_imports ADD CONSTRAINT hangtag_stock_imports_document_check CHECK (document_path IS NULL OR
    (char_length(document_path) BETWEEN 38 AND 300 AND split_part(document_path, '/', 1) = owner_id::TEXT)) NOT VALID;

-- A saved purchase may acquire its original after a temporarily failed Storage upload. It cannot then be replaced.
CREATE OR REPLACE FUNCTION public.hangtag_purchase_check()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD.kind = 'purchase' AND EXISTS (SELECT 1 FROM auth.users u WHERE u.id = OLD.owner_id) THEN RAISE EXCEPTION 'A purchase can''t be removed. Cancel it instead.' USING ERRCODE = '42501'; END IF;
        RETURN OLD;
    END IF;
    IF TG_OP = 'INSERT' THEN
        IF NEW.kind = 'purchase' THEN
            IF auth.uid() IS NOT NULL THEN NEW.user_id := auth.uid(); END IF;
            IF NEW.status <> 'posted' THEN RAISE EXCEPTION 'A new purchase is saved as posted.' USING ERRCODE = 'check_violation'; END IF;
        END IF;
        RETURN NEW;
    END IF;
    IF OLD.kind = 'purchase' OR NEW.kind = 'purchase' THEN
        IF (to_jsonb(NEW)-'status'-'cancel_reason'-'cancelled_at'-'document_path') IS DISTINCT FROM (to_jsonb(OLD)-'status'-'cancel_reason'-'cancelled_at'-'document_path') THEN
            RAISE EXCEPTION 'A saved purchase can''t be changed. Cancel it and enter it again.' USING ERRCODE = '42501';
        END IF;
        IF OLD.document_path IS NOT NULL AND NEW.document_path IS DISTINCT FROM OLD.document_path THEN RAISE EXCEPTION 'A purchase''s original document can''t be replaced.' USING ERRCODE = '42501'; END IF;
        IF (NEW.status,NEW.cancel_reason,NEW.cancelled_at) IS DISTINCT FROM (OLD.status,OLD.cancel_reason,OLD.cancelled_at)
           AND (OLD.status <> 'posted' OR COALESCE(current_setting('hangtag.cancel_purchase',true),'') <> OLD.id) THEN
            RAISE EXCEPTION 'A purchase is cancelled only with Cancel purchase (it takes its stock back), and only once.' USING ERRCODE = '42501';
        END IF;
    END IF;
    RETURN NEW;
END $$;

-- Products/variants, tracked ledger moves, the purchase record and document link are one transaction. Section 3n's
-- triggers remain the source of truth for serial and batch availability.
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
        dp:=CASE u WHEN 'kg' THEN 3 WHEN 'l' THEN 3 WHEN 'm' THEN 2 ELSE 0 END;
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

-- Private Storage is installed by Supabase, not by local PGlite. Dynamic SQL keeps the same schema runnable in both.
DO $$
BEGIN
    IF to_regclass('storage.buckets') IS NOT NULL AND to_regclass('storage.objects') IS NOT NULL THEN
        EXECUTE $sql$INSERT INTO storage.buckets (id,name,public,file_size_limit,allowed_mime_types) VALUES
            ('hangtag-bills','hangtag-bills',FALSE,15728640,ARRAY['application/pdf','image/jpeg','image/png','image/webp','image/heic'])
            ON CONFLICT (id) DO UPDATE SET public=FALSE,file_size_limit=EXCLUDED.file_size_limit,allowed_mime_types=EXCLUDED.allowed_mime_types$sql$;
        EXECUTE 'DROP POLICY IF EXISTS "hangtag bills read" ON storage.objects';
        EXECUTE 'DROP POLICY IF EXISTS "hangtag bills add" ON storage.objects';
        EXECUTE 'DROP POLICY IF EXISTS "hangtag bills change" ON storage.objects';
        EXECUTE $sql$CREATE POLICY "hangtag bills read" ON storage.objects FOR SELECT TO authenticated USING
            (bucket_id='hangtag-bills' AND split_part(name,'/',1)=public.hangtag_shop_id()::text AND (public.hangtag_can('create_purchase') OR public.hangtag_can('manage_inventory') OR public.hangtag_can('view_reports')))$sql$;
        EXECUTE $sql$CREATE POLICY "hangtag bills add" ON storage.objects FOR INSERT TO authenticated WITH CHECK
            (bucket_id='hangtag-bills' AND split_part(name,'/',1)=public.hangtag_shop_id()::text AND public.hangtag_can('create_purchase'))$sql$;
        EXECUTE $sql$CREATE POLICY "hangtag bills change" ON storage.objects FOR UPDATE TO authenticated USING
            (bucket_id='hangtag-bills' AND split_part(name,'/',1)=public.hangtag_shop_id()::text AND public.hangtag_can('create_purchase')) WITH CHECK
            (bucket_id='hangtag-bills' AND split_part(name,'/',1)=public.hangtag_shop_id()::text AND public.hangtag_can('create_purchase'))$sql$;
    END IF;
END $$;

-- (d) A completed table bill closes every live session at that table and retires its kitchen tickets in the same database
-- transaction as the bill. A cashier needs only create_sale; this is a consequence of the bill, not a second action.
CREATE OR REPLACE FUNCTION public.hangtag_close_table_sale()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE now_ms BIGINT := (extract(epoch FROM now())*1000)::BIGINT;
BEGIN
    IF NEW.table_id IS NULL THEN RETURN NULL; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.hangtag_tables t WHERE t.owner_id=NEW.owner_id AND t.id=NEW.table_id) THEN RAISE EXCEPTION 'That table does not belong to this shop.' USING ERRCODE='foreign_key_violation'; END IF;
    IF NEW.session_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.hangtag_table_sessions s WHERE s.owner_id=NEW.owner_id AND s.id=NEW.session_id AND s.table_id=NEW.table_id) THEN
        RAISE EXCEPTION 'That table session does not belong to this table.' USING ERRCODE='foreign_key_violation';
    END IF;
    UPDATE public.hangtag_table_sessions SET status='closed',closed_t=COALESCE(closed_t,now_ms),sale_id=COALESCE(sale_id,NEW.id),updated_at=NOW()
     WHERE owner_id=NEW.owner_id AND table_id=NEW.table_id AND status<>'closed';
    UPDATE public.hangtag_orders o SET status='served',version=version+1,updated_t=now_ms,updated_at=NOW()
     WHERE o.owner_id=NEW.owner_id AND o.kind='table' AND o.status NOT IN ('served','cancelled')
       AND EXISTS (SELECT 1 FROM public.hangtag_table_sessions s WHERE s.owner_id=o.owner_id AND s.id=o.session_id AND s.sale_id=NEW.id);
    RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS hangtag_close_table_sale ON public.hangtag_sales;
CREATE TRIGGER hangtag_close_table_sale AFTER INSERT OR UPDATE OF table_id,session_id ON public.hangtag_sales
    FOR EACH ROW WHEN (NEW.table_id IS NOT NULL) EXECUTE FUNCTION public.hangtag_close_table_sale();

CREATE OR REPLACE FUNCTION public.hangtag_order_status(p_id TEXT,p_status TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE uid UUID:=public.hangtag_shop_id(); o public.hangtag_orders; flow CONSTANT TEXT[]:=ARRAY['new','accepted','preparing','ready','served']; a INT; b INT; ver INT;
BEGIN
    IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Sign in to change orders.' USING ERRCODE='42501'; END IF;
    IF uid IS NULL OR NOT public.hangtag_cap_on(uid,'uses_tables') THEN RAISE EXCEPTION 'Table ordering is switched off for this shop.' USING ERRCODE='42501'; END IF;
    IF NOT (public.hangtag_can('manage_kitchen') OR public.hangtag_can('create_order') OR public.hangtag_can('send_to_kitchen')) THEN RAISE EXCEPTION 'Not allowed to change table orders.' USING ERRCODE='42501'; END IF;
    IF p_status IN ('accepted','preparing','ready') AND (NOT public.hangtag_cap_on(uid,'uses_kitchen') OR NOT (public.hangtag_can('manage_kitchen') OR public.hangtag_can('create_order'))) THEN
        RAISE EXCEPTION 'The kitchen is switched off or unavailable for this role.' USING ERRCODE='42501';
    END IF;
    IF p_status IS NULL OR NOT (p_status=ANY(flow) OR p_status='cancelled') THEN RAISE EXCEPTION 'Unknown step: %',p_status USING ERRCODE='22023'; END IF;
    SELECT * INTO o FROM public.hangtag_orders WHERE owner_id=uid AND id=p_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'That order isn''t in the cloud yet.' USING ERRCODE='23503'; END IF;
    IF o.kind<>'table' THEN RAISE EXCEPTION 'Only table orders go through the kitchen.' USING ERRCODE='check_violation'; END IF;
    a:=array_position(flow,o.status); b:=array_position(flow,p_status);
    IF o.status=p_status OR o.status IN ('served','cancelled') OR (p_status<>'cancelled' AND (a IS NULL OR b<=a)) THEN RETURN jsonb_build_object('status',o.status,'version',o.version,'changed',FALSE); END IF;
    UPDATE public.hangtag_orders SET status=p_status,version=version+1,updated_t=(extract(epoch FROM now())*1000)::BIGINT,updated_at=NOW()
     WHERE owner_id=uid AND id=p_id RETURNING version INTO ver;
    RETURN jsonb_build_object('status',p_status,'version',ver,'changed',TRUE);
END $$;
REVOKE ALL ON FUNCTION public.hangtag_cap_on(UUID,TEXT),public.hangtag_close_table_sale() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.hangtag_cap_on(UUID,TEXT) TO authenticated;
REVOKE ALL ON FUNCTION public.hangtag_order_status(TEXT,TEXT) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.hangtag_order_status(TEXT,TEXT) TO authenticated;

-- (e) Quotations sent to their customer by email or WhatsApp (Edge Function send-receipt, the same providers and log as
--     bills): a delivery row is for one bill OR one order. request_id is made by the phone for one press of Send and is
--     used once per shop, so a retry, a queued send going out twice or a second tap never sends the quotation twice.
--     Rows are still written only by the function; the shop reads them (row security: section 5).
ALTER TABLE public.hangtag_deliveries ADD COLUMN IF NOT EXISTS order_id TEXT;
ALTER TABLE public.hangtag_deliveries ADD COLUMN IF NOT EXISTS request_id TEXT;
ALTER TABLE public.hangtag_deliveries DROP CONSTRAINT IF EXISTS hangtag_deliveries_order_fkey;
ALTER TABLE public.hangtag_deliveries ADD CONSTRAINT hangtag_deliveries_order_fkey FOREIGN KEY (owner_id, order_id)
    REFERENCES public.hangtag_orders (owner_id, id) ON DELETE SET NULL (order_id);
ALTER TABLE public.hangtag_deliveries DROP CONSTRAINT IF EXISTS hangtag_deliveries_target_check;
ALTER TABLE public.hangtag_deliveries ADD CONSTRAINT hangtag_deliveries_target_check CHECK (sale_id IS NULL OR order_id IS NULL) NOT VALID;
ALTER TABLE public.hangtag_deliveries DROP CONSTRAINT IF EXISTS hangtag_deliveries_request_check;
ALTER TABLE public.hangtag_deliveries ADD CONSTRAINT hangtag_deliveries_request_check CHECK (request_id IS NULL OR request_id ~ '^[A-Za-z0-9_-]{8,64}$') NOT VALID;
CREATE UNIQUE INDEX IF NOT EXISTS uq_hangtag_deliveries_request ON public.hangtag_deliveries (owner_id, request_id) WHERE request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_hangtag_deliveries_order ON public.hangtag_deliveries (owner_id, order_id, created_at DESC) WHERE order_id IS NOT NULL;

-- ------------------------------------------------------------------------------
-- 3q. Mobile store and assisted customer cart
-- ------------------------------------------------------------------------------
-- One public interface over the existing catalog, stock ledger, customers, sales orders and billing. A shop explicitly
-- switches on uses_mobile_store. Its opaque store token reveals only the deliberately small catalog RPC; every order is
-- an ordinary confirmed sales order (source customer), and staff fulfil and bill it through the existing Orders screen.

-- (a) A stable, opaque shop link. It is not an account id or credential and can be replaced manually if a link must be
-- retired. Row security still keeps profiles private; only the catalog/order RPCs accept this token.
ALTER TABLE public.hangtag_profiles ADD COLUMN IF NOT EXISTS store_token TEXT;
UPDATE public.hangtag_profiles SET store_token = 'st_' || replace(gen_random_uuid()::TEXT, '-', '') WHERE store_token IS NULL;
ALTER TABLE public.hangtag_profiles ALTER COLUMN store_token SET DEFAULT ('st_' || replace(gen_random_uuid()::TEXT, '-', ''));
ALTER TABLE public.hangtag_profiles ALTER COLUMN store_token SET NOT NULL;
ALTER TABLE public.hangtag_profiles DROP CONSTRAINT IF EXISTS hangtag_profiles_store_token_check;
ALTER TABLE public.hangtag_profiles ADD CONSTRAINT hangtag_profiles_store_token_check CHECK (store_token ~ '^st_[A-Za-z0-9_-]{32,61}$') NOT VALID;
CREATE UNIQUE INDEX IF NOT EXISTS uq_hangtag_profiles_store_token ON public.hangtag_profiles (store_token);

-- A mobile order has two unrelated secrets: checkout_key makes one customer's retry idempotent; public_token lets that
-- customer read only the safe status of this order. Neither is used by staff or becomes a second order identifier.
ALTER TABLE public.hangtag_orders ADD COLUMN IF NOT EXISTS public_token TEXT;
ALTER TABLE public.hangtag_orders ADD COLUMN IF NOT EXISTS checkout_key TEXT;
ALTER TABLE public.hangtag_orders ADD COLUMN IF NOT EXISTS checkout_mode TEXT;
ALTER TABLE public.hangtag_orders ADD COLUMN IF NOT EXISTS payment_preference TEXT;
ALTER TABLE public.hangtag_orders DROP CONSTRAINT IF EXISTS hangtag_orders_public_token_check;
ALTER TABLE public.hangtag_orders ADD CONSTRAINT hangtag_orders_public_token_check CHECK (public_token IS NULL OR
    (public_token ~ '^mo_[A-Za-z0-9_-]{32,61}$' AND checkout_key ~ '^[A-Za-z0-9_-]{24,64}$' AND kind = 'sales' AND source = 'customer')) NOT VALID;
ALTER TABLE public.hangtag_orders DROP CONSTRAINT IF EXISTS hangtag_orders_checkout_mode_check;
ALTER TABLE public.hangtag_orders ADD CONSTRAINT hangtag_orders_checkout_mode_check CHECK (checkout_mode IS NULL OR checkout_mode IN ('store','assisted')) NOT VALID;
ALTER TABLE public.hangtag_orders DROP CONSTRAINT IF EXISTS hangtag_orders_payment_preference_check;
ALTER TABLE public.hangtag_orders ADD CONSTRAINT hangtag_orders_payment_preference_check CHECK (payment_preference IS NULL OR payment_preference IN ('counter','cash','upi')) NOT VALID;
CREATE UNIQUE INDEX IF NOT EXISTS uq_hangtag_orders_public_token ON public.hangtag_orders (public_token) WHERE public_token IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_hangtag_orders_checkout ON public.hangtag_orders (owner_id, checkout_key) WHERE checkout_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_hangtag_order_items_variant ON public.hangtag_order_items (owner_id, variant_id) WHERE variant_id IS NOT NULL;

-- Outstanding mobile-order quantity. Quantities billed against that order cease to be reservations because the bill has
-- removed them from on-hand stock. This helper also lets the till guard stay dormant when there is no customer reservation.
CREATE OR REPLACE FUNCTION public.hangtag_mobile_reserved(p_owner UUID, p_variant TEXT)
RETURNS NUMERIC LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
    SELECT COALESCE((SELECT sum(GREATEST(i.qty - COALESCE((SELECT sum(si.quantity) FROM public.hangtag_sales bs
                JOIN public.hangtag_sale_items si ON si.owner_id = bs.owner_id AND si.sale_id = bs.id
               WHERE bs.owner_id = o.owner_id AND bs.order_id = o.id AND NOT bs.is_void AND si.variant_id = i.variant_id), 0), 0))
            FROM public.hangtag_orders o JOIN public.hangtag_order_items i ON i.owner_id = o.owner_id AND i.order_id = o.id
           WHERE o.owner_id = p_owner AND o.public_token IS NOT NULL AND o.status NOT IN ('completed','cancelled') AND i.variant_id = p_variant), 0)
$$;

-- Current free quantity from the one stock ledger, less the reservation above. It deliberately remains unclamped for the
-- database guard below: a negative value while a reservation exists means an ordinary till bill consumed customer stock.
CREATE OR REPLACE FUNCTION public.hangtag_mobile_free(p_owner UUID, p_variant TEXT)
RETURNS NUMERIC LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
    SELECT
        COALESCE((SELECT sum(m.qty) FROM public.hangtag_stock_moves m WHERE m.owner_id = p_owner AND m.variant_id = p_variant), 0)
        - COALESCE((SELECT sum(i.quantity) FROM public.hangtag_sale_items i JOIN public.hangtag_sales s
            ON s.owner_id = i.owner_id AND s.id = i.sale_id WHERE i.owner_id = p_owner AND i.variant_id = p_variant AND NOT s.is_void), 0)
        + COALESCE((SELECT sum(i.quantity) FROM public.hangtag_return_items i JOIN public.hangtag_returns r
            ON r.owner_id = i.owner_id AND r.id = i.return_id JOIN public.hangtag_sales s
            ON s.owner_id = r.owner_id AND s.id = r.sale_id WHERE i.owner_id = p_owner AND i.variant_id = p_variant AND i.restock AND NOT s.is_void), 0)
        - public.hangtag_mobile_reserved(p_owner, p_variant)
$$;

CREATE OR REPLACE FUNCTION public.hangtag_mobile_available(p_owner UUID, p_variant TEXT)
RETURNS NUMERIC LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
    SELECT GREATEST(0, public.hangtag_mobile_free(p_owner, p_variant))
$$;

-- (b) Public catalog. Products stay nested around their existing variants so a product image and description are sent
-- once. Cost, SKU/barcode, supplier, exact ledger history and every other shop row remain private.
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
                       'price', COALESCE(v.price, p.price), 'available', public.hangtag_mobile_available(p.owner_id, v.id))
                       ORDER BY v.sort_order, v.id), '[]'::jsonb)
                     FROM public.hangtag_variants v WHERE v.owner_id = p.owner_id AND v.product_id = p.id AND v.active)) AS item,
               lower(COALESCE(p.category, 'zzz')) || '|' || lpad(p.sort_order::TEXT, 10, '0') || '|' || lower(p.name) AS sort_key
          FROM public.hangtag_products p LEFT JOIN public.hangtag_images im ON im.owner_id = p.owner_id AND im.product_id = p.id
         WHERE p.owner_id = shop.id AND NOT p.archived
           AND EXISTS (SELECT 1 FROM public.hangtag_variants v WHERE v.owner_id = p.owner_id AND v.product_id = p.id AND v.active)
         ORDER BY lower(COALESCE(p.category, 'zzz')), p.sort_order, lower(p.name) LIMIT 500) x;
    SELECT COALESCE(jsonb_agg(c ORDER BY lower(c)), '[]'::jsonb) INTO cats FROM (
        SELECT DISTINCT btrim(p.category) c FROM public.hangtag_products p WHERE p.owner_id = shop.id AND NOT p.archived AND btrim(COALESCE(p.category, '')) <> '') q;
    RETURN jsonb_build_object('ok', TRUE, 'shop', COALESCE(NULLIF(btrim(shop.shop_name), ''), 'Shop'), 'tax_on', tax_on,
        'tax_inclusive', tax_incl, 'items', items, 'categories', cats);
END $$;

-- (c) Customer checkout. The shop profile row and requested variants are locked before availability is tested, so two
-- phones cannot reserve the last piece. The phone never supplies price, GST, product/customer ids or order state.
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
    -- One short lock per shop serializes idempotency, reservation and stock checks. Catalog reads remain lock-free.
    SELECT p.id, p.shop_name INTO shop FROM public.hangtag_profiles p WHERE p.store_token = p_token FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('ok', FALSE, 'message', 'This shop link is not valid.'); END IF;
    IF p_checkout_key IS NULL OR p_checkout_key !~ '^[A-Za-z0-9_-]{24,64}$' THEN RETURN jsonb_build_object('ok', FALSE, 'message', 'Start checkout again and retry.'); END IF;
    SELECT * INTO prior FROM public.hangtag_orders o WHERE o.owner_id = shop.id AND o.checkout_key = p_checkout_key;
    IF FOUND THEN RETURN jsonb_build_object('ok', TRUE, 'order_no', prior.no, 'order_token', prior.public_token, 'state', 'received', 'state_label', 'Awaiting staff'); END IF;
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
    -- Sorted locks avoid deadlocks with carts containing the same variants in a different order.
    FOR it IN SELECT x.item FROM jsonb_array_elements(p_items) x(item) ORDER BY x.item ->> 'v' LOOP
        q := CASE WHEN jsonb_typeof(it -> 'q') = 'number' THEN (it ->> 'q')::NUMERIC END;
        SELECT v.id, v.product_id, p.name, p.unit, COALESCE(v.price, p.price) price, CASE WHEN tax_on THEN COALESCE(p.gst_rate,default_rate) ELSE 0 END gst_rate,
               COALESCE((SELECT string_agg(e.value, ' / ' ORDER BY e.n) FROM jsonb_array_elements_text(v.option_values) WITH ORDINALITY e(value,n)), '') label
          INTO vr FROM public.hangtag_variants v JOIN public.hangtag_products p ON p.owner_id = v.owner_id AND p.id = v.product_id
         WHERE v.owner_id = shop.id AND v.id = it ->> 'v' AND v.active AND NOT p.archived FOR UPDATE OF v, p;
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
        SELECT v.id, v.product_id, p.name, p.unit, COALESCE(v.price,p.price) price, CASE WHEN tax_on THEN COALESCE(p.gst_rate,default_rate) ELSE 0 END gst_rate,
               COALESCE((SELECT string_agg(e.value, ' / ' ORDER BY e.n) FROM jsonb_array_elements_text(v.option_values) WITH ORDINALITY e(value,n)), '') label
          INTO vr FROM public.hangtag_variants v JOIN public.hangtag_products p ON p.owner_id=v.owner_id AND p.id=v.product_id
         WHERE v.owner_id=shop.id AND v.id=it->>'v';
        INSERT INTO public.hangtag_order_items (owner_id,order_id,line_no,product_id,variant_id,name,variant_label,unit,qty,price,gst_rate,fulfilled_qty)
        VALUES (shop.id,oid,ln,vr.product_id,vr.id,vr.name,vr.label,COALESCE(vr.unit,'pcs'),q,vr.price,vr.gst_rate,0);
        ln := ln + 1;
    END LOOP;
    RETURN jsonb_build_object('ok', TRUE, 'order_no', ono, 'order_token', otok, 'total', round(total), 'state', 'received', 'state_label', 'Awaiting staff');
END $$;

-- (d) Only the order's random status token works. Status and payment are derived from existing orders, bills and payments;
-- no customer details, item names, shop ids, bill ids or payment references are exposed.
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
    IF o.status='cancelled' THEN state:='cancelled'; state_label:='Cancelled';
    ELSIF ordered>0 AND billed>=ordered THEN state:='fulfilled'; state_label:='Fulfilled';
    ELSIF billed>0 THEN state:='partial'; state_label:='Partly fulfilled';
    ELSE state:='received'; state_label:='Awaiting staff'; END IF;
    IF EXISTS (SELECT 1 FROM public.hangtag_sales s WHERE s.owner_id=o.owner_id AND s.order_id=o.id AND NOT s.is_void
        AND COALESCE((SELECT sum(p.amount) FROM public.hangtag_payments p WHERE p.owner_id=s.owner_id AND p.sale_id=s.id AND p.status='completed'),0)
            >= GREATEST(s.total-s.credit-s.due_amount,0)) THEN payment_state:='confirmed'; payment_label:='Payment confirmed';
    ELSE payment_state:='awaiting_staff'; payment_label:=CASE o.payment_preference WHEN 'upi' THEN 'UPI to be verified by staff' WHEN 'cash' THEN 'Cash at checkout' ELSE 'Pay at checkout' END; END IF;
    RETURN jsonb_build_object('ok',TRUE,'order_no',o.no,'state',state,'state_label',state_label,'payment_state',payment_state,'payment_label',payment_label,
        'total',o.total,'mode',COALESCE(o.checkout_mode,'store'),'updated_at',o.updated_at);
END $$;

-- A bill may fulfil a mobile order in parts, but never beyond what the customer ordered. This deferred check sees the
-- whole bill after hangtag_save_sales has inserted all lines, and serializes concurrent tills on the order row.
CREATE OR REPLACE FUNCTION public.hangtag_check_mobile_fulfilment()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE sid TEXT; own UUID; sale public.hangtag_sales; ord public.hangtag_orders;
BEGIN
    IF TG_TABLE_NAME='hangtag_sales' THEN
        IF TG_OP='DELETE' THEN sid:=OLD.id; own:=OLD.owner_id; ELSE sid:=NEW.id; own:=NEW.owner_id; END IF;
    ELSE
        IF TG_OP='DELETE' THEN sid:=OLD.sale_id; own:=OLD.owner_id; ELSE sid:=NEW.sale_id; own:=NEW.owner_id; END IF;
    END IF;
    SELECT * INTO sale FROM public.hangtag_sales s WHERE s.owner_id=own AND s.id=sid;
    IF NOT FOUND THEN RETURN NULL; END IF;
    -- Mobile checkout takes this same row lock before it tests stock. Whichever transaction locks it second therefore sees
    -- the first one's committed sale/order and cannot take the same units. A bill tied to the mobile order is safe because
    -- its billed quantity reduces that order's outstanding reservation by exactly the quantity removed from stock.
    PERFORM 1 FROM public.hangtag_profiles p WHERE p.id=own FOR UPDATE;
    IF NOT sale.is_void AND EXISTS (SELECT 1 FROM (SELECT DISTINCT i.variant_id FROM public.hangtag_sale_items i
        WHERE i.owner_id=own AND i.sale_id=sid AND i.variant_id IS NOT NULL) v
        WHERE public.hangtag_mobile_reserved(own,v.variant_id) > 0 AND public.hangtag_mobile_free(own,v.variant_id) < 0) THEN
        RAISE EXCEPTION 'Some stock on this bill is reserved for a mobile order. Fulfil or cancel that order first.' USING ERRCODE='check_violation';
    END IF;
    IF sale.order_id IS NULL THEN RETURN NULL; END IF;
    SELECT * INTO ord FROM public.hangtag_orders o WHERE o.owner_id=sale.owner_id AND o.id=sale.order_id AND o.public_token IS NOT NULL FOR UPDATE;
    IF NOT FOUND OR sale.is_void THEN RETURN NULL; END IF;
    IF ord.status='cancelled' THEN RAISE EXCEPTION 'This mobile order was cancelled and cannot be billed.' USING ERRCODE='check_violation'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.hangtag_sale_items i WHERE i.owner_id=sale.owner_id AND i.sale_id=sale.id) THEN
        RAISE EXCEPTION 'A mobile order bill needs at least one ordered item.' USING ERRCODE='check_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM public.hangtag_sales s JOIN public.hangtag_sale_items i ON i.owner_id=s.owner_id AND i.sale_id=s.id
        WHERE s.owner_id=ord.owner_id AND s.order_id=ord.id AND NOT s.is_void
          AND NOT EXISTS (SELECT 1 FROM public.hangtag_order_items oi WHERE oi.owner_id=ord.owner_id AND oi.order_id=ord.id
              AND oi.variant_id=i.variant_id AND oi.price=i.unit_price)) THEN
        RAISE EXCEPTION 'This bill has an item or price that is not on the mobile order.' USING ERRCODE='check_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM public.hangtag_order_items oi WHERE oi.owner_id=ord.owner_id AND oi.order_id=ord.id
        AND COALESCE((SELECT sum(i.quantity) FROM public.hangtag_sales s JOIN public.hangtag_sale_items i ON i.owner_id=s.owner_id AND i.sale_id=s.id
             WHERE s.owner_id=ord.owner_id AND s.order_id=ord.id AND NOT s.is_void AND i.variant_id=oi.variant_id),0)>oi.qty) THEN
        RAISE EXCEPTION 'This mobile order has already been billed for that quantity.' USING ERRCODE='check_violation';
    END IF;
    RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS hangtag_check_mobile_sale ON public.hangtag_sales;
CREATE CONSTRAINT TRIGGER hangtag_check_mobile_sale AFTER INSERT OR UPDATE OF is_void,order_id ON public.hangtag_sales
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.hangtag_check_mobile_fulfilment();
DROP TRIGGER IF EXISTS hangtag_check_mobile_line ON public.hangtag_sale_items;
CREATE CONSTRAINT TRIGGER hangtag_check_mobile_line AFTER INSERT OR UPDATE OR DELETE ON public.hangtag_sale_items
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.hangtag_check_mobile_fulfilment();

REVOKE ALL ON FUNCTION public.hangtag_mobile_reserved(UUID,TEXT), public.hangtag_mobile_free(UUID,TEXT), public.hangtag_mobile_available(UUID,TEXT), public.hangtag_check_mobile_fulfilment() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.hangtag_mobile_catalog(TEXT), public.hangtag_place_mobile_order(TEXT,JSONB,JSONB,TEXT,TEXT,TEXT,TEXT), public.hangtag_mobile_order_status(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.hangtag_mobile_catalog(TEXT), public.hangtag_place_mobile_order(TEXT,JSONB,JSONB,TEXT,TEXT,TEXT,TEXT), public.hangtag_mobile_order_status(TEXT) TO anon,authenticated;

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

-- ==============================================================================
-- 3s. Bank accounts (UX productization): the shop's bank accounts and the money moved in them by hand
--   An account has its opening balance on a date, is active or switched off, may be the default account, and may take
--   payment methods (UPI → one account, card machine settlements → another; unmapped methods go to the default account).
--   Entries made by hand: money in, money out, a transfer between two accounts of the shop, an adjustment with its reason
--   (signed), and a reversal of a whole entry made by mistake. Like cash entries (section 3h) they are added, never changed
--   or removed. The UPI and card money of the bank book (section 3e) is counted into the mapped account by the app; this
--   section adds no trigger to sales. Accounts are switched off, never deleted, so their entries keep their account.
-- ==============================================================================
CREATE TABLE IF NOT EXISTS public.hangtag_bank_accounts (
    owner_id UUID NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
    id TEXT NOT NULL CHECK (char_length(id) BETWEEN 1 AND 64),
    name TEXT NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 60),
    bank TEXT CHECK (bank IS NULL OR char_length(bank) <= 60),
    last4 TEXT CHECK (last4 IS NULL OR last4 ~ '^[0-9]{4}$'),
    opening NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (abs(opening) <= 1000000000),
    opening_date DATE NOT NULL DEFAULT CURRENT_DATE,
    active BOOLEAN NOT NULL DEFAULT true,
    is_default BOOLEAN NOT NULL DEFAULT false,
    methods TEXT[] NOT NULL DEFAULT '{}' CHECK (methods <@ ARRAY['upi','card']::TEXT[]),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (owner_id, id)
);
CREATE TABLE IF NOT EXISTS public.hangtag_bank_moves (
    owner_id UUID NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
    id TEXT NOT NULL CHECK (char_length(id) BETWEEN 1 AND 64),
    account_id TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('in','out','transfer','adjust','reversal')),
    amount NUMERIC(14,2) NOT NULL CHECK (amount <> 0 AND abs(amount) <= 1000000000),
    to_account TEXT,
    reason TEXT CHECK (reason IS NULL OR char_length(reason) BETWEEN 3 AND 200),
    reverses TEXT,
    t BIGINT NOT NULL,
    device_id TEXT,
    user_id UUID DEFAULT auth.uid(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (owner_id, id),
    CONSTRAINT hangtag_bank_moves_account_fkey FOREIGN KEY (owner_id, account_id) REFERENCES public.hangtag_bank_accounts (owner_id, id),
    CONSTRAINT hangtag_bank_moves_to_fkey FOREIGN KEY (owner_id, to_account) REFERENCES public.hangtag_bank_accounts (owner_id, id),
    CONSTRAINT hangtag_bank_moves_reverses_fkey FOREIGN KEY (owner_id, reverses) REFERENCES public.hangtag_bank_moves (owner_id, id)
);
-- a transfer names another account (its reversal names the same two); an adjustment and a reversal say why; only they may be
-- negative (an adjustment down, and the reversal of one)
ALTER TABLE public.hangtag_bank_moves DROP CONSTRAINT IF EXISTS hangtag_bank_moves_kind_check;
ALTER TABLE public.hangtag_bank_moves ADD CONSTRAINT hangtag_bank_moves_kind_check CHECK (
    (type IN ('transfer','reversal') OR to_account IS NULL) AND (type <> 'transfer' OR (to_account IS NOT NULL AND to_account <> account_id))
    AND (type = 'reversal') = (reverses IS NOT NULL)
    AND (type NOT IN ('adjust','reversal') OR reason IS NOT NULL)
    AND (type IN ('adjust','reversal') OR amount > 0));
CREATE UNIQUE INDEX IF NOT EXISTS hangtag_bank_moves_reversed_once ON public.hangtag_bank_moves (owner_id, reverses) WHERE reverses IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_hangtag_bank_moves_account ON public.hangtag_bank_moves (owner_id, account_id, t);
-- a reversal is of a whole entry that is not itself a reversal, on the same accounts
CREATE OR REPLACE FUNCTION public.hangtag_bank_move_check()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE o RECORD;
BEGIN
    IF NEW.type = 'reversal' THEN
        SELECT type, amount, account_id, to_account INTO o FROM public.hangtag_bank_moves WHERE owner_id = NEW.owner_id AND id = NEW.reverses;
        IF o.type IS NULL THEN RAISE EXCEPTION 'Bank entry % was not found', NEW.reverses USING ERRCODE = 'foreign_key_violation'; END IF;
        IF o.type = 'reversal' OR o.amount <> NEW.amount OR o.account_id <> NEW.account_id OR o.to_account IS DISTINCT FROM NEW.to_account THEN
            RAISE EXCEPTION 'A reversal must be for the whole of an entry that is not itself a reversal' USING ERRCODE = 'check_violation';
        END IF;
    END IF;
    RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS hangtag_bank_move_check ON public.hangtag_bank_moves;
CREATE TRIGGER hangtag_bank_move_check BEFORE INSERT ON public.hangtag_bank_moves FOR EACH ROW EXECUTE FUNCTION public.hangtag_bank_move_check();
REVOKE EXECUTE ON FUNCTION public.hangtag_bank_move_check() FROM PUBLIC, anon;
-- an account's changes keep when they were made
CREATE OR REPLACE FUNCTION public.hangtag_bank_account_touch()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN NEW.updated_at := NOW(); RETURN NEW; END $$;
DROP TRIGGER IF EXISTS hangtag_bank_account_touch ON public.hangtag_bank_accounts;
CREATE TRIGGER hangtag_bank_account_touch BEFORE UPDATE ON public.hangtag_bank_accounts FOR EACH ROW EXECUTE FUNCTION public.hangtag_bank_account_touch();
REVOKE EXECUTE ON FUNCTION public.hangtag_bank_account_touch() FROM PUBLIC, anon;

-- The public mobile store's catalog (section 3r) also gives the shop's city and its logo, so the storefront looks like the
-- shop's own (both are already on every receipt the shop hands out). Everything else is exactly as section 3r defines it.
CREATE OR REPLACE FUNCTION public.hangtag_mobile_catalog(p_token TEXT)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE shop RECORD; items JSONB; cats JSONB; logo TEXT; tax_on BOOLEAN := FALSE; tax_incl BOOLEAN := TRUE; default_rate NUMERIC := 5;
BEGIN
    IF p_token IS NULL OR p_token !~ '^st_[A-Za-z0-9_-]{32,61}$' THEN
        RETURN jsonb_build_object('ok', FALSE, 'message', 'This shop link is not valid. Ask the shop for a new link.');
    END IF;
    SELECT p.id, p.shop_name, p.city INTO shop FROM public.hangtag_profiles p WHERE p.store_token = p_token;
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
    -- the shop's logo (the one printed on its receipts), only when it is a picture
    SELECT CASE WHEN jsonb_typeof(m.value) = 'string' AND (m.value #>> '{}') ~ '^data:image/(png|jpeg|webp);base64,' THEN m.value #>> '{}' END
      INTO logo FROM public.hangtag_meta m WHERE m.owner_id = shop.id AND m.key = 'logo';
    RETURN jsonb_build_object('ok', TRUE, 'shop', COALESCE(NULLIF(btrim(shop.shop_name), ''), 'Shop'), 'city', NULLIF(btrim(COALESCE(shop.city, '')), ''), 'logo', logo, 'tax_on', tax_on,
        'tax_inclusive', tax_incl, 'items', items, 'categories', cats);
END $$;

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
-- has no shop of its own, so no trial. The email's trial is claimed; a second account with the same email — or the same
-- inbox under another name: name+tag@…, and for Gmail n.a.m.e@gmail.com / @googlemail.com — starts with its trial over.
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
BEGIN
    IF p_owner IS NULL OR EXISTS (SELECT 1 FROM public.hangtag_subscriptions s WHERE s.owner_id = p_owner) THEN RETURN; END IF;
    IF EXISTS (SELECT 1 FROM public.hangtag_members m WHERE m.user_id = p_owner) THEN RETURN; END IF;
    IF NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = p_owner) THEN RETURN; END IF;
    SELECT p.days INTO trial_days FROM public.hangtag_plans p WHERE p.code = 'trial';
    trial_days := COALESCE(trial_days, 7);
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
    INSERT INTO public.hangtag_subscriptions (owner_id, trial_started_at, trial_ends_at)
    VALUES (p_owner, started, CASE WHEN claimed IS NOT NULL THEN started ELSE started + make_interval(days => trial_days) END)
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
    -- one checkout at a time per promo code, so a burst of checkouts is counted against its limits one by one
    IF btrim(COALESCE(p_promo, '')) <> '' THEN
        PERFORM 1 FROM public.hangtag_promo_codes c WHERE c.code = upper(btrim(p_promo)) FOR UPDATE;
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
    lim RECORD;
    over BOOLEAN := FALSE;
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
    -- the promo code's limits, checked again now (one activation at a time per code): several checkouts opened before one
    -- was paid can't use a code beyond its limits. Nothing to pay → refused (the payment fails, no plan time); money the
    -- provider took is honoured and the payment is marked for review.
    IF pay.promo_code IS NOT NULL THEN
        SELECT c.max_uses, c.per_account_limit INTO lim FROM public.hangtag_promo_codes c WHERE c.code = pay.promo_code FOR UPDATE;
        over := (SELECT count(*) FROM public.hangtag_promo_redemptions r WHERE r.code = pay.promo_code AND r.owner_id = pay.owner_id) >= COALESCE(lim.per_account_limit, 1)
             OR (lim.max_uses IS NOT NULL AND (SELECT count(*) FROM public.hangtag_promo_redemptions r WHERE r.code = pay.promo_code) >= lim.max_uses);
        IF over AND pay.amount = 0 THEN
            UPDATE public.hangtag_subscription_payments SET status = 'failed', note = 'Promo code limit reached' WHERE id = pay.id;
            RETURN jsonb_build_object('ok', FALSE, 'refused', TRUE, 'reason', 'promo_limit', 'message', 'This promo code has already been used.');
        END IF;
    END IF;
    -- money the provider confirmed is honoured even if the checkout had been marked expired or cancelled meanwhile
    per := public.hangtag_subscription_extend(pay.owner_id, pay.plan_code);
    UPDATE public.hangtag_subscription_payments SET status = 'paid', provider_payment_id = NULLIF(btrim(COALESCE(p_provider_payment, '')), ''),
        paid_at = NOW(), period_start = (per ->> 'start')::TIMESTAMPTZ, period_end = (per ->> 'end')::TIMESTAMPTZ,
        note = CASE WHEN over THEN 'Review: promo code used beyond its limit' ELSE note END
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

-- ==============================================================================
-- 3u. A reason for each returned line (after-sales)
--   Each line of a return keeps why it came back (Didn't fit, Wrong size, Didn't like it, Damaged or faulty, Other — or the
--   shop's own words, at most 60 characters): Reports count returns by reason and by product, and a damaged line is kept off
--   the shelf by default. The return's note still holds the reasons in words, so an app from before this keeps reading it.
--   Saving a return (RPC hangtag_save_return, as before: all or nothing, safe to retry, never on a cancelled bill) now
--   keeps each line's reason too. Safe to run again.
-- ==============================================================================
ALTER TABLE public.hangtag_return_items ADD COLUMN IF NOT EXISTS reason TEXT;
DO $$
BEGIN
    ALTER TABLE public.hangtag_return_items ADD CONSTRAINT hangtag_return_items_reason_len CHECK (reason IS NULL OR char_length(reason) <= 60);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE OR REPLACE FUNCTION public.hangtag_save_return(p_return JSONB, p_items JSONB)
RETURNS JSONB LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE
    uid UUID := public.hangtag_shop_id();
    r public.hangtag_returns;
    voided BOOLEAN;
    lines_value NUMERIC;
    n INT;
BEGIN
    IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Sign in to save returns.' USING ERRCODE = '42501'; END IF;
    IF uid IS NULL OR NOT public.hangtag_can('perform_return') THEN RAISE EXCEPTION 'Not allowed to save returns.' USING ERRCODE = '42501'; END IF;
    r := jsonb_populate_record(NULL::public.hangtag_returns, p_return);
    IF COALESCE(r.id, '') = '' THEN RAISE EXCEPTION 'A return has no id.' USING ERRCODE = '22023'; END IF;
    -- a team member only adds returns: one already saved stays exactly as it is (its retry saves nothing new)
    IF uid <> auth.uid() AND EXISTS (SELECT 1 FROM public.hangtag_returns x WHERE x.owner_id = uid AND x.id = r.id) THEN
        RETURN jsonb_build_object('status', 'saved', 'return', r.id, 'lines', (SELECT count(*) FROM public.hangtag_return_items i WHERE i.owner_id = uid AND i.return_id = r.id));
    END IF;
    SELECT is_void INTO voided FROM public.hangtag_sales WHERE owner_id = uid AND id = r.sale_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Bill % was not found', r.sale_id USING ERRCODE = 'foreign_key_violation';
    END IF;
    IF voided THEN
        RAISE EXCEPTION 'That bill is cancelled, so it can''t have a return' USING ERRCODE = 'check_violation';
    END IF;
    INSERT INTO public.hangtag_returns (id, sale_id, t, kind, exchange_id, refund_amount, refund_method, value, round_off, credit_no, note, device_id)
    VALUES (r.id, r.sale_id, r.t, COALESCE(r.kind, 'return'), r.exchange_id, COALESCE(r.refund_amount, 0), r.refund_method, COALESCE(r.value, 0),
        COALESCE(r.round_off, 0), r.credit_no, r.note, r.device_id)
    ON CONFLICT (owner_id, id) DO UPDATE SET sale_id = EXCLUDED.sale_id, t = EXCLUDED.t, kind = EXCLUDED.kind, exchange_id = EXCLUDED.exchange_id,
        refund_amount = EXCLUDED.refund_amount, refund_method = EXCLUDED.refund_method, value = EXCLUDED.value, round_off = EXCLUDED.round_off,
        credit_no = EXCLUDED.credit_no, note = EXCLUDED.note, device_id = EXCLUDED.device_id;
    DELETE FROM public.hangtag_return_items i WHERE i.owner_id = uid AND i.return_id = r.id
       AND i.line_no NOT IN (SELECT (y ->> 'line_no')::int FROM jsonb_array_elements(COALESCE(p_items, '[]'::jsonb)) y);
    INSERT INTO public.hangtag_return_items (return_id, line_no, sale_id, sale_line_no, variant_id, product_id, product_name, color, size, sku,
        quantity, unit_price, value, cost_price, variant_label, options, restock, taxable_value, gst_rate, cgst_amount, sgst_amount, igst_amount, hsn, serials, batches,
        reason)
    SELECT r.id, i.line_no, r.sale_id, i.sale_line_no, i.variant_id, i.product_id, i.product_name, COALESCE(i.color, ''), COALESCE(i.size, ''), i.sku,
        i.quantity, COALESCE(i.unit_price, 0), COALESCE(i.value, 0), i.cost_price, i.variant_label, i.options, COALESCE(i.restock, TRUE), i.taxable_value,
        i.gst_rate, COALESCE(i.cgst_amount, 0), COALESCE(i.sgst_amount, 0), COALESCE(i.igst_amount, 0), i.hsn, i.serials, i.batches,
        NULLIF(left(btrim(COALESCE(i.reason, '')), 60), '')
    FROM jsonb_populate_recordset(NULL::public.hangtag_return_items, COALESCE(p_items, '[]'::jsonb)) i
    ON CONFLICT (owner_id, return_id, line_no) DO UPDATE SET sale_id = EXCLUDED.sale_id, sale_line_no = EXCLUDED.sale_line_no,
        variant_id = EXCLUDED.variant_id, product_id = EXCLUDED.product_id, product_name = EXCLUDED.product_name, color = EXCLUDED.color,
        size = EXCLUDED.size, sku = EXCLUDED.sku, quantity = EXCLUDED.quantity, unit_price = EXCLUDED.unit_price, value = EXCLUDED.value,
        cost_price = EXCLUDED.cost_price, variant_label = EXCLUDED.variant_label, options = EXCLUDED.options, restock = EXCLUDED.restock,
        taxable_value = EXCLUDED.taxable_value, gst_rate = EXCLUDED.gst_rate, cgst_amount = EXCLUDED.cgst_amount, sgst_amount = EXCLUDED.sgst_amount,
        igst_amount = EXCLUDED.igst_amount, hsn = EXCLUDED.hsn, serials = EXCLUDED.serials, batches = EXCLUDED.batches, reason = EXCLUDED.reason;
    SELECT count(*), COALESCE(SUM(value), 0) INTO n, lines_value FROM public.hangtag_return_items WHERE owner_id = uid AND return_id = r.id;
    IF n = 0 THEN RAISE EXCEPTION 'A return needs at least one line' USING ERRCODE = 'check_violation'; END IF;
    IF COALESCE(r.value, 0) <> lines_value + COALESCE(r.round_off, 0) THEN
        RAISE EXCEPTION 'Return % is worth % but its lines come to %', COALESCE(r.credit_no, r.id), r.value, lines_value + COALESCE(r.round_off, 0)
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN jsonb_build_object('status', 'saved', 'return', r.id, 'lines', n);
END $$;
REVOKE ALL ON FUNCTION public.hangtag_save_return(JSONB, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.hangtag_save_return(JSONB, JSONB) TO authenticated;

-- ==============================================================================
-- 4. Indexes for reports
-- ==============================================================================
DROP INDEX IF EXISTS public.idx_hangtag_sizes_prod;
DROP INDEX IF EXISTS public.idx_hangtag_sales_time;
DROP INDEX IF EXISTS public.idx_hangtag_sale_items_sale;
CREATE INDEX IF NOT EXISTS idx_hangtag_sales_owner_time ON public.hangtag_sales (owner_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_hangtag_sale_items_prod ON public.hangtag_sale_items (product_id);

-- ==============================================================================
-- 5. Row Level Security: a shop's rows are seen and changed only by its owner, and by its team members from their
--    enrolled devices, each within their role's permissions (section 3i). owner_id fills itself in with the shop of the
--    signed-in account (public.hangtag_shop_id()), so the app never sends it. For an owner nothing changes: the shop is
--    the account itself and every permission is theirs.
--    Replaces the older "Own rows only", "Public access" and "Approved staff access" rules.
-- ==============================================================================
DO $$
DECLARE
    r RECORD;
    rd TEXT;
    shop CONSTANT TEXT := 'owner_id = (SELECT public.hangtag_shop_id())';
    any_of TEXT;
    ops TEXT[];
    w TEXT[];
    i INT;
BEGIN
    FOR r IN SELECT * FROM (VALUES
        -- table, who may read it (any one of these permissions; '' = everyone in the shop),
        -- who may add / change / remove its rows ('-' = nobody here: the database or an Edge Function writes it; 'owner' = the owner only;
        -- 'add|change|remove' when they differ). Bills, returns and stock records are history: a member adds them, and
        -- hangtag_member_write_check() (section 3i) refuses a member's real change of a saved one (except cancelling a bill)
        ('hangtag_products',        '',                                             'manage_products'),
        ('hangtag_variants',        '',                                             'manage_products'),
        ('hangtag_images',          '',                                             'manage_products'),
        ('hangtag_sizes',           '',                                             'manage_products'),
        ('hangtag_stock_moves',     '',                                             'manage_inventory,create_purchase,perform_return|manage_inventory,create_purchase,perform_return|manage_inventory'),
        ('hangtag_sales',           'create_sale,view_reports,create_order',        'create_sale|create_sale,perform_return,manage_settings|owner'),
        ('hangtag_sale_items',      'create_sale,view_reports,create_order',        'create_sale|create_sale|owner'),
        ('hangtag_payments',        'create_sale,view_reports,create_order',        'create_sale|create_sale|owner'),
        ('hangtag_returns',         'create_sale,view_reports',                     'perform_return|perform_return|owner'),
        ('hangtag_return_items',    'create_sale,view_reports',                     'perform_return|perform_return|owner'),
        ('hangtag_customers',       '',                                             'create_sale,collect_credit,create_order'),
        ('hangtag_meta',            '',                                             'manage_settings'),
        ('hangtag_events',          '',                                             'manage_settings'),
        ('hangtag_stock_imports',   'create_purchase,manage_inventory,view_reports','create_purchase'),
        ('hangtag_fin_txns',        'create_sale,view_reports',                     '-'),
        ('hangtag_cash_book',       'create_sale,view_reports',                     '-'),
        ('hangtag_bank_book',       'create_sale,view_reports',                     '-'),
        ('hangtag_deliveries',      'create_sale,view_reports,create_order',        '-'),
        ('hangtag_payment_intents', 'create_sale,view_reports',                     '-'),
        ('hangtag_invoice_links',   'create_sale,view_reports',                     'create_sale'),
        ('hangtag_cash_moves',      'create_sale,view_reports',                     'create_sale'),
        ('hangtag_day_closes',      'create_sale,view_reports',                     'create_sale'),
        -- tables of section 3j

        -- tables of section 3k

        -- tables of section 3l
        ('hangtag_suppliers',       'create_purchase,manage_inventory,view_reports','create_purchase,manage_inventory'),
        ('hangtag_supplier_payments','create_purchase,manage_inventory,view_reports','create_purchase'),

        -- tables of section 3m
        ('hangtag_collections',     'create_sale,view_reports,collect_credit',      'collect_credit|owner|owner'),
        ('hangtag_held_carts',      'create_sale',                                  'create_sale'),
        ('hangtag_orders',          'create_order,create_sale,manage_kitchen,view_reports', '-'),
        ('hangtag_order_items',     'create_order,create_sale,manage_kitchen,view_reports', '-'),

        -- tables of section 3n (written only by the database's triggers)
        ('hangtag_serials',         'create_sale,view_reports,manage_inventory,create_purchase,perform_return', '-'),
        ('hangtag_batches',         'create_sale,view_reports,manage_inventory,create_purchase,perform_return', '-'),

        -- tables of section 3o
        ('hangtag_tables',          '',                                             'manage_settings'),
        ('hangtag_table_sessions',  '',                                             'manage_tables,create_order,create_sale|manage_tables,create_order,create_sale|owner'),

        -- tables of section 3r (purchase orders, repacks and vouchers are written only through their functions; e-invoice /
        -- e-way records by the app within hangtag_compliance_check's limits; webhooks: the owner's own rules below)
        ('hangtag_price_lists',     '',                                             'manage_products'),
        ('hangtag_purchase_orders', 'create_purchase,manage_inventory,view_reports','-'),
        ('hangtag_einvoices',       'create_sale,view_reports',                     'create_sale,view_reports|create_sale,view_reports|owner'),
        ('hangtag_eway_bills',      'create_sale,view_reports',                     'create_sale,view_reports|create_sale,view_reports|owner'),
        ('hangtag_repacks',         'manage_inventory,view_reports',                '-'),
        ('hangtag_vouchers',        'create_sale,view_reports',                     '-'),
        ('hangtag_voucher_redemptions','create_sale,view_reports',                  '-'),
        ('hangtag_webhook_endpoints', NULL,                                         NULL),
        ('hangtag_webhook_events',  NULL,                                           NULL),
        ('hangtag_webhook_deliveries', NULL,                                        NULL),

        -- tables of section 3s (accounts are switched off, never removed; entries are added, never changed)
        ('hangtag_bank_accounts',   'view_reports,manage_settings',                 'manage_settings|manage_settings|owner'),
        ('hangtag_bank_moves',      'view_reports,manage_settings',                 'view_reports,manage_settings|owner|owner'),

        ('hangtag_roles',           '',                                             'owner'),
        ('hangtag_audit_log',       'view_reports',                                 '-'),
        -- devices and enrollment tokens have rules of their own (below); here they get the shop default
        ('hangtag_devices',         NULL,                                           NULL),
        ('hangtag_enrollments',     NULL,                                           NULL)
    ) AS x(t, rd, wr) LOOP
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', r.t);
        EXECUTE format('ALTER TABLE public.%I ALTER COLUMN owner_id SET DEFAULT public.hangtag_shop_id()', r.t);
        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'Public access to ' || r.t, r.t);
        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'Approved staff access to ' || r.t, r.t);
        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'Own rows only', r.t);
        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'Shop read', r.t);
        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'Shop write (add)', r.t);
        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'Shop write (change)', r.t);
        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'Shop write (remove)', r.t);
        CONTINUE WHEN r.rd IS NULL;
        -- (SELECT …) runs each check once per statement, not once per row
        SELECT string_agg(format('(SELECT public.hangtag_can(%L))', p), ' OR ') INTO any_of FROM unnest(string_to_array(NULLIF(r.rd, ''), ',')) p;
        rd := shop || COALESCE(' AND (' || any_of || ')', '');
        EXECUTE format('CREATE POLICY "Shop read" ON public.%I FOR SELECT TO authenticated USING (%s)', r.t, rd);
        CONTINUE WHEN r.wr = '-';
        ops := string_to_array(r.wr, '|');
        IF array_length(ops, 1) = 1 THEN ops := ARRAY[ops[1], ops[1], ops[1]]; END IF;
        w := ARRAY[]::TEXT[];
        FOR i IN 1..3 LOOP
            IF ops[i] = 'owner' THEN
                w := w || (shop || ' AND (SELECT public.hangtag_role()) = ''owner''');
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

-- Team members: a member reads its own row; the owner reads the whole team and may rename a member or change the role
-- or status (members are added and removed by the team Edge Function)
ALTER TABLE public.hangtag_members ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Shop read" ON public.hangtag_members;
DROP POLICY IF EXISTS "Shop write (change)" ON public.hangtag_members;
CREATE POLICY "Shop read" ON public.hangtag_members FOR SELECT TO authenticated
    USING (shop_id = (SELECT public.hangtag_shop_id()) AND (user_id = (SELECT auth.uid()) OR (SELECT public.hangtag_role()) = 'owner'));
CREATE POLICY "Shop write (change)" ON public.hangtag_members FOR UPDATE TO authenticated
    USING (shop_id = (SELECT public.hangtag_shop_id()) AND (SELECT public.hangtag_role()) = 'owner')
    WITH CHECK (shop_id = (SELECT public.hangtag_shop_id()) AND (SELECT public.hangtag_role()) = 'owner');
-- Devices: a member reads its own; the owner reads all of the shop's and may rename, revoke or remove them
CREATE POLICY "Shop read" ON public.hangtag_devices FOR SELECT TO authenticated
    USING (owner_id = (SELECT public.hangtag_shop_id()) AND (user_id = (SELECT auth.uid()) OR (SELECT public.hangtag_role()) = 'owner'));
CREATE POLICY "Shop write (change)" ON public.hangtag_devices FOR UPDATE TO authenticated
    USING (owner_id = (SELECT public.hangtag_shop_id()) AND (SELECT public.hangtag_role()) = 'owner')
    WITH CHECK (owner_id = (SELECT public.hangtag_shop_id()) AND (SELECT public.hangtag_role()) = 'owner');
CREATE POLICY "Shop write (remove)" ON public.hangtag_devices FOR DELETE TO authenticated
    USING (owner_id = (SELECT public.hangtag_shop_id()) AND (SELECT public.hangtag_role()) = 'owner');
-- Enrollment tokens: the owner can see them (only their hashes are kept); only the team function writes them
CREATE POLICY "Shop read" ON public.hangtag_enrollments FOR SELECT TO authenticated
    USING (owner_id = (SELECT public.hangtag_shop_id()) AND (SELECT public.hangtag_role()) = 'owner');

-- Webhooks (section 3r): only the shop's owner sees its endpoints, events and deliveries (and never the secrets)
CREATE POLICY "Shop read" ON public.hangtag_webhook_endpoints FOR SELECT TO authenticated
    USING (owner_id = (SELECT public.hangtag_shop_id()) AND (SELECT public.hangtag_role()) = 'owner');
CREATE POLICY "Shop read" ON public.hangtag_webhook_events FOR SELECT TO authenticated
    USING (owner_id = (SELECT public.hangtag_shop_id()) AND (SELECT public.hangtag_role()) = 'owner');
CREATE POLICY "Shop read" ON public.hangtag_webhook_deliveries FOR SELECT TO authenticated
    USING (owner_id = (SELECT public.hangtag_shop_id()) AND (SELECT public.hangtag_role()) = 'owner');

-- Profiles: an account reads its own and, as a team member, its shop's (name, address, GSTIN on the bills); it changes
-- only its own
ALTER TABLE public.hangtag_profiles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Own profile: read" ON public.hangtag_profiles;
DROP POLICY IF EXISTS "Own or shop profile: read" ON public.hangtag_profiles;
DROP POLICY IF EXISTS "Own profile: add" ON public.hangtag_profiles;
DROP POLICY IF EXISTS "Own profile: change" ON public.hangtag_profiles;
CREATE POLICY "Own or shop profile: read" ON public.hangtag_profiles FOR SELECT TO authenticated
    USING (id = (SELECT auth.uid()) OR id = (SELECT public.hangtag_shop_id()));
CREATE POLICY "Own profile: add" ON public.hangtag_profiles FOR INSERT TO authenticated WITH CHECK (id = (SELECT auth.uid()));
CREATE POLICY "Own profile: change" ON public.hangtag_profiles FOR UPDATE TO authenticated USING (id = (SELECT auth.uid())) WITH CHECK (id = (SELECT auth.uid()));

-- The shared access list from the previous version is no longer used: every account gets its own shop.
DROP FUNCTION IF EXISTS public.hangtag_is_allowed();
DROP TABLE IF EXISTS public.hangtag_allowed_users;

-- Signed-out visitors (just the public key) get no table access at all.
-- Their requests fail loudly instead of quietly returning nothing, so the app keeps unsent work queued.
REVOKE ALL ON TABLE public.hangtag_products, public.hangtag_sizes, public.hangtag_images,
    public.hangtag_sales, public.hangtag_sale_items, public.hangtag_meta, public.hangtag_profiles,
    public.hangtag_variants, public.hangtag_stock_moves, public.hangtag_customers,
    public.hangtag_returns, public.hangtag_return_items, public.hangtag_stock_imports,
    public.hangtag_payments, public.hangtag_fin_txns, public.hangtag_cash_book, public.hangtag_bank_book, public.hangtag_deliveries,
    public.hangtag_events, public.hangtag_payment_intents, public.hangtag_invoice_links, public.hangtag_cash_moves, public.hangtag_day_closes,
    public.hangtag_members, public.hangtag_roles, public.hangtag_devices, public.hangtag_enrollments, public.hangtag_audit_log FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.hangtag_products, public.hangtag_sizes, public.hangtag_images,
    public.hangtag_sales, public.hangtag_sale_items, public.hangtag_meta,
    public.hangtag_variants, public.hangtag_stock_moves, public.hangtag_customers,
    public.hangtag_returns, public.hangtag_return_items, public.hangtag_stock_imports, public.hangtag_payments, public.hangtag_events,
    public.hangtag_roles TO authenticated;
-- Financial transactions and the cash and bank books are written only by the database (section 3e), and delivery
-- records only by the send-receipt Edge Function (section 3f): read-only here
REVOKE ALL ON TABLE public.hangtag_fin_txns, public.hangtag_cash_book, public.hangtag_bank_book, public.hangtag_deliveries, public.hangtag_payment_intents FROM authenticated;
GRANT SELECT ON TABLE public.hangtag_fin_txns, public.hangtag_cash_book, public.hangtag_bank_book, public.hangtag_deliveries, public.hangtag_payment_intents TO authenticated;
-- invoice links (section 3h): written by the send-receipt function; the shop can read its own and revoke them
REVOKE ALL ON TABLE public.hangtag_invoice_links FROM authenticated;
GRANT SELECT ON TABLE public.hangtag_invoice_links TO authenticated;
GRANT UPDATE (revoked_at) ON TABLE public.hangtag_invoice_links TO authenticated;
-- cash entries (section 3h) are added, never changed; day closes can be made again
REVOKE ALL ON TABLE public.hangtag_cash_moves FROM authenticated;
GRANT SELECT, INSERT ON TABLE public.hangtag_cash_moves TO authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.hangtag_day_closes TO authenticated;
-- bank accounts (section 3s) are added and changed (switched off, never deleted); their entries are added, never changed
REVOKE ALL ON TABLE public.hangtag_bank_accounts, public.hangtag_bank_moves FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.hangtag_bank_accounts TO authenticated;
GRANT SELECT, INSERT ON TABLE public.hangtag_bank_moves TO authenticated;
-- team (section 3i): members, devices and enrollment tokens are written by the team Edge Function; the owner may only
-- change a member's name, role and status, and rename, revoke or remove a device. The audit log is read-only for everyone.
REVOKE ALL ON TABLE public.hangtag_members, public.hangtag_devices, public.hangtag_enrollments, public.hangtag_audit_log FROM authenticated;
GRANT SELECT ON TABLE public.hangtag_members, public.hangtag_devices, public.hangtag_enrollments, public.hangtag_audit_log TO authenticated;
GRANT UPDATE (name, role, status) ON TABLE public.hangtag_members TO authenticated;
GRANT UPDATE (name, status, revoked_at), DELETE ON TABLE public.hangtag_devices TO authenticated;
REVOKE EXECUTE ON FUNCTION public.hangtag_check_return_qty() FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE ON TABLE public.hangtag_profiles TO authenticated;

-- ==============================================================================
-- 6. Realtime: live updates between a person's own phones and laptops
-- ==============================================================================
DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['hangtag_products','hangtag_sizes','hangtag_images','hangtag_sales','hangtag_sale_items',
                             'hangtag_variants','hangtag_stock_moves','hangtag_customers','hangtag_returns','hangtag_return_items','hangtag_meta','hangtag_stock_imports',
                             'hangtag_events','hangtag_payment_intents','hangtag_cash_moves','hangtag_day_closes',
                             'hangtag_price_lists','hangtag_purchase_orders','hangtag_vouchers','hangtag_einvoices','hangtag_eway_bills',
                             'hangtag_bank_accounts','hangtag_bank_moves'] LOOP
        BEGIN
            EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
        EXCEPTION WHEN OTHERS THEN
            NULL; -- already added (or realtime not available)
        END;
    END LOOP;
END $$;

-- ==============================================================================
-- 7. Migration report (shown below the editor after running). "ok" should say true on every row.
-- ==============================================================================
SELECT check_name, value, expected, value = expected AS ok FROM (
    SELECT 1 AS n, 'Products with at least one variant' AS check_name,
           (SELECT count(*) FROM public.hangtag_products p WHERE EXISTS (SELECT 1 FROM public.hangtag_variants v WHERE v.owner_id = p.owner_id AND v.product_id = p.id))::bigint AS value,
           (SELECT count(*) FROM public.hangtag_products)::bigint AS expected
    UNION ALL
    -- expected: every old size of a product still in the shop, plus sizes whose variant was moved into another product
    -- ("Combine colours" keeps variant ids, e.g. p2:M under p1, and removes the merged product). Fails only when a
    -- size of a product that is still there has no variant.
    SELECT 2, 'Old sizes that became variants',
           (SELECT count(*) FROM public.hangtag_backup_v2_sizes b WHERE EXISTS (SELECT 1 FROM public.hangtag_variants v WHERE v.owner_id = b.owner_id AND v.id = b.product_id || ':' || b.size))::bigint,
           (SELECT count(*) FROM public.hangtag_backup_v2_sizes b WHERE EXISTS (SELECT 1 FROM public.hangtag_products p WHERE p.owner_id = b.owner_id AND p.id = b.product_id)
              OR EXISTS (SELECT 1 FROM public.hangtag_variants v WHERE v.owner_id = b.owner_id AND v.id = b.product_id || ':' || b.size))::bigint
    UNION ALL
    SELECT 3, 'Pieces received under the old size list = opening stock',
           (SELECT COALESCE(sum(m.qty), 0) FROM public.hangtag_stock_moves m WHERE m.type = 'OPENING' AND m.id LIKE 'open:%'
              AND EXISTS (SELECT 1 FROM public.hangtag_backup_v2_sizes b WHERE b.owner_id = m.owner_id AND m.id = 'open:' || b.product_id || ':' || b.size))::bigint,
           (SELECT COALESCE(sum(b.stock), 0) FROM public.hangtag_backup_v2_sizes b WHERE EXISTS (SELECT 1 FROM public.hangtag_variants v WHERE v.owner_id = b.owner_id AND v.id = b.product_id || ':' || b.size))::bigint
    UNION ALL
    SELECT 4, 'Bills (unchanged)', (SELECT count(*) FROM public.hangtag_sales s WHERE EXISTS (SELECT 1 FROM public.hangtag_backup_v2_sales b WHERE b.owner_id = s.owner_id AND b.id = s.id))::bigint,
           (SELECT count(*) FROM public.hangtag_backup_v2_sales)::bigint
    UNION ALL
    SELECT 5, 'Sales total of those bills in rupees (unchanged)',
           (SELECT COALESCE(sum(s.total), 0) FROM public.hangtag_sales s WHERE EXISTS (SELECT 1 FROM public.hangtag_backup_v2_sales b WHERE b.owner_id = s.owner_id AND b.id = s.id))::bigint,
           (SELECT COALESCE(sum(total), 0) FROM public.hangtag_backup_v2_sales)::bigint
    UNION ALL
    SELECT 6, 'Pieces on those bills (unchanged)',
           (SELECT COALESCE(sum(i.quantity), 0) FROM public.hangtag_sale_items i WHERE EXISTS (SELECT 1 FROM public.hangtag_backup_v2_sale_items b WHERE b.owner_id = i.owner_id AND b.sale_id = i.sale_id AND b.line_no = i.line_no))::bigint,
           (SELECT COALESCE(sum(quantity), 0) FROM public.hangtag_backup_v2_sale_items)::bigint
    UNION ALL
    SELECT 7, 'Old bill lines linked to their variant',
           (SELECT count(*) FROM public.hangtag_sale_items i WHERE i.variant_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.hangtag_backup_v2_sale_items b WHERE b.owner_id = i.owner_id AND b.sale_id = i.sale_id AND b.line_no = i.line_no))::bigint,
           (SELECT count(*) FROM public.hangtag_backup_v2_sale_items b WHERE EXISTS (SELECT 1 FROM public.hangtag_variants v WHERE v.owner_id = b.owner_id AND v.id = b.product_id || ':' || b.size))::bigint
    UNION ALL
    SELECT 8, 'Variants with a colour or size that have option values',
           (SELECT count(*) FROM public.hangtag_variants v WHERE (v.color <> '' OR v.size <> '') AND v.option_values <> '[]'::jsonb)::bigint,
           (SELECT count(*) FROM public.hangtag_variants v WHERE v.color <> '' OR v.size <> '')::bigint
    UNION ALL
    SELECT 9, 'Products whose variants for sale match their options',
           (SELECT count(*) FROM public.hangtag_products p WHERE p.options ? 'opts' AND NOT EXISTS (SELECT 1 FROM public.hangtag_variants v
              WHERE v.owner_id = p.owner_id AND v.product_id = p.id AND v.active AND jsonb_array_length(v.option_values) <> jsonb_array_length(p.options -> 'opts')))::bigint,
           (SELECT count(*) FROM public.hangtag_products)::bigint
    UNION ALL
    SELECT 10, 'Bills whose payments add up to what was due (less any part on account)',
           (SELECT count(*) FROM public.hangtag_sales s WHERE (SELECT COALESCE(sum(p.amount), 0) FROM public.hangtag_payments p
              WHERE p.owner_id = s.owner_id AND p.sale_id = s.id) = GREATEST(s.total - s.credit - s.due_amount, 0))::bigint,
           (SELECT count(*) FROM public.hangtag_sales)::bigint
    UNION ALL
    SELECT 11, 'Payments posted as a financial transaction (a gift voucher payment is not money in)',
           (SELECT count(*) FROM public.hangtag_payments p WHERE p.method <> 'voucher' AND EXISTS (SELECT 1 FROM public.hangtag_fin_txns f WHERE f.owner_id = p.owner_id AND f.payment_id = p.id))::bigint,
           (SELECT count(*) FROM public.hangtag_payments p WHERE p.method <> 'voucher')::bigint
    UNION ALL
    SELECT 12, 'Refunds posted as a financial transaction',
           (SELECT count(*) FROM public.hangtag_returns r WHERE EXISTS (SELECT 1 FROM public.hangtag_fin_txns f WHERE f.owner_id = r.owner_id AND f.return_id = r.id))::bigint,
           (SELECT count(*) FROM public.hangtag_returns r WHERE r.refund_amount > 0 AND r.refund_method IN ('cash','upi','card'))::bigint
    UNION ALL
    SELECT 13, 'Financial transactions in the cash or bank book',
           (SELECT count(*) FROM public.hangtag_fin_txns f WHERE EXISTS (SELECT 1 FROM public.hangtag_cash_book c WHERE c.owner_id = f.owner_id AND c.fin_txn_id = f.id)
              OR EXISTS (SELECT 1 FROM public.hangtag_bank_book b WHERE b.owner_id = f.owner_id AND b.fin_txn_id = f.id))::bigint,
           (SELECT count(*) FROM public.hangtag_fin_txns)::bigint
    UNION ALL
    SELECT 14, 'Bill lines never returned more than bought',
           (SELECT count(*) FROM public.hangtag_sale_items i WHERE EXISTS (SELECT 1 FROM public.hangtag_return_items x WHERE x.owner_id = i.owner_id AND x.sale_id = i.sale_id AND x.sale_line_no = i.line_no)
              AND (SELECT sum(x.quantity) FROM public.hangtag_return_items x WHERE x.owner_id = i.owner_id AND x.sale_id = i.sale_id AND x.sale_line_no = i.line_no) <= i.quantity)::bigint,
           (SELECT count(*) FROM public.hangtag_sale_items i WHERE EXISTS (SELECT 1 FROM public.hangtag_return_items x WHERE x.owner_id = i.owner_id AND x.sale_id = i.sale_id AND x.sale_line_no = i.line_no))::bigint
    UNION ALL
    SELECT 15, 'Returns worth exactly their lines plus round off',
           (SELECT count(*) FROM public.hangtag_returns r WHERE r.value = r.round_off + (SELECT sum(x.value) FROM public.hangtag_return_items x WHERE x.owner_id = r.owner_id AND x.return_id = r.id))::bigint,
           (SELECT count(*) FROM public.hangtag_returns r WHERE EXISTS (SELECT 1 FROM public.hangtag_return_items x WHERE x.owner_id = r.owner_id AND x.return_id = r.id))::bigint
    UNION ALL
    SELECT 16, 'Bills made at an event that exists',
           (SELECT count(*) FROM public.hangtag_sales s WHERE s.event_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.hangtag_events e WHERE e.owner_id = s.owner_id AND e.id = s.event_id))::bigint,
           (SELECT count(*) FROM public.hangtag_sales s WHERE s.event_id IS NOT NULL)::bigint
    UNION ALL
    SELECT 17, 'Verified payments confirmed by the payment provider',
           (SELECT count(*) FROM public.hangtag_payments p WHERE p.verification = 'verified' AND EXISTS (SELECT 1 FROM public.hangtag_payment_intents i
              WHERE i.owner_id = p.owner_id AND i.id = p.intent_id AND i.status = 'verified' AND i.amount = p.amount))::bigint,
           (SELECT count(*) FROM public.hangtag_payments p WHERE p.verification = 'verified')::bigint
    UNION ALL
    SELECT 18, 'Automatic receipts sent once per bill and channel',
           (SELECT count(DISTINCT (d.owner_id, d.sale_id, d.channel)) FROM public.hangtag_deliveries d WHERE d.mode = 'auto' AND d.status IN ('pending','sent','delivered'))::bigint,
           (SELECT count(*) FROM public.hangtag_deliveries d WHERE d.mode = 'auto' AND d.status IN ('pending','sent','delivered'))::bigint
    UNION ALL
    SELECT 19, 'Cash reversals for the whole of their entry',
           (SELECT count(*) FROM public.hangtag_cash_moves r JOIN public.hangtag_cash_moves o ON o.owner_id = r.owner_id AND o.id = r.reverses
             WHERE r.type = 'reversal' AND o.type <> 'reversal' AND o.amount = r.amount)::bigint,
           (SELECT count(*) FROM public.hangtag_cash_moves r WHERE r.type = 'reversal')::bigint
    UNION ALL
    SELECT 20, 'Team members of a shop that exists and is not itself a team member',
           (SELECT count(*) FROM public.hangtag_members m WHERE EXISTS (SELECT 1 FROM auth.users u WHERE u.id = m.shop_id)
              AND NOT EXISTS (SELECT 1 FROM public.hangtag_members x WHERE x.user_id = m.shop_id))::bigint,
           (SELECT count(*) FROM public.hangtag_members)::bigint
    UNION ALL
    SELECT 21, 'Team members with no shop of their own',
           (SELECT count(*) FROM public.hangtag_members m WHERE NOT EXISTS (SELECT 1 FROM public.hangtag_members x WHERE x.shop_id = m.user_id)
              AND NOT EXISTS (SELECT 1 FROM public.hangtag_products p WHERE p.owner_id = m.user_id)
              AND NOT EXISTS (SELECT 1 FROM public.hangtag_sales s WHERE s.owner_id = m.user_id))::bigint,
           (SELECT count(*) FROM public.hangtag_members)::bigint
    UNION ALL
    SELECT 22, 'Devices that belong to a team member of their shop',
           (SELECT count(*) FROM public.hangtag_devices d JOIN public.hangtag_members m ON m.user_id = d.user_id AND m.shop_id = d.owner_id)::bigint,
           (SELECT count(*) FROM public.hangtag_devices)::bigint
    UNION ALL
    SELECT 30, 'Shop profiles with a known type of business (none, or a value saved before types, counts as retail)',
           (SELECT count(*) FROM public.hangtag_profiles p WHERE p.business_type IS NULL OR p.business_type IN ('retail', 'grocery', 'restaurant', 'electronics', 'other',
              'Clothing boutique', 'Pop-up or exhibition stall', 'Retail store', 'Online seller', 'Wholesale', 'Other'))::bigint,
           (SELECT count(*) FROM public.hangtag_profiles)::bigint
    UNION ALL
    SELECT 31, 'Products tracked by count, serial number or batch',
           (SELECT count(*) FROM public.hangtag_products p WHERE p.tracking IN ('none', 'serial', 'batch'))::bigint,
           (SELECT count(*) FROM public.hangtag_products)::bigint
    UNION ALL
    SELECT 32, 'Shop settings whose capabilities are all on or off',
           (SELECT count(*) FROM public.hangtag_meta m WHERE m.key = 'settings' AND (m.value IS NULL OR jsonb_typeof(m.value) <> 'object' OR NOT (m.value ? 'caps')
              OR (jsonb_typeof(m.value -> 'caps') = 'object' AND NOT EXISTS (SELECT 1 FROM jsonb_each(m.value -> 'caps') c WHERE jsonb_typeof(c.value) <> 'boolean'))))::bigint,
           (SELECT count(*) FROM public.hangtag_meta m WHERE m.key = 'settings')::bigint
    UNION ALL
    SELECT 35, 'Quantity columns that keep 3 decimals (bill lines, return lines, stock records)',
           (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND data_type = 'numeric' AND numeric_scale = 3
              AND (table_name, column_name) IN (('hangtag_sale_items','quantity'), ('hangtag_return_items','quantity'), ('hangtag_stock_moves','qty')))::bigint,
           3::bigint
    UNION ALL
    SELECT 36, 'Products sold in a known unit',
           (SELECT count(*) FROM public.hangtag_products p WHERE p.unit IN ('pcs','box','pack','dozen','kg','g','l','ml','m'))::bigint,
           (SELECT count(*) FROM public.hangtag_products)::bigint
    UNION ALL
    SELECT 37, 'Device-numbered bills whose number no other bill of the shop has',
           (SELECT count(*) FROM public.hangtag_sales s WHERE s.bill_no ~ '[0-9]{6}-[0-9A-Z]{3}[0-9]{3,}$'
              AND NOT EXISTS (SELECT 1 FROM public.hangtag_sales x WHERE x.owner_id = s.owner_id AND x.bill_no = s.bill_no AND x.id <> s.id))::bigint,
           (SELECT count(*) FROM public.hangtag_sales s WHERE s.bill_no ~ '[0-9]{6}-[0-9A-Z]{3}[0-9]{3,}$')::bigint
    UNION ALL
    SELECT 38, 'Device-numbered credit notes whose number no other return of the shop has',
           (SELECT count(*) FROM public.hangtag_returns r WHERE r.credit_no ~ '[0-9]{6}-[0-9A-Z]{3}[0-9]{3,}$'
              AND NOT EXISTS (SELECT 1 FROM public.hangtag_returns x WHERE x.owner_id = r.owner_id AND x.credit_no = r.credit_no AND x.id <> r.id))::bigint,
           (SELECT count(*) FROM public.hangtag_returns r WHERE r.credit_no ~ '[0-9]{6}-[0-9A-Z]{3}[0-9]{3,}$')::bigint
    UNION ALL
    SELECT 39, 'Bills, returns, stock records and cash entries that note who made them (user_id set by the database)',
           (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'user_id' AND column_default LIKE '%auth.uid()%'
              AND table_name IN ('hangtag_sales','hangtag_returns','hangtag_stock_moves','hangtag_cash_moves'))::bigint,
           4::bigint
    UNION ALL
    SELECT 45, 'Bills with an amount on account, for a saved customer',
           (SELECT count(*) FROM public.hangtag_sales s WHERE s.due_amount > 0 AND EXISTS (SELECT 1 FROM public.hangtag_customers c WHERE c.owner_id = s.owner_id AND c.id = s.customer_id))::bigint,
           (SELECT count(*) FROM public.hangtag_sales s WHERE s.due_amount > 0)::bigint
    UNION ALL
    SELECT 46, 'Payments collected from customers posted in the cash or bank book',
           (SELECT count(*) FROM public.hangtag_collections c WHERE EXISTS (SELECT 1 FROM public.hangtag_fin_txns f WHERE f.owner_id = c.owner_id AND f.collection_id = c.id
              AND (EXISTS (SELECT 1 FROM public.hangtag_cash_book b WHERE b.owner_id = f.owner_id AND b.fin_txn_id = f.id)
                OR EXISTS (SELECT 1 FROM public.hangtag_bank_book b WHERE b.owner_id = f.owner_id AND b.fin_txn_id = f.id))))::bigint,
           (SELECT count(*) FROM public.hangtag_collections)::bigint
    UNION ALL
    SELECT 47, 'Refunds to a customer''s account within what the bill had on account',
           (SELECT count(*) FROM public.hangtag_sales s WHERE EXISTS (SELECT 1 FROM public.hangtag_returns r WHERE r.owner_id = s.owner_id AND r.sale_id = s.id AND r.refund_method = 'due')
              AND (SELECT sum(r.refund_amount) FROM public.hangtag_returns r WHERE r.owner_id = s.owner_id AND r.sale_id = s.id AND r.refund_method = 'due') <= s.due_amount)::bigint,
           (SELECT count(*) FROM public.hangtag_sales s WHERE EXISTS (SELECT 1 FROM public.hangtag_returns r WHERE r.owner_id = s.owner_id AND r.sale_id = s.id AND r.refund_method = 'due'))::bigint
    UNION ALL
    SELECT 48, 'Bills made from an order that exists',
           (SELECT count(*) FROM public.hangtag_sales s WHERE s.order_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.hangtag_orders o WHERE o.owner_id = s.owner_id AND o.id = s.order_id))::bigint,
           (SELECT count(*) FROM public.hangtag_sales s WHERE s.order_id IS NOT NULL)::bigint
    UNION ALL
    SELECT 49, 'Orders with at least one line',
           (SELECT count(*) FROM public.hangtag_orders o WHERE EXISTS (SELECT 1 FROM public.hangtag_order_items i WHERE i.owner_id = o.owner_id AND i.order_id = o.id))::bigint,
           (SELECT count(*) FROM public.hangtag_orders)::bigint
    UNION ALL
    SELECT 40, 'Purchases whose lines add up to their total',
           (SELECT count(*) FROM public.hangtag_stock_imports p WHERE p.kind = 'purchase' AND p.total_amount = p.subtotal + p.tax_amount
              AND p.subtotal = (SELECT COALESCE(sum(round((x ->> 'tx')::NUMERIC, 2)), 0) FROM jsonb_array_elements(p.lines) x)
              AND p.tax_amount = (SELECT COALESCE(sum(round((x ->> 'tax')::NUMERIC, 2)), 0) FROM jsonb_array_elements(p.lines) x))::bigint,
           (SELECT count(*) FROM public.hangtag_stock_imports p WHERE p.kind = 'purchase')::bigint
    UNION ALL
    SELECT 41, 'Purchases whose stock in matches their lines (cancelled ones: taken back)',
           (SELECT count(*) FROM public.hangtag_stock_imports p WHERE p.kind = 'purchase'
              AND (SELECT COALESCE(sum(m.qty), 0) FROM public.hangtag_stock_moves m WHERE m.owner_id = p.owner_id AND m.import_id = p.id)
                = CASE WHEN p.status = 'cancelled' THEN 0 ELSE (SELECT COALESCE(sum((x ->> 'q')::NUMERIC), 0) FROM jsonb_array_elements(p.lines) x) END)::bigint,
           (SELECT count(*) FROM public.hangtag_stock_imports p WHERE p.kind = 'purchase')::bigint
    UNION ALL
    SELECT 42, 'Cash paid to suppliers is in the cash book',
           ((SELECT count(*) FROM public.hangtag_stock_imports p WHERE p.kind = 'purchase' AND p.payment_method = 'cash' AND p.paid_amount > 0
              AND EXISTS (SELECT 1 FROM public.hangtag_cash_moves c WHERE c.owner_id = p.owner_id AND c.id = 'pur:' || p.id AND c.type = 'out' AND c.amount = p.paid_amount)
              AND (p.status = 'posted' OR EXISTS (SELECT 1 FROM public.hangtag_cash_moves r WHERE r.owner_id = p.owner_id AND r.reverses = 'pur:' || p.id)))
            + (SELECT count(*) FROM public.hangtag_supplier_payments x WHERE x.method = 'cash'
              AND EXISTS (SELECT 1 FROM public.hangtag_cash_moves c WHERE c.owner_id = x.owner_id AND (c.id = 'spay:' || x.id OR (x.reverses IS NOT NULL AND c.reverses = 'spay:' || x.reverses)))))::bigint,
           ((SELECT count(*) FROM public.hangtag_stock_imports p WHERE p.kind = 'purchase' AND p.payment_method = 'cash' AND p.paid_amount > 0)
            + (SELECT count(*) FROM public.hangtag_supplier_payments x WHERE x.method = 'cash'))::bigint
    UNION ALL
    SELECT 43, 'Supplier payment reversals for the whole of their payment',
           (SELECT count(*) FROM public.hangtag_supplier_payments r JOIN public.hangtag_supplier_payments o ON o.owner_id = r.owner_id AND o.id = r.reverses
             WHERE o.reverses IS NULL AND o.amount = r.amount AND o.supplier_id = r.supplier_id)::bigint,
           (SELECT count(*) FROM public.hangtag_supplier_payments r WHERE r.reverses IS NOT NULL)::bigint
    UNION ALL
    SELECT 44, 'Purchases not paid more than their total',
           (SELECT count(*) FROM public.hangtag_stock_imports p WHERE p.kind = 'purchase' AND p.paid_amount + COALESCE((SELECT sum(CASE WHEN x.reverses IS NULL THEN x.amount ELSE -x.amount END)
              FROM public.hangtag_supplier_payments x WHERE x.owner_id = p.owner_id AND x.purchase_id = p.id), 0) <= p.total_amount)::bigint,
           (SELECT count(*) FROM public.hangtag_stock_imports p WHERE p.kind = 'purchase')::bigint
    UNION ALL
    SELECT 50, 'Serial numbers in a known state (one row per serial of a shop)',
           (SELECT count(*) FROM public.hangtag_serials WHERE status IN ('IN_STOCK','SOLD','RETURNED','DAMAGED','CANCELLED'))::bigint,
           (SELECT count(*) FROM public.hangtag_serials)::bigint
    UNION ALL
    SELECT 51, 'Serials sold are on a bill line that isn''t cancelled',
           (SELECT count(*) FROM public.hangtag_serials x WHERE x.status = 'SOLD' AND EXISTS (SELECT 1 FROM public.hangtag_sales s
              JOIN public.hangtag_sale_items i ON i.owner_id = s.owner_id AND i.sale_id = s.id
              WHERE s.owner_id = x.owner_id AND s.id = x.sale_id AND NOT s.is_void AND i.line_no = x.sale_line_no AND x.serial = ANY (i.serials)))::bigint,
           (SELECT count(*) FROM public.hangtag_serials WHERE status = 'SOLD')::bigint
    UNION ALL
    SELECT 52, 'Stock records with serial numbers: one per piece',
           (SELECT count(*) FROM public.hangtag_stock_moves m WHERE m.serials IS NOT NULL AND cardinality(m.serials) = abs(m.qty))::bigint,
           (SELECT count(*) FROM public.hangtag_stock_moves m WHERE m.serials IS NOT NULL)::bigint
    UNION ALL
    SELECT 53, 'Bill lines with serial numbers: one per piece, each in the register',
           (SELECT count(*) FROM public.hangtag_sale_items i WHERE i.serials IS NOT NULL AND cardinality(i.serials) = i.quantity
              AND NOT EXISTS (SELECT 1 FROM unnest(i.serials) z WHERE NOT EXISTS (SELECT 1 FROM public.hangtag_serials x WHERE x.owner_id = i.owner_id AND x.serial = z)))::bigint,
           (SELECT count(*) FROM public.hangtag_sale_items i WHERE i.serials IS NOT NULL)::bigint
    UNION ALL
    SELECT 54, 'Batches never below zero',
           (SELECT count(*) FROM public.hangtag_batches b WHERE public.hangtag_batch_left(b.owner_id, b.variant_id, b.batch_no) >= 0)::bigint,
           (SELECT count(*) FROM public.hangtag_batches)::bigint
    UNION ALL
    SELECT 55, 'Bill lines taking from batches that exist, exactly the line''s quantity',
           (SELECT count(*) FROM public.hangtag_sale_items i WHERE i.batches IS NOT NULL
              AND (SELECT sum((a ->> 'q')::NUMERIC) FROM jsonb_array_elements(i.batches) a) = i.quantity
              AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(i.batches) a WHERE NOT EXISTS (SELECT 1 FROM public.hangtag_batches b
                  WHERE b.owner_id = i.owner_id AND b.variant_id = i.variant_id AND b.batch_no = a ->> 'b')))::bigint,
           (SELECT count(*) FROM public.hangtag_sale_items i WHERE i.batches IS NOT NULL)::bigint
    UNION ALL
    SELECT 60, 'Tables with a QR code of their own',
           (SELECT count(DISTINCT t.qr_token) FROM public.hangtag_tables t)::bigint,
           (SELECT count(*) FROM public.hangtag_tables)::bigint
    UNION ALL
    SELECT 61, 'Table orders for a table that exists',
           (SELECT count(*) FROM public.hangtag_orders o WHERE o.kind = 'table' AND EXISTS (SELECT 1 FROM public.hangtag_tables t WHERE t.owner_id = o.owner_id AND t.id = o.table_id))::bigint,
           (SELECT count(*) FROM public.hangtag_orders o WHERE o.kind = 'table')::bigint
    UNION ALL
    SELECT 62, 'Closed table sessions with the bill that closed them',
           (SELECT count(*) FROM public.hangtag_table_sessions s WHERE s.status = 'closed' AND s.sale_id IS NOT NULL)::bigint,
           (SELECT count(*) FROM public.hangtag_table_sessions s WHERE s.status = 'closed')::bigint
    UNION ALL
    SELECT 63, 'Supplier bills whose original is kept in the shop''s own folder',
           (SELECT count(*) FROM public.hangtag_stock_imports i WHERE i.document_path IS NULL OR split_part(i.document_path, '/', 1) = i.owner_id::text)::bigint,
           (SELECT count(*) FROM public.hangtag_stock_imports)::bigint
    UNION ALL
    SELECT 64, 'Sales orders made from a quotation of the same shop',
           (SELECT count(*) FROM public.hangtag_orders o WHERE o.quote_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.hangtag_orders q
               WHERE q.owner_id = o.owner_id AND q.id = o.quote_id AND q.kind = 'quote'))::bigint,
           (SELECT count(*) FROM public.hangtag_orders o WHERE o.quote_id IS NOT NULL)::bigint
    UNION ALL
    SELECT 65, 'Messages sent for one bill or one quotation, never both',
           (SELECT count(*) FROM public.hangtag_deliveries d WHERE d.sale_id IS NULL OR d.order_id IS NULL)::bigint,
           (SELECT count(*) FROM public.hangtag_deliveries)::bigint
    UNION ALL
    SELECT 66, 'Price lists: at most one default per shop',
           (SELECT count(*) FROM (SELECT owner_id FROM public.hangtag_price_lists WHERE is_default GROUP BY owner_id HAVING count(*) = 1) x)::bigint,
           (SELECT count(DISTINCT owner_id) FROM public.hangtag_price_lists WHERE is_default)::bigint
    UNION ALL
    SELECT 67, 'Customers on a price list of their own shop',
           (SELECT count(*) FROM public.hangtag_customers c WHERE c.price_list_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.hangtag_price_lists l
               WHERE l.owner_id = c.owner_id AND l.id = c.price_list_id))::bigint,
           (SELECT count(*) FROM public.hangtag_customers c WHERE c.price_list_id IS NOT NULL)::bigint
    UNION ALL
    SELECT 68, 'Goods received on a purchase order come from its supplier',
           (SELECT count(*) FROM public.hangtag_stock_imports i JOIN public.hangtag_purchase_orders o ON o.owner_id = i.owner_id AND o.id = i.po_id
             WHERE i.supplier_id = o.supplier_id)::bigint,
           (SELECT count(*) FROM public.hangtag_stock_imports i WHERE i.po_id IS NOT NULL)::bigint
    UNION ALL
    SELECT 69, 'Gift vouchers: balance = amount − what was spent',
           (SELECT count(*) FROM public.hangtag_vouchers v WHERE v.balance = v.amount
               - COALESCE((SELECT sum(CASE WHEN r.kind = 'redeem' THEN r.amount ELSE -r.amount END) FROM public.hangtag_voucher_redemptions r
                           WHERE r.owner_id = v.owner_id AND r.voucher_id = v.id), 0))::bigint,
           (SELECT count(*) FROM public.hangtag_vouchers)::bigint
    UNION ALL
    SELECT 70, 'Kit items are products of the same shop, never kits',
           (SELECT count(*) FROM public.hangtag_products p WHERE p.bundle IS NOT NULL AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p.bundle) c
               WHERE NOT EXISTS (SELECT 1 FROM public.hangtag_variants v JOIN public.hangtag_products q ON q.owner_id = v.owner_id AND q.id = v.product_id
                   WHERE v.owner_id = p.owner_id AND v.id = c ->> 'v' AND q.bundle IS NULL)))::bigint,
           (SELECT count(*) FROM public.hangtag_products p WHERE p.bundle IS NOT NULL)::bigint
    UNION ALL
    SELECT 71, 'Repacks with both stock records',
           (SELECT count(*) FROM public.hangtag_repacks r WHERE EXISTS (SELECT 1 FROM public.hangtag_stock_moves m WHERE m.owner_id = r.owner_id AND m.id = 'rpk:' || r.id || ':out')
               AND EXISTS (SELECT 1 FROM public.hangtag_stock_moves m WHERE m.owner_id = r.owner_id AND m.id = 'rpk:' || r.id || ':in'))::bigint,
           (SELECT count(*) FROM public.hangtag_repacks)::bigint
    UNION ALL
    SELECT 72, 'E-invoices and e-way bills with a number only when the provider generated them',
           (SELECT count(*) FROM public.hangtag_einvoices e WHERE (e.irn IS NOT NULL) = (e.status IN ('generated','cancelled')))::bigint
             + (SELECT count(*) FROM public.hangtag_eway_bills w WHERE (w.ewb_no IS NOT NULL) = (w.status IN ('generated','cancelled')))::bigint,
           (SELECT count(*) FROM public.hangtag_einvoices)::bigint + (SELECT count(*) FROM public.hangtag_eway_bills)::bigint
    UNION ALL
    SELECT 73, 'Bank entries: transfers between two accounts, reversals of a whole entry',
           (SELECT count(*) FROM public.hangtag_bank_moves m WHERE (m.type <> 'transfer' OR m.to_account <> m.account_id)
               AND (m.type <> 'reversal' OR EXISTS (SELECT 1 FROM public.hangtag_bank_moves o WHERE o.owner_id = m.owner_id AND o.id = m.reverses
                   AND o.type <> 'reversal' AND o.amount = m.amount AND o.account_id = m.account_id)))::bigint,
           (SELECT count(*) FROM public.hangtag_bank_moves)::bigint
    UNION ALL
    SELECT 74, 'Plans, subscriptions, promo codes and the access lock are in place (functions)',
           (SELECT count(DISTINCT p.proname) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('hangtag_subscription_ensure',
               'hangtag_subscription_state', 'hangtag_access_ok', 'hangtag_subscription_on_onboard', 'hangtag_subscription_guard', 'hangtag_promo_evaluate',
               'hangtag_subscription_owner', 'hangtag_subscription_status', 'hangtag_subscription_plans', 'hangtag_subscription_quote',
               'hangtag_subscription_checkout', 'hangtag_subscription_attach', 'hangtag_subscription_extend', 'hangtag_subscription_activate',
               'hangtag_subscription_fail', 'hangtag_admin_grant', 'hangtag_admin_suspend', 'hangtag_agent_take'))::bigint,
           18::bigint
    UNION ALL
    SELECT 75, 'Shops set up with a plan record (their trial or paid plan)',
           (SELECT count(*) FROM public.hangtag_profiles p WHERE p.onboarded_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.hangtag_members m WHERE m.user_id = p.id)
               AND EXISTS (SELECT 1 FROM public.hangtag_subscriptions s WHERE s.owner_id = p.id))::bigint,
           (SELECT count(*) FROM public.hangtag_profiles p WHERE p.onboarded_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.hangtag_members m WHERE m.user_id = p.id))::bigint
    UNION ALL
    SELECT 76, 'Business tables that refuse the app''s writes when a plan has ended',
           (SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE c.relnamespace = 'public'::regnamespace
               AND t.tgname = 'zz_hangtag_subscription_guard' AND NOT t.tgisinternal)::bigint,
           (SELECT count(*) FROM information_schema.columns c JOIN information_schema.tables tb ON tb.table_schema = c.table_schema AND tb.table_name = c.table_name
               AND tb.table_type = 'BASE TABLE' WHERE c.table_schema = 'public' AND c.column_name = 'owner_id' AND c.table_name LIKE 'hangtag\_%'
               AND c.table_name NOT LIKE 'hangtag\_backup\_%' AND c.table_name NOT IN ('hangtag_audit_log', 'hangtag_devices', 'hangtag_enrollments',
               'hangtag_subscriptions', 'hangtag_subscription_payments', 'hangtag_promo_redemptions', 'hangtag_trial_claims'))::bigint
    UNION ALL
    SELECT 77, 'Promo codes used only on paid plan payments',
           (SELECT count(*) FROM public.hangtag_promo_redemptions r JOIN public.hangtag_subscription_payments y ON y.id = r.payment_id
               WHERE y.status = 'paid' AND y.promo_code = r.code)::bigint,
           (SELECT count(*) FROM public.hangtag_promo_redemptions)::bigint
    UNION ALL
    SELECT 78, 'Returned lines can keep their own reason (column and saving)',
           (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'hangtag_return_items' AND column_name = 'reason')::bigint
             + (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'hangtag_save_return' AND p.prosrc LIKE '%reason = EXCLUDED.reason%')::bigint,
           2::bigint
) r ORDER BY n;
