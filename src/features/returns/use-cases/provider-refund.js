// A return's refund sent back through the payment provider, onto the bill's own verified UPI or card payment (instead of
// paying it out by hand). The return is uploaded first; the function refunds the return's saved amount once and keeps
// the provider's refund id on it, so a retry never refunds twice.
import { paymentsOf } from '../../../domain/sales/payments.js';
import { store } from '../../../shared/state/store.js';
import { use } from '../../../shared/di/services.js';
import { saveReturns } from '../../../shared/state/persistence.js';
import { flushSbQueue } from '../../sync/services/outbox.js';
import { invalidate } from '../../inventory/services/ledger.js';
import { userMessage } from '../../../shared/errors/app-error.js';

const online=()=>!!store.sbClient&&store.sbStatus==="connected";
/* Can a refund by `method` go back through the provider? (the bill was paid that way and the provider verified it) */
export const canRefundThroughProvider=(sale,method)=>online()&&!!store.payConfig&&(method==="upi"||method==="card")&&
  paymentsOf(sale||{}).some(p=>p.method===method&&p.verification==="verified"&&p.providerRef);
/* → { refundId } or { error } (then the customer is refunded by hand, as recorded on the return) */
export async function refundThroughProvider(ret){
  if(!online()) return {error:"You're offline, so the refund can't go through the payment provider. Refund the customer by hand."};
  await flushSbQueue();
  if(store.sbOfflineQueue.some(q=>q.type==="return"&&q.id===ret.id)) return {error:"The return is still uploading. Refund through the provider from the bill once it has uploaded, or refund by hand."};
  try{
    const provider=use("paymentGateway"), r=provider.refund
      ? await provider.refund({returnId:ret.id})
      : await provider.refundReturn(ret.id);
    const kept=store.returnsMap[ret.id]; if(kept){ kept.providerRefund=r.refundId; saveReturns(); invalidate(); }
    return {refundId:r.refundId};
  }catch(e){ return {error:userMessage(e,"The provider didn't take the refund. Refund the customer by hand.")}; }
}
