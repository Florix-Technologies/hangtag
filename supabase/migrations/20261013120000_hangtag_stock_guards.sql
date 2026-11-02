-- ==============================================================================
-- Hangtag: stock and catalog write guards (schema.sql section 3za)
--   two devices can't both add the same new serial number or the same supplier bill; products and variants keep an
--   updated_at the database maintains; a product's unit stays once it has history
--
-- For the live database that supabase/schema.sql builds (the hangtag_* tables). It needs section 3z applied first (its
-- supplier-bill function is the one this section re-creates): run supabase/schema.sql once, or run this file after
-- 20261012120000_hangtag_custom_fields_units.sql. Safe to run again.
-- It is exactly section 3za of schema.sql.
-- Requires: supabase/schema.sql (applied first), then 20261012120000_hangtag_custom_fields_units.sql
-- Run it in the Supabase SQL Editor. Then the report at the end of schema.sql: rows 94 and 95.
-- ==============================================================================

-- ==============================================================================
-- 3za. Stock and catalog write guards: two devices can't both add the same new serial number or the same supplier bill,
--      and a product's unit stays once it has history
--   A new serial is added when the register doesn't have it, or has it written off (damaged or cancelled). An insert that
--   loses a race with another device's is refused ("already in stock"), never turned into a takeover. A supplier bill
--   locks on its file and on its invoice number before its duplicate check, so the same bill confirmed on two devices at
--   once is added once. Products made from a bill keep the values of the shop's own fields it carries.
--   Products and variants keep an updated_at the database maintains: it moves when anything else in the row changes,
--   and stays when the same row is sent again. A product's unit can't change once it has stock records, bill, return or
--   order lines, or repacks: counts already made are never read in another unit (the app says so first).
-- ==============================================================================
-- Section 3n's register of serials, otherwise exactly as that section defines it
CREATE OR REPLACE FUNCTION public.hangtag_track_move()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    s TEXT;
    cur public.hangtag_serials;
    known DATE;
    left_now NUMERIC;
    n INT;
