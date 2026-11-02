// The shop's settings forms in Settings (components/settings-page.js): Products & Inventory → stock alert; Payments & Banks →
// payment methods and the cash drawer's expense categories; Bills & Documents → bill numbers and paper, logo, GST, the
// receipts sent by themselves; Purchasing → reorder planning; This device → this device's receipt printer. Every form
// has Save and Cancel (Cancel puts back what is saved: the form is drawn with the saved values).
import { store } from '../../../shared/state/store.js';
import { renderSync } from '../../sync/components/sync-status.js';
import { flushSbQueue } from '../../sync/services/outbox.js';
import { savePrinterSettings, testPrinter } from '../../printing/use-cases/print-receipt.js';
import { removeReceiptLogo, setLogoDisplay, setReceiptLogo } from '../use-cases/receipt-logo.js';
import { LOGO_ALIGNS, logoDisplayOf } from '../../../domain/documents/doc-settings.js';
import { toast } from '../../../shared/components/toast.js';
import { $, $$, esc } from '../../../shared/dom.js';
import { renderAll } from '../../../shared/ui/render.js';
import { formActionsHTML } from '../../../shared/ui/kit.js';
import { saveBillingSettings, saveGstSettings, savePaymentSettings, saveReorderSettings } from '../use-cases/save-billing-settings.js';
import { loadChannels } from '../../delivery/use-cases/send-invoice.js';
import { gateway, loadPayConfig } from '../../sales/use-cases/provider-payment.js';
import { userMessage } from '../../../shared/errors/app-error.js';
import { dayKey, dayLab, hhmm } from '../../../shared/formatting/dates.js';
import { expenseCats, saveExpenseCats } from '../../finance/use-cases/cash-moves.js';
import { DOC_NO_MAX, checkNumberingSettings, formatDocNo, nextDocNo } from '../../../domain/documents/numbering.js';
import { quotePrefix } from '../../../domain/orders/orders.js';
import { deviceTill } from '../../sales/services/doc-numbers.js';
import { D } from '../../inventory/services/ledger.js';
import { hasCap } from '../services/shop-caps.js';
import { can } from '../services/access.js';
import { use } from '../../../shared/di/services.js';
import { upiCheckUri } from '../../../domain/sales/upi.js';
import { moneyLabel } from '../../../shared/formatting/money.js';

const errHTML=id=>`<p id="${id}" class="autherr" role="alert" hidden></p>`;
/* Products & Inventory: the low-stock alert */
export function stockAlertHTML(){
  const s=store.settings;
  return `<form id="stockSetForm" class="authform setblk" novalidate><h5>Stock alert</h5><div class="pgrid">
    <label class="f"><span class="lab">Low-stock alert at</span><input name="lowStock" type="number" inputmode="numeric" min="0" max="999" value="${esc(s.lowStock)}"><span class="fhint">pieces or fewer, per variant</span></label>
  </div>${errHTML("stockSetErr")}${formActionsHTML({save:"Save stock alert"})}</form>`;
}
/* Payments & Banks: the drawer's expense categories */
export function expenseCatsHTML(){
  return `<form id="expCatForm" class="authform setblk" novalidate><h5>Cash drawer</h5>
    <label class="f full"><span class="lab">Expense categories, one per line</span><textarea name="cats" rows="4">${esc(expenseCats().join("\n"))}</textarea><span class="fhint">Offered when cash is spent from the drawer (Reports → Cash book → Expense)</span></label>
    ${errHTML("expCatErr")}${formActionsHTML({save:"Save categories"})}</form>`;
}
/* Bills & Documents → Bill numbering: the next bill's number on this device as the form stands, and why it can't be used
   (domain/documents/numbering.js) */
