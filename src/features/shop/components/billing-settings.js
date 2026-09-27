// Billing and stock settings form.
import { store } from '../../../shared/state/store.js';
import { renderSync } from '../../sync/components/sync-status.js';
import { flushSbQueue } from '../../sync/services/outbox.js';
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
  <p id="billErr" class="autherr" hidden></p><div class="setactions"><button class="btn sm primary" type="submit">Save billing settings</button></div></form></div>`;
}
export function saveBillingForm(form){
  const f=new FormData(form),err=$("#billErr"),bad=m=>{err.textContent=m;err.hidden=false};
  const r=saveBillingSettings({lowStock:f.get("lowStock"),taxOn:f.get("taxOn"),taxRate:f.get("taxRate"),taxIncl:f.get("taxIncl"),prefix:f.get("prefix"),paper:f.get("paper"),footer:f.get("footer")});
  if(r.error)return bad(r.error);
  renderSync();flushSbQueue();
  err.hidden=true;renderAll();toast("Billing settings saved.");
}

/* Registered once at start-up (app/main.js). */
export function installBillingSettingsEvents(){
  document.addEventListener("submit",e=>{if(e.target.id==="billingForm"){e.preventDefault();saveBillingForm(e.target)}});
}
