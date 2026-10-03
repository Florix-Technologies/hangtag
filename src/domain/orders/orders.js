// Orders: ONE engine for quotations, sales orders and (later) table orders. An order is a list of lines (product, variant,
// quantity, price, discount, GST rate as agreed) for a customer, with a status. Orders never change stock: only the bill
// made from one does (the order's lines go on the bill at the order's prices, then the existing checkout).
//   quote:  draft → sent → accepted → converted (to a sales order, or straight to a bill); cancelled; expired (shown when
//           its validity date has passed while still a draft or sent)
//   sales:  draft → confirmed → partial (some delivered on a bill) → completed; cancelled
//   table:  new → accepted → preparing → ready → served; cancelled (restaurant batch)
// The database repeats the kinds, statuses and moves (supabase/schema.sql section 3m hangtag_order_next_ok) and saves an
// order only if nobody changed it meanwhile (its version). Totals come from computeCheckout, the one bill calculation.
// Pure; rupees in and out.
import { computeCheckout } from '../sales/checkout-totals.js';
import { checkBillDiscounts, normalizeDiscount } from '../sales/discounts.js';
import { deviceCode, formatInvoiceNo } from '../sales/sale.js';
import { tooPrecise } from '../sales/paise.js';
import { checkQty, unitId } from '../catalog/units.js';
import { mobileE164 } from '../invoices/delivery.js';
import { validEmail } from '../../shared/validation/email.js';

export const ORDER_KINDS=["quote","sales","table"];
export const KIND_LABELS={quote:"Quotation",sales:"Sales order",table:"Table order"};
export const ORDER_STATUSES={
  quote:["draft","sent","accepted","expired","cancelled","converted"],
  sales:["draft","confirmed","partial","completed","cancelled"],
  table:["new","accepted","preparing","ready","served","cancelled"],
};
export const STATUS_LABELS={draft:"Draft",sent:"Sent",accepted:"Accepted",expired:"Expired",cancelled:"Cancelled",converted:"Converted",
  confirmed:"Confirmed",partial:"Partly delivered",completed:"Completed",new:"New",preparing:"Preparing",ready:"Ready",served:"Served"};
export const statusLabel=(kind,status)=>kind==="sales"&&status==="draft"?"Pending":kind==="sales"&&status==="partial"?"Partly fulfilled":kind==="sales"&&status==="completed"?"Fulfilled":STATUS_LABELS[status]||status;
/* Where each status may go next (the same moves as the database's hangtag_order_next_ok) */
export const ORDER_NEXT={
  quote:{draft:["sent","accepted","cancelled","converted","expired"],sent:["draft","accepted","cancelled","converted","expired"],accepted:["converted","cancelled"],
    expired:["draft","sent","cancelled"],cancelled:[],converted:[]},
  sales:{draft:["confirmed","partial","completed","cancelled"],confirmed:["partial","completed","cancelled"],partial:["completed","cancelled"],completed:[],cancelled:[]},
  table:{new:["accepted","preparing","cancelled"],accepted:["preparing","ready","served","cancelled"],preparing:["ready","served","cancelled"],ready:["served","cancelled"],served:[],cancelled:[]},
};
export const FIRST_STATUS={quote:"draft",sales:"draft",table:"new"};
export const FINAL={quote:["cancelled","converted"],sales:["completed","cancelled"],table:["served","cancelled"]};
/* Numbers: QT-260929-K3F001, SO-…, KOT-… — T1's device-scoped series (domain/sales/sale.js): the prefix, the date (yymmdd),
   this device's code and its running number of that kind that day, so two tills offline never make the same number. */
export const ORDER_PREFIX={quote:"QT-",sales:"SO-",table:"KOT-"};
/* A quotation's number prefix from the shop's quotation settings ("QT" → "QT-"; empty: the default) */
export const quotePrefix=p=>{const x=String(p||"").trim();return !x?ORDER_PREFIX.quote:/[-/]$/.test(x)?x:x+"-"};
export const orderDeviceCode=deviceCode;
export const orderNo=(kind,t,seq,dev)=>formatInvoiceNo(ORDER_PREFIX[kind]||"OR-",t,seq,dev);

