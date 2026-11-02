// Writes the post-repair migration, its undo and its read-only report check from supabase/schema.sql and the stated edits
// in supabase/tests/post-repair-edits.mjs:
//   supabase/migrations/20261019120000_hangtag_post_repair_integrity.sql
//   supabase/operations/post-repair-integrity-undo.sql
//   supabase/checks/post-repair-report.sql
// Each function the migration takes from schema.sql is schema.sql's last definition with exactly its listed edits
// (supabase/tests/post-repair-integrity.test.mjs checks it); everything else here is new. Run: node scripts/gen-post-repair.mjs
import fs from 'node:fs';
import { FUNCTION_EDITS, applyEdits, fnText, lf } from '../supabase/tests/post-repair-edits.mjs';

const root = new URL('../', import.meta.url);
const SCHEMA = lf(fs.readFileSync(new URL('supabase/schema.sql', root), 'utf8'));
const EDITED = {}, ORIGINAL = {};
for (const f of FUNCTION_EDITS) { ORIGINAL[f.name] = fnText(SCHEMA, f.name); EDITED[f.name] = applyEdits(ORIGINAL[f.name], f.edits, f.name); }

/* Every function this migration adds, with its arguments: none for an app account unless listed in APP_CALLABLE */
const NEW_FUNCTIONS = [
  'hangtag_billing_mode()', 'hangtag_billing_event_seen(TEXT, TEXT, TEXT)',
  'hangtag_billing_event_record(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, BOOLEAN)',
  'hangtag_billing_exception_open(TEXT, TEXT, TEXT, UUID, UUID, NUMERIC, JSONB, TEXT)',
  'hangtag_subscription_activate_checked(UUID, TEXT, NUMERIC, TEXT)',
  'hangtag_autopay_attach_mandate(UUID, TEXT, TEXT, TEXT, TEXT)',
  'hangtag_autopay_report(TEXT, TEXT, TEXT, TEXT, NUMERIC, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TEXT)',
  'hangtag_autopay_orphan(TEXT, TEXT, TEXT)', 'hangtag_autopay_check_claim(UUID)',
  'hangtag_billing_reconcile_begin(INT, TEXT)', 'hangtag_billing_reconcile_done(BIGINT, JSONB)',
  'hangtag_billing_known_payments(TEXT, TEXT[])', 'hangtag_autopay_known(TEXT, TEXT[])',
  'hangtag_billing_probe_record(TEXT, TEXT, TEXT, TEXT)', 'hangtag_billing_integrity()', 'hangtag_billing_readiness()',
  'hangtag_billing_selfcheck_allowed()', 'hangtag_platform_billing_exceptions(TEXT, INT)',
  'hangtag_platform_billing_exception_resolve(BIGINT, TEXT)', 'hangtag_platform_billing_health()',
  'hangtag_billing_call_claim(UUID, TEXT)',
];
const APP_CALLABLE = ['hangtag_billing_selfcheck_allowed()', 'hangtag_platform_billing_exceptions(TEXT, INT)',
  'hangtag_platform_billing_exception_resolve(BIGINT, TEXT)', 'hangtag_platform_billing_health()'];
const SERVICE_ONLY = NEW_FUNCTIONS.filter((f) => !APP_CALLABLE.includes(f));
const NEW_TABLES = ['hangtag_deleted_products', 'hangtag_billing_settings', 'hangtag_billing_events', 'hangtag_billing_exceptions',
  'hangtag_autopay_mandates', 'hangtag_billing_reconcile_runs', 'hangtag_billing_probes', 'hangtag_billing_payment_checks', 'hangtag_billing_call_counts'];
const BILLING_TABLES = NEW_TABLES.filter((t) => t !== 'hangtag_deleted_products');
const regp = (sig) => `to_regprocedure('public.${sig.toLowerCase()}')`;
const noApp = (sig) => `(${regp(sig)} IS NOT NULL AND NOT has_function_privilege('anon', ${regp(sig)}, 'EXECUTE') AND NOT has_function_privilege('authenticated', ${regp(sig)}, 'EXECUTE'))`;
const closed = (t) => `(to_regclass('public.${t}') IS NOT NULL AND (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = to_regclass('public.${t}'))
           AND NOT has_table_privilege('anon', 'public.${t}', 'SELECT,INSERT,UPDATE,DELETE') AND NOT has_table_privilege('authenticated', 'public.${t}', 'SELECT,INSERT,UPDATE,DELETE'))`;
const src = (sig) => `COALESCE((SELECT p.prosrc FROM pg_proc p WHERE p.oid = ${regp(sig)}), '')`;

const REPORT_ROWS = `    SELECT 1 AS n, 'Returns take the bill line''s lock before the sum' AS check_name,
           ${src('hangtag_check_return_qty()')} LIKE '%pg_advisory_xact_lock(hashtextextended(''hangtag_return_line:''%' AS ok
    UNION ALL SELECT 2, 'Stock records of tracked products need their serial numbers or batch',
           EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = 'public.hangtag_stock_moves'::regclass AND t.tgname = 'hangtag_tracking_required' AND NOT t.tgisinternal)
    UNION ALL SELECT 3, 'Bills keep the unit sold',
           ${src('hangtag_save_sales(JSONB)')} LIKE '%kit, unit)%'
    UNION ALL SELECT 4, 'A deleted product leaves its mark, read only by its shop (and waits, like every shop table, when its plan has ended)',
           EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = 'public.hangtag_products'::regclass AND t.tgname = 'hangtag_product_deleted')
           AND EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = 'public.hangtag_deleted_products'::regclass AND t.tgname = 'zz_hangtag_subscription_guard')
           AND (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = 'public.hangtag_deleted_products'::regclass)
           AND NOT has_table_privilege('anon', 'public.hangtag_deleted_products', 'SELECT')
           AND NOT has_table_privilege('authenticated', 'public.hangtag_deleted_products', 'INSERT')
    UNION ALL SELECT 5, 'Capabilities answer an app account about its own shop only',
           ${src('hangtag_cap_on(UUID, TEXT)')} LIKE '%p_owner IS DISTINCT FROM public.hangtag_shop_id() THEN RETURN FALSE%'
    UNION ALL SELECT 6, 'Billing notifications and exceptions: kept once each, in the database''s own billing mode, closed to app accounts',
           ${['hangtag_billing_settings', 'hangtag_billing_events', 'hangtag_billing_exceptions'].map(closed).join('\n           AND ')}
           AND (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'hangtag_billing_event_record') = 1
           AND (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'hangtag_billing_exception_open') = 1
           AND ${src('hangtag_billing_event_record(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, BOOLEAN)')} LIKE '%p_mode IS DISTINCT FROM bm%'
           AND NOT EXISTS (SELECT 1 FROM information_schema.columns c WHERE c.table_schema = 'public' AND c.table_name = 'hangtag_billing_exceptions' AND c.column_name = 'owner_id')
           AND pg_get_constraintdef((SELECT k.oid FROM pg_constraint k WHERE k.conname = 'hangtag_billing_exceptions_kind_check')) LIKE '%mode_mismatch%'
           AND (SELECT s.billing_mode FROM public.hangtag_billing_settings s WHERE s.id) IN ('live', 'test')
    UNION ALL SELECT 7, 'Plan payments: none from a suspended shop; a halted AutoPay off first; a page only on an open payment; activation in the billing mode, never for refunded money; the provider asked a limited number of times per account',
           ${src('hangtag_subscription_checkout(TEXT, TEXT, TEXT)')} LIKE '%s.owner_id = me AND s.suspended)%'
           AND ${src('hangtag_subscription_checkout(TEXT, TEXT, TEXT)')} LIKE '%''cancel_mandate'', halted%'
           AND ${src('hangtag_subscription_attach(UUID, TEXT, TEXT)')} LIKE '%can''''t take a payment page any more%'
           AND ${noApp('hangtag_subscription_activate_checked(UUID, TEXT, NUMERIC, TEXT)')}
           AND ${closed('hangtag_billing_call_counts')} AND ${noApp('hangtag_billing_call_claim(UUID, TEXT)')}
    UNION ALL SELECT 8, 'Offers: a place is held only by a real checkout, one per shop',
           ${src('hangtag_promo_evaluate(UUID, TEXT, TEXT)')} LIKE '%count(DISTINCT y.owner_id)%provider_order_id IS NOT NULL%'
    UNION ALL SELECT 9, 'AutoPay set-ups registered; a charge recorded once, at the price agreed; a replaced set-up or an older report never moves a shop''s AutoPay',
           ${closed('hangtag_autopay_mandates')}
           AND NOT EXISTS (SELECT 1 FROM information_schema.columns c WHERE c.table_schema = 'public' AND c.table_name = 'hangtag_autopay_mandates' AND c.column_name = 'owner_id')
           AND ${src('hangtag_autopay_begin(BOOLEAN, TEXT)')} LIKE '%hangtag_autopay_mandates%'
           AND ${['hangtag_autopay_attach_mandate(UUID, TEXT, TEXT, TEXT, TEXT)', 'hangtag_autopay_report(TEXT, TEXT, TEXT, TEXT, NUMERIC, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TEXT)',
                 'hangtag_autopay_orphan(TEXT, TEXT, TEXT)', 'hangtag_autopay_check_claim(UUID)'].map(noApp).join('\n           AND ')}
           AND (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'hangtag_autopay_event') = 1
    UNION ALL SELECT 10, 'Reconciliation: one run at a time, its log, targets and checks, service role only',
           ${['hangtag_billing_reconcile_runs', 'hangtag_billing_probes', 'hangtag_billing_payment_checks'].map(closed).join('\n           AND ')}
           AND ${['hangtag_billing_reconcile_begin(INT, TEXT)', 'hangtag_billing_reconcile_done(BIGINT, JSONB)', 'hangtag_billing_known_payments(TEXT, TEXT[])',
                 'hangtag_autopay_known(TEXT, TEXT[])', 'hangtag_billing_probe_record(TEXT, TEXT, TEXT, TEXT)', 'hangtag_billing_integrity()'].map(noApp).join('\n           AND ')}
    UNION ALL SELECT 11, 'AutoPay offered, switched on and required of new trials only once its notifications are proven',
           ${noApp('hangtag_billing_readiness()')}
           AND ${src('hangtag_autopay_terms(UUID)')} LIKE '%hangtag_billing_readiness%'
           AND ${src('hangtag_platform_settings_save(JSONB)')} LIKE '%hangtag_billing_readiness%'
           AND ${src('hangtag_subscription_ensure(UUID)')} LIKE '%hangtag_billing_readiness%'
    UNION ALL SELECT 12, 'Billing review in the console: listed and settled by role, audited; the self-check by those who manage settings',
           ${APP_CALLABLE.map((f) => `(${regp(f)} IS NOT NULL AND has_function_privilege('authenticated', ${regp(f)}, 'EXECUTE') AND NOT has_function_privilege('anon', ${regp(f)}, 'EXECUTE')
               AND ${src(f)} LIKE '%hangtag_platform_require(%')`).join('\n           AND ')}
    UNION ALL SELECT 13, 'Every function added runs with its owner''s rights and an empty search path',
           (SELECT bool_and(p.prosecdef AND p.proconfig @> ARRAY['search_path=""']) FROM pg_proc p WHERE p.oid IN (${NEW_FUNCTIONS.map(regp).join(', ')}))
           AND (SELECT count(*) FROM pg_proc p WHERE p.oid IN (${NEW_FUNCTIONS.map(regp).join(', ')})) = ${NEW_FUNCTIONS.length}`;
