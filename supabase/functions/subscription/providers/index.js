// The payment provider for Hangtag plans, chosen by the function's secrets. Another provider is another file here with the
// same shape: { name, createPayment, getPayment, verifyWebhook, readWebhook } and, for AutoPay, { getPlan, createAutopay,
// getAutopay, cancelAutopay }. Not configured → null: the app then says honestly that online payment isn't set up (it never
// shows a Pay button that cannot work). AutoPay also needs the provider's plan: autopayPlanId(env).
//   SUBSCRIPTION_PROVIDER=razorpay, SUBSCRIPTION_RAZORPAY_KEY_ID, SUBSCRIPTION_RAZORPAY_KEY_SECRET, SUBSCRIPTION_WEBHOOK_SECRET,
//   SUBSCRIPTION_RAZORPAY_AUTOPAY_PLAN_ID (a monthly plan at the AutoPay plan's price, made in the Razorpay dashboard)
import { razorpay } from "./razorpay.js";

const str = (v) => (v == null ? "" : String(v).trim());
/* The provider's plan AutoPay subscribes shops to, or "" (AutoPay not set up) */
export const autopayPlanId = (env) => { const id = str(env && env.SUBSCRIPTION_RAZORPAY_AUTOPAY_PLAN_ID); return /^plan_[A-Za-z0-9]{6,40}$/.test(id) ? id : ""; };
export function providerFor(env, fetchImpl = fetch, now = () => Date.now()) {
  const name = str(env.SUBSCRIPTION_PROVIDER).toLowerCase() || (str(env.SUBSCRIPTION_RAZORPAY_KEY_ID) ? "razorpay" : "");
  if (name === "razorpay") {
    const keyId = str(env.SUBSCRIPTION_RAZORPAY_KEY_ID), keySecret = str(env.SUBSCRIPTION_RAZORPAY_KEY_SECRET);
    if (!keyId || !keySecret) return null;
    return razorpay({ keyId, keySecret, webhookSecret: str(env.SUBSCRIPTION_WEBHOOK_SECRET) }, fetchImpl, now);
  }
  return null;
}
