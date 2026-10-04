-- ==============================================================================
-- Hangtag: bank accounts, and the mobile store's logo and city (schema.sql section 3s)
--   the shop's bank accounts (opening balance and date, active, default, which payment methods land in each) and the money
--   moved in them by hand (money in, money out, transfers, adjustments with a reason, reversals)
--
-- For the live database that supabase/schema.sql builds (the hangtag_* tables). It needs everything up to section 3r
-- (commerce batch) already applied: run supabase/schema.sql once, or run this file after it. Safe to run again.
-- It is exactly section 3s of schema.sql plus the row security rules and grants section 5 gives these tables, so running
-- the whole schema.sql again gives the same result.
--
-- How to apply: Supabase → SQL Editor → New query → paste this file → Run (or `supabase db push`).
-- ==============================================================================
-- ==============================================================================
-- 3s. Bank accounts (UX productization): the shop's bank accounts and the money moved in them by hand
--   An account has its opening balance on a date, is active or switched off, may be the default account, and may take
--   payment methods (UPI → one account, card machine settlements → another; unmapped methods go to the default account).
--   Entries made by hand: money in, money out, a transfer between two accounts of the shop, an adjustment with its reason
--   (signed), and a reversal of a whole entry made by mistake. Like cash entries (section 3h) they are added, never changed
--   or removed. The UPI and card money of the bank book (section 3e) is counted into the mapped account by the app; this
--   section adds no trigger to sales. Accounts are switched off, never deleted, so their entries keep their account.
-- ==============================================================================
CREATE TABLE IF NOT EXISTS public.hangtag_bank_accounts (
    owner_id UUID NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
    id TEXT NOT NULL CHECK (char_length(id) BETWEEN 1 AND 64),
    name TEXT NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 60),
    bank TEXT CHECK (bank IS NULL OR char_length(bank) <= 60),
    last4 TEXT CHECK (last4 IS NULL OR last4 ~ '^[0-9]{4}$'),
    opening NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (abs(opening) <= 1000000000),
    opening_date DATE NOT NULL DEFAULT CURRENT_DATE,
    active BOOLEAN NOT NULL DEFAULT true,
    is_default BOOLEAN NOT NULL DEFAULT false,
    methods TEXT[] NOT NULL DEFAULT '{}' CHECK (methods <@ ARRAY['upi','card']::TEXT[]),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (owner_id, id)
);
CREATE TABLE IF NOT EXISTS public.hangtag_bank_moves (
    owner_id UUID NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
    id TEXT NOT NULL CHECK (char_length(id) BETWEEN 1 AND 64),
    account_id TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('in','out','transfer','adjust','reversal')),
    amount NUMERIC(14,2) NOT NULL CHECK (amount <> 0 AND abs(amount) <= 1000000000),
    to_account TEXT,
    reason TEXT CHECK (reason IS NULL OR char_length(reason) BETWEEN 3 AND 200),
    reverses TEXT,
    t BIGINT NOT NULL,
    device_id TEXT,
    user_id UUID DEFAULT auth.uid(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (owner_id, id),
    CONSTRAINT hangtag_bank_moves_account_fkey FOREIGN KEY (owner_id, account_id) REFERENCES public.hangtag_bank_accounts (owner_id, id),
    CONSTRAINT hangtag_bank_moves_to_fkey FOREIGN KEY (owner_id, to_account) REFERENCES public.hangtag_bank_accounts (owner_id, id),
    CONSTRAINT hangtag_bank_moves_reverses_fkey FOREIGN KEY (owner_id, reverses) REFERENCES public.hangtag_bank_moves (owner_id, id)
);
-- a transfer names another account (its reversal names the same two); an adjustment and a reversal say why; only they may be
-- negative (an adjustment down, and the reversal of one)
ALTER TABLE public.hangtag_bank_moves DROP CONSTRAINT IF EXISTS hangtag_bank_moves_kind_check;
ALTER TABLE public.hangtag_bank_moves ADD CONSTRAINT hangtag_bank_moves_kind_check CHECK (
    (type IN ('transfer','reversal') OR to_account IS NULL) AND (type <> 'transfer' OR (to_account IS NOT NULL AND to_account <> account_id))
    AND (type = 'reversal') = (reverses IS NOT NULL)
    AND (type NOT IN ('adjust','reversal') OR reason IS NOT NULL)
    AND (type IN ('adjust','reversal') OR amount > 0));
