-- Read-only. What the data changes in supabase/schema.sql (26: backfills from earlier versions) would touch on this database
-- now — run it right before running schema.sql on the live project. Every number should be 0: then schema.sql changes no
-- shop's rows. A number that isn't 0 says which rows it would change; stop and look before running it.
SELECT json_build_object(
 '01 profiles for accounts without one', (SELECT count(*) FROM auth.users u WHERE NOT EXISTS (SELECT 1 FROM public.hangtag_profiles p WHERE p.id = u.id)),
 '02 rows without an owner (the script stops if any)', (SELECT (SELECT count(*) FROM public.hangtag_products WHERE owner_id IS NULL) + (SELECT count(*) FROM public.hangtag_sizes WHERE owner_id IS NULL)
      + (SELECT count(*) FROM public.hangtag_images WHERE owner_id IS NULL) + (SELECT count(*) FROM public.hangtag_sales WHERE owner_id IS NULL)
      + (SELECT count(*) FROM public.hangtag_sale_items WHERE owner_id IS NULL) + (SELECT count(*) FROM public.hangtag_meta WHERE owner_id IS NULL)),
 '03 variants made from old sizes', (SELECT count(*) FROM public.hangtag_sizes s JOIN public.hangtag_products p ON p.owner_id = s.owner_id AND p.id = s.product_id
      WHERE NOT EXISTS (SELECT 1 FROM public.hangtag_variants v WHERE v.owner_id = s.owner_id AND v.product_id = s.product_id)),
 '04 variants for products without one', (SELECT count(*) FROM public.hangtag_products p WHERE NOT EXISTS (SELECT 1 FROM public.hangtag_variants v WHERE v.owner_id = p.owner_id AND v.product_id = p.id)),
 '05 products whose empty options are filled', (SELECT count(*) FROM public.hangtag_products p WHERE (p.options IS NULL OR p.options = '{}'::jsonb)
      AND NOT EXISTS (SELECT 1 FROM public.hangtag_variants v WHERE v.owner_id = p.owner_id AND v.product_id = p.id AND (v.color <> '' OR NOT v.active))),
 '06 opening stock records from old sizes (new ones only)', (SELECT count(*) FROM public.hangtag_sizes s WHERE s.stock <> 0
      AND EXISTS (SELECT 1 FROM public.hangtag_variants v WHERE v.owner_id = s.owner_id AND v.id = s.product_id || ':' || s.size)
      AND NOT EXISTS (SELECT 1 FROM public.hangtag_stock_moves m WHERE m.owner_id = s.owner_id AND m.id = 'open:' || s.product_id || ':' || s.size)),
 '07 bill lines given their variant', (SELECT count(*) FROM public.hangtag_sale_items si WHERE si.variant_id IS NULL
      AND EXISTS (SELECT 1 FROM public.hangtag_variants v WHERE v.owner_id = si.owner_id AND v.id = si.product_id || ':' || si.size)),
 '08 products whose options are rewritten (no opts yet)', (SELECT count(*) FROM public.hangtag_products WHERE NOT (COALESCE(options, '{}'::jsonb) ? 'opts')),
 '09 bills given GST fields (gst_mode missing)', (SELECT count(*) FROM public.hangtag_sales WHERE gst_mode IS NULL),
 '10 payments made for bills without one', (SELECT count(*) FROM public.hangtag_sales s WHERE s.total - s.credit > 0 AND s.payment_method IN ('cash','upi','card')
      AND NOT EXISTS (SELECT 1 FROM public.hangtag_payments p WHERE p.owner_id = s.owner_id AND p.sale_id = s.id)),
 '11 refunds posted to the books again', (SELECT count(*) FROM public.hangtag_returns r WHERE r.refund_amount > 0
      AND NOT EXISTS (SELECT 1 FROM public.hangtag_fin_txns f WHERE f.owner_id = r.owner_id AND f.return_id = r.id)),
 '12 payment fees copied from their intent', (SELECT count(*) FROM public.hangtag_payments p JOIN public.hangtag_payment_intents i ON p.owner_id = i.owner_id AND p.intent_id = i.id
      WHERE p.verification = 'verified' AND p.provider_fee IS DISTINCT FROM i.provider_fee),
 '13 business types renamed', (SELECT count(*) FROM public.hangtag_profiles WHERE business_type IS NOT NULL AND business_type NOT IN ('retail', 'grocery', 'restaurant', 'electronics', 'other',
      'Clothing boutique', 'Pop-up or exhibition stall', 'Retail store', 'Online seller', 'Wholesale', 'Other')),
 '14 products given unit pcs', (SELECT count(*) FROM public.hangtag_products WHERE unit IS NULL),
 '15 stock imports given a time', (SELECT count(*) FROM public.hangtag_stock_imports WHERE t IS NULL AND created_at IS NOT NULL),
 '16 order lines given unit pcs', (SELECT count(*) FROM public.hangtag_order_items WHERE unit IS NULL),
 '17 profiles given a store token', (SELECT count(*) FROM public.hangtag_profiles WHERE store_token IS NULL),
 '18 base plans added (missing)', (SELECT 4 - count(*) FROM public.hangtag_plans WHERE code IN ('trial', 'm1', 'm3', 'm6')),
 '19 12-month plan added (missing)', (SELECT 1 - count(*) FROM public.hangtag_plans WHERE code = 'm12'),
 '20 plan prices raised (still at the old price)', (SELECT count(*) FROM public.hangtag_plans p JOIN (VALUES ('m1', 499), ('m3', 1349), ('m6', 2499)) v(code, old_price) ON p.code = v.code AND p.price = v.old_price),
 '21 plan labels renamed (still the old label)', (SELECT count(*) FROM public.hangtag_plans p JOIN (VALUES ('m1', '1 month'), ('m3', '3 months'), ('m6', '6 months')) v(code, old_label) ON p.code = v.code AND p.label = v.old_label),
 '22 trial made 30 days (now 7)', (SELECT count(*) FROM public.hangtag_plans WHERE code = 'trial' AND days = 7),
 '23 promo code use counts raised', (SELECT count(*) FROM public.hangtag_promo_codes c JOIN (SELECT code, count(*)::INT AS n FROM public.hangtag_promo_redemptions GROUP BY code) r ON r.code = c.code WHERE c.redeemed < r.n),
 '24 launch offer code added (missing)', (SELECT 1 - count(*) FROM public.hangtag_promo_codes WHERE code = 'LAUNCH100'),
 '25 plan payments given their capture time', (SELECT count(*) FROM public.hangtag_subscription_payments WHERE status = 'paid' AND amount > 0 AND provider NOT IN ('manual', 'free') AND captured_at IS NULL AND paid_at IS NOT NULL),
 '26 platform settings row added (missing)', (SELECT 1 - count(*) FROM public.hangtag_platform_config)
) AS dryrun;
