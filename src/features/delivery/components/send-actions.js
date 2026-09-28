// "Send to customer" on the payment screen and in the bill view: Email, WhatsApp and SMS, and what happened to each.
// "Sent" is shown only for what the server confirmed; WhatsApp without a provider opens WhatsApp on this device instead.
import { CHANNEL_LABELS, deliveryTarget } from '../../../domain/invoices/delivery.js';
import { D } from '../../inventory/services/ledger.js';
import { invoiceFor } from '../../receipts/services/receipt-model.js';
import { whatsappReceipt } from '../../receipts/services/receipt-output.js';
import { deliveriesOf, invoiceLink, loadChannels, loadDeliveryHistory, refreshDeliveryStatus, revokeInvoiceLinks, sendInvoice } from '../use-cases/send-invoice.js';
import { MAX_ATTEMPTS } from '../../../domain/invoices/delivery.js';
import { autoJobs, onDeliveryChange } from '../use-cases/auto-delivery.js';
import { store } from '../../../shared/state/store.js';
import { toast } from '../../../shared/components/toast.js';
import { $$, esc } from '../../../shared/dom.js';
import { hhmm } from '../../../shared/formatting/dates.js';

const verb={email:"Emailed",whatsapp:"Sent on WhatsApp",sms:"Sent by SMS"};
/* The receipts that go out by themselves when a bill completes, and where each one is */
function autoHTML(sid){
  return autoJobs(sid).map(j=>{
    const ch=esc(CHANNEL_LABELS[j.channel]), lab=`Receipt by ${ch}${j.after?` (after ${esc(CHANNEL_LABELS[j.after])} failed)`:""}`;
    if(j.status==="sent") return `<span class="dl-ok" data-auto="sent">✓ ${lab} sent automatically to ${esc(j.to||"")}</span>`;
    if(j.status==="delivered") return `<span class="dl-ok" data-auto="delivered">✓ ${lab} delivered to ${esc(j.to||"")}</span>`;
    if(j.status==="sending") return `<span class="dl-busy" data-auto="sending">Sending the receipt by ${ch}…</span>`;
    if(j.status==="failed") return `<span class="dl-err" data-auto="failed">${lab} not sent: ${esc(j.error||"")}</span> <button type="button" class="link xs" data-send="${esc(j.channel)}:${esc(sid)}">Send now</button>`;
    if(j.status==="skipped") return `<span class="dl-note" data-auto="skipped">${lab} skipped: ${esc(j.error||"")}</span>`;
    const why=j.wait==="offline"?"queued — goes out when you're back online":j.wait==="upload"?"queued — goes out once the bill has uploaded":j.attempts?`not sent yet (try ${j.attempts} of ${MAX_ATTEMPTS}), trying again at ${esc(hhmm(j.nextAt))}${j.error?": "+esc(j.error):""}`:"queued";
    return `<span class="dl-note" data-auto="queued">${lab}: ${why}</span>`;
  }).join("<br>");
}
/* One line about the latest attempt */
function stateHTML(sid){
  const e=deliveriesOf(sid)[0]; if(!e) return "";
  const s=D().saleById[sid], custId=s&&s.cust&&s.cust.id;
  if(e.status==="sending") return `<span class="dl-busy">Sending by ${esc(CHANNEL_LABELS[e.channel])}…</span>`;
  if(e.status==="sent") return `<span class="dl-ok">✓ ${verb[e.channel]} to ${esc(e.to)} · ${esc(hhmm(e.t))}</span>`;
  if(e.status==="opened") return `<span class="dl-note">WhatsApp opened on this device. Press Send there to send the bill.</span>`;
  if(e.status==="pending") return `<span class="dl-note">${esc(CHANNEL_LABELS[e.channel])} to ${esc(e.to||"")} · ${esc(hhmm(e.t))}: not confirmed yet (it may have gone out). Check with the customer before sending again.</span>`;
  return `<span class="dl-err">${esc(e.error||"Not sent.")}</span>`+
    (e.field==="contact"&&custId?` <button type="button" class="link xs" data-custedit="${esc(custId)}">Edit customer</button>`:"")+
    (e.status==="failed"?` <button type="button" class="link xs" data-send="${esc(e.channel)}:${esc(sid)}">Try again</button>`:"");
}
/* The send buttons for a bill (sale), with the note for walk-ins and the latest result */
export function sendBoxHTML(sale){
  const inv=invoiceFor(sale), sid=sale.id, walkIn=!inv.buyer, cancelled=inv.status==="cancelled";
  const btn=ch=>{const t=deliveryTarget(inv,ch), off=cancelled||(walkIn&&ch!=="whatsapp");return `<button type="button" class="btn sm" data-send="${ch}:${esc(sid)}" title="${esc(t.to?"To "+t.to:t.error)}"${off?" disabled data-off":""}>${CHANNEL_LABELS[ch]}</button>`};
  return `<div class="sendbox" data-sendbox="${esc(sid)}"><span class="sendh">Send to customer</span><div class="sendacts">${["email","whatsapp","sms"].map(btn).join("")}</div>`+
    `${cancelled?`<p class="note">A cancelled bill can't be sent.</p>`:walkIn?`<p class="note">Walk-in bill: add a customer to a bill to email or text it. WhatsApp opens on this device.</p>`:""}`+
    `<p class="sendstate" data-sendstate="${esc(sid)}" role="status">${both(sid)}</p></div>`;
}
const both=sid=>[autoHTML(sid),stateHTML(sid)].filter(Boolean).join("<br>");
export function renderSendState(sid){
  $$(`[data-sendstate="${sid}"]`).forEach(p=>{p.innerHTML=both(sid)});
  const busy=deliveriesOf(sid).some(e=>e.status==="sending");
  $$(`[data-sendbox="${sid}"] [data-send]`).forEach(b=>{ b.disabled=busy||b.hasAttribute("data-off"); });
}
/* A click on Email / WhatsApp / SMS */
export async function onSend(sid,channel){
  const s=D().saleById[sid]; if(!s||deliveriesOf(sid).some(e=>e.status==="sending")) return;
  // No WhatsApp provider on the server (or not known yet), or a walk-in bill (no saved customer to send it to): open
  // WhatsApp on this device, right in the click — a window opened after waiting would be blocked as a pop-up. The person
  // presses Send there; nothing is claimed as sent.
  if(channel==="whatsapp"&&(!(store.channels&&store.channels.whatsapp)||!(s.cust&&s.cust.name))){
    whatsappReceipt(sid);
    store.deliveries[sid]=[{channel,status:"opened",t:Date.now()},...deliveriesOf(sid)];
    renderSendState(sid); return;
  }
  const p=sendInvoice(sid,channel); renderSendState(sid);
  const r=await p;
  renderSendState(sid);
  if(r.ok) toast(`${verb[channel]} to ${r.to}.`);
}
/* The bill view's list of everything sent from this bill (loaded from the server when online) */
export function historyHTML(sid){
  // "pending" rows are attempts the server started but never confirmed: shown as not confirmed, never as sent
  const list=deliveriesOf(sid).filter(e=>e.id&&(e.status==="sent"||e.status==="delivered"||e.status==="failed"||e.status==="pending"));
  const mark={sent:"✓",delivered:"✓✓",pending:"?",failed:"✕"};
  const links=`<div class="setactions"><button type="button" class="btn xs" data-invlink="${esc(sid)}">Copy invoice link</button><button type="button" class="btn xs" data-invrevoke="${esc(sid)}">Revoke links</button>${list.some(e=>e.status==="sent")?`<button type="button" class="btn xs" data-dlrefresh="${esc(sid)}">Check delivery</button>`:""}</div>`;
  return `<div class="setsec dlhist"><h4>Sent to the customer</h4>${list.length?list.map(e=>`<div class="retline">${mark[e.status]||"✕"} <b>${esc(CHANNEL_LABELS[e.channel])}</b> · ${esc(e.to||"")} · ${esc(hhmm(e.t))}${e.mode==="auto"?" · automatic":""}${e.status==="delivered"?" · delivered":e.status==="failed"?` · not sent: ${esc(e.error||"")}`:e.status==="pending"?" · not confirmed":""}</div>`).join(""):`<p class="note">Nothing sent from this bill yet.</p>`}${links}</div>`;
}
export async function refreshHistory(sid){
  loadChannels();
  await loadDeliveryHistory(sid);
  $$(`[data-dlhist="${sid}"]`).forEach(h=>{h.innerHTML=historyHTML(sid)});
  renderSendState(sid);
}

/* "Check delivery": asks the providers whether the messages arrived */
export async function onDeliveryRefresh(sid){
  const r=await refreshDeliveryStatus(sid);
  if(r.error){ toast(r.error); return; }
  $$(`[data-dlhist="${sid}"]`).forEach(h=>{h.innerHTML=historyHTML(sid)});
  renderSendState(sid);
}
/* "Copy invoice link": the secure link to this bill, copied (or shown when copying isn't allowed) */
export async function onInvoiceLink(sid){
  const r=await invoiceLink(sid);
  if(r.error){ toast(r.error); return; }
  try{ await navigator.clipboard.writeText(r.url); toast("Invoice link copied. It shows only this bill, for 12 months."); }
  catch{ prompt("Invoice link (shows only this bill):",r.url); }
}
export async function onRevokeLinks(sid){
  if(!confirm("Stop every link to this bill from working? Customers who have the link won't be able to open it any more.")) return;
  const r=await revokeInvoiceLinks(sid);
  toast(r.error||"Links revoked. A new link can be made later.");
}
// automatic sends change in the background: the bill on screen follows them
onDeliveryChange(sid=>renderSendState(sid));