const REPORT = `SELECT check_name, ok FROM (
${REPORT_ROWS}
) r ORDER BY n;`;

const MIG = `-- Requires: supabase/schema.sql — and the repair: run only after RELEASE.md §3 has run and its checks are all ok
-- (supabase/REPAIR-RUNBOOK.md, step 6). Never before it: on the live project's older functions it would mix versions.
-- Generated by scripts/gen-post-repair.mjs from schema.sql and the stated edits in supabase/tests/post-repair-edits.mjs.
-- ==============================================================================
-- Post-repair integrity (2026-10-18/19). Fixes that need the database, kept out of schema.sql on purpose: schema.sql is
-- the repair's script, and its rehearsal, hash and undo are what the repair's approval rests on. Until this is folded into
-- schema.sql, run it again after any run of schema.sql (a schema.sql run puts the older bodies of the functions below
-- back). When folded: section 3t's guard loop and report row 76 already leave out these tables' shop column (it is not
-- called owner_id), except hangtag_deleted_products, which carries the guard (section 4).
--   1. Returns: one return of a bill line at a time (two at the same moment could each miss the other: AUDIT 114).
--   2. Stock records of tracked products: serial numbers for a serial-tracked product, the batch for a batch-tracked one,
--      on every path (the supplier-bill import already checked; a purchase or the upload queue didn't: AUDIT 56).
--   3. Bill lines keep the unit they were sold in (hangtag_save_sales dropped it, so the product's unit at upload time
--      was used: AUDIT 61).
--   4. Deleted products leave a mark, so an edit queued on another device can't bring one back (AUDIT 57; the app reads
--      the mark and sends the edit to the review list).
--   5. hangtag_cap_on answers an app account about its own shop only (it answered for any shop whose id was known).
--   6. Plan billing: the database's billing mode ('live' or 'test', changed only in the SQL Editor); every signed provider
--      notification noted once; money that can't be matched kept for review.
--   7. Plan payments: none from a suspended shop (REMEDIATION step 11); an AutoPay the provider halted is turned off
--      before a payment by hand (step 5); a payment page attaches only to a payment still open for it; activation only in
--      the billing mode, never for money refunded or disputed; the provider asked a limited number of times per account
--      (step 11).
--   8. Offers: a place in a capped offer is held only by a real checkout, one per shop (REMEDIATION step 9).
--   9. AutoPay: a registry of every set-up, the price and currency agreed to; a charge on any of them recorded once; a
--      report older than the newest one applied changes nothing (REMEDIATION steps 5 and 8).
--  10. Reconciliation: what the provider holds read back on a schedule — missed notifications repaired through the same
--      functions, untracked money kept for review (REMEDIATION step 7).
--  11. Readiness: AutoPay offered, switched on and required of new trials only once its notifications are proven
--      (REMEDIATION step 4).
--  12. The console: billing review listed and settled by role, audited; billing health.
-- Run once, whole, in one transaction (the runbook wraps it); running it again changes nothing. It ends with its report
-- and refuses to commit unless every row is ok: an error then, and nothing changed. The SQL Editor shows only
-- the last statement's result (after the runbook's COMMIT, none), so read supabase/checks/post-repair-report.sql
-- afterwards (read-only, any time). Undo: supabase/operations/post-repair-integrity-undo.sql.
-- ==============================================================================

-- 0. Only after the repair: three functions the repair brings up to date (and this migration leaves alone) must be
--    schema.sql's, byte for byte; otherwise stop here, before anything changes (no repair yet, or an older section file
--    run after it — the 2026-10-13 incident)
DO $guard$
DECLARE stale TEXT[];
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
END $guard$;

-- 1. Returns: the bill line's lock before the sum (a lock of the transaction, no table privilege needed)
${EDITED.hangtag_check_return_qty}

-- 2. Stock records of tracked products carry what tracks them (fires before hangtag_tracking_shape, which checks the
--    serial numbers' count and form; an empty list counts as none)
CREATE OR REPLACE FUNCTION public.hangtag_tracking_required()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE tr TEXT; pid TEXT := NEW.product_id;
BEGIN
    IF pid IS NULL THEN SELECT v.product_id INTO pid FROM public.hangtag_variants v WHERE v.owner_id = NEW.owner_id AND v.id = NEW.variant_id; END IF;
    SELECT p.tracking INTO tr FROM public.hangtag_products p WHERE p.owner_id = NEW.owner_id AND p.id = pid;
    IF tr = 'serial' AND (NEW.serials IS NULL OR cardinality(NEW.serials) = 0) THEN
        RAISE EXCEPTION 'This product is tracked by serial number: its stock record needs the serial number of each piece.' USING ERRCODE = 'check_violation';
    END IF;
    IF tr = 'batch' AND NULLIF(btrim(COALESCE(NEW.batch_no, '')), '') IS NULL THEN
        RAISE EXCEPTION 'This product is tracked by batch: its stock record needs the batch.' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS hangtag_tracking_required ON public.hangtag_stock_moves;
CREATE TRIGGER hangtag_tracking_required BEFORE INSERT ON public.hangtag_stock_moves FOR EACH ROW EXECUTE FUNCTION public.hangtag_tracking_required();
REVOKE ALL ON FUNCTION public.hangtag_tracking_required() FROM PUBLIC, anon, authenticated;

-- 3. Bill lines: the unit sold (a line without one still gets its product's, from hangtag_line_unit)
${EDITED.hangtag_save_sales}
REVOKE ALL ON FUNCTION public.hangtag_save_sales(JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.hangtag_save_sales(JSONB) TO authenticated;

-- 4. A deleted product's mark: the shop reads its own; only the delete writes one. A shop table like the others: it waits
--    while the shop's plan has ended (section 3t's guard, which schema.sql puts on every shop table)
CREATE TABLE IF NOT EXISTS public.hangtag_deleted_products (
    owner_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    product_id TEXT NOT NULL CHECK (char_length(product_id) BETWEEN 1 AND 200),
    deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (owner_id, product_id)
);
ALTER TABLE public.hangtag_deleted_products ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "A shop reads its own deleted products" ON public.hangtag_deleted_products;
CREATE POLICY "A shop reads its own deleted products" ON public.hangtag_deleted_products FOR SELECT TO authenticated
    USING (owner_id = public.hangtag_shop_id());
REVOKE ALL ON TABLE public.hangtag_deleted_products FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.hangtag_deleted_products TO authenticated;
DROP TRIGGER IF EXISTS zz_hangtag_subscription_guard ON public.hangtag_deleted_products;
CREATE TRIGGER zz_hangtag_subscription_guard BEFORE INSERT OR UPDATE OR DELETE ON public.hangtag_deleted_products FOR EACH ROW EXECUTE FUNCTION public.hangtag_subscription_guard();
CREATE OR REPLACE FUNCTION public.hangtag_product_deleted()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
    INSERT INTO public.hangtag_deleted_products (owner_id, product_id, deleted_at) VALUES (OLD.owner_id, OLD.id, NOW())
    ON CONFLICT (owner_id, product_id) DO UPDATE SET deleted_at = EXCLUDED.deleted_at;
    RETURN OLD;
END $$;
DROP TRIGGER IF EXISTS hangtag_product_deleted ON public.hangtag_products;
CREATE TRIGGER hangtag_product_deleted AFTER DELETE ON public.hangtag_products FOR EACH ROW EXECUTE FUNCTION public.hangtag_product_deleted();
REVOKE ALL ON FUNCTION public.hangtag_product_deleted() FROM PUBLIC, anon, authenticated;

-- 5. Capabilities: an app account's own shop only
${EDITED.hangtag_cap_on}
REVOKE ALL ON FUNCTION public.hangtag_cap_on(UUID,TEXT) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.hangtag_cap_on(UUID,TEXT) TO authenticated;

-- 6. Plan billing: the database's billing mode; provider notifications, once each; money that can't be matched, for
--    review. Service role only (the subscription functions). The billing mode says whose money this database counts:
--    'live' (real money: the live project) or 'test' (a provider's sandbox: a test project only). No function writes it;
--    on a test project, in the SQL Editor: UPDATE public.hangtag_billing_settings SET billing_mode = 'test';
CREATE TABLE IF NOT EXISTS public.hangtag_billing_settings (
    id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
    billing_mode TEXT NOT NULL DEFAULT 'live' CHECK (billing_mode IN ('live', 'test')),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO public.hangtag_billing_settings (id) VALUES (TRUE) ON CONFLICT (id) DO NOTHING;
CREATE TABLE IF NOT EXISTS public.hangtag_billing_events (
    provider TEXT NOT NULL CHECK (provider ~ '^[a-z]{2,20}$'),
    event_id TEXT NOT NULL CHECK (char_length(event_id) BETWEEN 1 AND 200),
    event_type TEXT CHECK (event_type IS NULL OR char_length(event_type) <= 80),
    ref TEXT CHECK (ref IS NULL OR char_length(ref) <= 120),
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (provider, event_id)
);
ALTER TABLE public.hangtag_billing_events ADD COLUMN IF NOT EXISTS mode TEXT CHECK (mode IS NULL OR mode IN ('live', 'test'));
ALTER TABLE public.hangtag_billing_events ADD COLUMN IF NOT EXISTS entity_id TEXT CHECK (entity_id IS NULL OR char_length(entity_id) <= 120);
ALTER TABLE public.hangtag_billing_events ADD COLUMN IF NOT EXISTS provider_created_at TIMESTAMPTZ;   -- from the signed body
ALTER TABLE public.hangtag_billing_events ADD COLUMN IF NOT EXISTS outcome TEXT CHECK (outcome IS NULL OR char_length(outcome) <= 40);
ALTER TABLE public.hangtag_billing_events ADD COLUMN IF NOT EXISTS probe BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS idx_hangtag_billing_events_kind ON public.hangtag_billing_events (provider, mode, event_type, provider_created_at DESC);
CREATE TABLE IF NOT EXISTS public.hangtag_billing_exceptions (
    id BIGSERIAL PRIMARY KEY,
    kind TEXT NOT NULL,
    provider TEXT NOT NULL CHECK (provider ~ '^[a-z]{2,20}$'),
    ref TEXT NOT NULL CHECK (char_length(ref) BETWEEN 1 AND 120),
    shop_owner_id UUID,   -- the shop the money is about, when known (not "owner_id": these aren't the shop's own records)
    payment_id UUID,
    amount NUMERIC(12,2),
    detail JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail) = 'object' AND pg_column_size(detail) <= 4000),
    opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
    resolved_at TIMESTAMPTZ,
    resolved_by UUID,
    resolution TEXT CHECK (resolution IS NULL OR char_length(resolution) <= 300),
    UNIQUE (provider, kind, ref)
);
-- an earlier draft of this section named the shop column owner_id (it would have taken section 3t's guard): renamed
DO $rename$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns c WHERE c.table_schema = 'public' AND c.table_name = 'hangtag_billing_exceptions' AND c.column_name = 'owner_id') THEN
        ALTER TABLE public.hangtag_billing_exceptions RENAME COLUMN owner_id TO shop_owner_id;
    END IF;
END $rename$;
ALTER TABLE public.hangtag_billing_exceptions ADD COLUMN IF NOT EXISTS provider_payment_id TEXT CHECK (provider_payment_id IS NULL OR char_length(provider_payment_id) <= 120);
ALTER TABLE public.hangtag_billing_exceptions DROP CONSTRAINT IF EXISTS hangtag_billing_exceptions_kind_check;
ALTER TABLE public.hangtag_billing_exceptions ADD CONSTRAINT hangtag_billing_exceptions_kind_check CHECK (kind IN ('amount_mismatch', 'currency_mismatch',
    'wrong_shop', 'unknown_order', 'refund', 'dispute', 'activation_refused', 'unknown_mandate_charge', 'unmatched_payment', 'stale_mandate',
    'charge_overdue', 'cancel_failed', 'mode_mismatch', 'reconcile_error'));
CREATE INDEX IF NOT EXISTS idx_hangtag_billing_exceptions_open ON public.hangtag_billing_exceptions (status, opened_at DESC);
CREATE INDEX IF NOT EXISTS idx_hangtag_billing_exceptions_payment ON public.hangtag_billing_exceptions (provider, provider_payment_id) WHERE provider_payment_id IS NOT NULL;
ALTER TABLE public.hangtag_billing_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hangtag_billing_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hangtag_billing_exceptions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.hangtag_billing_settings, public.hangtag_billing_events, public.hangtag_billing_exceptions FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.hangtag_billing_exceptions_id_seq FROM PUBLIC, anon, authenticated;
-- the database's billing mode
CREATE OR REPLACE FUNCTION public.hangtag_billing_mode()
RETURNS TEXT LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
    SELECT COALESCE((SELECT s.billing_mode FROM public.hangtag_billing_settings s WHERE s.id), 'live')
$$;
-- before a signed notification is acted on: { duplicate (noted before), mode_ok (the function's mode is this database's), billing_mode }
CREATE OR REPLACE FUNCTION public.hangtag_billing_event_seen(p_provider TEXT, p_event_id TEXT, p_mode TEXT)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE bm TEXT := public.hangtag_billing_mode();
BEGIN
    RETURN jsonb_build_object('duplicate', EXISTS (SELECT 1 FROM public.hangtag_billing_events e WHERE e.provider = p_provider AND e.event_id = p_event_id),
        'mode_ok', COALESCE(p_mode = bm, FALSE), 'billing_mode', bm);
END $$;
-- a signed notification, noted once it is settled (a half-handled one is handled in full when it comes again): { duplicate }.
-- Refused in another billing mode. Its time is the provider's own (the signed body's), never later than now.
DROP FUNCTION IF EXISTS public.hangtag_billing_event_record(TEXT, TEXT, TEXT, TEXT);
CREATE OR REPLACE FUNCTION public.hangtag_billing_event_record(p_provider TEXT, p_event_id TEXT, p_type TEXT, p_ref TEXT, p_mode TEXT,
    p_entity TEXT DEFAULT NULL, p_created_at TIMESTAMPTZ DEFAULT NULL, p_outcome TEXT DEFAULT NULL, p_probe BOOLEAN DEFAULT FALSE)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE n INT; bm TEXT := public.hangtag_billing_mode();
BEGIN
    IF COALESCE(p_provider, '') !~ '^[a-z]{2,20}$' OR char_length(COALESCE(p_event_id, '')) NOT BETWEEN 1 AND 200 THEN
        RAISE EXCEPTION 'A notification needs its provider and id.' USING ERRCODE = 'P0001';
    END IF;
    IF p_mode IS DISTINCT FROM bm THEN
        RAISE EXCEPTION 'A notification in % mode on a % database: not recorded.', COALESCE(p_mode, 'no'), bm USING ERRCODE = 'P0001';
    END IF;
    INSERT INTO public.hangtag_billing_events (provider, event_id, event_type, ref, mode, entity_id, provider_created_at, outcome, probe)
    VALUES (p_provider, p_event_id, left(p_type, 80), left(p_ref, 120), p_mode, left(p_entity, 120), LEAST(p_created_at, NOW()), left(p_outcome, 40), COALESCE(p_probe, FALSE))
    ON CONFLICT (provider, event_id) DO NOTHING;
    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN jsonb_build_object('duplicate', n = 0);
END $$;
-- money that can't be matched, once per provider, kind and reference: { opened } (false: already open)
DROP FUNCTION IF EXISTS public.hangtag_billing_exception_open(TEXT, TEXT, TEXT, UUID, UUID, NUMERIC, JSONB);
CREATE OR REPLACE FUNCTION public.hangtag_billing_exception_open(p_provider TEXT, p_kind TEXT, p_ref TEXT, p_owner UUID, p_payment UUID,
    p_amount NUMERIC, p_detail JSONB, p_provider_payment TEXT DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE n INT;
BEGIN
    INSERT INTO public.hangtag_billing_exceptions (provider, kind, ref, shop_owner_id, payment_id, amount, detail, provider_payment_id)
    VALUES (p_provider, p_kind, left(p_ref, 120), p_owner, p_payment, p_amount, CASE WHEN jsonb_typeof(p_detail) = 'object' THEN p_detail ELSE '{}'::jsonb END,
            NULLIF(left(btrim(COALESCE(p_provider_payment, '')), 120), ''))
    ON CONFLICT (provider, kind, ref) DO NOTHING;
    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN jsonb_build_object('opened', n = 1);
END $$;

-- 7. Plan payments: a suspended shop can't start one; an AutoPay the provider halted is turned off first; a page attaches
--    only to a payment still open for it
${EDITED.hangtag_subscription_checkout}
REVOKE ALL ON FUNCTION public.hangtag_subscription_checkout(TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hangtag_subscription_checkout(TEXT, TEXT, TEXT) TO authenticated;
${EDITED.hangtag_subscription_attach}
-- activation as the provider's notification, the app's own check and the reconciler ask for it: only in this database's
-- billing mode, and never for a provider payment already refunded or disputed (its exception is open)
CREATE OR REPLACE FUNCTION public.hangtag_subscription_activate_checked(p_payment UUID, p_provider_payment TEXT, p_amount NUMERIC, p_mode TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE bm TEXT := public.hangtag_billing_mode();
BEGIN
    IF p_mode IS DISTINCT FROM bm THEN
        RAISE EXCEPTION 'A payment in % mode on a % database: not activated.', COALESCE(p_mode, 'no'), bm USING ERRCODE = 'P0001';
    END IF;
    IF EXISTS (SELECT 1 FROM public.hangtag_billing_exceptions e JOIN public.hangtag_subscription_payments y ON y.id = p_payment AND y.provider = e.provider
                WHERE e.kind IN ('refund', 'dispute') AND e.status = 'open' AND e.provider_payment_id = btrim(COALESCE(p_provider_payment, ''))) THEN
        RETURN jsonb_build_object('ok', FALSE, 'refused', TRUE, 'reason', 'refunded', 'message', 'This payment was refunded or disputed: it adds no time.');
    END IF;
    RETURN public.hangtag_subscription_activate(p_payment, p_provider_payment, p_amount);
END $$;
-- the payment provider asked a limited number of times per account (REMEDIATION step 11): the app's own check of a
-- payment, and starting AutoPay, each count by the minute and by the hour; over the limit the function asks the provider
-- nothing (a payment check answers what the database knows: the notification and the reconciler still settle it). Taking
-- a payment page is limited already (20 an hour, by checkout); turning AutoPay off isn't (the database refuses it once
-- it is off). The account column isn't called owner_id: the table isn't one of the shop's own (section 3t's guard)
CREATE TABLE IF NOT EXISTS public.hangtag_billing_call_counts (
    shop_owner_id UUID NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('verify', 'autopay_start')),
    bucket TIMESTAMPTZ NOT NULL,
    hits INT NOT NULL DEFAULT 0 CHECK (hits >= 0),
    PRIMARY KEY (shop_owner_id, kind, bucket)
);
ALTER TABLE public.hangtag_billing_call_counts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.hangtag_billing_call_counts FROM PUBLIC, anon, authenticated;
CREATE OR REPLACE FUNCTION public.hangtag_billing_call_claim(p_owner UUID, p_kind TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    knd TEXT := lower(btrim(COALESCE(p_kind, '')));
    per_minute INT;
    per_hour INT;
    this_minute TIMESTAMPTZ := date_trunc('minute', NOW());
    in_minute INT;
    in_hour INT;
    oldest TIMESTAMPTZ;
BEGIN
    SELECT l.a_minute, l.an_hour INTO per_minute, per_hour
      FROM (VALUES ('verify', 60, 900), ('autopay_start', 6, 30)) l(kind_name, a_minute, an_hour) WHERE l.kind_name = knd;
    IF p_owner IS NULL OR per_minute IS NULL THEN
        RAISE EXCEPTION 'A provider call needs its account and a known kind.' USING ERRCODE = 'P0001';
    END IF;
    -- one account's calls of one kind are counted one at a time (two at once can't both take the last place)
    PERFORM pg_advisory_xact_lock(hashtextextended('hangtag_billing_call:' || p_owner::text || ':' || knd, 0));
    DELETE FROM public.hangtag_billing_call_counts c WHERE c.shop_owner_id = p_owner AND c.kind = knd AND c.bucket <= this_minute - interval '1 hour';
    SELECT COALESCE(sum(c.hits) FILTER (WHERE c.bucket = this_minute), 0), COALESCE(sum(c.hits), 0), min(c.bucket)
      INTO in_minute, in_hour, oldest
      FROM public.hangtag_billing_call_counts c WHERE c.shop_owner_id = p_owner AND c.kind = knd;
    IF in_hour >= per_hour THEN
        RETURN jsonb_build_object('ok', FALSE, 'retry_after', GREATEST(1, ceil(extract(epoch FROM (oldest + interval '1 hour' - NOW())))::INT));
    END IF;
    IF in_minute >= per_minute THEN
        RETURN jsonb_build_object('ok', FALSE, 'retry_after', GREATEST(1, ceil(extract(epoch FROM (this_minute + interval '1 minute' - NOW())))::INT));
    END IF;
    INSERT INTO public.hangtag_billing_call_counts AS c (shop_owner_id, kind, bucket, hits) VALUES (p_owner, knd, this_minute, 1)
        ON CONFLICT (shop_owner_id, kind, bucket) DO UPDATE SET hits = c.hits + 1;
    RETURN jsonb_build_object('ok', TRUE);
END $$;

-- 8. Offers: a place is held only by a real checkout, one per shop
${EDITED.hangtag_promo_evaluate}

-- 9. AutoPay: the registry of every set-up Hangtag made (the shop's current one, and the ones it replaced, kept until the
--    provider confirms them off). The shop column isn't called owner_id: the registry isn't one of the shop's own tables
--    (section 3t's guard would refuse the owner's AutoPay set-up while the shop waits for it).
CREATE TABLE IF NOT EXISTS public.hangtag_autopay_mandates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    shop_owner_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,   -- NULL: a set-up carrying Hangtag's note no shop recorded (kept to be cancelled)
    provider TEXT NOT NULL DEFAULT 'razorpay' CHECK (provider ~ '^[a-z]{2,20}$'),
    subscription_id TEXT CHECK (subscription_id IS NULL OR char_length(subscription_id) BETWEEN 1 AND 120),
    plan_code TEXT,
    price NUMERIC(12,2),
    currency TEXT CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
    mode TEXT CHECK (mode IS NULL OR mode IN ('live', 'test')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    attached_at TIMESTAMPTZ,
    is_current BOOLEAN NOT NULL DEFAULT FALSE,
    provider_status TEXT CHECK (provider_status IS NULL OR char_length(provider_status) <= 30),
    cancel_requested_at TIMESTAMPTZ,
    cancel_confirmed_at TIMESTAMPTZ,
    last_state_event_at TIMESTAMPTZ,   -- the provider's time of the newest state report applied
    last_checked_at TIMESTAMPTZ,       -- read back from the provider (the reconciler, the owner's check)
    final_checked_at TIMESTAMPTZ,      -- read back once more after it ended
    UNIQUE (provider, subscription_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS hangtag_autopay_mandates_one_current ON public.hangtag_autopay_mandates (shop_owner_id) WHERE is_current;
ALTER TABLE public.hangtag_autopay_mandates ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.hangtag_autopay_mandates FROM PUBLIC, anon, authenticated;
-- the set-ups made before the registry, each shop's as its current one (run again, it converges on the shop's record)
UPDATE public.hangtag_autopay_mandates m SET is_current = FALSE
 WHERE m.is_current AND EXISTS (SELECT 1 FROM public.hangtag_subscriptions s WHERE s.owner_id = m.shop_owner_id AND s.autopay_subscription_id IS NOT NULL
        AND (s.autopay_provider IS DISTINCT FROM m.provider OR s.autopay_subscription_id IS DISTINCT FROM m.subscription_id));
INSERT INTO public.hangtag_autopay_mandates (shop_owner_id, provider, subscription_id, plan_code, price, currency, mode, created_at, attached_at, is_current, provider_status)
SELECT s.owner_id, COALESCE(s.autopay_provider, 'razorpay'), s.autopay_subscription_id, s.autopay_plan_code, p.price, COALESCE(p.currency, 'INR'),
       public.hangtag_billing_mode(), COALESCE(s.autopay_consent_at, NOW()), COALESCE(s.autopay_consent_at, NOW()), TRUE, s.autopay_status
  FROM public.hangtag_subscriptions s LEFT JOIN public.hangtag_plans p ON p.code = s.autopay_plan_code
 WHERE s.autopay_subscription_id IS NOT NULL
ON CONFLICT (provider, subscription_id) DO UPDATE SET is_current = TRUE, shop_owner_id = EXCLUDED.shop_owner_id;
${EDITED.hangtag_autopay_begin}
-- the provider's subscription made for a set-up (the registry's id, sent to the provider as notes.hangtag_mandate):
-- { current } — false when the set-up was replaced or turned off meanwhile: then it is to be cancelled at once
CREATE OR REPLACE FUNCTION public.hangtag_autopay_attach_mandate(p_mandate UUID, p_provider TEXT, p_subscription TEXT, p_customer TEXT, p_mode TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE mo UUID; mm RECORD; prov TEXT := lower(btrim(COALESCE(p_provider, ''))); sid TEXT := btrim(COALESCE(p_subscription, '')); bm TEXT := public.hangtag_billing_mode();
BEGIN
    IF p_mode IS DISTINCT FROM bm THEN
        RAISE EXCEPTION 'An AutoPay set-up in % mode on a % database: not recorded.', COALESCE(p_mode, 'no'), bm USING ERRCODE = 'P0001';
    END IF;
    IF sid = '' OR prov !~ '^[a-z]{2,20}$' THEN RAISE EXCEPTION 'The provider''s subscription is missing.' USING ERRCODE = 'P0001'; END IF;
    SELECT x.shop_owner_id INTO mo FROM public.hangtag_autopay_mandates x WHERE x.id = p_mandate;
    IF NOT FOUND OR mo IS NULL THEN RAISE EXCEPTION 'AutoPay isn''t waiting to be set up.' USING ERRCODE = 'P0001'; END IF;
    PERFORM 1 FROM public.hangtag_subscriptions s WHERE s.owner_id = mo FOR UPDATE;   -- the shop first, then its set-up: one lock order
    SELECT * INTO mm FROM public.hangtag_autopay_mandates x WHERE x.id = p_mandate FOR UPDATE;
    IF mm.subscription_id IS NOT NULL THEN RAISE EXCEPTION 'AutoPay isn''t waiting to be set up.' USING ERRCODE = 'P0001'; END IF;
    UPDATE public.hangtag_autopay_mandates SET provider = prov, subscription_id = sid, attached_at = NOW(), mode = bm,
        cancel_requested_at = CASE WHEN mm.is_current THEN cancel_requested_at ELSE COALESCE(cancel_requested_at, NOW()) END
     WHERE id = mm.id;
    IF mm.is_current THEN
        UPDATE public.hangtag_subscriptions SET autopay_provider = prov, autopay_subscription_id = sid,
            autopay_customer_id = NULLIF(btrim(COALESCE(p_customer, '')), ''), updated_at = NOW()
         WHERE owner_id = mo AND autopay_status = 'pending' AND autopay_subscription_id IS NULL;
        IF FOUND THEN RETURN jsonb_build_object('ok', TRUE, 'current', TRUE); END IF;
        -- turned off (or set up again) meanwhile: this one is replaced, to be cancelled
        UPDATE public.hangtag_autopay_mandates SET is_current = FALSE, cancel_requested_at = COALESCE(cancel_requested_at, NOW()) WHERE id = mm.id;
    END IF;
    RETURN jsonb_build_object('ok', TRUE, 'current', FALSE);
END $$;
-- What the provider reports about an AutoPay set-up (hangtag_autopay_event's job, through the registry; that function is
-- kept as it was for older callers). Refused in another billing mode. Any set-up Hangtag made is known: the shop's current
-- one, or one it replaced. A charge adds the plan's time once (the provider's payment id) — on a replaced set-up too (the
-- money was taken), noted for review — but only at the price and in the currency agreed to, never for a set-up no shop
-- recorded, and never for money already refunded or disputed: those are kept for review instead. A state report moves the
-- shop's AutoPay only for its current set-up and only when it isn't older than the newest report applied (the provider's
-- times); a cancellation always applies. { ok, known, current, stale, recorded, cancel (to be cancelled at the provider) }
CREATE OR REPLACE FUNCTION public.hangtag_autopay_report(p_provider TEXT, p_subscription TEXT, p_event TEXT, p_payment TEXT, p_amount NUMERIC,
    p_currency TEXT, p_next_charge_at TIMESTAMPTZ, p_event_at TIMESTAMPTZ, p_mode TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    bm TEXT := public.hangtag_billing_mode();
    ev TEXT := lower(btrim(COALESCE(p_event, '')));
    prov TEXT := lower(btrim(COALESCE(p_provider, '')));
    sid TEXT := btrim(COALESCE(p_subscription, ''));
    pay TEXT := btrim(COALESCE(p_payment, ''));
    n TIMESTAMPTZ := NOW();
    at_ TIMESTAMPTZ := LEAST(p_event_at, NOW());
    terminal BOOLEAN;
    mo UUID;
    mm RECORD;
    s RECORD;
    pl RECORD;
    cur BOOLEAN;
    stale BOOLEAN;
    ps TEXT;
    want_cancel BOOLEAN;
    amt NUMERIC(12,2);
    due NUMERIC(12,2);
    due_cur TEXT;
    pid UUID;
    per JSONB;
    x JSONB;
BEGIN
    IF ev NOT IN ('authenticated', 'activated', 'resumed', 'charged', 'pending', 'halted', 'cancelled', 'completed', 'expired') THEN
        RAISE EXCEPTION 'Unknown AutoPay event.' USING ERRCODE = 'P0001';
    END IF;
    IF p_mode IS DISTINCT FROM bm THEN
        RAISE EXCEPTION 'An AutoPay report in % mode on a % database: not applied.', COALESCE(p_mode, 'no'), bm USING ERRCODE = 'P0001';
    END IF;
    terminal := ev IN ('cancelled', 'completed', 'expired');
    -- the shop first, then its set-up (one lock order with begin and attach)
    SELECT r1.shop_owner_id INTO mo FROM public.hangtag_autopay_mandates r1 WHERE r1.provider = prov AND r1.subscription_id = sid;
    IF NOT FOUND THEN
        SELECT r2.owner_id INTO mo FROM public.hangtag_subscriptions r2 WHERE r2.autopay_provider = prov AND r2.autopay_subscription_id = sid;
        IF NOT FOUND THEN RETURN jsonb_build_object('ok', TRUE, 'known', FALSE); END IF;
        -- attached before the registry (or by the older attach): the shop's own current set-up, registered now
        PERFORM 1 FROM public.hangtag_subscriptions r3 WHERE r3.owner_id = mo FOR UPDATE;
        UPDATE public.hangtag_autopay_mandates m SET provider = prov, subscription_id = sid, attached_at = COALESCE(m.attached_at, n), mode = COALESCE(m.mode, bm)
         WHERE m.shop_owner_id = mo AND m.is_current AND m.subscription_id IS NULL;
        IF NOT FOUND THEN
            UPDATE public.hangtag_autopay_mandates m SET is_current = FALSE,
                cancel_requested_at = CASE WHEN m.subscription_id IS NOT NULL AND m.cancel_confirmed_at IS NULL
                    AND COALESCE(m.provider_status, '') NOT IN ('cancelled', 'completed', 'expired') THEN COALESCE(m.cancel_requested_at, n) ELSE m.cancel_requested_at END
             WHERE m.shop_owner_id = mo AND m.is_current;
            INSERT INTO public.hangtag_autopay_mandates (shop_owner_id, provider, subscription_id, plan_code, price, currency, mode, attached_at, is_current, provider_status)
            SELECT r4.owner_id, prov, sid, r4.autopay_plan_code, p.price, COALESCE(p.currency, 'INR'), bm, n, TRUE, r4.autopay_status
              FROM public.hangtag_subscriptions r4 LEFT JOIN public.hangtag_plans p ON p.code = r4.autopay_plan_code WHERE r4.owner_id = mo
            ON CONFLICT (provider, subscription_id) DO NOTHING;
        END IF;
    ELSIF mo IS NOT NULL THEN
        PERFORM 1 FROM public.hangtag_subscriptions r3 WHERE r3.owner_id = mo FOR UPDATE;
    END IF;
    SELECT * INTO mm FROM public.hangtag_autopay_mandates r5 WHERE r5.provider = prov AND r5.subscription_id = sid FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('ok', TRUE, 'known', FALSE); END IF;
    SELECT * INTO s FROM public.hangtag_subscriptions r6 WHERE r6.owner_id = mm.shop_owner_id;
    cur := FOUND AND mm.shop_owner_id IS NOT NULL AND mm.is_current AND s.autopay_provider IS NOT DISTINCT FROM mm.provider
           AND s.autopay_subscription_id IS NOT DISTINCT FROM mm.subscription_id;
    stale := NOT terminal AND at_ IS NOT NULL AND mm.last_state_event_at IS NOT NULL AND at_ < mm.last_state_event_at;
    ps := CASE WHEN stale THEN mm.provider_status
               WHEN ev IN ('activated', 'resumed') THEN 'active'
               WHEN ev = 'charged' THEN CASE WHEN mm.provider_status IN ('cancelled', 'completed', 'expired') THEN mm.provider_status ELSE 'active' END
               ELSE ev END;
    want_cancel := NOT cur AND NOT terminal AND mm.cancel_confirmed_at IS NULL AND COALESCE(ps, '') NOT IN ('cancelled', 'completed', 'expired');
    UPDATE public.hangtag_autopay_mandates SET provider_status = ps,
        last_state_event_at = CASE WHEN stale OR at_ IS NULL THEN last_state_event_at ELSE GREATEST(COALESCE(last_state_event_at, at_), at_) END,
        cancel_confirmed_at = CASE WHEN terminal THEN COALESCE(cancel_confirmed_at, n) ELSE cancel_confirmed_at END,
        cancel_requested_at = CASE WHEN want_cancel THEN COALESCE(cancel_requested_at, n) ELSE cancel_requested_at END
     WHERE id = mm.id;
    IF ev = 'charged' THEN
        amt := round(COALESCE(p_amount, 0), 2);
        IF pay = '' OR amt <= 0 THEN RAISE EXCEPTION 'A charge needs the provider''s payment and its amount.' USING ERRCODE = 'P0001'; END IF;
        IF mm.shop_owner_id IS NULL OR s.owner_id IS NULL THEN
            -- a set-up no shop recorded: the money is kept for review (to refund), never time
            x := public.hangtag_billing_exception_open(prov, 'unknown_mandate_charge', pay, NULL, NULL, amt,
                jsonb_build_object('subscription', sid, 'currency', p_currency, 'note', 'refund it in the provider''s dashboard'), pay);
            RETURN jsonb_build_object('ok', TRUE, 'known', FALSE, 'orphan', TRUE, 'recorded', FALSE, 'current', FALSE, 'cancel', want_cancel);
        END IF;
        IF EXISTS (SELECT 1 FROM public.hangtag_subscription_payments y WHERE y.provider = prov AND y.provider_payment_id = pay) THEN
            RETURN jsonb_build_object('ok', TRUE, 'known', TRUE, 'already', TRUE, 'recorded', TRUE, 'current', cur, 'cancel', want_cancel,
                'state', public.hangtag_subscription_state(s.owner_id, n));
        END IF;
        IF EXISTS (SELECT 1 FROM public.hangtag_billing_exceptions e WHERE e.provider = prov AND e.provider_payment_id = pay AND e.kind IN ('refund', 'dispute') AND e.status = 'open') THEN
            RETURN jsonb_build_object('ok', TRUE, 'known', TRUE, 'recorded', FALSE, 'refunded', TRUE, 'current', cur, 'cancel', want_cancel);
        END IF;
        SELECT p.code, p.price, p.currency INTO pl FROM public.hangtag_plans p WHERE p.code = COALESCE(mm.plan_code, s.autopay_plan_code, 'm1');
        due := COALESCE(mm.price, pl.price); due_cur := upper(COALESCE(mm.currency, pl.currency, 'INR'));
        -- a price or plan that can't be found (a plan since removed) is no price agreed: kept for review like another amount,
        -- never a failure the provider would send again and again
        IF pl.code IS NULL OR due IS NULL OR amt <> due OR upper(btrim(COALESCE(p_currency, ''))) <> due_cur THEN
            x := public.hangtag_billing_exception_open(prov, CASE WHEN pl.code IS NULL OR due IS NULL OR amt <> due THEN 'amount_mismatch' ELSE 'currency_mismatch' END, pay, s.owner_id, NULL, amt,
                jsonb_build_object('subscription', sid, 'due', due, 'currency', p_currency, 'due_currency', due_cur, 'plan', COALESCE(pl.code, mm.plan_code)), pay);
            RETURN jsonb_build_object('ok', TRUE, 'known', TRUE, 'recorded', FALSE, 'mismatch', TRUE, 'current', cur, 'cancel', want_cancel);
        END IF;
        INSERT INTO public.hangtag_subscription_payments (owner_id, plan_code, price, discount, amount, currency, provider, provider_order_id,
            provider_payment_id, status, kind, note)
        VALUES (s.owner_id, pl.code, amt, 0, amt, due_cur, prov, left(sid, 120), left(pay, 120), 'created', 'autopay',
            CASE WHEN NOT cur THEN 'Review: charge on a replaced AutoPay' END)
        ON CONFLICT (provider, provider_payment_id) DO NOTHING
        RETURNING id INTO pid;
        IF pid IS NULL THEN
            RETURN jsonb_build_object('ok', TRUE, 'known', TRUE, 'already', TRUE, 'recorded', TRUE, 'current', cur, 'cancel', want_cancel,
                'state', public.hangtag_subscription_state(s.owner_id, n));
        END IF;
        per := public.hangtag_subscription_extend(s.owner_id, pl.code);
        UPDATE public.hangtag_subscription_payments SET status = 'paid', paid_at = n, captured_at = n,
            period_start = (per ->> 'start')::TIMESTAMPTZ, period_end = (per ->> 'end')::TIMESTAMPTZ
         WHERE id = pid;
        IF cur AND NOT stale THEN
            UPDATE public.hangtag_subscriptions SET autopay_status = CASE WHEN autopay_status = 'cancelled' THEN 'cancelled' ELSE 'active' END,
                autopay_authorized_at = COALESCE(autopay_authorized_at, n), autopay_failed_at = NULL,
                autopay_next_charge_at = CASE WHEN autopay_status = 'cancelled' THEN NULL ELSE COALESCE(p_next_charge_at, (per ->> 'end')::TIMESTAMPTZ) END, updated_at = n
             WHERE owner_id = s.owner_id;
        END IF;
        RETURN jsonb_build_object('ok', TRUE, 'known', TRUE, 'recorded', TRUE, 'current', cur, 'stale', stale, 'cancel', want_cancel, 'owner', s.owner_id,
            'state', public.hangtag_subscription_state(s.owner_id, n),
            'autopay_status', (SELECT y.autopay_status FROM public.hangtag_subscriptions y WHERE y.owner_id = s.owner_id));
    END IF;
    -- a state report: the shop's AutoPay moves only for its current set-up, and not on an older report
    IF NOT cur OR stale THEN
        RETURN jsonb_build_object('ok', TRUE, 'known', mm.shop_owner_id IS NOT NULL, 'orphan', mm.shop_owner_id IS NULL, 'current', cur, 'stale', stale,
            'cancel', want_cancel);
    END IF;
    IF ev IN ('authenticated', 'activated', 'resumed') THEN
        UPDATE public.hangtag_subscriptions SET autopay_status = CASE WHEN s.autopay_status = 'cancelled' THEN 'cancelled' ELSE 'active' END,
            autopay_authorized_at = COALESCE(s.autopay_authorized_at, n), autopay_next_charge_at = COALESCE(p_next_charge_at, s.autopay_next_charge_at),
            autopay_failed_at = CASE WHEN ev = 'resumed' THEN NULL ELSE s.autopay_failed_at END, updated_at = n
         WHERE owner_id = s.owner_id;
    ELSIF ev = 'pending' THEN
        UPDATE public.hangtag_subscriptions SET autopay_status = CASE WHEN s.autopay_status IN ('cancelled', 'halted') THEN s.autopay_status ELSE 'past_due' END,
            autopay_failed_at = n, updated_at = n
         WHERE owner_id = s.owner_id;
    ELSIF ev = 'halted' THEN
        UPDATE public.hangtag_subscriptions SET autopay_status = CASE WHEN s.autopay_status = 'cancelled' THEN 'cancelled' ELSE 'halted' END,
            autopay_failed_at = COALESCE(s.autopay_failed_at, n), autopay_next_charge_at = NULL, updated_at = n
         WHERE owner_id = s.owner_id;
    ELSE
        UPDATE public.hangtag_subscriptions SET autopay_status = 'cancelled', autopay_cancelled_at = COALESCE(s.autopay_cancelled_at, n),
            autopay_next_charge_at = NULL, updated_at = n
         WHERE owner_id = s.owner_id;
    END IF;
    RETURN jsonb_build_object('ok', TRUE, 'known', TRUE, 'current', TRUE, 'stale', FALSE, 'cancel', FALSE, 'owner', s.owner_id,
        'state', public.hangtag_subscription_state(s.owner_id, n),
        'autopay_status', (SELECT y.autopay_status FROM public.hangtag_subscriptions y WHERE y.owner_id = s.owner_id));
END $$;
-- a set-up carrying Hangtag's note that no shop recorded (an attach and its cancel both failed): kept to be cancelled by
-- the reconciler; never a probe of the self-check (those end by themselves). { registered }
CREATE OR REPLACE FUNCTION public.hangtag_autopay_orphan(p_provider TEXT, p_subscription TEXT, p_mode TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE n INT; prov TEXT := lower(btrim(COALESCE(p_provider, ''))); sid TEXT := btrim(COALESCE(p_subscription, '')); bm TEXT := public.hangtag_billing_mode();
BEGIN
    IF p_mode IS DISTINCT FROM bm THEN
        RAISE EXCEPTION 'An AutoPay set-up in % mode on a % database: not recorded.', COALESCE(p_mode, 'no'), bm USING ERRCODE = 'P0001';
    END IF;
    IF sid = '' OR prov !~ '^[a-z]{2,20}$' THEN RAISE EXCEPTION 'The provider''s subscription is missing.' USING ERRCODE = 'P0001'; END IF;
    IF EXISTS (SELECT 1 FROM public.hangtag_billing_probes pr WHERE pr.provider = prov AND pr.entity_id = sid) THEN
        RETURN jsonb_build_object('ok', TRUE, 'registered', FALSE, 'probe', TRUE);
    END IF;
    INSERT INTO public.hangtag_autopay_mandates (shop_owner_id, provider, subscription_id, mode, is_current, cancel_requested_at, attached_at)
    VALUES (NULL, prov, sid, bm, FALSE, NOW(), NOW())
    ON CONFLICT (provider, subscription_id) DO NOTHING;
    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN jsonb_build_object('ok', TRUE, 'registered', n = 1);
END $$;
-- the owner's own check of their AutoPay (the subscription function's autopay_verify) reads the provider at most every 5
-- minutes: the shop's current set-up when it is due a read (stamped now), else null
CREATE OR REPLACE FUNCTION public.hangtag_autopay_check_claim(p_owner UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r RECORD;
BEGIN
    UPDATE public.hangtag_autopay_mandates m SET last_checked_at = NOW()
     WHERE m.shop_owner_id = p_owner AND m.is_current AND m.subscription_id IS NOT NULL
       AND (m.last_checked_at IS NULL OR m.last_checked_at < NOW() - interval '5 minutes')
    RETURNING m.id, m.provider, m.subscription_id, m.price, m.currency INTO r;
    IF NOT FOUND THEN RETURN NULL; END IF;
    RETURN jsonb_build_object('id', r.id, 'provider', r.provider, 'subscription_id', r.subscription_id, 'price', r.price, 'currency', r.currency,
        'recorded', COALESCE((SELECT jsonb_agg(DISTINCT q.pid) FROM (
            SELECT y.provider_payment_id AS pid FROM public.hangtag_subscription_payments y
             WHERE y.kind = 'autopay' AND y.provider = r.provider AND y.provider_order_id = r.subscription_id AND y.provider_payment_id IS NOT NULL
            UNION SELECT e.provider_payment_id FROM public.hangtag_billing_exceptions e
             WHERE e.provider = r.provider AND e.provider_payment_id IS NOT NULL AND e.detail ->> 'subscription' = r.subscription_id) q), '[]'::jsonb));
END $$;

-- 10. Reconciliation: the provider is the record of money, the database of time. A run (the subscription-webhook
--     function's reconcile action, on a schedule) reads back what the provider holds and repairs through the same functions
--     as the notifications; what it can't match is kept for review. One run at a time; the times are the database's.
CREATE TABLE IF NOT EXISTS public.hangtag_billing_reconcile_runs (
    id BIGSERIAL PRIMARY KEY,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at TIMESTAMPTZ,
    mode TEXT NOT NULL CHECK (mode IN ('live', 'test')),
    ok BOOLEAN,
    complete BOOLEAN NOT NULL DEFAULT FALSE,   -- every target and the whole window read (a run that hit its call cap isn't)
    checked INT NOT NULL DEFAULT 0 CHECK (checked >= 0),
    repaired INT NOT NULL DEFAULT 0 CHECK (repaired >= 0),
    exceptions_opened INT NOT NULL DEFAULT 0 CHECK (exceptions_opened >= 0),
    c_until TIMESTAMPTZ,   -- the account's subscriptions read up to here
    d_until TIMESTAMPTZ,   -- the account's payments, refunds and disputes read up to here
    provider_totals JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(provider_totals) = 'object' AND pg_column_size(provider_totals) <= 4000),
    error_code TEXT CHECK (error_code IS NULL OR char_length(error_code) <= 60)
);
CREATE INDEX IF NOT EXISTS idx_hangtag_billing_reconcile_runs_started ON public.hangtag_billing_reconcile_runs (mode, started_at DESC);
-- the self-check's objects at the provider (a ₹1 link, a far-future subscription; both cancelled at once, both ending by
-- themselves): their notifications prove the webhook, and they are never taken for a shop's money
CREATE TABLE IF NOT EXISTS public.hangtag_billing_probes (
    provider TEXT NOT NULL CHECK (provider ~ '^[a-z]{2,20}$'),
    entity_id TEXT NOT NULL CHECK (char_length(entity_id) BETWEEN 1 AND 120),
    kind TEXT NOT NULL CHECK (kind IN ('payment_link', 'subscription')),
    mode TEXT NOT NULL CHECK (mode IN ('live', 'test')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (provider, entity_id)
);
-- when the reconciler last read a plan payment's page back (least recently read first; 'final' once it can't change)
CREATE TABLE IF NOT EXISTS public.hangtag_billing_payment_checks (
    payment_id UUID PRIMARY KEY,
    last_checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    final BOOLEAN NOT NULL DEFAULT FALSE
);
ALTER TABLE public.hangtag_billing_reconcile_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hangtag_billing_probes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hangtag_billing_payment_checks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.hangtag_billing_reconcile_runs, public.hangtag_billing_probes, public.hangtag_billing_payment_checks FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.hangtag_billing_reconcile_runs_id_seq FROM PUBLIC, anon, authenticated;
-- a run begins: refused in another billing mode (recorded as a failed run, so the window stays put); { busy } while
-- another runs or one ended under 5 minutes ago; else { run_id, payments (sweep A), mandates (sweep B), c_since, d_since }
CREATE OR REPLACE FUNCTION public.hangtag_billing_reconcile_begin(p_limit INT, p_mode TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    bm TEXT := public.hangtag_billing_mode();
    lim INT := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 500);
    rid BIGINT;
    since TIMESTAMPTZ;
    c_since TIMESTAMPTZ;
    d_since TIMESTAMPTZ;
    pays JSONB;
    mands JSONB;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended('hangtag_billing_reconcile', 0));
    IF p_mode IS DISTINCT FROM bm THEN
        INSERT INTO public.hangtag_billing_reconcile_runs (mode, finished_at, ok, error_code) VALUES (bm, NOW(), FALSE, 'mode_mismatch');
        RETURN jsonb_build_object('refused', TRUE, 'reason', 'mode_mismatch');
    END IF;
    IF EXISTS (SELECT 1 FROM public.hangtag_billing_reconcile_runs r WHERE r.finished_at IS NULL AND r.started_at > NOW() - interval '10 minutes')
       OR EXISTS (SELECT 1 FROM public.hangtag_billing_reconcile_runs r WHERE r.finished_at > NOW() - interval '5 minutes' AND r.error_code IS DISTINCT FROM 'mode_mismatch') THEN
        RETURN jsonb_build_object('busy', TRUE);
    END IF;
    INSERT INTO public.hangtag_billing_reconcile_runs (mode) VALUES (bm) RETURNING id INTO rid;
    SELECT max(r.started_at) - interval '48 hours' INTO since FROM public.hangtag_billing_reconcile_runs r WHERE r.mode = bm AND r.ok AND r.complete;
    IF since IS NULL THEN
        since := LEAST((SELECT min(y.created_at) FROM public.hangtag_subscription_payments y WHERE y.provider NOT IN ('manual', 'free')),
                       (SELECT min(m.created_at) FROM public.hangtag_autopay_mandates m), NOW() - interval '1 hour');
    END IF;
    SELECT max(r.c_until) - interval '48 hours' INTO c_since FROM public.hangtag_billing_reconcile_runs r WHERE r.mode = bm AND r.c_until IS NOT NULL;
    SELECT max(r.d_until) - interval '48 hours' INTO d_since FROM public.hangtag_billing_reconcile_runs r WHERE r.mode = bm AND r.d_until IS NOT NULL;
    -- sweep A: plan payments whose page was made and that aren't paid (a missed notification), 15 minutes old or more, from
    -- 7 days back — or further, to the last complete run, after a gap
    SELECT COALESCE(jsonb_agg(to_jsonb(y) - 'checked_at' ORDER BY y.checked_at NULLS FIRST, y.created_at), '[]'::jsonb) INTO pays FROM (
        SELECT p.id, p.owner_id, p.amount, p.currency, p.status, p.provider, p.provider_order_id, p.created_at, c.last_checked_at AS checked_at
          FROM public.hangtag_subscription_payments p LEFT JOIN public.hangtag_billing_payment_checks c ON c.payment_id = p.id
         WHERE p.kind = 'one_time' AND p.status IN ('created', 'expired', 'cancelled', 'failed') AND p.provider_order_id IS NOT NULL
           AND p.provider NOT IN ('manual', 'free') AND NOT COALESCE(c.final, FALSE)
           AND p.created_at BETWEEN LEAST(NOW() - interval '7 days', since) AND NOW() - interval '15 minutes'
           AND (c.last_checked_at IS NULL OR c.last_checked_at < NOW() - interval '50 minutes')
         ORDER BY c.last_checked_at NULLS FIRST, p.created_at LIMIT lim) y;
    -- sweep B: AutoPay set-ups to read back — a cancel not yet confirmed; a renewal overdue at 22 hours, 46 hours and 4 days
    -- (charges are retried for days); one ended (read once more); one not read in a day. Never a probe.
    SELECT COALESCE(jsonb_agg(z.j ORDER BY z.rk, z.created_at), '[]'::jsonb) INTO mands FROM (
        SELECT q.rk, q.created_at,
               jsonb_build_object('id', q.id, 'shop_owner_id', q.shop_owner_id, 'provider', q.provider, 'subscription_id', q.subscription_id,
                   'current', q.is_current, 'provider_status', q.provider_status, 'next_charge_at', q.next_charge_at, 'reason', q.reason,
                   'overdue_days', q.overdue_days, 'price', q.price, 'currency', q.currency,
                   'recorded', COALESCE((SELECT jsonb_agg(DISTINCT k.pid) FROM (
                        SELECT y.provider_payment_id AS pid FROM public.hangtag_subscription_payments y
                         WHERE y.kind = 'autopay' AND y.provider = q.provider AND y.provider_order_id = q.subscription_id AND y.provider_payment_id IS NOT NULL
                        UNION SELECT e.provider_payment_id FROM public.hangtag_billing_exceptions e
                         WHERE e.provider = q.provider AND e.provider_payment_id IS NOT NULL AND e.detail ->> 'subscription' = q.subscription_id) k), '[]'::jsonb)) AS j
          FROM (SELECT m.*, s.autopay_next_charge_at AS next_charge_at,
                       CASE WHEN ov.due THEN round((EXTRACT(EPOCH FROM (NOW() - s.autopay_next_charge_at)) / 86400)::NUMERIC, 2) END AS overdue_days,
                       CASE WHEN m.cancel_requested_at IS NOT NULL AND m.cancel_confirmed_at IS NULL THEN 'cancel'
                            WHEN ov.due THEN 'charge_overdue'
                            WHEN m.cancel_confirmed_at IS NOT NULL AND m.final_checked_at IS NULL THEN 'final'
                            ELSE 'check' END AS reason,
                       CASE WHEN m.cancel_requested_at IS NOT NULL AND m.cancel_confirmed_at IS NULL THEN 0 WHEN ov.due THEN 1
                            WHEN m.cancel_confirmed_at IS NOT NULL AND m.final_checked_at IS NULL THEN 2 ELSE 3 END AS rk
                  FROM public.hangtag_autopay_mandates m
                  LEFT JOIN public.hangtag_subscriptions s ON s.owner_id = m.shop_owner_id AND s.autopay_subscription_id = m.subscription_id AND m.is_current
                  CROSS JOIN LATERAL (SELECT COALESCE(m.is_current AND s.autopay_status IN ('active', 'past_due') AND s.autopay_next_charge_at IS NOT NULL
                        AND ((NOW() >= s.autopay_next_charge_at + interval '22 hours' AND (m.last_checked_at IS NULL OR m.last_checked_at < s.autopay_next_charge_at + interval '22 hours'))
                          OR (NOW() >= s.autopay_next_charge_at + interval '46 hours' AND m.last_checked_at < s.autopay_next_charge_at + interval '46 hours')
                          OR (NOW() >= s.autopay_next_charge_at + interval '4 days' AND m.last_checked_at < s.autopay_next_charge_at + interval '4 days')), FALSE) AS due) ov
                 WHERE m.subscription_id IS NOT NULL
                   AND NOT EXISTS (SELECT 1 FROM public.hangtag_billing_probes pr WHERE pr.provider = m.provider AND pr.entity_id = m.subscription_id)) q
         WHERE q.reason IN ('cancel', 'charge_overdue', 'final')
            OR (COALESCE(q.provider_status, '') NOT IN ('cancelled', 'completed', 'expired') AND q.cancel_confirmed_at IS NULL
                AND (q.last_checked_at IS NULL OR q.last_checked_at < NOW() - interval '24 hours'))
         ORDER BY q.rk, q.created_at LIMIT lim) z;
    RETURN jsonb_build_object('run_id', rid, 'mode', bm, 'payments', pays, 'mandates', mands,
        'c_since', COALESCE(c_since, since), 'd_since', COALESCE(d_since, since), 'started_at', (SELECT r.started_at FROM public.hangtag_billing_reconcile_runs r WHERE r.id = rid));
END $$;
-- a run ends: { ok, complete, checked, repaired, exceptions_opened, c_until, d_until, provider_totals, error_code,
-- checked_mandates [ids], checked_payments [{ id, final }] } — stamped with the database's time
CREATE OR REPLACE FUNCTION public.hangtag_billing_reconcile_done(p_run_id BIGINT, p_result JSONB)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r RECORD; res JSONB := CASE WHEN jsonb_typeof(p_result) = 'object' THEN p_result ELSE '{}'::jsonb END;
BEGIN
    SELECT * INTO r FROM public.hangtag_billing_reconcile_runs x WHERE x.id = p_run_id FOR UPDATE;
    IF NOT FOUND OR r.finished_at IS NOT NULL THEN RAISE EXCEPTION 'No such run waiting to finish.' USING ERRCODE = 'P0001'; END IF;
    BEGIN
        UPDATE public.hangtag_billing_reconcile_runs SET finished_at = NOW(), ok = COALESCE((res ->> 'ok')::BOOLEAN, FALSE),
            complete = COALESCE((res ->> 'complete')::BOOLEAN, FALSE) AND COALESCE((res ->> 'ok')::BOOLEAN, FALSE),
            checked = GREATEST(COALESCE((res ->> 'checked')::INT, 0), 0), repaired = GREATEST(COALESCE((res ->> 'repaired')::INT, 0), 0),
            exceptions_opened = GREATEST(COALESCE((res ->> 'exceptions_opened')::INT, 0), 0),
            c_until = CASE WHEN res ->> 'c_until' IS NOT NULL THEN LEAST((res ->> 'c_until')::TIMESTAMPTZ, r.started_at) END,
            d_until = CASE WHEN res ->> 'd_until' IS NOT NULL THEN LEAST((res ->> 'd_until')::TIMESTAMPTZ, r.started_at) END,
            provider_totals = CASE WHEN jsonb_typeof(res -> 'provider_totals') = 'object' AND pg_column_size(res -> 'provider_totals') <= 4000 THEN res -> 'provider_totals' ELSE '{}'::jsonb END,
            error_code = left(res ->> 'error_code', 60)
         WHERE id = p_run_id;
    EXCEPTION WHEN invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow OR numeric_value_out_of_range THEN
        RAISE EXCEPTION 'The run''s result isn''t readable.' USING ERRCODE = 'P0001';
    END;
    UPDATE public.hangtag_autopay_mandates m SET last_checked_at = NOW(),
        final_checked_at = CASE WHEN m.cancel_confirmed_at IS NOT NULL THEN COALESCE(m.final_checked_at, NOW()) ELSE m.final_checked_at END
     WHERE m.id::text IN (SELECT jsonb_array_elements_text(CASE WHEN jsonb_typeof(res -> 'checked_mandates') = 'array' THEN res -> 'checked_mandates' ELSE '[]'::jsonb END));
    INSERT INTO public.hangtag_billing_payment_checks (payment_id, last_checked_at, final)
    SELECT y.id, NOW(), COALESCE((e ->> 'final')::BOOLEAN, FALSE)
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(res -> 'checked_payments') = 'array' THEN res -> 'checked_payments' ELSE '[]'::jsonb END) e
      JOIN public.hangtag_subscription_payments y ON y.id::text = e ->> 'id'
    ON CONFLICT (payment_id) DO UPDATE SET last_checked_at = EXCLUDED.last_checked_at, final = public.hangtag_billing_payment_checks.final OR EXCLUDED.final;
    RETURN jsonb_build_object('ok', TRUE, 'id', p_run_id);
END $$;
-- which of these provider payments Hangtag already holds: a paid plan payment's, or one kept for review
CREATE OR REPLACE FUNCTION public.hangtag_billing_known_payments(p_provider TEXT, p_ids TEXT[])
RETURNS TEXT[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
    SELECT COALESCE(array_agg(DISTINCT q.k), ARRAY[]::TEXT[]) FROM (
        SELECT y.provider_payment_id AS k FROM public.hangtag_subscription_payments y
         WHERE y.provider = lower(btrim(COALESCE(p_provider, ''))) AND y.status = 'paid' AND y.provider_payment_id = ANY (COALESCE(p_ids, ARRAY[]::TEXT[]))
        UNION SELECT e.provider_payment_id FROM public.hangtag_billing_exceptions e
         WHERE e.provider = lower(btrim(COALESCE(p_provider, ''))) AND e.provider_payment_id = ANY (COALESCE(p_ids, ARRAY[]::TEXT[]))) q
$$;
-- which of these provider subscriptions are Hangtag's set-ups (the registry or a shop's record), and which are probes
CREATE OR REPLACE FUNCTION public.hangtag_autopay_known(p_provider TEXT, p_subs TEXT[])
RETURNS JSONB LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
    SELECT jsonb_build_object(
        'known', COALESCE((SELECT jsonb_agg(DISTINCT q.k) FROM (
            SELECT m.subscription_id AS k FROM public.hangtag_autopay_mandates m
             WHERE m.provider = lower(btrim(COALESCE(p_provider, ''))) AND m.subscription_id = ANY (COALESCE(p_subs, ARRAY[]::TEXT[]))
            UNION SELECT s.autopay_subscription_id FROM public.hangtag_subscriptions s
             WHERE s.autopay_provider = lower(btrim(COALESCE(p_provider, ''))) AND s.autopay_subscription_id = ANY (COALESCE(p_subs, ARRAY[]::TEXT[]))) q), '[]'::jsonb),
        'probes', COALESCE((SELECT jsonb_agg(pr.entity_id) FROM public.hangtag_billing_probes pr
             WHERE pr.provider = lower(btrim(COALESCE(p_provider, ''))) AND pr.entity_id = ANY (COALESCE(p_subs, ARRAY[]::TEXT[]))), '[]'::jsonb))
$$;
-- the self-check's objects, as it makes them (refused in another billing mode)
CREATE OR REPLACE FUNCTION public.hangtag_billing_probe_record(p_provider TEXT, p_kind TEXT, p_entity TEXT, p_mode TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE bm TEXT := public.hangtag_billing_mode();
BEGIN
    IF p_mode IS DISTINCT FROM bm THEN
        RAISE EXCEPTION 'A probe in % mode on a % database: not recorded.', COALESCE(p_mode, 'no'), bm USING ERRCODE = 'P0001';
    END IF;
    INSERT INTO public.hangtag_billing_probes (provider, entity_id, kind, mode) VALUES (lower(btrim(p_provider)), btrim(p_entity), p_kind, bm)
    ON CONFLICT (provider, entity_id) DO NOTHING;
    RETURN jsonb_build_object('ok', TRUE);
END $$;
-- what must always hold between money and time: no two paid periods of a shop overlap; nothing counted as paid that no
-- provider captured (free and console-given plans aside); no shop's time ends before a period it paid for; every AutoPay
-- charge belongs to one of that shop's set-ups. { ok, problems }
CREATE OR REPLACE FUNCTION public.hangtag_billing_integrity()
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE probs JSONB := '[]'::jsonb;
BEGIN
    probs := probs || COALESCE((SELECT jsonb_agg(jsonb_build_object('kind', 'overlapping_periods', 'shop_owner_id', a.owner_id, 'payments', jsonb_build_array(a.id, b.id)))
        FROM public.hangtag_subscription_payments a JOIN public.hangtag_subscription_payments b
          ON b.owner_id = a.owner_id AND a.id < b.id AND b.status = 'paid' AND b.period_start IS NOT NULL AND b.period_end IS NOT NULL
         AND a.period_start < b.period_end AND b.period_start < a.period_end
       WHERE a.status = 'paid' AND a.period_start IS NOT NULL AND a.period_end IS NOT NULL), '[]'::jsonb);
    probs := probs || COALESCE((SELECT jsonb_agg(jsonb_build_object('kind', 'paid_without_capture', 'shop_owner_id', p.owner_id, 'payment', p.id))
        FROM public.hangtag_subscription_payments p
       WHERE p.status = 'paid' AND p.amount > 0 AND p.provider NOT IN ('manual', 'free') AND p.captured_at IS NULL), '[]'::jsonb);
    probs := probs || COALESCE((SELECT jsonb_agg(jsonb_build_object('kind', 'time_short_of_payments', 'shop_owner_id', s.owner_id, 'period_end', s.period_end, 'paid_until', x.paid_until))
        FROM public.hangtag_subscriptions s
        JOIN (SELECT p.owner_id, max(p.period_end) AS paid_until FROM public.hangtag_subscription_payments p
               WHERE p.status = 'paid' AND p.period_end IS NOT NULL GROUP BY p.owner_id) x ON x.owner_id = s.owner_id
       WHERE s.period_end IS NULL OR s.period_end < x.paid_until), '[]'::jsonb);
    probs := probs || COALESCE((SELECT jsonb_agg(jsonb_build_object('kind', 'autopay_charge_without_setup', 'shop_owner_id', p.owner_id, 'payment', p.id))
        FROM public.hangtag_subscription_payments p
       WHERE p.kind = 'autopay' AND NOT EXISTS (SELECT 1 FROM public.hangtag_autopay_mandates m
              WHERE m.shop_owner_id = p.owner_id AND m.provider = p.provider AND m.subscription_id = p.provider_order_id)), '[]'::jsonb);
    RETURN jsonb_build_object('ok', jsonb_array_length(probs) = 0, 'problems', probs, 'checked_at', NOW());
END $$;

-- 11. AutoPay readiness: offered, switched on and required of new trials only once its provider's notifications are
--     proven to reach this database in its own mode — a payment-link and a subscription notification within 7 days (the
--     provider's own times), each about one of the self-check's objects or a real Hangtag one — and a complete
--     reconciliation ran within 26 hours. Losing it stops new set-ups by itself; set-ups already made keep being recorded.
CREATE OR REPLACE FUNCTION public.hangtag_billing_readiness()
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE bm TEXT := public.hangtag_billing_mode(); l TIMESTAMPTZ; a TIMESTAMPTZ; rc TIMESTAMPTZ; why TEXT[] := ARRAY[]::TEXT[];
BEGIN
    SELECT max(e.provider_created_at) INTO l FROM public.hangtag_billing_events e
     WHERE e.provider = 'razorpay' AND e.mode = bm AND left(e.event_type, 13) = 'payment_link.' AND e.provider_created_at > NOW() - interval '7 days'
       AND (EXISTS (SELECT 1 FROM public.hangtag_billing_probes pr WHERE pr.provider = e.provider AND pr.entity_id = e.entity_id AND pr.mode = bm)
            OR EXISTS (SELECT 1 FROM public.hangtag_subscription_payments y WHERE y.provider = e.provider AND y.provider_order_id = e.entity_id));
    SELECT max(e.provider_created_at) INTO a FROM public.hangtag_billing_events e
     WHERE e.provider = 'razorpay' AND e.mode = bm AND starts_with(e.event_type, 'subscription.') AND e.provider_created_at > NOW() - interval '7 days'
       AND (EXISTS (SELECT 1 FROM public.hangtag_billing_probes pr WHERE pr.provider = e.provider AND pr.entity_id = e.entity_id AND pr.mode = bm)
            OR EXISTS (SELECT 1 FROM public.hangtag_autopay_mandates m WHERE m.provider = e.provider AND m.subscription_id = e.entity_id AND m.shop_owner_id IS NOT NULL));
    SELECT max(x.started_at) INTO rc FROM public.hangtag_billing_reconcile_runs x
     WHERE x.mode = bm AND x.ok AND x.complete AND x.finished_at IS NOT NULL AND x.started_at > NOW() - interval '26 hours';
    IF l IS NULL THEN why := why || 'no payment-link notification proven in 7 days'::TEXT; END IF;
    IF a IS NULL THEN why := why || 'no subscription notification proven in 7 days'::TEXT; END IF;
    IF rc IS NULL THEN why := why || 'no complete reconciliation in 26 hours'::TEXT; END IF;
    RETURN jsonb_build_object('ready', cardinality(why) = 0, 'mode', bm, 'link_event_at', l, 'autopay_event_at', a, 'reconcile_at', rc, 'reasons', to_jsonb(why));
END $$;
${EDITED.hangtag_autopay_terms}
${EDITED.hangtag_platform_settings_save}
${EDITED.hangtag_subscription_ensure}
-- the console's billing self-check may run (settings.manage; once in 10 minutes; audited before any provider is asked)
CREATE OR REPLACE FUNCTION public.hangtag_billing_selfcheck_allowed()
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r TEXT := public.hangtag_platform_require('settings.manage');
BEGIN
    IF EXISTS (SELECT 1 FROM public.hangtag_platform_audit a WHERE a.action = 'billing.selfcheck' AND a.t > NOW() - interval '10 minutes') THEN
        RAISE EXCEPTION 'The billing self-check ran less than 10 minutes ago.' USING ERRCODE = 'P0001';
    END IF;
    PERFORM public.hangtag_platform_log('billing.selfcheck', 'billing', 'webhook', jsonb_build_object('mode', public.hangtag_billing_mode()));
    RETURN TRUE;
END $$;

-- 12. The console: money kept for review (payments.view), settled with a reason (subscriptions.manage, audited), and the
--     billing health (readiness, the last runs, the checks)
CREATE OR REPLACE FUNCTION public.hangtag_platform_billing_exceptions(p_status TEXT DEFAULT 'open', p_limit INT DEFAULT 100)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r TEXT := public.hangtag_platform_require('payments.view'); st TEXT := lower(btrim(COALESCE(p_status, 'open'))); lim INT := LEAST(GREATEST(COALESCE(p_limit, 100), 1), 500);
BEGIN
    IF st NOT IN ('open', 'resolved', 'all') THEN RAISE EXCEPTION 'Choose open, resolved or all.' USING ERRCODE = 'P0001'; END IF;
    RETURN jsonb_build_object(
        'counts', (SELECT jsonb_build_object('open', count(*) FILTER (WHERE e.status = 'open'), 'resolved', count(*) FILTER (WHERE e.status = 'resolved'))
                     FROM public.hangtag_billing_exceptions e),
        'rows', COALESCE((SELECT jsonb_agg(to_jsonb(y) ORDER BY y.opened_at DESC) FROM (
            SELECT e.id, e.kind, e.provider, e.ref, e.shop_owner_id, e.payment_id, e.provider_payment_id, e.amount, e.detail, e.opened_at, e.status,
                   e.resolved_at, e.resolution, p.shop_name, u.email
              FROM public.hangtag_billing_exceptions e
              LEFT JOIN public.hangtag_profiles p ON p.id = e.shop_owner_id
              LEFT JOIN auth.users u ON u.id = e.shop_owner_id
             WHERE st = 'all' OR e.status = st
             ORDER BY e.opened_at DESC LIMIT lim) y), '[]'::jsonb));
END $$;
CREATE OR REPLACE FUNCTION public.hangtag_platform_billing_exception_resolve(p_id BIGINT, p_resolution TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r TEXT := public.hangtag_platform_require('subscriptions.manage'); x RECORD; res TEXT := btrim(COALESCE(p_resolution, '')); aft JSONB;
BEGIN
    IF char_length(res) NOT BETWEEN 3 AND 300 THEN RAISE EXCEPTION 'Say how it was settled (3 to 300 characters).' USING ERRCODE = 'P0001'; END IF;
    SELECT * INTO x FROM public.hangtag_billing_exceptions e WHERE e.id = p_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'No such item for review.' USING ERRCODE = 'P0001'; END IF;
    IF x.status = 'resolved' THEN RAISE EXCEPTION 'This item was already settled.' USING ERRCODE = 'P0001'; END IF;
    UPDATE public.hangtag_billing_exceptions SET status = 'resolved', resolved_at = NOW(), resolved_by = auth.uid(), resolution = res WHERE id = p_id
    RETURNING to_jsonb(hangtag_billing_exceptions) INTO aft;
    PERFORM public.hangtag_platform_log('billing.exception_resolve', 'billing_exception', p_id::TEXT,
        jsonb_build_object('kind', x.kind, 'shop', x.shop_owner_id, 'before', to_jsonb(x), 'after', aft));
    RETURN aft;
END $$;
CREATE OR REPLACE FUNCTION public.hangtag_platform_billing_health()
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r TEXT := public.hangtag_platform_require('payments.view');
BEGIN
    RETURN jsonb_build_object('mode', public.hangtag_billing_mode(), 'readiness', public.hangtag_billing_readiness(),
        'autopay_enabled', (SELECT c.autopay_enabled FROM public.hangtag_platform_config c WHERE c.id),
        'runs', COALESCE((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.started_at DESC) FROM (
            SELECT y.id, y.started_at, y.finished_at, y.mode, y.ok, y.complete, y.checked, y.repaired, y.exceptions_opened, y.error_code
              FROM public.hangtag_billing_reconcile_runs y ORDER BY y.started_at DESC LIMIT 5) x), '[]'::jsonb),
        'open_exceptions', (SELECT count(*) FROM public.hangtag_billing_exceptions e WHERE e.status = 'open'),
        'integrity', public.hangtag_billing_integrity());
END $$;

-- who may call what: every function added here, no app account unless it is a console function (each checks the console
-- role first); the service role (the subscription functions) the rest, and the billing tables
REVOKE ALL ON FUNCTION ${NEW_FUNCTIONS.map((f) => 'public.' + f).join(',\n    ')} FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION ${APP_CALLABLE.map((f) => 'public.' + f).join(', ')} TO authenticated;
DO $do$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
        EXECUTE $g$GRANT ALL ON TABLE ${BILLING_TABLES.map((t) => 'public.' + t).join(', ')} TO service_role$g$;
        EXECUTE $g$GRANT USAGE, SELECT ON SEQUENCE public.hangtag_billing_exceptions_id_seq, public.hangtag_billing_reconcile_runs_id_seq TO service_role$g$;
        EXECUTE $g$GRANT EXECUTE ON FUNCTION ${SERVICE_ONLY.map((f) => 'public.' + f).join(',\n            ')} TO service_role$g$;
    END IF;
END $do$;

-- Report: every row ok, or nothing of this migration is kept — a row that isn't stops it here, before it can commit
DO $report$
DECLARE bad TEXT;
BEGIN
    SELECT string_agg(r.n || ' ' || r.check_name, '; ' ORDER BY r.n) INTO bad FROM (
${REPORT_ROWS}
    ) r WHERE r.ok IS NOT TRUE;
    IF bad IS NOT NULL THEN
        RAISE EXCEPTION 'The post-repair report is not all ok (%). Nothing was changed.', bad USING ERRCODE = 'P0001';
    END IF;
END $report$;
${REPORT}
`;

