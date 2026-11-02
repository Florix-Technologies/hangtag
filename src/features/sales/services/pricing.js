// Prices with the shop's price lists: the one resolver (domain/sales/pricing.js) fed with this shop's lists, the customer
// on the bill (their own list) and the list chosen on the bill. The till, quotations and sales orders all ask here; the
// mobile store and assisted cart ask the database's copy of the same rule (hangtag_list_price). A saved bill keeps its
// prices: nothing here changes a bill that is already made.
import { activeList, choosableLists, resolvePrice } from '../../../domain/sales/pricing.js';
import { vPrice } from '../../../domain/catalog/variants.js';
import { store } from '../../../shared/state/store.js';
import { dayKey } from '../../../shared/formatting/dates.js';
import { bizRepository } from '../../commerce/repositories/biz-repository.js';
import { hasCap } from '../../shop/services/shop-caps.js';

/* The shop's price lists (none while the capability is off: every price is the item's own) */
export const priceLists = () => hasCap("uses_price_lists") ? bizRepository().list("pl") : [];
/* A customer's own list (as saved in Customers) */
export const customerListId = cust => { const id = cust && cust.id; const c = id && store.customers && store.customers[id]; return c && c.priceList || null; };
/* What decides prices for a customer and a chosen list, today */
export const priceCtx = (cust, selectedListId) => ({ lists: priceLists(), customerListId: customerListId(cust), selectedListId: selectedListId || null, day: dayKey(Date.now()) });
/* The bill on the screen: its customer and the list chosen on it */
export const billPriceCtx = () => priceCtx(store.cartCust, store.cartPriceList);
/* The price of a catalog item → { price, base, listId, listName, source } */
export const priceOf = (p, v, ctx) => resolvePrice(p && p.id, v && v.id, vPrice(p, v), ctx || billPriceCtx());
/* The list deciding the bill's prices now → { list, locked } (locked: the customer's own list) */
export const billList = () => activeList(billPriceCtx());
export const billLists = () => choosableLists(priceLists(), dayKey(Date.now()));
