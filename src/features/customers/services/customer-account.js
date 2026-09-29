// What customers owe (read model over this device's bills, returns and payments collected; the rules are in
// domain/customers/credit.js): one customer's account and everyone's outstanding amounts.
import { customerAccount, dueRefundRoom, outstandingByCustomer } from '../../../domain/customers/credit.js';
import { D } from '../../inventory/services/ledger.js';
import { creditRepository } from '../repositories/credit-repository.js';

export const collections = () => creditRepository().list();
const sources = () => { const d = D(); return { sales: d.sales, returns: d.rets, collections: collections() }; };
/* { purchases, paidAtSale, onAccount, refundedToAccount, collected, paid, outstanding, bills, entries } */
export const accountOf = cid => customerAccount(cid, sources());
/* { [customer id]: rupees owed } (only customers with something on account or collected) */
export const outstandingAll = () => outstandingByCustomer(sources());
/* How much of a bill can still be refunded to its customer's account */
export const billDueRoom = sid => { const d = D(), s = d.saleById[sid]; return s ? dueRefundRoom(s, d.retBySale[sid] || []) : 0; };
