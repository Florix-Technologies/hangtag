// Suppliers and purchases (a supplier's invoice entered line by line). A purchase adds stock only through its stock-in
// records (RESTOCK, pointing at the purchase, with the cost per piece); stock is never kept as a number. Money in rupees
// with at most 2 decimals, added up in paise. What a supplier is owed is worked out from the purchases (total − paid at the
// time) and the later payments (a reversal takes one back); a cancelled purchase is owed nothing. Cash paid out of the
// drawer is a cash book "Cash out" entry: the database adds it (pur:<purchase>, spay:<payment>) and the phone shows the same
// entry at once under the same id. Pure.
//   Serial numbers and batches (domain/inventory/tracking.js): a line of a product tracked by serial number carries
//   `serials` (one per piece), one tracked by batch `batch` ({ no, exp }); its stock-in record carries them (sn / b, exp),
//   so they come into stock, and leave it again when the purchase is cancelled, with the same records as the stock.
import { toPaise, toRupees, tooPrecise } from '../sales/paise.js';
import { validEmail } from '../../shared/validation/email.js';
import { validGstin } from '../../shared/validation/gstin.js';
import { validPhone } from '../../shared/validation/phone.js';
import { checkBatchNo, checkExpiry, incomingSerialError, normSerial, validSerial } from './tracking.js';

export const PURCHASE_METHODS=["cash","upi","card","bank","cheque"];
export const PURCHASE_METHOD_LABELS={cash:"Cash",upi:"UPI",card:"Card",bank:"Bank transfer",cheque:"Cheque"};
export const MAX_CASH_PAID=1000000;   // one cash book entry (hangtag_cash_moves.amount)
export const MAX_PURCHASE_LINES=200;
const clean=(s,max)=>String(s==null?"":s).replace(/[\u0000-\u001f\u007f]/g," ").trim().replace(/\s+/g," ").slice(0,max||500);
const num=v=>{const t=String(v==null?"":v).trim().replace(/[₹,\s]/g,"");return t===""?null:Number(t)};

/* ---------- suppliers ---------- */
/* input: { id, name, phone, email, address, gstin, notes, active } · others: the shop's suppliers (duplicates by name / GSTIN)
   → { error, field } or { supplier } (cleaned; the id is kept) */
export function checkSupplier(input,others=[]){
  const s=input||{}, name=clean(s.name,120);
  if(!name) return {error:"Enter the supplier's name.",field:"name"};
  if(name.length>80) return {error:"A supplier's name can be at most 80 characters.",field:"name"};
  const phone=clean(s.phone,40), email=clean(s.email,200), gstin=clean(s.gstin,40).toUpperCase().replace(/\s/g,""), address=clean(s.address,400), notes=String(s.notes==null?"":s.notes).trim();
  if(phone&&(!validPhone(phone)||phone.length>20)) return {error:"Enter a valid phone number (10–15 digits), or leave it empty.",field:"phone"};
  if(email&&(!validEmail(email)||email.length>120)) return {error:"Enter a valid email address, or leave it empty.",field:"email"};
  if(gstin&&!validGstin(gstin)) return {error:"A GSTIN has 15 letters and digits, like 27ABCDE1234F1Z5.",field:"gstin"};
  if(address.length>300) return {error:"The address can be at most 300 characters.",field:"address"};
  if(notes.length>500) return {error:"Notes can be at most 500 characters.",field:"notes"};
  const other=(others||[]).filter(o=>o&&o.id!==s.id);
  const same=other.find(o=>o.active!==false&&clean(o.name).toLowerCase()===name.toLowerCase());
  if(same) return {error:`There's already a supplier called ${same.name}.`,field:"name"};
  const g=gstin&&other.find(o=>o.gstin&&o.gstin.toUpperCase()===gstin);
  if(g) return {error:`${g.name} already has this GSTIN.`,field:"gstin"};
  return {supplier:{id:s.id,name,phone,email,address,gstin,notes,active:s.active!==false}};
}

