// Bill totals, in this order: subtotal → line discounts → bill discount (shared over the lines) → GST on what is left
// → round off to the whole rupee. The one place bill money is worked out: the bill, the payment screen, the saved bill
// and the receipt all come from here. Pure and deterministic; rupees in and out, worked in paise.
import { allocate, discountPaise } from './discounts.js';
import { GST_MODES, lineTax, taxBreakdown } from './gst.js';
import { linePaise, sumP, toRupees as R } from './paise.js';

/* lines: [{ q, price, disc? (line discount), rate? (GST %) }] · billDisc: the bill discount · gst: { mode, inclusive }
   (mode from gst.js placeOfSupply). Returns rupees:
   { lines: [{ gross, itemDisc, billDisc, net, taxable, rate, cgst, sgst, igst, tax, total }],
     sub, itemDisc, billDisc, disc, taxable, cgst, sgst, igst, tax, exact, roundOff, total,
     rate (the one rate on the bill, null when rates differ), incl, mode, breakdown: [{ rate, taxable, cgst, sgst, igst, tax }] } */
export function computeCheckout({lines,billDisc,gst}){
  const g={mode:(gst&&gst.mode)||GST_MODES.NONE,inclusive:!!(gst&&gst.inclusive)};
  const L=(lines||[]).map(l=>{const gross=linePaise(l.q,l.price),itemDisc=discountPaise(l.disc,gross);return {gross,itemDisc,after:gross-itemDisc,rate:l.rate}});
  const bd=discountPaise(billDisc,sumP(L.map(x=>x.after)));
  const shares=allocate(bd,L.map(x=>x.after));
  const P=L.map((x,i)=>{const net=x.after-shares[i];return {gross:x.gross,itemDisc:x.itemDisc,billDisc:shares[i],net,...lineTax(net,x.rate,g)}});
  const S=k=>sumP(P.map(x=>x[k]));
  const exact=S("total"), total=Math.round(exact/100)*100;
  const rates=[...new Set(P.filter(x=>x.gross>0).map(x=>x.rate))];
  return {
    lines:P.map(x=>({gross:R(x.gross),itemDisc:R(x.itemDisc),billDisc:R(x.billDisc),net:R(x.net),taxable:R(x.taxable),rate:x.rate,
      cgst:R(x.cgst),sgst:R(x.sgst),igst:R(x.igst),tax:R(x.tax),total:R(x.total)})),
    sub:R(S("gross")),itemDisc:R(S("itemDisc")),billDisc:R(bd),disc:R(S("itemDisc")+bd),
    taxable:R(S("taxable")),cgst:R(S("cgst")),sgst:R(S("sgst")),igst:R(S("igst")),tax:R(S("tax")),
    exact:R(exact),roundOff:R(total-exact),total:R(total),
    rate:rates.length>1?null:(rates[0]||0),incl:g.inclusive,mode:g.mode,
    breakdown:taxBreakdown(P).map(b=>({rate:b.rate,taxable:R(b.taxable),cgst:R(b.cgst),sgst:R(b.sgst),igst:R(b.igst),tax:R(b.tax)})),
  };
}
