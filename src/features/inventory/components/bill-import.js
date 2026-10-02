// Upload supplier bill → read → review → confirm → stock added. Phone first: one card per line, big tap targets.
// Nothing reaches stock until "Confirm & Add to Inventory"; the save is one all-or-nothing step in the cloud.
import { store } from '../../../shared/state/store.js';
import { variantsOf } from '../../../domain/catalog/variants.js';
import { addBlankLine, billDocumentLink, confirmSupplierBill, fingerprintBill, invoiceDuplicates, keepBillDocument, planSupplierBill, readSupplierBill, refreshLine } from '../use-cases/import-supplier-bill.js';
import { suppliersList } from '../services/purchase-state.js';
import { IMPORT_UNITS } from '../../../domain/catalog/product-import.js';
import { liveProducts, prod } from '../../products/services/catalog.js';
import { closeModal } from '../../../shared/components/modal.js';
import { toast } from '../../../shared/components/toast.js';
import { ICON } from '../../../shared/constants/icons.js';
import { $, esc } from '../../../shared/dom.js';
import { dtLong } from '../../../shared/formatting/dates.js';
import { isAppError, ERROR_CODES } from '../../../shared/errors/app-error.js';
import { logger } from '../../../shared/logging/logger.js';
import { renderAll } from '../../../shared/ui/render.js';
import { uid } from '../../../shared/utils/ids.js';
import { refuse } from '../../shop/services/access.js';

/* store.billImport = { step: "pick"|"busy"|"dup"|"failed"|"review"|"summary"|"done", file, fileHash, dups, ext, importId,
     doc ({ local, cloud, path }: where the original is kept), supplier, gstin, supplierId (recorded as a purchase from them),
     invoiceNo, invoiceDate, lines, filter, plan, invDups, conflict, err, busy, result } */
const B = () => store.billImport;
const numOr = v => { const t = String(v == null ? "" : v).trim().replace(/[₹,%\s]/g, ""); return t === "" || !Number.isFinite(+t) ? null : +t; };
const fmtDate = t => { try{ return dtLong(t); }catch{ return ""; } };

export function openBillImport(){
  if(refuse("create_purchase","add supplier bills"))return;
  if(!store.authUser || !store.sbClient || store.sbStatus !== "connected"){
    toast(store.sbStatus === "update" ? "The database needs its update (schema.sql) before bills can be read." : "Connect to the internet and sign in to read supplier bills. You can still add stock by hand with Stock in.");
    return;
  }
  store.billImport = { step: "pick", importId: "imp" + uid(), lines: [], filter: "all", supplier: "", gstin: "", invoiceNo: "", invoiceDate: "", err: "" };
  renderBillImport();
}
/* The sheet; when it is already open only its contents change (no fade again, the line list keeps its scroll position) */
function shell(title, sub, body, foot){
  const inner = `<div class="sh-head"><div class="sh-t"><h3 id="biT">${title}</h3><p>${sub}</p></div><button class="iconbtn" data-bi="cancel" aria-label="Close">${ICON.x}</button></div>
    ${body}${foot ? `<div class="sh-foot">${foot}</div>` : ""}`;
  const open = $("#modalHost [data-billimp] .sheet.billimp");
  if(open){
    const list = open.querySelector("#biLines"), top = list ? list.scrollTop : 0;
    open.innerHTML = inner;
    const again = open.querySelector("#biLines"); if(again && top) again.scrollTop = top;
    return;
  }
  $("#modalHost").innerHTML = `<div class="scrim" data-modal-scrim data-billimp><div class="sheet billimp" role="dialog" aria-modal="true" aria-labelledby="biT">${inner}</div></div>`;
}
const dupHTML = (list, what) => `<div class="bi-warn" role="alert"><b>This bill may already have been imported.</b><br>${list.slice(0, 3).map(d =>
  `${esc(what)} added ${esc(fmtDate(d.t))}${d.invoiceNo ? " · " + esc(d.invoiceNo) : ""}${d.supplier ? " · " + esc(d.supplier) : ""}${d.units ? " · " + d.units + " pcs" : ""}`).join("<br>")}</div>`;

