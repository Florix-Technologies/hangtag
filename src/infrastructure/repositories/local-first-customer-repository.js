// The "customerRepository" port: customers are kept on this device first (the state store + its storage), then queued for
// upload. The database keeps each shop's customers to itself (row-level security). Dependencies come from app/container.js.

/* store: the state store · persist: { saveCustomers } · outbox: { enqueue } */
export function createLocalFirstCustomerRepository({ store, persist, outbox }){
  const all = () => Object.values(store.customers || {});
  return {
    list: all,
    get: id => (store.customers || {})[id] || null,
    /* A new or changed customer: saved here, then uploaded — a new one whole; an edit as the fields it changed (fields:
       none changed, nothing to upload) */
    save(c, { fields } = {}){
      if(!store.customers) store.customers = {};
      store.customers[c.id] = c;
      persist.saveCustomers();
      if(Array.isArray(fields) && !fields.length) return c;
      outbox.enqueue({ type: "cust", id: c.id, cust: c, ...(Array.isArray(fields) ? { fields } : {}) });
      return c;
    },
  };
}
