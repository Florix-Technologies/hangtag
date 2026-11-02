-- Undo of supabase/migrations/20261026150000_hangtag_canonical_invoices.sql. Run once, whole, in one transaction.
-- Delivery records keep every row (only their invoice_id column goes). The invoice rows go; their PDF files stay in the
-- private bucket "hangtag-invoices" (remove the bucket by hand in the dashboard if they are no longer wanted). Before
-- undoing, put the send-receipt and receipt functions back to their earlier version: the new ones read the table.
ALTER TABLE public.hangtag_deliveries DROP CONSTRAINT IF EXISTS hangtag_deliveries_invoice_fkey;
ALTER TABLE public.hangtag_deliveries DROP COLUMN IF EXISTS invoice_id;
DROP TABLE IF EXISTS public.hangtag_invoices;
