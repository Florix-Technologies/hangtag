// Settings → Bills & Documents → Templates: the look of every A4 document (tax invoice, bill, quotation, sales order,
// delivery challan, credit note, purchase order) — Standard, Classic, Modern or Compact, an accent colour, GST details shown
// or not, terms, a signature line, bank or UPI details, and the authorised signature and company stamp (pictures: upload,
// replace, remove, print or not). The preview beside the choices is the real document — the latest bill (or sample lines)
// drawn by the same renderer and settings as print and PDF — and follows the form as it changes, before anything is saved.
// 80 mm receipts keep their thermal layout.
import { store } from '../../../shared/state/store.js';
import { $, esc } from '../../../shared/dom.js';
import { toast } from '../../../shared/components/toast.js';
import { renderSync } from '../../sync/components/sync-status.js';
import { flushSbQueue } from '../../sync/services/outbox.js';
import { sheetHTML } from '../../../shared/ui/kit.js';
import { DOC_ACCENTS, DOC_IMAGE_KINDS, DOC_TEMPLATES, checkDocSettings, docSettingsOf } from '../../../domain/documents/doc-settings.js';
import { saveDocSettings } from '../../shop/use-cases/save-billing-settings.js';
import { removeDocImage, setDocImage } from '../../shop/use-cases/doc-images.js';
import { D } from '../../inventory/services/ledger.js';
import { formatMoney, inr } from '../../../shared/formatting/money.js';
import { fmtDate } from '../../../shared/formatting/dates.js';
import { amountInWords } from '../../../domain/invoices/amount-words.js';
const money2 = n => formatMoney(n, { decimals: 2 });   // the preview's columns, as on a real invoice
import { invoiceModel } from '../services/doc-models.js';
import { documentFrameHTML, fitDocFrames } from './doc-render.js';
import { accountBalances } from '../../finance/use-cases/bank-accounts.js';