const restore = FUNCTION_EDITS.map((f) => ORIGINAL[f.name]).join('\n\n');
const UNDO = `-- WRITES (DDL). The undo of supabase/migrations/20261019120000_hangtag_post_repair_integrity.sql (generated with it by
-- scripts/gen-post-repair.mjs): the ${FUNCTION_EDITS.length} functions it changed go back to supabase/schema.sql's versions, byte for
-- byte (their arguments never changed, so their grants stay as they are); its triggers and every function it added are
-- removed. Its tables stay, with what they hold (deleted products' marks; the billing mode; notifications, money for review,
-- the AutoPay registry, reconciliation runs): drop them by hand only when they are no longer needed. Redeploy the
-- subscription functions of the build before this migration first, or keep the current build: it falls back to the older
-- functions when these are gone. Run it whole; the last row says whether it took.
BEGIN;
SET LOCAL lock_timeout = '10s';
${restore}

DROP TRIGGER IF EXISTS hangtag_tracking_required ON public.hangtag_stock_moves;
DROP FUNCTION IF EXISTS public.hangtag_tracking_required();
DROP TRIGGER IF EXISTS hangtag_product_deleted ON public.hangtag_products;
DROP FUNCTION IF EXISTS public.hangtag_product_deleted();
DROP TRIGGER IF EXISTS zz_hangtag_subscription_guard ON public.hangtag_deleted_products;
${NEW_FUNCTIONS.map((f) => `DROP FUNCTION IF EXISTS public.${f};`).join('\n')}
COMMIT;
SELECT ${FUNCTION_EDITS.map((f) => `md5(replace(${src(sigOf(f.name))}, chr(13), '')) = '${md5(bodyOf(ORIGINAL[f.name]))}'`).join('\n   AND ')}
   AND to_regprocedure('public.hangtag_tracking_required()') IS NULL AND to_regprocedure('public.hangtag_product_deleted()') IS NULL
   AND NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = to_regclass('public.hangtag_deleted_products') AND t.tgname = 'zz_hangtag_subscription_guard')
   AND ${NEW_FUNCTIONS.map((f) => `${regp(f)} IS NULL`).join('\n   AND ')} AS undone;
`;

