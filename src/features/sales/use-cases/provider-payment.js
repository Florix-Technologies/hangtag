// Verified payments through the payment provider ("paymentGateway" port): a single-use UPI QR, or a card payment link the
// customer opens on their own phone, for one part of the bill. The QR being on screen changes nothing: the part counts
// only once the provider says the money arrived ("verified"). A payment still open when the app closes is kept
// (store.payPending) and picked up again when it reopens. UPI checked by hand is matched to the provider's payments
// later (verifyManualUpi), when the bill has uploaded.
import { store } from '../../../shared/state/store.js';
import { use } from '../../../shared/di/services.js';
import { savePayPending } from '../../../shared/state/persistence.js';
import { ERROR_CODES, userMessage } from '../../../shared/errors/app-error.js';
import { logger } from '../../../shared/logging/logger.js';
import { uid } from '../../../shared/utils/ids.js';
import { paymentsOf } from '../../../domain/sales/payments.js';
import { normalizeProviderConfig, normalizeProviderIntent } from '../../../domain/sales/payment-provider.js';

export const gateway = () => use("paymentGateway");
export const paymentProvider = gateway;
const providerCall = (modern, legacy, ...args) => {
  const provider = paymentProvider(), fn = provider[modern] || provider[legacy];
  if(typeof fn !== 'function') throw new Error(`The payment provider does not support ${modern}.`);
  return fn.apply(provider, args);
};
const online = () => !!store.sbClient && store.sbStatus === "connected";
const OPEN = ["starting", "pending"];
export const isOpen = I => !!I && OPEN.includes(I.status);

/* What the provider can take ({ provider, upi, cardLink }); asked once per session, null while unknown or offline */
export async function loadPayConfig(force){
  if((store.payConfig && !force) || !online()) return store.payConfig;
  try{ store.payConfig = normalizeProviderConfig(await paymentProvider().config()); }
  catch(e){
    logger.event("payment", "start-failed", { op: "provider", code: e && e.code });
    // not set up (or the function isn't deployed): known for this session; anything else is asked again next time
    store.payConfig = e && e.code === ERROR_CODES.NOT_CONFIGURED ? { provider: null, upi: false, cardLink: false } : null;
  }
  return store.payConfig;
}
/* Can this part be taken through the provider right now? */
export const providerReady = method => online() && !!store.payConfig && (method === "upi" ? store.payConfig.upi : method === "card" ? store.payConfig.cardLink : false);

/* The bill's id, fixed at the first provider request, so the provider's record points at the bill that is saved */
export function billIdForPayment(){
  const s = store.payState;
  if(!s.saleId) s.saleId = uid();
  return s.saleId;
}
/* Keeps open intents across a closed app (the cart is kept already) */
export function persistPending(){
  const s = store.payState, pi = s && s.pi ? Object.fromEntries(Object.entries(s.pi).filter(([, I]) => I && I.id && I.status !== "cancelled")) : {};
  store.payPending = s && Object.keys(pi).length ? { saleId: s.saleId, mode: s.mode, method: s.method, via: s.via, amt: s.amt, pi, t: Date.now() } : null;
  savePayPending();
}
export function clearPending(){ store.payPending = null; savePayPending(); }

/* Starts a QR ("upi") or card link ("card") for `amount` → the intent, or { error, unavailable } (unavailable: offer the
   hand-checked way instead). An open intent for the same part is closed first. */
