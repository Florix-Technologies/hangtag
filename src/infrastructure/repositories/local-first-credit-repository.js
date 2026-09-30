// The "creditRepository" port: payments customers make towards what they owe (collections), kept on this device first,
// then queued for upload (hangtag_collections; the database posts each to the cash or bank book). An entry is never
// changed; the owner may cancel one. Dependencies come from app/container.js.

/* store: the state store · persist: { saveCollections } · outbox: { enqueue } */
export function createLocalFirstCreditRepository({ store, persist, outbox }){
  const all = () => store.collections || (store.collections = {});
  return {
    list: () => Object.values(all()),
    get: id => all()[id] || null,
    record(c){ all()[c.id] = c; persist.saveCollections(); outbox.enqueue({ type: "collection", id: c.id, col: c }); return c; },
    cancel(id){
      const c = all()[id]; if(!c || c.status === "cancelled") return c || null;
      const next = { ...c, status: "cancelled" }; all()[id] = next; persist.saveCollections();
      outbox.enqueue({ type: "collection", id, col: next });
      return next;
    },
  };
}