BEGIN
    IF TG_OP = 'DELETE' THEN
        -- a stock record removed (the owner, or its variant deleted): its serials go with it
        IF OLD.serials IS NOT NULL THEN
            IF OLD.qty > 0 THEN
                UPDATE public.hangtag_serials SET status = 'CANCELLED', out_move_id = OLD.id, updated_at = NOW()
                 WHERE owner_id = OLD.owner_id AND serial = ANY (OLD.serials) AND move_id = OLD.id AND status IN ('IN_STOCK','RETURNED');
            ELSE
                UPDATE public.hangtag_serials SET status = 'IN_STOCK', out_move_id = NULL, updated_at = NOW()
                 WHERE owner_id = OLD.owner_id AND serial = ANY (OLD.serials) AND out_move_id = OLD.id AND status IN ('DAMAGED','CANCELLED');
            END IF;
        END IF;
        RETURN NULL;
    END IF;
    IF NEW.serials IS NOT NULL THEN
        FOREACH s IN ARRAY NEW.serials LOOP
            SELECT * INTO cur FROM public.hangtag_serials WHERE owner_id = NEW.owner_id AND serial = s FOR UPDATE;
            IF NEW.qty > 0 THEN
                IF FOUND AND cur.status IN ('IN_STOCK','RETURNED') THEN
                    RAISE EXCEPTION 'Serial % is already in stock.', s USING ERRCODE = 'unique_violation';
                ELSIF FOUND AND cur.status = 'SOLD' THEN
                    RAISE EXCEPTION 'Serial % is on a bill (sold). Take it back with a return instead.', s USING ERRCODE = 'unique_violation';
                END IF;
                INSERT INTO public.hangtag_serials AS x (owner_id, serial, variant_id, product_id, status, move_id, import_id, t)
                VALUES (NEW.owner_id, s, NEW.variant_id, NEW.product_id, 'IN_STOCK', NEW.id, NEW.import_id, NEW.t)
                ON CONFLICT (owner_id, serial) DO UPDATE SET variant_id = EXCLUDED.variant_id, product_id = EXCLUDED.product_id, status = 'IN_STOCK',
                    move_id = EXCLUDED.move_id, import_id = EXCLUDED.import_id, sale_id = NULL, sale_line_no = NULL, return_id = NULL, out_move_id = NULL,
                    t = EXCLUDED.t, updated_at = NOW()
                 WHERE x.status IN ('DAMAGED','CANCELLED');
                -- nothing written: another device added this serial since the check above (its insert won)
                GET DIAGNOSTICS n = ROW_COUNT;
                IF n = 0 THEN RAISE EXCEPTION 'Serial % is already in stock.', s USING ERRCODE = 'unique_violation'; END IF;
            ELSE
                IF NOT FOUND OR cur.variant_id <> NEW.variant_id OR cur.status NOT IN ('IN_STOCK','RETURNED') THEN
                    RAISE EXCEPTION 'Serial % isn''t in stock%.', s, CASE WHEN FOUND AND cur.status = 'SOLD' THEN ' (it is sold)' ELSE '' END USING ERRCODE = 'check_violation';
                END IF;
                UPDATE public.hangtag_serials SET status = CASE WHEN NEW.id LIKE 'pcx:%' THEN 'CANCELLED' ELSE 'DAMAGED' END, out_move_id = NEW.id, t = NEW.t, updated_at = NOW()
                 WHERE owner_id = NEW.owner_id AND serial = s;
            END IF;
        END LOOP;
    END IF;
    IF NEW.batch_no IS NOT NULL THEN
        IF NEW.qty > 0 THEN
            INSERT INTO public.hangtag_batches (owner_id, variant_id, batch_no, product_id, expiry, move_id, import_id, t)
            VALUES (NEW.owner_id, NEW.variant_id, NEW.batch_no, NEW.product_id, NEW.expiry, NEW.id, NEW.import_id, NEW.t)
            ON CONFLICT (owner_id, variant_id, batch_no) DO NOTHING;
            SELECT expiry INTO known FROM public.hangtag_batches WHERE owner_id = NEW.owner_id AND variant_id = NEW.variant_id AND batch_no = NEW.batch_no;
            IF NEW.expiry IS NOT NULL THEN
                IF known IS NULL THEN
                    UPDATE public.hangtag_batches SET expiry = NEW.expiry WHERE owner_id = NEW.owner_id AND variant_id = NEW.variant_id AND batch_no = NEW.batch_no;
                ELSIF known <> NEW.expiry THEN
                    RAISE EXCEPTION 'Batch % already has the expiry date %.', NEW.batch_no, known USING ERRCODE = 'check_violation';
                END IF;
            END IF;
        ELSIF NEW.qty < 0 THEN
            IF NOT EXISTS (SELECT 1 FROM public.hangtag_batches WHERE owner_id = NEW.owner_id AND variant_id = NEW.variant_id AND batch_no = NEW.batch_no) THEN
                RAISE EXCEPTION 'Batch % of this item isn''t in stock.', NEW.batch_no USING ERRCODE = 'check_violation';
            END IF;
            left_now := public.hangtag_batch_left(NEW.owner_id, NEW.variant_id, NEW.batch_no);
            IF left_now < 0 THEN
                RAISE EXCEPTION 'Batch % has only % left.', NEW.batch_no, trim_scale(left_now - NEW.qty) USING ERRCODE = 'check_violation';
            END IF;
        END IF;
    END IF;
    RETURN NULL;
END $$;
-- Section 3z's supplier bills, otherwise exactly as that section defines it
CREATE OR REPLACE FUNCTION public.hangtag_import_stock(p_import JSONB, p_products JSONB, p_variants JSONB, p_moves JSONB, p_allow_duplicate BOOLEAN DEFAULT FALSE)
RETURNS JSONB LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE
    uid UUID := public.hangtag_shop_id(); imp TEXT := p_import->>'id'; d RECORD; r JSONB;
    n_p INT:=0; n_v INT:=0; n_m INT:=0; n_units NUMERIC:=0; q NUMERIC;
    inv TEXT:=lower(btrim(COALESCE(p_import->>'invoice_no',''))); gst TEXT:=lower(btrim(COALESCE(p_import->>'supplier_gstin',''))); sup TEXT:=lower(btrim(COALESCE(p_import->>'supplier_name','')));
    tr TEXT; u TEXT; dp INT; keeps_expiry BOOLEAN; sns TEXT[]; bno TEXT; bexp DATE;
    k TEXT:=CASE WHEN p_import->>'kind'='purchase' THEN 'purchase' ELSE 'import' END;
    sid TEXT:=NULLIF(btrim(COALESCE(p_import->>'supplier_id','')),''); ls JSONB:=COALESCE(p_import->'lines','[]'::jsonb);
    sub NUMERIC:=round(COALESCE((p_import->>'subtotal')::NUMERIC,0),2); tax NUMERIC:=round(COALESCE((p_import->>'tax_amount')::NUMERIC,0),2);
    tot NUMERIC:=round(COALESCE((p_import->>'total_amount')::NUMERIC,0),2); l_sub NUMERIC; l_tax NUMERIC; l_tot NUMERIC; l_q NUMERIC;
    bad BOOLEAN; s_name TEXT; s_gstin TEXT;
