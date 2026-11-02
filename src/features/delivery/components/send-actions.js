// "Send to customer" on the payment screen and in the bill view: Email, WhatsApp and SMS, and what happened to each.
// "Sent" is shown only for what the server confirmed; WhatsApp without a provider opens WhatsApp on this device instead.
// Every channel carries the bill's one invoice PDF (use-cases/canonical-invoice.js): the email attaches it, WhatsApp sends
// it as a document (or a link to it), the SMS a link to download it — each line says which, and each channel shows its own
// state, so a failed one is tried again on its own. A walk-in bill, or a customer with no mobile or email, gets the contact
// added here: the bill (and its invoice) stay as they are, nothing is sold again.
import { CHANNEL_LABELS, deliveryTarget } from '../../../domain/invoices/delivery.js';
import { D } from '../../inventory/services/ledger.js';
import { invoiceFor } from '../../receipts/services/receipt-model.js';
import { whatsappReceipt } from '../../receipts/services/receipt-output.js';
import { deliveriesOf, invoiceLink, loadChannels, loadDeliveryHistory, refreshDeliveryStatus, revokeInvoiceLinks, sendInvoice } from '../use-cases/send-invoice.js';
import { MAX_ATTEMPTS } from '../../../domain/invoices/delivery.js';
import { autoJobs, onDeliveryChange } from '../use-cases/auto-delivery.js';
import { saveCustomer } from '../../customers/use-cases/save-customer.js';
import { flushSbQueue } from '../../sync/services/outbox.js';
import { store } from '../../../shared/state/store.js';
import { toast } from '../../../shared/components/toast.js';
import { $, $$, esc } from '../../../shared/dom.js';
import { hhmm } from '../../../shared/formatting/dates.js';

