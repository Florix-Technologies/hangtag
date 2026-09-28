-- ==============================================================================
-- Hangtag Database Schema for Supabase (PostgreSQL)
-- Run this complete script in your Supabase project's SQL Editor (SQL Editor -> New Query).
-- It is safe to run again. If anything fails, nothing is changed.
--
-- Every account has its own shop: its own profile, products, variants (any options: colour, size, storage...),
-- stock history, supplier bills, bills (with their discounts, GST and payments), cash and bank books, returns,
-- customers, bills sent to customers, logo and settings. Nobody can see or change another account's data.
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
-- saved, or none are (any error undoes everything). Runs with the caller's own rights, so row security applies.
-- The same import id twice is a safe retry. The same file, or the same supplier + invoice number, is refused as a
-- likely repeat unless p_allow_duplicate is true.
CREATE OR REPLACE FUNCTION public.hangtag_import_stock(p_import JSONB, p_products JSONB, p_variants JSONB, p_moves JSONB, p_allow_duplicate BOOLEAN DEFAULT FALSE)
RETURNS JSONB LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE
    uid UUID := auth.uid(); imp TEXT := p_import ->> 'id'; d RECORD; r JSONB;
    n_p INT := 0; n_v INT := 0; n_m INT := 0; n_units INT := 0;
    inv TEXT := lower(btrim(COALESCE(p_import ->> 'invoice_no', '')));
    gst TEXT := lower(btrim(COALESCE(p_import ->> 'supplier_gstin', '')));
    sup TEXT := lower(btrim(COALESCE(p_import ->> 'supplier_name', '')));
BEGIN
    IF uid IS NULL THEN RAISE EXCEPTION 'Sign in to add stock.' USING ERRCODE = '42501'; END IF;
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
        INSERT INTO public.hangtag_bank_book (owner_id, id, fin_txn_id, sale_id, method, entry_type, reference, amount_in, status, t)
        VALUES (NEW.owner_id, 'bb:' || ft, ft, NEW.sale_id, NEW.method, 'receipt', NEW.reference, NEW.amount, st, NEW.t)
        ON CONFLICT (owner_id, id) DO UPDATE SET method = EXCLUDED.method, reference = EXCLUDED.reference, amount_in = EXCLUDED.amount_in,
            status = EXCLUDED.status, t = EXCLUDED.t;
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

-- Saves bills with their lines and payments, all or nothing. Runs with the caller's own rights (row security applies).
-- p_bills: [{ sale: {hangtag_sales columns}, items: [{hangtag_sale_items columns}], payments: [{hangtag_payments columns}] }]
-- Saving the same bill again updates it (a safe retry), and payments no longer on it are removed. Each bill's
-- payments must add up to exactly what was due, or nothing is saved.
CREATE OR REPLACE FUNCTION public.hangtag_save_sales(p_bills JSONB)
RETURNS JSONB LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE
    uid UUID := auth.uid();
    b JSONB;
    s public.hangtag_sales;
    voided BOOLEAN;
    due NUMERIC;
    paid NUMERIC;
    n INT := 0;