BEGIN
    IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Sign in to add stock.' USING ERRCODE='42501'; END IF;
    IF uid IS NULL OR NOT public.hangtag_can('create_purchase') THEN RAISE EXCEPTION 'Not allowed to add stock from supplier bills.' USING ERRCODE='42501'; END IF;
    IF COALESCE(imp,'')='' THEN RAISE EXCEPTION 'The import has no id.' USING ERRCODE='22023'; END IF;
    -- one at a time per file and per invoice number of the shop (always in this order), so the same bill confirmed on two
    -- devices at once can't pass the duplicate check below twice: the second waits, then finds the first
    IF COALESCE(p_import->>'file_hash','')<>'' THEN PERFORM pg_advisory_xact_lock(hashtextextended('hangtag_import_file|'||uid::TEXT||'|'||(p_import->>'file_hash'),0)); END IF;
    IF inv<>'' THEN PERFORM pg_advisory_xact_lock(hashtextextended('hangtag_import_invoice|'||uid::TEXT||'|'||inv,0)); END IF;
    IF EXISTS (SELECT 1 FROM public.hangtag_stock_imports WHERE owner_id=uid AND id=imp) THEN RETURN jsonb_build_object('status','already_imported','import_id',imp); END IF;
    IF NOT COALESCE(p_allow_duplicate,FALSE) THEN
        SELECT id,created_at,invoice_no,supplier_name INTO d FROM public.hangtag_stock_imports WHERE owner_id=uid AND COALESCE(file_hash,'')<>'' AND file_hash=p_import->>'file_hash' ORDER BY created_at LIMIT 1;
        IF FOUND THEN RAISE EXCEPTION 'HANGTAG_DUPLICATE_FILE' USING DETAIL=jsonb_build_object('id',d.id,'created_at',d.created_at,'invoice_no',d.invoice_no,'supplier_name',d.supplier_name)::TEXT; END IF;
        IF inv<>'' THEN
            SELECT id,created_at,invoice_no,supplier_name INTO d FROM public.hangtag_stock_imports i WHERE i.owner_id=uid AND lower(btrim(COALESCE(i.invoice_no,'')))=inv
              AND CASE WHEN gst<>'' AND btrim(COALESCE(i.supplier_gstin,''))<>'' THEN lower(btrim(i.supplier_gstin))=gst ELSE lower(btrim(COALESCE(i.supplier_name,'')))=sup END ORDER BY created_at LIMIT 1;
            IF FOUND THEN RAISE EXCEPTION 'HANGTAG_DUPLICATE_INVOICE' USING DETAIL=jsonb_build_object('id',d.id,'created_at',d.created_at,'invoice_no',d.invoice_no,'supplier_name',d.supplier_name)::TEXT; END IF;
        END IF;
    END IF;
    FOR r IN SELECT * FROM jsonb_array_elements(COALESCE(p_products,'[]'::jsonb)) LOOP
        IF r->>'mode'='update_options' THEN
            IF NOT public.hangtag_cap_on(uid,'uses_variants') THEN RAISE EXCEPTION 'Product variants are switched off for this shop.' USING ERRCODE='42501'; END IF;
            UPDATE public.hangtag_products SET options=r->'options',updated_at=NOW() WHERE owner_id=uid AND id=r->>'id';
            IF NOT FOUND THEN RAISE EXCEPTION 'A product on this bill no longer exists. Check the bill again.' USING ERRCODE='23503'; END IF;
        ELSE
            tr:=COALESCE(NULLIF(r->>'tracking',''),'none'); u:=COALESCE(NULLIF(r->>'unit',''),'pcs');
            IF jsonb_array_length(COALESCE(r->'options'->'opts','[]'::jsonb))>0 AND NOT public.hangtag_cap_on(uid,'uses_variants') THEN RAISE EXCEPTION 'Product variants are switched off for this shop.' USING ERRCODE='42501'; END IF;
            IF u IN ('kg','g','l','ml') AND NOT public.hangtag_cap_on(uid,'uses_weight') THEN RAISE EXCEPTION 'Weight-based products are switched off for this shop.' USING ERRCODE='42501'; END IF;
            IF tr='serial' AND NOT public.hangtag_cap_on(uid,'uses_serials') THEN RAISE EXCEPTION 'Serial tracking is switched off for this shop.' USING ERRCODE='42501'; END IF;
            IF tr='batch' AND NOT public.hangtag_cap_on(uid,'uses_batches') THEN RAISE EXCEPTION 'Batch tracking is switched off for this shop.' USING ERRCODE='42501'; END IF;
            IF COALESCE((r->>'tracks_expiry')::BOOLEAN,FALSE) AND NOT public.hangtag_cap_on(uid,'uses_expiry') THEN RAISE EXCEPTION 'Expiry tracking is switched off for this shop.' USING ERRCODE='42501'; END IF;
            INSERT INTO public.hangtag_products (id,name,price,color,sort_order,category,brand,description,cost_price,archived,options,hsn,gst_rate,code_type,unit,tracking,tracks_expiry,low_stock,attrs)
            VALUES (r->>'id',r->>'name',COALESCE((r->>'price')::INTEGER,0),COALESCE(r->>'color','#8E8A83'),COALESCE((r->>'sort_order')::INTEGER,0),
                NULLIF(r->>'category',''),NULLIF(r->>'brand',''),NULLIF(r->>'description',''),(r->>'cost_price')::INTEGER,FALSE,COALESCE(r->'options','{}'::jsonb),
                NULLIF(r->>'hsn',''),(r->>'gst_rate')::NUMERIC,NULLIF(r->>'code_type',''),u,tr,COALESCE((r->>'tracks_expiry')::BOOLEAN,FALSE),(r->>'low_stock')::NUMERIC,
                CASE WHEN jsonb_typeof(r->'attrs')='object' THEN r->'attrs' ELSE '{}'::jsonb END);
        END IF;
        n_p:=n_p+1;
    END LOOP;
    FOR r IN SELECT * FROM jsonb_array_elements(COALESCE(p_variants,'[]'::jsonb)) LOOP
        INSERT INTO public.hangtag_variants (id,product_id,option_values,color,size,sku,barcode,price,cost_price,active,sort_order)
        VALUES (r->>'id',r->>'product_id',COALESCE(r->'option_values','[]'::jsonb),COALESCE(r->>'color',''),COALESCE(r->>'size',''),NULLIF(r->>'sku',''),NULLIF(r->>'barcode',''),
            (r->>'price')::INTEGER,(r->>'cost_price')::INTEGER,COALESCE((r->>'active')::BOOLEAN,TRUE),COALESCE((r->>'sort_order')::INTEGER,0));
        n_v:=n_v+1;
    END LOOP;
    FOR r IN SELECT * FROM jsonb_array_elements(COALESCE(p_moves,'[]'::jsonb)) LOOP
        q:=round(COALESCE((r->>'qty')::NUMERIC,0),3); IF q<=0 THEN RAISE EXCEPTION 'Every line needs a quantity above 0.' USING ERRCODE='23514'; END IF;
        SELECT p.tracking,p.tracks_expiry,p.unit INTO tr,keeps_expiry,u FROM public.hangtag_variants v JOIN public.hangtag_products p ON p.owner_id=v.owner_id AND p.id=v.product_id
         WHERE v.owner_id=uid AND v.id=r->>'variant_id' AND p.id=r->>'product_id';
        IF NOT FOUND THEN RAISE EXCEPTION 'A product or variant on this bill no longer exists.' USING ERRCODE='23503'; END IF;
        dp:=public.hangtag_unit_decimals(uid,u);
        IF q<>round(q,dp) THEN RAISE EXCEPTION 'Quantity % has too many decimal places for %.',trim_scale(q),u USING ERRCODE='23514'; END IF;
        sns:=CASE WHEN jsonb_typeof(r->'serials')='array' THEN ARRAY(SELECT jsonb_array_elements_text(r->'serials')) END;
        bno:=NULLIF(upper(btrim(COALESCE(r->>'batch_no',''))),''); bexp:=NULLIF(r->>'expiry','')::DATE;
        IF tr='serial' AND (sns IS NULL OR bno IS NOT NULL) THEN RAISE EXCEPTION 'A serial-tracked line needs one serial per piece and no batch.' USING ERRCODE='23514'; END IF;
        IF tr='batch' AND (bno IS NULL OR sns IS NOT NULL OR (keeps_expiry AND bexp IS NULL)) THEN RAISE EXCEPTION 'A batch-tracked line needs its batch% and no serials.',CASE WHEN keeps_expiry THEN ' and expiry date' ELSE '' END USING ERRCODE='23514'; END IF;
        IF tr='none' AND (sns IS NOT NULL OR bno IS NOT NULL OR bexp IS NOT NULL) THEN RAISE EXCEPTION 'This product is not tracked by serial or batch.' USING ERRCODE='23514'; END IF;
        IF tr<>'batch' AND bexp IS NOT NULL THEN RAISE EXCEPTION 'Only a batch-tracked product has an expiry date.' USING ERRCODE='23514'; END IF;
        INSERT INTO public.hangtag_stock_moves (id,variant_id,product_id,type,qty,cost_price,note,t,device_id,import_id,serials,batch_no,expiry)
        VALUES (r->>'id',r->>'variant_id',r->>'product_id','RESTOCK',q,(r->>'cost_price')::INTEGER,LEFT(r->>'note',200),COALESCE((r->>'t')::BIGINT,(extract(epoch FROM now())*1000)::BIGINT),r->>'device_id',imp,sns,bno,bexp);
        n_m:=n_m+1; n_units:=n_units+q;
    END LOOP;
    -- a purchase needs stock lines; a plain import keeps the earlier rule (an import record alone is allowed)
    IF n_m=0 AND k='purchase' THEN RAISE EXCEPTION 'There is no stock to add.' USING ERRCODE='23514'; END IF;
    IF k='purchase' THEN
        IF sid IS NULL THEN RAISE EXCEPTION 'Choose the supplier for this purchase.' USING ERRCODE='23514'; END IF;
        SELECT name,gstin INTO s_name,s_gstin FROM public.hangtag_suppliers WHERE owner_id=uid AND id=sid;
        IF NOT FOUND THEN RAISE EXCEPTION 'That supplier was not found in this shop.' USING ERRCODE='23503'; END IF;
        IF jsonb_typeof(ls)<>'array' OR jsonb_array_length(ls)<>n_m THEN RAISE EXCEPTION 'The purchase lines do not match its stock-in lines.' USING ERRCODE='23514'; END IF;
        SELECT COALESCE(sum(round((x->>'tx')::NUMERIC,2)),0),COALESCE(sum(round((x->>'tax')::NUMERIC,2)),0),COALESCE(sum(round((x->>'total')::NUMERIC,2)),0),
            COALESCE(sum((x->>'q')::NUMERIC),0),COALESCE(bool_or((x->>'q')::NUMERIC<=0 OR (x->>'cost')::NUMERIC<0 OR (x->>'gst')::NUMERIC NOT BETWEEN 0 AND 100),FALSE)
          INTO l_sub,l_tax,l_tot,l_q,bad FROM jsonb_array_elements(ls) x;
        IF bad OR l_sub<>sub OR l_tax<>tax OR l_tot<>tot OR tot<>sub+tax OR round(l_q,3)<>round(n_units,3) THEN RAISE EXCEPTION 'The purchase lines, subtotal, GST and stock quantities do not add up.' USING ERRCODE='23514'; END IF;
    END IF;
    INSERT INTO public.hangtag_stock_imports (id,kind,supplier_id,file_hash,file_name,file_type,document_path,supplier_name,supplier_gstin,invoice_no,invoice_date,t,line_count,units,amount,
        subtotal,tax_amount,total_amount,paid_amount,payment_method,status,lines,extraction,device_id)
    VALUES (imp,k,CASE WHEN k='purchase' THEN sid END,NULLIF(p_import->>'file_hash',''),p_import->>'file_name',p_import->>'file_type',NULLIF(p_import->>'document_path',''),
        COALESCE(CASE WHEN k='purchase' THEN s_name END,NULLIF(p_import->>'supplier_name','')),COALESCE(CASE WHEN k='purchase' THEN s_gstin END,NULLIF(p_import->>'supplier_gstin','')),
        NULLIF(p_import->>'invoice_no',''),NULLIF(p_import->>'invoice_date','')::DATE,COALESCE((p_import->>'t')::BIGINT,(extract(epoch FROM now())*1000)::BIGINT),
        COALESCE((p_import->>'line_count')::INTEGER,n_m),n_units,COALESCE((p_import->>'amount')::NUMERIC,CASE WHEN k='purchase' THEN tot END),
        CASE WHEN k='purchase' THEN sub END,CASE WHEN k='purchase' THEN tax END,CASE WHEN k='purchase' THEN tot END,0,NULL,'posted',ls,p_import->'extraction',p_import->>'device_id');
    RETURN jsonb_build_object('status','imported','import_id',imp,'products',n_p,'variants',n_v,'moves',n_m,'units',n_units,'purchase',k='purchase');
