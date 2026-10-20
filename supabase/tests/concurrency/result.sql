-- How many pieces of bill s1's line came back (2 were bought). ok: never more than bought.
SELECT COALESCE(sum(quantity), 0) AS returned, COALESCE(sum(quantity), 0) <= 2 AS ok
  FROM public.hangtag_return_items WHERE sale_id = 's1' AND sale_line_no = 0;
