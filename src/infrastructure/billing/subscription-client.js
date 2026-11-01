// The "subscriptionService" port: the shop's Hangtag plan. Status, plans (with the offers the shop may take), promo quotes,
// AutoPay's terms and payment history come from the database (schema.sql sections 3t and 3w, as the signed-in person);
// checkout, verify and AutoPay (start with the owner's consent, verify, cancel) go through the subscription Edge Function.
// Prices, discounts and amounts are always the server's — this client never sends one.
import { ERROR_CODES } from '../../shared/errors/app-error.js';

/* cloud: the cloud gateway (subscriptionStatus, subscriptionPlans, subscriptionQuote, subscriptionPayments, subscriptionAutopayQuote,
   subscriptionCall) */
export function createSubscriptionClient({ cloud }){
  return Object.freeze({
    status: () => cloud.subscriptionStatus(),
    plans: () => cloud.subscriptionPlans(),
    quote: (plan, promo) => cloud.subscriptionQuote(plan, promo),
    payments: () => cloud.subscriptionPayments(),
    /* AutoPay's terms for the owner's shop: { available, plan, price, currency, today, first_charge_at, consent_version, status } */
    autopayQuote: () => cloud.subscriptionAutopayQuote(),
    /* Is online payment (and AutoPay) set up? Never throws: not deployed / not set up / unreachable → not available */
    async config(){
      try{
        const r = await cloud.subscriptionCall({ action: "config" }), verify = +(r && r.autopay_verify);
        // autopay_verify: what UPI or a card takes to confirm AutoPay (₹, refunded), shown before the owner agrees
        return { available: !!(r && r.available), provider: (r && r.provider) || null, autopay: !!(r && r.autopay),
          ...(r && r.autopay && verify > 0 && verify <= 100 ? { autopay_verify: verify } : {}) };
      }
      catch(e){ return { available: false, provider: null, autopay: false, reason: e && e.code === ERROR_CODES.NOT_CONFIGURED ? "not_configured" : "unreachable" }; }
    },
    /* AutoPay with the owner's consent to the terms of this version → { auth_url, first_charge_at, today, price } */
    /* phone: the payer's mobile number for the mandate, when the server asked for one (phone_required) */
    autopayStart: (consentVersion, phone) => cloud.subscriptionCall({ action: "autopay_start", consent: true, consent_version: consentVersion, ...(phone ? { phone } : {}) }),
    autopayVerify: () => cloud.subscriptionCall({ action: "autopay_verify" }),
    autopayCancel: () => cloud.subscriptionCall({ action: "autopay_cancel" }),
    /* phone: the payer's mobile number for this payment, when the server asked for one (phone_required) */
    checkout: (plan, promo, phone) => cloud.subscriptionCall({ action: "checkout", plan, promo: promo || "", ...(phone ? { phone } : {}) }),
    verify: paymentId => cloud.subscriptionCall({ action: "verify", payment_id: paymentId }),
  });
}
