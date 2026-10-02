// SendQuotation: a quotation goes to its customer by email or WhatsApp through the "messageDelivery" port (Edge Function
// send-receipt: the same providers and delivery log as bills; the server writes the message from the saved quotation and
// sends it to the customer's saved email / mobile). Each press of Send is one job with its own request id, kept on this
// device (store.quoteSends) until it has gone: Queued (offline, or the quotation or its customer still uploading) →
// Sending → Sent, or Failed. The server uses a request id once, so a retry or a second run of the queue never sends the
// same press twice; a quotation still a draft becomes "sent" once a message is accepted. Nothing is shown as sent
// unless the provider accepted it. Sharing the PDF from the phone stays available (components/quotation-document.js).
import { QUOTE_CHANNELS, quoteTarget } from '../../../domain/orders/orders.js';
import { store } from '../../../shared/state/store.js';
import { messageDelivery } from '../../delivery/repositories/delivery-service.js';
import { orderById, setOrderStatus } from './orders.js';
import { hasCap } from '../../shop/services/shop-caps.js';
import { denied } from '../../shop/services/access.js';
import { saveQuoteSends } from '../../../shared/state/persistence.js';
import { ERROR_CODES, userMessage } from '../../../shared/errors/app-error.js';
import { logger } from '../../../shared/logging/logger.js';
import { uid } from '../../../shared/utils/ids.js';

const MAX_ATTEMPTS = 5, KEEP = 200;
const online = () => !!store.sbClient && store.sbStatus === "connected";
const jobs = () => store.quoteSends || (store.quoteSends = []);
const listeners = new Set();
/* The quotation's send sheet redraws when its jobs change */
export const onQuoteSendChange = f => { listeners.add(f); return () => listeners.delete(f); };
const changed = id => { saveQuoteSends(); listeners.forEach(f => { try{ f(id); }catch(e){ logger.warn(e); } }); };

/* This device's sends of a quotation, newest first */
export const quoteSendsOf = id => jobs().filter(j => j.orderId === id).sort((a, b) => b.t - a.t);
/* May the server send quotations on this channel? true / false, or null while that isn't known (offline) */
export const quoteChannelReady = channel => store.channels ? store.channels["quote_" + channel] === true : null;
/* The quotation's customer as saved in Customers (the server sends to that record, never to a typed address) */
export function quoteCustomer(o){
  const c = o && o.cust; if(!c || !c.id) return null;
  const saved = store.customers && store.customers[c.id] || {};
  return { name: saved.name || c.name || "", email: saved.email || c.email || "", phone: saved.phone || c.phone || "" };
}
/* Where it would go: { to } or { error } */
export const quoteSendTarget = (o, channel) => quoteTarget(quoteCustomer(o), channel);

/* One press of Send → { job } (queued; it goes as soon as it can) or { error } (nothing queued) */
export function sendQuotation(id, channel){
  const no = denied("create_order", "send quotations"); if(no) return no;
  if(!hasCap("uses_quotations")) return { error: "Quotations are switched off for this shop." };
  const o = orderById(id); if(!o || o.kind !== "quote") return { error: "That quotation isn't on this device." };
  if(o.status === "cancelled") return { error: "A cancelled quotation can't be sent." };
  const label = QUOTE_CHANNELS[channel]; if(!label) return { error: "Choose email or WhatsApp." };
  const t = quoteSendTarget(o, channel); if(t.error) return t;
  if(quoteChannelReady(channel) === false) return { error: `Sending quotations by ${label} isn't set up on the server yet. Use Share PDF instead.` };
  if(quoteSendsOf(id).some(j => j.channel === channel && (j.status === "queued" || j.status === "sending"))) return { error: `This quotation is already waiting to go by ${label}.` };
  const now = Date.now();
  const job = { id: uid(), requestId: "q" + uid() + uid(), orderId: id, no: o.no || "", channel, to: t.to, status: "queued", attempts: 0, t: now };
  jobs().push(job);
  if(jobs().length > KEEP) store.quoteSends = jobs().filter(j => j.status === "queued" || j.status === "sending").concat(jobs().filter(j => j.status !== "queued" && j.status !== "sending").slice(-KEEP));
  changed(id);
  processQuoteSends();
  return { job };
}
/* A failed send tried again: a new press (a new request id), so the server sends it afresh */
export const retryQuoteSend = jobId => { const j = jobs().find(x => x.id === jobId); return j ? sendQuotation(j.orderId, j.channel) : { error: "That send wasn't found." }; };

/* Still uploading: the quotation (or its customer) must reach the cloud before the server can write the message */
function uploading(j){
  const o = orderById(j.orderId), q = store.sbOfflineQueue || [];
  return q.some(x => x && x.type === "order" && x.id === j.orderId) || !!(o && o.cust && o.cust.id && q.some(x => x && x.type === "cust" && x.id === o.cust.id));
}
const temporary = e => { const why = e && e.details && e.details.error;
  return why === "busy" || why === "not_found" || why === "rate_limited" || !e || [ERROR_CODES.NETWORK, ERROR_CODES.AUTH, ERROR_CODES.UNKNOWN].includes(e.code); };
let running = null, retryT = null, recovered = false;
const later = ms => { clearTimeout(retryT); retryT = setTimeout(() => processQuoteSends(), ms); };
/* Sends every queued job that can go now. Safe to call often: one run at a time. */
export function processQuoteSends(){
  if(!running) running = run().finally(() => { running = null; });
  return running;
}
async function run(){
  // a send the app was closed in the middle of goes again (the server answers a request id it already handled with its result)
  if(!recovered){ recovered = true; jobs().forEach(j => { if(j.status === "sending") j.status = "queued"; }); }
  for(const j of jobs().filter(x => x.status === "queued")){
    if(!online()){ if(j.wait !== "offline"){ j.wait = "offline"; changed(j.orderId); } continue; }
    if(uploading(j)){ if(j.wait !== "upload"){ j.wait = "upload"; changed(j.orderId); } later(4000); continue; }
    j.status = "sending"; delete j.wait; j.attempts = (j.attempts || 0) + 1; changed(j.orderId);
    try{
      const r = await messageDelivery().sendQuote({ channel: j.channel, orderId: j.orderId, requestId: j.requestId });
      Object.assign(j, { status: r.status === "delivered" ? "delivered" : "sent", to: r.to || j.to, provider: r.provider || "", sentAt: Date.now() }); delete j.error;
      const o = orderById(j.orderId);
      if(o && o.status === "draft") setOrderStatus(o.id, "sent");
    }catch(e){
      const msg = userMessage(e, "The quotation wasn't sent. Try again.");
      if(temporary(e) && j.attempts < MAX_ATTEMPTS){ Object.assign(j, { status: "queued", wait: "retry", error: msg }); later(Math.min(60000, 5000 * j.attempts)); }
      else Object.assign(j, { status: "failed", error: msg, failedAt: Date.now(), ...(e && e.code === ERROR_CODES.NOT_CONFIGURED ? { unavailable: true } : {}) });
    }
    changed(j.orderId);
  }
}
/* What the server recorded for the quotation (sends from any phone), newest first; [] offline */
export async function quoteHistory(id){
  if(!online()) return [];
  try{ return await messageDelivery().quoteHistory(id); }catch(e){ logger.warn("Quotation history:", e); return []; }
}
