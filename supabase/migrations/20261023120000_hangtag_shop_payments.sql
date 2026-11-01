-- Requires: supabase/schema.sql — and the repair: run only after RELEASE.md §3 has run and its checks are all ok
-- (supabase/REPAIR-RUNBOOK.md, step 6), on a database where no shop table is open to every account. The post-repair
-- migration (20261019120000) may come before or after it; it doesn't depend on this one, nor this one on it.
-- ==============================================================================
-- Shop payments (2026-10-23, the payment-first launch). Kept out of schema.sql on purpose, as the post-repair migration
-- is: schema.sql is the repair's script, and the repair's scope is pinned (supabase/tests/repair-inventory.test.mjs).
-- Until it is folded into schema.sql, run it again after any run of schema.sql (section 3h puts the payments' older
-- rule back, which doesn't know "confirmed").
--   1. A shop's own payment gateway account (hangtag_payment_accounts). A gateway is optional. A shop that connects one
--      connects ITS OWN merchant account — Razorpay keys made in the shop's own Razorpay dashboard — so the provider
--      settles the money to the shop's bank, never through Hangtag. Every shop's payments use its own account; there is no
--      shared Hangtag account for shops' customers (the payment-gateway function has no such keys at all). The key
--      secret and the webhook secret are stored only sealed by the payment-gateway function (AES-256-GCM with its
--      PAYMENT_ACCOUNTS_KEY secret, bound to the account and the field), so the table holds no usable secret; and no app
--      account can read or write the table at all (the function says what the app may show).
--   2. Every payment intent made from now on names the account it was made on, of the same shop (a foreign key on both
--      columns): it is checked, refunded and notified with that account only. Refunds keep the provider's outcome.
--   3. The provider's notifications are kept once per account and event id (a repeat changes nothing), with what each
--      changed: the shop's payment history, which those who see the books can read.
--   4. UPI paid to the shop's own UPI QR is "unverified" until someone who sees the books confirms it reached the shop's
--      account (hangtag_confirm_upi_payment): "confirmed", by whom and when (the audit log keeps the change). A phone
--      can't upload a UPI payment as recorded or confirmed, and sending a bill again never undoes a confirmation.
-- Run once, whole, in one transaction (the SQL Editor runs a script as one; with psql, `-1 -f`); running it again changes
-- nothing. It ends with its report and refuses to commit unless every row is ok: an error then, and nothing changed. Read-only check any time:
-- supabase/checks/shop-payments-report.sql. Undo: supabase/operations/shop-payments-undo.sql.
-- ==============================================================================

-- 0. Only after the repair, and never on a database open across shops: three functions the repair brings up to date
--    must be schema.sql's, byte for byte (the post-repair migration's check), and no shop table may have a policy that is
--    always true (the 2026-10-13 incident). Otherwise stop here, before anything changes.
DO $guard$
DECLARE stale TEXT[]; open_n INT;
BEGIN
    SELECT array_agg(e.fn) INTO stale FROM (VALUES
        ('public.hangtag_subscription_state(uuid,timestamp with time zone)', '828c8cd96bd4f3d5685087b07f1ea0ca'),
        ('public.hangtag_import_stock(jsonb,jsonb,jsonb,jsonb,boolean)', '2459d864861028bc4dbbe5a1564d3dfc'),
        ('public.hangtag_biz_changes()', 'cdee633ea7ae2b5cbdfdc3f88b0044d0')) e(fn, fp)
     WHERE to_regprocedure(e.fn) IS NULL
        OR (SELECT md5(replace(p.prosrc, chr(13), '')) FROM pg_proc p WHERE p.oid = to_regprocedure(e.fn)) IS DISTINCT FROM e.fp;
    IF stale IS NOT NULL THEN
        RAISE EXCEPTION 'Run the database repair first (supabase/REPAIR-RUNBOOK.md, step 6): % not yet as schema.sql has it. Nothing was changed.',
            array_to_string(stale, ', ') USING ERRCODE = 'P0001';
    END IF;
    SELECT count(*) INTO open_n FROM pg_policies p WHERE p.schemaname = 'public' AND p.permissive = 'PERMISSIVE'
       AND (btrim(COALESCE(p.qual, '')) IN ('true', '(true)') OR btrim(COALESCE(p.with_check, '')) IN ('true', '(true)'))
       AND EXISTS (SELECT 1 FROM information_schema.columns c WHERE c.table_schema = 'public' AND c.table_name = p.tablename AND c.column_name = 'owner_id');
    IF open_n > 0 THEN
        RAISE EXCEPTION 'A shop table is open to every account (% policies that are always true): contain and repair the database first. Nothing was changed.',
            open_n USING ERRCODE = 'P0001';
    END IF;
