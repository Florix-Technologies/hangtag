// Sales by channel (domain/commerce/channels.js) over the same bills and returns as every report: the counter, the online
// store, sales orders, dine-in and events.
import { byChannel } from '../../../domain/commerce/channels.js';
import { store } from '../../../shared/state/store.js';
import { D } from '../../inventory/services/ledger.js';
import { kstats, periodData } from '../../reports/services/report-data.js';

const orderOf = id => (store.orders || {})[id] || null;
/* [{ key, label, sales, bills }] for the channels that sold in the period (ev: an event filter as periodData takes it) */
export function salesByChannel(from, to, ev){
  const x = ev === undefined ? periodData(from, to) : periodData(from, to, ev);
  return byChannel(x.live, x.rets, { orderOf, saleOf: id => D().saleById[id] || null, summarize: (l, r) => { const K = kstats(l, r); return { sales: K.rev, bills: K.bills }; } });
}
