// What customers owe (read model over this device's bills, returns and payments collected; the rules are in
// domain/customers/credit.js): one customer's account and everyone's outstanding amounts.
import { billBalances, customerAccount, dueRefundRoom, outstandingByCustomer } from '../../../domain/customers/credit.js';
import { D } from '../../inventory/services/ledger.js';
import { creditRepository } from '../repositories/credit-repository.js';

export const collectionsList = () => creditRepository().list();
const sources = () => { const d = D(); return { sales: d.sales, returns: d.rets, collections: collectionsList() }; };
/* { purchases, paidAtSale, onAccount, refundedToAccount, collected, paid, outstanding, bills, entries } */
export const accountOf = cid => customerAccount(cid, sources());
/* { [customer id]: rupees owed } (only customers with something on account or collected) */
export const outstandingAll = () => outstandingByCustomer(sources());
/* { [bill id]: rupees still owed on that bill } (payments collected later pay the oldest bills first) */
export const openBillBalances = () => billBalances(sources());
/* How much of a bill can still be refunded to its customer's account: what the bill still has on account (the database's
   rule), and never more than the customer owes now (payments collected since may have covered it) */
export const billDueRoom = sid => { const d = D(), s = d.saleById[sid]; if(!s || !s.cust || !s.cust.id) return 0;
  return Math.max(0, Math.min(dueRefundRoom(s, d.retBySale[sid] || []), accountOf(s.cust.id).outstanding)); };