/* ---------- purchase lines and totals ---------- */
/* One line's money in paise: taxable value = qty × cost per piece (before GST), the GST on it, and the line total */
export function lineMoney({q,cost,gst}){
  const tx=Math.round((+q||0)*toPaise(cost)), tax=Math.round(tx*(+gst||0)/100);
  return {tx,tax,total:tx+tax};
}
/* The first problem with a line (n: its number on the screen), or null. dec: decimals its quantity may have (0: whole pieces) */
export function lineError(l,n){
  const lab=`Line ${n}${l&&l.n?` (${l.n})`:""}`;
  if(!l||!l.v||!l.p) return `${lab}: choose the product.`;
  const q=num(l.q), dec=Math.max(0,Math.min(3,Math.round(+l.dec||0)));
  if(q==null||!Number.isFinite(q)||q<=0) return `${lab}: enter a quantity more than 0.`;
  if(Math.abs(q*10**dec-Math.round(q*10**dec))>1e-6) return dec?`${lab}: use at most ${dec} decimal places.`:`${lab}: the quantity is a whole number of pieces.`;
  if(q>1000000) return `${lab}: that quantity is too large.`;
  const c=num(l.cost);
  if(c==null||!Number.isFinite(c)||c<0) return `${lab}: enter the cost per piece (₹0 or more).`;
  if(tooPrecise(c)) return `${lab}: the cost can have at most 2 decimal places.`;
  const g=num(l.gst==null?"":String(l.gst).replace("%",""));
  if(g!=null&&(!Number.isFinite(g)||g<0||g>100||tooPrecise(g))) return `${lab}: GST % should be between 0 and 100.`;
  return null;
}
/* Totals of lines in rupees: { sub, tax, total, pieces } */
export function purchaseTotals(lines){
  let tx=0,tax=0,pieces=0;
  (lines||[]).forEach(l=>{const m=lineMoney({q:num(l.q)||0,cost:num(l.cost)||0,gst:num(String(l.gst==null?"":l.gst).replace("%",""))||0});tx+=m.tx;tax+=m.tax;pieces+=num(l.q)||0});
  return {sub:toRupees(tx),tax:toRupees(tax),total:toRupees(tx+tax),pieces:Math.round(pieces*1000)/1000};
}
/* A stock-in record's note for a purchase */
export const purchaseNote=(invoiceNo,supplier)=>["Purchase",clean(invoiceNo,40),supplier?"· "+clean(supplier,60):""].filter(Boolean).join(" ").slice(0,200);

/* A line's serial numbers or batch, for how its product is tracked (trk: { tracking, expiry } or none) → error text or null.
   seen: serials already on the purchase · ctx: { serialState(sn), batchOf(vid, b), today } */
export function lineTrackingError(l,n,trk,seen,ctx={}){
  const lab=`Line ${n}${l&&l.n?` (${l.n})`:""}`, t=trk&&trk.tracking;
  if(t==="serial"){
    const sn=Array.isArray(l.serials)?l.serials.map(normSerial):[];
    if(!sn.length) return `${lab}: enter the serial number of each piece.`;
    if(sn.length!==+l.q) return `${lab}: ${+l.q} piece${+l.q===1?"":"s"} but ${sn.length} serial number${sn.length===1?"":"s"}.`;
    const bad=sn.find(x=>!validSerial(x)); if(bad) return `${lab}: "${bad.slice(0,30)}" isn't a serial number.`;
    for(const x of sn){ if(seen.has(x)) return `${lab}: serial ${x} is on this purchase twice.`; seen.add(x); }
    const e=ctx.serialState?incomingSerialError(sn,ctx.serialState):null; if(e) return `${lab}: ${e}`;
  } else if(t==="batch"){
    const b=l.batch&&typeof l.batch==="object"?l.batch:{}, c=checkBatchNo(b.no); if(c.error) return `${lab}: ${c.error}`;
    const known=ctx.batchOf?ctx.batchOf(l.v,c.b):null, x=checkExpiry(b.exp,{required:!!trk.expiry,today:ctx.today,known:known&&known.exp||null});
    if(x.error) return `${lab}: ${x.error}`;
  }
  return null;
}
/* input: { id, supplierId, supplierName, supplierGstin, invoiceNo, invoiceDate ("yyyy-mm-dd"), lines: [{ p, v, n, vl, sku, q, cost, gst,
     dec?, serials?, batch? }], paid, method, note, t, dev }
   ctx: { today ("yyyy-mm-dd"), purchases (this shop's, to spot the same invoice entered twice), allowDuplicate, moveId(i),
     trackingOf(line) ({ tracking, expiry } of its product), serialState(sn), batchOf(vid, b) }
   → { error, field?, duplicate? } or { purchase, moves, totals }. Nothing is changed here. */
