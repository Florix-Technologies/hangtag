-- Hangtag: billing integrity — a cancelled bill stays cancelled when a till sends it again; a bill with a return can't be cancelled.
-- Exactly section 3y of supabase/schema.sql. Needs section 3r (hangtag_save_sales) first.
-- Requires: supabase/schema.sql (applied first)
-- Run it in the Supabase SQL Editor; safe to run again. Then the report at the end of schema.sql: row 90.

-- ==============================================================================
-- 3y. Billing integrity: a cancelled bill stays cancelled when sent again; a bill with a return can't be cancelled
--   A till keeps a bill in its queue until the cloud confirms it, and sends it again when the confirmation is lost (a
--   dropped connection) or when it uploads every bill (after a restore). The bill may have been cancelled in the meantime,
--   on another till or on this one. Sending it again must not bring it back: its stock would leave the shelf a second time
--   and its payments come back into the cash and bank books. So a bill's upload may cancel it but never un-cancels it, and
--   keeps its reason for cancelling; only Restore (the app setting is_void back, with the cancel_bill permission) does.
--   (Everything else about saving bills is as in section 3r: all or nothing, payments that add up to what is due.)
--   A bill with a return or exchange, and the new bill of an exchange, can't be cancelled: the credit note's money (refunded,
--   or paid for the new bill) would be left pointing at nothing. The app refuses it; so does the database when a till that
--   hasn't seen the return yet sends the cancel. A till's upload of a whole bill leaves such a bill as it is instead (the
--   upload goes through, so the till's queue never sticks on it).
-- ==============================================================================
CREATE OR REPLACE FUNCTION public.hangtag_save_sales(p_bills JSONB)
RETURNS JSONB LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE
    uid UUID := public.hangtag_shop_id();
    member BOOLEAN;
    b JSONB;
    s public.hangtag_sales;
    voided BOOLEAN;
    due NUMERIC;
    paid NUMERIC;
    n INT := 0;
BEGIN
    IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Sign in to save bills.' USING ERRCODE = '42501'; END IF;
    IF uid IS NULL OR NOT public.hangtag_can('create_sale') THEN RAISE EXCEPTION 'Not allowed to save bills.' USING ERRCODE = '42501'; END IF;
    member := uid <> auth.uid();
    PERFORM set_config('hangtag.bill_upload', 'on', true);
    FOR b IN SELECT * FROM jsonb_array_elements(COALESCE(p_bills, '[]'::jsonb)) LOOP
        s := jsonb_populate_record(NULL::public.hangtag_sales, b -> 'sale');
        IF COALESCE(s.id, '') = '' THEN RAISE EXCEPTION 'A bill has no id.' USING ERRCODE = '22023'; END IF;
        IF member AND EXISTS (SELECT 1 FROM public.hangtag_sales x WHERE x.owner_id = uid AND x.id = s.id) THEN n := n + 1; CONTINUE; END IF;
        INSERT INTO public.hangtag_sales (id, timestamp, subtotal, discount, total, payment_method, device_id, is_void, bill_no,
            customer_id, customer_name, customer_phone, tax_rate, tax_amount, tax_inclusive, kind, exchange_id, credit,
            item_discount, bill_discount, bill_discount_type, bill_discount_value, taxable_amount, cgst_amount, sgst_amount, igst_amount,
            round_off, gst_mode, place_of_supply, customer_gstin, customer_type, event_id, due_amount, order_id, table_id, session_id)
        VALUES (s.id, s.timestamp, COALESCE(s.subtotal, 0), COALESCE(s.discount, 0), COALESCE(s.total, 0), s.payment_method, s.device_id,
            COALESCE(s.is_void, FALSE), s.bill_no, s.customer_id, s.customer_name, s.customer_phone, COALESCE(s.tax_rate, 0),
            COALESCE(s.tax_amount, 0), COALESCE(s.tax_inclusive, TRUE), COALESCE(s.kind, 'sale'), s.exchange_id, COALESCE(s.credit, 0),
            COALESCE(s.item_discount, 0), COALESCE(s.bill_discount, 0), s.bill_discount_type, s.bill_discount_value, s.taxable_amount,
            COALESCE(s.cgst_amount, 0), COALESCE(s.sgst_amount, 0), COALESCE(s.igst_amount, 0), COALESCE(s.round_off, 0),
            s.gst_mode, s.place_of_supply, s.customer_gstin, s.customer_type, s.event_id, COALESCE(s.due_amount, 0), s.order_id, s.table_id, s.session_id)
        ON CONFLICT (owner_id, id) DO UPDATE SET timestamp = EXCLUDED.timestamp, subtotal = EXCLUDED.subtotal, discount = EXCLUDED.discount,
            total = EXCLUDED.total, payment_method = EXCLUDED.payment_method, device_id = EXCLUDED.device_id, is_void = hangtag_sales.is_void OR EXCLUDED.is_void,
            void_reason = CASE WHEN hangtag_sales.is_void OR EXCLUDED.is_void THEN hangtag_sales.void_reason END,
            bill_no = EXCLUDED.bill_no, customer_id = EXCLUDED.customer_id, customer_name = EXCLUDED.customer_name,
            customer_phone = EXCLUDED.customer_phone, tax_rate = EXCLUDED.tax_rate, tax_amount = EXCLUDED.tax_amount,
            tax_inclusive = EXCLUDED.tax_inclusive, kind = EXCLUDED.kind, exchange_id = EXCLUDED.exchange_id, credit = EXCLUDED.credit,
            item_discount = EXCLUDED.item_discount, bill_discount = EXCLUDED.bill_discount, bill_discount_type = EXCLUDED.bill_discount_type,
            bill_discount_value = EXCLUDED.bill_discount_value, taxable_amount = EXCLUDED.taxable_amount, cgst_amount = EXCLUDED.cgst_amount,
            sgst_amount = EXCLUDED.sgst_amount, igst_amount = EXCLUDED.igst_amount, round_off = EXCLUDED.round_off, gst_mode = EXCLUDED.gst_mode,
            place_of_supply = EXCLUDED.place_of_supply, customer_gstin = EXCLUDED.customer_gstin, customer_type = EXCLUDED.customer_type,
            event_id = EXCLUDED.event_id, due_amount = EXCLUDED.due_amount, order_id = EXCLUDED.order_id, table_id = EXCLUDED.table_id, session_id = EXCLUDED.session_id;
        INSERT INTO public.hangtag_sale_items (sale_id, line_no, product_id, product_name, size, quantity, unit_price, variant_id, color, sku,
            cost_price, variant_label, options, discount_type, discount_value, discount_amount, bill_discount_share, taxable_value, gst_rate,
            cgst_amount, sgst_amount, igst_amount, line_total, hsn, serials, batches, kit)
        SELECT s.id, i.line_no, i.product_id, i.product_name, COALESCE(i.size, ''), COALESCE(i.quantity, 1), COALESCE(i.unit_price, 0),
            i.variant_id, COALESCE(i.color, ''), i.sku, i.cost_price, i.variant_label, i.options, i.discount_type, i.discount_value,
            COALESCE(i.discount_amount, 0), COALESCE(i.bill_discount_share, 0), i.taxable_value, i.gst_rate, COALESCE(i.cgst_amount, 0),
            COALESCE(i.sgst_amount, 0), COALESCE(i.igst_amount, 0), i.line_total, i.hsn, i.serials, i.batches, i.kit
        FROM jsonb_populate_recordset(NULL::public.hangtag_sale_items, COALESCE(b -> 'items', '[]'::jsonb)) i
        ON CONFLICT (owner_id, sale_id, line_no) DO UPDATE SET product_id = EXCLUDED.product_id, product_name = EXCLUDED.product_name,
            size = EXCLUDED.size, quantity = EXCLUDED.quantity, unit_price = EXCLUDED.unit_price, variant_id = EXCLUDED.variant_id,
            color = EXCLUDED.color, sku = EXCLUDED.sku, cost_price = EXCLUDED.cost_price, variant_label = EXCLUDED.variant_label,
            options = EXCLUDED.options, discount_type = EXCLUDED.discount_type, discount_value = EXCLUDED.discount_value,
            discount_amount = EXCLUDED.discount_amount, bill_discount_share = EXCLUDED.bill_discount_share, taxable_value = EXCLUDED.taxable_value,
            gst_rate = EXCLUDED.gst_rate, cgst_amount = EXCLUDED.cgst_amount, sgst_amount = EXCLUDED.sgst_amount,
            igst_amount = EXCLUDED.igst_amount, line_total = EXCLUDED.line_total, hsn = EXCLUDED.hsn, serials = EXCLUDED.serials, batches = EXCLUDED.batches, kit = EXCLUDED.kit;
        SELECT x.is_void, GREATEST(x.total - x.credit - x.due_amount, 0) INTO voided, due FROM public.hangtag_sales x WHERE x.owner_id = uid AND x.id = s.id;
        DELETE FROM public.hangtag_payments p WHERE p.owner_id = uid AND p.sale_id = s.id
           AND p.id NOT IN (SELECT y ->> 'id' FROM jsonb_array_elements(COALESCE(b -> 'payments', '[]'::jsonb)) y);
        INSERT INTO public.hangtag_payments (id, sale_id, method, amount, tendered, change_given, reference, status, t, device_id,
            verification, via, intent_id, provider_payment_id, card_last4)
        SELECT p.id, s.id, p.method, p.amount, p.tendered, COALESCE(p.change_given, 0), NULLIF(btrim(p.reference), ''),
            CASE WHEN voided THEN 'cancelled' ELSE 'completed' END, COALESCE(p.t, s.timestamp), p.device_id,
            COALESCE(p.verification, 'recorded'), p.via, p.intent_id, p.provider_payment_id, NULLIF(btrim(p.card_last4), '')
        FROM jsonb_populate_recordset(NULL::public.hangtag_payments, COALESCE(b -> 'payments', '[]'::jsonb)) p
        ON CONFLICT (owner_id, id) DO UPDATE SET method = EXCLUDED.method, amount = EXCLUDED.amount, tendered = EXCLUDED.tendered,
            change_given = EXCLUDED.change_given, reference = EXCLUDED.reference, status = EXCLUDED.status, t = EXCLUDED.t,
            device_id = EXCLUDED.device_id, via = EXCLUDED.via, card_last4 = EXCLUDED.card_last4,
            verification = CASE WHEN hangtag_payments.verification = 'verified' THEN 'verified' ELSE EXCLUDED.verification END,
            intent_id = COALESCE(EXCLUDED.intent_id, hangtag_payments.intent_id),
            provider_payment_id = COALESCE(EXCLUDED.provider_payment_id, hangtag_payments.provider_payment_id);
        SELECT COALESCE(SUM(amount), 0) INTO paid FROM public.hangtag_payments WHERE owner_id = uid AND sale_id = s.id;
        IF paid <> due THEN
            RAISE EXCEPTION 'The payments on bill % come to % but % is due', COALESCE(s.bill_no, s.id), paid, due USING ERRCODE = 'check_violation';
        END IF;
        n := n + 1;
    END LOOP;
    PERFORM set_config('hangtag.bill_upload', 'off', true);
    RETURN jsonb_build_object('status', 'saved', 'bills', n);
END $$;
REVOKE ALL ON FUNCTION public.hangtag_save_sales(JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.hangtag_save_sales(JSONB) TO authenticated;

-- A bill with a return or exchange (or an exchange's new bill) is never cancelled: a cancel is refused, an upload leaves it
CREATE OR REPLACE FUNCTION public.hangtag_sale_cancel_check()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
    IF NEW.is_void AND NOT OLD.is_void AND (NEW.kind = 'exchange'
        OR EXISTS (SELECT 1 FROM public.hangtag_returns r WHERE r.owner_id = NEW.owner_id AND r.sale_id = NEW.id)) THEN
        IF current_setting('hangtag.bill_upload', true) = 'on' THEN
            NEW.is_void := FALSE; NEW.void_reason := NULL;
            RETURN NEW;
        END IF;
        RAISE EXCEPTION 'Bill % has a return or exchange, so it can''t be cancelled. Take its items back as a return instead.', COALESCE(NEW.bill_no, NEW.id)
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.hangtag_sale_cancel_check() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS hangtag_sale_cancel_check ON public.hangtag_sales;
CREATE TRIGGER hangtag_sale_cancel_check BEFORE UPDATE OF is_void ON public.hangtag_sales
    FOR EACH ROW EXECUTE FUNCTION public.hangtag_sale_cancel_check();
