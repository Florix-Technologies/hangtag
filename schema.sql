-- ==============================================================================
-- Hangtag Database Schema for Supabase (PostgreSQL)
-- Run this complete script in your Supabase project's SQL Editor (SQL Editor -> New Query).
-- It is safe to run again after changes.
--
-- Sign-in setup (Supabase dashboard + Google Cloud), do these BEFORE running this script:
--  1. Google Cloud Console -> APIs & Services -> Credentials -> your OAuth client (Web application)
--     -> Authorized redirect URIs: https://<project-ref>.supabase.co/auth/v1/callback
--  2. Supabase -> Authentication -> Sign In / Providers -> Google: on, with that client ID and secret.
--  3. Supabase -> Authentication -> URL Configuration: Site URL = the app address;
--     Redirect URLs = every address the app is opened from (GitHub Pages and http://localhost:3000/).
--  4. Email sign-up and password reset: Supabase's built-in email only reaches your own team's
--     addresses. Set up your own SMTP (Authentication -> Emails -> SMTP Settings) for staff.
--  5. Optional, so email links work in any browser (not only the one that asked):
--     Authentication -> Emails -> Templates. Point the link at
--       Confirm signup:  {{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=email
--       Reset password:  {{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=recovery
-- After signing in once yourself, run this script. It limits all data to the access list below.
-- ==============================================================================

-- 1. Create Products Table
CREATE TABLE IF NOT EXISTS public.hangtag_products (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    price INTEGER NOT NULL DEFAULT 0,
    color TEXT DEFAULT '#8E8A83',
    sort_order INTEGER DEFAULT 0,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Create Product Sizes / Inventory Table
CREATE TABLE IF NOT EXISTS public.hangtag_sizes (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    product_id TEXT NOT NULL REFERENCES public.hangtag_products(id) ON DELETE CASCADE,
    size TEXT NOT NULL,
    stock INTEGER NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(product_id, size)
);

-- 3. Create Product Images Table (Thumbnails stored as base64 data URLs)
CREATE TABLE IF NOT EXISTS public.hangtag_images (
    product_id TEXT PRIMARY KEY REFERENCES public.hangtag_products(id) ON DELETE CASCADE,
    image_data TEXT NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. Create Sales / Bills Table
CREATE TABLE IF NOT EXISTS public.hangtag_sales (
    id TEXT PRIMARY KEY,
    timestamp BIGINT NOT NULL,
    subtotal INTEGER NOT NULL DEFAULT 0,
    discount INTEGER NOT NULL DEFAULT 0,
    total INTEGER NOT NULL DEFAULT 0,
    payment_method TEXT NOT NULL,
    device_id TEXT,
    is_void BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 5. Create Sale Line Items Table
CREATE TABLE IF NOT EXISTS public.hangtag_sale_items (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    sale_id TEXT NOT NULL REFERENCES public.hangtag_sales(id) ON DELETE CASCADE,
    line_no INTEGER NOT NULL DEFAULT 0,
    product_id TEXT NOT NULL,
    product_name TEXT NOT NULL,
    size TEXT NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 1,
    unit_price INTEGER NOT NULL DEFAULT 0
);
-- Upgrades databases created before line_no existed. One row per bill line, so re-uploads never duplicate.
ALTER TABLE public.hangtag_sale_items ADD COLUMN IF NOT EXISTS line_no INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX IF NOT EXISTS uq_hangtag_sale_items_line ON public.hangtag_sale_items(sale_id, line_no);

-- 6. Create Metadata Table (Catalog settings, etc.)
CREATE TABLE IF NOT EXISTS public.hangtag_meta (
    key TEXT PRIMARY KEY,
    value JSONB,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ==============================================================================
-- Indexes for High Performance Querying & Reports
-- ==============================================================================
CREATE INDEX IF NOT EXISTS idx_hangtag_sizes_prod ON public.hangtag_sizes(product_id);
CREATE INDEX IF NOT EXISTS idx_hangtag_sales_time ON public.hangtag_sales(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_hangtag_sale_items_sale ON public.hangtag_sale_items(sale_id);
CREATE INDEX IF NOT EXISTS idx_hangtag_sale_items_prod ON public.hangtag_sale_items(product_id);

-- ==============================================================================
-- Access list: only these Google accounts can use Hangtag.
-- Add a person:    INSERT INTO public.hangtag_allowed_users (email) VALUES (lower('someone@gmail.com'));
-- Remove a person: DELETE FROM public.hangtag_allowed_users WHERE email = lower('someone@gmail.com');
-- Emails are stored in lowercase so adding and removing always match.
-- ==============================================================================
CREATE TABLE IF NOT EXISTS public.hangtag_allowed_users (
    email TEXT PRIMARY KEY CHECK (email = lower(btrim(email))),
    added_at TIMESTAMPTZ DEFAULT NOW()
);
-- RLS on with no policies: the app can't read or edit the list, only this SQL Editor can.
ALTER TABLE public.hangtag_allowed_users ENABLE ROW LEVEL SECURITY;

-- The shop owner. Change this if you sign in with a different Google account.
INSERT INTO public.hangtag_allowed_users (email) VALUES ('florixenergy@gmail.com') ON CONFLICT DO NOTHING;

-- True when the signed-in Google account is on the access list
CREATE OR REPLACE FUNCTION public.hangtag_is_allowed()
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.hangtag_allowed_users
        WHERE email = lower(btrim(auth.jwt() ->> 'email'))
    );
$$;
REVOKE EXECUTE ON FUNCTION public.hangtag_is_allowed() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.hangtag_is_allowed() TO authenticated;

-- ==============================================================================
-- Row Level Security (RLS): signed-in accounts on the access list only.
-- Safe to re-run: replaces the old open "Public access" policies.
-- ==============================================================================
ALTER TABLE public.hangtag_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hangtag_sizes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hangtag_images ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hangtag_sales ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hangtag_sale_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hangtag_meta ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['hangtag_products','hangtag_sizes','hangtag_images','hangtag_sales','hangtag_sale_items','hangtag_meta'] LOOP
        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'Public access to ' || t, t);
        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'Approved staff access to ' || t, t);
        EXECUTE format(
            'CREATE POLICY %I ON public.%I FOR ALL TO authenticated USING ((SELECT public.hangtag_is_allowed())) WITH CHECK ((SELECT public.hangtag_is_allowed()))',
            'Approved staff access to ' || t, t);
    END LOOP;
END $$;

-- Signed-out visitors (the "anon" role, i.e. just the public key) get no table access at all.
-- Their requests fail loudly instead of quietly returning nothing, so the app keeps unsent work queued.
REVOKE ALL ON TABLE public.hangtag_products, public.hangtag_sizes, public.hangtag_images,
    public.hangtag_sales, public.hangtag_sale_items, public.hangtag_meta, public.hangtag_allowed_users FROM anon;
REVOKE ALL ON TABLE public.hangtag_allowed_users FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.hangtag_products, public.hangtag_sizes, public.hangtag_images,
    public.hangtag_sales, public.hangtag_sale_items, public.hangtag_meta TO authenticated;

-- ==============================================================================
-- Enable Realtime for Live Multi-Device Sync
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
    NULL; -- Skip if already added
END $$;