const verb={email:"Emailed",whatsapp:"Sent on WhatsApp",sms:"Sent by SMS"};
/* What the customer got, as the server said (format) */
const carried={attachment:" with the invoice PDF attached",document:" with the invoice PDF",pdf_link:" with a link to the invoice PDF",link:" with a link to the bill"};
/* The saved customer a walk-in bill goes to (added from this box): the bill keeps no customer, the message goes to them */
const sendToOf=sid=>(store.sendTo||{})[sid]||null;
/* Who the bill goes to: its own customer as saved, or the one added here for a walk-in bill */
function recipientOf(sale){
  const id=sale.cust&&sale.cust.id||sendToOf(sale.id);
  return id&&store.customers&&store.customers[id]||(sale.cust&&sale.cust.id?sale.cust:null);
}
/* What each channel would carry, from what the server can send (store.channels) — or "not set up" */
function capsHTML(){
  const C=store.channels; if(!C) return "";
  const what={email:C.email?"the invoice PDF attached":"",whatsapp:C.whatsapp?(C.whatsapp_pdf?"the invoice PDF":"a link to the invoice PDF"):"opens WhatsApp on this phone",sms:C.sms?"a link to download the invoice PDF":""};
  return `<p class="note dlcap" data-dlcap>${["email","whatsapp","sms"].map(ch=>`<b>${CHANNEL_LABELS[ch]}:</b> ${what[ch]||"not set up"}`).join(" · ")}</p>`;
}
/* One channel's own latest state, as a badge on its button */
function badgeOf(sid,ch){
  const e=deliveriesOf(sid).find(x=>x.channel===ch)||autoJobs(sid).find(j=>j.channel===ch);
  if(!e) return "";
  const s=e.status, k=s==="sent"||s==="delivered"?["ok","✓","sent"]:s==="sending"||s==="queued"?["busy","…","sending"]:s==="failed"||s==="refused"?["err","!","not sent"]:s==="unknown"||s==="pending"?["unk","?","not confirmed"]:s==="opened"?["note","↗","opened on this phone"]:null;
  return k?`<span class="dlb ${k[0]}" data-dlb="${ch}" title="${esc(CHANNEL_LABELS[ch]+": "+k[2])}" aria-label="${esc(k[2])}">${k[1]}</span>`:"";
}
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
  if(e.status==="sent") return `<span class="dl-ok">✓ ${verb[e.channel]} to ${esc(e.to)}${esc(carried[e.format]||"")} · ${esc(hhmm(e.t))}</span>`;
  if(e.status==="opened") return `<span class="dl-note">WhatsApp opened on this device. Press Send there to send the bill.</span>`;
  if(e.status==="pending") return `<span class="dl-note">${esc(CHANNEL_LABELS[e.channel])} to ${esc(e.to||"")} · ${esc(hhmm(e.t))}: not confirmed yet (it may have gone out). Check with the customer before sending again.</span>`;
  // no answer came back: it may have gone out — "Check again" asks about this same send, never sends a second one
  if(e.status==="unknown") return `<span class="dl-note">${esc(CHANNEL_LABELS[e.channel])} to ${esc(e.to||"")}: no answer came back (it may have gone out).</span> <button type="button" class="link xs" data-send="${esc(e.channel)}:${esc(sid)}">Check again</button>`;
  return `<span class="dl-err">${esc(e.error||"Not sent.")}</span>`+
    (e.field==="contact"&&custId?` <button type="button" class="link xs" data-custedit="${esc(custId)}">Edit customer</button>`:"")+
    (e.status==="failed"?` <button type="button" class="link xs" data-send="${esc(e.channel)}:${esc(sid)}">Try again</button>`:"");
}
/* The form that adds the contact the bill goes to: its customer's missing mobile / email, or a customer for a walk-in bill */
function contactFormHTML(sid){
  const F=store.contactForm;
  return `<form class="dlcontact" data-contactform="${esc(sid)}" novalidate><div class="pgrid2">
    <label class="f"><span class="lab">Name</span><input name="name" value="${esc(F.name)}" autocomplete="off"${F.locked?" readonly":""}></label>
    <label class="f"><span class="lab">Mobile</span><input name="phone" value="${esc(F.phone)}" type="tel" inputmode="tel" autocomplete="off"></label></div>
    <label class="f"><span class="lab">Email</span><input name="email" value="${esc(F.email)}" type="email" inputmode="email" autocomplete="off"></label>
    ${F.err?`<p class="note bad" role="alert">${esc(F.err)}</p>`:""}
    <div class="setactions"><button type="submit" class="btn sm primary" data-contactsave="${esc(sid)}">Save contact</button><button type="button" class="btn sm" data-contactcancel="${esc(sid)}">Cancel</button></div></form>`;
}
/* The send buttons for a bill (sale), each with its own state, what each carries, and the latest result */
export function sendBoxHTML(sale){
  const inv=invoiceFor(sale), sid=sale.id, cancelled=inv.status==="cancelled", who=recipientOf(sale);
  const buyer=who?{name:who.name,mobile:who.phone||"",email:who.email||""}:inv.buyer, walkIn=!buyer, I={...inv,buyer};
  const missing=!cancelled&&(walkIn||!buyer.mobile||!buyer.email);
  const btn=ch=>{const t=deliveryTarget(I,ch), off=cancelled||(walkIn&&ch!=="whatsapp");return `<button type="button" class="btn sm" data-send="${ch}:${esc(sid)}" title="${esc(t.to?"To "+t.to:t.error)}"${off?" disabled data-off":""}>${CHANNEL_LABELS[ch]}${badgeOf(sid,ch)}</button>`};
  const form=store.contactForm&&store.contactForm.sid===sid;
  return `<div class="sendbox" data-sendbox="${esc(sid)}"><span class="sendh">Send to customer${buyer&&buyer.name?` · <b>${esc(buyer.name)}</b>`:""}</span><div class="sendacts">${["email","whatsapp","sms"].map(btn).join("")}</div>`+
    `${cancelled?`<p class="note">A cancelled bill can't be sent.</p>`:walkIn?`<p class="note">Walk-in bill: add the customer's mobile or email to email or text it. WhatsApp opens on this device.</p>`:""}`+
    (cancelled?"":capsHTML())+
    (missing&&!form?`<button type="button" class="link xs" data-addcontact="${esc(sid)}">${walkIn?"+ Add customer's contact":"+ Add mobile or email"}</button>`:"")+
    (form?contactFormHTML(sid):"")+
    `<p class="sendstate" data-sendstate="${esc(sid)}" role="status">${both(sid)}</p></div>`;
}
const both=sid=>[autoHTML(sid),stateHTML(sid)].filter(Boolean).join("<br>");
export function renderSendState(sid){
  $$(`[data-sendstate="${sid}"]`).forEach(p=>{p.innerHTML=both(sid)});
  const busy=deliveriesOf(sid).some(e=>e.status==="sending");
  $$(`[data-sendbox="${sid}"] [data-send]`).forEach(b=>{ b.disabled=busy||b.hasAttribute("data-off"); const ch=b.dataset.send.split(":")[0], old=b.querySelector(".dlb"); if(old) old.remove(); b.insertAdjacentHTML("beforeend",badgeOf(sid,ch)); });
}
/* The box again once the server said which channels it can send (it was drawn before that answer); a contact being
   typed keeps its box as it is */
