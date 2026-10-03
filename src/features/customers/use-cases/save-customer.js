// SaveCustomer / SetBillCustomer: add or edit a customer (checked, never a second copy of the same mobile or GSTIN), and
// put a customer on the bill being rung up (or none: a walk-in).
import { store } from '../../../shared/state/store.js';
import { checkCustomer, findDuplicate, tidyCustomer } from '../../../domain/customers/customer.js';
import { customerRepository } from '../repositories/customer-repository.js';
import { saveCart } from '../../../shared/state/persistence.js';
import { uid } from '../../../shared/utils/ids.js';
import { can, canAny, notAllowedText } from '../../shop/services/access.js';
import { repriceCart } from '../../sales/services/cart.js';

/* input: form values; id: the customer being edited (none = new).
   → { error, field, duplicate? } (nothing saved) or { customer, created } */
export function saveCustomer(input, { id } = {}){
  if(!canAny(["create_sale","collect_credit","create_order"])) return { error: notAllowedText("add or change customers") };
  const repo = customerRepository(), c = tidyCustomer(input);
  const bad = checkCustomer(c); if(bad) return bad;
  const dup = findDuplicate(repo.list(), c, id);
  if(dup) return { error: dup.by === "phone" ? `${dup.customer.name} already has this mobile number.` : `${dup.customer.name} already has this GSTIN.`, field: dup.by, duplicate: dup.customer };
  const old = id ? repo.get(id) : null;
  if(id && !old) return { error: "That customer no longer exists." };
  // a customer's own price list is a pricing decision: only someone who may change prices sets it (the list must exist)
  const pl = input && "priceList" in input ? (input.priceList || null) : undefined;
  if(pl !== undefined && pl !== ((old && old.priceList) || null)){
    if(!can("manage_products")) return { error: notAllowedText("give customers a price list"), field: "priceList" };
    if(pl && !(store.biz && store.biz.pl && store.biz.pl[pl])) return { error: "That price list no longer exists.", field: "priceList" };
  }
  const customer = Object.assign(old ? { ...old, ...c } : { id: "c" + uid(), ...c, t: Date.now() }, pl !== undefined ? { priceList: pl } : {});
  repo.save(customer);
  if(store.cartCust && store.cartCust.id === customer.id) setBillCustomer(customer);   // the open bill shows the new name/mobile
  return { customer, created: !old };
}
/* The customer on the bill being rung up: a saved customer, or null for a walk-in */
export function setBillCustomer(c){
  store.cartCust = c ? { id: c.id, name: c.name, phone: c.phone || "" } : null;
  saveCart();
  repriceCart();   // the customer's own price list (if any) now decides the bill's prices
}
