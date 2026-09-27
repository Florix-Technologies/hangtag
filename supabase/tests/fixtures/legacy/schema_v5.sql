-- ==============================================================================
-- Hangtag Database Schema for Supabase (PostgreSQL)
-- Run this complete script in your Supabase project's SQL Editor (SQL Editor -> New Query).
-- It is safe to run again. If anything fails, nothing is changed.
--
-- Every account has its own shop: its own profile, products, variants (colour + size), stock history,
-- bills, returns, customers and settings. Nobody can see or change another account's data.
-- The first run of the variant upgrade keeps a copy of the old product, size and bill tables
-- (hangtag_backup_v2_*) and ends with a migration report you can check.
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
CREATE UNIQUE INDEX IF NOT EXISTS uq_hangtag_variants_combo ON public.hangtag_variants (owner_id, product_id, color, size);
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
UPDATE public.hangtag_products p
SET options = jsonb_build_object('colors', '[]'::jsonb, 'sizes', COALESCE((
        SELECT jsonb_agg(v.size ORDER BY COALESCE(array_position(ARRAY['XXS','XS','S','M','L','XL','XXL','2XL','XXXL','3XL','4XL','5XL'], upper(v.size))::numeric,
                                                   CASE WHEN v.size ~ '^[0-9]+(\.[0-9]+)?$' THEN 100 + v.size::numeric ELSE 1000 END), v.size)
        FROM public.hangtag_variants v WHERE v.owner_id = p.owner_id AND v.product_id = p.id AND v.size <> ''), '[]'::jsonb))
WHERE p.options IS NULL OR p.options = '{}'::jsonb;
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
    FOREACH t IN ARRAY ARRAY['hangtag_products','hangtag_sizes','hangtag_images','hangtag_sales','hangtag_sale_items','hangtag_meta','hangtag_variants','hangtag_stock_moves','hangtag_customers','hangtag_returns','hangtag_return_items'] LOOP
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
    public.hangtag_returns, public.hangtag_return_items FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.hangtag_products, public.hangtag_sizes, public.hangtag_images,
    public.hangtag_sales, public.hangtag_sale_items, public.hangtag_meta,
    public.hangtag_variants, public.hangtag_stock_moves, public.hangtag_customers,
    public.hangtag_returns, public.hangtag_return_items TO authenticated;
REVOKE EXECUTE ON FUNCTION public.hangtag_check_return_qty() FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE ON TABLE public.hangtag_profiles TO authenticated;

-- ==============================================================================
-- 6. Realtime: live updates between a person's own phones and laptops
-- ==============================================================================
DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['hangtag_products','hangtag_sizes','hangtag_images','hangtag_sales','hangtag_sale_items',
                             'hangtag_variants','hangtag_stock_moves','hangtag_customers','hangtag_returns','hangtag_return_items','hangtag_meta'] LOOP
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
) r ORDER BY n;
