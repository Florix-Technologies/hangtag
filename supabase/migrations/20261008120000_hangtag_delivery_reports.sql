-- ==============================================================================
-- Hangtag: the providers' delivery reports (schema.sql section 3v)
--   an index so the Edge Function delivery-status finds a message by the provider's own id
--
-- For the live database that supabase/schema.sql builds (the hangtag_* tables). It needs the delivery log
-- (hangtag_deliveries, section 3 onwards) already applied: run supabase/schema.sql once, or run this file after it.
-- Safe to run again. It is exactly section 3v of schema.sql, so running the whole schema.sql again gives the same result.
--
-- Requires: supabase/schema.sql (applied first)
-- How to apply: Supabase → SQL Editor → New query → paste this file → Run (or supabase db push).
-- ==============================================================================

-- ==============================================================================
-- 3v. The providers' delivery reports (receipts: "Delivered")
--   WhatsApp (Meta's WhatsApp Cloud API), Twilio and Resend report what happened to each message to the Edge Function
--   delivery-status, which finds the message by the provider's own id: this index makes that a lookup, not a scan of
--   every shop's messages. Nothing else changes (the function writes with the service role, as send-receipt does).
--   Safe to run again.
-- ==============================================================================
CREATE INDEX IF NOT EXISTS idx_hangtag_deliveries_provider_msg ON public.hangtag_deliveries (provider, provider_message_id)
    WHERE provider_message_id IS NOT NULL;
