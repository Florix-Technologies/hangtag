-- ==============================================================================
-- Hangtag Database Schema for Supabase (PostgreSQL)
-- Run this complete script in your Supabase project's SQL Editor (SQL Editor -> New Query)
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
-- Row Level Security (RLS) Policies (Permits read/write with Supabase Anon Key)
-- ==============================================================================
ALTER TABLE public.hangtag_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hangtag_sizes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hangtag_images ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hangtag_sales ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hangtag_sale_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hangtag_meta ENABLE ROW LEVEL SECURITY;

DO $$ 
BEGIN
    -- Products
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Public access to hangtag_products') THEN
        CREATE POLICY "Public access to hangtag_products" ON public.hangtag_products FOR ALL USING (true) WITH CHECK (true);
    END IF;
    -- Sizes
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Public access to hangtag_sizes') THEN
        CREATE POLICY "Public access to hangtag_sizes" ON public.hangtag_sizes FOR ALL USING (true) WITH CHECK (true);
    END IF;
    -- Images
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Public access to hangtag_images') THEN
        CREATE POLICY "Public access to hangtag_images" ON public.hangtag_images FOR ALL USING (true) WITH CHECK (true);
    END IF;
    -- Sales
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Public access to hangtag_sales') THEN
        CREATE POLICY "Public access to hangtag_sales" ON public.hangtag_sales FOR ALL USING (true) WITH CHECK (true);
    END IF;
    -- Sale Items
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Public access to hangtag_sale_items') THEN
        CREATE POLICY "Public access to hangtag_sale_items" ON public.hangtag_sale_items FOR ALL USING (true) WITH CHECK (true);
    END IF;
    -- Meta
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Public access to hangtag_meta') THEN
        CREATE POLICY "Public access to hangtag_meta" ON public.hangtag_meta FOR ALL USING (true) WITH CHECK (true);
    END IF;
END $$;

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
