// The shop's financial transactions and its cash and bank books, from the bills and returns on this device — the same
// entries, with the same ids, that the database posts (schema.sql 3e). The rules are in domain/finance/books.js.
import { bankBook, cashBook, financialTransactions, reconcileSale } from '../../../domain/finance/books.js';
import { D } from '../../inventory/services/ledger.js';
import { parseDay } from '../../../shared/formatting/dates.js';

export const shopTransactions=()=>{const d=D();return financialTransactions(d.sales,d.rets)};
/* Days "yyyy-mm-dd" → { from, to } in ms (the whole of both days) */
export const dayBounds=(from,to)=>({from:parseDay(from).getTime(),to:parseDay(to).getTime()+864e5-1});
export const cashBookFor=(from,to)=>cashBook(shopTransactions(),dayBounds(from,to));
export const bankBookFor=(from,to)=>bankBook(shopTransactions(),dayBounds(from,to));
/* One bill's money: its payments and refunds, and whether receipts match what was due */
export function billMoney(sale){
  const tx=shopTransactions().filter(x=>x.saleId===sale.id);
  return {txns:tx,...reconcileSale(sale,tx)};
}