BEGIN
    IF uid IS NULL THEN RAISE EXCEPTION 'Sign in to save bills.' USING ERRCODE = '42501'; END IF;
    FOR b IN SELECT * FROM jsonb_array_elements(COALESCE(p_bills, '[]'::jsonb)) LOOP
        s := jsonb_populate_record(NULL::public.hangtag_sales, b -> 'sale');
        IF COALESCE(s.id, '') = '' THEN RAISE EXCEPTION 'A bill has no id.' USING ERRCODE = '22023'; END IF;
        INSERT INTO public.hangtag_sales (id, timestamp, subtotal, discount, total, payment_method, device_id, is_void, bill_no,
            customer_id, customer_name, customer_phone, tax_rate, tax_amount, tax_inclusive, kind, exchange_id, credit,
            item_discount, bill_discount, bill_discount_type, bill_discount_value, taxable_amount, cgst_amount, sgst_amount, igst_amount,
            round_off, gst_mode, place_of_supply, customer_gstin, customer_type)
        VALUES (s.id, s.timestamp, COALESCE(s.subtotal, 0), COALESCE(s.discount, 0), COALESCE(s.total, 0), s.payment_method, s.device_id,
            COALESCE(s.is_void, FALSE), s.bill_no, s.customer_id, s.customer_name, s.customer_phone, COALESCE(s.tax_rate, 0),
            COALESCE(s.tax_amount, 0), COALESCE(s.tax_inclusive, TRUE), COALESCE(s.kind, 'sale'), s.exchange_id, COALESCE(s.credit, 0),
            COALESCE(s.item_discount, 0), COALESCE(s.bill_discount, 0), s.bill_discount_type, s.bill_discount_value, s.taxable_amount,
            COALESCE(s.cgst_amount, 0), COALESCE(s.sgst_amount, 0), COALESCE(s.igst_amount, 0), COALESCE(s.round_off, 0),
            s.gst_mode, s.place_of_supply, s.customer_gstin, s.customer_type)
        ON CONFLICT (owner_id, id) DO UPDATE SET timestamp = EXCLUDED.timestamp, subtotal = EXCLUDED.subtotal, discount = EXCLUDED.discount,
            total = EXCLUDED.total, payment_method = EXCLUDED.payment_method, device_id = EXCLUDED.device_id, is_void = EXCLUDED.is_void,
            bill_no = EXCLUDED.bill_no, customer_id = EXCLUDED.customer_id, customer_name = EXCLUDED.customer_name,
            customer_phone = EXCLUDED.customer_phone, tax_rate = EXCLUDED.tax_rate, tax_amount = EXCLUDED.tax_amount,
            tax_inclusive = EXCLUDED.tax_inclusive, kind = EXCLUDED.kind, exchange_id = EXCLUDED.exchange_id, credit = EXCLUDED.credit,
            item_discount = EXCLUDED.item_discount, bill_discount = EXCLUDED.bill_discount, bill_discount_type = EXCLUDED.bill_discount_type,
            bill_discount_value = EXCLUDED.bill_discount_value, taxable_amount = EXCLUDED.taxable_amount, cgst_amount = EXCLUDED.cgst_amount,
            sgst_amount = EXCLUDED.sgst_amount, igst_amount = EXCLUDED.igst_amount, round_off = EXCLUDED.round_off, gst_mode = EXCLUDED.gst_mode,
            place_of_supply = EXCLUDED.place_of_supply, customer_gstin = EXCLUDED.customer_gstin, customer_type = EXCLUDED.customer_type;
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
        INSERT INTO public.hangtag_payments (id, sale_id, method, amount, tendered, change_given, reference, status, t, device_id)
        SELECT p.id, s.id, p.method, p.amount, p.tendered, COALESCE(p.change_given, 0), NULLIF(btrim(p.reference), ''),
            CASE WHEN voided THEN 'cancelled' ELSE 'completed' END, COALESCE(p.t, s.timestamp), p.device_id
        FROM jsonb_populate_recordset(NULL::public.hangtag_payments, COALESCE(b -> 'payments', '[]'::jsonb)) p
        ON CONFLICT (owner_id, id) DO UPDATE SET method = EXCLUDED.method, amount = EXCLUDED.amount, tendered = EXCLUDED.tendered,
            change_given = EXCLUDED.change_given, reference = EXCLUDED.reference, status = EXCLUDED.status, t = EXCLUDED.t,
            device_id = EXCLUDED.device_id;
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
-- 4. Indexes for reports
-- ==============================================================================
DROP INDEX IF EXISTS public.idx_hangtag_sizes_prod;
DROP INDEX IF EXISTS public.idx_hangtag_sales_time;
DROP INDEX IF EXISTS public.idx_hangtag_sale_items_sale;
CREATE INDEX IF NOT EXISTS idx_hangtag_sales_owner_time ON public.hangtag_sales (owner_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_hangtag_sale_items_prod ON public.hangtag_sale_items (product_id);

-- ==============================================================================
-- 5. Row Level Security: each signed-in account sees and changes only its own rows.
--    Replaces the older "Public access" and "Approved staff access" rules.
-- ==============================================================================
DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['hangtag_products','hangtag_sizes','hangtag_images','hangtag_sales','hangtag_sale_items','hangtag_meta','hangtag_variants','hangtag_stock_moves','hangtag_customers','hangtag_returns','hangtag_return_items','hangtag_stock_imports',
                     'hangtag_payments','hangtag_fin_txns','hangtag_cash_book','hangtag_bank_book','hangtag_deliveries'] LOOP
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'Public access to ' || t, t);
        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'Approved staff access to ' || t, t);
        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'Own rows only', t);
        EXECUTE format(
            'CREATE POLICY %I ON public.%I FOR ALL TO authenticated USING (owner_id = (SELECT auth.uid())) WITH CHECK (owner_id = (SELECT auth.uid()))',
            'Own rows only', t);
    END LOOP;
