// The "bizRepository" port: the commerce batch's records (schema.sql section 3r), kept on this device first and queued for
// upload — one queue item per record ({ type: "biz", kind, id }; the upload reads the record as it is then).
//   pl  price lists          → hangtag_price_lists (one row each)
//   po  purchase orders      → RPC hangtag_save_purchase_order, on the version this device last saw (CONFLICT when changed elsewhere)
//   ei  e-invoice readiness  → hangtag_einvoices          ew  e-way bill readiness → hangtag_eway_bills
//   rpk repacks              → RPC hangtag_save_repack with its two stock records (shown in the stock ledger at once)
//   gv  gift vouchers        → made and spent online through RPCs; kept here only as the cloud's copy (never uploaded)
// Dependencies come from app/container.js.

/* store: the state store · persist: { saveBiz, saveMoves } · outbox: { enqueue, dropQueued } · invalidate: the ledger's refresh */
/* What the queue needs to know of a record to send it after what it depends on (domain/sync/queue-rules.js dependsOn) */
const depsOf = (kind, r) => kind === "po" ? { supplierId: r.supplierId, items: (r.items || []).map(l => ({ p: l.p })) }
  : kind === "rpk" ? { fromP: r.fromP, toP: r.toP } : {};
export function createLocalFirstBizRepository({ store, persist, outbox, invalidate }){
  const kinds = () => store.biz || (store.biz = {});
  const slice = k => kinds()[k] || (kinds()[k] = {});
  return {
    list: kind => Object.values(slice(kind)),
    get: (kind, id) => slice(kind)[id] || null,
    /* Saved here and queued for upload */
    save(kind, rec){ slice(kind)[rec.id] = rec; persist.saveBiz(); outbox.enqueue({ type: "biz", kind, id: rec.id, rec: depsOf(kind, rec) }); return rec; },
    /* The cloud's copy (a voucher an RPC returned): kept, not uploaded */
    keep(kind, rec){ slice(kind)[rec.id] = rec; persist.saveBiz(); return rec; },
    /* Removed here and in the cloud (an upload of it still waiting is dropped) */
    remove(kind, id){
      if(!slice(kind)[id]) return null;
      const r = slice(kind)[id]; delete slice(kind)[id]; persist.saveBiz();
      outbox.dropQueued(q => q.type === "biz" && q.kind === kind && q.id === id && !q.sending && !q.tries);
      outbox.enqueue({ type: "bizdel", kind, id });
      return r;
    },
    /* The cloud took a save: the version it holds now (the next save is made on it) */
    saved(kind, id, version){ const r = slice(kind)[id]; if(r && version > (+r.version || 0)){ r.version = version; persist.saveBiz(); } },
    /* A repack: its record and its two stock records, here at once, then one upload */
    repack(rec){
      slice("rpk")[rec.id] = rec;
      (rec.moves || []).forEach(m => { store.moves[m.id] = m; }); persist.saveMoves(); persist.saveBiz(); invalidate();
      outbox.enqueue({ type: "biz", kind: "rpk", id: rec.id, rec: depsOf("rpk", rec) });
      return rec;
    },
    /* A download: the cloud's records of a kind (those still waiting to upload from here are passed in to stay) */
    replace(kind, map){ kinds()[kind] = map; persist.saveBiz(); },
  };
}