export function buildPurchase(input,ctx={}){
  const x=input||{}, lines=(x.lines||[]).filter(l=>l&&!(l.blank&&!l.v));
  if(!x.id) return {error:"The purchase has no id."};
  if(!lines.length) return {error:"Add at least one line: scan or type a code, or pick a product.",field:"lines"};
  if(lines.length>MAX_PURCHASE_LINES) return {error:`A purchase can have up to ${MAX_PURCHASE_LINES} lines.`,field:"lines"};
  for(let i=0;i<lines.length;i++){const e=lineError(lines[i],i+1);if(e)return {error:e,field:"lines",line:i}}
  const seen=new Set(), trkOf=ctx.trackingOf||(()=>null);
  for(let i=0;i<lines.length;i++){const e=lineTrackingError(lines[i],i+1,trkOf(lines[i]),seen,ctx);if(e)return {error:e,field:"lines",line:i}}
  const invoiceNo=clean(x.invoiceNo,60), date=String(x.invoiceDate||"").trim();
  if(invoiceNo.length>40) return {error:"The invoice number can be at most 40 characters.",field:"invoiceNo"};
  if(date&&!/^\d{4}-\d{2}-\d{2}$/.test(date)) return {error:"Enter the invoice date.",field:"invoiceDate"};
  if(date&&ctx.today&&date>ctx.today) return {error:"The invoice date can't be in the future.",field:"invoiceDate"};
  const note=clean(x.note,400); if(note.length>200) return {error:"The note can be at most 200 characters.",field:"note"};
  const priced=lines.map(l=>{
    const q=num(l.q), cost=toRupees(toPaise(num(l.cost))), gst=num(l.gst==null?"":String(l.gst).replace("%",""))||0, m=lineMoney({q,cost,gst});
    const trk=trkOf(l)||{}, bt=trk.tracking==="batch"&&l.batch?checkBatchNo(l.batch.no):null;
    const exp=bt&&bt.b?checkExpiry(l.batch.exp,{known:(ctx.batchOf&&ctx.batchOf(l.v,bt.b)||{}).exp||null}).exp:null;
    return Object.assign({p:l.p,v:l.v,n:clean(l.n,120),vl:clean(l.vl,120),sku:clean(l.sku,64),q,cost,gst,tx:toRupees(m.tx),tax:toRupees(m.tax),total:toRupees(m.total)},
      trk.tracking==="serial"&&Array.isArray(l.serials)&&l.serials.length?{serials:l.serials.map(normSerial)}:{},
      bt&&bt.b?{batch:Object.assign({no:bt.b},exp?{exp}:{})}:{});
  });
  const T=purchaseTotals(lines);
  const paidRaw=num(x.paid), paid=paidRaw==null?0:paidRaw;
  if(!Number.isFinite(paid)||paid<0) return {error:"Enter the amount paid (₹0 or more).",field:"paid"};
  if(tooPrecise(paid)) return {error:"The amount paid can have at most 2 decimal places.",field:"paid"};
  if(toPaise(paid)>toPaise(T.total)) return {error:"More than the purchase total can't be paid on it.",field:"paid"};
  const method=paid>0?String(x.method||""):"";
  if(paid>0&&!PURCHASE_METHODS.includes(method)) return {error:"Choose how it was paid.",field:"method"};
  if(method==="cash"&&paid>MAX_CASH_PAID) return {error:"That much cash is too large for one entry. Pay part of it another way.",field:"paid"};
  const sid=x.supplierId||null;
  if(!sid&&toPaise(paid)<toPaise(T.total)) return {error:"Choose the supplier: part of this purchase is still to be paid.",field:"supplier"};
  if(sid&&invoiceNo&&!ctx.allowDuplicate){
    const d=(ctx.purchases||[]).find(p=>p&&p.id!==x.id&&p.status!=="cancelled"&&p.supplierId===sid&&clean(p.invoiceNo).toLowerCase()===invoiceNo.toLowerCase());
    if(d) return {error:`Invoice ${invoiceNo} from this supplier is already entered${d.invoiceDate?" (dated "+d.invoiceDate+")":""}. Save it again only if it really is a second delivery.`,field:"invoiceNo",duplicate:true};
  }
  const t=+x.t||0, supplier=clean(x.supplierName,80);
  const purchase={id:x.id,kind:"purchase",supplierId:sid,supplier,gstin:clean(x.supplierGstin,20),invoiceNo,invoiceDate:date,t,lines:priced,
    sub:T.sub,tax:T.tax,total:T.total,paid:toRupees(toPaise(paid)),method:method||null,status:"posted",note,dev:x.dev||""};
  const moveId=ctx.moveId||(i=>x.id+":"+i), mnote=purchaseNote(invoiceNo,supplier);
  const moves=priced.map((l,i)=>Object.assign({id:moveId(i),v:l.v,p:l.p,type:"RESTOCK",q:l.q,cost:Math.round(l.cost),note:mnote,t,dev:x.dev||"",imp:x.id},
    l.serials?{sn:l.serials.slice()}:{}, l.batch?{b:l.batch.no,...(l.batch.exp?{exp:l.batch.exp}:{})}:{}));
  return {purchase,moves,totals:T};
}

