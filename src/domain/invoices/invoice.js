// Invoices: a finalized bill as a document — seller, buyer, lines, discounts, GST, round off, total, payments.
// Built only from what the bill saved when the sale completed (domain/sales/checkout-totals.js worked it out then);
// nothing is recalculated here. The receipt, the A4 invoice, the thermal print and the messages to the customer all
// read this one model. Pure.
import { lineLabel } from '../catalog/options.js';
import { discountLabel, normalizeDiscount } from '../sales/discounts.js';
import { gstinState, saleGstSplit, stateCode, stateName } from '../sales/gst.js';
import { linePaise, round2, sumP, toPaise, toRupees } from '../sales/paise.js';
import { qtyText, roundQty, unitOf } from '../catalog/units.js';
import { PAY_LABELS, paymentsOf } from '../sales/payments.js';
import { amountInWords } from './amount-words.js';

export const INVOICE_STATUS={VALID:"valid",CANCELLED:"cancelled"};

/* The shop profile (hangtag_profiles) as the seller block */
export function sellerOf(profile){
  const p=profile||{}, gstin=String(p.gstin||"").toUpperCase(), code=gstinState(gstin)||stateCode(p.state);
  return {name:p.shop_name||"My shop",address:[p.address,p.city,p.state].filter(Boolean).join(", "),phone:p.phone||"",gstin,
    stateCode:code,stateName:code?stateName(code):(p.state||"")};
}
/* sale: the saved bill (with void set when cancelled). ctx: { profile (the shop), customer (the saved customer record: its
   email and mobile are where the bill can be sent), returns (returns and exchanges of this bill), footer, logo (data URL) }
   The buyer's GSTIN and type are the ones the bill was made with: editing the customer later never changes an invoice. */
