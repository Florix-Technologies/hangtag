// E-invoice and e-way bill on the phone: on a bill, one line each — "E-invoice ✓ Ready" or "Needs: Buyer GSTIN" — and a
// short sheet that asks only for what is missing. Never a tax form. Settings → Billing & Documents → E-invoice and e-way bill switches them on.
import { EINV_LABELS } from '../../../domain/gst/einvoice.js';
import { EWAY_LABELS, TRANSPORT_MODES, transportFieldsNeeded } from '../../../domain/gst/eway.js';
import { store } from '../../../shared/state/store.js';
import { esc } from '../../../shared/dom.js';
import { toast } from '../../../shared/components/toast.js';
import { renderAll } from '../../../shared/ui/render.js';
import { can } from '../../shop/services/access.js';
import { einvoiceOf, ewayOf, exportJSON, fillDetails, keepEinvoice, saveGstSettings, saveTransport, usesEinvoice, usesEway } from '../use-cases/gst-documents.js';
import { bizError, bizSheet, chip, closeBiz } from './biz-sheet.js';

const V = () => store.bizView || {};
const TONE = { ready: "ok", pending: "info", generated: "ok", failed: "bad", cancelled: "bad", needs: "warn", not_required: "muted" };
const line = (what, st, labels, saleId, kind) => {
  if(!st || st.state === "not_required") return "";
  const needs = st.state === "needs", label = needs ? (st.missing.length ? "Needs: " + st.missing.slice(0, 2).map(m => m.label).join(", ") + (st.missing.length > 2 ? ` +${st.missing.length - 2}` : "") : st.problems[0]) : labels[st.state];
  return `<div class="disc-row"><span><b>${esc(what)}</b><small>${esc(label || "")}${st.record && st.record.irn ? ` · IRN ${esc(st.record.irn.slice(0, 12))}…` : ""}${st.record && st.record.ewbNo ? ` · EWB ${esc(st.record.ewbNo)}` : ""}</small></span>
    <span class="oc-acts">${chip(needs ? "Needs details" : labels[st.state], TONE[needs ? "needs" : st.state])}<button type="button" class="btn xs" data-gstopen="${kind}|${esc(saleId)}">${needs ? "Add details" : "Open"}</button></span></div>`;
};
/* On the bill view (features/receipts/components/bill-view.js) */
export function gstDocsHTML(sale){
  if(!sale || sale.void || !(usesEinvoice() || usesEway()) || !(can("create_sale") || can("view_reports"))) return "";
  const a = line("E-invoice", einvoiceOf(sale.id), EINV_LABELS, sale.id, "einv"), b = line("E-way bill", ewayOf(sale.id), EWAY_LABELS, sale.id, "eway");
  return a || b ? `<div class="setsec"><h4>GST documents</h4>${a}${b}</div>` : "";
}
const FIELD_INPUT = {
  seller_gstin: () => `<p class="note">Add your shop's GSTIN in Settings → Business.</p>`,
  seller_name: k => `<label class="f full">Business's legal name<input data-gstf="${k}" maxlength="100"></label>`,
  seller_address: () => `<p class="note">Add your shop's address in Settings → Business.</p>`,
  seller_city: () => `<p class="note">Add your shop's city in Settings → Business.</p>`,
  seller_pin: k => `<label class="f">Your shop's PIN code<input data-gstf="${k}" inputmode="numeric" maxlength="6"></label>`,
  buyer_gstin: k => `<label class="f full">Buyer GSTIN<input data-gstf="${k}" maxlength="15" autocapitalize="characters" placeholder="27ABCDE1234F1Z5"></label>`,
  buyer_name: () => `<p class="note">Add the buyer's name in Customers.</p>`,
  buyer_address: k => `<label class="f full">Buyer's address<input data-gstf="${k}" maxlength="200"></label>`,
  buyer_city: k => `<label class="f">Buyer's city<input data-gstf="${k}" maxlength="60"></label>`,
  buyer_pin: k => `<label class="f">Buyer's PIN code<input data-gstf="${k}" inputmode="numeric" maxlength="6"></label><label class="f">Buyer's state<input data-gstf="buyer_state" maxlength="60"></label>`,
};
const missingInputs = list => list.map(m => m.key.startsWith("hsn:") ? `<label class="f">${esc(m.label)}<input data-gstf="${esc(m.key)}" inputmode="numeric" maxlength="8"></label>` : (FIELD_INPUT[m.key] || (() => ""))(m.key)).join("");
export function openGstDoc(kind, saleId){
  store.bizView = { kind: "gst", what: kind, saleId, values: {}, transport: {}, err: "" };
  renderGstDoc();
}
export function renderGstDoc(){
  const F = V(), eway = F.what === "eway", st = eway ? ewayOf(F.saleId) : einvoiceOf(F.saleId);
  if(!st){ closeBiz(); return; }
  const needs = st.state === "needs", missing = st.missing || [], tfields = eway ? transportFieldsNeeded(missing) : [];
  const T = (st.transport || (st.record && st.record.transport) || {});
  const transportInputs = eway && (needs || st.state === "ready") ? `<div class="pgrid">
      <label class="f">How it goes<select data-gstt="mode">${Object.entries(TRANSPORT_MODES).map(([k, m]) => `<option value="${k}"${(F.transport.mode || T.mode || "road") === k ? " selected" : ""}>${esc(m.label)}</option>`).join("")}</select></label>
      ${tfields.includes("vehicle") || T.vehicle ? `<label class="f">Vehicle number<input data-gstt="vehicle" value="${esc(F.transport.vehicle != null ? F.transport.vehicle : T.vehicle || "")}" autocapitalize="characters" placeholder="MH12AB1234"></label>` : ""}
      ${tfields.includes("trans_doc") ? `<label class="f">Transport document no.<input data-gstt="docNo" maxlength="15"></label>` : ""}
      ${tfields.includes("distance") || T.distance != null ? `<label class="f">Distance (km)<input data-gstt="distance" type="number" min="0" max="4000" value="${esc(String(F.transport.distance != null ? F.transport.distance : T.distance != null ? T.distance : ""))}"></label>` : ""}
      ${tfields.includes("to_address") ? `<label class="f full">Delivery address<input data-gstt="to.line" maxlength="120"></label>` : ""}
      ${tfields.includes("to_pin") ? `<label class="f">Delivery PIN code<input data-gstt="to.pin" inputmode="numeric" maxlength="6"></label><label class="f">Delivery city<input data-gstt="to.city" maxlength="50"></label>` : ""}
      <details class="full"><summary>Transporter (optional)</summary><div class="pgrid"><label class="f">Transporter id<input data-gstt="transporterId" maxlength="15" autocapitalize="characters" value="${esc(T.transporterId || "")}"></label><label class="f">Name<input data-gstt="transporterName" maxlength="100" value="${esc(T.transporterName || "")}"></label></div></details></div>` : "";
  const other = missing.filter(m => m.where !== "transport");
  const body = needs
    ? `<div class="biznote warn">Needs ${missing.length ? missing.map(m => esc(m.label)).join(", ") : esc(st.problems[0] || "")}</div>${st.problems.length && missing.length ? `<p class="note">${st.problems.map(esc).join("<br>")}</p>` : ""}${other.length ? `<div class="pgrid">${missingInputs(other)}</div>` : ""}${transportInputs}`
    : st.state === "ready" ? `<div class="biznote ok">✓ Ready${st.record ? "" : " — everything needed is on the bill"}</div>${transportInputs}<p class="note">Hangtag isn't connected to the GST portal yet. Export the JSON for your GST software, or keep it ready to send once a provider is connected.</p>`
    : `<div class="biznote">${esc((eway ? EWAY_LABELS : EINV_LABELS)[st.state] || st.state)}</div>${st.record && st.record.irn ? `<p class="note">IRN ${esc(st.record.irn)}</p>` : ""}`;
  const foot = needs ? `<button type="button" class="btn sm" data-biz="close">Later</button><button type="button" class="btn sm primary" data-biz="gstsave">Save details</button>`
    : st.state === "ready" ? `<button type="button" class="btn sm" data-biz="gstjson">Export JSON</button><button type="button" class="btn sm primary" data-biz="gstkeep">${eway ? "Save" : "Keep ready"}</button>`
    : `<button type="button" class="btn sm" data-biz="gstjson">Export JSON</button>`;
  bizSheet({ label: eway ? "E-way bill" : "E-invoice", body, foot });
}
/* Settings → Billing & Documents → E-invoice and e-way bill */
export function gstSettingsHTML(){
  if(!(usesEinvoice() || usesEway())) return "";
  const e = store.settings.einv || {}, w = store.settings.eway || {};
  return `<form id="gstDocsForm" class="setpart"><h5 class="subh">GST documents</h5><p class="note" style="margin:0">Hangtag prepares and checks them; the rules depend on your turnover, so you decide when they're needed.</p>
    ${usesEinvoice() ? `<label class="chk"><input type="checkbox" name="einvOn"${e.on ? " checked" : ""}> Prepare e-invoices for business bills</label>` : ""}
    ${usesEway() ? `<label class="chk"><input type="checkbox" name="ewayOn"${w.on ? " checked" : ""}> Prepare e-way bills for bills of ₹<input name="threshold" type="number" min="0" step="1" value="${esc(String(w.threshold == null ? 50000 : w.threshold))}" style="width:90px"> or more</label>` : ""}
    <details><summary>Legal name, PIN code</summary><div class="pgrid"><label class="f">Legal name (if not the shop name)<input name="legalName" maxlength="100" value="${esc(e.legalName || "")}"></label><label class="f">Shop's PIN code<input name="pin" inputmode="numeric" maxlength="6" value="${esc(e.pin || "")}"></label></div></details>
    <div class="setactions"><button type="submit" class="btn sm">Save</button></div></form>`;
}
/* ---------- events ---------- */
export function gstClick(t){
  const o = t.closest("[data-gstopen]"); if(o){ const [kind, id] = o.dataset.gstopen.split("|"); openGstDoc(kind, id); return true; }
  const F = V(); if(F.kind !== "gst") return false;
  const b = t.closest("[data-biz]"); if(!b) return false;
  const eway = F.what === "eway";
  if(b.dataset.biz === "gstsave"){
    const r = fillDetails(F.saleId, F.values); if(r.error){ bizError(r.error); return true; }
    if(eway){ const x = saveTransport(F.saleId, F.transport); if(x.error){ bizError(x.error); return true; } }
    F.values = {}; F.err = ""; renderGstDoc(); renderAll(); return true;
  }
  if(b.dataset.biz === "gstkeep"){
    const r = eway ? saveTransport(F.saleId, F.transport, "ready") : keepEinvoice(F.saleId, "ready");
    if(r.error){ bizError(r.error); return true; }
    toast(eway ? "E-way bill details saved." : "E-invoice kept ready."); closeBiz(); renderAll(); return true;
  }
  if(b.dataset.biz === "gstjson"){ exportJSON(F.saleId, eway ? "eway" : "einv").then(r => { if(r.error) bizError(r.error); else toast(`Saved ${r.name}.`); }); return true; }
  return false;
}
export function gstInput(t){
  const F = V(); if(F.kind !== "gst") return false;
  if(t.matches("[data-gstf]")){ F.values[t.dataset.gstf] = t.value; return true; }
  if(t.matches("[data-gstt]")){ const k = t.dataset.gstt; if(k.startsWith("to.")) F.transport.to = { ...(F.transport.to || {}), [k.slice(3)]: t.value }; else F.transport[k] = t.value; return true; }
  return false;
}
export function gstChange(t){ return gstInput(t); }
export function gstSubmit(e){
  if(e.target.id !== "gstDocsForm") return false;
  e.preventDefault();
  const f = new FormData(e.target), r = saveGstSettings({ einvOn: !!f.get("einvOn"), b2bOnly: true, legalName: f.get("legalName"), pin: f.get("pin"), ewayOn: !!f.get("ewayOn"), threshold: f.get("threshold") });
  toast(r.error || "GST settings saved."); return true;
}
