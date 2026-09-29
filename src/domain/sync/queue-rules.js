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
const ONE_PER_RECORD=["sale","return","cust","move","event","eventdel","void","cashmove","dayclose"];
const REVIEW_NOW=["VALIDATION","CONFLICT"];
export const REVIEW_AFTER_TRIES=3;   // NOT_FOUND: something it needs may still be on its way from another device

/* The record an item uploads ("sale:<id>"), or null for items that aren't one record (settings, logo, full upload…) */
export function itemKey(item){
  if(!item||!ONE_PER_RECORD.includes(item.type)) return null;
  const id=item.id||(item.sale&&item.sale.id)||(item.ret&&item.ret.id)||(item.cust&&item.cust.id)||(item.move&&item.move.id)||(item.ev&&item.ev.id);
  return id?item.type+":"+id:null;
}
/* The queue with a new item: a waiting upload of the same record is replaced where it stands (not one being sent) */
export function mergeIntoQueue(queue,item){
  const k=itemKey(item), q=(queue||[]).slice();
  if(k){ const i=q.findIndex(x=>!x.sending&&itemKey(x)===k); if(i>-1){ q[i]=item; return q; } }
  q.push(item); return q;
}
/* Records an item needs in the cloud first */
export function dependsOn(item){
  if(!item) return [];
  if(item.type==="return"&&item.ret) return ["sale:"+item.ret.sale];
  if(item.type==="void") return ["sale:"+item.id];
  if(item.type==="move"&&item.move&&item.move.p) return ["prod:"+item.move.p];
  if(item.type==="cashmove"&&item.move&&item.move.reverses) return ["cashmove:"+item.move.reverses];
  return [];
}
/* The record an item stands for when others wait on it (products too, which merge instead of being replaced) */
export const recordKey=x=>itemKey(x)||(x&&x.type==="prod"&&x.id?"prod:"+x.id:null);
/* Keys of records still waiting: the queue's items (except those done) and the review list */
export function waitingKeys(queue,review,done){
  const s=new Set();
  const add=x=>{const k=recordKey(x);if(k)s.add(k)};
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
};
/* May someone with these permissions upload this item? (unknown kinds: yes) */
export const uploadAllowed=(item,has)=>{const need=item&&UPLOAD_PERMISSIONS[item.type];return !need||need.some(p=>has(p))};