/* ---------- what is owed ---------- */
const netPaid=pays=>(pays||[]).reduce((a,x)=>a+(x.reverses?-toPaise(x.amount):toPaise(x.amount)),0);
/* Still owed on one purchase, in rupees (0 for a cancelled one): total − paid at the time − later payments for it */
export function purchaseDue(p,payments){
  if(!p||p.status==="cancelled") return 0;
  return toRupees(toPaise(p.total)-toPaise(p.paid)-netPaid((payments||[]).filter(x=>x.purchaseId===p.id)));
}
/* A supplier's account: { purchases (newest first), count, total, paid, outstanding, payments (newest first) }. Cancelled
   purchases are listed but owe nothing; a payment for one still counts as paid to the supplier (an advance). */
export function supplierAccount(supplierId,purchases,payments){
  const ps=(purchases||[]).filter(p=>p&&p.supplierId===supplierId).sort((a,b)=>b.t-a.t);
  const pays=(payments||[]).filter(x=>x&&x.supplierId===supplierId).sort((a,b)=>b.t-a.t);
  const posted=ps.filter(p=>p.status!=="cancelled");
  const total=posted.reduce((a,p)=>a+toPaise(p.total),0), paid=posted.reduce((a,p)=>a+toPaise(p.paid),0)+netPaid(pays);
  return {purchases:ps,count:posted.length,total:toRupees(total),paid:toRupees(paid),outstanding:toRupees(total-paid),payments:pays};
}
/* input: { supplierId, purchaseId?, amount, method, ref, note } · ctx: { purchase (when paying one invoice), payments }
   → { error, field } or { payment: { supplierId, purchaseId, amount, method, ref, note } } */
