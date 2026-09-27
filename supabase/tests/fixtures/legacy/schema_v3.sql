-- ==============================================================================
-- Hangtag Database Schema for Supabase (PostgreSQL)
-- Run this complete script in your Supabase project's SQL Editor (SQL Editor -> New Query).
-- It is safe to run again. If anything fails, nothing is changed.
--
-- Every account has its own shop: its own profile, products, stock, photos and bills.
-- Nobody can see or change another account's data.
--
-- Sign-in setup (do these first):
--  1. Google Cloud Console -> APIs & Services -> Credentials -> your OAuth client (Web application)
--     -> Authorized redirect URIs: https://<project-ref>.supabase.co/auth/v1/callback
--  2. Supabase -> Authentication -> Sign In / Providers -> Google: on, with that client ID and secret.
--     Other services (Microsoft, Apple, GitHub, Facebook...) show up in the app when you switch them on here.
--  3. Supabase -> Authentication -> Sign In / Providers -> Email: switch OFF, so no accounts are made by
--     email and Supabase never sends verification emails.
--  4. Supabase -> Authentication -> URL Configuration: Site URL = the app address;
--     Redirect URLs = every address the app is opened from (GitHub Pages and http://localhost:3000/).
--  5. Sign in to the app once with the owner account below, then run this script.
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
    FOREACH t IN ARRAY ARRAY['hangtag_products','hangtag_sizes','hangtag_images','hangtag_sales','hangtag_sale_items','hangtag_meta'] LOOP
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
    public.hangtag_sales, public.hangtag_sale_items, public.hangtag_meta, public.hangtag_profiles FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.hangtag_products, public.hangtag_sizes, public.hangtag_images,
    public.hangtag_sales, public.hangtag_sale_items, public.hangtag_meta TO authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.hangtag_profiles TO authenticated;

-- ==============================================================================
-- 6. Realtime: live updates between a person's own phones and laptops
-- ==============================================================================
DO $$
BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE
        public.hangtag_products,
        public.hangtag_sizes,
        public.hangtag_images,
        public.hangtag_sales,
        public.hangtag_sale_items;
EXCEPTION WHEN OTHERS THEN
    NULL; -- already added
END $$;
