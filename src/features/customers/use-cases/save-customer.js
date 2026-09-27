// SaveCustomer / SetBillCustomer: add or edit a customer (checked, never a second copy of the same mobile or GSTIN), and
// put a customer on the bill being rung up (or none: a walk-in).
import { store } from '../../../shared/state/store.js';
import { checkCustomer, findDuplicate, tidyCustomer } from '../../../domain/customers/customer.js';
import { customerRepository } from '../repositories/customer-repository.js';
import { saveCart } from '../../../shared/state/persistence.js';
import { uid } from '../../../shared/utils/ids.js';

/* input: form values; id: the customer being edited (none = new).
   → { error, field, duplicate? } (nothing saved) or { customer, created } */
export function saveCustomer(input, { id } = {}){
  const repo = customerRepository(), c = tidyCustomer(input);
  const bad = checkCustomer(c); if(bad) return bad;
  const dup = findDuplicate(repo.list(), c, id);
  if(dup) return { error: dup.by === "phone" ? `${dup.customer.name} already has this mobile number.` : `${dup.customer.name} already has this GSTIN.`, field: dup.by, duplicate: dup.customer };
  const old = id ? repo.get(id) : null;
  if(id && !old) return { error: "That customer no longer exists." };
  const customer = old ? { ...old, ...c } : { id: "c" + uid(), ...c, t: Date.now() };
  repo.save(customer);
  if(store.cartCust && store.cartCust.id === customer.id) setBillCustomer(customer);   // the open bill shows the new name/mobile
  return { customer, created: !old };
}
/* The customer on the bill being rung up: a saved customer, or null for a walk-in */
export function setBillCustomer(c){
  store.cartCust = c ? { id: c.id, name: c.name, phone: c.phone || "" } : null;
  saveCart();
}
