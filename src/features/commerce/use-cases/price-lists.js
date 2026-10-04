// Price lists (domain/sales/pricing.js): make and change the shop's lists, set an item's price on a list, choose the list on
// the bill. Changing prices is manage_products (the database checks it too, and that the capability is on); choosing a
// list on the bill is part of selling. A bill already made keeps its prices.
import { checkPriceList, normalizeList, setListPrice } from '../../../domain/sales/pricing.js';
import { store } from '../../../shared/state/store.js';
import { saveCartPriceList } from '../../../shared/state/persistence.js';
import { uid } from '../../../shared/utils/ids.js';
import { denied } from '../../shop/services/access.js';
import { hasCap } from '../../shop/services/shop-caps.js';
import { repriceCart } from '../../sales/services/cart.js';
import { bizRepository } from '../repositories/biz-repository.js';
import { renderSync } from '../../sync/components/sync-status.js';
import { flushSbQueue } from '../../sync/services/outbox.js';

const upload = () => { renderSync(); flushSbQueue(); };
const off = () => hasCap("uses_price_lists") ? null : { error: "Price lists are switched off for this shop. Switch them on in Settings → Business → Features." };
export const allLists = () => bizRepository().list("pl").slice().sort((a, b) => (b.isDefault - a.isDefault) || a.name.localeCompare(b.name));
export const listById = id => bizRepository().get("pl", id);

/* input: { id?, name, isDefault, active, from, to, prices? } → { list } or { error, field } (nothing saved) */
export function savePriceList(input){
  const no = denied("manage_products", "change price lists") || off(); if(no) return no;
  const prev = input && input.id ? listById(input.id) : null;
  const l = normalizeList({ ...(prev || {}), ...input, id: prev ? prev.id : "pl" + uid(), prices: input.prices || (prev && prev.prices) || {} });
  const bad = checkPriceList({ ...l, id: prev ? l.id : "" }, allLists()); if(bad) return bad;
  const t = Date.now();
  // one default per shop: the old default stops being it (the database does the same)
  if(l.isDefault) allLists().filter(x => x.isDefault && x.id !== l.id).forEach(x => bizRepository().save("pl", { ...x, isDefault: false, t }));
  const list = bizRepository().save("pl", { ...l, t });
  repriceCart(); upload();
  return { list };
}
/* One item's price on a list (key "p:<product>" or "v:<variant>"); an empty price takes it off the list → { list } or { error } */
export function setItemPrice(listId, key, price){
  const no = denied("manage_products", "change price lists") || off(); if(no) return no;
  const l = listById(listId); if(!l) return { error: "That price list isn't on this device." };
  const raw = price == null ? "" : String(price).trim().replace(/[₹,\s]/g, "");
  const next = setListPrice(l, key, raw === "" ? null : +raw);
  const bad = checkPriceList(next, allLists()); if(bad) return bad;
  const list = bizRepository().save("pl", { ...next, t: Date.now() });
  repriceCart(); upload();
  return { list };
}
export function removePriceList(id){
  const no = denied("manage_products", "change price lists"); if(no) return no;
  const l = listById(id); if(!l) return { error: "That price list isn't on this device." };
  if(l.isDefault) return { error: "This is the default list. Make another list the default first." };
  bizRepository().remove("pl", id);
  if(store.cartPriceList === id){ store.cartPriceList = null; saveCartPriceList(); }
  repriceCart(); upload();
  return { ok: true };
}
/* The list chosen on the bill being rung up (null: the default) → { changed (lines repriced) } */
export function chooseBillList(id){
  if(id && !listById(id)) return { error: "That price list isn't on this device." };
  store.cartPriceList = id || null; saveCartPriceList();
  return { changed: repriceCart() };
}