END $$;

ALTER TABLE public.hangtag_profiles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Own profile: read" ON public.hangtag_profiles;
DROP POLICY IF EXISTS "Own profile: add" ON public.hangtag_profiles;
DROP POLICY IF EXISTS "Own profile: change" ON public.hangtag_profiles;
CREATE POLICY "Own profile: read" ON public.hangtag_profiles FOR SELECT TO authenticated USING (id = (SELECT auth.uid()));
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
    public.hangtag_payments, public.hangtag_fin_txns, public.hangtag_cash_book, public.hangtag_bank_book, public.hangtag_deliveries FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.hangtag_products, public.hangtag_sizes, public.hangtag_images,
    public.hangtag_sales, public.hangtag_sale_items, public.hangtag_meta,
    public.hangtag_variants, public.hangtag_stock_moves, public.hangtag_customers,
    public.hangtag_returns, public.hangtag_return_items, public.hangtag_stock_imports, public.hangtag_payments TO authenticated;
-- Financial transactions and the cash and bank books are written only by the database (section 3e), and delivery
-- records only by the send-receipt Edge Function (section 3f): read-only here
REVOKE ALL ON TABLE public.hangtag_fin_txns, public.hangtag_cash_book, public.hangtag_bank_book, public.hangtag_deliveries FROM authenticated;
GRANT SELECT ON TABLE public.hangtag_fin_txns, public.hangtag_cash_book, public.hangtag_bank_book, public.hangtag_deliveries TO authenticated;
REVOKE EXECUTE ON FUNCTION public.hangtag_check_return_qty() FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE ON TABLE public.hangtag_profiles TO authenticated;

-- ==============================================================================
-- 6. Realtime: live updates between a person's own phones and laptops
-- ==============================================================================
DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['hangtag_products','hangtag_sizes','hangtag_images','hangtag_sales','hangtag_sale_items',
                             'hangtag_variants','hangtag_stock_moves','hangtag_customers','hangtag_returns','hangtag_return_items','hangtag_meta','hangtag_stock_imports'] LOOP
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
    SELECT 10, 'Bills whose payments add up to what was due',
           (SELECT count(*) FROM public.hangtag_sales s WHERE (SELECT COALESCE(sum(p.amount), 0) FROM public.hangtag_payments p
              WHERE p.owner_id = s.owner_id AND p.sale_id = s.id) = GREATEST(s.total - s.credit, 0))::bigint,
           (SELECT count(*) FROM public.hangtag_sales)::bigint
    UNION ALL
    SELECT 11, 'Payments posted as a financial transaction',
           (SELECT count(*) FROM public.hangtag_payments p WHERE EXISTS (SELECT 1 FROM public.hangtag_fin_txns f WHERE f.owner_id = p.owner_id AND f.payment_id = p.id))::bigint,
           (SELECT count(*) FROM public.hangtag_payments)::bigint
    UNION ALL
    SELECT 12, 'Refunds posted as a financial transaction',
           (SELECT count(*) FROM public.hangtag_returns r WHERE EXISTS (SELECT 1 FROM public.hangtag_fin_txns f WHERE f.owner_id = r.owner_id AND f.return_id = r.id))::bigint,
           (SELECT count(*) FROM public.hangtag_returns r WHERE r.refund_amount > 0 AND r.refund_method IN ('cash','upi','card'))::bigint
    UNION ALL
    SELECT 13, 'Financial transactions in the cash or bank book',
           (SELECT count(*) FROM public.hangtag_fin_txns f WHERE EXISTS (SELECT 1 FROM public.hangtag_cash_book c WHERE c.owner_id = f.owner_id AND c.fin_txn_id = f.id)
              OR EXISTS (SELECT 1 FROM public.hangtag_bank_book b WHERE b.owner_id = f.owner_id AND b.fin_txn_id = f.id))::bigint,
           (SELECT count(*) FROM public.hangtag_fin_txns)::bigint
) r ORDER BY n;
