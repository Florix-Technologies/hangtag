// The "stockRepository" port: stock moves are recorded on this device first, then queued for upload.
// Dependencies are passed in by app/container.js.

/* store: the state store · persist: { saveMoves, saveCatalog } · outbox: { enqueue } */
export function createLocalFirstStockRepository({ store, persist, outbox }){
  return {
    /* Record moves; changedProductId: a product whose data changed too (its cost), saved and uploaded before the moves —
       as just the variants changed (changedVariantIds), so another till's edit of the product stays */
    record({ moves, changedProductId, changedVariantIds }){
      // who recorded it (for display; the database notes the signed-in account itself)
      const user=store.authUser&&store.authUser.id;
      moves.forEach(m=>{if(user&&!m.user)m.user=user;store.moves[m.id]=m}); persist.saveMoves();
      if(changedProductId){ persist.saveCatalog(); outbox.enqueue({type:"prod",id:changedProductId,...(Array.isArray(changedVariantIds)?{fields:[],vars:changedVariantIds}:{})}); }
      moves.forEach(m=>outbox.enqueue({type:"move",id:m.id,move:m}));
    },
  };
}
