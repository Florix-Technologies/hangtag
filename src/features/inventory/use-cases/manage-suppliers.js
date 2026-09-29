// Suppliers and payments to them: add / change a supplier, switch one off (never deleted: its purchases and payments keep
// it), record a later payment (for one invoice or on account) and reverse one made by mistake. Checked with the domain rules
// first; a team member needs create_purchase (suppliers: or manage_inventory), refused before anything changes.
import { store } from '../../../shared/state/store.js';
import { checkSupplier, checkSupplierPayment, paymentCashMove, reversePayment } from '../../../domain/inventory/purchase.js';
import { purchaseRepository } from '../repositories/purchase-repository.js';
import { purchasesList, supplierById, supplierPaysList, suppliersList } from '../services/purchase-state.js';
import { uid } from '../../../shared/utils/ids.js';
import { denied } from '../../shop/services/access.js';

/* input: { id?, name, phone, email, address, gstin, notes, active } → { error, field } or { supplier, created } */
export function saveSupplier(input){
  const no=denied(["create_purchase","manage_inventory"],"add or change suppliers"); if(no) return no;
  const old=input&&input.id?supplierById(input.id):null;
  const r=checkSupplier({...input,id:old?old.id:"sup"+uid(),active:old?(input.active==null?old.active:input.active):true},suppliersList(true));
  if(r.error) return r;
  const s={...r.supplier,t:old&&old.t?old.t:Date.now()};
  purchaseRepository().saveSupplier(s);
  return {supplier:s,created:!old};
}
/* Switch a supplier off (hidden from new purchases) or on again */
export function setSupplierActive(id,on){
  const no=denied(["create_purchase","manage_inventory"],"change suppliers"); if(no) return no;
  const s=supplierById(id); if(!s) return {error:"That supplier wasn't found."};
  if(on&&suppliersList().some(o=>o.id!==id&&o.name.toLowerCase()===s.name.toLowerCase())) return {error:`Another supplier is called ${s.name}. Rename one of them first.`};
  const next={...s,active:!!on};
  purchaseRepository().saveSupplier(next);
  return {supplier:next};
}
/* input: { supplierId, purchaseId?, amount, method, ref, note } → { error, field } or { payment } (cash also goes into the
   cash book as "Cash out", added by the database and shown here at once) */
export function recordSupplierPayment(input){
  const no=denied("create_purchase","pay suppliers"); if(no) return no;
  const s=supplierById(input&&input.supplierId); if(!s) return {error:"Which supplier?",field:"supplier"};
  const pays=supplierPaysList(), purchase=input.purchaseId?purchasesList().find(p=>p.id===input.purchaseId)||null:null;
  const r=checkSupplierPayment(input,{purchase,payments:pays}); if(r.error) return r;
  const payment={...r.payment,id:"sp"+uid(),t:Date.now(),dev:store.dev};
  purchaseRepository().recordPayment({payment,cashMove:paymentCashMove(payment,s.name)});
  return {payment};
}
/* The whole of a payment back, once, with a reason → { error } or { payment } (the reversal) */
export function reverseSupplierPayment(id,reason){
  const no=denied("create_purchase","reverse supplier payments"); if(no) return no;
  const pays=supplierPaysList(), orig=pays.find(x=>x.id===id);
  const r=reversePayment(orig,reason,pays); if(r.error) return r;
  const s=supplierById(orig.supplierId), payment={...r.payment,id:"sp"+uid(),t:Date.now(),dev:store.dev};
  purchaseRepository().recordPayment({payment,cashMove:paymentCashMove(payment,s&&s.name)});
  return {payment};
}
