// The "stockRepository" port: stock moves are recorded on this device first, then queued for upload.
// Dependencies are passed in by app/container.js.

/* store: the state store · persist: { saveMoves, saveCatalog } · outbox: { enqueue } */
export function createLocalFirstStockRepository({ store, persist, outbox }){
  return {
    /* Record moves; changedProductId: a product whose data changed too (e.g. its cost), saved and uploaded before the moves */
    record({ moves, changedProductId }){
      // who recorded it (for display; the database notes the signed-in account itself)
      const user=store.authUser&&store.authUser.id;
      moves.forEach(m=>{if(user&&!m.user)m.user=user;store.moves[m.id]=m}); persist.saveMoves();
      if(changedProductId){ persist.saveCatalog(); outbox.enqueue({type:"prod",id:changedProductId}); }
      moves.forEach(m=>outbox.enqueue({type:"move",id:m.id,move:m}));
    },
  };
}