export const canMove=(kind,from,to)=>from===to||!!(ORDER_NEXT[kind]&&(ORDER_NEXT[kind][from]||[]).includes(to));
export const isFinal=o=>!!o&&(FINAL[o.kind]||[]).includes(o.status);
/* A quotation past its validity date (still a draft or sent): shown and treated as expired. today: "yyyy-mm-dd" */
export const isExpired=(o,today)=>!!o&&o.kind==="quote"&&(o.status==="expired"||(["draft","sent"].includes(o.status)&&!!o.validUntil&&o.validUntil<today));
export const shownStatus=(o,today)=>isExpired(o,today)?"expired":o.status;
/* The statuses a person may choose next in the editor (the current one first) */
export const nextStatuses=o=>[o.status,...((ORDER_NEXT[o.kind]||{})[o.status]||[]).filter(s=>s!=="converted"&&s!=="partial"&&s!=="completed")];

const qtyOk=q=>Number.isFinite(q)&&q>0&&Math.abs(q*1000-Math.round(q*1000))<1e-6;
/* The first problem with an order before it is saved → { error, field, line? } or null.
   A quotation and a sales order are for a saved customer; every line has a name, a quantity above 0 (at most 3
   decimals), a price of 0 or more (at most 2 decimals) and a discount that fits; the bill discount fits too. */
export function checkOrder(o){
  if(!o||!ORDER_KINDS.includes(o.kind)) return {error:"Unknown kind of order.",field:"kind"};
  if(!(ORDER_STATUSES[o.kind]||[]).includes(o.status)) return {error:"Unknown status.",field:"status"};
  if(o.kind!=="table"&&!(o.cust&&o.cust.id&&o.cust.name)) return {error:"Choose the customer.",field:"customer"};
  const items=o.items||[];
  if(!items.length) return {error:"Add at least one item.",field:"items"};
  for(const [i,l] of items.entries()){
    if(!String(l.name||"").trim()) return {error:"A line has no name.",field:"items",line:i};
    const q=+l.q, p=+l.price, qr=checkQty(l.q,unitId(l.u));
    if(qr.error||!qtyOk(q)) return {error:`${l.name}: ${qr.error||"enter a quantity above 0 (at most 3 decimals)."}`,field:"qty",line:i};
    if(!(Number.isFinite(p)&&p>=0)||tooPrecise(p)) return {error:`${l.name}: enter a price of 0 or more (at most 2 decimals).`,field:"price",line:i};
    if(+l.fq>q) return {error:`${l.name}: ${l.fq} already delivered, so the quantity can't be less.`,field:"qty",line:i};
  }
  const bad=checkBillDiscounts(items.map(l=>({name:l.name,q:+l.q,price:+l.price,disc:l.disc})),o.billDisc);
  if(bad) return {error:bad.error,field:bad.line==null?"billDisc":"disc",line:bad.line};
  if(o.validUntil&&!/^\d{4}-\d{2}-\d{2}$/.test(o.validUntil)) return {error:"Enter the validity date as a date.",field:"validUntil"};
  if(String(o.notes||"").length>500) return {error:"Notes can be at most 500 characters.",field:"notes"};
  if(String(o.terms||"").length>2000) return {error:"Terms can be at most 2,000 characters.",field:"terms"};
  return null;
}
/* The order's figures, from the one bill calculation: gst = { mode, inclusive } (the customer's place of supply) */
export function orderCheckout(o,gst){
  return computeCheckout({lines:(o.items||[]).map(l=>({q:+l.q||0,price:+l.price||0,disc:l.disc,rate:l.gst==null?0:+l.gst})),billDisc:o.billDisc,gst});
}
/* What is still to deliver on a line, and the lines that still have something */
export const remaining=l=>Math.max(0,Math.round(((+l.q||0)-(+l.fq||0))*1000)/1000);
export const openLines=o=>(o.items||[]).filter(l=>remaining(l)>0);
/* Can this order go on a bill now? → null or the reason */
export function cartBlock(o,today){
  if(!o) return "That order isn't on this device.";
  if(o.kind==="table") return "Table orders are billed from their table.";
  if(isExpired(o,today)) return `This quotation expired on ${o.validUntil}. Extend its validity first.`;
  if(isFinal(o)) return `This ${KIND_LABELS[o.kind].toLowerCase()} is ${statusLabel(o.kind,o.status).toLowerCase()}.`;
  if(o.kind==="sales"&&o.status==="draft") return "Confirm the sales order first.";
  if(!openLines(o).length) return "Everything on this order is delivered.";
  return null;
}
/* A quotation turned into a sales order: the same customer, lines (nothing delivered yet), discounts and notes; the
   quotation becomes "converted" and points at it. ids: { id, no, t, dev? }
   → { order, quote } or { error } */