END $guard$;

-- 1. A shop's own payment gateway account: written only by the payment-gateway function (service role)
CREATE TABLE IF NOT EXISTS public.hangtag_payment_accounts (
    id UUID PRIMARY KEY,
    owner_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    mode TEXT NOT NULL,                      -- 'test' or 'live', from the key id
    key_id TEXT NOT NULL,                    -- the public half of the keys (shown masked)
    secret_box TEXT,                         -- the key secret, sealed: "v1.<iv>.<ciphertext>" (never the secret itself)
    webhook_box TEXT,                        -- the webhook secret, sealed the same way
    hook_id TEXT NOT NULL,                   -- random, in the webhook's address: which account a notification is for
    status TEXT NOT NULL DEFAULT 'connected',
    card_link BOOLEAN NOT NULL DEFAULT TRUE,
    checked_at TIMESTAMPTZ,                  -- when the provider last accepted the keys
    last_event_at TIMESTAMPTZ,               -- the last notification with a valid signature
    connected_by UUID,
    disconnected_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (owner_id, id),
    UNIQUE (hook_id)
);
ALTER TABLE public.hangtag_payment_accounts DROP CONSTRAINT IF EXISTS hangtag_payment_accounts_check;
ALTER TABLE public.hangtag_payment_accounts ADD CONSTRAINT hangtag_payment_accounts_check CHECK (
    provider IN ('razorpay') AND mode IN ('test','live') AND status IN ('connected','disconnected')
    AND key_id ~ '^rzp_(test|live)_[A-Za-z0-9]{6,40}$' AND (mode = 'live') = (key_id LIKE 'rzp\_live\_%')
    AND hook_id ~ '^[A-Za-z0-9_-]{32,64}$'
    AND (status = 'disconnected' OR (secret_box IS NOT NULL AND webhook_box IS NOT NULL))
    AND (status = 'connected' OR (secret_box IS NULL AND webhook_box IS NULL AND disconnected_at IS NOT NULL))
    AND (secret_box IS NULL OR (secret_box ~ '^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{24,}$' AND char_length(secret_box) <= 420))
    AND (webhook_box IS NULL OR (webhook_box ~ '^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{24,}$' AND char_length(webhook_box) <= 420)));
-- one connected account per shop (connecting another one disconnects the first)
CREATE UNIQUE INDEX IF NOT EXISTS hangtag_payment_accounts_connected ON public.hangtag_payment_accounts (owner_id) WHERE status = 'connected';
ALTER TABLE public.hangtag_payment_accounts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.hangtag_payment_accounts FROM PUBLIC, anon, authenticated;

-- 2. Payment intents name the shop's own account they were made on; refunds keep the provider's outcome
ALTER TABLE public.hangtag_payment_intents ADD COLUMN IF NOT EXISTS account_id UUID;
ALTER TABLE public.hangtag_payment_intents ADD COLUMN IF NOT EXISTS refund_status TEXT;
ALTER TABLE public.hangtag_payment_intents DROP CONSTRAINT IF EXISTS hangtag_payment_intents_account_fk;
ALTER TABLE public.hangtag_payment_intents ADD CONSTRAINT hangtag_payment_intents_account_fk FOREIGN KEY (owner_id, account_id)
    REFERENCES public.hangtag_payment_accounts (owner_id, id);
ALTER TABLE public.hangtag_payment_intents DROP CONSTRAINT IF EXISTS hangtag_payment_intents_refund_check;
ALTER TABLE public.hangtag_payment_intents ADD CONSTRAINT hangtag_payment_intents_refund_check CHECK (
    refund_status IS NULL OR (refund_status IN ('pending','processed','failed') AND refund_id IS NOT NULL));
CREATE INDEX IF NOT EXISTS idx_hangtag_payment_intents_account ON public.hangtag_payment_intents (account_id, provider_intent_id);
-- a new intent is made on an account (intents from before this migration have none and are left as they are)
CREATE OR REPLACE FUNCTION public.hangtag_intent_account_check()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
    IF NEW.account_id IS NULL THEN
        RAISE EXCEPTION 'A payment is taken on the shop''s own payment account: this one names none.' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS hangtag_intent_account_check ON public.hangtag_payment_intents;