export function refreshSendBox(sid){ if(!(store.contactForm&&store.contactForm.sid===sid)) redrawBox(sid); }
/* The whole box again (a contact was added: who it goes to and which buttons work changed) */
function redrawBox(sid){
  const s=D().saleById[sid]; if(!s) return;
  $$(`[data-sendbox="${sid}"]`).forEach(b=>{ b.outerHTML=sendBoxHTML(s); });
}
/* A click on Email / WhatsApp / SMS */
export async function onSend(sid,channel){
  const s=D().saleById[sid]; if(!s||deliveriesOf(sid).some(e=>e.status==="sending")) return;
  const who=recipientOf(s);
  // No WhatsApp provider on the server (or not known yet), or nobody saved to send it to: open WhatsApp on this device,
  // right in the click — a window opened after waiting would be blocked as a pop-up. The person presses Send there;
  // nothing is claimed as sent.
  if(channel==="whatsapp"&&(!(store.channels&&store.channels.whatsapp)||!(who&&who.name))){
    whatsappReceipt(sid);
    store.deliveries[sid]=[{channel,status:"opened",t:Date.now()},...deliveriesOf(sid)];
    renderSendState(sid); return;
  }
  const to=sendToOf(sid);
  // a contact just added is still uploading: the server sends to the customer as saved in the cloud, so wait for it
  if(to) await uploaded(to);
  const p=sendInvoice(sid,channel,to?{customerId:to}:{}); renderSendState(sid);
  const r=await p;
  renderSendState(sid);
  if(r.ok) toast(`${verb[channel]} to ${r.to}${carried[r.format]||""}.`);
}
/* Waits (up to 8 s) for a customer's change to reach the cloud */
async function uploaded(cid){
  for(let i=0;i<16&&store.sbOfflineQueue.some(q=>q.type==="cust"&&q.id===cid);i++){ if(i%4===0) flushSbQueue(); await new Promise(r=>setTimeout(r,500)); }
}
/* "+ Add contact": the form, filled with what is known */
export function onAddContact(sid){
  const s=D().saleById[sid]; if(!s) return;
  const who=recipientOf(s);
  store.contactForm={sid,id:who&&who.id||null,name:who&&who.name||"",phone:who&&who.phone||"",email:who&&who.email||"",locked:!!(s.cust&&s.cust.id),err:""};
  redrawBox(sid);
  const i=$(`[data-contactform="${sid}"] [name=${store.contactForm.phone?"email":"phone"}]`); if(i) i.focus();
}
export function onContactCancel(sid){ store.contactForm=null; redrawBox(sid); }
/* Saves the contact: the bill's customer gets the missing mobile / email; a walk-in bill gets a saved customer to go to
   (an existing one with that mobile is used). The bill itself, and its invoice, don't change. */
export async function onContactSave(sid,form){
  const F=store.contactForm; if(!F||F.sid!==sid) return;
  const v=k=>String(form.querySelector(`[name=${k}]`).value||"").trim(), name=v("name"), phone=v("phone"), email=v("email");
  Object.assign(F,{name,phone,email,err:""});
  if(!phone&&!email){ F.err="Enter a mobile number or an email address."; redrawBox(sid); return; }
  const old=F.id&&store.customers[F.id];
  let r=saveCustomer(old?{...old,phone:phone||old.phone||"",email:email||old.email||""}:{name:name||"Customer",phone,email},old?{id:old.id}:{});
  // a walk-in whose mobile a saved customer already has: the bill goes to that customer (with the email given, if they had none)
  if(r.error&&r.duplicate&&!old){ const d=r.duplicate; r=email&&!d.email?saveCustomer({...d,email},{id:d.id}):{customer:d}; }
  if(r.error){ F.err=r.error; redrawBox(sid); return; }
  const s=D().saleById[sid];
  if(!(s&&s.cust&&s.cust.id)) store.sendTo={...(store.sendTo||{}),[sid]:r.customer.id};
  store.contactForm=null; flushSbQueue(); redrawBox(sid);
  toast(`Saved. Choose how to send the bill to ${r.customer.name}.`);
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
