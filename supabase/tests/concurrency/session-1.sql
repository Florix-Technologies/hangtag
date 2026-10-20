-- Session 1: returns both pieces of bill s1's line, and keeps its transaction open 5 s before committing.
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false), set_config('request.headers', '{"authorization":"Bearer x"}', false);
BEGIN;
SELECT public.hangtag_save_return(
  '{"id":"r1","sale_id":"s1","t":1790000001000,"kind":"return","refund_amount":200,"refund_method":"cash","value":200,"device_id":"d1"}'::jsonb,
  '[{"return_id":"r1","line_no":0,"sale_id":"s1","sale_line_no":0,"variant_id":"tee:","product_id":"tee","product_name":"Tee","quantity":2,"unit_price":100,"value":200,"restock":true}]'::jsonb);
SELECT pg_sleep(5);
COMMIT;
\echo session 1 committed