CREATE UNIQUE INDEX IF NOT EXISTS hangtag_bank_moves_reversed_once ON public.hangtag_bank_moves (owner_id, reverses) WHERE reverses IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_hangtag_bank_moves_account ON public.hangtag_bank_moves (owner_id, account_id, t);
-- a reversal is of a whole entry that is not itself a reversal, on the same accounts
CREATE OR REPLACE FUNCTION public.hangtag_bank_move_check()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE o RECORD;
BEGIN
    IF NEW.type = 'reversal' THEN
        SELECT type, amount, account_id, to_account INTO o FROM public.hangtag_bank_moves WHERE owner_id = NEW.owner_id AND id = NEW.reverses;
        IF o.type IS NULL THEN RAISE EXCEPTION 'Bank entry % was not found', NEW.reverses USING ERRCODE = 'foreign_key_violation'; END IF;
        IF o.type = 'reversal' OR o.amount <> NEW.amount OR o.account_id <> NEW.account_id OR o.to_account IS DISTINCT FROM NEW.to_account THEN
            RAISE EXCEPTION 'A reversal must be for the whole of an entry that is not itself a reversal' USING ERRCODE = 'check_violation';
        END IF;
    END IF;
    RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS hangtag_bank_move_check ON public.hangtag_bank_moves;
CREATE TRIGGER hangtag_bank_move_check BEFORE INSERT ON public.hangtag_bank_moves FOR EACH ROW EXECUTE FUNCTION public.hangtag_bank_move_check();
REVOKE EXECUTE ON FUNCTION public.hangtag_bank_move_check() FROM PUBLIC, anon;
-- an account's changes keep when they were made
CREATE OR REPLACE FUNCTION public.hangtag_bank_account_touch()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN NEW.updated_at := NOW(); RETURN NEW; END $$;
DROP TRIGGER IF EXISTS hangtag_bank_account_touch ON public.hangtag_bank_accounts;
CREATE TRIGGER hangtag_bank_account_touch BEFORE UPDATE ON public.hangtag_bank_accounts FOR EACH ROW EXECUTE FUNCTION public.hangtag_bank_account_touch();
REVOKE EXECUTE ON FUNCTION public.hangtag_bank_account_touch() FROM PUBLIC, anon;

