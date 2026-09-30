// Purchases, suppliers and supplier payments on this device (read model), and what a refused upload does to them: like a
// refused return, a purchase, a cancel or a payment the database refused is taken off this device's stock and books until
// it is sent again from the sync review (the database didn't accept it); sent again, it comes back.
import { store } from '../../../shared/state/store.js';
import { cancelPurchaseMoves, paymentCashMove, purchaseCashMove, purchaseCashReversal, supplierAccount } from '../../../domain/inventory/purchase.js';
import { saveCashMoves, saveMoves, savePurchases, saveSupplierPays } from '../../../shared/state/persistence.js';
import { invalidate } from './ledger.js';

export const suppliersList = (all) => Object.values(store.suppliers || {}).filter(s => s && (all || s.active !== false)).sort((a, b) => a.name.localeCompare(b.name));
export const supplierById = id => (store.suppliers || {})[id] || null;
export const purchasesList = () => Object.values(store.purchases || {}).filter(Boolean).sort((a, b) => b.t - a.t);
export const supplierPaysList = () => Object.values(store.supplierPays || {}).filter(Boolean);
export const supplierAccountOf = id => supplierAccount(id, purchasesList(), supplierPaysList());

const drop = (slice, id) => { if(store[slice] && store[slice][id]){ delete store[slice][id]; return true; } return false; };

/* A queued upload went to the review list: take what it did off this device */
export function purchaseItemOff(item){
  if(!item) return;
  if(item.type === "purchase" && item.purchase){
    drop("purchases", item.id); savePurchases();
    (item.moves || []).forEach(m => { delete store.moves[m.id]; }); saveMoves();
    if(drop("cashMoves", "pur:" + item.id)) saveCashMoves();
    invalidate();
  } else if(item.type === "pcancel"){
    const p = (store.purchases || {})[item.id];
    if(p){ const q = { ...p, status: "posted" }; delete q.cancelReason; delete q.cancelledAt; store.purchases[item.id] = q; savePurchases(); }
    Object.keys(store.moves).forEach(k => { const m = store.moves[k]; if(m && m.imp === item.id && k.startsWith("pcx:")) delete store.moves[k]; }); saveMoves();
    if(drop("cashMoves", "purx:" + item.id)) saveCashMoves();
    invalidate();
  } else if(item.type === "spay"){
    drop("supplierPays", item.id); saveSupplierPays();
    if(drop("cashMoves", "spay:" + item.id)) saveCashMoves();
  }
}
/* Sent again from the review list: it is back on this device until the database answers */
export function purchaseItemOn(item){
  if(!item) return;
  if(item.type === "purchase" && item.purchase){
    if(!store.purchases) store.purchases = {};
    store.purchases[item.id] = item.purchase; savePurchases();
    (item.moves || []).forEach(m => { store.moves[m.id] = m; }); saveMoves();
    const c = purchaseCashMove(item.purchase); if(c){ store.cashMoves[c.id] = c; saveCashMoves(); }
    invalidate();
  } else if(item.type === "pcancel"){
    const p = (store.purchases || {})[item.id]; if(!p || p.status === "cancelled") return;
    const r = cancelPurchaseMoves(p, Object.values(store.moves), { reason: item.reason, t: item.t, dev: item.dev });
    if(r.error) return;
    store.purchases[item.id] = { ...p, status: "cancelled", cancelReason: r.reason, cancelledAt: item.t }; savePurchases();
    r.moves.forEach(m => { store.moves[m.id] = m; }); saveMoves();
    const c = purchaseCashReversal(p, r.reason, item.t, item.dev); if(c){ store.cashMoves[c.id] = c; saveCashMoves(); }
    invalidate();
  } else if(item.type === "spay" && item.pay){
    if(!store.supplierPays) store.supplierPays = {};
    store.supplierPays[item.id] = item.pay; saveSupplierPays();
    const s = supplierById(item.pay.supplierId), c = paymentCashMove(item.pay, s && s.name);
    if(c){ store.cashMoves[c.id] = c; saveCashMoves(); }
  }
}