CREATE TRIGGER hangtag_intent_account_check BEFORE INSERT ON public.hangtag_payment_intents FOR EACH ROW EXECUTE FUNCTION public.hangtag_intent_account_check();
REVOKE ALL ON FUNCTION public.hangtag_intent_account_check() FROM PUBLIC, anon, authenticated;
-- a return refunded through the provider keeps what the provider said of the refund
ALTER TABLE public.hangtag_returns ADD COLUMN IF NOT EXISTS provider_refund_status TEXT;
ALTER TABLE public.hangtag_returns DROP CONSTRAINT IF EXISTS hangtag_returns_provider_refund_check;
ALTER TABLE public.hangtag_returns ADD CONSTRAINT hangtag_returns_provider_refund_check CHECK (
    provider_refund_status IS NULL OR (provider_refund_status IN ('pending','processed','failed') AND provider_refund_id IS NOT NULL)) NOT VALID;

-- 3. The provider's notifications, once per account and event, with what each changed (written only by payment-webhook)
CREATE TABLE IF NOT EXISTS public.hangtag_payment_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    account_id UUID NOT NULL,
    provider TEXT NOT NULL DEFAULT 'razorpay',
    event_id TEXT NOT NULL,
    event TEXT NOT NULL,
    intent_id UUID,
    refund_id TEXT,
    outcome TEXT NOT NULL DEFAULT 'received',
    from_status TEXT,
    to_status TEXT,
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (account_id, event_id),
    FOREIGN KEY (owner_id, account_id) REFERENCES public.hangtag_payment_accounts (owner_id, id)
);
ALTER TABLE public.hangtag_payment_events DROP CONSTRAINT IF EXISTS hangtag_payment_events_check;
ALTER TABLE public.hangtag_payment_events ADD CONSTRAINT hangtag_payment_events_check CHECK (
    provider IN ('razorpay') AND char_length(event_id) BETWEEN 1 AND 100 AND char_length(event) BETWEEN 1 AND 60
    AND outcome IN ('received','changed','unchanged','ignored','refund') AND (refund_id IS NULL OR char_length(refund_id) <= 64));
CREATE INDEX IF NOT EXISTS idx_hangtag_payment_events_owner ON public.hangtag_payment_events (owner_id, received_at DESC);
ALTER TABLE public.hangtag_payment_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.hangtag_payment_events FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.hangtag_payment_events TO authenticated;
DROP POLICY IF EXISTS "Shop read" ON public.hangtag_payment_events;
CREATE POLICY "Shop read" ON public.hangtag_payment_events FOR SELECT TO authenticated
    USING (owner_id = (SELECT public.hangtag_shop_id()) AND (SELECT public.hangtag_can('view_reports')));
-- like every business table: an app account's write waits while the shop's plan has ended (section 3t; these two are
-- written only by the functions, which the guard lets through)
DROP TRIGGER IF EXISTS zz_hangtag_subscription_guard ON public.hangtag_payment_accounts;
CREATE TRIGGER zz_hangtag_subscription_guard BEFORE INSERT OR UPDATE OR DELETE ON public.hangtag_payment_accounts FOR EACH ROW EXECUTE FUNCTION public.hangtag_subscription_guard();
DROP TRIGGER IF EXISTS zz_hangtag_subscription_guard ON public.hangtag_payment_events;
CREATE TRIGGER zz_hangtag_subscription_guard BEFORE INSERT OR UPDATE OR DELETE ON public.hangtag_payment_events FOR EACH ROW EXECUTE FUNCTION public.hangtag_subscription_guard();

-- 4. UPI paid to the shop's own QR: unverified until the shop confirms it reached its account
ALTER TABLE public.hangtag_payments ADD COLUMN IF NOT EXISTS confirmed_by UUID;
ALTER TABLE public.hangtag_payments ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ;
-- section 3h's rule, with "confirmed": a UPI payment the shop confirmed, with when
ALTER TABLE public.hangtag_payments DROP CONSTRAINT IF EXISTS hangtag_payments_verification_check;
ALTER TABLE public.hangtag_payments ADD CONSTRAINT hangtag_payments_verification_check CHECK (
    verification IN ('verified','confirmed','recorded','unverified')
    AND (via IS NULL OR (method = 'upi' AND via IN ('manual','qr')) OR (method = 'card' AND via IN ('terminal','link')))
    AND (method <> 'cash' OR (via IS NULL AND verification = 'recorded'))
    AND (verification NOT IN ('unverified','confirmed') OR method = 'upi')
    AND (verification <> 'confirmed' OR confirmed_at IS NOT NULL)
    AND (verification <> 'verified' OR intent_id IS NOT NULL)
    AND (card_last4 IS NULL OR (method = 'card' AND card_last4 ~ '^[0-9]{4}$'))
    AND (provider_fee IS NULL OR (verification = 'verified' AND provider_fee >= 0))
    AND (provider_payment_id IS NULL OR char_length(provider_payment_id) <= 64)) NOT VALID;
