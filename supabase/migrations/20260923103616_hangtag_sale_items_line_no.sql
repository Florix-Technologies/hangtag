ALTER TABLE public.hangtag_sale_items ADD COLUMN IF NOT EXISTS line_no INTEGER NOT NULL DEFAULT 0;
UPDATE public.hangtag_sale_items t SET line_no = r.rn
FROM (SELECT id, (row_number() OVER (PARTITION BY sale_id ORDER BY id)) - 1 AS rn FROM public.hangtag_sale_items) r
WHERE t.id = r.id;
CREATE UNIQUE INDEX IF NOT EXISTS uq_hangtag_sale_items_line ON public.hangtag_sale_items(sale_id, line_no);
NOTIFY pgrst, 'reload schema';
