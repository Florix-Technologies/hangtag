// Quantity rules for bill lines and the product picker. Pure.

/* A typed quantity → { q } when it is a whole number from 1 to max (the pieces in stock), otherwise { error } (a
   message for the person) and, when there is a usable nearest value, q: that value (e.g. the stock left). */
export function checkQty(raw, max){
  const t = String(raw == null ? "" : raw).trim();
  if(!/^\d+$/.test(t)) return { error: "Enter a whole number of pieces, 1 or more." };
  const q = Number(t);
  if(q < 1) return { error: "Enter 1 or more. To take it off the bill, tap Remove." };
  if(max != null && q > max) return max > 0 ? { error: `Only ${max} in stock.`, q: max } : { error: "That one is sold out." };
  return { q };
}
