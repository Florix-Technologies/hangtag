// The shop's financial transactions and its cash and bank books, from the bills and returns on this device — the same
// entries, with the same ids, that the database posts (schema.sql 3e). The rules are in domain/finance/books.js.
import { bankBook, cashBook, financialTransactions, reconcileSale } from '../../../domain/finance/books.js';
import { D } from '../../inventory/services/ledger.js';
import { parseDay } from '../../../shared/formatting/dates.js';
import { inFilter } from '../../../domain/events/event.js';
import { store } from '../../../shared/state/store.js';

/* filter: "" every bill, "store", or an event id (returns follow their bill; cash entries carry the event they were made at) */
export const shopTransactions=(filter="")=>{const d=D(),ok=s=>inFilter(s||{},filter);return financialTransactions(d.sales.filter(ok),d.rets.filter(r=>ok(d.saleById[r.sale])),Object.values(store.cashMoves||{}).filter(ok))};
/* Days "yyyy-mm-dd" → { from, to } in ms (the whole of both days) */
export const dayBounds=(from,to)=>({from:parseDay(from).getTime(),to:parseDay(to).getTime()+864e5-1});
/* The books for the Reports page's period and event filter */
export const cashBookFor=(from,to)=>cashBook(shopTransactions(store.prefs.repEvent||""),dayBounds(from,to));
export const bankBookFor=(from,to)=>bankBook(shopTransactions(store.prefs.repEvent||""),dayBounds(from,to));
/* One bill's money: its payments and refunds, and whether receipts match what was due */
export function billMoney(sale){
  const tx=shopTransactions().filter(x=>x.saleId===sale.id);
  return {txns:tx,...reconcileSale(sale,tx)};
}
