// Stock reserved for online-store orders (domain/commerce/channels.js), as the database counts it: the till can't sell it
// (the database would refuse that bill), except on the bill of that very order.
import { reservedByOrders } from '../../../domain/commerce/channels.js';
import { store } from '../../../shared/state/store.js';

/* Map(variantId → qty) reserved now, leaving out the order on the bill (if any) */
export const reservedStock = () => reservedByOrders(Object.values(store.orders || {}), { except: store.cartOrder && store.cartOrder.id || null });
export const reservedOf = vid => reservedStock().get(vid) || 0;
/* All reservations, for the stock page (no order is being billed there) */
export const reservedAll = () => reservedByOrders(Object.values(store.orders || {}));
