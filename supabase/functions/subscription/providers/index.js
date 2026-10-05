// The payment provider for Hangtag plans, chosen by the function's secrets. Another provider is another file here with the
// same shape: { name, createPayment, getPayment, verifyWebhook, readWebhook }. Not configured → null: the app then says
// honestly that online payment isn't set up (it never shows a Pay button that cannot work).
//   SUBSCRIPTION_PROVIDER=razorpay, SUBSCRIPTION_RAZORPAY_KEY_ID, SUBSCRIPTION_RAZORPAY_KEY_SECRET, SUBSCRIPTION_WEBHOOK_SECRET
import { razorpay } from "./razorpay.js";

const str = (v) => (v == null ? "" : String(v).trim());
export function providerFor(env, fetchImpl = fetch, now = () => Date.now()) {
  const name = str(env.SUBSCRIPTION_PROVIDER).toLowerCase() || (str(env.SUBSCRIPTION_RAZORPAY_KEY_ID) ? "razorpay" : "");
  if (name === "razorpay") {
    const keyId = str(env.SUBSCRIPTION_RAZORPAY_KEY_ID), keySecret = str(env.SUBSCRIPTION_RAZORPAY_KEY_SECRET);
    if (!keyId || !keySecret) return null;
    return razorpay({ keyId, keySecret, webhookSecret: str(env.SUBSCRIPTION_WEBHOOK_SECRET) }, fetchImpl, now);
  }
  return null;
}
