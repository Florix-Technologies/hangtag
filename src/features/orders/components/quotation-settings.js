// Settings → Bills & Documents → Quotations: the quotation document's light template — its title, number prefix, footer, the terms
// a new quotation starts with, a signature line and whether GST is shown. Part of the shop's synced settings
// (settings.quote*); shown to a shop that makes quotations. Also on Receipt: the page invoice links open (the owner's
// app keeps it; use-cases/receipt-page.js in the shop feature).
import { store } from '../../../shared/state/store.js';
import { checkQuotationSettings } from '../../../domain/shop/settings-validation.js';
import { quotePrefix } from '../../../domain/orders/orders.js';
import { denied, isMember } from '../../shop/services/access.js';
import { appReceiptPage, rememberReceiptPage, shopReceiptPage } from '../../shop/use-cases/receipt-page.js';
import { enqueue, flushSbQueue } from '../../sync/services/outbox.js';
import { renderSync } from '../../sync/components/sync-status.js';
import { saveSettings } from '../../../shared/state/persistence.js';
import { toast } from '../../../shared/components/toast.js';
import { $, esc } from '../../../shared/dom.js';
import { renderAll } from '../../../shared/ui/render.js';

export function quotationSettingsHTML(){
  const s = store.settings || {};
  return `<div class="setsec" id="quoteSetup"><h4>Quotations</h4>
    <form id="quoteSetForm" class="authform" novalidate><div class="pgrid">
      <label class="f"><span class="lab">Title</span><input name="quoteTitle" maxlength="40" value="${esc(s.quoteTitle || "QUOTATION")}"><span class="fhint">At the top of every quotation. It can't say invoice.</span></label>
      <label class="f"><span class="lab">Number prefix</span><input name="quotePrefix" maxlength="10" value="${esc(s.quotePrefix == null ? "QT" : s.quotePrefix)}" autocapitalize="characters"><span class="fhint">Numbers look like ${esc(quotePrefix(s.quotePrefix))}260929-K3F001.</span></label>
      <label class="f full"><span class="lab">Terms &amp; conditions <small>(a new quotation starts with these)</small></span><textarea name="quoteTerms" rows="3" maxlength="2000">${esc(s.quoteTerms || "")}</textarea></label>
      <label class="f"><span class="lab">Signature line <small>(optional)</small></span><input name="quoteSignature" maxlength="200" value="${esc(s.quoteSignature || "")}" placeholder="For Shop name · Authorised signatory"></label>
      <label class="f"><span class="lab">Footer <small>(optional; else the bill's footer)</small></span><input name="quoteFooter" maxlength="300" value="${esc(s.quoteFooter || "")}"></label>
      <label class="chk full"><input type="checkbox" name="quoteGst"${s.quoteGst === false ? "" : " checked"}> Show GST on quotations</label>
    </div>
    <p id="quoteSetErr" class="autherr" role="alert" hidden></p>
    <div class="setactions"><button class="btn sm primary" type="submit">Save quotation settings</button></div></form></div>`;
}
/* SaveQuotationSettings (needs manage_settings; saved here, then uploaded with the shop's settings) → { error } | { ok } */
export function saveQuotationSettings(input){
  const no = denied("manage_settings", "change the quotation settings"); if(no) return no;
  const r = checkQuotationSettings(input); if(r.error) return r;
  store.settings = Object.assign({}, store.settings, r.patch); saveSettings(); enqueue({ type: "settings" });
  return { ok: true };
}
export function quotationSettingsSubmit(e){
  if(e.target.id !== "quoteSetForm") return false;
  e.preventDefault();
  const f = new FormData(e.target), err = $("#quoteSetErr");
  const r = saveQuotationSettings({ quoteTitle: f.get("quoteTitle"), quotePrefix: f.get("quotePrefix"), quoteTerms: f.get("quoteTerms"), quoteSignature: f.get("quoteSignature"),
    quoteFooter: f.get("quoteFooter"), quoteGst: !!f.get("quoteGst") });
  if(r.error){ if(err){ err.textContent = r.error; err.hidden = false; } return true; }
  if(err) err.hidden = true;
  renderSync(); flushSbQueue(); renderAll(); toast("Quotation settings saved.");
  return true;
}
/* Receipt → Invoice links: the page they open (the owner's own) */
export function invoicePageHTML(){
  if(isMember()) return "";
  const cur = shopReceiptPage(), mine = appReceiptPage();
  return `<div class="setsec" id="invoicePage"><h4>Invoice links</h4><p class="note" style="margin:0">Links sent with bills open ${cur ? `<b>${esc(cur)}</b>` : "the shop's receipt page once it is set"}${mine && mine !== cur ? `. This app's page is ${esc(mine)}.` : "."}</p>
    ${mine && mine !== cur ? `<div class="setactions"><button class="btn sm" type="button" data-invpage>Use this app's page</button></div>` : ""}</div>`;
}
export function invoicePageClick(t){
  if(!t.closest || !t.closest("[data-invpage]")) return false;
  if(rememberReceiptPage(true)){ renderSync(); renderAll(); toast("Invoice links now open this app's receipt page."); }
  else toast("Only the shop's owner can change this, from this app's address.");
  const host = $("#invoicePage"); if(host) host.outerHTML = invoicePageHTML();
  return true;
}