export function checkSupplierPayment(input,ctx={}){
  const x=input||{};
  if(!x.supplierId) return {error:"Which supplier?",field:"supplier"};
  const a=num(x.amount);
  if(a==null||!Number.isFinite(a)||a<=0) return {error:"Enter an amount more than ₹0.",field:"amount"};
  if(tooPrecise(a)) return {error:"Use at most 2 decimal places.",field:"amount"};
  if(a>100000000) return {error:"That amount is too large.",field:"amount"};
  if(!PURCHASE_METHODS.includes(x.method)) return {error:"Choose how it was paid.",field:"method"};
  if(x.method==="cash"&&a>MAX_CASH_PAID) return {error:"That much cash is too large for one entry.",field:"amount"};
  const p=x.purchaseId?ctx.purchase:null;
  if(x.purchaseId){
    if(!p||p.supplierId!==x.supplierId) return {error:"That purchase isn't from this supplier.",field:"purchase"};
    if(p.status==="cancelled") return {error:"That purchase is cancelled: nothing is owed on it.",field:"purchase"};
    const due=purchaseDue(p,ctx.payments);
    if(toPaise(a)>toPaise(due)) return {error:`Only ₹${due.toLocaleString("en-IN")} is still owed on that invoice.`,field:"amount"};
  }
  const ref=clean(x.ref,80), note=clean(x.note,300);
  if(ref.length>60) return {error:"The reference can be at most 60 characters.",field:"ref"};
  if(note.length>200) return {error:"The note can be at most 200 characters.",field:"note"};
  return {payment:{supplierId:x.supplierId,purchaseId:x.purchaseId||null,amount:toRupees(toPaise(a)),method:x.method,ref,note}};
}
/* Reversing a payment made by mistake: the whole of it, once, with a reason → { error } or { payment } (a reversal) */
export function reversePayment(orig,reason,payments){
  if(!orig) return {error:"That payment wasn't found."};
  if(orig.reverses) return {error:"A reversal can't be reversed. Record a new payment instead."};
  if((payments||[]).some(x=>x.reverses===orig.id)) return {error:"That payment has been reversed already."};
  const why=clean(reason,300); if(why.length<3) return {error:"Say why it's being reversed (at least 3 characters)."};
  return {payment:{supplierId:orig.supplierId,purchaseId:orig.purchaseId||null,amount:orig.amount,method:orig.method,ref:"",note:why.slice(0,200),reverses:orig.id}};
}

/* ---------- cancelling a purchase ---------- */
/* → { error } or { moves }: the opposite adjustment of each of its stock-in records (ids pcx:<record>, as the database makes them) */
export function cancelPurchaseMoves(p,moves,{reason,t,dev}){
  if(!p||p.kind!=="purchase") return {error:"That purchase wasn't found."};
  if(p.status==="cancelled") return {error:"This purchase is cancelled already."};
  const why=clean(reason,300); if(why.length<3) return {error:"Say why the purchase is cancelled (at least 3 characters)."};
  // serials and batches leave with the stock they came with (the database does the same)
  const out=(moves||[]).filter(m=>m&&m.imp===p.id&&m.type==="RESTOCK").map(m=>Object.assign({id:"pcx:"+m.id,v:m.v,p:m.p,type:"ADJUST",q:-m.q,cost:null,note:("Purchase cancelled: "+why).slice(0,200),t,dev,imp:p.id},
    Array.isArray(m.sn)&&m.sn.length?{sn:m.sn.slice()}:{}, m.b?{b:m.b}:{}));
  return {moves:out,reason:why.slice(0,200)};
}

/* ---------- the cash book entries the database adds (shown on this phone at once, under the same ids) ---------- */
export const purchaseCashMove=p=>p&&p.method==="cash"&&toPaise(p.paid)>0
  ?{id:"pur:"+p.id,type:"out",amount:p.paid,reason:("Paid supplier "+(clean(p.supplier)||"for stock")+(clean(p.invoiceNo)?" · "+clean(p.invoiceNo):"")).slice(0,200),t:p.t,dev:p.dev}:null;
export const purchaseCashReversal=(p,reason,t,dev)=>p&&p.method==="cash"&&toPaise(p.paid)>0
  ?{id:"purx:"+p.id,type:"reversal",amount:p.paid,reason:("Purchase cancelled: "+clean(reason)).slice(0,200),reverses:"pur:"+p.id,t,dev}:null;
export function paymentCashMove(x,supplierName){
  if(!x||x.method!=="cash") return null;
  if(x.reverses) return {id:"spay:"+x.id,type:"reversal",amount:x.amount,reason:("Supplier payment reversed: "+clean(x.note)).slice(0,200),reverses:"spay:"+x.reverses,t:x.t,dev:x.dev};
  return {id:"spay:"+x.id,type:"out",amount:x.amount,reason:("Paid supplier "+(clean(supplierName)||x.supplierId)).slice(0,200),t:x.t,dev:x.dev};
}
