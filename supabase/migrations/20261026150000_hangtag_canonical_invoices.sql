-- Requires: supabase/schema.sql (hangtag_sales, hangtag_deliveries, hangtag_shop_id(), hangtag_can()). Independent of the
-- repair, the post-repair migration and the shop payments migration: it adds a table and a column, touches no function.
-- ==============================================================================
-- Canonical invoices (2026-10-26): one PDF per bill, the same file on every channel.
--   1. hangtag_invoices: a bill's one invoice PDF. One row per bill (UNIQUE owner_id, sale_id), so however many phones or
--      channels ask at once, the first copy registered is the bill's invoice for good. The file itself is in the private
--      storage bucket "hangtag-invoices" at <shop>/<sha256>.pdf; the row keeps its hash, size, number and total. Written
--      only by the send-receipt Edge Function (service role), after it has checked the copy belongs to a saved, not
--      cancelled bill of the caller's shop. The shop reads its own rows (who may read its delivery records); no app
--      account can add, change or remove one, and no other shop or signed-out visitor can read one.
--   2. hangtag_deliveries.invoice_id: which invoice a message carried (attached by email, as a WhatsApp document, or as
--      the download link of an SMS), so a resend or a retry of a failed channel is seen to reuse the same invoice.
--   3. The private bucket: no access policies at all, so only the Edge Functions (service role) read or write its files;
--      the customer gets a file through a short-lived signed address (receipt function, invoice link token) only.
-- Run once, whole, in one transaction (the SQL Editor runs a script as one; with psql, `-1 -f`); running it again changes
-- nothing. It ends with a check that refuses to commit unless everything is in place. Undo:
-- supabase/operations/canonical-invoices-undo.sql (drops the column and the table; the bucket's files are kept).
-- ==============================================================================

CREATE TABLE IF NOT EXISTS public.hangtag_invoices (
    owner_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    id UUID NOT NULL DEFAULT gen_random_uuid(),
    sale_id TEXT NOT NULL,
    number TEXT NOT NULL CHECK (char_length(number) BETWEEN 1 AND 64),
    total NUMERIC(12,2) NOT NULL,
    sha256 TEXT NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    size_bytes INTEGER NOT NULL CHECK (size_bytes BETWEEN 200 AND 2097152),
    storage_path TEXT NOT NULL CHECK (storage_path ~ '^[0-9a-f-]{36}/[0-9a-f]{64}\.pdf$'),
    created_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (owner_id, id),
    CONSTRAINT hangtag_invoices_one_per_sale UNIQUE (owner_id, sale_id),
    CONSTRAINT hangtag_invoices_sale_fkey FOREIGN KEY (owner_id, sale_id) REFERENCES public.hangtag_sales (owner_id, id) ON DELETE CASCADE
);

ALTER TABLE public.hangtag_invoices ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Shop read" ON public.hangtag_invoices;
CREATE POLICY "Shop read" ON public.hangtag_invoices FOR SELECT TO authenticated
    USING (owner_id = (SELECT public.hangtag_shop_id())
       AND ((SELECT public.hangtag_can('create_sale')) OR (SELECT public.hangtag_can('view_reports')) OR (SELECT public.hangtag_can('create_order'))));
REVOKE ALL ON TABLE public.hangtag_invoices FROM anon, authenticated;
GRANT SELECT ON TABLE public.hangtag_invoices TO authenticated;

ALTER TABLE public.hangtag_deliveries ADD COLUMN IF NOT EXISTS invoice_id UUID;
ALTER TABLE public.hangtag_deliveries DROP CONSTRAINT IF EXISTS hangtag_deliveries_invoice_fkey;
ALTER TABLE public.hangtag_deliveries ADD CONSTRAINT hangtag_deliveries_invoice_fkey FOREIGN KEY (owner_id, invoice_id)
    REFERENCES public.hangtag_invoices (owner_id, id) ON DELETE SET NULL (invoice_id);

-- the private bucket (a Supabase project has the storage schema; a plain PostgreSQL test database doesn't)
DO $$
BEGIN
    IF to_regclass('storage.buckets') IS NOT NULL THEN
        INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
        VALUES ('hangtag-invoices', 'hangtag-invoices', false, 2097152, ARRAY['application/pdf'])
        ON CONFLICT (id) DO UPDATE SET public = false, file_size_limit = 2097152, allowed_mime_types = ARRAY['application/pdf'];
    END IF;
END $$;

-- The check: everything above is in place, or nothing is committed
DO $$
DECLARE missing TEXT[] := ARRAY[]::TEXT[];
BEGIN
    IF to_regclass('public.hangtag_invoices') IS NULL THEN missing := missing || 'table hangtag_invoices'; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = 'public.hangtag_invoices'::regclass AND relrowsecurity) THEN missing := missing || 'row security on hangtag_invoices'; END IF;
    IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'hangtag_invoices') <> 1 THEN missing := missing || 'exactly one policy (Shop read) on hangtag_invoices'; END IF;
    IF has_table_privilege('authenticated', 'public.hangtag_invoices', 'INSERT') OR has_table_privilege('authenticated', 'public.hangtag_invoices', 'UPDATE')
       OR has_table_privilege('authenticated', 'public.hangtag_invoices', 'DELETE') OR has_table_privilege('anon', 'public.hangtag_invoices', 'SELECT') THEN
        missing := missing || 'hangtag_invoices read-only for the app, closed to anon';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'hangtag_deliveries' AND column_name = 'invoice_id') THEN
        missing := missing || 'hangtag_deliveries.invoice_id';
    END IF;
    IF to_regclass('storage.buckets') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'hangtag-invoices' AND public = false) THEN
        missing := missing || 'private bucket hangtag-invoices';
    END IF;
    IF array_length(missing, 1) > 0 THEN RAISE EXCEPTION 'canonical invoices: not in place: %', array_to_string(missing, ', '); END IF;
    RAISE NOTICE 'canonical invoices: ok';
END $$;
