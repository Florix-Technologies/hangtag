// Settings → Billing & Documents → Templates: the look of every A4 document (tax invoice, bill, quotation, sales order,
// delivery challan, credit note, purchase order) — Modern, Classic or Minimal, an accent colour, GST details shown or not,
// terms, a signature line and bank or UPI details — with a preview before saving. 80 mm receipts keep their compact layout.
import { store } from '../../../shared/state/store.js';
import { $, esc } from '../../../shared/dom.js';
import { toast } from '../../../shared/components/toast.js';
import { renderSync } from '../../sync/components/sync-status.js';
import { flushSbQueue } from '../../sync/services/outbox.js';
import { sheetHTML } from '../../../shared/ui/kit.js';
import { DOC_ACCENTS, DOC_TEMPLATES, checkDocSettings, docSettingsOf } from '../../../domain/documents/doc-settings.js';
import { saveDocSettings } from '../../shop/use-cases/save-billing-settings.js';
import { D } from '../../inventory/services/ledger.js';
import { invoiceModel } from '../services/doc-models.js';
import { documentFrameHTML, fitDocFrames } from './doc-render.js';
import { accountBalances } from '../../finance/use-cases/bank-accounts.js';

export function docTemplatesHTML(){
  const S = docSettingsOf(store.settings);
  return `<form id="docTplForm" class="authform setblk" novalidate><h5>Templates</h5>
    <p class="note" style="margin:0 0 4px">One look for every A4 document: tax invoices and bills, quotations, sales orders, delivery challans, credit notes and purchase orders. Receipts on the 80 mm printer keep their compact receipt layout.</p>
    <div class="tplpick" role="radiogroup" aria-label="Template">${DOC_TEMPLATES.map(t => `<label class="tplcard"><input type="radio" name="docTpl" value="${t.key}"${S.template === t.key ? " checked" : ""}><span class="tplmini tpl-${t.key}" aria-hidden="true"><i></i><i></i><i></i><i></i></span><b>${esc(t.label)}</b><small>${esc(t.hint)}</small></label>`).join("")}</div>
    <div class="f"><span class="lab">Accent colour</span><div class="accpick" role="radiogroup" aria-label="Accent colour">${DOC_ACCENTS.map(a => `<label class="accsw" title="${esc(a.label)}"><input type="radio" name="docAccent" value="${a.key}"${S.accent.toLowerCase() === a.key.toLowerCase() ? " checked" : ""}><span style="background:${a.key}"></span><small>${esc(a.label)}</small></label>`).join("")}</div></div>
    <label class="chk"><input type="checkbox" name="docGst"${S.showGst ? " checked" : ""}> Show GST details (rates, taxable values, CGST / SGST / IGST) on documents with GST</label>
    <div class="pgrid">
      <label class="f full"><span class="lab">Terms &amp; conditions <small>(printed on invoices, bills and sales orders)</small></span><textarea name="docTerms" rows="3" maxlength="1200" placeholder="e.g. Goods once sold can be exchanged within 7 days with the bill.">${esc(S.terms)}</textarea></label>
      <label class="f"><span class="lab">Signature line</span><input name="docSign" maxlength="120" value="${esc(S.signature)}" placeholder="For ${esc((store.profile && store.profile.shop_name) || "your shop")}"></label>
      <label class="f full"><span class="lab">Bank &amp; payment details <small>(optional)</small></span><textarea name="docBank" rows="2" maxlength="400" placeholder="e.g. HDFC Bank · A/c 50200012345678 · IFSC HDFC0001234 · UPI shop@okhdfc">${esc(S.bank)}</textarea>
        <span class="fhint"><button type="button" class="link xs" data-docbankfill>Fill from my default bank account and UPI ID</button></span></label>
    </div>
    <p id="docTplErr" class="autherr" role="alert" hidden></p>
    <div class="formacts"><button type="button" class="btn text" data-docpreview>Preview</button><span class="fa-note"></span><button class="btn" type="reset">Cancel</button><button class="btn primary" type="submit">Save templates</button></div></form>`;
}
function formValues(f){
  const d = new FormData(f);
  return { docTpl: d.get("docTpl"), docAccent: d.get("docAccent"), docGst: !!d.get("docGst"), docTerms: d.get("docTerms"), docSign: d.get("docSign"), docBank: d.get("docBank") };
}
/* A model to preview: the latest bill, or one made up from the shop's own details */
function sampleModel(){
  const last = D().sales.filter(s => !s.void).sort((a, b) => b.t - a.t)[0];
  if(last) return invoiceModel(last);
  const p = store.profile || {};
  return { kind: "invoice", title: "Tax Invoice", number: "INV-SAMPLE", seller: { name: p.shop_name || "Your shop", lines: [[p.address, p.city, p.state].filter(Boolean).join(", "), p.phone && "Phone " + p.phone, p.gstin && "GSTIN " + p.gstin] },
    logo: store.logo || "", meta: [["Invoice no.", "INV-SAMPLE"], ["Date", new Date().toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })]],
    parties: [{ label: "Bill to", name: "Customer name", lines: ["Phone number"] }], columns: ["#", "Item", "Qty", "Rate", "Amount"], left: 2,
    rows: [["1", { t: "First item", sub: "Variant · SKU" }, "2", "₹500.00", "₹1,000.00"], ["2", { t: "Second item" }, "1", "₹750.00", "₹750.00"]],
    totals: [["Subtotal", "₹1,750.00"], ["Total", "₹1,750", true]], words: "Rupees one thousand seven hundred and fifty only", notice: "This is a preview with sample lines.", footer: (store.settings && store.settings.footer) || "" };
}
function openPreview(form){
  const v = form ? formValues(form) : null, chk = v ? checkDocSettings(v) : null;
  const S = chk && chk.patch ? docSettingsOf(Object.assign({}, store.settings, chk.patch)) : docSettingsOf(store.settings);
  const m = Object.assign(sampleModel(), { terms: S.terms, bank: S.bank, signature: S.signature });
  $("#modalHost").innerHTML = sheetHTML({ id: "docPrev", cls: "billview wide", title: "Template preview", sub: esc(DOC_TEMPLATES.find(t => t.key === S.template).label + " · as your documents will print"),
    body: `<div class="rcpt-prev a4prev">${documentFrameHTML(m, { template: S.template, accent: S.accent })}</div>`, foot: `<button type="button" class="btn" data-modal-close>Close</button>` });
  fitDocFrames($("#modalHost"));
}
/* Registered once at start-up (app/modules.js) */
let on = false;
export function installDocTemplateEvents(){
  if(on) return; on = true;
  document.addEventListener("click", e => {
    const t = e.target; if(!t || !t.closest) return;
    if(t.closest("[data-docpreview]")){ openPreview($("#docTplForm")); return; }
    if(t.closest("[data-docbankfill]")){
      const f = $("#docTplForm"), box = f && f.querySelector("[name=docBank]"); if(!box) return;
      const def = accountBalances().rows.map(r => r.account).find(a => a.isDefault && a.active !== false), upi = store.settings && store.settings.upiId;
      const text = [def ? [def.bank || def.name, def.last4 ? "A/c ending " + def.last4 : ""].filter(Boolean).join(" · ") : "", upi ? "UPI " + upi : ""].filter(Boolean).join(" · ");
      if(!text){ toast("Add a bank account or your UPI ID in Payments & Banks first."); return; }
      box.value = text; box.dispatchEvent(new Event("input", { bubbles: true }));
    }
  });
  document.addEventListener("submit", e => {
    if(!e.target || e.target.id !== "docTplForm") return;
    e.preventDefault();
    const err = $("#docTplErr"), r = saveDocSettings(formValues(e.target));
    if(r.error){ if(err){ err.textContent = r.error; err.hidden = false; } return; }
    if(err) err.hidden = true;
    renderSync(); flushSbQueue(); toast("Templates saved. Every A4 document uses them now.");
  });
}
