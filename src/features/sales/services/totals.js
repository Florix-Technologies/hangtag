// Bill totals and invoice numbers with this shop's settings.
import { store } from '../../../shared/state/store.js';
import { computeBillTotals } from '../../../domain/sales/bill-totals.js';
import { formatInvoiceNo } from '../../../domain/sales/sale.js';

/* Totals for a list of lines, with the shop's GST setting */
export const billTotals=(lines,discount)=>computeBillTotals(lines,discount,store.settings);
export const invoiceNo=(t,seq)=>formatInvoiceNo(store.settings.prefix,t,seq);