export function convertQuote(q,{id,no,t,dev},today){
  if(!q||q.kind!=="quote") return {error:"Only a quotation can become a sales order."};
  if(isExpired(q,today)) return {error:`This quotation expired on ${q.validUntil}. Extend its validity first.`};
  if(isFinal(q)) return {error:`This quotation is ${statusLabel(q.kind,q.status).toLowerCase()}.`};
  const order={id,kind:"sales",no,status:"draft",cust:q.cust?{...q.cust}:null,billDisc:q.billDisc?{...q.billDisc}:null,
    notes:q.notes||"",terms:q.terms||"",validUntil:"",source:"staff",convertedTo:null,quoteId:q.id,quoteNo:q.no||"",saleIds:[],
    version:0,t,updatedT:t,...(dev?{dev}:{}),items:(q.items||[]).map((l,k)=>({...l,ln:k,fq:0}))};
  return {order,quote:{...q,status:"converted",convertedTo:id,updatedT:t}};
}
/* The order after a bill delivered some of it. sold: { [order line no]: quantity on the bill }. A sales order is
   "completed" when every line is delivered, else "partial"; a quotation billed straight away is "converted" (to the
   bill). Never more than ordered is counted. → the changed order (a copy) */
export function fulfil(o,sold,saleId,t){
  const items=(o.items||[]).map(l=>{const q=+(sold||{})[l.ln]||0;return q>0?{...l,fq:Math.min(+l.q,Math.round(((+l.fq||0)+q)*1000)/1000)}:l;});
  const next={...o,items,saleIds:[...new Set([...(o.saleIds||[]),saleId])],updatedT:t};
  if(o.kind==="sales") next.status=items.every(l=>remaining(l)<=0)?"completed":items.some(l=>+l.fq>0)?"partial":o.status;
  else if(o.kind==="quote"){ next.status="converted"; next.convertedTo=o.convertedTo||saleId; }
  return next;
}
/* The bill lines an order puts in the cart: what is left to deliver, at the order's price and discount, capped by stock.
   avail(variantId) → pieces in stock (null when the variant no longer exists).
   → { lines: [{ v, p, name, vl, q, price, disc?, ord, oln }], skipped: [{ name, why }] } */
export function orderCartLines(o,avail){
  const lines=[], skipped=[];
  openLines(o).forEach(l=>{
    const a=l.v?avail(l.v):null;
    if(a==null){ skipped.push({name:l.name,why:"no longer in the catalog"}); return; }
    const q=Math.min(remaining(l),Math.max(0,a));
    if(!(q>0)){ skipped.push({name:l.name,why:"out of stock"}); return; }
    const d=normalizeDiscount(l.disc);
    lines.push({v:l.v,p:l.p,name:l.name,vl:l.vl||"",q,price:+l.price,...(l.u&&l.u!=="pcs"?{u:l.u}:{}),...(l.gst!=null?{gst:+l.gst}:{}),...(d?{disc:d}:{}),ord:o.id,oln:l.ln,...(q<remaining(l)?{short:remaining(l)-q}:{})});
  });
  return {lines,skipped};
}
/* Fulfilling a sales order now, line by line: what is ordered, already delivered, still to deliver, what can go out now
   (stock allows) and what then stays for later. avail(variant id) → pieces that can be sold now (null: not in the catalog).
   The remaining quantity is tracked by the order itself — nobody makes a separate backorder.
   → { lines: [{ ln, name, vl, u, ordered, delivered, remaining, now, later }], now, later, canFulfil } */