export function renderBillImport(){
  const b = B(); if(!b) return;
  if(b.step === "pick") return shell("Add stock from a supplier bill", "Take a photo of the bill, or choose a picture or PDF. You'll check every line before anything is added.",
    `${b.err ? `<p class="autherr">${esc(b.err)}</p>` : ""}<div class="bi-pick">
      <label>${ICON.cam || ""}Take photo<small>Camera</small><input class="sr" type="file" accept="image/*" capture="environment" data-bifile></label>
      <label>Choose image<small>Gallery · JPG, PNG</small><input class="sr" type="file" accept="image/*" data-bifile></label>
      <label>Choose PDF<small>Text or scanned PDF, up to 15 MB</small><input class="sr" type="file" accept="application/pdf,.pdf" data-bifile></label>
    </div><p class="note">No file? <button type="button" class="link" data-bi="manual">Enter the lines by hand</button>.</p>`,
    `<div class="sh-acts"><button class="btn sm" data-bi="cancel">Cancel</button></div>`);
  if(b.step === "busy") return shell("Add stock from a supplier bill", esc(b.file ? b.file.name : ""),
    `<div class="bi-busy" role="status" aria-live="polite"><div class="bi-spin"></div><b>${esc(b.busy || "Reading the bill…")}</b><span class="note">This can take a minute for long bills.</span></div>`, "");
  if(b.step === "dup") return shell("Add stock from a supplier bill", esc(b.file ? b.file.name : ""),
    dupHTML(b.dups, "The same file was") + `<p class="note">Adding it again would count the same stock twice.</p>`,
    `<div class="sh-acts"><button class="btn sm" data-bi="cancel">Cancel</button><button class="btn sm primary" data-bi="continue">Continue anyway</button></div>`);
  // reading failed: the bill is kept; read it again, or enter its lines by hand (the original stays attached)
  if(b.step === "failed") return shell("The bill couldn't be read", esc(b.file ? b.file.name : ""),
    `<p class="autherr" role="alert">${esc(b.err)}</p>${docHTML(b)}`,
    `<div class="sh-acts"><button class="btn sm" data-bi="another">Choose another file</button><button class="btn sm" data-bi="manual">Enter the lines by hand</button><button class="btn sm primary" data-bi="retry">Try reading again</button></div>`);
  if(b.step === "review") return renderReview();
  if(b.step === "summary") return renderSummary();
  if(b.step === "done") return shell("Stock added", "", `<div class="bi-busy">${ICON.ok}<b>Stock added: ${b.result.units} piece${b.result.units === 1 ? "" : "s"}${b.invoiceNo ? " from " + esc(b.invoiceNo) : ""}.</b>
      <span class="note">${b.result.products ? `${b.result.products} new product${b.result.products === 1 ? "" : "s"} · ` : ""}${b.result.variants ? `${b.result.variants} new variant${b.result.variants === 1 ? "" : "s"} · ` : ""}${b.result.purchase ? `Recorded as a purchase from ${esc(b.result.purchase)} (Inventory → Purchases).` : "It shows in Stock history as “Supplier bill”."}</span></div>`,
    `<div class="sh-acts"><button class="btn sm primary" data-bi="close">Done</button></div>`);
}
/* Where the original is kept */
function docHTML(b){
  if(!b.file) return "";
  const d = b.doc || {};
  return `<p class="note bi-doc">Original: <b>${esc(b.file.name || "bill")}</b> · ${d.cloud ? "saved in the cloud ✓" : d.local ? "kept on this device (it goes to the cloud when it can)" : "kept while this screen is open"} <button type="button" class="link xs" data-bi="viewdoc">View</button></p>`;
}

