// Billing and stock settings form, and receipts: the logo (for the shop) and this device's receipt printer.
import { store } from '../../../shared/state/store.js';
import { renderSync } from '../../sync/components/sync-status.js';
import { flushSbQueue } from '../../sync/services/outbox.js';
import { savePrinterSettings, testPrinter } from '../../printing/use-cases/print-receipt.js';
import { removeReceiptLogo, setReceiptLogo } from '../use-cases/receipt-logo.js';
import { toast } from '../../../shared/components/toast.js';
import { $, esc } from '../../../shared/dom.js';
import { renderAll } from '../../../shared/ui/render.js';
import { saveBillingSettings } from '../use-cases/save-billing-settings.js';

/* ---------- Billing and stock settings (in Profile & shop settings; saved on this device, synced when online) ---------- */

export function billingFormHTML(){
  const s=store.settings;
  return `<div class="setsec"><h4>Billing and stock</h4><form id="billingForm" class="authform" novalidate><div class="pgrid">
    <label class="f"><span class="lab">Low-stock alert at</span><input name="lowStock" type="number" inputmode="numeric" min="0" max="999" value="${esc(s.lowStock)}"><span class="fhint">pieces or fewer, per colour and size</span></label>
    <label class="f"><span class="lab">Bill number prefix</span><input name="prefix" maxlength="10" value="${esc(s.prefix||"")}" autocomplete="off"><span class="fhint">e.g. INV- gives INV-250925-004</span></label>
    <label class="chk full"><input type="checkbox" name="taxOn"${s.taxOn?" checked":""}> Show GST on bills</label>
    <label class="f"><span class="lab">GST rate %</span><input name="taxRate" type="number" inputmode="decimal" step="0.01" min="0" max="40" value="${esc(s.taxRate)}"></label>
    <label class="chk"><input type="checkbox" name="taxIncl"${s.taxIncl?" checked":""}> My prices already include GST</label>
    <label class="f"><span class="lab">Receipt paper</span><select name="paper"><option value="80mm"${s.paper!=="a4"?" selected":""}>80 mm receipt printer</option><option value="a4"${s.paper==="a4"?" selected":""}>A4 invoice</option></select></label>
    <label class="f"><span class="lab">Receipt footer</span><input name="footer" maxlength="120" value="${esc(s.footer||"")}"></label>
  </div><p class="note" style="margin:0">GST is worked out from these settings for your bills. Check the rules that apply to your business with your accountant.</p>
  <p id="billErr" class="autherr" hidden></p><div class="setactions"><button class="btn sm primary" type="submit">Save billing settings</button></div></form></div>`+receiptSetupHTML();
}
/* Receipts: the logo (every device of the shop) and the printer of this device */
export function receiptSetupHTML(){
  const p=store.printer, ep=p.kind==="epson";
  return `<div class="setsec" id="receiptSetup"><h4>Receipts and printer</h4>
    <div class="logoedit"><span class="logoprev">${store.logo?`<img src="${esc(store.logo)}" alt="Shop logo">`:`<span class="note">No logo</span>`}</span>
      <div><p class="note" style="margin:0 0 6px">Your logo, shop name, address, phone and GSTIN (from your profile above) print at the top of every receipt and invoice.</p>
      <label class="btn sm">${store.logo?"Change logo":"Add logo"}<input type="file" accept="image/png,image/jpeg,image/webp" data-logofile hidden></label>${store.logo?` <button type="button" class="btn sm" data-act="logoremove">Remove logo</button>`:""}</div></div>
    <form id="printerForm" class="authform" novalidate><div class="pgrid">
      <label class="f"><span class="lab">Printer on this device</span><select name="kind" data-printerkind><option value="browser"${ep?"":" selected"}>Print dialog (any printer)</option><option value="epson"${ep?" selected":""}>Epson thermal printer (network)</option></select></label>
      <label class="f" data-epson${ep?"":" hidden"}><span class="lab">Printer IP address</span><input name="host" value="${esc(p.host)}" placeholder="192.168.1.50" autocomplete="off" inputmode="url"><span class="fhint">On the printer's status sheet (hold the feed button while switching it on)</span></label>
      <label class="f" data-epson${ep?"":" hidden"}><span class="lab">Paper width</span><select name="cols"><option value="48"${p.cols===48?" selected":""}>80 mm</option><option value="42"${p.cols===42?" selected":""}>80 mm (font B off)</option><option value="32"${p.cols===32?" selected":""}>58 mm</option></select></label>
      <label class="f" data-epson${ep?"":" hidden"}><span class="lab">Device ID</span><input name="devid" value="${esc(p.devid)}" autocomplete="off"><span class="fhint">Usually local_printer</span></label>
      <label class="chk full" data-epson${ep?"":" hidden"}><input type="checkbox" name="https"${p.https!==false?" checked":""}> Secure connection (https), needed when Hangtag is opened over https</label>
    </div><p class="note" style="margin:0">Saved on this device only: each till can have its own printer. The printer and this device must be on the same Wi-Fi.</p>
    <p id="printerMsg" class="autherr" role="status" hidden></p>
    <div class="setactions"><button class="btn sm primary" type="submit">Save printer</button><button class="btn sm" type="button" data-act="printertest" data-epson${ep?"":" hidden"}>Test print</button></div></form></div>`;
}
export function saveBillingForm(form){
  const f=new FormData(form),err=$("#billErr"),bad=m=>{err.textContent=m;err.hidden=false};
  const r=saveBillingSettings({lowStock:f.get("lowStock"),taxOn:f.get("taxOn"),taxRate:f.get("taxRate"),taxIncl:f.get("taxIncl"),prefix:f.get("prefix"),paper:f.get("paper"),footer:f.get("footer")});
  if(r.error)return bad(r.error);
  renderSync();flushSbQueue();
  err.hidden=true;renderAll();toast("Billing settings saved.");
}
const printerInput=form=>{const f=new FormData(form);return {kind:f.get("kind"),host:f.get("host"),cols:f.get("cols"),devid:f.get("devid"),https:!!f.get("https")}};
function printerMsg(text,ok){const m=$("#printerMsg");if(!m)return;m.textContent=text;m.hidden=!text;m.classList.toggle("okmsg",!!ok)}
const redrawReceiptSetup=()=>{const s=$("#receiptSetup");if(s)s.outerHTML=receiptSetupHTML()};