export function fulfilmentPlan(o,avail){
  const lines=(o&&o.items||[]).map(l=>{
    const rem=remaining(l), a=l.v?avail(l.v):null, now=a==null?0:Math.max(0,Math.min(rem,Math.floor(a*1000+1e-6)/1000));
    return {ln:l.ln,name:l.name,vl:l.vl||"",u:l.u||"pcs",ordered:+l.q||0,delivered:+l.fq||0,remaining:rem,now,later:Math.round((rem-now)*1000)/1000};
  });
  const sum=k=>Math.round(lines.reduce((a,l)=>a+l[k],0)*1000)/1000;
  return {lines,now:sum("now"),later:sum("later"),canFulfil:lines.some(l=>l.now>0)};
}
/* What the customer sees (never ERP words): Confirmed → Partially ready → Ready (everything handed over, payment still at
   the counter) → Completed (handed over and paid); Cancelled */
export const CUSTOMER_LABELS={received:"Received",confirmed:"Confirmed",partial:"Partially ready",ready:"Ready",completed:"Completed",cancelled:"Cancelled"};
export function customerStage(o,{paid}={}){
  if(!o) return "received";
  if(o.status==="cancelled") return "cancelled";
  const items=o.items||[], all=items.length>0&&items.every(l=>remaining(l)<=0), some=items.some(l=>+l.fq>0);
  if(all||o.status==="completed") return paid?"completed":"ready";
  if(some||o.status==="partial") return "partial";
  return o.status==="draft"?"received":"confirmed";
}
/* The order lines a bill delivered: { [order line no]: quantity } for the bill's lines that came from this order */
export function soldFromOrder(sale,orderId){
  const out={}, kits=new Set();
  (sale.items||[]).forEach(i=>{
    if(i.ord!==orderId||i.oln==null) return;
    // a kit's items (domain/catalog/bundles.js) deliver the kit: counted once, as the number of kits
    if(i.kit&&typeof i.kit==="object"){ if(!kits.has(i.oln)){ kits.add(i.oln); out[i.oln]=(out[i.oln]||0)+(+i.kit.n||0); } return; }
    out[i.oln]=(out[i.oln]||0)+(+i.q||0);
  });
  return out;
}

/* ---------- held carts: a bill put aside to finish later (never touches stock) ---------- */
/* A name for a held bill: the customer's, else "Bill 14:05" */
export const heldName=(cust,label)=>String(cust&&cust.name||label||"Bill").trim().slice(0,60)||"Bill";
/* → null or the reason it can't be held */
export function checkHold(cart,name){
  if(!Array.isArray(cart)||!cart.length) return "There's nothing on the bill to hold.";
  const n=String(name==null?"":name).trim();
  if(!n) return "Give the bill a name (e.g. the customer's).";
  if(n.length>60) return "Keep the name to 60 characters.";
  return null;
}

/* ---------- sending a quotation to its customer ---------- */
/* Quotations go by email or WhatsApp (through the server's providers), or as a PDF shared from the phone */
export const QUOTE_CHANNELS={email:"Email",whatsapp:"WhatsApp"};
export const QUOTE_SEND_LABELS={queued:"Queued",sending:"Sending…",sent:"Sent",delivered:"Delivered",failed:"Failed"};
/* Where a quotation would go on a channel, from its customer as saved in Customers (cust: { name, email, phone }) →
   { to } or { error } (a reason written for the shop) */
export function quoteTarget(cust,channel){
  if(!QUOTE_CHANNELS[channel]) return {error:"Choose email or WhatsApp."};
  if(!cust||!cust.name) return {error:"Choose the quotation's customer first."};
  if(channel==="email"){
    const e=String(cust.email||"").trim();
    return e&&validEmail(e)?{to:e}:{error:`${cust.name} has no email address. Add one in Customers to email the quotation.`};
  }
  const m=mobileE164(cust.phone);
  return m?{to:m}:{error:`${cust.name} has no mobile number${cust.phone?" that can get messages":""} in Customers. Add one there to send by WhatsApp.`};
}