function numberPreviewHTML(input){
  const till=deviceTill(), r=checkNumberingSettings(input,{till});
  if(r.error) return `<span>Next bill</span><b>${esc(r.preview||"—")}</b><small class="bad" role="alert">${esc(r.error)}</small>`;
  const now=Date.now(), next=nextDocNo(D().sales,r.config,now,till), of=prefix=>formatDocNo({prefix,padding:r.config.padding,suffix:r.config.suffix},now,1,till);
  const others=[hasCap("uses_quotations")&&"Quotations "+of(quotePrefix(store.settings.quotePrefix)),hasCap("uses_sales_orders")&&"Sales orders "+of("SO-"),
    "Credit notes "+of("CN-"),hasCap("uses_purchase_orders")&&"Purchase orders "+of("PO-")].filter(Boolean);
  return `<span>Next bill</span><b data-nextbillno>${esc(next)}</b><small class="ok">✓ ${next.length} of ${DOC_NO_MAX} characters · ${r.yearly?"starts again on 1 April every year":"continues from year to year"}</small>
    ${r.warning?`<small class="warn">${esc(r.warning)}</small>`:""}
    <small>${till?`This device makes its documents in its own series (${esc(till)}): two devices never give the same number, even offline.`:`This device uses the shop's main series. Another device that makes bills gets its own letter (${esc(formatDocNo(r.config,now,r.config.start,"B"))}), so numbers never clash, even offline.`}</small>
    <small>Each document type has its own series: ${esc(others.join(" · "))}.</small>`;
}
const numberingInput=form=>{const f=new FormData(form);return {prefix:f.get("prefix"),start:f.get("invoiceStart"),padding:f.get("invoicePadding"),suffix:f.get("invoiceSuffix")};};
/* Bills & Documents: bill numbers, receipt paper and footer */
export function receiptFormHTML(){
  const s=store.settings, pad=+s.invoicePadding||6;
  return `<form id="billingForm" class="authform setblk" novalidate><h5>Bill numbering</h5><p class="note">Bill numbers are made automatically when a sale completes: nobody types them, and a number given is never changed.</p><div class="pgrid">
    <label class="f"><span class="lab">Prefix</span><input name="prefix" maxlength="14" value="${esc(s.prefix||"INV-")}" autocomplete="off" autocapitalize="characters" spellcheck="false"><span class="fhint">e.g. INV- · add {FY} for the financial year: INV/{FY}/</span></label>
    <label class="f"><span class="lab">Starting number</span><input name="invoiceStart" type="number" inputmode="numeric" min="1" max="99999999" value="${esc(s.invoiceStart||1)}"><span class="fhint">Continuing from another app? Start after its last bill.</span></label>
    <label class="f"><span class="lab">Digits</span><select name="invoicePadding">${[3,4,5,6,7,8].map(x=>`<option value="${x}"${pad===x?" selected":""}>${x} digits (${"0".repeat(x-1)}1)</option>`).join("")}</select></label>
    <label class="f"><span class="lab">Suffix <small>(optional)</small></span><input name="invoiceSuffix" maxlength="12" value="${esc(s.invoiceSuffix||"")}" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="e.g. /{FY}"></label>
    <div class="numpreview full" id="billNoPreview" aria-live="polite">${numberPreviewHTML({prefix:s.prefix||"INV-",start:s.invoiceStart,padding:pad,suffix:s.invoiceSuffix})}</div>
  </div><h5 class="setsubhead">Receipt output</h5><div class="pgrid">
    <label class="f"><span class="lab">Receipt paper</span><select name="paper"><option value="80mm"${s.paper!=="a4"?" selected":""}>80 mm receipt printer</option><option value="a4"${s.paper==="a4"?" selected":""}>A4 invoice</option></select></label>
    <label class="f full"><span class="lab">Receipt footer</span><input name="footer" maxlength="120" value="${esc(s.footer||"")}"></label>
  </div>${errHTML("billErr")}${formActionsHTML({save:"Save bill settings"})}</form>`;
}
/* Bills & Documents: GST on bills, and GST filing preparation */
export function taxFormsHTML(){
  const s=store.settings;
  return `<form id="taxForm" class="authform setblk" novalidate><h5>GST on bills</h5><div class="pgrid">
    <label class="chk full"><input type="checkbox" name="taxOn"${s.taxOn?" checked":""}> Show GST on bills</label>
    <label class="f"><span class="lab">GST rate %</span><input name="taxRate" type="number" inputmode="decimal" step="0.01" min="0" max="40" value="${esc(s.taxRate)}"><span class="fhint">For products without a GST rate of their own</span></label>
    <label class="chk"><input type="checkbox" name="taxIncl"${s.taxIncl?" checked":""}> My prices already include GST</label>
  </div><p class="note" style="margin:0">GST is worked out from these settings for your bills. Check the rules that apply to your business with your accountant.</p>
  ${errHTML("taxErr")}${formActionsHTML({save:"Save GST settings"})}</form>
  <form id="gstSetForm" class="authform setblk" novalidate><h5>GST filing preparation</h5><div class="pgrid">
    <label class="f"><span class="lab">${esc(moneyLabel("B2C large above"))}</span><input name="b2clLimit" type="number" inputmode="numeric" min="0" value="${esc(s.b2clLimit==null?100000:s.b2clLimit)}"><span class="fhint">Invoices to another state, without GSTIN, above this value are listed one by one</span></label>
  </div>${errHTML("gstErr")}${formActionsHTML({save:"Save GST setting"})}</form>`;
}
/* ---------- Payments & Banks → Connect a payment gateway ----------
   Optional for every shop, three ways side by side: cash and the shop's own card machine (always there); the shop's own UPI
   QR, no gateway (paid straight to its UPI ID, marked received by the cashier and kept Unverified until the shop confirms
   it in Reports → Reconciliation); and a payment gateway, where each payment is confirmed by the gateway itself. A gateway
   is always the shop's OWN merchant account — its own Razorpay keys, so Razorpay settles the money to the shop's bank;
   Hangtag never collects it — and the server says whether connecting one is switched on for the shop: said so, plainly,
   never a switch that pretends. The keys go to the server once (a form of their own, never the shop's settings) and are
   kept sealed there; the app is shown only a masked key id. Hangtag's own plan billing is separate (Plans & Billing). */
const payUi={testQr:false,confirmRemove:false,connect:false,confirmDisconnect:false,busy:false,hook:""};
const qrSvg=(text,size)=>{try{return use("qrCodeService").render(text,{unit:"px",size,margin:2})}catch{return ""}};
const when=ms=>ms?`${dayLab(dayKey(ms))} · ${hhmm(ms)}`:"";
/* A webhook secret made here for the shop to copy into Razorpay (it may type its own instead) */
const newWebhookSecret=()=>{ const b=new Uint8Array(18); crypto.getRandomValues(b); return "hgw_"+Array.from(b,x=>x.toString(16).padStart(2,"0")).join(""); };
/* The gateway option: what the server says about the shop's own gateway account (null: not known yet) */
function gatewayHTML(){
  const pc=store.payConfig, g=pc&&pc.gateway||{}, on=!!(pc&&(pc.upi||pc.cardLink)), s=store.settings, manage=can("manage_settings");
  const chip=pc==null?`<span class="pg-chip">Checking…</span>`:g.connected?`<span class="pg-chip on">${g.mode==="live"?"On · Live":"On · Test mode"}</span>`:`<span class="pg-chip">Not connected</span>`;
  const what=on?`${pc.upi?"UPI QR":""}${pc.upi&&pc.cardLink?" and ":""}${pc.cardLink?"card links":""}`:"";
  const head=`<div class="pg-h"><b>A payment gateway</b>${chip}</div>
    <p class="note">Each payment is confirmed by the gateway itself — never from a screenshot, the customer's word or the page they come back to — and the bill completes by itself.</p>`;
  if(pc==null) return head+`<p class="note">Checking whether it is on for your shop…</p>`;
  if(g.connected){
    const seen=g.lastEventAt?`Razorpay's notifications: last received ${esc(when(g.lastEventAt))}.`:`Razorpay's notifications: none received yet — add the webhook below in your Razorpay dashboard, then take a test payment.`;
    return head+`<p class="note" data-gwstate="connected">Your Razorpay account <b>${esc(g.keyId)}</b>${g.mode==="live"?"":" (test mode: no real money moves)"}${what?` · ${esc(what)}`:""}. Razorpay pays the money into your own bank; a payment counts only once Razorpay confirms it.</p>
      <p class="note" data-gwhooks>${seen}</p>
      ${g.webhookUrl?`<div class="pg-hook"><label class="f full"><span class="lab">Webhook address (Razorpay → Webhooks)</span><input readonly value="${esc(g.webhookUrl)}" data-gwurl></label>
        <span class="pg-acts"><button type="button" class="btn sm" data-gwcopy>Copy address</button></span>
        <p class="fhint">Events: ${esc((g.events||[]).join(", "))}. Use the webhook secret you gave when connecting.</p></div>`:""}
      ${on?`<label class="f"><span class="lab">A payment QR stays open for</span><input name="payExpiry" type="number" inputmode="numeric" min="2" max="30" value="${esc(s.payExpiry||5)}"><span class="fhint">minutes (2 to 30)</span></label>`:""}
      ${manage?(payUi.confirmDisconnect?`<div class="pg-confirm" role="alert"><p>Disconnect your Razorpay account? QR codes and links still open are closed, and Hangtag forgets the keys (you can connect again any time). Payments already taken stay as they are; refund them from your Razorpay dashboard.</p>
        <span class="pg-acts"><button type="button" class="btn sm danger" data-gwdisconnectyes${payUi.busy?" disabled":""}>Disconnect</button><button type="button" class="btn sm" data-gwdisconnectno>Keep it</button></span></div>`
        :`<span class="pg-acts"><button type="button" class="btn sm ghost" data-gwdisconnect>Disconnect</button></span>`):""}`;
  }
  if(!g.available) return head+`<p class="note">Connecting your shop's own Razorpay account (so the money settles straight to your bank) isn't switched on for your shop yet. Until it is, use your own UPI QR: nothing else changes.</p>`;
  return head+`<p class="note" data-gwstate="available">Connect your own Razorpay account: Razorpay pays the money into your bank; Hangtag only asks it for each QR or link and checks each payment with it. Test keys (rzp_test_…) until live payments are switched on for your shop.</p>
    ${manage?(payUi.connect?"":`<span class="pg-acts"><button type="button" class="btn sm primary" data-gwconnect>Connect your Razorpay account</button></span>`):`<p class="note">Someone who manages the shop's settings can connect it.</p>`}`;
}
/* The keys, in a form of their own (never part of the shop's settings, which every phone syncs) */
function connectFormHTML(){
  return `<form id="gwConnectForm" class="authform pg-connect" novalidate autocomplete="off"><h5>Connect your Razorpay account</h5>
    <ol class="note pg-steps"><li>In your own Razorpay dashboard → Account &amp; Settings → API Keys, generate a <b>test</b> key.</li>
      <li>Paste its Key Id and Key Secret here. Keep the webhook secret below (or type your own): you'll give it to Razorpay too.</li>
      <li>Connect, then add the webhook Hangtag shows you in Razorpay → Webhooks.</li></ol>
    <div class="pgrid">
      <label class="f"><span class="lab">Key Id</span><input name="gwKeyId" placeholder="rzp_test_…" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="60"></label>
      <label class="f"><span class="lab">Key Secret</span><input name="gwKeySecret" type="password" autocomplete="new-password" autocapitalize="off" spellcheck="false" maxlength="80"></label>
      <label class="f full"><span class="lab">Webhook secret</span><input name="gwWebhookSecret" value="${esc(payUi.hook)}" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="128"><span class="fhint">8 or more characters; the same goes into Razorpay → Webhooks → Secret</span></label>
    </div>
    <p class="note">The secrets go to Hangtag's server once: checked with Razorpay, then kept sealed. Nobody can read them back, not even you.</p>
    <p id="gwErr" class="autherr" role="alert" hidden></p>
    <div class="formacts"><button class="btn" type="button" data-gwcancel>Cancel</button><button class="btn primary" type="submit" data-gwsubmit${payUi.busy?" disabled":""}>${payUi.busy?"Checking with Razorpay…":"Connect"}</button></div></form>`;
}
/* Payments & Banks: how the shop takes payments */
export function paymentsFormHTML(){
  const s=store.settings, vpa=String(s.upiId||"").trim(), on=!!vpa, pc=store.payConfig, gwOn=!!(pc&&(pc.upi||pc.cardLink));
  const name=store.profile&&store.profile.shop_name||"Shop", manage=can("manage_settings");
  const test=on&&payUi.testQr?`<div class="pg-test"><div class="pi-qr small">${qrSvg(upiCheckUri({vpa,name}),160)}</div>
    <p class="note">Scan it with any UPI app: it shows the name of the account this UPI ID pays into. It has no amount — don't pay; check the name, then close it.</p></div>`:"";
  const remove=payUi.confirmRemove?`<div class="pg-confirm" role="alert"><p>Remove your UPI ID? The payment screen won't show your QR any more; UPI can still be recorded by hand, and nothing already sold changes.</p>
    <span class="pg-acts"><button type="button" class="btn sm danger" data-payremoveyes>Remove UPI ID</button><button type="button" class="btn sm" data-payremoveno>Keep it</button></span></div>`:"";
  return `<div class="setblk" id="paySetup"><h5>Connect a payment gateway</h5>
    <p class="note pg-lead">Optional. Choose how your shop takes payments — Hangtag works with cash, your card machine and your own UPI QR without any gateway.</p>
    <form id="paymentsForm" class="authform" novalidate><div class="pg-opts">
      <section class="pg-opt on" aria-label="Cash and card machine"><div class="pg-h"><b>Cash and your card machine</b><span class="pg-chip on">Always on</span></div>
        <p class="note">Nothing to set up. For a card on your own machine the payment screen notes only its approval number and the last 4 digits, both optional — never the card number, CVV or PIN.</p></section>
      <section class="pg-opt${on?" on":""}" id="pgUpi" aria-label="Your own UPI QR"><div class="pg-h"><b>Your own UPI QR</b><span class="pg-chip${on?" on":""}">${on?"On":"Off"}</span></div>
        <p class="note">No gateway needed. The payment screen shows a QR with the bill's amount, paid straight to your UPI ID. The cashier marks it received after seeing the customer's successful payment, and it is kept as <b>Unverified</b> until you confirm it reached your account (Reports → Reconciliation).</p>
        <label class="f"><span class="lab">Shop UPI ID</span><input name="upiId" value="${esc(vpa)}" placeholder="myshop@okaxis" autocomplete="off" autocapitalize="off" spellcheck="false"${manage?"":" readonly"}><span class="fhint">name@bank, as in your UPI app</span></label>
        ${on?`<span class="pg-acts"><button type="button" class="btn sm" data-paytestqr aria-expanded="${payUi.testQr}">${payUi.testQr?"Hide the test QR":"Show a test QR"}</button>${manage?`<button type="button" class="btn sm ghost" data-payremove>Remove UPI ID</button>`:""}</span>`:""}
        ${test}${remove}</section>
      <section class="pg-opt${gwOn?" on":""}" aria-label="A payment gateway" data-payprovider>${gatewayHTML()}</section>
    </div>${gwOn?"":`<input type="hidden" name="payExpiry" value="${esc(s.payExpiry||5)}">`}
    <p id="payErr2" class="autherr" hidden></p>${manage?formActionsHTML({save:"Save payment settings"}):`<p class="note">Only someone who manages the shop's settings can change these.</p>`}</form>
    ${payUi.connect&&manage&&pc&&pc.gateway&&pc.gateway.available&&!pc.gateway.connected?connectFormHTML():""}</div>`;
}
/* Connects the shop's own Razorpay account: the keys go to the payment-gateway function, which checks them with Razorpay
   and keeps them sealed; the form is emptied whatever the answer */
async function connectGateway(form){
  const f=new FormData(form), keys={keyId:String(f.get("gwKeyId")||""),keySecret:String(f.get("gwKeySecret")||""),webhookSecret:String(f.get("gwWebhookSecret")||"")};
  form.querySelector('[name="gwKeySecret"]').value="";
  payUi.busy=true; const b=form.querySelector("[data-gwsubmit]"); if(b){ b.disabled=true; b.textContent="Checking with Razorpay…"; }
  try{
    store.payConfig=await gateway().connect(keys);
    payUi.connect=false; payUi.busy=false; payUi.hook=""; redrawPaySetup();
    toast(`Razorpay account connected${store.payConfig.gateway.mode==="live"?"":" (test mode)"}. Now add the webhook it shows in Razorpay.`);
  }catch(e){
    payUi.busy=false;
    const err=$("#gwErr"); if(err){ err.textContent=userMessage(e,"Couldn't connect the account. Try again."); err.hidden=false; }
    if(b){ b.disabled=false; b.textContent="Connect"; }
  }
}
async function disconnectGateway(){
  payUi.busy=true; redrawPaySetup();
  try{ store.payConfig=await gateway().disconnect(); payUi.confirmDisconnect=false; toast("Razorpay account disconnected. UPI by your own QR and the card machine work as before."); }
  catch(e){ toast(userMessage(e,"Couldn't disconnect it. Try again.")); }
  payUi.busy=false; redrawPaySetup();
}
function copyWebhookUrl(){
  const i=$("[data-gwurl]"); if(!i) return;
  const done=()=>toast("Webhook address copied.");
  if(navigator.clipboard&&navigator.clipboard.writeText) navigator.clipboard.writeText(i.value).then(done,()=>{ i.select(); toast("Select and copy the address."); });
  else { i.select(); toast("Select and copy the address."); }
}
/* Redrawn in place (the test QR shown or hidden, the removal asked for) */
function redrawPaySetup(){ const b=$("#paySetup"); if(b) b.outerHTML=paymentsFormHTML(); }
/* Remove the UPI ID (after the merchant confirmed it): the rest of the payment settings as they are */
function removeUpiId(){
  const s=store.settings, a=Object.assign({whatsapp:false,sms:false,email:false},s.autoSend||{});
  const r=savePaymentSettings({upiId:"",payExpiry:s.payExpiry||5,...a});
  payUi.confirmRemove=false; payUi.testQr=false;
  if(r.error){ toast(r.error); redrawPaySetup(); return; }
  renderSync(); flushSbQueue(); redrawPaySetup(); toast("UPI ID removed. UPI can still be recorded by hand.");
}
/* Clicks in Connect a payment gateway (from installBillingSettingsEvents) */
function paySetupClick(t){
  if(t.closest("[data-paytestqr]")){ payUi.testQr=!payUi.testQr; redrawPaySetup(); return true; }
  if(t.closest("[data-payremove]")){ payUi.confirmRemove=true; redrawPaySetup(); return true; }
  if(t.closest("[data-payremoveno]")){ payUi.confirmRemove=false; redrawPaySetup(); return true; }
  if(t.closest("[data-payremoveyes]")){ removeUpiId(); return true; }
  if(t.closest("[data-gwconnect]")){ payUi.connect=true; payUi.hook=payUi.hook||newWebhookSecret(); redrawPaySetup(); const k=$('#gwConnectForm [name="gwKeyId"]'); if(k) k.focus(); return true; }
  if(t.closest("[data-gwcancel]")){ payUi.connect=false; payUi.hook=""; redrawPaySetup(); return true; }
  if(t.closest("[data-gwdisconnect]")){ payUi.confirmDisconnect=true; redrawPaySetup(); return true; }
  if(t.closest("[data-gwdisconnectno]")){ payUi.confirmDisconnect=false; redrawPaySetup(); return true; }
  if(t.closest("[data-gwdisconnectyes]")){ if(!payUi.busy) disconnectGateway(); return true; }
  if(t.closest("[data-gwcopy]")){ copyWebhookUrl(); return true; }
  return false;
}
/* Bills & Documents: receipts sent by themselves when a bill completes */
export function autoSendFormHTML(){
  const a=Object.assign({whatsapp:false,sms:false,email:false},store.settings.autoSend||{}),ch=store.channels;
  const box=(k,label)=>{const off=ch&&ch[k]===false;return `<label class="chk" data-chan="${k}"><input type="checkbox" name="${k}"${a[k]?" checked":""}${off&&!a[k]?" disabled":""}> ${label}${off?` <small class="muted">(not set up on the server yet)</small>`:""}</label>`};
  return `<form id="autoSendForm" class="authform setblk" novalidate><h5>Send receipts automatically</h5>
    <div class="pgrid">${box("whatsapp","WhatsApp")}${box("sms","SMS (and when WhatsApp fails)")}${box("email","Email")}</div>
    <p class="note" style="margin:0">Goes to the bill's customer as saved in Customers. It can be turned off for one sale on the payment screen. Offline, it waits and goes once the bill has uploaded.</p>
    <p id="autoSendErr" class="autherr" hidden></p>${formActionsHTML({save:"Save"})}</form>`;
}
/* The server's answers arrive after the forms are drawn: update the provider line and the channels in place (never the
   fields someone may be typing in) */
export async function refreshPaymentsForm(){
  await Promise.all([loadChannels(),loadPayConfig()]);
  // the gateway's state arrived: the whole block again only while nothing is being typed in it
  const box=$("#paySetup"), typing=box&&box.contains(document.activeElement)&&document.activeElement.matches("input");
  if(box&&!typing) redrawPaySetup(); else $$("[data-payprovider]").forEach(p=>{p.innerHTML=gatewayHTML()});
  const f=$("#autoSendForm"),ch=store.channels;
  if(f&&ch) ["whatsapp","sms","email"].forEach(k=>{const i=f.querySelector(`[name="${k}"]`);if(i&&ch[k]===false&&!i.checked)i.disabled=true});
}
/* Bills & Documents: the logo (every device of the shop) */
export function receiptSetupHTML(){
  return `<div class="setblk" id="receiptSetup"><h5>Logo</h5>
    <div class="logoedit"><span class="logoprev">${store.logo?`<img src="${esc(store.logo)}" alt="Shop logo">`:`<span class="note">No logo</span>`}</span>
      <div><p class="note" style="margin:0 0 6px">Your logo, shop name, address, phone and GSTIN (from Business) print at the top of every receipt and document. It is saved as soon as you choose it.</p>
      <label class="btn sm">${store.logo?"Change logo":"Add logo"}<input type="file" accept="image/png,image/jpeg,image/webp" data-logofile hidden></label>${store.logo?` <button type="button" class="btn sm danger" data-act="logoremove">Remove logo</button>`:""}</div></div>
    ${store.logo?logoDisplayHTML():""}</div>`;
}
/* Printed or not, and where: on every bill, receipt, invoice, quotation and the online receipt */
function logoDisplayHTML(){
  const L=logoDisplayOf(store.settings), A={auto:"Auto",left:"Left",center:"Centre",right:"Right"};
  return `<div class="logodisp"><label class="chk"><input type="checkbox" data-logoshow${L.show?" checked":""}> Print the logo on bills and documents</label>
    <div class="segrow" role="radiogroup" aria-label="Where the logo goes"${L.show?"":" hidden"}>${LOGO_ALIGNS.map(a=>`<label class="segopt"><input type="radio" name="logoAlign" value="${a}" data-logoalign${L.align===a?" checked":""}><span>${A[a]}</span></label>`).join("")}</div>
    <p class="note" style="margin:6px 0 0">Auto: on the left of A4 invoices and documents, centred on receipts.</p></div>`;
}
/* Purchasing: Smart reorder's planning */
export function reorderFormHTML(){
  const r=Object.assign({leadDays:7,safetyDays:3,targetCoverDays:21},store.settings.reorder||{});
  return `<form id="reorderForm" class="authform setblk" novalidate><h5>Reorder planning</h5><div class="pgrid">
    <label class="f"><span class="lab">Supplier lead time</span><input name="leadDays" type="number" inputmode="numeric" min="0" max="120" value="${esc(r.leadDays)}"><span class="fhint">days from ordering to the stock arriving</span></label>
    <label class="f"><span class="lab">Safety stock</span><input name="safetyDays" type="number" inputmode="numeric" min="0" max="120" value="${esc(r.safetyDays)}"><span class="fhint">extra days of sales kept in hand</span></label>
    <label class="f"><span class="lab">One order covers</span><input name="targetCoverDays" type="number" inputmode="numeric" min="1" max="365" value="${esc(r.targetCoverDays)}"><span class="fhint">days of sales (at least lead time + safety stock)</span></label>
  </div><p class="note" style="margin:0">Smart reorder suggests what to buy when a variant's stock would run out within the lead time plus safety stock, and how much to cover this many days.</p>
  ${errHTML("reorderErr")}${formActionsHTML({save:"Save reorder planning"})}</form>`;
}
/* This device: the receipt printer of this device (every person, whatever the role) */
export function printerSetupHTML(){
  const p=store.printer, ep=p.kind==="epson";
  return `<div class="setblk" id="printerSetup"><h5>Receipt printer on this device</h5>
    <form id="printerForm" class="authform" novalidate><div class="pgrid">
      <label class="f"><span class="lab">Printer</span><select name="kind" data-printerkind><option value="browser"${ep?"":" selected"}>Print dialog (any printer)</option><option value="epson"${ep?" selected":""}>Epson thermal printer (network)</option></select></label>
      <label class="f" data-epson${ep?"":" hidden"}><span class="lab">Printer IP address</span><input name="host" value="${esc(p.host)}" placeholder="192.168.1.50" autocomplete="off" inputmode="url"><span class="fhint">On the printer's status sheet (hold the feed button while switching it on)</span></label>
      <label class="f" data-epson${ep?"":" hidden"}><span class="lab">Paper width</span><select name="cols"><option value="48"${p.cols===48?" selected":""}>80 mm</option><option value="42"${p.cols===42?" selected":""}>80 mm (font B off)</option><option value="32"${p.cols===32?" selected":""}>58 mm</option></select></label>
      <label class="f" data-epson${ep?"":" hidden"}><span class="lab">Device ID</span><input name="devid" value="${esc(p.devid)}" autocomplete="off"><span class="fhint">Usually local_printer</span></label>
      <label class="chk full" data-epson${ep?"":" hidden"}><input type="checkbox" name="https"${p.https!==false?" checked":""}> Secure connection (https), needed when Hangtag is opened over https</label>
    </div><p class="note" style="margin:0">Saved on this device only: each till can have its own printer. The printer and this device must be on the same Wi-Fi.</p>
    <p id="printerMsg" class="autherr" role="status" hidden></p>
    <div class="formacts"><button class="btn" type="button" data-act="printertest" data-epson${ep?"":" hidden"}>Test print</button><button class="btn" type="reset">Cancel</button><button class="btn primary" type="submit">Save printer</button></div></form></div>`;
}
/* Any of the billing forms (receipt, GST, stock alert): what the form doesn't show keeps its saved value */
export function saveBillingForm(form){
  const s=store.settings,f=new FormData(form),has=n=>!!form.querySelector(`[name="${n}"]`),v=(n,cur)=>has(n)?f.get(n):cur;
  const err=form.querySelector(".autherr"),bad=m=>{if(err){err.textContent=m;err.hidden=false}};
  // the bill numbering goes along only from its own form (a numbering saved before is otherwise left as it is)
  const num=has("prefix")?{prefix:f.get("prefix"),invoiceStart:f.get("invoiceStart"),invoicePadding:f.get("invoicePadding"),invoiceSuffix:f.get("invoiceSuffix")}:{};
  const r=saveBillingSettings({lowStock:v("lowStock",s.lowStock),taxOn:v("taxOn",s.taxOn),taxRate:v("taxRate",s.taxRate),taxIncl:v("taxIncl",s.taxIncl),...num,paper:v("paper",s.paper),footer:v("footer",s.footer)});
  if(r.error){bad(r.error);const el=r.field&&form.querySelector(`[name="${{prefix:"prefix",start:"invoiceStart",padding:"invoicePadding",suffix:"invoiceSuffix",length:"prefix"}[r.field]||r.field}"]`);if(el)el.focus();return}
  renderSync();flushSbQueue();
  if(err)err.hidden=true;renderAll();toast(form.id==="taxForm"?"GST settings saved.":form.id==="stockSetForm"?"Stock alert saved.":"Bill settings saved.");
}
const printerInput=form=>{const f=new FormData(form);return {kind:f.get("kind"),host:f.get("host"),cols:f.get("cols"),devid:f.get("devid"),https:!!f.get("https")}};
function printerMsg(text,ok){const m=$("#printerMsg");if(!m)return;m.textContent=text;m.hidden=!text;m.classList.toggle("okmsg",!!ok)}
const redrawReceiptSetup=()=>{const s=$("#receiptSetup");if(s)s.outerHTML=receiptSetupHTML()};
const formErr=(id,r)=>{const err=$(id);if(r.error){if(err){err.textContent=r.error;err.hidden=false}return true}if(err)err.hidden=true;return false};

/* Registered once at start-up (app/main.js). */
export function installBillingSettingsEvents(){
  document.addEventListener("click",e=>{ const t=e.target; if(t&&t.closest&&t.closest("#paySetup")&&paySetupClick(t)) e.preventDefault(); });
  document.addEventListener("submit",e=>{
    const id=e.target.id;
    if(["billingForm","taxForm","stockSetForm"].includes(id)){e.preventDefault();saveBillingForm(e.target);return}
    if(id==="gwConnectForm"){e.preventDefault();if(!payUi.busy&&can("manage_settings"))connectGateway(e.target);return}
    if(id==="paymentsForm"||id==="autoSendForm"){e.preventDefault();const f=new FormData(e.target),s=store.settings,a=Object.assign({whatsapp:false,sms:false,email:false},s.autoSend||{});
      const r=id==="paymentsForm"?savePaymentSettings({upiId:f.get("upiId"),payExpiry:f.get("payExpiry"),...a}):savePaymentSettings({upiId:s.upiId,payExpiry:s.payExpiry,whatsapp:f.get("whatsapp"),sms:f.get("sms"),email:f.get("email")});
      if(formErr(id==="paymentsForm"?"#payErr2":"#autoSendErr",r))return;renderSync();flushSbQueue();
      // saved: the UPI QR's state (On, its test QR and Remove) shows at once
      if(id==="paymentsForm"){ payUi.confirmRemove=false; redrawPaySetup(); }
      toast(id==="paymentsForm"?"Payment settings saved.":"Automatic receipts saved.");return}
    if(id==="expCatForm"){e.preventDefault();const f=new FormData(e.target);if(formErr("#expCatErr",saveExpenseCats(String(f.get("cats")||"").split(/[\n,]/))))return;toast("Expense categories saved.");return}
    if(id==="gstSetForm"){e.preventDefault();const f=new FormData(e.target);if(formErr("#gstErr",saveGstSettings({b2clLimit:f.get("b2clLimit")})))return;renderSync();flushSbQueue();toast("GST setting saved.");return}
    if(id==="reorderForm"){e.preventDefault();const f=new FormData(e.target);if(formErr("#reorderErr",saveReorderSettings({leadDays:f.get("leadDays"),safetyDays:f.get("safetyDays"),targetCoverDays:f.get("targetCoverDays")})))return;renderSync();flushSbQueue();renderAll();toast("Reorder planning saved.");return}
    if(id==="printerForm"){e.preventDefault();const r=savePrinterSettings(printerInput(e.target));if(r.error){printerMsg(r.error);return}printerMsg("Printer saved on this device.",true);toast("Printer saved.")}
  });
  document.addEventListener("reset",e=>{
    // Cancel: the form goes back to what is saved; the printer form's Epson fields follow its choice again
    if(e.target.id==="printerForm") setTimeout(()=>{const k=e.target.querySelector("[data-printerkind]");if(k)k.dispatchEvent(new Event("change",{bubbles:true}))},0);
    if(e.target.id==="billingForm") setTimeout(()=>{const box=$("#billNoPreview");if(box)box.innerHTML=numberPreviewHTML(numberingInput(e.target))},0);
    const err=e.target.querySelector&&e.target.querySelector(".autherr");if(err)err.hidden=true;
  });
  document.addEventListener("change",async e=>{
    const t=e.target;
    if(t.matches&&t.matches("[data-printerkind]")){const ep=t.value==="epson";t.form.querySelectorAll("[data-epson]").forEach(x=>{x.hidden=!ep});return}
    if(t.matches&&(t.matches("[data-logoshow]")||t.matches("[data-logoalign]"))){const box=t.closest("#receiptSetup"),show=box.querySelector("[data-logoshow]").checked,al=box.querySelector("[data-logoalign]:checked");const r=setLogoDisplay({show,align:al?al.value:"auto"});if(r.error){toast(r.error);return}redrawReceiptSetup();flushSbQueue();toast(show?"The logo prints on bills and documents.":"The logo is kept, but not printed.");return}
    if(t.matches&&t.matches("[data-logofile]")){const f=t.files&&t.files[0];t.value="";if(!f)return;const r=await setReceiptLogo(f);if(r.error){toast(r.error);return}redrawReceiptSetup();flushSbQueue();toast("Logo saved. It prints on every receipt.")}
  });
  // Bill numbering: the preview follows what is typed
  const numberPreview=e=>{const form=e.target&&e.target.closest&&e.target.closest("#billingForm");if(!form||!["prefix","invoiceStart","invoicePadding","invoiceSuffix"].includes(e.target.name))return;const box=$("#billNoPreview");if(box)box.innerHTML=numberPreviewHTML(numberingInput(form));};
  document.addEventListener("input",numberPreview);
  document.addEventListener("change",numberPreview);
  document.addEventListener("click",async e=>{
    const a=e.target.closest&&e.target.closest("#receiptSetup [data-act],#printerSetup [data-act]");if(!a)return;
    if(a.dataset.act==="logoremove"){removeReceiptLogo();redrawReceiptSetup();flushSbQueue();toast("Logo removed.");return}
    if(a.dataset.act==="printertest"){const form=$("#printerForm");printerMsg("Printing a test receipt…");const r=await testPrinter(printerInput(form));printerMsg(r.error||"✓ The printer printed the test receipt.",!r.error)}
  });
}

