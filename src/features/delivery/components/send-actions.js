// "Send to customer" on the payment screen and in the bill view: Email, WhatsApp and SMS, and what happened to each.
// "Sent" is shown only for what the server confirmed; WhatsApp without a provider opens WhatsApp on this device instead.
import { CHANNEL_LABELS, deliveryTarget } from '../../../domain/invoices/delivery.js';
import { D } from '../../inventory/services/ledger.js';
import { invoiceFor } from '../../receipts/services/receipt-model.js';
import { whatsappReceipt } from '../../receipts/services/receipt-output.js';
import { deliveriesOf, loadChannels, loadDeliveryHistory, sendInvoice } from '../use-cases/send-invoice.js';
import { store } from '../../../shared/state/store.js';
import { toast } from '../../../shared/components/toast.js';
import { $$, esc } from '../../../shared/dom.js';
import { hhmm } from '../../../shared/formatting/dates.js';

const verb={email:"Emailed",whatsapp:"Sent on WhatsApp",sms:"Sent by SMS"};
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
    `<p class="sendstate" data-sendstate="${esc(sid)}" role="status">${stateHTML(sid)}</p></div>`;
}
export function renderSendState(sid){
  $$(`[data-sendstate="${sid}"]`).forEach(p=>{p.innerHTML=stateHTML(sid)});
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
  const list=deliveriesOf(sid).filter(e=>e.status==="sent"||e.status==="failed"||(e.status==="pending"&&e.id));
  return list.length?`<div class="setsec dlhist"><h4>Sent to the customer</h4>${list.map(e=>`<div class="retline">${e.status==="sent"?"✓":e.status==="pending"?"?":"✕"} <b>${esc(CHANNEL_LABELS[e.channel])}</b> · ${esc(e.to||"")} · ${esc(hhmm(e.t))}${e.status==="failed"?` · not sent: ${esc(e.error||"")}`:e.status==="pending"?" · not confirmed":""}</div>`).join("")}</div>`:"";
}
export async function refreshHistory(sid){
  loadChannels();
  await loadDeliveryHistory(sid);
  $$(`[data-dlhist="${sid}"]`).forEach(h=>{h.innerHTML=historyHTML(sid)});
  renderSendState(sid);
}
