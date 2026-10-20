-- Session 2: the same two pieces of the same line, while session 1's transaction is still open. With the post-repair
-- migration it waits for session 1 and is then refused; without it, it gets through (the race).
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false), set_config('request.headers', '{"authorization":"Bearer x"}', false);
SELECT public.hangtag_save_return(
  '{"id":"r2","sale_id":"s1","t":1790000002000,"kind":"return","refund_amount":200,"refund_method":"cash","value":200,"device_id":"d2"}'::jsonb,
  '[{"return_id":"r2","line_no":0,"sale_id":"s1","sale_line_no":0,"variant_id":"tee:","product_id":"tee","product_name":"Tee","quantity":2,"unit_price":100,"value":200,"restock":true}]'::jsonb);
\echo session 2 done
