-- Numbers the lines of bills saved before line numbers existed (September 2026), once. On a database whose lines already
-- have their numbers (schema.sql's per-shop key hangtag_sale_items_owner_sale_line_key) this file changes nothing: numbering
-- again by id would reorder every bill's lines (ids are random) and break the returns that point at them, and the old
-- index would join two shops' bills.
ALTER TABLE public.hangtag_sale_items ADD COLUMN IF NOT EXISTS line_no INTEGER NOT NULL DEFAULT 0;
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hangtag_sale_items_owner_sale_line_key') THEN
        RETURN;
    END IF;
    UPDATE public.hangtag_sale_items t SET line_no = r.rn
    FROM (SELECT id, (row_number() OVER (PARTITION BY sale_id ORDER BY id)) - 1 AS rn FROM public.hangtag_sale_items) r
    WHERE t.id = r.id;
    CREATE UNIQUE INDEX IF NOT EXISTS uq_hangtag_sale_items_line ON public.hangtag_sale_items(sale_id, line_no);
END $$;
NOTIFY pgrst, 'reload schema';