-- What a phone sends never makes a payment more trusted than it is, and never undoes the shop's confirmation. Named to
-- fire before hangtag_member_write_check (triggers fire by name): a team member's phone sending the bill again then
-- sends exactly what is saved, which that check lets through.
CREATE OR REPLACE FUNCTION public.hangtag_keep_payment_state()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
    -- the shop's own confirmation, made by hangtag_confirm_upi_payment for exactly this payment (inside that function,
    -- which runs as its owner: an app account's own statement runs as authenticated and can't pass for it)
    IF NEW.verification = 'confirmed' AND current_user <> 'authenticated'
       AND current_setting('hangtag.payment_confirm', true) = NEW.owner_id::TEXT || '/' || NEW.id THEN
        RETURN NEW;
    END IF;
    -- the same payment, confirmed before: it stays confirmed, by whom and when — unless the provider's own record now
    -- verifies it (stronger than the shop's word; hangtag_payment_verified_check still demands a verified intent of this
    -- shop, method and amount)
    IF TG_OP = 'UPDATE' AND OLD.verification = 'confirmed' AND NEW.verification IS DISTINCT FROM 'verified'
       AND NEW.method = OLD.method AND NEW.amount = OLD.amount THEN
        NEW.verification := 'confirmed'; NEW.confirmed_by := OLD.confirmed_by; NEW.confirmed_at := OLD.confirmed_at;
        RETURN NEW;
    END IF;
    -- UPI the cashier checked by eye is unverified, however an app sends it (a payment saved before verification was kept
    -- stays "recorded" when its bill is sent again unchanged)
    IF NEW.method = 'upi' AND NEW.verification IN ('recorded','confirmed') AND auth.uid() IS NOT NULL
       AND NOT (TG_OP = 'UPDATE' AND OLD.verification = 'recorded' AND NEW.verification = 'recorded' AND NEW.amount = OLD.amount) THEN
        NEW.verification := 'unverified';
    END IF;
    IF NEW.verification IS DISTINCT FROM 'confirmed' THEN NEW.confirmed_by := NULL; NEW.confirmed_at := NULL; END IF;
    RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS hangtag_keep_payment_state ON public.hangtag_payments;