/* ---------- review ---------- */
const included = () => B().lines.filter(l => l.include !== false);
function filtered(){
  const f = B().filter;
  return B().lines.filter(l => f === "all" ? true : f === "review" ? l.include !== false && l.needsReview && !l.confirmed
    : f === "new" ? l.include !== false && (l.action === "new-product" || l.action === "new-variant") : f === "matched" ? l.include !== false && l.action === "existing" : true);
}
function targetText(l){
  const p = prod(l.targetProductId), v = p && p.variants.find(x => x.id === l.targetVariantId);
  if(l.action === "existing") return p && v ? `Existing product found: <b>${esc([p.name, ...(v.o || [])].join(" → "))}</b>` : "Pick the product and variant to add this stock to.";
  if(l.action === "new-variant") return p ? `New variant of <b>${esc(p.name)}</b>: ${esc(l.options.map(o => o.v).join(" / "))}` : "Pick the product.";
  if(l.action === "new-product") return `New product: <b>${esc(l.name || "…")}</b>${l.options.length ? ` · ${esc(l.options.map(o => o.v).join(" / "))}` : ""}${l.match && l.match.kind === "product" ? ` <small>(${esc(l.match.label)} already exists)</small>` : ""}`;
  return esc(l.decisionNote || "Choose what to do with this line.");
}
function pickerHTML(l){
  const p = prod(l.targetProductId), ps = liveProducts().slice().sort((a, c) => a.name.localeCompare(c.name));
  return `<div class="bi-grid"><label class="wide">Product<select data-bipick="${esc(l.id)}"><option value="">Choose a product…</option>${ps.map(x => `<option value="${esc(x.id)}"${p && x.id === p.id ? " selected" : ""}>${esc(x.name)}</option>`).join("")}</select></label>
    ${p && (p.opts || []).length ? `<label class="wide">Variant<select data-bivar="${esc(l.id)}"><option value="">Choose…</option>${variantsOf(p).map(v => `<option value="${esc(v.id)}"${v.id === l.targetVariantId && l.action === "existing" ? " selected" : ""}>${esc((v.o || []).join(" / "))}</option>`).join("")}<option value="__new"${l.action === "new-variant" ? " selected" : ""}>+ New variant from this line's options</option></select></label>` : ""}</div>`;
}
/* A line of a product tracked by serial number (its serials, one per piece) or by batch (its batch and expiry date) */
function trackHTML(l){
  const id = esc(l.id);
  if(l.tracking === "serial") return `<label class="bi-trk">Serial numbers <small>(one per piece: ${esc(l.qty == null ? "?" : l.qty)})</small><textarea data-bif="snText" data-line="${id}" rows="2" placeholder="One per line, or a range like SN001..SN010">${esc(l.snText || "")}</textarea></label>`;
  if(l.tracking === "batch") return `<div class="bi-grid bi-trk"><label>Batch no.<input data-bif="bno" data-line="${id}" value="${esc(l.bno || "")}" maxlength="40" autocomplete="off"></label>
    <label>Expiry${l.expiry ? "" : " <small>(optional)</small>"}<input type="date" data-bif="bexp" data-line="${id}" value="${esc(l.bexp || "")}"></label></div>`;
  return "";
}
function lineHTML(l){
  if(l.include === false) return `<div class="bi-line skip" id="bi-${esc(l.id)}"><div class="bi-top"><span>${esc(l.name || "Line")} · removed</span><button type="button" class="btn xs" data-bi="restore" data-line="${esc(l.id)}">Undo</button></div></div>`;
  const nr = l.needsReview && !l.confirmed, id = esc(l.id);
  const f = (key, lab, val, extra = "") => `<label${key === "name" ? ' class="name"' : ""}>${lab}<input data-bif="${key}" data-line="${id}" value="${esc(val == null ? "" : val)}"${extra}></label>`;
  const conf = l.confidence == null ? "" : `<span class="bi-badge">${Math.round(l.confidence * 100)}% sure</span>`;
  return `<div class="bi-line${nr ? " nr" : l.confirmed ? " ok" : ""}" id="bi-${id}">
    <div class="bi-top"><b>${esc(l.name || "New line")}</b><span>${nr ? `<span class="bi-badge nr">Needs review</span>` : l.confirmed ? `<span class="bi-badge ok">Confirmed</span>` : ""} ${conf}</span></div>
    ${nr && l.reasons.length ? `<p class="bi-reasons">${l.reasons.map(esc).join(" · ")}</p>` : ""}
    <div class="bi-grid">
      ${f("name", "Product", l.name, ' maxlength="120" autocomplete="off"')}
      ${f("qty", l.dp ? "Quantity (" + esc((IMPORT_UNITS.find(u => u[0] === (prod(l.targetProductId) || l).unit) || ["", "kg"])[1]) + ")" : "Quantity", l.qty, ` type="number" inputmode="${l.dp ? "decimal" : "numeric"}" min="0" step="${l.dp ? "any" : "1"}"`)}
      ${l.action === "new-product" ? `<label>Unit<select data-bif="unit" data-line="${id}">${IMPORT_UNITS.map(([c, lab]) => `<option value="${esc(c)}"${(l.unit || "pcs") === c ? " selected" : ""}>${esc(lab)}</option>`).join("")}</select></label>` : ""}
      ${f("unitCost", "Cost ₹ / piece", l.unitCost, ' type="number" inputmode="decimal" min="0"')}
      ${f("sellPrice", "Selling price ₹", l.sellPrice, ' type="number" inputmode="numeric" min="0" placeholder="for new items"')}
      ${f("gst", "GST %", l.gst, ' type="number" inputmode="decimal" min="0" max="100"')}
      ${f("hsn", "HSN", l.hsn, ' inputmode="numeric" maxlength="8"')}
      ${f("sku", "SKU", l.sku, ' maxlength="40" autocomplete="off"')}
      ${f("barcode", "Barcode", l.barcode, ' maxlength="64" autocomplete="off"')}
      ${f("brand", "Brand", l.brand, ' maxlength="60" autocomplete="off"')}
    </div>
    <div class="chips" style="margin-top:8px">${l.options.map((o, i) => `<span class="chip"><input class="biopt" data-biopt="${id}:${i}:n" value="${esc(o.n)}" size="${Math.max(4, o.n.length)}" aria-label="Option name">:<input class="biopt" data-biopt="${id}:${i}:v" value="${esc(o.v)}" size="${Math.max(3, o.v.length)}" aria-label="Option value"><button type="button" data-bi="rmopt" data-line="${id}" data-i="${i}" aria-label="Remove option">×</button></span>`).join("")}
      <button type="button" class="btn xs ghost" data-bi="addopt" data-line="${id}">+ Option (colour, size…)</button></div>
    <div class="bi-match"><span>${targetText(l)}</span>
      ${l.action !== "existing" && l.match && ["sku", "barcode", "variant"].includes(l.match.kind) ? `<button type="button" class="btn xs" data-bi="existing" data-line="${id}">Add stock to existing</button>` : ""}
      ${l.action !== "new-product" ? `<button type="button" class="btn xs" data-bi="newprod" data-line="${id}">Create new product</button>` : ""}
      <button type="button" class="btn xs" data-bi="pick" data-line="${id}">${l.picking ? "Hide" : "Pick another product"}</button></div>
    ${l.picking ? pickerHTML(l) : ""}
    ${trackHTML(l)}
    <div class="bi-acts">${nr ? `<button type="button" class="btn xs primary" data-bi="confirm" data-line="${id}">Confirm line</button>` : ""}<button type="button" class="btn xs" data-bi="remove" data-line="${id}">Remove line</button></div>
  </div>`;
}
function renderReview(){
  const b = B(), inc = included(), nr = inc.filter(l => l.needsReview && !l.confirmed).length;
  const count = f => b.lines.filter(l => l.include !== false && (f === "review" ? l.needsReview && !l.confirmed : f === "new" ? l.action === "new-product" || l.action === "new-variant" : l.action === "existing")).length;
  const chips = [["all", `All ${inc.length}`], ["review", `Needs review ${count("review")}`], ["new", `New ${count("new")}`], ["matched", `Matched ${count("matched")}`]];
  const list = filtered();
  shell("Check the bill", `${inc.length} line${inc.length === 1 ? "" : "s"} read${b.ext && b.ext.provider === "mock" ? " (sample reader)" : ""}. Fix anything that's wrong. Nothing is added until you confirm.`,
    `${b.ext && b.ext.warnings && b.ext.warnings.length ? `<p class="note">${b.ext.warnings.map(esc).join(" · ")}</p>` : ""}
    <div class="bi-head">
      <label class="f"><span class="lab">Supplier</span><input data-bih="supplier" value="${esc(b.supplier)}" maxlength="120"></label>
      <label class="f"><span class="lab">Supplier GSTIN</span><input data-bih="gstin" value="${esc(b.gstin)}" maxlength="15"></label>
      <label class="f"><span class="lab">Invoice no.</span><input data-bih="invoiceNo" value="${esc(b.invoiceNo)}" maxlength="40"></label>
      <label class="f"><span class="lab">Invoice date</span><input type="date" data-bih="invoiceDate" value="${esc(b.invoiceDate)}"></label>
      <label class="f"><span class="lab">Record as a purchase from</span><select data-bisup><option value="">— Not a purchase (stock in only) —</option>${suppliersList().map(s => `<option value="${esc(s.id)}"${s.id === b.supplierId ? " selected" : ""}>${esc(s.name)}</option>`).join("")}</select></label>
    </div>
    ${docHTML(b)}
    <div class="bi-filter" role="group" aria-label="Show">${chips.map(([k, l]) => `<button type="button" class="btn xs" data-bifilter="${k}" aria-pressed="${b.filter === k}">${l}</button>`).join("")}
      ${nr ? `<button type="button" class="btn xs" data-bi="confirmall">Confirm all ${nr}</button>` : ""}</div>
    <div class="bi-lines" id="biLines">${list.length ? list.map(lineHTML).join("") : `<p class="note">No lines here.</p>`}</div>
    <p><button type="button" class="btn xs ghost" data-bi="addline">+ Add a line</button></p>`,
    `<span class="note">${Math.round(inc.reduce((a, l) => a + (Number.isFinite(l.qty) && l.qty > 0 ? l.qty : 0), 0) * 1000) / 1000} units on ${inc.length} line${inc.length === 1 ? "" : "s"}</span>
    <div class="sh-acts"><button class="btn sm" data-bi="cancel">Cancel</button><button class="btn sm primary" data-bi="tosummary"${inc.length ? "" : " disabled"}>Review summary</button></div>`);
}
function rerenderLine(l){
  const el = document.getElementById("bi-" + l.id);
  const a = document.activeElement, key = a && a.dataset ? (a.dataset.bif ? "f:" + a.dataset.bif : a.dataset.biopt ? "o:" + a.dataset.biopt : "") : "";
  if(el) el.outerHTML = lineHTML(l); else renderReview();
  if(key){ const x = [...document.querySelectorAll(`#bi-${CSS.escape(l.id)} input`)].find(i => (i.dataset.bif ? "f:" + i.dataset.bif : i.dataset.biopt ? "o:" + i.dataset.biopt : "") === key); if(x) x.focus(); }
}

