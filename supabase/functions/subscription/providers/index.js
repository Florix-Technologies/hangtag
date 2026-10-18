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
/* The keys' mode, from their prefix. Test keys move no money, so they are accepted only where the project says it is a
   test project (SUBSCRIPTION_TEST_MODE=true), and live keys never there: a test payment can't add paid time to a real
   shop, and a test project can't take real money. Any other key → not configured. */
export function keyMode(env) {
  const keyId = str(env && env.SUBSCRIPTION_RAZORPAY_KEY_ID), test = str(env && env.SUBSCRIPTION_TEST_MODE).toLowerCase() === "true";
  if (/^rzp_live_[A-Za-z0-9]+$/.test(keyId)) return test ? null : "live";
  if (/^rzp_test_[A-Za-z0-9]+$/.test(keyId)) return test ? "test" : null;
  return null;
}
export function providerFor(env, fetchImpl = fetch, now = () => Date.now()) {
  const name = str(env.SUBSCRIPTION_PROVIDER).toLowerCase() || (str(env.SUBSCRIPTION_RAZORPAY_KEY_ID) ? "razorpay" : "");
  if (name === "razorpay") {
    const keyId = str(env.SUBSCRIPTION_RAZORPAY_KEY_ID), keySecret = str(env.SUBSCRIPTION_RAZORPAY_KEY_SECRET), mode = keyMode(env);
    if (!keyId || !keySecret || !mode) return null;
    return { ...razorpay({ keyId, keySecret, webhookSecret: str(env.SUBSCRIPTION_WEBHOOK_SECRET) }, fetchImpl, now), mode };
  }
  return null;
}
