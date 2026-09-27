// Add, change or remove a discount on one bill line or on the whole bill. Rules: domain/sales/discounts.js.
import { checkBillDiscounts, checkDiscount, normalizeDiscount } from '../../../domain/sales/discounts.js';
import { toPaise } from '../../../domain/sales/paise.js';
import { store } from '../../../shared/state/store.js';
import { saveCart } from '../../../shared/state/persistence.js';

/* Line i: input { type: "percent" | "fixed", value } — an empty value removes the discount.
   → { ok: true } or { error } (nothing changes) */
export function setLineDiscount(i,input){
  const c=store.cart[i]; if(!c) return {error:"That line is no longer on the bill."};
  const err=checkDiscount(input,toPaise(c.q*c.price)); if(err) return err;
  const d=normalizeDiscount(input);
  if(d) c.disc=d; else delete c.disc;
  saveCart(); return {ok:true};
}
/* The bill discount box, as typed ({ type, value }). It is kept even when it doesn't fit the bill, so the box keeps
   what was typed; the bill shows why, and payment waits until it's fixed. → { ok: true } or { error } */
export function setBillDiscount(input){
  store.disc=input?{type:input.type==="percent"?"percent":"fixed",value:input.value==null?"":input.value}:null;
  saveCart();
  const bad=checkBillDiscounts(store.cart,store.disc);
  return bad?{error:bad.error}:{ok:true};
}
/* The first discount problem on the bill being rung up, or "" */
export const billDiscountError=()=>{const bad=checkBillDiscounts(store.cart,store.disc);return bad?bad.error:""};
