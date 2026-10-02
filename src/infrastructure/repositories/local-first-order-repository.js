// The "orderRepository" port: orders (quotations, sales orders, table orders) and held bills, kept on this device first
// (the state store + its storage), then queued for upload. An order uploads as a whole through RPC hangtag_save_order
// (the queued item names it; the upload reads the order as it is then, with the version this device last saw in the
// cloud). A held bill is added or replaced (hangtag_held_carts); recalling it removes it for every till. Holding a bill
// never touches stock. Dependencies come from app/container.js.

/* store: the state store · persist: { saveOrders, saveHeldCarts } · outbox: { enqueue, dropQueued } */
export function createLocalFirstOrderRepository({ store, persist, outbox }){
  const orders = () => store.orders || (store.orders = {});
  const held = () => store.heldCarts || (store.heldCarts = {});
  return {
    list: () => Object.values(orders()),
    get: id => orders()[id] || null,
    save(o){ orders()[o.id] = o; persist.saveOrders(); outbox.enqueue({ type: "order", id: o.id }); return o; },
    /* A table order's step in the kitchen (or cancelled): kept here and sent on its own ("ostatus" → RPC hangtag_order_status:
       the kitchen moves an order along, it never edits it) */
    setStatus(id, status, t){ const o = orders()[id]; if(!o) return null; orders()[id] = { ...o, status, updatedT: t }; persist.saveOrders(); outbox.enqueue({ type: "ostatus", id, status }); return orders()[id]; },
    /* Paying a table bill retires all of that session's tickets locally. The sale's database trigger performs the same
       transition atomically in the cloud, so this consequence is not a second queued/permissioned kitchen action. */
    closeSessionOrders(sessionIds, t){ const ids=new Set(sessionIds||[]); let n=0; Object.values(orders()).forEach(o=>{ if(o.kind==="table"&&ids.has(o.sessionId)&&!["served","cancelled"].includes(o.status)){ orders()[o.id]={...o,status:"served",updatedT:t}; n++; } }); if(n) persist.saveOrders(); return n; },
    /* The cloud took a save: the version it holds now (the next save is made on it) */
    saved(id, version){ const o = orders()[id]; if(o && version > (+o.version || 0)){ o.version = version; persist.saveOrders(); } },
    heldList: () => Object.values(held()),
    getHeld: id => held()[id] || null,
    hold(h){ held()[h.id] = h; persist.saveHeldCarts(); outbox.enqueue({ type: "held", id: h.id, held: h }); return h; },
    /* Recalled (or thrown away): gone here, and removed in the cloud (an upload of it still waiting is simply dropped) */
    removeHeld(id){
      const h = held()[id]; if(!h) return null;
      delete held()[id]; persist.saveHeldCarts();
      outbox.dropQueued(q => q.type === "held" && q.id === id && !q.sending && !q.tries);
      outbox.enqueue({ type: "helddel", id });
      return h;
    },
  };
}
