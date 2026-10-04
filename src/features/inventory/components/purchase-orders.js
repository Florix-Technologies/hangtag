// Purchase orders on the phone (Inventory → Purchase orders; "Create PO" from Smart reorder; Receive inside the PO).
//   new PO:   supplier → scan or search products → quantities → Create PO   (expected date, prices, GST, notes folded away)
//   open PO:  what is ordered / received / still to come, and one main action: Receive
//   receive:  each line starts at what is still to come; change only what differs; scan to count; Confirm
//   compare:  "✓ Everything matches", or the differences with Accept / Note (only when something differs)
import { purchaseOrderModel } from '../../receipts/services/doc-models.js';
import { downloadDocumentPdf, printDocument, shareDocumentPdf } from '../../receipts/components/doc-actions.js';
import { PO_LABELS } from '../../../domain/inventory/purchase-orders.js';
import { qtyText } from '../../../domain/catalog/units.js';
import { vLabel, variantsOf } from '../../../domain/catalog/variants.js';
import { store } from '../../../shared/state/store.js';
import { esc } from '../../../shared/dom.js';
import { inr } from '../../../shared/formatting/money.js';
import { toast } from '../../../shared/components/toast.js';
import { renderAll } from '../../../shared/ui/render.js';
import { can } from '../../shop/services/access.js';
import { hasCap } from '../../shop/services/shop-caps.js';
import { liveProducts } from '../../products/services/catalog.js';
import { bizError, bizSheet, chip } from '../../commerce/components/biz-sheet.js';
import { suppliersList, supplierById } from '../services/purchase-state.js';
import { trackingOfP } from '../services/tracking.js';
import { vRec } from '../services/ledger.js';
import { billStart, newPODraft, poById, poDifferences, poFromReorder, poLine, poList, poProgressOf, receivePO, receiveStart, reorderGroups, reviewDifference, savePO, savePOBill,
  setPOStatus } from '../use-cases/purchase-orders.js';

const V = () => store.bizView || {};
const TONE = { draft: "muted", sent: "info", partial: "warn", received: "ok", closed: "muted", cancelled: "bad" };
const stat = s => chip(PO_LABELS[s] || s, TONE[s] || "muted");
export const usesPOs = () => hasCap("uses_purchase_orders");

