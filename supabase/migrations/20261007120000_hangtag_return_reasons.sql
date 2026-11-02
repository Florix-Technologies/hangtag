-- ==============================================================================
-- Hangtag: a reason for each returned line (schema.sql section 3u)
--   each line of a return keeps why it came back; RPC hangtag_save_return saves it
--
-- For the live database that supabase/schema.sql builds (the hangtag_* tables). It needs everything up to section 3t
-- (plans and subscriptions) already applied: run supabase/schema.sql once, or run this file after it. Safe to run again.
-- It is exactly section 3u of schema.sql, so running the whole schema.sql again gives the same result.
--
-- Requires: supabase/schema.sql (applied first; supabase/tests/returns-events.test.mjs checks what it does)
-- How to apply: Supabase → SQL Editor → New query → paste this file → Run (or supabase db push).
-- ==============================================================================

-- ==============================================================================
-- 3u. A reason for each returned line (after-sales)
--   Each line of a return keeps why it came back (Didn't fit, Wrong size, Didn't like it, Damaged or faulty, Other — or the
--   shop's own words, at most 60 characters): Reports count returns by reason and by product, and a damaged line is kept off
--   the shelf by default. The return's note still holds the reasons in words, so an app from before this keeps reading it.
--   Saving a return (RPC hangtag_save_return, as before: all or nothing, safe to retry, never on a cancelled bill) now
--   keeps each line's reason too. Safe to run again.
-- ==============================================================================
ALTER TABLE public.hangtag_return_items ADD COLUMN IF NOT EXISTS reason TEXT;
DO $$
BEGIN
    ALTER TABLE public.hangtag_return_items ADD CONSTRAINT hangtag_return_items_reason_len CHECK (reason IS NULL OR char_length(reason) <= 60);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE OR REPLACE FUNCTION public.hangtag_save_return(p_return JSONB, p_items JSONB)
RETURNS JSONB LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE
    uid UUID := public.hangtag_shop_id();
    r public.hangtag_returns;
    voided BOOLEAN;
    lines_value NUMERIC;
    n INT;
BEGIN
    IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Sign in to save returns.' USING ERRCODE = '42501'; END IF;
    IF uid IS NULL OR NOT public.hangtag_can('perform_return') THEN RAISE EXCEPTION 'Not allowed to save returns.' USING ERRCODE = '42501'; END IF;
    r := jsonb_populate_record(NULL::public.hangtag_returns, p_return);
    IF COALESCE(r.id, '') = '' THEN RAISE EXCEPTION 'A return has no id.' USING ERRCODE = '22023'; END IF;
    -- a team member only adds returns: one already saved stays exactly as it is (its retry saves nothing new)
    IF uid <> auth.uid() AND EXISTS (SELECT 1 FROM public.hangtag_returns x WHERE x.owner_id = uid AND x.id = r.id) THEN
        RETURN jsonb_build_object('status', 'saved', 'return', r.id, 'lines', (SELECT count(*) FROM public.hangtag_return_items i WHERE i.owner_id = uid AND i.return_id = r.id));
    END IF;
    SELECT is_void INTO voided FROM public.hangtag_sales WHERE owner_id = uid AND id = r.sale_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Bill % was not found', r.sale_id USING ERRCODE = 'foreign_key_violation';
    END IF;
    IF voided THEN
        RAISE EXCEPTION 'That bill is cancelled, so it can''t have a return' USING ERRCODE = 'check_violation';
    END IF;
    INSERT INTO public.hangtag_returns (id, sale_id, t, kind, exchange_id, refund_amount, refund_method, value, round_off, credit_no, note, device_id)
    VALUES (r.id, r.sale_id, r.t, COALESCE(r.kind, 'return'), r.exchange_id, COALESCE(r.refund_amount, 0), r.refund_method, COALESCE(r.value, 0),
        COALESCE(r.round_off, 0), r.credit_no, r.note, r.device_id)
    ON CONFLICT (owner_id, id) DO UPDATE SET sale_id = EXCLUDED.sale_id, t = EXCLUDED.t, kind = EXCLUDED.kind, exchange_id = EXCLUDED.exchange_id,
        refund_amount = EXCLUDED.refund_amount, refund_method = EXCLUDED.refund_method, value = EXCLUDED.value, round_off = EXCLUDED.round_off,
        credit_no = EXCLUDED.credit_no, note = EXCLUDED.note, device_id = EXCLUDED.device_id;
    DELETE FROM public.hangtag_return_items i WHERE i.owner_id = uid AND i.return_id = r.id
       AND i.line_no NOT IN (SELECT (y ->> 'line_no')::int FROM jsonb_array_elements(COALESCE(p_items, '[]'::jsonb)) y);
    INSERT INTO public.hangtag_return_items (return_id, line_no, sale_id, sale_line_no, variant_id, product_id, product_name, color, size, sku,
        quantity, unit_price, value, cost_price, variant_label, options, restock, taxable_value, gst_rate, cgst_amount, sgst_amount, igst_amount, hsn, serials, batches,
        reason)
    SELECT r.id, i.line_no, r.sale_id, i.sale_line_no, i.variant_id, i.product_id, i.product_name, COALESCE(i.color, ''), COALESCE(i.size, ''), i.sku,
        i.quantity, COALESCE(i.unit_price, 0), COALESCE(i.value, 0), i.cost_price, i.variant_label, i.options, COALESCE(i.restock, TRUE), i.taxable_value,
        i.gst_rate, COALESCE(i.cgst_amount, 0), COALESCE(i.sgst_amount, 0), COALESCE(i.igst_amount, 0), i.hsn, i.serials, i.batches,
        NULLIF(left(btrim(COALESCE(i.reason, '')), 60), '')
    FROM jsonb_populate_recordset(NULL::public.hangtag_return_items, COALESCE(p_items, '[]'::jsonb)) i
    ON CONFLICT (owner_id, return_id, line_no) DO UPDATE SET sale_id = EXCLUDED.sale_id, sale_line_no = EXCLUDED.sale_line_no,
        variant_id = EXCLUDED.variant_id, product_id = EXCLUDED.product_id, product_name = EXCLUDED.product_name, color = EXCLUDED.color,
        size = EXCLUDED.size, sku = EXCLUDED.sku, quantity = EXCLUDED.quantity, unit_price = EXCLUDED.unit_price, value = EXCLUDED.value,
        cost_price = EXCLUDED.cost_price, variant_label = EXCLUDED.variant_label, options = EXCLUDED.options, restock = EXCLUDED.restock,
        taxable_value = EXCLUDED.taxable_value, gst_rate = EXCLUDED.gst_rate, cgst_amount = EXCLUDED.cgst_amount, sgst_amount = EXCLUDED.sgst_amount,
        igst_amount = EXCLUDED.igst_amount, hsn = EXCLUDED.hsn, serials = EXCLUDED.serials, batches = EXCLUDED.batches, reason = EXCLUDED.reason;
    SELECT count(*), COALESCE(SUM(value), 0) INTO n, lines_value FROM public.hangtag_return_items WHERE owner_id = uid AND return_id = r.id;
    IF n = 0 THEN RAISE EXCEPTION 'A return needs at least one line' USING ERRCODE = 'check_violation'; END IF;
    IF COALESCE(r.value, 0) <> lines_value + COALESCE(r.round_off, 0) THEN
        RAISE EXCEPTION 'Return % is worth % but its lines come to %', COALESCE(r.credit_no, r.id), r.value, lines_value + COALESCE(r.round_off, 0)
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN jsonb_build_object('status', 'saved', 'return', r.id, 'lines', n);
END $$;
REVOKE ALL ON FUNCTION public.hangtag_save_return(JSONB, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.hangtag_save_return(JSONB, JSONB) TO authenticated;

