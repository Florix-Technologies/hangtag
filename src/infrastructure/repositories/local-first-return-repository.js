// The "returnRepository" port: returns and exchanges are kept on this device first (the state store + its storage), then
// queued for upload (RPC hangtag_save_return: the return with its lines, all or nothing). The database refuses a return of
// more pieces than a bill line has left, on any device. Dependencies come from app/container.js.

/* store: the state store · persist: { saveReturns } · outbox: { enqueue } · invalidate: drops the stock read model */
export function createLocalFirstReturnRepository({ store, persist, outbox, invalidate }){
  return {
    list: () => Object.values(store.returnsMap || {}),
    get: id => (store.returnsMap || {})[id] || null,
    /* A new return: saved here, then uploaded */
    record(ret){
      store.returnsMap[ret.id] = ret; persist.saveReturns(); invalidate();
      outbox.enqueue({ type: "return", id: ret.id, ret });
      return ret;
    },
  };
}