CREATE TRIGGER hangtag_keep_payment_state BEFORE INSERT OR UPDATE ON public.hangtag_payments FOR EACH ROW EXECUTE FUNCTION public.hangtag_keep_payment_state();
REVOKE ALL ON FUNCTION public.hangtag_keep_payment_state() FROM PUBLIC, anon, authenticated;
-- The shop confirms a UPI payment reached its own account (the owner, or a role that sees the books — the cashier who
-- took it doesn't confirm it). Once; a payment the provider verified, one already confirmed and one saved before
-- verification was kept answer as they are; a cancelled bill's payment can't be confirmed.
--   → { status: 'confirmed', confirmedAt (ms), confirmedBy } | { status: 'verified'|'confirmed'|'recorded', already: true }
--     | { status: 'not_found' } | { status: 'cancelled' }
CREATE OR REPLACE FUNCTION public.hangtag_confirm_upi_payment(p_payment_id TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    shop UUID := public.hangtag_shop_id();
    p public.hangtag_payments;
    at TIMESTAMPTZ := NOW();
BEGIN
    IF shop IS NULL OR auth.uid() IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = '42501'; END IF;
    IF NOT public.hangtag_can('view_reports') THEN
        RAISE EXCEPTION 'Only the owner, or a role that sees the books, can confirm a payment reached the shop.' USING ERRCODE = '42501';
    END IF;
    SELECT * INTO p FROM public.hangtag_payments x WHERE x.owner_id = shop AND x.id = p_payment_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('status', 'not_found'); END IF;
    IF p.method <> 'upi' THEN RAISE EXCEPTION 'Only a UPI payment is confirmed this way.' USING ERRCODE = '22023'; END IF;
    IF p.verification <> 'unverified' THEN
        RETURN jsonb_build_object('status', p.verification, 'already', TRUE,
            'confirmedAt', CASE WHEN p.confirmed_at IS NULL THEN NULL ELSE (extract(epoch FROM p.confirmed_at) * 1000)::BIGINT END, 'confirmedBy', p.confirmed_by);
    END IF;
    IF p.status = 'cancelled' THEN RETURN jsonb_build_object('status', 'cancelled'); END IF;
    PERFORM set_config('hangtag.payment_confirm', shop::TEXT || '/' || p.id, TRUE);
    UPDATE public.hangtag_payments x SET verification = 'confirmed', confirmed_by = auth.uid(), confirmed_at = at
     WHERE x.owner_id = shop AND x.id = p.id;
    PERFORM set_config('hangtag.payment_confirm', '', TRUE);
    RETURN jsonb_build_object('status', 'confirmed', 'confirmedAt', (extract(epoch FROM at) * 1000)::BIGINT, 'confirmedBy', auth.uid());
END $$;
REVOKE ALL ON FUNCTION public.hangtag_confirm_upi_payment(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.hangtag_confirm_upi_payment(TEXT) TO authenticated;

-- 5. The report: every row ok, or nothing is committed
DO $report$
DECLARE bad TEXT;
BEGIN
    SELECT string_agg(check_name, '; ') INTO bad FROM (
        SELECT 1 AS n, 'Shop payment accounts: closed to every app account (row security on, no policy, no privilege)' AS check_name,
               (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = 'public.hangtag_payment_accounts'::regclass)
               AND NOT EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'hangtag_payment_accounts')
               AND NOT has_table_privilege('authenticated', 'public.hangtag_payment_accounts', 'SELECT, INSERT, UPDATE, DELETE')
               AND NOT has_table_privilege('anon', 'public.hangtag_payment_accounts', 'SELECT, INSERT, UPDATE, DELETE') AS ok
        UNION ALL
        SELECT 2, 'Shop payment accounts hold only sealed secrets, one connected account per shop',
               EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conname = 'hangtag_payment_accounts_check' AND pg_get_constraintdef(c.oid) LIKE '%v1%')
               AND EXISTS (SELECT 1 FROM pg_indexes i WHERE i.schemaname = 'public' AND i.indexname = 'hangtag_payment_accounts_connected')
               AND NOT EXISTS (SELECT 1 FROM public.hangtag_payment_accounts a WHERE a.secret_box !~ '^v1\.' OR a.webhook_box !~ '^v1\.')
        UNION ALL
        SELECT 3, 'Every new payment intent names an account of its own shop',
               EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conname = 'hangtag_payment_intents_account_fk' AND c.contype = 'f' AND array_length(c.conkey, 1) = 2)
               AND EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = 'public.hangtag_payment_intents'::regclass AND t.tgname = 'hangtag_intent_account_check')
        UNION ALL
        SELECT 4, 'Provider notifications kept once per account and event; read by the shop only',
               EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid = 'public.hangtag_payment_events'::regclass AND c.contype = 'u')
               AND (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = 'public.hangtag_payment_events'::regclass)
               AND NOT has_table_privilege('authenticated', 'public.hangtag_payment_events', 'INSERT, UPDATE, DELETE')
               AND NOT has_table_privilege('anon', 'public.hangtag_payment_events', 'SELECT, INSERT, UPDATE, DELETE')
        UNION ALL
        SELECT 5, 'UPI confirmed only by the shop, never undone by a bill sent again',
               EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = 'public.hangtag_payments'::regclass AND t.tgname = 'hangtag_keep_payment_state')
               AND 'hangtag_keep_payment_state' < 'hangtag_member_write_check'
               AND EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conname = 'hangtag_payments_verification_check' AND pg_get_constraintdef(c.oid) LIKE '%confirmed%')
               AND EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = to_regprocedure('public.hangtag_confirm_upi_payment(text)') AND p.prosecdef)
               AND has_function_privilege('authenticated', 'public.hangtag_confirm_upi_payment(text)', 'EXECUTE')
               AND NOT has_function_privilege('anon', 'public.hangtag_confirm_upi_payment(text)', 'EXECUTE')
        UNION ALL
        SELECT 6, 'No shop table open to every account (a policy that is always true)',
               NOT EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname = 'public' AND p.permissive = 'PERMISSIVE'
                   AND (btrim(COALESCE(p.qual, '')) IN ('true', '(true)') OR btrim(COALESCE(p.with_check, '')) IN ('true', '(true)'))
                   AND EXISTS (SELECT 1 FROM information_schema.columns c WHERE c.table_schema = 'public' AND c.table_name = p.tablename AND c.column_name = 'owner_id'))
        UNION ALL
        SELECT 7, 'The new tables wait like every business table while a plan has ended',
               (SELECT count(*) FROM pg_trigger t WHERE t.tgname = 'zz_hangtag_subscription_guard'
                   AND t.tgrelid IN ('public.hangtag_payment_accounts'::regclass, 'public.hangtag_payment_events'::regclass)) = 2
    ) r WHERE NOT r.ok;
    IF bad IS NOT NULL THEN
        RAISE EXCEPTION 'Shop payments migration report not ok: %. Nothing was changed.', bad USING ERRCODE = 'P0001';
    END IF;
END $report$;