export async function startIntent(method, amount){
  const s = store.payState; if(!s) return { error: "Open the payment screen first." };
  if(!(+amount > 0)) return { error: "Enter the amount for this part first." };
  if(!online()) return { error: "You're offline, so the payment can't be verified. Check it by hand instead.", unavailable: true };
  if(!providerReady(method)) return { error: "Verified payments aren't set up for this shop.", unavailable: true };
  const old = s.pi[method];
  if(isOpen(old) && old.id){ const c = await cancelIntent(method); if(c && c.status === "verified") return c; }
  s.pi[method] = { status: "starting", method, amount: +amount };
  try{
    const request = { method, amount: +amount, saleId: billIdForPayment(), note: s.note || "", expiryMin: store.settings.payExpiry || 5 };
    const raw = method === 'upi' ? await providerCall('createDynamicQr', 'create', request) : await providerCall('createPayment', 'create', request);
    const I = normalizeProviderIntent(raw);
    if(store.payState !== s) return I;
    s.pi[method] = I; persistPending();
    return I;
  }catch(e){
    const unavailable = !e || [ERROR_CODES.NOT_CONFIGURED, ERROR_CODES.NETWORK, ERROR_CODES.AUTH].includes(e.code);
    const error = userMessage(e, "The payment couldn't be started.");
    if(store.payState === s) s.pi[method] = { status: "error", method, amount: +amount, error, unavailable };
    return { error, unavailable };
  }
}
/* Asks the provider about an open intent; the part changes only with what the provider says */
export async function checkIntent(method){
  const s = store.payState, I = s && s.pi[method];
  if(!I || !I.id || !isOpen(I)) return I;
  try{
    const N = normalizeProviderIntent(await providerCall('getStatus', 'status', I.id));
    if(store.payState === s && s.pi[method] && s.pi[method].id === N.id){ s.pi[method] = N; persistPending(); }
    return N;
  }catch(e){
    logger.event("payment", "status-failed", { op: "provider", code: e && e.code }, "warn");
    if(store.payState === s && s.pi[method]) s.pi[method].checkError = userMessage(e, "Couldn't check the payment. Retrying…");
    return I;
  }
}
/* Closes an open intent. When the money had already arrived the answer is "verified" and the part is kept. */
export async function cancelIntent(method){
  const s = store.payState, I = s && s.pi[method];
  if(!I) return null;
  if(!I.id || !isOpen(I)){ if(I.status !== "verified") delete s.pi[method]; persistPending(); return I; }
  try{
    const N = normalizeProviderIntent(await providerCall('cancelPayment', 'cancel', I.id));
    if(store.payState === s){ if(N.status === "verified") s.pi[method] = N; else delete s.pi[method]; persistPending(); }
    return N;
  }catch(e){
    logger.event("payment", "cancel-failed", { op: "provider", code: e && e.code }, "warn");
    // couldn't reach the server: the provider closes it at its expiry anyway; money that still arrives shows as unmatched
    if(store.payState === s){ delete s.pi[method]; persistPending(); }
    return { status: "cancelled", error: userMessage(e, "Couldn't close the payment at the provider.") };
  }
}
/* Payment screen closed without a sale: open intents are closed (money that still arrives is kept as unmatched).
   keepVerified: payments the provider already confirmed stay with the bill (store.payPending), so opening Pay again
   completes the sale with them; they are never dropped. → the verified intents kept */
export async function abandonIntents(state, { keepVerified = false } = {}){
  const s = state || store.payState; if(!s || !s.pi) return [];
  const open = Object.values(s.pi).filter(I => I && I.id && isOpen(I));
  const verified = Object.entries(s.pi).filter(([, I]) => I && I.id && I.status === "verified");
  if(keepVerified && verified.length){
    store.payPending = { saleId: s.saleId, mode: s.mode, method: s.method, via: s.via, amt: s.amt, pi: Object.fromEntries(verified), t: Date.now() };
    savePayPending();
  }else if(open.length || store.payPending) clearPending();
  await Promise.all(open.map(I => providerCall('cancelPayment', 'cancel', I.id).catch(e => logger.event("payment", "cancel-failed", { op: "provider", code: e && e.code }, "warn"))));
  return verified.map(([, I]) => I);
}

/* After a restart: the bill that was waiting for a provider payment, restored as it was → the pay state, or null */
export function pendingPayState(){
  const P = store.payPending;
  if(!P || !P.pi || !store.cart.length) return null;
  return { mode: P.mode === "split" ? "split" : "single", method: P.method || "upi", recv: "", ref: { upi: "", card: "" }, last4: "",
    amt: Object.assign({ cash: "", upi: "", card: "" }, P.amt || {}), via: Object.assign({ upi: "manual", card: "terminal" }, P.via || {}),
    pi: P.pi, saleId: P.saleId, err: "", restored: true };
}

/* UPI parts checked by hand, matched to the provider's payments once their bill is in the cloud. Each match upgrades the
   part to "verified" on this device (the server has already upgraded its copy). → the number verified */
export async function verifyManualUpi(sales){
  if(!online() || !store.payConfig || !store.payConfig.upi) return 0;
  const queued = new Set(store.sbOfflineQueue.filter(q => q.type === "sale" && q.sale).map(q => q.sale.id));
  let n = 0;
  for(const s of sales || []){
    if(s.void || queued.has(s.id)) continue;
    const p = paymentsOf(s).find(x => x.method === "upi" && x.verification === "unverified" && x.ref && !(Date.now() - (x.checkedAt || 0) < 3600e3));
    if(!p) continue;
    try{
      const r = await providerCall('verifyPayment', 'verify', { saleId: s.id, reference: p.ref });
      p.checkedAt = Date.now();
      if(r && r.status === "verified"){ p.verification = "verified"; p.intent = r.intentId || p.intent; p.providerRef = r.paymentId || p.providerRef; n++; }
    }catch(e){ logger.event("payment", "upi-check-failed", { op: "provider", code: e && e.code }, "warn"); if(e && e.code === ERROR_CODES.NOT_CONFIGURED) break; }
  }
  return n;
}