END $$;
REVOKE ALL ON FUNCTION public.hangtag_import_stock(JSONB,JSONB,JSONB,JSONB,BOOLEAN) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.hangtag_import_stock(JSONB,JSONB,JSONB,JSONB,BOOLEAN) TO authenticated;

-- updated_at on products and variants: when anything else changed, the time now; an identical resend keeps it (so it
-- can tell whether a row changed since it was read). zz_: after the other triggers that may change the row.
CREATE OR REPLACE FUNCTION public.hangtag_touch_updated()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
    IF (to_jsonb(NEW) - 'updated_at') IS DISTINCT FROM (to_jsonb(OLD) - 'updated_at') THEN NEW.updated_at := clock_timestamp();
    ELSE NEW.updated_at := OLD.updated_at; END IF;
    RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS zz_hangtag_touch ON public.hangtag_products;
CREATE TRIGGER zz_hangtag_touch BEFORE UPDATE ON public.hangtag_products FOR EACH ROW EXECUTE FUNCTION public.hangtag_touch_updated();
DROP TRIGGER IF EXISTS zz_hangtag_touch ON public.hangtag_variants;
CREATE TRIGGER zz_hangtag_touch BEFORE UPDATE ON public.hangtag_variants FOR EACH ROW EXECUTE FUNCTION public.hangtag_touch_updated();

