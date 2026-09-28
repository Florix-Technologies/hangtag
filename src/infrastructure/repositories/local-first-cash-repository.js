// The "cashRepository" port: cash moved without a bill (opening float, cash in / out, expenses, reversals) and day closes.
// Kept on this device first (the state store + its storage), then queued for upload (hangtag_cash_moves,
// hangtag_day_closes). Entries are never changed or deleted once made; a close of the same day and scope replaces the
// earlier one. Dependencies come from app/container.js.

/* store: the state store · persist: { saveCashMoves, saveDayCloses } · outbox: { enqueue } */
export function createLocalFirstCashRepository({ store, persist, outbox }){
  return {
    moves: () => Object.values(store.cashMoves || {}),
    record(move){
      if(!store.cashMoves) store.cashMoves = {};
      store.cashMoves[move.id] = move; persist.saveCashMoves();
      outbox.enqueue({ type: "cashmove", id: move.id, move });
      return move;
    },
    closes: () => Object.values(store.dayCloses || {}),
    close(c){
      if(!store.dayCloses) store.dayCloses = {};
      store.dayCloses[c.id] = c; persist.saveDayCloses();
      outbox.enqueue({ type: "dayclose", id: c.id, close: c });
      return c;
    },
  };
}
