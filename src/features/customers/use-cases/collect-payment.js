// CollectPayment: money a customer pays towards what they owe (cash, UPI or card), never more than they owe. Kept on this
// device first, then uploaded; the database posts it to the cash or bank book like a bill's payment (and the app's books
// show it the same way). Only the owner can cancel one (a mistake), which takes it out of the balances.
import { checkCollection } from '../../../domain/customers/credit.js';
import { store } from '../../../shared/state/store.js';
import { accountOf } from '../services/customer-account.js';
import { creditRepository } from '../repositories/credit-repository.js';
import { customerRepository } from '../repositories/customer-repository.js';
import { renderSync } from '../../sync/components/sync-status.js';
import { flushSbQueue } from '../../sync/services/outbox.js';
import { uid } from '../../../shared/utils/ids.js';
import { denied, isMember, notAllowedText } from '../../shop/services/access.js';

const upload = () => { renderSync(); flushSbQueue(); };
/* input: { amount, method: "cash" | "upi" | "card", ref?, note? } → { collection, outstanding } or { error, field } (nothing saved) */
export function collectPayment(cid, input){
  const no = denied("collect_credit", "collect payments from customers"); if(no) return no;
  if(!customerRepository().get(cid)) return { error: "That customer isn't on this device." };
  const r = checkCollection(input, accountOf(cid).outstanding);
  if(r.error) return r;
  const c = { id: "col" + uid(), cust: cid, ...r.collection, t: Date.now(), dev: store.dev, status: "posted", ...(store.authUser ? { user: store.authUser.id } : {}) };
  creditRepository().record(c); upload();
  return { collection: c, outstanding: accountOf(cid).outstanding };
}
/* The owner takes a wrong entry back → { ok } or { error } */
export function cancelCollection(id){
  if(isMember()) return { error: notAllowedText("cancel a payment collected") };
  const c = creditRepository().get(id); if(!c) return { error: "That payment isn't on this device." };
  if(c.status === "cancelled") return { ok: true };
  creditRepository().cancel(id); upload();
  return { ok: true };
}