-- A product's unit stays once it has history (any writer: an older app, a whole re-upload, SQL)
CREATE OR REPLACE FUNCTION public.hangtag_product_unit_lock()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM public.hangtag_stock_moves m WHERE m.owner_id = OLD.owner_id AND m.product_id = OLD.id)
       OR EXISTS (SELECT 1 FROM public.hangtag_sale_items i WHERE i.owner_id = OLD.owner_id AND i.product_id = OLD.id)
       OR EXISTS (SELECT 1 FROM public.hangtag_return_items i WHERE i.owner_id = OLD.owner_id AND i.product_id = OLD.id)
       OR EXISTS (SELECT 1 FROM public.hangtag_order_items i WHERE i.owner_id = OLD.owner_id AND i.product_id = OLD.id)
       OR EXISTS (SELECT 1 FROM public.hangtag_repacks r WHERE r.owner_id = OLD.owner_id AND OLD.id IN (r.from_product, r.to_product)) THEN
        RAISE EXCEPTION '% has stock records or bills in %, so its unit stays. Add a new product and move the stock across with Repack.', OLD.name, OLD.unit
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS hangtag_product_unit_lock ON public.hangtag_products;
CREATE TRIGGER hangtag_product_unit_lock BEFORE UPDATE OF unit ON public.hangtag_products FOR EACH ROW
    WHEN (OLD.unit IS DISTINCT FROM NEW.unit) EXECUTE FUNCTION public.hangtag_product_unit_lock();
REVOKE ALL ON FUNCTION public.hangtag_touch_updated(), public.hangtag_product_unit_lock() FROM PUBLIC, anon, authenticated;