/* ---------- summary ---------- */
function renderSummary(){
  const b = B(), plan = b.plan, s = plan.summary, names = new Map(b.lines.map(l => [l.id, l.name || "a line"]));
  const box = (n, lab) => `<div><b>${n}</b>${lab}</div>`;
  shell("Summary", `${esc(b.supplier || "Supplier bill")}${b.invoiceNo ? " · " + esc(b.invoiceNo) : ""}`,
    `${plan.errors.length ? `<div class="bi-warn" role="alert"><b>Fix these first:</b><ul class="bi-errs">${plan.errors.map(e => `<li>${esc(names.get(e.lineId))}: ${esc(e.message)}</li>`).join("")}</ul></div>` : ""}
    <div class="bi-sum">${box(s.productsToCreate, "Products to create")}${box(s.variantsToCreate, "Variants to create")}${box(s.existingMatched, "Existing products matched")}${box(s.units, "Stock to add (units)")}</div>
    ${b.invDups && b.invDups.length ? dupHTML(b.invDups, "This invoice was") : ""}
    ${b.conflict ? dupHTML(b.conflict, "It was") + `<p class="note">Add it anyway only if this really is a new delivery.</p>` : ""}
    ${b.err ? `<p class="autherr" role="alert">${esc(b.err)}</p>` : ""}`,
    `<div class="sh-acts"><button class="btn sm" data-bi="back">Back to lines</button><button class="btn sm" data-bi="cancel">Cancel</button>
      ${plan.errors.length ? "" : b.conflict ? `<button class="btn sm primary" data-bi="commitdup">Add anyway</button>` : `<button class="btn sm primary" data-bi="commit">Confirm &amp; Add to Inventory</button>`}</div>`);
}

