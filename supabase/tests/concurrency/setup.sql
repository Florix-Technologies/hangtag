-- A disposable PostgreSQL 17 made to look like a Supabase project, with schema.sql, one shop and one bill of 2 pieces.
-- Never run against the live project. (Supabase's own roles and auth schema, the parts schema.sql uses.)
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE SCHEMA auth;
CREATE TABLE auth.users (id uuid PRIMARY KEY, email text, raw_user_meta_data jsonb DEFAULT '{}'::jsonb, created_at timestamptz DEFAULT now());
CREATE TABLE auth.identities (id uuid DEFAULT gen_random_uuid() PRIMARY KEY, user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE, provider text, email text);
CREATE TABLE auth.sessions (id uuid DEFAULT gen_random_uuid() PRIMARY KEY, user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT '{}'::jsonb $$;
GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.uid(), auth.jwt() TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
CREATE PUBLICATION supabase_realtime;

\i ../../schema.sql

-- the shop (onboarded) and its product
INSERT INTO auth.users (id, email) VALUES ('11111111-1111-1111-1111-111111111111', 'race@shop.test');
UPDATE public.hangtag_profiles SET shop_name = 'Race', full_name = 'X', business_type = 'retail', onboarded_at = NOW() WHERE id = '11111111-1111-1111-1111-111111111111';
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false), set_config('request.headers', '{"authorization":"Bearer x"}', false);
INSERT INTO public.hangtag_products (id, name, price, options) VALUES ('tee', 'Tee', 100, '{"opts":[]}');
INSERT INTO public.hangtag_variants (id, product_id, option_values) VALUES ('tee:', 'tee', '[]');
-- one bill: 2 pieces at 100, paid in cash
SELECT public.hangtag_save_sales('[{"sale":{"id":"s1","timestamp":1790000000000,"subtotal":200,"total":200,"payment_method":"cash","device_id":"d1","bill_no":"INV-1","kind":"sale"},
  "items":[{"line_no":0,"product_id":"tee","variant_id":"tee:","product_name":"Tee","quantity":2,"unit_price":100,"line_total":200}],
  "payments":[{"id":"s1:cash","method":"cash","amount":200}]}]'::jsonb);
RESET ROLE;
