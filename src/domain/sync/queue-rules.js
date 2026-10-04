// Upload queue rules (offline-first sync). Everything is saved on the device first and queued; these rules decide what the
// queue keeps, in which order it sends, and what happens when an upload fails. Pure.
//   · Exactly once: every upload saves a record under its own fixed id (bills, returns, payments, book entries all have
//     ids made on the device), so sending it again changes nothing. The queue keeps one waiting upload per record: a later
//     change of the same record replaces the waiting one where it stands.
//   · Order: items go in the order they were made. A bill, product, event or full upload that fails holds back everything
//     after it (later work may need it). A return or a cancel waits while its bill is still queued or under review; a stock
//     move waits for its product.
//   · Failures: no connection, an expired sign-in, an outdated database or a server error keep the item and retry. A refusal
//     by the database's rules won't fix itself by retrying: the item goes to the review list with the reason. Nothing is
//     ever dropped silently; review items can be sent again, and all but bills can be discarded after review.
export const ORDERED_TYPES=["sale","prod","allsales","event"];
const ONE_PER_RECORD=["sale","return","cust","move","event","eventdel","void","cashmove","dayclose","collection","held","helddel","order","supplier","purchase","pcancel","spay","table","tsession","ostatus","biz","bizdel"];
const REVIEW_NOW=["VALIDATION","CONFLICT"];
export const REVIEW_AFTER_TRIES=3;   // NOT_FOUND: something it needs may still be on its way from another device

/* The record an item uploads ("sale:<id>"), or null for items that aren't one record (settings, logo, full upload…) */
export function itemKey(item){
  if(!item||!ONE_PER_RECORD.includes(item.type)) return null;
  // the commerce batch (section 3r): one record per kind and id ("biz:po:<id>")
  if(item.type==="biz"||item.type==="bizdel") return item.kind&&item.id?item.type+":"+item.kind+":"+item.id:null;
  const id=item.id||(item.sale&&item.sale.id)||(item.ret&&item.ret.id)||(item.cust&&item.cust.id)||(item.move&&item.move.id)||(item.ev&&item.ev.id);
  return id?item.type+":"+id:null;
}
/* The queue with a new item: a waiting upload of the same record is replaced where it stands (not one being sent) */
export function mergeIntoQueue(queue,item){
  const k=itemKey(item), q=(queue||[]).slice();
  if(k){ const i=q.findIndex(x=>!x.sending&&itemKey(x)===k); if(i>-1){ q[i]=item; return q; } }
  q.push(item); return q;
}
/* Serial numbers and batches (section 3n): a stock-in brings them into the cloud ("sn:<serial>", "bt:<variant>|<batch>");
   a bill, or a stock record taking them out, waits for the stock-in still on its way. Serials and batches as normalized
   (upper case, trimmed), as every record keeps them. */
const snKeys=list=>(list||[]).flatMap(x=>Array.isArray(x.sn)?x.sn.map(s=>"sn:"+String(s).trim().toUpperCase()):[]);
const btKeys=(list,vid)=>(list||[]).flatMap(x=>Array.isArray(x.bt)?x.bt.map(a=>"bt:"+(vid||x.v)+"|"+String(a.b).trim().replace(/\s+/g," ").toUpperCase()):[]);
const moveKeys=m=>[...snKeys([m]),...(m.b?["bt:"+m.v+"|"+String(m.b).trim().replace(/\s+/g," ").toUpperCase()]:[])];
export function providesKeys(item){
  if(!item) return [];
  if(item.type==="move"&&item.move&&item.move.q>0) return moveKeys(item.move);
  if(item.type==="purchase") return (item.moves||[]).flatMap(moveKeys);
  return [];
}
/* Records an item needs in the cloud first */
export function dependsOn(item){
  if(!item) return [];
  if(item.type==="sale"&&item.sale) return [...snKeys(item.sale.items),...btKeys(item.sale.items)];
  if(item.type==="return"&&item.ret) return ["sale:"+item.ret.sale];
  if(item.type==="void") return ["sale:"+item.id];
  if(item.type==="move"&&item.move&&item.move.p) return ["prod:"+item.move.p,...(item.move.q<0?moveKeys(item.move):[])];
  if(item.type==="cashmove"&&item.move&&item.move.reverses) return ["cashmove:"+item.move.reverses];
  // a payment collected from a customer needs the customer in the cloud first (foreign key)
  if(item.type==="collection"&&item.col&&item.col.cust) return ["cust:"+item.col.cust];
  // a purchase needs its supplier and the products of its lines; a cancel its purchase; a payment its supplier, its invoice
  // and the payment it reverses
  if(item.type==="purchase"&&item.purchase){const p=item.purchase;return [...(p.supplierId?["supplier:"+p.supplierId]:[]),...new Set((p.lines||[]).map(l=>"prod:"+l.p)),...(p.poId?["biz:po:"+p.poId]:[])]}
  if(item.type==="pcancel") return ["purchase:"+item.id];
  // a restaurant (section 3o): a kitchen step needs its order in the cloud; a table order its table's session
  if(item.type==="ostatus") return ["order:"+item.id];
  if(item.type==="tsession"&&item.session) return ["table:"+item.session.table];
  if(item.type==="spay"&&item.pay){const x=item.pay;return ["supplier:"+x.supplierId,...(x.purchaseId?["purchase:"+x.purchaseId]:[]),...(x.reverses?["spay:"+x.reverses]:[])]}
  // the commerce batch: a purchase order needs its supplier and products; GST readiness its bill; a repack its products;
  // a purchase received on a purchase order needs the order in the cloud first
  if(item.type==="biz"){
    const r=item.rec||{};
    if(item.kind==="po") return [...(r.supplierId?["supplier:"+r.supplierId]:[]),...new Set((r.items||[]).map(l=>"prod:"+l.p))];
    if(item.kind==="ei"||item.kind==="ew") return ["sale:"+item.id];
    if(item.kind==="rpk") return [...new Set([r.fromP,r.toP].filter(Boolean).map(p=>"prod:"+p))];
    // a bank entry needs its accounts in the cloud first, and a reversal the entry it reverses
    if(item.kind==="bm") return [...new Set([r.account,r.to].filter(Boolean).map(a=>"biz:ba:"+a)),...(r.reverses?["biz:bm:"+r.reverses]:[])];
  }
  return [];
}
/* The record an item stands for when others wait on it (products too, which merge instead of being replaced) */
export const recordKey=x=>itemKey(x)||(x&&x.type==="prod"&&x.id?"prod:"+x.id:null);
/* Keys of records still waiting: the queue's items (except those done) and the review list */
export function waitingKeys(queue,review,done){
  const s=new Set();
  const add=x=>{const k=recordKey(x);if(k)s.add(k);providesKeys(x).forEach(p=>s.add(p))};
  (queue||[]).forEach(x=>{if(!(done&&done.has(x)))add(x)});
  (review||[]).forEach(r=>add(r.item));
  return s;
}
export const isBlocked=(item,waiting)=>dependsOn(item).some(k=>waiting.has(k));
/* After a failed upload: "retry" (keep it queued) or "review" (the database refused it; show it for review).
   For a team member (opts.member), PERMISSION means the role may not do this: retrying won't help, so it goes to review
   (a phone that lost the shop altogether is signed out before this is asked). For the owner it stays a retry, as before. */
