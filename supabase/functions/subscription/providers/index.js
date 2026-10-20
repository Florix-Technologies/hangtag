// The payment providers for Hangtag plans, chosen by the function's secrets. A provider is a file here with the same
// shape: { name, mode, createPayment, getPayment, verifyWebhook, readWebhook, eventIdOf, webhookReady } and, for AutoPay,
// { getPlan, createAutopay, getAutopay, cancelAutopay }. Not configured → null: the app then says honestly that online
// payment isn't set up (it never shows a Pay button that cannot work).
//   Plan payments: SUBSCRIPTION_PROVIDER = razorpay (the default when its key is set) or cashfree.
//   - razorpay: SUBSCRIPTION_RAZORPAY_KEY_ID, SUBSCRIPTION_RAZORPAY_KEY_SECRET, SUBSCRIPTION_WEBHOOK_SECRET
//   - cashfree: SUBSCRIPTION_CASHFREE_APP_ID, SUBSCRIPTION_CASHFREE_SECRET_KEY, SUBSCRIPTION_CASHFREE_ENV (sandbox or
//     production)
//   Test credentials (Razorpay rzp_test_…, Cashfree's sandbox) move no money, so they are accepted only on a test project
//   (SUBSCRIPTION_TEST_MODE=true), and live ones never there: a test payment can't add paid time to a real shop, and a
//   test project can't take real money.
//   AutoPay stays Razorpay Subscriptions (SUBSCRIPTION_RAZORPAY_AUTOPAY_PLAN_ID, a monthly plan at the AutoPay plan's
//   price made in the Razorpay dashboard), whichever provider takes plan payments.
// A payment already made is always checked with the provider that took it (providerNamed), so changing the provider never
// strands a payment or a notification still on its way.
import { razorpay } from "./razorpay.js";
import { cashfree } from "./cashfree.js";

const str = (v) => (v == null ? "" : String(v).trim());
const testProject = (env) => str(env && env.SUBSCRIPTION_TEST_MODE).toLowerCase() === "true";
/* The provider's plan AutoPay subscribes shops to, or "" (AutoPay not set up) */
export const autopayPlanId = (env) => { const id = str(env && env.SUBSCRIPTION_RAZORPAY_AUTOPAY_PLAN_ID); return /^plan_[A-Za-z0-9]{6,40}$/.test(id) ? id : ""; };
/* Razorpay's keys' mode, from their prefix: "live", "test" (only on a test project), or null */
export function keyMode(env) {
  const keyId = str(env && env.SUBSCRIPTION_RAZORPAY_KEY_ID), test = testProject(env);
  if (/^rzp_live_[A-Za-z0-9]+$/.test(keyId)) return test ? null : "live";
  if (/^rzp_test_[A-Za-z0-9]+$/.test(keyId)) return test ? "test" : null;
  return null;
}
/* Cashfree's environment: SUBSCRIPTION_CASHFREE_ENV, else the sandbox on a test project and production otherwise — and
   null when it's something else, when the sandbox is asked for outside a test project or production inside one, or when
   the secret key itself says the other environment (cfsk_ma_test_… / cfsk_ma_prod_…) */
export function cashfreeEnv(env) {
  const test = testProject(env), mode = str(env && env.SUBSCRIPTION_CASHFREE_ENV).toLowerCase() || (test ? "sandbox" : "production");
  if (mode !== "sandbox" && mode !== "production") return null;
  if ((mode === "sandbox") !== test) return null;
  const secret = str(env && env.SUBSCRIPTION_CASHFREE_SECRET_KEY).toLowerCase();
  if ((mode === "sandbox" && secret.startsWith("cfsk_ma_prod_")) || (mode === "production" && secret.startsWith("cfsk_ma_test_"))) return null;
  return mode;
}
/* A provider by name, when its keys are set and allowed here; null otherwise */
export function providerNamed(name, env, fetchImpl = fetch, now = () => Date.now()) {
  const n = str(name).toLowerCase();
  if (n === "razorpay") {
    const keyId = str(env.SUBSCRIPTION_RAZORPAY_KEY_ID), keySecret = str(env.SUBSCRIPTION_RAZORPAY_KEY_SECRET), mode = keyMode(env);
    if (!keyId || !keySecret || !mode) return null;
    return { ...razorpay({ keyId, keySecret, webhookSecret: str(env.SUBSCRIPTION_WEBHOOK_SECRET) }, fetchImpl, now), mode };
  }
  if (n === "cashfree") {
    const appId = str(env.SUBSCRIPTION_CASHFREE_APP_ID), secretKey = str(env.SUBSCRIPTION_CASHFREE_SECRET_KEY), mode = cashfreeEnv(env);
    if (!appId || !secretKey || !mode) return null;
    return cashfree({ appId, secretKey, env: mode }, fetchImpl, now);
  }
  return null;
}
/* The provider that takes plan payments now */
export function providerFor(env, fetchImpl = fetch, now = () => Date.now()) {
  const name = str(env.SUBSCRIPTION_PROVIDER).toLowerCase() || (str(env.SUBSCRIPTION_RAZORPAY_KEY_ID) ? "razorpay" : "");
  return providerNamed(name, env, fetchImpl, now);
}
/* AutoPay's provider: Razorpay with Hangtag's keys and the AutoPay plan, or null (AutoPay not set up) */
export function autopayProviderFor(env, fetchImpl = fetch, now = () => Date.now()) {
  if (!autopayPlanId(env)) return null;
  const p = providerNamed("razorpay", env, fetchImpl, now);
  return p && typeof p.createAutopay === "function" ? p : null;
}
/* The provider a notification comes from, by the signature header it carries (each checks it with its own secret) */
export function webhookProviderFor(env, headers, fetchImpl = fetch, now = () => Date.now()) {
  const h = headers || {};
  if (h["x-webhook-signature"]) return providerNamed("cashfree", env, fetchImpl, now);
  if (h["x-razorpay-signature"]) return providerNamed("razorpay", env, fetchImpl, now);
  return null;
}
