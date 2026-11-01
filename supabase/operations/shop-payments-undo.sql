-- WRITES (DDL). The undo of supabase/migrations/20261023120000_hangtag_shop_payments.sql, only on the owner's word. Turn the
-- gateway off first (unset PAYMENT_ALLOWED_USERS on payment-gateway): the functions of this build need what this removes.
-- It removes the migration's behaviour and keeps every row:
--  - the shop's confirmation of UPI (hangtag_confirm_upi_payment) and the trigger that keeps a phone from uploading UPI as
--    recorded or confirmed, or undoing a confirmation, go;
--  - section 3h's verification rule comes back only when no payment is "confirmed" (an older rule would refuse those
--    bills' next upload); otherwise the migration's rule, which also allows "confirmed", stays;
--  - new intents no longer need an account; the column, its link to the account and the refund outcomes stay;
--  - the accounts and the notifications stay, closed to every app account as they are (the sealed keys open with nothing
--    once PAYMENT_ACCOUNTS_KEY is unset). Drop them by hand only when no longer needed.
-- Run it whole; the last row says whether it took.
BEGIN;
SET LOCAL lock_timeout = '10s';
DROP FUNCTION IF EXISTS public.hangtag_confirm_upi_payment(TEXT);
DROP TRIGGER IF EXISTS hangtag_keep_payment_state ON public.hangtag_payments;
DROP FUNCTION IF EXISTS public.hangtag_keep_payment_state();
DROP TRIGGER IF EXISTS hangtag_intent_account_check ON public.hangtag_payment_intents;
DROP FUNCTION IF EXISTS public.hangtag_intent_account_check();
DO $undo$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM public.hangtag_payments WHERE verification = 'confirmed') THEN
        ALTER TABLE public.hangtag_payments DROP CONSTRAINT IF EXISTS hangtag_payments_verification_check;
        ALTER TABLE public.hangtag_payments ADD CONSTRAINT hangtag_payments_verification_check CHECK (
            verification IN ('verified','recorded','unverified')
            AND (via IS NULL OR (method = 'upi' AND via IN ('manual','qr')) OR (method = 'card' AND via IN ('terminal','link')))
            AND (method <> 'cash' OR (via IS NULL AND verification = 'recorded'))
            AND (verification <> 'unverified' OR method = 'upi')
            AND (verification <> 'verified' OR intent_id IS NOT NULL)
            AND (card_last4 IS NULL OR (method = 'card' AND card_last4 ~ '^[0-9]{4}$'))
            AND (provider_fee IS NULL OR (verification = 'verified' AND provider_fee >= 0))
            AND (provider_payment_id IS NULL OR char_length(provider_payment_id) <= 64)) NOT VALID;
    END IF;
END $undo$;
COMMIT;
SELECT to_regprocedure('public.hangtag_confirm_upi_payment(text)') IS NULL
   AND NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgname IN ('hangtag_keep_payment_state', 'hangtag_intent_account_check') AND NOT t.tgisinternal) AS undone;