/* Registered once at start-up (app/main.js). */
export function installBillingSettingsEvents(){
  document.addEventListener("submit",e=>{
    if(e.target.id==="billingForm"){e.preventDefault();saveBillingForm(e.target);return}
    if(e.target.id==="printerForm"){e.preventDefault();const r=savePrinterSettings(printerInput(e.target));if(r.error){printerMsg(r.error);return}printerMsg("Printer saved on this device.",true);toast("Printer saved.")}
  });
  document.addEventListener("change",async e=>{
    const t=e.target;
    if(t.matches&&t.matches("[data-printerkind]")){const ep=t.value==="epson";t.form.querySelectorAll("[data-epson]").forEach(x=>{x.hidden=!ep});document.querySelectorAll("#receiptSetup [data-act=printertest]").forEach(x=>{x.hidden=!ep});return}
    if(t.matches&&t.matches("[data-logofile]")){const f=t.files&&t.files[0];t.value="";if(!f)return;const r=await setReceiptLogo(f);if(r.error){toast(r.error);return}redrawReceiptSetup();flushSbQueue();toast("Logo saved. It prints on every receipt.")}
  });
  document.addEventListener("click",async e=>{
    const a=e.target.closest&&e.target.closest("#receiptSetup [data-act]");if(!a)return;
    if(a.dataset.act==="logoremove"){removeReceiptLogo();redrawReceiptSetup();flushSbQueue();toast("Logo removed.");return}
    if(a.dataset.act==="printertest"){const form=$("#printerForm");printerMsg("Printing a test receipt…");const r=await testPrinter(printerInput(form));printerMsg(r.error||"✓ The printer printed the test receipt.",!r.error)}
  });
}
