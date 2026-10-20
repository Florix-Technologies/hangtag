// Every change the post-repair migration (supabase/migrations/20261019120000_hangtag_post_repair_integrity.sql) makes to a
// function it takes from supabase/schema.sql: each such function is schema.sql's last definition with exactly these
// replacements, in order, and nothing else. The migration is generated from this list, and
// supabase/tests/post-repair-integrity.test.mjs checks, function by function, that the migration's text is schema.sql's
// text with these edits — so reviewing this file reviews every change to an existing function. (Functions the migration
// adds are new and are read in the migration itself.) No existing function's arguments change: a later run of schema.sql
// can then only put an older body back (the migration is run again), never leave two versions side by side.
export const lf = (s) => String(s).replace(/\r\n/g, '\n');

/* A function's text: from its last CREATE OR REPLACE in `text` to the end of its body */
export function fnText(text, name) {
  const t = lf(text), head = `CREATE OR REPLACE FUNCTION public.${name}(`, i = t.lastIndexOf(head);
  if (i < 0) throw new Error('no function ' + name);
  const a = t.indexOf('\n$$;', i), b = t.indexOf('END $$;', i);
  return t.slice(i, a >= 0 && (b < 0 || a < b) ? a + 4 : b + 7);
}

/* The edits applied in order; each target must occur exactly once in the text it is applied to */
export function applyEdits(text, edits, name = '') {
  return edits.reduce((s, [find, repl], k) => {
    const parts = s.split(find);
    if (parts.length !== 2) throw new Error(`${name} edit ${k + 1}: its target occurs ${parts.length - 1} times, not once`);
    return parts.join(repl);
  }, text);
}