export function failureAction(code,tries,opts){
  if(REVIEW_NOW.includes(code)) return "review";
  if(code==="PERMISSION"&&opts&&opts.member) return "review";
  if(code==="NOT_FOUND"&&(tries||0)>=REVIEW_AFTER_TRIES) return "review";
  return "retry";
}
/* Only bills can't be discarded from review: a completed sale is never thrown away */
export const canDiscard=item=>!!item&&item.type!=="sale"&&item.type!=="allsales";
/* The permissions (any one) the database asks of a team member for each kind of upload (supabase/schema.sql section 5:
   adding the record; a cancel is a change of the bill, see hangtag_member_write_check). The use cases refuse a member's
   change its role can't upload before changing anything; one that still reaches the queue goes to the review list with
   the reason (the owner's are always queued). */
export const UPLOAD_PERMISSIONS={
  sale:["create_sale"],void:["perform_return","manage_settings"],allsales:["create_sale"],cashmove:["create_sale"],dayclose:["create_sale"],
  return:["perform_return"],cust:["create_sale","collect_credit","create_order"],
  prod:["manage_products"],proddel:["manage_products"],img:["manage_products"],
  move:["manage_inventory","create_purchase","perform_return"],
  settings:["manage_settings"],logo:["manage_settings"],event:["manage_settings"],eventdel:["manage_settings"],
  // section 3m: payments collected from customers, held bills, orders (RPC hangtag_save_order checks create_order)
  collection:["collect_credit"],held:["create_sale"],helddel:["create_sale"],order:["create_order"],
  // suppliers and purchases (section 3l); cancelling a purchase also needs manage_inventory (checked by the use case and hangtag_cancel_purchase)
  supplier:["create_purchase","manage_inventory"],purchase:["create_purchase"],pcancel:["create_purchase"],spay:["create_purchase"],
  // a restaurant (section 3o): tables are set up with the shop's settings; guests are seated by whoever takes their order;
  // the kitchen moves orders along (RPC hangtag_order_status)
  table:["manage_settings"],tsession:["manage_tables","create_order","create_sale"],ostatus:["manage_kitchen","create_order","send_to_kitchen"],
};
/* The commerce batch (section 3r), by kind: price lists with products, purchase orders and repacks with stock, GST
   readiness with bills */
export const BIZ_UPLOAD_PERMISSIONS={pl:["manage_products"],po:["create_purchase"],ei:["create_sale","view_reports"],ew:["create_sale","view_reports"],rpk:["manage_inventory"],
  ba:["manage_settings"],bm:["view_reports","manage_settings"]};
/* May someone with these permissions upload this item? (unknown kinds: yes) */
export const uploadAllowed=(item,has)=>{const need=item&&(item.type==="biz"||item.type==="bizdel"?BIZ_UPLOAD_PERMISSIONS[item.kind]:UPLOAD_PERMISSIONS[item.type]);return !need||need.some(p=>has(p))};
/* A bill or return refused because another one of the shop already has its number (hangtag_doc_no_check): it can be given
   the next number of this device's series and sent again */
export const numberTaken=r=>!!r&&!!r.item&&(r.item.type==="sale"||r.item.type==="return")&&r.code==="CONFLICT"&&/number .+ is already used/i.test(r.err||"");