/* ---------- steps ---------- */
async function chooseFile(file){
  const b = B(); if(!b || !file) return;
  b.file = file; b.err = ""; b.step = "busy"; b.busy = "Checking the bill…"; renderBillImport();
  try{
    // Keep the original before hashing or extraction: either may fail and the selected bill must still be recoverable.
    b.busy = "Keeping the bill…"; renderBillImport();
    b.doc = await keepBillDocument(b.importId, file);
    if(B() !== b) return;
    b.busy = "Checking the bill…"; renderBillImport();
    const f = await fingerprintBill(file);
    if(B() !== b) return;
    b.fileHash = f.fileHash; b.dups = f.dups;
    if(f.dups.length){ b.step = "dup"; renderBillImport(); return; }
    await extract();
  }catch(e){ logger.warn("Bill check failed:", e); b.step = "pick"; b.err = "Couldn't read that file. Try another photo or PDF."; renderBillImport(); }
}
async function extract(){
  const b = B(); b.step = "busy"; b.busy = "Reading the bill…"; renderBillImport();
  try{
    const r = await readSupplierBill(b.file, b.fileHash);
    if(B() !== b) return;
    b.ext = r.ext; b.lines = r.lines;
    b.supplier = (r.ext.supplier && r.ext.supplier.name) || ""; b.gstin = (r.ext.supplier && r.ext.supplier.gstin) || "";
    b.invoiceNo = (r.ext.invoice && r.ext.invoice.number) || ""; b.invoiceDate = (r.ext.invoice && r.ext.invoice.date) || "";
    // a supplier the shop already has (by GSTIN, else by name): the bill is recorded as a purchase from them (it can be changed)
    const g = String(b.gstin || "").trim().toUpperCase(), nm = String(b.supplier || "").trim().toLowerCase();
    const known = suppliersList().find(s => (g && s.gstin && s.gstin.toUpperCase() === g) || (nm && s.name.toLowerCase() === nm));
    if(known && !b.supplierId) b.supplierId = known.id;
    if(!b.lines.length){ b.lines = [addBlankLine()]; toast("No product lines were found. Add them by hand."); }
    b.step = "review"; b.filter = b.lines.some(l => l.needsReview) ? "review" : "all"; renderBillImport();
  }catch(e){
    logger.warn("Bill reading failed:", e);
    if(B() !== b) return;
    // the bill stays: read it again, enter its lines by hand (it stays attached), or choose another file
    b.step = "failed";
    b.err = isAppError(e) && e.code === ERROR_CODES.NOT_CONFIGURED ? "Reading bills isn't set up yet (the extract-bill function needs its API key). Enter the lines by hand: the bill stays attached."
      : (isAppError(e) ? e.message : "The bill couldn't be read.") + " Try reading it again, or enter the lines by hand: the bill stays attached.";
    renderBillImport();
  }
}
async function toSummary(){
  const b = B();
  b.plan = planSupplierBill(b); b.err = ""; b.conflict = null; b.step = "summary"; renderBillImport();
  const inv = await invoiceDuplicates(b.invoiceNo);
  if(B() === b && b.step === "summary"){ b.invDups = inv.filter(d => d.fileHash !== b.fileHash || !b.fileHash); if(b.invDups.length) renderBillImport(); }
}
async function commit(allowDuplicate){
  const b = B(); if(b.saving) return;
  b.saving = true; b.err = ""; b.step = "busy"; b.busy = "Adding stock…"; renderBillImport();
  try{
    const res = await confirmSupplierBill(b, b.plan, { allowDuplicate });
    const sup = b.supplierId && suppliersList(true).find(s => s.id === b.supplierId);
    b.result = { units: b.plan.summary.units, products: b.plan.summary.productsToCreate, variants: b.plan.summary.variantsToCreate, status: res && res.status, purchase: sup ? sup.name : "" };
    b.step = "done"; renderAll(); renderBillImport();
    toast(`Stock added: ${b.plan.summary.units} piece${b.plan.summary.units === 1 ? "" : "s"}${b.invoiceNo ? " from " + b.invoiceNo : ""}.`);
  }catch(e){
    logger.warn("Import failed:", e);
    b.step = "summary";
    if(isAppError(e) && e.code === ERROR_CODES.CONFLICT && e.details && e.details.previous){
      const p = e.details.previous;
      b.conflict = [{ t: Date.parse(p.created_at) || 0, invoiceNo: p.invoice_no || "", supplier: p.supplier_name || "" }];
    } else b.err = (isAppError(e) ? e.message : "The stock couldn't be added.") + " Nothing was changed.";
    renderBillImport();
  }finally{ b.saving = false; }
}