export const FUNCTION_EDITS = [
  { name: 'hangtag_check_return_qty', section: 1, what: 'one return of a bill line at a time: the line\'s lock before the sum', edits: [
    [`BEGIN
    SELECT quantity INTO bought FROM public.hangtag_sale_items`, `BEGIN
    -- one return of this bill line at a time (post-repair 1): a second, at the same moment, waits here and then counts the first
    PERFORM pg_advisory_xact_lock(hashtextextended('hangtag_return_line:' || NEW.owner_id::text || ':' || NEW.sale_id || ':' || NEW.sale_line_no::text, 0));
    SELECT quantity INTO bought FROM public.hangtag_sale_items`],
  ] },
  { name: 'hangtag_save_sales', section: 3, what: 'a bill line keeps the unit it was sold in (a re-sent line keeps the first)', edits: [
    [`line_total, hsn, serials, batches, kit)
        SELECT s.id,`, `line_total, hsn, serials, batches, kit, unit)
        SELECT s.id,`],
    [`i.line_total, i.hsn, i.serials, i.batches, i.kit
        FROM jsonb_populate_recordset(NULL::public.hangtag_sale_items`, `i.line_total, i.hsn, i.serials, i.batches, i.kit, NULLIF(btrim(i.unit), '')
        FROM jsonb_populate_recordset(NULL::public.hangtag_sale_items`],
  ] },
  { name: 'hangtag_cap_on', section: 5, what: 'an app account asks about its own shop only', edits: [
    [`BEGIN
    IF p_cap IN ('uses_mobile_store'`, `BEGIN
    -- an app account asks about its own shop only (post-repair 5); the public store pages and the database's own checks
    -- run without one, and ask about the shop they serve
    IF auth.uid() IS NOT NULL AND p_owner IS DISTINCT FROM public.hangtag_shop_id() THEN RETURN FALSE; END IF;
    IF p_cap IN ('uses_mobile_store'`],
  ] },
  { name: 'hangtag_subscription_checkout', section: 7, what: 'no payment from a suspended shop; an AutoPay the provider halted is handed back to be cancelled first', edits: [
    [`    prov TEXT := lower(btrim(COALESCE(p_provider, '')));
BEGIN`, `    prov TEXT := lower(btrim(COALESCE(p_provider, '')));
    halted JSONB;
BEGIN`],
    [`    IF prov !~ '^[a-z][a-z0-9_]{1,30}$' OR prov IN ('manual', 'free') THEN RAISE EXCEPTION 'Choose a way to pay.' USING ERRCODE = 'P0001'; END IF;
`, `    IF prov !~ '^[a-z][a-z0-9_]{1,30}$' OR prov IN ('manual', 'free') THEN RAISE EXCEPTION 'Choose a way to pay.' USING ERRCODE = 'P0001'; END IF;
    -- a suspended shop can't start a payment (post-repair 7); one it started before is still honoured when its money comes
    IF EXISTS (SELECT 1 FROM public.hangtag_subscriptions s WHERE s.owner_id = me AND s.suspended) THEN
        RAISE EXCEPTION 'This shop is suspended. Contact Hangtag support.' USING ERRCODE = 'P0001';
    END IF;
`],
    [`        RAISE EXCEPTION 'AutoPay is set up for this shop. Turn AutoPay off before paying for a plan.' USING ERRCODE = 'P0001';
    END IF;
`, `        RAISE EXCEPTION 'AutoPay is set up for this shop. Turn AutoPay off before paying for a plan.' USING ERRCODE = 'P0001';
    END IF;
    -- an AutoPay the provider stopped (halted) and that isn't confirmed off there: handed back, to be turned off before this
    -- payment's page is made, so it can't charge as well (post-repair 9: the function does it, and refuses when it can't)
    SELECT CASE WHEN s.autopay_status = 'halted' AND s.autopay_subscription_id IS NOT NULL AND NOT EXISTS (
                SELECT 1 FROM public.hangtag_autopay_mandates m WHERE m.provider = s.autopay_provider AND m.subscription_id = s.autopay_subscription_id
                   AND m.cancel_confirmed_at IS NOT NULL)
                THEN jsonb_build_object('provider', s.autopay_provider, 'subscription_id', s.autopay_subscription_id) END
      INTO halted FROM public.hangtag_subscriptions s WHERE s.owner_id = me;
`],
    [`        'currency', q ->> 'currency', 'promo_code', CASE WHEN (q #>> '{promo,valid}')::BOOLEAN THEN q #>> '{promo,code}' END);`,
     `        'currency', q ->> 'currency', 'promo_code', CASE WHEN (q #>> '{promo,valid}')::BOOLEAN THEN q #>> '{promo,code}' END,
        'cancel_mandate', halted);`],
  ] },
  { name: 'hangtag_subscription_attach', section: 7, what: 'a payment page is attached only to a payment still open for it, and the caller hears when it isn\'t', edits: [
    [`     WHERE id = p_payment AND status = 'created';
END $$;`, `     WHERE id = p_payment AND status = 'created' AND (provider_order_id IS NULL OR provider_order_id = p_order);
    -- a payment already failed, paid or given another page takes none (post-repair 7): the caller withdraws the page it made
    IF NOT FOUND THEN RAISE EXCEPTION 'This payment can''t take a payment page any more.' USING ERRCODE = 'P0001'; END IF;
END $$;`],
  ] },
  { name: 'hangtag_promo_evaluate', section: 8, what: 'a place in a capped offer is held only by a real checkout, one per shop, and not by a shop that keeps letting its checkouts lapse', edits: [
    [`    SELECT count(*) INTO held FROM public.hangtag_subscription_payments y WHERE y.promo_code = v_code AND y.status = 'created'
       AND y.created_at > NOW() - interval '30 minutes' AND y.owner_id IS DISTINCT FROM p_owner;
`, `    -- a place is held only by a real checkout (its payment page made: attached by the service role), one per shop, and not by
    -- a shop that let two such checkouts of this code lapse unpaid in the last day (post-repair 8)
    SELECT count(DISTINCT y.owner_id) INTO held FROM public.hangtag_subscription_payments y WHERE y.promo_code = v_code AND y.status = 'created'
       AND y.provider_order_id IS NOT NULL AND y.created_at > NOW() - interval '30 minutes' AND y.owner_id IS DISTINCT FROM p_owner
       AND (SELECT count(*) FROM public.hangtag_subscription_payments z WHERE z.owner_id = y.owner_id AND z.promo_code = v_code
              AND z.provider_order_id IS NOT NULL AND z.status <> 'paid'
              AND z.created_at BETWEEN NOW() - interval '24 hours' AND NOW() - interval '30 minutes') < 2;
`],
  ] },
  { name: 'hangtag_autopay_begin', section: 9, what: 'every AutoPay set-up registered with the price and currency agreed to; the earlier ones handed back to be cancelled', edits: [
    [`DECLARE me UUID := public.hangtag_subscription_owner(); t JSONB; s RECORD;`,
     `DECLARE me UUID := public.hangtag_subscription_owner(); t JSONB; s RECORD; mid UUID; cancel_list JSONB;`],
    [`     WHERE owner_id = me;
    RETURN t || jsonb_build_object('owner', me, 'previous', CASE`, `     WHERE owner_id = me;
    -- the registry (post-repair 9): the shop's earlier set-ups are replaced, each not yet off at the provider to be cancelled
    -- there (a waiting or a halted one included); this one is the current set-up, with the plan, price and currency agreed to
    UPDATE public.hangtag_autopay_mandates m SET is_current = FALSE,
        cancel_requested_at = CASE WHEN m.subscription_id IS NOT NULL AND m.cancel_confirmed_at IS NULL
            AND COALESCE(m.provider_status, '') NOT IN ('cancelled', 'completed', 'expired') THEN COALESCE(m.cancel_requested_at, NOW())
            ELSE m.cancel_requested_at END
     WHERE m.shop_owner_id = me AND m.is_current;
    INSERT INTO public.hangtag_autopay_mandates (shop_owner_id, plan_code, price, currency, mode, is_current)
    VALUES (me, t #>> '{plan,code}', (t ->> 'price')::NUMERIC, COALESCE(t ->> 'currency', 'INR'), public.hangtag_billing_mode(), TRUE)
    RETURNING id INTO mid;
    SELECT COALESCE(jsonb_agg(jsonb_build_object('provider', m.provider, 'subscription_id', m.subscription_id) ORDER BY m.created_at), '[]'::jsonb)
      INTO cancel_list FROM public.hangtag_autopay_mandates m
     WHERE m.shop_owner_id = me AND NOT m.is_current AND m.subscription_id IS NOT NULL AND m.cancel_confirmed_at IS NULL
       AND COALESCE(m.provider_status, '') NOT IN ('cancelled', 'completed', 'expired');
    RETURN t || jsonb_build_object('owner', me, 'mandate_id', mid, 'to_cancel', cancel_list, 'previous', CASE`],
  ] },
  { name: 'hangtag_autopay_terms', section: 11, what: 'AutoPay offered only while its notifications are proven', edits: [
    [`    RETURN jsonb_build_object('available', COALESCE(cfg.autopay_enabled, FALSE) AND pl.code IS NOT NULL,`,
     `    -- offered only while AutoPay's notifications are proven to reach this database (post-repair 11)
    RETURN jsonb_build_object('available', COALESCE(cfg.autopay_enabled, FALSE) AND pl.code IS NOT NULL
            AND COALESCE((public.hangtag_billing_readiness() ->> 'ready')::BOOLEAN, FALSE),`],
  ] },
  { name: 'hangtag_platform_settings_save', section: 11, what: 'AutoPay switched on only once its notifications are proven (a save that keeps it on still works); the proof in the audit', edits: [
    [`DECLARE r TEXT := public.hangtag_platform_require('settings.manage'); c public.hangtag_platform_config; before JSONB; bad TEXT;`,
     `DECLARE r TEXT := public.hangtag_platform_require('settings.manage'); c public.hangtag_platform_config; before JSONB; bad TEXT; rd JSONB;`],
    [`        RAISE EXCEPTION 'AutoPay renews a paid plan on sale.' USING ERRCODE = 'P0001';
    END IF;
`, `        RAISE EXCEPTION 'AutoPay renews a paid plan on sale.' USING ERRCODE = 'P0001';
    END IF;
    -- AutoPay is switched on — or made a condition of new trials — only once its provider's notifications are proven
    -- (post-repair 11); a save that changes nothing about it still works while the proof has lapsed
    rd := public.hangtag_billing_readiness();
    IF ((c.autopay_enabled AND NOT COALESCE((before ->> 'autopay_enabled')::BOOLEAN, FALSE))
        OR (c.autopay_enabled AND c.trial_requires_autopay
            AND NOT (COALESCE((before ->> 'autopay_enabled')::BOOLEAN, FALSE) AND COALESCE((before ->> 'trial_requires_autopay')::BOOLEAN, FALSE))))
       AND NOT COALESCE((rd ->> 'ready')::BOOLEAN, FALSE) THEN
        RAISE EXCEPTION 'AutoPay can''t be switched on yet: its webhook isn''t proven (%).',
            array_to_string(ARRAY(SELECT jsonb_array_elements_text(rd -> 'reasons')), '; ') USING ERRCODE = 'P0001';
    END IF;
`],
    [`        'after', (SELECT to_jsonb(x) - 'updated_at' - 'updated_by' FROM public.hangtag_platform_config x WHERE x.id)));`,
     `        'after', (SELECT to_jsonb(x) - 'updated_at' - 'updated_by' FROM public.hangtag_platform_config x WHERE x.id), 'readiness', rd));`],
  ] },
  { name: 'hangtag_subscription_ensure', section: 11, what: 'a new trial waits for AutoPay only while AutoPay can be set up', edits: [
    [`    SELECT c.autopay_enabled AND c.trial_requires_autopay, c.autopay_plan_code INTO need_ap, ap_plan FROM public.hangtag_platform_config c WHERE c.id;
`, `    SELECT c.autopay_enabled AND c.trial_requires_autopay, c.autopay_plan_code INTO need_ap, ap_plan FROM public.hangtag_platform_config c WHERE c.id;
    -- a new trial waits for AutoPay only while AutoPay can actually be set up (post-repair 11): a lapsed proof locks no new shop
    IF need_ap THEN need_ap := COALESCE((public.hangtag_billing_readiness() ->> 'ready')::BOOLEAN, FALSE); END IF;
`],
  ] },
];
