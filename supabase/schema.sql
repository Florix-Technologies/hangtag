-- ==============================================================================
-- Hangtag Database Schema for Supabase (PostgreSQL)
-- Run this complete script in your Supabase project's SQL Editor (SQL Editor -> New Query).
-- It is safe to run again. If anything fails, nothing is changed.
--
-- Every account has its own shop: its own profile, products, variants (any options: colour, size, storage...),
-- stock history, supplier bills, bills, returns, customers and settings. Nobody can see or change another
-- account's data.
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
    FOREACH t IN ARRAY ARRAY['hangtag_products','hangtag_sizes','hangtag_images','hangtag_sales','hangtag_sale_items','hangtag_meta','hangtag_variants','hangtag_stock_moves','hangtag_customers','hangtag_returns','hangtag_return_items','hangtag_stock_imports'] LOOP
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
    public.hangtag_returns, public.hangtag_return_items, public.hangtag_stock_imports FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.hangtag_products, public.hangtag_sizes, public.hangtag_images,
    public.hangtag_sales, public.hangtag_sale_items, public.hangtag_meta,
    public.hangtag_variants, public.hangtag_stock_moves, public.hangtag_customers,
    public.hangtag_returns, public.hangtag_return_items, public.hangtag_stock_imports TO authenticated;
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
    SELECT 2, 'Old sizes that became variants',
           (SELECT count(*) FROM public.hangtag_backup_v2_sizes b WHERE EXISTS (SELECT 1 FROM public.hangtag_variants v WHERE v.owner_id = b.owner_id AND v.id = b.product_id || ':' || b.size))::bigint,
           (SELECT count(*) FROM public.hangtag_backup_v2_sizes b WHERE EXISTS (SELECT 1 FROM public.hangtag_products p WHERE p.owner_id = b.owner_id AND p.id = b.product_id))::bigint
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
) r ORDER BY n;
