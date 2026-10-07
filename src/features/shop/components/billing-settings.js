// The shop's settings forms in Settings (components/settings-page.js): Products & Inventory → stock alert; Payments & Banks →
// payment methods and the cash drawer's expense categories; Bills & Documents → bill numbers and paper, logo, GST, the
// receipts sent by themselves; Purchasing → reorder planning; This device → this device's receipt printer. Every form
// has Save and Cancel (Cancel puts back what is saved: the form is drawn with the saved values).
import { store } from '../../../shared/state/store.js';
import { renderSync } from '../../sync/components/sync-status.js';
import { flushSbQueue } from '../../sync/services/outbox.js';
import { savePrinterSettings, testPrinter } from '../../printing/use-cases/print-receipt.js';
import { removeReceiptLogo, setReceiptLogo } from '../use-cases/receipt-logo.js';
import { toast } from '../../../shared/components/toast.js';
import { $, $$, esc } from '../../../shared/dom.js';
import { renderAll } from '../../../shared/ui/render.js';
import { formActionsHTML } from '../../../shared/ui/kit.js';
import { saveBillingSettings, saveGstSettings, savePaymentSettings, saveReorderSettings } from '../use-cases/save-billing-settings.js';
import { loadChannels } from '../../delivery/use-cases/send-invoice.js';
import { loadPayConfig } from '../../sales/use-cases/provider-payment.js';
import { expenseCats, saveExpenseCats } from '../../finance/use-cases/cash-moves.js';
import { DOC_NO_MAX, checkNumberingSettings, formatDocNo, nextDocNo } from '../../../domain/documents/numbering.js';
import { quotePrefix } from '../../../domain/orders/orders.js';
import { deviceTill } from '../../sales/services/doc-numbers.js';
import { D } from '../../inventory/services/ledger.js';
import { hasCap } from '../services/shop-caps.js';
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
/* The server's word on verified payments (null: not known yet) */
function providerNote(){
  const pc=store.payConfig;
  return pc==null?"Verified UPI and card links: checking with the server…":pc.upi?`Verified UPI QR${pc.cardLink?" and card payment links are":" is"} on (${esc(pc.provider||"payment provider")}). A payment counts only when the provider confirms it.`:"Verified UPI isn't set up on the server (payment-gateway secrets). UPI and card payments are marked received by hand and kept as Unverified until they are matched.";
}
/* Payments & Banks: the shop's UPI ID and the verified QR */
export function paymentsFormHTML(){
  const s=store.settings;
  return `<div class="setblk" id="paySetup"><h5>Payment methods</h5><form id="paymentsForm" class="authform" novalidate><div class="pgrid">
    <label class="f"><span class="lab">Shop UPI ID</span><input name="upiId" value="${esc(s.upiId||"")}" placeholder="myshop@okaxis" autocomplete="off" autocapitalize="off" spellcheck="false"><span class="fhint">Shown as a QR with the amount when UPI is marked received by hand</span></label>
    <label class="f"><span class="lab">Verified QR stays open for</span><input name="payExpiry" type="number" inputmode="numeric" min="2" max="30" value="${esc(s.payExpiry||5)}"><span class="fhint">minutes (2 to 30)</span></label>
  </div>
  <p class="note" data-payprovider>${providerNote()}</p>
  <p class="note" style="margin:0">Cards on your own card machine: the payment screen asks only for the machine's reference and the last 4 digits, both optional. Never the card number, CVV or PIN.</p>
  <p id="payErr2" class="autherr" hidden></p>${formActionsHTML({save:"Save payment methods"})}</form></div>`;
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
  $$("[data-payprovider]").forEach(p=>{p.innerHTML=providerNote()});
  const f=$("#autoSendForm"),ch=store.channels;
  if(f&&ch) ["whatsapp","sms","email"].forEach(k=>{const i=f.querySelector(`[name="${k}"]`);if(i&&ch[k]===false&&!i.checked)i.disabled=true});
}
/* Bills & Documents: the logo (every device of the shop) */
export function receiptSetupHTML(){
  return `<div class="setblk" id="receiptSetup"><h5>Logo</h5>
    <div class="logoedit"><span class="logoprev">${store.logo?`<img src="${esc(store.logo)}" alt="Shop logo">`:`<span class="note">No logo</span>`}</span>
      <div><p class="note" style="margin:0 0 6px">Your logo, shop name, address, phone and GSTIN (from Business) print at the top of every receipt and document. It is saved as soon as you choose it.</p>
      <label class="btn sm">${store.logo?"Change logo":"Add logo"}<input type="file" accept="image/png,image/jpeg,image/webp" data-logofile hidden></label>${store.logo?` <button type="button" class="btn sm danger" data-act="logoremove">Remove logo</button>`:""}</div></div></div>`;
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
  document.addEventListener("submit",e=>{
    const id=e.target.id;
    if(["billingForm","taxForm","stockSetForm"].includes(id)){e.preventDefault();saveBillingForm(e.target);return}
    if(id==="paymentsForm"||id==="autoSendForm"){e.preventDefault();const f=new FormData(e.target),s=store.settings,a=Object.assign({whatsapp:false,sms:false,email:false},s.autoSend||{});
      const r=id==="paymentsForm"?savePaymentSettings({upiId:f.get("upiId"),payExpiry:f.get("payExpiry"),...a}):savePaymentSettings({upiId:s.upiId,payExpiry:s.payExpiry,whatsapp:f.get("whatsapp"),sms:f.get("sms"),email:f.get("email")});
      if(formErr(id==="paymentsForm"?"#payErr2":"#autoSendErr",r))return;renderSync();flushSbQueue();toast(id==="paymentsForm"?"Payment methods saved.":"Automatic receipts saved.");return}
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