/* The signature and stamp: each with its picture (or none yet), Upload / Replace, Remove, and whether it is printed */
function picturesHTML(S){
  const im = store.docImages || {};
  const card = (kind, on) => { const src = im[kind], lab = DOC_IMAGE_KINDS[kind];
    return `<div class="docpic" data-docpic="${kind}"><b>${esc(lab)}</b><span class="docpic-prev">${src ? `<img src="${esc(src)}" alt="${esc(lab)}">` : `<span class="note">None yet</span>`}</span>
      <span class="docpic-acts"><label class="btn sm">${src ? "Replace" : "Upload"}<input type="file" accept="image/png,image/jpeg,image/webp" data-docpicfile="${kind}" hidden></label>${src ? `<button type="button" class="btn sm text danger" data-docpicremove="${kind}">Remove</button>` : ""}</span>
      <label class="chk"><input type="checkbox" name="${kind === "signature" ? "docSignImg" : "docStampImg"}"${on ? " checked" : ""}${src ? "" : " disabled"}> Print on documents</label></div>`; };
  return `<div class="docpics">${card("signature", S.signImg)}${card("stamp", S.stampImg)}</div>
    <p class="note">A clear picture on white works best (PNG or JPG). It prints at the signature of A4 documents and PDFs; receipts on the 80 mm printer don't carry it.</p>`;
}
export function docTemplatesHTML(){
  const S = docSettingsOf(store.settings);
  return `<form id="docTplForm" class="authform setblk" novalidate><h5>Templates</h5>
    <p class="note" style="margin:0 0 4px">One look for every A4 document: tax invoices and bills, quotations, sales orders, delivery challans, credit notes and purchase orders. These are your shop's layouts for GST invoices. Receipts on the 80 mm printer keep their compact receipt layout.</p>
    <div class="tplpick" role="radiogroup" aria-label="Template">${DOC_TEMPLATES.map(t => `<label class="tplcard"><input type="radio" name="docTpl" value="${t.key}"${S.template === t.key ? " checked" : ""}><b>${esc(t.label)}</b><small>${esc(t.hint)}</small></label>`).join("")}</div>
    <div class="f"><span class="lab">Accent colour</span><div class="accpick" role="radiogroup" aria-label="Accent colour">${DOC_ACCENTS.map(a => `<label class="accsw" title="${esc(a.label)}"><input type="radio" name="docAccent" value="${a.key}"${S.accent.toLowerCase() === a.key.toLowerCase() ? " checked" : ""}><span style="background:${a.key}"></span><small>${esc(a.label)}</small></label>`).join("")}</div></div>
    <div class="doclive" id="docTplLive" aria-label="Preview of your documents">${liveHTML(formModelOpts(null))}</div>
    <label class="chk"><input type="checkbox" name="docGst"${S.showGst ? " checked" : ""}> Show GST details (rates, taxable values, CGST / SGST / IGST) on documents with GST</label>
    <div class="pgrid">
      <label class="f full"><span class="lab">Terms &amp; conditions <small>(printed on invoices, bills and sales orders)</small></span><textarea name="docTerms" rows="3" maxlength="1200" placeholder="e.g. Goods once sold can be exchanged within 7 days with the bill.">${esc(S.terms)}</textarea></label>
      <label class="f"><span class="lab">Signature line</span><input name="docSign" maxlength="120" value="${esc(S.signature)}" placeholder="For ${esc((store.profile && store.profile.shop_name) || "your shop")}"></label>
      <label class="f full"><span class="lab">Bank &amp; payment details <small>(optional)</small></span><textarea name="docBank" rows="2" maxlength="400" placeholder="e.g. HDFC Bank · A/c 50200012345678 · IFSC HDFC0001234 · UPI shop@okhdfc">${esc(S.bank)}</textarea>
        <span class="fhint"><button type="button" class="link xs" data-docbankfill>Fill from my default bank account and UPI ID</button></span></label>
    </div>
    <h5 class="setsubhead">Authorised signature and company stamp</h5>
    <div id="docPics">${picturesHTML(S)}</div>
    <p id="docTplErr" class="autherr" role="alert" hidden></p>
    <div class="formacts"><button type="button" class="btn text" data-docpreview>Full preview</button><span class="fa-note"></span><button class="btn" type="reset">Cancel</button><button class="btn primary" type="submit">Save templates</button></div></form>`;
}
function formValues(f){
  // a picture's "Print on documents" is read from its box (a disabled box — no picture yet — keeps the default: printed)
  const d = new FormData(f), box = n => { const b = f.querySelector(`[name="${n}"]`); return b && !b.disabled ? b.checked : undefined; };
  return { docTpl: d.get("docTpl"), docAccent: d.get("docAccent"), docGst: !!d.get("docGst"), docTerms: d.get("docTerms"), docSign: d.get("docSign"), docBank: d.get("docBank"),
    docSignImg: box("docSignImg"), docStampImg: box("docStampImg") };
}
/* A model to preview: the latest bill, or one made up from the shop's own details */
function sampleModel(){
  const last = D().sales.filter(s => !s.void).sort((a, b) => b.t - a.t)[0];
  if(last) return invoiceModel(last);
  const p = store.profile || {};
  return { kind: "invoice", title: "Tax Invoice", number: "INV-SAMPLE", seller: { name: p.shop_name || "Your shop", lines: [[p.address, p.city, p.state].filter(Boolean).join(", "), p.phone && "Phone " + p.phone, p.gstin && "GSTIN " + p.gstin] },
    logo: store.logo || "", meta: [["Invoice no.", "INV-SAMPLE"], ["Date", fmtDate(Date.now(), { day: "numeric", month: "short", year: "numeric" })]],
    parties: [{ label: "Bill to", name: "Customer name", lines: ["Phone number"] }], columns: ["#", "Item", "Qty", "Rate", "Amount"], left: 2,
    rows: [["1", { t: "First item", sub: "Variant · SKU" }, "2", money2(500), money2(1000)], ["2", { t: "Second item" }, "1", money2(750), money2(750)]],
    totals: [["Subtotal", money2(1750)], ["Total", inr(1750), true]], words: amountInWords(1750), notice: "This is a preview with sample lines.", footer: (store.settings && store.settings.footer) || "" };
}
/* The document as the form stands (not saved yet): { m (the model), o (template and accent) } */
function formModelOpts(form){
  const v = form ? formValues(form) : null, chk = v ? checkDocSettings(v) : null;
  const S = chk && chk.patch ? docSettingsOf(Object.assign({}, store.settings, chk.patch)) : docSettingsOf(store.settings), im = store.docImages || {};
  const m = Object.assign(sampleModel(), { terms: S.terms, bank: S.bank, signature: S.signature, signImg: S.signImg && im.signature || "", stampImg: S.stampImg && im.stamp || "" });
  return { m, o: { template: S.template, accent: S.accent }, S };
}
const liveHTML = ({ m, o }) => `<div class="rcpt-prev a4prev">${documentFrameHTML(m, o)}</div>`;
let liveT = 0;
function redrawLive(now){
  clearTimeout(liveT);
  liveT = setTimeout(() => { const f = $("#docTplForm"), box = $("#docTplLive"); if(!f || !box) return; box.innerHTML = liveHTML(formModelOpts(f)); fitDocFrames(box); }, now ? 0 : 250);
}
function openPreview(form){
  const { m, o, S } = formModelOpts(form);
  $("#modalHost").innerHTML = sheetHTML({ id: "docPrev", cls: "billview wide", title: "Template preview", sub: esc(DOC_TEMPLATES.find(t => t.key === S.template).label + " · as your documents will print"),
    body: liveHTML({ m, o }), foot: `<button type="button" class="btn" data-modal-close>Close</button>` });
  fitDocFrames($("#modalHost"));
}
/* After a picture changed: its card again (its print choice kept as typed), and the preview */
function redrawPictures(){
  const f = $("#docTplForm"), box = $("#docPics"); if(!f || !box) return;
  const v = formValues(f), S = docSettingsOf(Object.assign({}, store.settings, { docSignImg: v.docSignImg !== false, docStampImg: v.docStampImg !== false }));
  box.innerHTML = picturesHTML(S); redrawLive(true);
}
/* Registered once at start-up (app/modules.js) */
let on = false;
export function installDocTemplateEvents(){
  if(on) return; on = true;
  document.addEventListener("click", e => {
    const t = e.target; if(!t || !t.closest) return;
    if(t.closest("[data-docpreview]")){ openPreview($("#docTplForm")); return; }
    const rm = t.closest("[data-docpicremove]");
    if(rm){ const r = removeDocImage(rm.dataset.docpicremove); if(r.error){ toast(r.error); return; } redrawPictures(); flushSbQueue(); toast(DOC_IMAGE_KINDS[rm.dataset.docpicremove] + " removed."); return; }
    if(t.closest("[data-docbankfill]")){
      const f = $("#docTplForm"), box = f && f.querySelector("[name=docBank]"); if(!box) return;
      const def = accountBalances().rows.map(r => r.account).find(a => a.isDefault && a.active !== false), upi = store.settings && store.settings.upiId;
      const text = [def ? [def.bank || def.name, def.last4 ? "A/c ending " + def.last4 : ""].filter(Boolean).join(" · ") : "", upi ? "UPI " + upi : ""].filter(Boolean).join(" · ");
      if(!text){ toast("Add a bank account or your UPI ID in Payments & Banks first."); return; }
      box.value = text; box.dispatchEvent(new Event("input", { bubbles: true }));
    }
  });
  // the preview follows the form: at once for a choice, a moment after typing stops
  document.addEventListener("change", async e => {
    const t = e.target; if(!t || !t.closest || !t.closest("#docTplForm")) return;
    if(t.matches("[data-docpicfile]")){
      const kind = t.dataset.docpicfile, file = t.files && t.files[0]; t.value = ""; if(!file) return;
      const r = await setDocImage(kind, file); if(r.error){ toast(r.error); return; }
      redrawPictures(); flushSbQueue(); toast(DOC_IMAGE_KINDS[kind] + " saved. It prints on A4 documents.");
      return;
    }
    redrawLive(true);
  });
  document.addEventListener("input", e => { if(e.target && e.target.closest && e.target.closest("#docTplForm") && /^(docTerms|docSign|docBank)$/.test(e.target.name || "")) redrawLive(false); });
  document.addEventListener("reset", e => { if(e.target && e.target.id === "docTplForm") setTimeout(() => { redrawPictures(); }, 0); });
  document.addEventListener("submit", e => {
    if(!e.target || e.target.id !== "docTplForm") return;
    e.preventDefault();
    const err = $("#docTplErr"), r = saveDocSettings(formValues(e.target));
    if(r.error){ if(err){ err.textContent = r.error; err.hidden = false; } return; }
    if(err) err.hidden = true;
    renderSync(); flushSbQueue(); toast("Templates saved. Every A4 document uses them now.");
  });
}