-- The public mobile store's catalog (section 3r) also gives the shop's city and its logo, so the storefront looks like the
-- shop's own (both are already on every receipt the shop hands out). Everything else is exactly as section 3r defines it.
CREATE OR REPLACE FUNCTION public.hangtag_mobile_catalog(p_token TEXT)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE shop RECORD; items JSONB; cats JSONB; logo TEXT; tax_on BOOLEAN := FALSE; tax_incl BOOLEAN := TRUE; default_rate NUMERIC := 5;
BEGIN
    IF p_token IS NULL OR p_token !~ '^st_[A-Za-z0-9_-]{32,61}$' THEN
        RETURN jsonb_build_object('ok', FALSE, 'message', 'This shop link is not valid. Ask the shop for a new link.');
    END IF;
    SELECT p.id, p.shop_name, p.city INTO shop FROM public.hangtag_profiles p WHERE p.store_token = p_token;
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
    -- the shop's logo (the one printed on its receipts), only when it is a picture
    SELECT CASE WHEN jsonb_typeof(m.value) = 'string' AND (m.value #>> '{}') ~ '^data:image/(png|jpeg|webp);base64,' THEN m.value #>> '{}' END
      INTO logo FROM public.hangtag_meta m WHERE m.owner_id = shop.id AND m.key = 'logo';
    RETURN jsonb_build_object('ok', TRUE, 'shop', COALESCE(NULLIF(btrim(shop.shop_name), ''), 'Shop'), 'city', NULLIF(btrim(COALESCE(shop.city, '')), ''), 'logo', logo, 'tax_on', tax_on,
        'tax_inclusive', tax_incl, 'items', items, 'categories', cats);
END $$;

-- Row security (section 5): owner and managers read (view_reports or manage_settings); accounts are added and changed with
-- manage_settings, never removed; entries are added with view_reports or manage_settings, never changed or removed
ALTER TABLE public.hangtag_bank_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hangtag_bank_moves ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hangtag_bank_accounts ALTER COLUMN owner_id SET DEFAULT public.hangtag_shop_id();
ALTER TABLE public.hangtag_bank_moves ALTER COLUMN owner_id SET DEFAULT public.hangtag_shop_id();
DROP POLICY IF EXISTS "Shop read" ON public.hangtag_bank_accounts;
DROP POLICY IF EXISTS "Shop write (add)" ON public.hangtag_bank_accounts;
DROP POLICY IF EXISTS "Shop write (change)" ON public.hangtag_bank_accounts;
DROP POLICY IF EXISTS "Shop write (remove)" ON public.hangtag_bank_accounts;
CREATE POLICY "Shop read" ON public.hangtag_bank_accounts FOR SELECT TO authenticated
    USING (owner_id = (SELECT public.hangtag_shop_id()) AND ((SELECT public.hangtag_can('view_reports')) OR (SELECT public.hangtag_can('manage_settings'))));
CREATE POLICY "Shop write (add)" ON public.hangtag_bank_accounts FOR INSERT TO authenticated
    WITH CHECK (owner_id = (SELECT public.hangtag_shop_id()) AND ((SELECT public.hangtag_can('manage_settings'))));
CREATE POLICY "Shop write (change)" ON public.hangtag_bank_accounts FOR UPDATE TO authenticated
    USING (owner_id = (SELECT public.hangtag_shop_id()) AND ((SELECT public.hangtag_can('manage_settings'))))
    WITH CHECK (owner_id = (SELECT public.hangtag_shop_id()) AND ((SELECT public.hangtag_can('manage_settings'))));
CREATE POLICY "Shop write (remove)" ON public.hangtag_bank_accounts FOR DELETE TO authenticated
    USING (owner_id = (SELECT public.hangtag_shop_id()) AND (SELECT public.hangtag_role()) = 'owner');
DROP POLICY IF EXISTS "Shop read" ON public.hangtag_bank_moves;
DROP POLICY IF EXISTS "Shop write (add)" ON public.hangtag_bank_moves;
DROP POLICY IF EXISTS "Shop write (change)" ON public.hangtag_bank_moves;
DROP POLICY IF EXISTS "Shop write (remove)" ON public.hangtag_bank_moves;
CREATE POLICY "Shop read" ON public.hangtag_bank_moves FOR SELECT TO authenticated
    USING (owner_id = (SELECT public.hangtag_shop_id()) AND ((SELECT public.hangtag_can('view_reports')) OR (SELECT public.hangtag_can('manage_settings'))));
CREATE POLICY "Shop write (add)" ON public.hangtag_bank_moves FOR INSERT TO authenticated
    WITH CHECK (owner_id = (SELECT public.hangtag_shop_id()) AND ((SELECT public.hangtag_can('view_reports')) OR (SELECT public.hangtag_can('manage_settings'))));
CREATE POLICY "Shop write (change)" ON public.hangtag_bank_moves FOR UPDATE TO authenticated
    USING (owner_id = (SELECT public.hangtag_shop_id()) AND (SELECT public.hangtag_role()) = 'owner')
    WITH CHECK (owner_id = (SELECT public.hangtag_shop_id()) AND (SELECT public.hangtag_role()) = 'owner');
CREATE POLICY "Shop write (remove)" ON public.hangtag_bank_moves FOR DELETE TO authenticated
    USING (owner_id = (SELECT public.hangtag_shop_id()) AND (SELECT public.hangtag_role()) = 'owner');
REVOKE ALL ON TABLE public.hangtag_bank_accounts, public.hangtag_bank_moves FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.hangtag_bank_accounts TO authenticated;
GRANT SELECT, INSERT ON TABLE public.hangtag_bank_moves TO authenticated;
-- live updates between the shop's devices
DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['hangtag_bank_accounts','hangtag_bank_moves'] LOOP
        BEGIN EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t); EXCEPTION WHEN OTHERS THEN NULL; END;
    END LOOP;
END $$;
