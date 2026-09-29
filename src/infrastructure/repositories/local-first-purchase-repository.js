// The "purchaseRepository" port: suppliers, purchases from them and later payments to them. Kept on this device first (the
// state store + its storage), then queued for upload: a supplier is one row (hangtag_suppliers), a purchase goes up with
// its stock-in records in ONE step (RPC hangtag_save_purchase: all or nothing), a cancel through hangtag_cancel_purchase,
// a payment is one row that is never changed (hangtag_supplier_payments). Stock is only ever the stock records; the cash
// book entry of cash paid is added by the database, and shown here at once under the same id. Dependencies come from
// app/container.js.

/* store: the state store · persist: { saveSuppliers, savePurchases, saveSupplierPays, saveMoves, saveCashMoves, saveCatalog }
   · outbox: { enqueue } · invalidate: the ledger's refresh */
export function createLocalFirstPurchaseRepository({ store, persist, outbox, invalidate }){
  const slice = k => store[k] || (store[k] = {});
  return {
    suppliers: () => Object.values(store.suppliers || {}),
    purchases: () => Object.values(store.purchases || {}),
    payments: () => Object.values(store.supplierPays || {}),
    saveSupplier(s){
      slice("suppliers")[s.id] = s; persist.saveSuppliers();
      outbox.enqueue({ type: "supplier", id: s.id, sup: s });
      return s;
    },
    /* A purchase, its stock-in records and (cash paid) the cash book entry; changedProductIds: products whose cost price
       changed with it, uploaded first */
    savePurchase({ purchase, moves, cashMove, changedProductIds }){
      slice("purchases")[purchase.id] = purchase; persist.savePurchases();
      moves.forEach(m => { store.moves[m.id] = m; }); persist.saveMoves();
      if(cashMove){ slice("cashMoves")[cashMove.id] = cashMove; persist.saveCashMoves(); }
      if(changedProductIds && changedProductIds.length){ persist.saveCatalog(); changedProductIds.forEach(id => outbox.enqueue({ type: "prod", id })); }
      invalidate();
      outbox.enqueue({ type: "purchase", id: purchase.id, purchase, moves });
      return purchase;
    },
    /* Cancel: the purchase is marked cancelled, the opposite adjustments of its stock-in records and the cash coming back are
       shown here under the ids the database gives them */
    cancelPurchase({ id, reason, moves, cashMove, t, dev }){
      const p = slice("purchases")[id]; if(!p) return null;
      slice("purchases")[id] = { ...p, status: "cancelled", cancelReason: reason, cancelledAt: t };
      persist.savePurchases();
      moves.forEach(m => { store.moves[m.id] = m; }); persist.saveMoves();
      if(cashMove){ slice("cashMoves")[cashMove.id] = cashMove; persist.saveCashMoves(); }
      invalidate();
      outbox.enqueue({ type: "pcancel", id, reason, t, dev });
      return slice("purchases")[id];
    },
    recordPayment({ payment, cashMove }){
      slice("supplierPays")[payment.id] = payment; persist.saveSupplierPays();
      if(cashMove){ slice("cashMoves")[cashMove.id] = cashMove; persist.saveCashMoves(); }
      outbox.enqueue({ type: "spay", id: payment.id, pay: payment });
      return payment;
    },
  };
}