export function buildInvoice(sale,ctx={}){
  const seller=sellerOf(ctx.profile), G=saleGstSplit(sale), tax=sale.tax||0, c=sale.cust, cr=ctx.customer||{};
  const lineTax=sale.items.length>0&&sale.items.every(i=>i.lt!=null);
  const lines=sale.items.map((i,k)=>{const d=normalizeDiscount(i.disc);return {sl:k+1,ln:i.ln!=null?i.ln:k,name:i.n,variant:lineLabel(i),sku:i.sku||"",hsn:i.hsn||"",
    // the serial numbers of the pieces sold, and the batches they came from (printed under the item)
    serials:Array.isArray(i.sn)?i.sn.join(", "):"",batch:Array.isArray(i.bt)?i.bt.map(b=>b.b).join(", "):"",
    // qty: the number; unit: its symbol ("kg"; "" for pieces); qtyText: both, as printed ("2.5 kg", "3")
    qty:roundQty(i.q),unit:unitOf(i.u).id==="pcs"?"":unitOf(i.u).sym,uqc:unitOf(i.u).uqc,qtyText:qtyText(i.q,i.u),rate:i.price,gross:toRupees(linePaise(i.q,i.price)),discount:i.dAmt||0,discountLabel:d?discountLabel(d):"",billDiscount:i.bdAmt||0,
    taxable:i.tx==null?null:i.tx,gstRate:i.gst==null?null:i.gst,cgst:i.cgst||0,sgst:i.sgst||0,igst:i.igst||0,total:i.lt==null?null:i.lt}});
  const credit=sale.credit||0, due=Math.max(0,round2(sale.total-credit)), roundOff=sale.roundOff||0;
  const itemDiscount=sale.itemDisc||0, billDisc=normalizeDiscount(sale.billDisc);
  const pays=paymentsOf(sale).map(p=>({method:p.method,label:PAY_LABELS[p.method]||p.method,amount:p.amount,ref:p.ref||"",
    received:p.method==="cash"?(p.received==null?round2(p.amount+(p.change||0)):p.received):null,change:p.change||0,verification:p.verification||"recorded",last4:p.last4||""}));
  const paid=toRupees(sumP(pays.map(p=>toPaise(p.amount))));
  const rets=(ctx.returns||[]).map(r=>({id:r.id,kind:r.kind||"return",t:r.t,value:r.value||0,refund:r.refund||0,method:r.pay||"",
    label:PAY_LABELS[r.pay]||r.pay||"",items:(r.items||[]).map(i=>({name:i.n,variant:lineLabel(i),qty:roundQty(i.q),qtyText:qtyText(i.q,i.u)}))}));
  const buyer=c&&c.name?{name:c.name,phone:c.phone||cr.phone||"",email:cr.email||"",mobile:cr.phone||"",gstin:c.gstin||"",
    business:c.type==="business"}:null;
  const pos=sale.gst&&sale.gst.pos||"";
  return {
    number:sale.no||"",saleId:sale.id,t:sale.t,kind:sale.kind==="exchange"?"exchange":"sale",
    status:sale.void?INVOICE_STATUS.CANCELLED:INVOICE_STATUS.VALID,title:tax>0?"Tax Invoice":"Invoice",
    seller,buyer,placeOfSupply:pos?{code:pos,name:stateName(pos)}:null,gstMode:G.mode,inclusive:sale.taxIncl!==false,
    lines,lineTax,taxSummary:taxSummary(sale,lines,lineTax,G),
    totals:{subtotal:sale.sub,itemDiscount,billDiscount:sale.billDiscAmt!=null?sale.billDiscAmt:round2((sale.disc||0)-itemDiscount),
      billDiscountLabel:billDisc&&billDisc.type==="percent"?discountLabel(billDisc):"",discount:sale.disc||0,
      taxable:sale.taxable!=null?sale.taxable:round2(sale.total-tax-roundOff),cgst:G.cgst,sgst:G.sgst,igst:G.igst,tax,
      rate:sale.taxRate||0,roundOff,total:sale.total,credit,due},
    payments:pays,paid,received:toRupees(sumP(pays.map(p=>toPaise(p.received==null?p.amount:p.received)))),
    change:toRupees(sumP(pays.map(p=>toPaise(p.change)))),balance:Math.max(0,toRupees(toPaise(due)-toPaise(paid))),
    returns:rets,returned:toRupees(sumP(rets.map(r=>toPaise(r.value)))),refunded:toRupees(sumP(rets.map(r=>toPaise(r.refund)))),
    amountInWords:amountInWords(sale.total),footer:ctx.footer||"",logo:ctx.logo||"",logoAlign:ctx.logoAlign||"",
  };
}
/* GST by rate: the saved lines added up by rate; bills saved before line GST was kept show their bill totals as one row */
function taxSummary(sale,lines,lineTax,G){
  if(!(sale.tax>0)) return [];
  if(!lineTax) return [{rate:sale.taxRate||null,taxable:sale.taxable!=null?sale.taxable:round2(sale.total-sale.tax-(sale.roundOff||0)),cgst:G.cgst,sgst:G.sgst,igst:G.igst,tax:sale.tax}];
  const by={};
  lines.forEach(l=>{ if(!(l.cgst||l.sgst||l.igst)) return; const o=by[l.gstRate]||(by[l.gstRate]={rate:l.gstRate,taxable:0,cgst:0,sgst:0,igst:0});
    o.taxable+=toPaise(l.taxable);o.cgst+=toPaise(l.cgst);o.sgst+=toPaise(l.sgst);o.igst+=toPaise(l.igst); });
  return Object.values(by).sort((a,b)=>a.rate-b.rate).map(o=>({rate:o.rate,taxable:toRupees(o.taxable),cgst:toRupees(o.cgst),sgst:toRupees(o.sgst),igst:toRupees(o.igst),tax:toRupees(o.cgst+o.sgst+o.igst)}));
}
/* GST lines for a total block: CGST + SGST, or IGST, with the rate when the whole bill has one → [{ label, amount }] */
export function gstLines(inv){
  const T=inv.totals; if(!(T.tax>0)) return [];
  const one=inv.taxSummary.length===1&&inv.taxSummary[0].rate?inv.taxSummary[0].rate:(T.rate||0);
  const r=f=>one?" "+Math.round(one*f*100)/100+"%":"";
  return inv.gstMode==="inter"?[{label:"IGST"+r(1),amount:T.igst}]:[{label:"CGST"+r(.5),amount:T.cgst},{label:"SGST"+r(.5),amount:T.sgst}];
}
/* A valid (not cancelled) invoice can be printed as a bill and sent to the customer */
export const isValidInvoice=inv=>inv.status===INVOICE_STATUS.VALID;
