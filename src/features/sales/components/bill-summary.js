// The money rows of a bill — discounts, taxable amount, GST (CGST + SGST or IGST), round off — shared by the bill and
// the payment screen. Figures come from the totals (features/sales/services/totals.js); nothing is worked out here.
import { discountLabel, normalizeDiscount } from '../../../domain/sales/discounts.js';
import { esc } from '../../../shared/dom.js';
import { inrx } from '../../../shared/formatting/money.js';

const pct=r=>String(Math.round(r*100)/100);
export const sumRow=(l,r,cls,attr)=>`<div class="row${cls?" "+cls:""}"${attr||""}><span>${l}</span><span class="tnum">${r}</span></div>`;
/* Line and bill discounts taken off (nothing when there are none) */
export function discountRowsHTML(T,billDisc){
  const d=normalizeDiscount(billDisc);
  return (T.itemDisc?sumRow("Item discounts","−"+inrx(T.itemDisc),"disc"):"")+(T.billDisc?sumRow(`Bill discount${d&&d.type==="percent"?" "+esc(discountLabel(d)):""}`,"−"+inrx(T.billDisc),"disc"):"");
}
/* Taxable amount and the GST on it; "Not charged" when the shop has GST switched off */
export function gstRowsHTML(T){
  if(T.mode==="none") return sumRow("GST","Not charged","muted");
  const inc=T.incl?" <small>(in prices)</small>":"", one=T.rate!=null&&T.rate>0, r=f=>one?" "+pct(T.rate*f)+"%":"";
  let h=sumRow("Taxable amount",inrx(T.taxable),"muted");
  if(T.mode==="inter") h+=sumRow(`IGST${r(1)}${inc}`,inrx(T.igst),"taxrow");
  else h+=sumRow(`CGST${r(.5)}${inc}`,inrx(T.cgst),"taxrow")+sumRow(`SGST${r(.5)}${inc}`,inrx(T.sgst),"taxrow");
  return h;
}
export const roundRowHTML=T=>T.roundOff?sumRow("Round off",(T.roundOff>0?"+":"")+inrx(T.roundOff),"muted"):"";