function sigOf(name) {
  const sigs = { hangtag_check_return_qty: '()', hangtag_save_sales: '(JSONB)', hangtag_cap_on: '(UUID, TEXT)', hangtag_subscription_checkout: '(TEXT, TEXT, TEXT)',
    hangtag_subscription_attach: '(UUID, TEXT, TEXT)', hangtag_promo_evaluate: '(UUID, TEXT, TEXT)', hangtag_autopay_begin: '(BOOLEAN, TEXT)',
    hangtag_autopay_terms: '(UUID)', hangtag_platform_settings_save: '(JSONB)', hangtag_subscription_ensure: '(UUID)' };
  if (!sigs[name]) throw new Error('no signature for ' + name);
  return name + sigs[name];
}
/* The function's body as pg_proc.prosrc keeps it: what lies between its opening and closing dollar quotes */
function bodyOf(text) {
  const open = text.indexOf('$$') + 2, close = text.lastIndexOf('$$');
  return text.slice(open, close);
}
function md5(s) { return createHash('md5').update(s).digest('hex'); }
import { createHash } from 'node:crypto';

const CHECK = `-- Read-only. The post-repair migration's report (supabase/migrations/20261019120000_hangtag_post_repair_integrity.sql):
-- run it any time to see whether the migration's changes are all in place — every row ok. After a run of schema.sql,
-- rows read false until the migration is run again. Generated by scripts/gen-post-repair.mjs.
${REPORT}
`;

fs.writeFileSync(new URL('supabase/migrations/20261019120000_hangtag_post_repair_integrity.sql', root), MIG);
fs.writeFileSync(new URL('supabase/operations/post-repair-integrity-undo.sql', root), UNDO);
fs.writeFileSync(new URL('supabase/checks/post-repair-report.sql', root), CHECK);
console.log('written: migration', MIG.length, 'undo', UNDO.length, 'check', CHECK.length);
