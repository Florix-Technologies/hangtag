-- UNDO OF THE 2026-10-13 DATABASE REPAIR ONLY. Puts back, exactly as they were on the live project on 2026-10-14 (06:3x UTC,
-- captured read-only with pg_get_functiondef), the 18 function versions the repair replaces and the 3 redundant indexes it
-- drops. Those versions LACK the fixes of sections 3t-3za (the bill-cancel guard, the supplier-bill and serial locks, the
-- plan rules, the store closing when a plan ends): run it only if the repaired functions are proven to break the live app,
-- and only on the owner's word. CREATE OR REPLACE keeps each function's owner and grants. It changes no row.
BEGIN;
SET LOCAL lock_timeout = '10s';
-- hangtag_access_ok(p_owner uuid)
CREATE OR REPLACE FUNCTION public.hangtag_access_ok(p_owner uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE st TEXT := public.hangtag_subscription_state(p_owner, NOW());
BEGIN
    IF st IN ('trial_active', 'paid_active') THEN RETURN TRUE; END IF;
    IF st = 'none' THEN
        RETURN NOT EXISTS (SELECT 1 FROM public.hangtag_profiles p WHERE p.id = p_owner AND p.onboarded_at IS NOT NULL);
    END IF;
    RETURN FALSE;
END $function$;

-- hangtag_biz_changes()
CREATE OR REPLACE FUNCTION public.hangtag_biz_changes()
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
    SELECT jsonb_build_object(
        'lists', (SELECT count(*) || ':' || COALESCE(sum(hashtext(l.id || '|' || l.updated_at::TEXT)), 0) FROM public.hangtag_price_lists l),
        'pos', (SELECT count(*) || ':' || COALESCE(sum(hashtext(p.id || '|' || p.version::TEXT)), 0) FROM public.hangtag_purchase_orders p),
        'vouchers', (SELECT count(*) || ':' || COALESCE(sum(hashtext(v.id || '|' || v.updated_at::TEXT)), 0) FROM public.hangtag_vouchers v),
        'gst', (SELECT count(*) || ':' || COALESCE(sum(hashtext(e.sale_id || '|' || e.updated_at::TEXT)), 0) FROM public.hangtag_einvoices e)
            || '/' || (SELECT count(*) || ':' || COALESCE(sum(hashtext(w.sale_id || '|' || w.updated_at::TEXT)), 0) FROM public.hangtag_eway_bills w))
$function$;

-- hangtag_cap_on(p_owner uuid, p_cap text)
CREATE OR REPLACE FUNCTION public.hangtag_cap_on(p_owner uuid, p_cap text)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE raw TEXT; kind TEXT; caps JSONB; v BOOLEAN; need TEXT;
BEGIN
    SELECT lower(btrim(COALESCE(business_type, ''))) INTO raw FROM public.hangtag_profiles WHERE id = p_owner;
    kind := CASE
        WHEN raw IN ('retail','grocery','restaurant','electronics','other') THEN raw
        WHEN raw ~ '(restaurant|hotel|cafe|café|food)' THEN 'restaurant'
        WHEN raw ~ '(grocer|kirana|supermarket)' THEN 'grocery'
        WHEN raw ~ '(electronic|mobile)' THEN 'electronics'
        WHEN raw = 'other' THEN 'other'
        ELSE 'retail' END;
    SELECT m.value -> 'caps' INTO caps FROM public.hangtag_meta m WHERE m.owner_id = p_owner AND m.key = 'settings';
    IF caps IS NOT NULL AND jsonb_typeof(caps) = 'object' AND jsonb_typeof(caps -> p_cap) = 'boolean' THEN v := (caps ->> p_cap)::BOOLEAN;
    ELSE v := CASE p_cap
        WHEN 'uses_variants' THEN kind IN ('retail','grocery','electronics','other')
        WHEN 'uses_serials' THEN kind = 'electronics'
        WHEN 'uses_batches' THEN kind = 'grocery'
        WHEN 'uses_expiry' THEN kind = 'grocery'
        WHEN 'uses_weight' THEN kind = 'grocery'
        WHEN 'uses_quotations' THEN kind IN ('retail','grocery','electronics')
        WHEN 'uses_sales_orders' THEN kind IN ('retail','grocery','electronics')
        WHEN 'uses_mobile_store' THEN FALSE
        WHEN 'uses_tables' THEN kind = 'restaurant'
        WHEN 'uses_table_qr' THEN kind = 'restaurant'
        WHEN 'uses_customer_ordering' THEN kind = 'restaurant'
        WHEN 'uses_server_ordering' THEN kind = 'restaurant'
        WHEN 'uses_kitchen' THEN kind = 'restaurant'
        WHEN 'uses_price_lists' THEN FALSE
        WHEN 'uses_purchase_orders' THEN kind IN ('retail','grocery','electronics')
        WHEN 'uses_bundles' THEN kind = 'electronics'
        WHEN 'uses_repack' THEN kind = 'grocery'
        WHEN 'uses_vouchers' THEN FALSE
        WHEN 'uses_einvoice' THEN FALSE
        WHEN 'uses_eway' THEN FALSE
        ELSE FALSE END;
    END IF;
    need := CASE p_cap WHEN 'uses_mobile_store' THEN 'uses_sales_orders'
        WHEN 'uses_table_qr' THEN 'uses_tables' WHEN 'uses_customer_ordering' THEN 'uses_table_qr'
        WHEN 'uses_server_ordering' THEN 'uses_tables' WHEN 'uses_kitchen' THEN 'uses_tables' END;
    IF v AND need IS NOT NULL THEN v := public.hangtag_cap_on(p_owner, need); END IF;
    RETURN COALESCE(v, FALSE);
END $function$;

-- hangtag_import_stock(p_import jsonb, p_products jsonb, p_variants jsonb, p_moves jsonb, p_allow_duplicate boolean)
CREATE OR REPLACE FUNCTION public.hangtag_import_stock(p_import jsonb, p_products jsonb, p_variants jsonb, p_moves jsonb, p_allow_duplicate boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
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
            INSERT INTO public.hangtag_products (id,name,price,color,sort_order,category,brand,description,cost_price,archived,options,hsn,gst_rate,code_type,unit,tracking,tracks_expiry,low_stock)
            VALUES (r->>'id',r->>'name',COALESCE((r->>'price')::INTEGER,0),COALESCE(r->>'color','#8E8A83'),COALESCE((r->>'sort_order')::INTEGER,0),
                NULLIF(r->>'category',''),NULLIF(r->>'brand',''),NULLIF(r->>'description',''),(r->>'cost_price')::INTEGER,FALSE,COALESCE(r->'options','{}'::jsonb),
                NULLIF(r->>'hsn',''),(r->>'gst_rate')::NUMERIC,NULLIF(r->>'code_type',''),u,tr,COALESCE((r->>'tracks_expiry')::BOOLEAN,FALSE),(r->>'low_stock')::NUMERIC);
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
END $function$;

-- hangtag_mobile_catalog(p_token text)
CREATE OR REPLACE FUNCTION public.hangtag_mobile_catalog(p_token text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE shop RECORD; items JSONB; cats JSONB; tax_on BOOLEAN := FALSE; tax_incl BOOLEAN := TRUE; default_rate NUMERIC := 5;
BEGIN
    IF p_token IS NULL OR p_token !~ '^st_[A-Za-z0-9_-]{32,61}$' THEN
        RETURN jsonb_build_object('ok', FALSE, 'message', 'This shop link is not valid. Ask the shop for a new link.');
    END IF;
    SELECT p.id, p.shop_name INTO shop FROM public.hangtag_profiles p WHERE p.store_token = p_token;
    IF NOT FOUND OR NOT public.hangtag_cap_on(shop.id, 'uses_mobile_store') THEN
        RETURN jsonb_build_object('ok', FALSE, 'message', 'This mobile store is not open right now.');
    END IF;
    SELECT COALESCE(CASE WHEN jsonb_typeof(m.value->'taxOn')='boolean' THEN (m.value->>'taxOn')::BOOLEAN END,FALSE),
           COALESCE(CASE WHEN jsonb_typeof(m.value->'taxIncl')='boolean' THEN (m.value->>'taxIncl')::BOOLEAN END,TRUE),
           COALESCE(CASE WHEN jsonb_typeof(m.value->'taxRate')='number' THEN (m.value->>'taxRate')::NUMERIC END,5)
      INTO tax_on,tax_incl,default_rate FROM public.hangtag_meta m WHERE m.owner_id=shop.id AND m.key='settings';
    SELECT COALESCE(jsonb_agg(x.item ORDER BY x.sort_key), '[]'::jsonb) INTO items FROM (
        SELECT jsonb_build_object('id', p.id, 'name', p.name, 'description', COALESCE(p.description, ''),
                   'brand', COALESCE(p.brand, ''), 'category', COALESCE(p.category, ''), 'gst', CASE WHEN tax_on THEN COALESCE(p.gst_rate,default_rate) ELSE 0 END,
                   'unit', COALESCE(p.unit, 'pcs'), 'image', CASE WHEN im.image_data ~ '^data:image/(png|jpeg|webp);base64,' THEN im.image_data END,
                   'variants', (SELECT COALESCE(jsonb_agg(jsonb_build_object('v', v.id,
                       'label', COALESCE((SELECT string_agg(e.value, ' / ' ORDER BY e.n) FROM jsonb_array_elements_text(v.option_values) WITH ORDINALITY e(value,n)), ''),
                       'price', public.hangtag_list_price(p.owner_id, NULL, NULL, p.id, v.id, COALESCE(v.price, p.price)), 'available', public.hangtag_mobile_available(p.owner_id, v.id))
                       ORDER BY v.sort_order, v.id), '[]'::jsonb)
                     FROM public.hangtag_variants v WHERE v.owner_id = p.owner_id AND v.product_id = p.id AND v.active)) AS item,
               lower(COALESCE(p.category, 'zzz')) || '|' || lpad(p.sort_order::TEXT, 10, '0') || '|' || lower(p.name) AS sort_key
          FROM public.hangtag_products p LEFT JOIN public.hangtag_images im ON im.owner_id = p.owner_id AND im.product_id = p.id
         WHERE p.owner_id = shop.id AND NOT p.archived AND p.bundle IS NULL
           AND EXISTS (SELECT 1 FROM public.hangtag_variants v WHERE v.owner_id = p.owner_id AND v.product_id = p.id AND v.active)
         ORDER BY lower(COALESCE(p.category, 'zzz')), p.sort_order, lower(p.name) LIMIT 500) x;
    SELECT COALESCE(jsonb_agg(c ORDER BY lower(c)), '[]'::jsonb) INTO cats FROM (
        SELECT DISTINCT btrim(p.category) c FROM public.hangtag_products p WHERE p.owner_id = shop.id AND NOT p.archived AND p.bundle IS NULL AND btrim(COALESCE(p.category, '')) <> '') q;
    RETURN jsonb_build_object('ok', TRUE, 'shop', COALESCE(NULLIF(btrim(shop.shop_name), ''), 'Shop'), 'tax_on', tax_on,
        'tax_inclusive', tax_incl, 'items', items, 'categories', cats);
END $function$;

-- hangtag_mobile_order_status(p_order_token text)
CREATE OR REPLACE FUNCTION public.hangtag_mobile_order_status(p_order_token text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE o public.hangtag_orders; ordered NUMERIC; billed NUMERIC; state TEXT; state_label TEXT; payment_state TEXT; payment_label TEXT;
BEGIN
    IF p_order_token IS NULL OR p_order_token !~ '^mo_[A-Za-z0-9_-]{32,61}$' THEN RETURN jsonb_build_object('ok', FALSE, 'message', 'That order link is not valid.'); END IF;
    SELECT * INTO o FROM public.hangtag_orders x WHERE x.public_token = p_order_token;
    IF NOT FOUND THEN RETURN jsonb_build_object('ok', FALSE, 'message', 'That order was not found.'); END IF;
    SELECT COALESCE(sum(i.qty),0) INTO ordered FROM public.hangtag_order_items i WHERE i.owner_id=o.owner_id AND i.order_id=o.id;
    SELECT COALESCE(sum(i.quantity),0) INTO billed FROM public.hangtag_sales s JOIN public.hangtag_sale_items i ON i.owner_id=s.owner_id AND i.sale_id=s.id
     WHERE s.owner_id=o.owner_id AND s.order_id=o.id AND NOT s.is_void;
    IF EXISTS (SELECT 1 FROM public.hangtag_sales s WHERE s.owner_id=o.owner_id AND s.order_id=o.id AND NOT s.is_void
        AND COALESCE((SELECT sum(p.amount) FROM public.hangtag_payments p WHERE p.owner_id=s.owner_id AND p.sale_id=s.id AND p.status='completed'),0)
            >= GREATEST(s.total-s.credit-s.due_amount,0)) THEN payment_state:='confirmed'; payment_label:='Payment confirmed';
    ELSE payment_state:='awaiting_staff'; payment_label:=CASE o.payment_preference WHEN 'upi' THEN 'UPI to be verified by staff' WHEN 'cash' THEN 'Cash at checkout' ELSE 'Pay at checkout' END; END IF;
    IF o.status='cancelled' THEN state:='cancelled'; state_label:='Cancelled';
    ELSIF ordered>0 AND billed>=ordered THEN state:='fulfilled'; state_label:=CASE WHEN payment_state='confirmed' THEN 'Completed' ELSE 'Ready' END;
    ELSIF billed>0 THEN state:='partial'; state_label:='Partially ready';
    ELSE state:='received'; state_label:='Confirmed'; END IF;
    RETURN jsonb_build_object('ok',TRUE,'order_no',o.no,'state',state,'state_label',state_label,'payment_state',payment_state,'payment_label',payment_label,
        'total',o.total,'mode',COALESCE(o.checkout_mode,'store'),'updated_at',o.updated_at);
END $function$;

-- hangtag_place_mobile_order(p_token text, p_items jsonb, p_customer jsonb, p_checkout_key text, p_note text, p_payment text, p_mode text)
CREATE OR REPLACE FUNCTION public.hangtag_place_mobile_order(p_token text, p_items jsonb, p_customer jsonb, p_checkout_key text, p_note text DEFAULT NULL::text, p_payment text DEFAULT 'counter'::text, p_mode text DEFAULT 'store'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
    shop RECORD; prior public.hangtag_orders; vr RECORD; it JSONB; q NUMERIC; available NUMERIC; dp INT; ln INT := 0;
    oid TEXT := 'om' || replace(gen_random_uuid()::TEXT, '-', ''); otok TEXT := 'mo_' || replace(gen_random_uuid()::TEXT, '-', '');
    now_ms BIGINT := (extract(epoch FROM now()) * 1000)::BIGINT; ono TEXT; total NUMERIC := 0; cid TEXT; line_net NUMERIC;
    tax_on BOOLEAN := FALSE; tax_incl BOOLEAN := TRUE; default_rate NUMERIC := 5;
    nm TEXT; ph TEXT; em TEXT; raw_phone TEXT; clean_note TEXT;
BEGIN
    IF p_token IS NULL OR p_token !~ '^st_[A-Za-z0-9_-]{32,61}$' THEN RETURN jsonb_build_object('ok', FALSE, 'message', 'This shop link is not valid.'); END IF;
    SELECT p.id, p.shop_name INTO shop FROM public.hangtag_profiles p WHERE p.store_token = p_token FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('ok', FALSE, 'message', 'This shop link is not valid.'); END IF;
    IF p_checkout_key IS NULL OR p_checkout_key !~ '^[A-Za-z0-9_-]{24,64}$' THEN RETURN jsonb_build_object('ok', FALSE, 'message', 'Start checkout again and retry.'); END IF;
    SELECT * INTO prior FROM public.hangtag_orders o WHERE o.owner_id = shop.id AND o.checkout_key = p_checkout_key;
    IF FOUND THEN RETURN jsonb_build_object('ok', TRUE, 'order_no', prior.no, 'order_token', prior.public_token, 'state', 'received', 'state_label', 'Confirmed'); END IF;
    IF NOT public.hangtag_cap_on(shop.id, 'uses_mobile_store') THEN RETURN jsonb_build_object('ok', FALSE, 'message', 'This mobile store is not open right now.'); END IF;
    SELECT COALESCE(CASE WHEN jsonb_typeof(m.value->'taxOn')='boolean' THEN (m.value->>'taxOn')::BOOLEAN END,FALSE),
           COALESCE(CASE WHEN jsonb_typeof(m.value->'taxIncl')='boolean' THEN (m.value->>'taxIncl')::BOOLEAN END,TRUE),
           COALESCE(CASE WHEN jsonb_typeof(m.value->'taxRate')='number' THEN (m.value->>'taxRate')::NUMERIC END,5)
      INTO tax_on,tax_incl,default_rate FROM public.hangtag_meta m WHERE m.owner_id=shop.id AND m.key='settings';
    IF p_mode NOT IN ('store','assisted') OR p_payment NOT IN ('counter','cash','upi') THEN RETURN jsonb_build_object('ok', FALSE, 'message', 'Choose a valid checkout option.'); END IF;
    IF jsonb_typeof(COALESCE(p_items, 'null'::jsonb)) <> 'array' OR jsonb_array_length(p_items) NOT BETWEEN 1 AND 50 THEN RETURN jsonb_build_object('ok', FALSE, 'message', 'Add from 1 to 50 products to your cart.'); END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_items) x(item) GROUP BY x.item ->> 'v' HAVING count(*) > 1) THEN RETURN jsonb_build_object('ok', FALSE, 'message', 'Choose each product variant only once.'); END IF;
    IF jsonb_typeof(COALESCE(p_customer, 'null'::jsonb)) <> 'object' THEN RETURN jsonb_build_object('ok', FALSE, 'message', 'Enter your customer details.'); END IF;
    nm := left(btrim(regexp_replace(COALESCE(p_customer ->> 'name', ''), '[[:cntrl:]]', ' ', 'g')), 80);
    raw_phone := regexp_replace(COALESCE(p_customer ->> 'phone', ''), '[^0-9]', '', 'g'); ph := left(raw_phone, 15);
    em := lower(left(btrim(COALESCE(p_customer ->> 'email', '')), 120));
    clean_note := NULLIF(left(btrim(regexp_replace(COALESCE(p_note, ''), '[[:cntrl:]]', ' ', 'g')), 500), '');
    IF nm = '' THEN RETURN jsonb_build_object('ok', FALSE, 'message', 'Enter your name.'); END IF;
    IF char_length(raw_phone) NOT BETWEEN 10 AND 15 THEN RETURN jsonb_build_object('ok', FALSE, 'message', 'Enter a valid mobile number.'); END IF;
    IF em <> '' AND em !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' THEN RETURN jsonb_build_object('ok', FALSE, 'message', 'Enter a valid email address.'); END IF;
    IF (SELECT count(*) FROM public.hangtag_orders o WHERE o.owner_id = shop.id AND o.public_token IS NOT NULL AND o.created_at > NOW() - interval '10 minutes') >= 100 THEN
        RETURN jsonb_build_object('ok', FALSE, 'message', 'The shop received many orders just now. Please wait a moment or contact the staff.');
    END IF;
    FOR it IN SELECT x.item FROM jsonb_array_elements(p_items) x(item) ORDER BY x.item ->> 'v' LOOP
        q := CASE WHEN jsonb_typeof(it -> 'q') = 'number' THEN (it ->> 'q')::NUMERIC END;
        SELECT v.id, v.product_id, p.name, p.unit, public.hangtag_list_price(shop.id, NULL, NULL, p.id, v.id, COALESCE(v.price, p.price)) price,
               CASE WHEN tax_on THEN COALESCE(p.gst_rate,default_rate) ELSE 0 END gst_rate,
               COALESCE((SELECT string_agg(e.value, ' / ' ORDER BY e.n) FROM jsonb_array_elements_text(v.option_values) WITH ORDINALITY e(value,n)), '') label
          INTO vr FROM public.hangtag_variants v JOIN public.hangtag_products p ON p.owner_id = v.owner_id AND p.id = v.product_id
         WHERE v.owner_id = shop.id AND v.id = it ->> 'v' AND v.active AND NOT p.archived AND p.bundle IS NULL FOR UPDATE OF v, p;
        IF NOT FOUND THEN RAISE EXCEPTION 'A product in your cart is not available any more. Refresh the store and try again.' USING ERRCODE = 'check_violation'; END IF;
        dp := CASE vr.unit WHEN 'kg' THEN 3 WHEN 'l' THEN 3 WHEN 'm' THEN 2 ELSE 0 END;
        IF q IS NULL OR q <= 0 OR q > 50 OR q <> round(q, dp) THEN RAISE EXCEPTION 'Choose a valid quantity for %.', vr.name USING ERRCODE = 'check_violation'; END IF;
        available := public.hangtag_mobile_available(shop.id, vr.id);
        IF q > available THEN RAISE EXCEPTION '% now has only % available. Refresh your cart and try again.', vr.name, trim_scale(available) USING ERRCODE = 'check_violation'; END IF;
        line_net := round(q * vr.price,2);
        total := total + line_net + CASE WHEN tax_on AND NOT tax_incl AND vr.gst_rate>0 THEN 2*round(line_net*vr.gst_rate/200,2) ELSE 0 END;
    END LOOP;
    SELECT c.id INTO cid FROM public.hangtag_customers c WHERE c.owner_id = shop.id
     AND right(regexp_replace(COALESCE(c.phone, ''), '[^0-9]', '', 'g'), 10) = right(ph, 10) ORDER BY c.created_at LIMIT 1;
    IF cid IS NULL THEN
        cid := 'mc' || replace(gen_random_uuid()::TEXT, '-', '');
        INSERT INTO public.hangtag_customers (owner_id, id, name, phone, email, customer_type) VALUES (shop.id, cid, nm, ph, NULLIF(em, ''), 'individual');
    END IF;
    ono := 'MO-' || to_char(NOW() AT TIME ZONE 'Asia/Kolkata', 'YYMMDD') || '-' || upper(substr(md5(oid), 1, 6));
    INSERT INTO public.hangtag_orders (owner_id,id,kind,no,status,customer_id,customer,notes,source,version,t,updated_t,device_id,user_id,total,
        public_token,checkout_key,checkout_mode,payment_preference)
    VALUES (shop.id,oid,'sales',ono,'confirmed',cid,jsonb_build_object('id',cid,'name',nm,'phone',ph) || CASE WHEN em <> '' THEN jsonb_build_object('email',em) ELSE '{}'::jsonb END,
        clean_note,'customer',1,now_ms,now_ms,'mobile-store',NULL,round(total),otok,p_checkout_key,p_mode,p_payment);
    FOR it IN SELECT x.item FROM jsonb_array_elements(p_items) WITH ORDINALITY x(item,n) ORDER BY x.n LOOP
        q := (it ->> 'q')::NUMERIC;
        SELECT v.id, v.product_id, p.name, p.unit, public.hangtag_list_price(shop.id, NULL, NULL, p.id, v.id, COALESCE(v.price, p.price)) price,
               CASE WHEN tax_on THEN COALESCE(p.gst_rate,default_rate) ELSE 0 END gst_rate,
               COALESCE((SELECT string_agg(e.value, ' / ' ORDER BY e.n) FROM jsonb_array_elements_text(v.option_values) WITH ORDINALITY e(value,n)), '') label
          INTO vr FROM public.hangtag_variants v JOIN public.hangtag_products p ON p.owner_id=v.owner_id AND p.id=v.product_id
         WHERE v.owner_id=shop.id AND v.id=it->>'v';
        INSERT INTO public.hangtag_order_items (owner_id,order_id,line_no,product_id,variant_id,name,variant_label,unit,qty,price,gst_rate,fulfilled_qty)
        VALUES (shop.id,oid,ln,vr.product_id,vr.id,vr.name,vr.label,COALESCE(vr.unit,'pcs'),q,vr.price,vr.gst_rate,0);
        ln := ln + 1;
    END LOOP;
    RETURN jsonb_build_object('ok', TRUE, 'order_no', ono, 'order_token', otok, 'total', round(total), 'state', 'received', 'state_label', 'Confirmed');
END $function$;

-- hangtag_platform_dashboard()
CREATE OR REPLACE FUNCTION public.hangtag_platform_dashboard()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
    r TEXT := public.hangtag_platform_require('dashboard.view');
    n TIMESTAMPTZ := NOW();
    m0 TIMESTAMPTZ := (date_trunc('month', NOW() AT TIME ZONE 'Asia/Kolkata')) AT TIME ZONE 'Asia/Kolkata';
    ending INT;
    shops JSONB; subs JSONB; money JSONB; offers JSONB; usage JSONB; cur TEXT;
BEGIN
    SELECT c.trial_ending_days INTO ending FROM public.hangtag_platform_config c WHERE c.id;
    SELECT p.currency INTO cur FROM public.hangtag_plans p WHERE p.kind = 'paid' ORDER BY p.sort LIMIT 1;
    SELECT jsonb_build_object('total', count(*), 'new_7d', count(*) FILTER (WHERE p.onboarded_at > n - interval '7 days'),
               'new_30d', count(*) FILTER (WHERE p.onboarded_at > n - interval '30 days'))
      INTO shops FROM public.hangtag_profiles p
     WHERE p.onboarded_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.hangtag_members m WHERE m.user_id = p.id);
    WITH s AS (SELECT public.hangtag_subscription_state(x.owner_id, n) AS st, x.autopay_status AS ap, x.trial_ends_at FROM public.hangtag_subscriptions x)
    SELECT jsonb_build_object(
        'trial', count(*) FILTER (WHERE st = 'trial_active' AND trial_ends_at - n > make_interval(days => COALESCE(ending, 3))),
        'trial_ending', count(*) FILTER (WHERE st = 'trial_active' AND trial_ends_at - n <= make_interval(days => COALESCE(ending, 3))),
        'autopay_setup', count(*) FILTER (WHERE st = 'trial_setup'),
        'active', count(*) FILTER (WHERE st = 'paid_active'),
        'renewing', count(*) FILTER (WHERE st = 'renewal_due'),
        'expired', count(*) FILTER (WHERE st IN ('trial_expired', 'paid_expired')),
        'suspended', count(*) FILTER (WHERE st = 'suspended'),
        'autopay_on', count(*) FILTER (WHERE ap = 'active'),
        'autopay_failing', count(*) FILTER (WHERE ap IN ('past_due', 'halted')),
        'autopay_cancelled', count(*) FILTER (WHERE ap = 'cancelled'))
      INTO subs FROM s;
    SELECT jsonb_build_object('currency', COALESCE(cur, 'INR'),
        'month', COALESCE(sum(y.amount) FILTER (WHERE y.captured_at >= m0), 0), 'month_count', count(*) FILTER (WHERE y.captured_at >= m0),
        'last_30d', COALESCE(sum(y.amount) FILTER (WHERE y.captured_at > n - interval '30 days'), 0),
        'autopay_30d', COALESCE(sum(y.amount) FILTER (WHERE y.captured_at > n - interval '30 days' AND y.kind = 'autopay'), 0),
        'failed_7d', (SELECT count(*) FROM public.hangtag_subscription_payments f WHERE f.status = 'failed' AND f.created_at > n - interval '7 days'))
      INTO money FROM public.hangtag_subscription_payments y WHERE y.captured_at IS NOT NULL;
    SELECT COALESCE(jsonb_agg(jsonb_build_object('code', c.code, 'title', COALESCE(c.title, c.code), 'redeemed', c.redeemed, 'cap', c.max_uses,
               'active', c.active, 'ends_at', c.ends_at) ORDER BY c.code), '[]'::jsonb)
      INTO offers FROM public.hangtag_promo_codes c WHERE c.auto_apply OR c.max_uses IS NOT NULL;
    SELECT jsonb_build_object('bills_24h', (SELECT count(*) FROM public.hangtag_sales x WHERE x.created_at > n - interval '24 hours'),
               'shops_selling_7d', (SELECT count(DISTINCT x.owner_id) FROM public.hangtag_sales x WHERE x.created_at > n - interval '7 days'))
      INTO usage;
    RETURN jsonb_build_object('generated_at', n, 'role', r, 'shops', shops, 'subscriptions', subs, 'revenue', money, 'offers', offers, 'usage', usage);
END $function$;

-- hangtag_platform_permissions(p_role text)
CREATE OR REPLACE FUNCTION public.hangtag_platform_permissions(p_role text)
 RETURNS text[]
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
    SELECT CASE p_role
        WHEN 'super_admin' THEN ARRAY['dashboard.view', 'customers.view', 'subscriptions.view', 'subscriptions.manage', 'payments.view', 'promotions.view',
            'promotions.manage', 'plans.manage', 'referrals.view', 'wallet.view', 'communications.view', 'health.view', 'inventory.view', 'diagnostics.view',
            'growth.view', 'employees.view', 'incentives.view', 'reports.view', 'audit.view', 'settings.view', 'settings.manage', 'staff.manage']
        WHEN 'admin' THEN ARRAY['dashboard.view', 'customers.view', 'subscriptions.view', 'subscriptions.manage', 'payments.view', 'promotions.view',
            'promotions.manage', 'plans.manage', 'referrals.view', 'wallet.view', 'communications.view', 'health.view', 'inventory.view', 'diagnostics.view',
            'growth.view', 'employees.view', 'incentives.view', 'reports.view', 'audit.view', 'settings.view', 'staff.manage']
        WHEN 'billing_admin' THEN ARRAY['dashboard.view', 'customers.view', 'subscriptions.view', 'subscriptions.manage', 'payments.view', 'promotions.view',
            'promotions.manage', 'plans.manage', 'referrals.view', 'wallet.view', 'incentives.view', 'reports.view']
        WHEN 'support_admin' THEN ARRAY['dashboard.view', 'customers.view', 'subscriptions.view', 'payments.view', 'communications.view', 'health.view',
            'inventory.view', 'diagnostics.view']
        WHEN 'read_only' THEN ARRAY['dashboard.view', 'customers.view', 'subscriptions.view', 'payments.view', 'promotions.view', 'health.view',
            'growth.view', 'reports.view']
        ELSE ARRAY[]::TEXT[] END;
$function$;

-- hangtag_promo_evaluate(p_owner uuid, p_plan text, p_code text)
CREATE OR REPLACE FUNCTION public.hangtag_promo_evaluate(p_owner uuid, p_plan text, p_code text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
    v_code TEXT := upper(btrim(COALESCE(p_code, '')));
    c RECORD;
    pl RECORD;
    used_total INT;
    used_mine INT;
    disc NUMERIC(12,2);
    reason TEXT;
    msg TEXT;
BEGIN
    SELECT p.code, p.label, p.price INTO pl FROM public.hangtag_plans p WHERE p.code = p_plan;
    IF v_code !~ '^[A-Z0-9_-]{3,32}$' THEN
        RETURN jsonb_build_object('code', v_code, 'valid', FALSE, 'reason', 'invalid', 'message', 'This promo code isn''t valid.', 'discount', 0);
    END IF;
    SELECT * INTO c FROM public.hangtag_promo_codes x WHERE x.code = v_code;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('code', v_code, 'valid', FALSE, 'reason', 'invalid', 'message', 'This promo code isn''t valid.', 'discount', 0);
    END IF;
    SELECT count(*) INTO used_mine FROM public.hangtag_promo_redemptions r WHERE r.code = v_code AND r.owner_id = p_owner;
    SELECT (SELECT count(*) FROM public.hangtag_promo_redemptions r WHERE r.code = v_code)
         + (SELECT count(*) FROM public.hangtag_subscription_payments y WHERE y.promo_code = v_code AND y.status = 'created'
              AND y.created_at > NOW() - interval '30 minutes' AND y.owner_id IS DISTINCT FROM p_owner)
      INTO used_total;
    IF NOT c.active THEN reason := 'inactive'; msg := 'This promo code is no longer active.';
    ELSIF c.starts_at IS NOT NULL AND c.starts_at > NOW() THEN reason := 'not_started'; msg := 'This promo code isn''t active yet.';
    ELSIF c.ends_at IS NOT NULL AND c.ends_at <= NOW() THEN reason := 'expired'; msg := 'This promo code has expired.';
    ELSIF c.plans IS NOT NULL AND NOT (p_plan = ANY (c.plans)) THEN
        reason := 'not_for_plan'; msg := 'This promo code isn''t for the ' || COALESCE(pl.label, 'chosen') || ' plan.';
    ELSIF used_mine >= c.per_account_limit THEN reason := 'already_used'; msg := 'You have already used this promo code.';
    ELSIF c.max_uses IS NOT NULL AND used_total >= c.max_uses THEN reason := 'used_up'; msg := 'This promo code has been fully used.';
    END IF;
    IF reason IS NOT NULL THEN
        RETURN jsonb_build_object('code', v_code, 'valid', FALSE, 'reason', reason, 'message', msg, 'kind', c.kind, 'value', c.value, 'discount', 0);
    END IF;
    disc := CASE WHEN c.kind = 'percent' THEN round(COALESCE(pl.price, 0) * c.value / 100, 2) ELSE c.value END;
    disc := LEAST(GREATEST(disc, 0), COALESCE(pl.price, 0));
    RETURN jsonb_build_object('code', v_code, 'valid', TRUE, 'reason', NULL, 'message', 'Promo code applied.', 'kind', c.kind, 'value', c.value, 'discount', disc);
END $function$;

-- hangtag_save_sales(p_bills jsonb)
CREATE OR REPLACE FUNCTION public.hangtag_save_sales(p_bills jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
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
            total = EXCLUDED.total, payment_method = EXCLUDED.payment_method, device_id = EXCLUDED.device_id, is_void = EXCLUDED.is_void, void_reason = CASE WHEN EXCLUDED.is_void THEN hangtag_sales.void_reason END,
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
    RETURN jsonb_build_object('status', 'saved', 'bills', n);
END $function$;

-- hangtag_subscription_activate(p_payment uuid, p_provider_payment text, p_amount numeric)
CREATE OR REPLACE FUNCTION public.hangtag_subscription_activate(p_payment uuid, p_provider_payment text, p_amount numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
    pay RECORD;
    per JSONB;
    lim RECORD;
    over BOOLEAN := FALSE;
BEGIN
    SELECT * INTO pay FROM public.hangtag_subscription_payments y WHERE y.id = p_payment FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Payment not found.' USING ERRCODE = 'P0002'; END IF;
    IF pay.status = 'paid' THEN
        RETURN jsonb_build_object('ok', TRUE, 'already', TRUE, 'state', public.hangtag_subscription_state(pay.owner_id, NOW()),
            'plan_code', pay.plan_code, 'period_start', pay.period_start, 'period_end', pay.period_end);
    END IF;
    IF p_amount IS NULL OR round(p_amount, 2) <> pay.amount THEN
        RAISE EXCEPTION 'The amount paid is not the amount due.' USING ERRCODE = 'P0001';
    END IF;
    IF pay.amount > 0 AND btrim(COALESCE(p_provider_payment, '')) = '' THEN
        RAISE EXCEPTION 'The provider''s payment reference is missing.' USING ERRCODE = 'P0001';
    END IF;
    -- the promo code's limits, checked again now (one activation at a time per code): several checkouts opened before one
    -- was paid can't use a code beyond its limits. Nothing to pay → refused (the payment fails, no plan time); money the
    -- provider took is honoured and the payment is marked for review.
    IF pay.promo_code IS NOT NULL THEN
        SELECT c.max_uses, c.per_account_limit INTO lim FROM public.hangtag_promo_codes c WHERE c.code = pay.promo_code FOR UPDATE;
        over := (SELECT count(*) FROM public.hangtag_promo_redemptions r WHERE r.code = pay.promo_code AND r.owner_id = pay.owner_id) >= COALESCE(lim.per_account_limit, 1)
             OR (lim.max_uses IS NOT NULL AND (SELECT count(*) FROM public.hangtag_promo_redemptions r WHERE r.code = pay.promo_code) >= lim.max_uses);
        IF over AND pay.amount = 0 THEN
            UPDATE public.hangtag_subscription_payments SET status = 'failed', note = 'Promo code limit reached' WHERE id = pay.id;
            RETURN jsonb_build_object('ok', FALSE, 'refused', TRUE, 'reason', 'promo_limit', 'message', 'This promo code has already been used.');
        END IF;
    END IF;
    -- money the provider confirmed is honoured even if the checkout had been marked expired or cancelled meanwhile
    per := public.hangtag_subscription_extend(pay.owner_id, pay.plan_code);
    UPDATE public.hangtag_subscription_payments SET status = 'paid', provider_payment_id = NULLIF(btrim(COALESCE(p_provider_payment, '')), ''),
        paid_at = NOW(), period_start = (per ->> 'start')::TIMESTAMPTZ, period_end = (per ->> 'end')::TIMESTAMPTZ,
        note = CASE WHEN over THEN 'Review: promo code used beyond its limit' ELSE note END
     WHERE id = pay.id;
    IF pay.promo_code IS NOT NULL THEN
        INSERT INTO public.hangtag_promo_redemptions (payment_id, code, owner_id, plan_code, discount)
        VALUES (pay.id, pay.promo_code, pay.owner_id, pay.plan_code, pay.discount) ON CONFLICT (payment_id) DO NOTHING;
    END IF;
    RETURN jsonb_build_object('ok', TRUE, 'already', FALSE, 'state', public.hangtag_subscription_state(pay.owner_id, NOW()),
        'plan_code', pay.plan_code, 'period_start', per ->> 'start', 'period_end', per ->> 'end');
END $function$;

-- hangtag_subscription_checkout(p_plan text, p_promo text, p_provider text)
CREATE OR REPLACE FUNCTION public.hangtag_subscription_checkout(p_plan text, p_promo text DEFAULT NULL::text, p_provider text DEFAULT 'razorpay'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
    me UUID := public.hangtag_subscription_owner();
    q JSONB;
    pid UUID;
    prov TEXT := lower(btrim(COALESCE(p_provider, '')));
BEGIN
    IF prov !~ '^[a-z][a-z0-9_]{1,30}$' OR prov IN ('manual', 'free') THEN RAISE EXCEPTION 'Choose a way to pay.' USING ERRCODE = 'P0001'; END IF;
    IF (SELECT count(*) FROM public.hangtag_subscription_payments y WHERE y.owner_id = me AND y.created_at > NOW() - interval '1 hour') >= 20 THEN
        RAISE EXCEPTION 'Too many payment attempts. Try again in an hour.' USING ERRCODE = 'P0001';
    END IF;
    -- one checkout at a time per promo code, so a burst of checkouts is counted against its limits one by one
    IF btrim(COALESCE(p_promo, '')) <> '' THEN
        PERFORM 1 FROM public.hangtag_promo_codes c WHERE c.code = upper(btrim(p_promo)) FOR UPDATE;
    END IF;
    q := public.hangtag_subscription_quote(p_plan, p_promo);
    IF q -> 'promo' IS NOT NULL AND jsonb_typeof(q -> 'promo') = 'object' AND NOT (q #>> '{promo,valid}')::BOOLEAN THEN
        RAISE EXCEPTION '%', q #>> '{promo,message}' USING ERRCODE = 'P0001';
    END IF;
    INSERT INTO public.hangtag_subscription_payments (owner_id, plan_code, price, discount, amount, currency, promo_code, provider, created_by)
    VALUES (me, q #>> '{plan,code}', (q ->> 'price')::NUMERIC, (q ->> 'discount')::NUMERIC, (q ->> 'amount')::NUMERIC, q ->> 'currency',
            CASE WHEN (q #>> '{promo,valid}')::BOOLEAN THEN q #>> '{promo,code}' END,
            CASE WHEN (q ->> 'amount')::NUMERIC = 0 THEN 'free' ELSE prov END, me)
    RETURNING id INTO pid;
    RETURN jsonb_build_object('payment_id', pid, 'plan_code', q #>> '{plan,code}', 'plan_label', q #>> '{plan,label}',
        'price', (q ->> 'price')::NUMERIC, 'discount', (q ->> 'discount')::NUMERIC, 'amount', (q ->> 'amount')::NUMERIC,
        'currency', q ->> 'currency', 'promo_code', CASE WHEN (q #>> '{promo,valid}')::BOOLEAN THEN q #>> '{promo,code}' END);
END $function$;

-- hangtag_subscription_ensure(p_owner uuid)
CREATE OR REPLACE FUNCTION public.hangtag_subscription_ensure(p_owner uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
    trial_days INT;
    em TEXT;
    k TEXT;
    nk TEXT;
    lp TEXT;
    dom TEXT;
    claimed UUID;
    started TIMESTAMPTZ := NOW();
BEGIN
    IF p_owner IS NULL OR EXISTS (SELECT 1 FROM public.hangtag_subscriptions s WHERE s.owner_id = p_owner) THEN RETURN; END IF;
    IF EXISTS (SELECT 1 FROM public.hangtag_members m WHERE m.user_id = p_owner) THEN RETURN; END IF;
    IF NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = p_owner) THEN RETURN; END IF;
    SELECT p.days INTO trial_days FROM public.hangtag_plans p WHERE p.code = 'trial';
    trial_days := COALESCE(trial_days, 7);
    SELECT lower(btrim(u.email)) INTO em FROM auth.users u WHERE u.id = p_owner;
    IF COALESCE(em, '') <> '' THEN
        k := md5(em);
        lp := regexp_replace(split_part(em, '@', 1), '\+.*$', '');
        dom := split_part(em, '@', 2);
        IF dom IN ('gmail.com', 'googlemail.com') THEN lp := replace(lp, '.', ''); dom := 'gmail.com'; END IF;
        nk := md5(lp || '@' || dom);
        INSERT INTO public.hangtag_trial_claims (email_key, owner_id) VALUES (nk, p_owner) ON CONFLICT (email_key) DO NOTHING;
        IF k <> nk THEN INSERT INTO public.hangtag_trial_claims (email_key, owner_id) VALUES (k, p_owner) ON CONFLICT (email_key) DO NOTHING; END IF;
        SELECT c.owner_id INTO claimed FROM public.hangtag_trial_claims c WHERE c.email_key IN (k, nk) AND c.owner_id <> p_owner LIMIT 1;
    END IF;
    INSERT INTO public.hangtag_subscriptions (owner_id, trial_started_at, trial_ends_at)
    VALUES (p_owner, started, CASE WHEN claimed IS NOT NULL THEN started ELSE started + make_interval(days => trial_days) END)
    ON CONFLICT (owner_id) DO NOTHING;
END $function$;

-- hangtag_subscription_plans()
CREATE OR REPLACE FUNCTION public.hangtag_subscription_plans()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
    SELECT COALESCE(jsonb_agg(jsonb_build_object('code', p.code, 'label', p.label, 'months', p.months, 'price', p.price, 'currency', p.currency)
        ORDER BY p.sort, p.months), '[]'::jsonb)
      FROM public.hangtag_plans p WHERE p.kind = 'paid' AND p.active;
$function$;

-- hangtag_subscription_quote(p_plan text, p_promo text)
CREATE OR REPLACE FUNCTION public.hangtag_subscription_quote(p_plan text, p_promo text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
    me UUID := public.hangtag_subscription_owner();
    pl RECORD;
    promo JSONB;
    disc NUMERIC(12,2) := 0;
BEGIN
    SELECT p.code, p.label, p.months, p.price, p.currency INTO pl FROM public.hangtag_plans p WHERE p.code = p_plan AND p.kind = 'paid' AND p.active;
    IF NOT FOUND THEN RAISE EXCEPTION 'Choose a plan.' USING ERRCODE = 'P0001'; END IF;
    IF btrim(COALESCE(p_promo, '')) <> '' THEN
        promo := public.hangtag_promo_evaluate(me, pl.code, p_promo);
        IF (promo ->> 'valid')::BOOLEAN THEN disc := (promo ->> 'discount')::NUMERIC; END IF;
    END IF;
    RETURN jsonb_build_object('ok', TRUE, 'plan', jsonb_build_object('code', pl.code, 'label', pl.label, 'months', pl.months),
        'price', pl.price, 'discount', disc, 'amount', pl.price - disc, 'currency', pl.currency, 'promo', promo);
END $function$;

-- hangtag_subscription_state(p_owner uuid, p_now timestamp with time zone)
CREATE OR REPLACE FUNCTION public.hangtag_subscription_state(p_owner uuid, p_now timestamp with time zone DEFAULT now())
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE s RECORD;
BEGIN
    SELECT x.suspended, x.trial_ends_at, x.period_end INTO s FROM public.hangtag_subscriptions x WHERE x.owner_id = p_owner;
    IF NOT FOUND THEN RETURN 'none'; END IF;
    IF s.suspended THEN RETURN 'suspended'; END IF;
    IF s.period_end IS NOT NULL AND s.period_end > p_now THEN RETURN 'paid_active'; END IF;
    IF s.trial_ends_at > p_now THEN RETURN 'trial_active'; END IF;
    IF s.period_end IS NOT NULL THEN RETURN 'paid_expired'; END IF;
    RETURN 'trial_expired';
END $function$;

-- hangtag_subscription_status()
CREATE OR REPLACE FUNCTION public.hangtag_subscription_status()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
    shop UUID := public.hangtag_shop_id();
    n TIMESTAMPTZ := NOW();
    s RECORD;
    st TEXT;
    plan_label TEXT;
    trial_days INT;
    until_at TIMESTAMPTZ;
BEGIN
    IF shop IS NULL THEN
        RETURN jsonb_build_object('state', 'none', 'server_now', n, 'is_owner', FALSE, 'days_left', 0, 'suspended', FALSE);
    END IF;
    IF EXISTS (SELECT 1 FROM public.hangtag_profiles p WHERE p.id = shop AND p.onboarded_at IS NOT NULL) THEN
        PERFORM public.hangtag_subscription_ensure(shop);
    END IF;
    SELECT * INTO s FROM public.hangtag_subscriptions x WHERE x.owner_id = shop;
    st := public.hangtag_subscription_state(shop, n);
    SELECT p.days INTO trial_days FROM public.hangtag_plans p WHERE p.code = 'trial';
    IF s.owner_id IS NULL THEN
        RETURN jsonb_build_object('state', st, 'server_now', n, 'is_owner', shop = auth.uid(), 'days_left', 0, 'suspended', FALSE,
            'trial_days', COALESCE(trial_days, 7));
    END IF;
    SELECT p.label INTO plan_label FROM public.hangtag_plans p WHERE p.code = s.plan_code;
    until_at := GREATEST(s.trial_ends_at, s.period_end);
    RETURN jsonb_build_object(
        'state', st,
        'plan_code', s.plan_code,
        'plan_label', plan_label,
        'trial_days', COALESCE(trial_days, 7),
        'trial_started_at', s.trial_started_at,
        'trial_ends_at', s.trial_ends_at,
        'period_start', s.period_start,
        'period_end', s.period_end,
        'access_until', until_at,
        'days_left', CASE WHEN st IN ('trial_active', 'paid_active') THEN GREATEST(0, ceil(extract(epoch FROM (until_at - n)) / 86400))::INT ELSE 0 END,
        'server_now', n,
        'is_owner', shop = auth.uid(),
        'suspended', s.suspended,
        'suspended_reason', CASE WHEN shop = auth.uid() THEN s.suspended_reason END);
END $function$;

CREATE INDEX IF NOT EXISTS idx_hangtag_sale_items_sale ON public.hangtag_sale_items USING btree (sale_id);
CREATE INDEX IF NOT EXISTS idx_hangtag_sales_time ON public.hangtag_sales USING btree ("timestamp" DESC);
CREATE INDEX IF NOT EXISTS idx_hangtag_sizes_prod ON public.hangtag_sizes USING btree (product_id);
COMMIT;