/* ---------- events (wired in app/events) ---------- */
const lineOf = id => B().lines.find(l => l.id === id);
export function billImportClick(t){
  const b = B(); if(!b) return false;
  const fb = t.closest("[data-bifilter]"); if(fb){ b.filter = fb.dataset.bifilter; renderReview(); return true; }
  const el = t.closest("[data-bi]"); if(!el) return false;
  const act = el.dataset.bi, l = el.dataset.line ? lineOf(el.dataset.line) : null;
  switch(act){
    case "cancel": if(b.step === "review" && b.lines.length > 1 && !confirm("Close without adding this bill? Your review will be lost.")) return true; store.billImport = null; closeModal(); break;
    case "close": store.billImport = null; closeModal(); break;
    case "continue": extract(); break;
    case "retry": extract(); break;
    case "another": b.step = "pick"; b.err = ""; b.file = null; b.doc = null; b.fileHash = ""; b.importId = "imp" + uid(); renderBillImport(); break;
    case "viewdoc": billDocumentLink(b.importId, b.doc && b.doc.cloud ? b.doc.path : "").then(r => {
        const url = r.url || (b.file ? URL.createObjectURL(b.file) : ""); if(url) window.open(url, "_blank", "noopener"); else toast(r.error || "The original isn't available."); }); break;
    // by hand: the chosen file (if any) stays attached to the bill
    case "manual": b.lines = [addBlankLine()]; b.ext = null; b.step = "review"; renderBillImport(); break;
    case "addline": { const n = addBlankLine(); b.lines.push(n); b.filter = "all"; renderReview(); const x = document.querySelector(`#bi-${CSS.escape(n.id)} input`); if(x) x.focus(); break; }
    case "confirmall": b.lines.forEach(x => { if(x.include !== false) x.confirmed = true; }); renderReview(); break;
    case "tosummary": toSummary(); break;
    case "back": b.step = "review"; renderReview(); break;
    case "commit": commit(false); break;
    case "commitdup": commit(true); break;
    case "confirm": if(l){ l.confirmed = true; rerenderLine(l); } break;
    case "remove": if(l){ l.include = false; rerenderLine(l); } break;
    case "restore": if(l){ l.include = true; rerenderLine(l); } break;
    case "existing": if(l){ l.decided = true; l.action = "existing"; l.targetProductId = l.match.productId; l.targetVariantId = l.match.variantId; refreshLine(l); rerenderLine(l); } break;
    case "newprod": if(l){ l.decided = true; l.action = "new-product"; l.targetProductId = ""; l.targetVariantId = ""; refreshLine(l); rerenderLine(l); } break;
    case "pick": if(l){ l.picking = !l.picking; rerenderLine(l); } break;
    case "addopt": if(l){ l.options.push({ n: "", v: "" }); rerenderLine(l); const ins = document.querySelectorAll(`#bi-${CSS.escape(l.id)} [data-biopt]`); if(ins.length) ins[ins.length - 2].focus(); } break;
    case "rmopt": if(l){ l.options.splice(+el.dataset.i, 1); refreshLine(l); rerenderLine(l); } break;
    default: return false;
  }
  return true;
}
/* typing: state only (the card is redrawn when the field is left) */
export function billImportInput(t){
  const b = B(); if(!b) return false;
  if(t.dataset.bih){ b[t.dataset.bih] = t.value; return true; }
  if(t.dataset.bif){ const l = lineOf(t.dataset.line); if(!l) return true;
    const k = t.dataset.bif; l[k] = ["qty", "unitCost", "sellPrice", "gst"].includes(k) ? numOr(t.value) : t.value; if(k === "sellPrice" && l.sellPrice != null) l.sellPrice = Math.round(l.sellPrice); return true; }
  if(t.dataset.biopt){ const [id, i, part] = t.dataset.biopt.split(":"), l = lineOf(id); if(l && l.options[+i]) l.options[+i][part] = t.value.trim(); return true; }
  return false;
}
export async function billImportChange(t){
  const b = B(); if(!b) return false;
  if(t.matches("[data-bifile]")){ const f = t.files && t.files[0]; t.value = ""; if(f) await chooseFile(f); return true; }
  if(t.dataset.bif || t.dataset.biopt){
    const l = lineOf(t.dataset.line || t.dataset.biopt.split(":")[0]); if(!l) return true;
    l.options = l.options.filter(o => o.n || o.v || document.activeElement === t);
    refreshLine(l); rerenderLine(l); return true;
  }
  if(t.dataset.bipick){
    const l = lineOf(t.dataset.bipick), p = prod(t.value); if(!l) return true;
    l.decided = true; l.targetProductId = p ? p.id : "";
    if(p && !(p.opts || []).length){ l.action = "existing"; l.targetVariantId = (variantsOf(p)[0] || {}).id || ""; }
    else { l.action = p ? "" : l.action; l.targetVariantId = ""; }
    refreshLine(l); rerenderLine(l); return true;
  }
  if(t.dataset.bivar){
    const l = lineOf(t.dataset.bivar); if(!l) return true;
    l.decided = true;
    if(t.value === "__new"){ l.action = "new-variant"; l.targetVariantId = ""; } else { l.action = t.value ? "existing" : ""; l.targetVariantId = t.value; }
    refreshLine(l); rerenderLine(l); return true;
  }
  // the bill recorded as a purchase from this supplier (or not)
  if(t.matches("[data-bisup]")){ b.supplierId = t.value; return true; }
  return false;
}
