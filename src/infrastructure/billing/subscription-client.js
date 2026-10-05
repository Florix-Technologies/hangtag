// The "subscriptionService" port: the shop's Hangtag plan. Status, plans, promo quotes and payment history come from the
// database (schema.sql section 3t, as the signed-in person); checkout and verify go through the subscription Edge
// Function. Prices, discounts and amounts are always the server's — this client never sends one.
import { ERROR_CODES } from '../../shared/errors/app-error.js';

/* cloud: the cloud gateway (subscriptionStatus, subscriptionPlans, subscriptionQuote, subscriptionPayments, subscriptionCall) */
export function createSubscriptionClient({ cloud }){
  return Object.freeze({
    status: () => cloud.subscriptionStatus(),
    plans: () => cloud.subscriptionPlans(),
    quote: (plan, promo) => cloud.subscriptionQuote(plan, promo),
    payments: () => cloud.subscriptionPayments(),
    /* Is online payment set up? Never throws: not deployed / not set up / unreachable → not available */
    async config(){
      try{ const r = await cloud.subscriptionCall({ action: "config" }); return { available: !!(r && r.available), provider: (r && r.provider) || null }; }
      catch(e){ return { available: false, provider: null, reason: e && e.code === ERROR_CODES.NOT_CONFIGURED ? "not_configured" : "unreachable" }; }
    },
    checkout: (plan, promo) => cloud.subscriptionCall({ action: "checkout", plan, promo: promo || "" }),
    verify: paymentId => cloud.subscriptionCall({ action: "verify", payment_id: paymentId }),
  });
}