/* ---------- Inventory → Purchase orders ---------- */
export function renderPurchaseOrdersView(host){
  const list = poList(), open = list.filter(p => !["closed", "cancelled"].includes(p.status) && poProgressOf(p).status !== "received");
  const row = po => { const P = poProgressOf(po), sup = supplierById(po.supplierId);
    return `<button type="button" class="bizrow" data-poopen="${esc(po.id)}"><span><b>${esc(sup ? sup.name : "Supplier")}</b><small>${esc(po.no || "")} · ${po.items.length} item${po.items.length === 1 ? "" : "s"}${P.received ? ` · ${qtyText(P.received)} of ${qtyText(P.ordered)} in` : ""}</small></span>${stat(P.status)}</button>`; };
  host.innerHTML = `<div class="intel-head"><div><span class="eyebrow">Buying</span><h2 class="vt">Purchase orders</h2><p>Order from a supplier, then receive what arrives. Only receiving adds stock.</p></div>
    <div class="otools">${can("create_purchase") ? `<button type="button" class="btn sm primary" data-ponew>New purchase order</button><button type="button" class="btn sm" data-invsub="smart">From Smart reorder</button>` : ""}</div></div>
    ${open.length ? `<div class="bizlist">${open.map(row).join("")}</div>` : `<div class="empty compact"><p>No open purchase orders.</p></div>`}
    ${list.length > open.length ? `<details class="pu-more"><summary>Received, closed and cancelled (${list.length - open.length})</summary><div class="bizlist">${list.filter(p => !open.includes(p)).slice(0, 50).map(row).join("")}</div></details>` : ""}`;
}
/* ---------- Smart reorder → "Create PO" (features/inventory/pages/smart-reorder-page.js) ---------- */
export function reorderPOsHTML(){
  if(!usesPOs() || !can("create_purchase")) return "";
  const groups = reorderGroups(); if(!groups.length) return "";
  return `<section class="intel-section"><div class="intel-section-head"><div><h3>Recommended purchase</h3><p>Grouped by the supplier each product last came from. Review, then create the order.</p></div></div>
    ${groups.map((g, i) => `<div class="reorder-group"><h4>${esc(g.supplier || "Choose a supplier")}</h4>${g.items.slice(0, 8).map(l => `<div class="reorder-line"><span>${esc(l.name)}${l.vl ? ` · ${esc(l.vl)}` : ""}</span><b>+${esc(qtyText(l.q, l.u))}</b></div>`).join("")}
      ${g.items.length > 8 ? `<small class="muted">and ${g.items.length - 8} more</small>` : ""}<div class="setactions"><button type="button" class="btn sm primary" data-poreorder="${i}">Create PO</button></div></div>`).join("")}</section>`;
}
/* ---------- the PO editor (new or a draft) ---------- */
export function openPOEditor(id, seed){
  const po = id ? poById(id) : seed || newPODraft({ supplierId: (suppliersList()[0] || {}).id || "" });
  if(!po){ toast("That purchase order isn't on this device."); return; }
  store.bizView = { kind: "po", po: JSON.parse(JSON.stringify(po)), q: "", err: "" };
  renderPOEditor();
}
function editorHits(q){
  const s = String(q || "").trim().toLowerCase(); if(!s) return "";
  const hits = [];
  liveProducts().forEach(p => variantsOf(p).forEach(v => { if(hits.length < 8 && (p.name.toLowerCase().includes(s) || String(v.sku || "").toLowerCase() === s || String(v.bc || "") === s)) hits.push({ p, v }); }));
  return hits.map(({ p, v }) => `<button type="button" class="ohit" data-poadd="${esc(v.id)}"><b>${esc(p.name)}</b><span>${esc(vLabel(v) || "")}</span></button>`).join("") || `<p class="muted">No product matches.</p>`;
}
export function renderPOEditor(){
  const F = V(), po = F.po, sups = suppliersList();
  bizSheet({ label: po.no ? `Purchase order ${po.no}` : "New purchase order", cls: "poedit",
    body: `<label class="f full">Supplier<select data-posup><option value="">Choose the supplier…</option>${sups.map(s => `<option value="${esc(s.id)}"${po.supplierId === s.id ? " selected" : ""}>${esc(s.name)}</option>`).join("")}</select></label>
      <input type="search" class="bizsearch" data-poq value="${esc(F.q || "")}" placeholder="Scan or search a product to add" aria-label="Scan or search a product">
      <div class="ohits" data-pohits>${editorHits(F.q)}</div>
      <div class="bizlist">${po.items.map((l, i) => `<div class="poline"><span><b>${esc(l.name)}</b><small>${esc(l.vl || "")}${l.price != null ? ` · ${inr(l.price)} each` : ""}</small></span><span><input type="number" inputmode="decimal" min="0" step="any" value="${esc(String(l.q))}" data-poqty="${i}" aria-label="How many ${esc(l.name)}"></span></div>`).join("") || `<p class="muted">Add the products to order.</p>`}</div>
      <details><summary>Expected date, prices, GST, note</summary><div class="pgrid"><label class="f">Expected<input type="date" data-poexp value="${esc(po.expected || "")}"></label>
        <label class="f full">Note<textarea data-ponotes rows="2" maxlength="500">${esc(po.notes || "")}</textarea></label></div>
        ${po.items.map((l, i) => `<div class="poline"><span><b>${esc(l.name)}</b><small>agreed price · GST %</small></span><span><input type="number" inputmode="decimal" min="0" step="any" value="${l.price == null ? "" : esc(String(l.price))}" data-poprice="${i}" aria-label="Agreed price of ${esc(l.name)}"> <input type="number" inputmode="decimal" min="0" max="100" step="any" value="${l.gst == null ? "" : esc(String(l.gst))}" data-pogst="${i}" aria-label="GST % of ${esc(l.name)}"></span></div>`).join("")}</details>`,
    foot: `${po.version || po.no ? `<button type="button" class="btn sm" data-biz="close">Cancel</button>` : ""}<button type="button" class="btn sm primary" data-biz="posave">${po.no ? "Save" : "Create PO"}</button>` });
}
/* ---------- an open PO ---------- */
export function openPODetail(id){
  const po = poById(id); if(!po){ toast("That purchase order isn't on this device."); return; }
  store.bizView = { kind: "podetail", id, err: "" };
  const P = poProgressOf(po), sup = supplierById(po.supplierId), diffs = poDifferences(po), open = diffs.filter(d => !d.accepted);
  const canRecv = can("create_purchase") && !["closed", "cancelled"].includes(po.status) && P.status !== "received";
  const lines = P.lines.map(l => `<div class="poline${l.remaining <= 0 ? " done" : ""}"><span><b>${esc(l.name)}</b><span class="recv-nums"><span>Ordered <b>${esc(qtyText(l.ordered, l.u))}</b></span><span>Previously received <b>${esc(qtyText(l.received, l.u))}</b></span><span>Remaining <b>${esc(qtyText(l.remaining, l.u))}</b></span></span></span><span>${l.remaining <= 0 ? chip("✓", "ok") : ""}</span></div>`).join("");
  const compare = P.received > 0 || po.bill ? (open.length
    ? `<div class="biznote warn">⚠ ${open.length} difference${open.length === 1 ? "" : "s"}</div>${open.map(d => `<div class="disc-row"><span><b>${esc(d.name)}</b><small>${esc(d.text)}</small></span><span class="oc-acts"><button type="button" class="btn xs" data-podiff="accepted|${esc(d.key)}">Accept</button><button type="button" class="btn xs" data-podiff="note|${esc(d.key)}">Note</button></span></div>`).join("")}`
    : `<div class="biznote ok">✓ Everything matches${po.bill ? " (order, goods and bill)" : " so far"}</div>`) : "";
  const acts = [];
  if(can("create_purchase")){
    if(po.status === "draft") acts.push(`<button type="button" class="btn sm" data-postatus="sent">Mark sent</button>`, `<button type="button" class="btn sm" data-poedit>Edit</button>`);
    if(!["closed", "cancelled"].includes(po.status)) acts.push(`<button type="button" class="btn sm" data-pobill>${po.bill ? "Supplier bill" : "Add supplier bill"}</button>`);
    if(!["closed", "cancelled"].includes(po.status) && P.received > 0) acts.push(`<button type="button" class="btn sm" data-postatus="closed">Close</button>`);
    if(["draft", "sent"].includes(po.status) && !P.received) acts.push(`<button type="button" class="btn sm danger" data-postatus="cancelled">Cancel PO</button>`);
  }
  acts.push(`<button type="button" class="btn sm" data-podoc="print" data-id="${esc(po.id)}">Print</button>`, `<button type="button" class="btn sm" data-podoc="pdf" data-id="${esc(po.id)}">Download PDF</button>`, `<button type="button" class="btn sm" data-podoc="share" data-id="${esc(po.id)}">Share</button>`);
  bizSheet({ label: sup ? sup.name : "Purchase order", sub: `${po.no || ""}${po.expected ? ` · expected ${po.expected}` : ""}`,
    body: `<div>${stat(P.status)}</div><div class="bizlist">${lines}</div>${compare}${acts.length ? `<div class="setactions">${acts.join("")}</div>` : ""}${po.notes ? `<p class="note">${esc(po.notes)}</p>` : ""}`,
    foot: canRecv ? `<button type="button" class="btn sm primary" data-porecv="${esc(po.id)}">Receive</button>` : `<button type="button" class="btn sm" data-biz="close">Done</button>` });
}
/* ---------- receiving ---------- */
export function openReceive(id){
  const po = poById(id); if(!po) return;
  store.bizView = { kind: "porecv", id, counts: receiveStart(po), extra: {}, invoiceNo: "", err: "", over: null };
  renderReceive();
}
export function renderReceive(){
  const F = V(), po = poById(F.id); if(!po) return;
  const P = poProgressOf(po);
  const rows = P.lines.map(l => {
    const r = vRec(l.v), trk = r ? trackingOfP(r.p) : "none", x = F.extra[l.v] || {};
    const more = trk === "serial" ? `<textarea rows="2" data-recvsn="${esc(l.v)}" placeholder="Serial numbers, one per line" aria-label="Serial numbers of ${esc(l.name)}">${esc(x.snText || "")}</textarea>`
      : trk === "batch" ? `<span class="pgrid"><input data-recvbatch="${esc(l.v)}" value="${esc(x.batch && x.batch.no || "")}" placeholder="Batch" aria-label="Batch of ${esc(l.name)}"><input type="date" data-recvexp="${esc(l.v)}" value="${esc(x.batch && x.batch.exp || "")}" aria-label="Expiry of ${esc(l.name)}"></span>` : "";
    return `<div class="poline${l.remaining <= 0 ? " done" : ""}"><span><b>${esc(l.name)}${l.vl ? ` · ${esc(l.vl)}` : ""}</b><span class="recv-nums"><span>Ordered <b>${esc(qtyText(l.ordered, l.u))}</b></span><span>Previously received <b>${esc(qtyText(l.received, l.u))}</b></span><span>Remaining <b>${esc(qtyText(Math.max(0, l.remaining - (+F.counts[l.v] || 0)), l.u))}</b></span></span>${more}</span>
      <label class="recvnow"><small>Receiving now</small><input type="number" inputmode="decimal" min="0" step="any" value="${esc(String(F.counts[l.v] == null ? "" : F.counts[l.v]))}" data-recvq="${esc(l.v)}" aria-label="Receiving now: ${esc(l.name)}"></label></div>`;
  }).join("");
  bizSheet({ label: "Receive", sub: "Each line starts at what is still to come. Change only what differs, or scan to count.",
    body: `<input type="search" class="bizsearch" data-recvscan placeholder="Scan a barcode to count one" aria-label="Scan a barcode"><div class="bizlist">${rows}</div>
      <label class="f full">Supplier's invoice no. (optional)<input data-recvinv value="${esc(F.invoiceNo || "")}" maxlength="40"></label>
      ${F.over ? `<div class="biznote warn">More than ordered: ${F.over.map(o => `${esc(o.name)} ${esc(String(o.q))} (${esc(String(o.remaining))} to come)`).join(", ")}. Did the supplier send extra?</div>` : ""}`,
    foot: `<button type="button" class="btn sm" data-biz="close">Cancel</button><button type="button" class="btn sm primary" data-biz="${F.over ? "porecvover" : "porecvok"}">${F.over ? "Yes, receive extra" : "Confirm"}</button>` });
}
/* ---------- the supplier's bill ---------- */
export function openPOBill(id){
  const po = poById(id); if(!po) return;
  store.bizView = { kind: "pobill", id, bill: billStart(po), err: "" };
  const B = V().bill;
  bizSheet({ label: "Supplier bill", sub: "What the bill says. It never adds stock: the goods came in when received.",
    body: `<div class="pgrid"><label class="f">Bill no.<input data-pbno value="${esc(B.no || "")}" maxlength="40"></label><label class="f">Date<input type="date" data-pbdate value="${esc(B.date || "")}"></label></div>
      <div class="bizlist">${B.lines.map((l, i) => `<div class="poline"><span><b>${esc(l.name)}</b><small>quantity · price · GST %</small></span><span><input type="number" step="any" min="0" data-pbq="${i}" value="${esc(String(l.q))}" aria-label="Billed quantity of ${esc(l.name)}"> <input type="number" step="any" min="0" data-pbp="${i}" value="${esc(String(l.price))}" aria-label="Billed price of ${esc(l.name)}"> <input type="number" step="any" min="0" max="100" data-pbg="${i}" value="${l.gst == null ? "" : esc(String(l.gst))}" aria-label="GST % of ${esc(l.name)}"></span></div>`).join("") || `<p class="muted">Receive the goods first, then add the bill.</p>`}</div>`,
    foot: `<button type="button" class="btn sm" data-poopen="${esc(id)}">Back</button><button type="button" class="btn sm primary" data-biz="pobillsave">Save bill</button>` });
}
/* ---------- events ---------- */
let reorderCache = [];
export function purchaseOrdersClick(t){
  if(t.closest("[data-ponew]")){ openPOEditor(null); return true; }
  const ro = t.closest("[data-poreorder]");
  if(ro){ reorderCache = reorderGroups(); const g = reorderCache[+ro.dataset.poreorder]; if(!g) return true;
    if(!g.supplierId){ openPOEditor(null, newPODraft({ supplierId: "", items: g.items, source: "reorder" })); return true; }
    const r = poFromReorder(g.supplierId, g.items); if(r.error){ toast(r.error); return true; }
    toast(`Draft purchase order ${r.po.no} ready for ${g.supplier}. Check it, then mark it sent.`); renderAll(); openPODetail(r.po.id); return true; }
  const op = t.closest("[data-poopen]"); if(op){ openPODetail(op.dataset.poopen); return true; }
  if(t.closest("[data-poedit]") && V().kind === "podetail"){ openPOEditor(V().id); return true; }
  const rc = t.closest("[data-porecv]"); if(rc){ openReceive(rc.dataset.porecv); return true; }
  const pd = t.closest("[data-podoc]"); if(pd){ const m = purchaseOrderModel(poById(pd.dataset.id)); if(m){ if(pd.dataset.podoc === "print") printDocument(m); else if(pd.dataset.podoc === "pdf") downloadDocumentPdf(m); else shareDocumentPdf(m, `${m.title} ${m.number} from ${m.seller.name}`); } return true; }
  if(t.closest("[data-pobill]") && V().kind === "podetail"){ openPOBill(V().id); return true; }
  const st = t.closest("[data-postatus]");
  if(st && V().kind === "podetail"){ const r = setPOStatus(V().id, st.dataset.postatus); if(r.error){ bizError(r.error); return true; } toast(`Purchase order ${PO_LABELS[st.dataset.postatus].toLowerCase()}.`); renderAll(); openPODetail(V().id); return true; }
  const df = t.closest("[data-podiff]");
  if(df && V().kind === "podetail"){ const [action, key] = df.dataset.podiff.split("|"); const note = action === "note" ? (window.prompt("Note about this difference") || "") : "";
    if(action === "note" && !note) return true;
    const r = reviewDifference(V().id, key, action, note); if(r.error){ bizError(r.error); return true; } renderAll(); openPODetail(V().id); return true; }
  const add = t.closest("[data-poadd]");
  if(add && V().kind === "po"){ const F = V(), same = F.po.items.find(l => l.v === add.dataset.poadd); if(same) same.q = (+same.q || 0) + 1; else { const l = poLine(add.dataset.poadd, 1); if(l) F.po.items.push(l); } F.q = ""; renderPOEditor(); return true; }
  const b = t.closest("[data-biz]"); if(!b) return false;
  const a = b.dataset.biz;
  if(a === "posave" && V().kind === "po"){ const r = savePO({ ...V().po, status: V().po.status || "draft" }); if(r.error){ bizError(r.error); return true; } toast(V().po.no ? "Purchase order saved." : `Purchase order ${r.po.no} created.`); renderAll(); openPODetail(r.po.id); return true; }
  if((a === "porecvok" || a === "porecvover") && V().kind === "porecv"){
    const F = V(), r = receivePO(F.id, F.counts, F.extra, { invoiceNo: F.invoiceNo, allowOver: a === "porecvover" });
    if(r.over){ F.over = r.over; renderReceive(); return true; }
    if(r.error){ bizError(r.error); return true; }
    toast(`Received ${r.purchase.lines.length} item${r.purchase.lines.length === 1 ? "" : "s"} into stock.`); renderAll(); openPODetail(F.id); return true;
  }
  if(a === "pobillsave" && V().kind === "pobill"){ const r = savePOBill(V().id, V().bill); if(r.error){ bizError(r.error); return true; } toast("Supplier bill saved."); renderAll(); openPODetail(V().id); return true; }
  return false;
}
export function purchaseOrdersInput(t){
  const F = V();
  if(F.kind === "po"){
    if(t.matches("[data-poq]")){ F.q = t.value; const h = document.querySelector("[data-pohits]"); if(h) h.innerHTML = editorHits(t.value); return true; }
    if(t.matches("[data-poqty]")){ const l = F.po.items[+t.dataset.poqty]; if(l) l.q = t.value === "" ? 0 : +t.value; return true; }
    if(t.matches("[data-poprice]")){ const l = F.po.items[+t.dataset.poprice]; if(l) l.price = t.value === "" ? null : +t.value; return true; }
    if(t.matches("[data-pogst]")){ const l = F.po.items[+t.dataset.pogst]; if(l){ if(t.value === "") delete l.gst; else l.gst = +t.value; } return true; }
    if(t.matches("[data-poexp]")){ F.po.expected = t.value; return true; }
    if(t.matches("[data-ponotes]")){ F.po.notes = t.value; return true; }
  }
  if(F.kind === "porecv"){
    if(t.matches("[data-recvq]")){ F.counts[t.dataset.recvq] = t.value === "" ? 0 : +t.value; F.over = null; return true; }
    if(t.matches("[data-recvsn]")){ (F.extra[t.dataset.recvsn] = F.extra[t.dataset.recvsn] || {}).snText = t.value; return true; }
    if(t.matches("[data-recvbatch]")){ const x = F.extra[t.dataset.recvbatch] = F.extra[t.dataset.recvbatch] || {}; x.batch = { ...(x.batch || {}), no: t.value }; return true; }
    if(t.matches("[data-recvexp]")){ const x = F.extra[t.dataset.recvexp] = F.extra[t.dataset.recvexp] || {}; x.batch = { ...(x.batch || {}), exp: t.value }; return true; }
    if(t.matches("[data-recvinv]")){ F.invoiceNo = t.value; return true; }
  }
  if(F.kind === "pobill"){
    const B = F.bill;
    if(t.matches("[data-pbno]")){ B.no = t.value; return true; }
    if(t.matches("[data-pbdate]")){ B.date = t.value; return true; }
    if(t.matches("[data-pbq]")){ B.lines[+t.dataset.pbq].q = +t.value || 0; return true; }
    if(t.matches("[data-pbp]")){ B.lines[+t.dataset.pbp].price = +t.value || 0; return true; }
    if(t.matches("[data-pbg]")){ const l = B.lines[+t.dataset.pbg]; if(t.value === "") delete l.gst; else l.gst = +t.value; return true; }
  }
  return false;
}
export function purchaseOrdersChange(t){
  const F = V();
  if(F.kind === "po" && t.matches("[data-posup]")){ F.po.supplierId = t.value; return true; }
  if(F.kind === "porecv" && t.matches("[data-recvscan]")){ const c = t.value; t.value = ""; receiveScan(c); return true; }
  return false;
}
/* Scanning while receiving: the barcode's line counts one more (Enter in the scan box, or a scanner) */
export function receiveScan(code){
  const F = V(); if(F.kind !== "porecv") return false;
  const po = poById(F.id), c = String(code || "").trim(); if(!po || !c) return false;
  const line = po.items.find(l => { const r = vRec(l.v); return r && (r.v.bc === c || r.v.sku === c); });
  if(!line){ toast("That code isn't on this purchase order."); return true; }
  F.counts[line.v] = (+F.counts[line.v] || 0) + 1; F.over = null; renderReceive();
  const s = document.querySelector("[data-recvscan]"); if(s) s.focus();
  return true;
}
