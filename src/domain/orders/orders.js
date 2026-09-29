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
import { formatInvoiceNo } from '../sales/sale.js';
import { tooPrecise } from '../sales/paise.js';

export const ORDER_KINDS=["quote","sales","table"];
export const KIND_LABELS={quote:"Quotation",sales:"Sales order",table:"Table order"};
export const ORDER_STATUSES={
  quote:["draft","sent","accepted","expired","cancelled","converted"],
  sales:["draft","confirmed","partial","completed","cancelled"],
  table:["new","accepted","preparing","ready","served","cancelled"],
};
export const STATUS_LABELS={draft:"Draft",sent:"Sent",accepted:"Accepted",expired:"Expired",cancelled:"Cancelled",converted:"Converted",
  confirmed:"Confirmed",partial:"Partly delivered",completed:"Completed",new:"New",preparing:"Preparing",ready:"Ready",served:"Served"};
/* Where each status may go next (the same moves as the database's hangtag_order_next_ok) */
export const ORDER_NEXT={
  quote:{draft:["sent","accepted","cancelled","converted","expired"],sent:["draft","accepted","cancelled","converted","expired"],accepted:["converted","cancelled"],
    expired:["draft","sent","cancelled"],cancelled:[],converted:[]},
  sales:{draft:["confirmed","partial","completed","cancelled"],confirmed:["partial","completed","cancelled"],partial:["completed","cancelled"],completed:[],cancelled:[]},
  table:{new:["accepted","preparing","cancelled"],accepted:["preparing","ready","served","cancelled"],preparing:["ready","served","cancelled"],ready:["served","cancelled"],served:[],cancelled:[]},
};
export const FIRST_STATUS={quote:"draft",sales:"draft",table:"new"};
export const FINAL={quote:["cancelled","converted"],sales:["completed","cancelled"],table:["served","cancelled"]};
/* Numbers: QT-260929-001, SO-260929-001, KOT-260929-001 (own series per kind; batch T1's device-scoped series takes over
   the running number when present) */
export const ORDER_PREFIX={quote:"QT-",sales:"SO-",table:"KOT-"};
export const orderNo=(kind,t,seq)=>formatInvoiceNo(ORDER_PREFIX[kind]||"OR-",t,seq);

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
    const q=+l.q, p=+l.price;
    if(!qtyOk(q)) return {error:`${l.name}: enter a quantity above 0 (at most 3 decimals).`,field:"qty",line:i};
    if(!(Number.isFinite(p)&&p>=0)||tooPrecise(p)) return {error:`${l.name}: enter a price of 0 or more (at most 2 decimals).`,field:"price",line:i};
    if(+l.fq>q) return {error:`${l.name}: ${l.fq} already delivered, so the quantity can't be less.`,field:"qty",line:i};
  }
  const bad=checkBillDiscounts(items.map(l=>({name:l.name,q:+l.q,price:+l.price,disc:l.disc})),o.billDisc);
  if(bad) return {error:bad.error,field:bad.line==null?"billDisc":"disc",line:bad.line};
  if(o.validUntil&&!/^\d{4}-\d{2}-\d{2}$/.test(o.validUntil)) return {error:"Enter the validity date as a date.",field:"validUntil"};
  if(String(o.notes||"").length>500) return {error:"Notes can be at most 500 characters.",field:"notes"};
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
  if(isFinal(o)) return `This ${KIND_LABELS[o.kind].toLowerCase()} is ${STATUS_LABELS[o.status].toLowerCase()}.`;
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
  if(isFinal(q)) return {error:`This quotation is ${STATUS_LABELS[q.status].toLowerCase()}.`};
  const order={id,kind:"sales",no,status:"confirmed",cust:q.cust?{...q.cust}:null,billDisc:q.billDisc?{...q.billDisc}:null,
    notes:[q.notes,q.no?"From quotation "+q.no:""].filter(Boolean).join("\n").slice(0,500),validUntil:"",source:"staff",convertedTo:null,saleIds:[],
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
    lines.push({v:l.v,p:l.p,name:l.name,vl:l.vl||"",q,price:+l.price,...(d?{disc:d}:{}),ord:o.id,oln:l.ln,...(q<remaining(l)?{short:remaining(l)-q}:{})});
  });
  return {lines,skipped};
}
/* The order lines a bill delivered: { [order line no]: quantity } for the bill's lines that came from this order */
export function soldFromOrder(sale,orderId){
  const out={};
  (sale.items||[]).forEach(i=>{ if(i.ord===orderId&&i.oln!=null) out[i.oln]=(out[i.oln]||0)+(+i.q||0); });
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
