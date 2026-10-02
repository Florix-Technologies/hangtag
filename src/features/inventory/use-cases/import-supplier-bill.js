// ImportSupplierBill: fingerprint and read a supplier bill, keep the review lines matched to the catalog, plan what the
// confirmed bill adds, and save it in one step. The review screen (components/bill-import.js) calls these.
//   · The original photo or PDF is kept from the moment it is chosen: on this device (blobStore) and in the shop's private
//     cloud folder (bucket hangtag-bills); a reading that fails, a retry or entering the lines by hand never loses it, and the
//     saved bill points at it (hangtag_stock_imports.document_path). One that couldn't reach the cloud yet goes up later.
//   · Lines of products tracked by serial number carry their serials (one per piece); by batch, their batch and expiry date.
//   · With a supplier chosen, the bill is recorded as a purchase from them (Inventory → Purchases; what is owed on it).
//   · Nothing reaches stock before the merchant confirms the reviewed lines.
import { store } from '../../../shared/state/store.js';
import { use } from '../../../shared/di/services.js';
import { blankReviewLine, newReviewLines, planImport, prepareLines, reviewReasons } from '../../../domain/inventory/bill-import.js';
import { lineMoney, lineTrackingError } from '../../../domain/inventory/purchase.js';
import { normBatch, parseSerials } from '../../../domain/inventory/tracking.js';
import { toRupees } from '../../../domain/sales/paise.js';
import { decimalsOf, isWeighed } from '../../../domain/catalog/units.js';
import { prod, products } from '../../products/services/catalog.js';
import { batchOf, expiryKept, serialState, today, trackingOfP } from '../services/tracking.js';
import { supplierById } from '../services/purchase-state.js';
import { pullFromSupabase, pullPurchases } from '../../sync/services/pull.js';
import { logger } from '../../../shared/logging/logger.js';
import { uid } from '../../../shared/utils/ids.js';
import { AppError, ERROR_CODES } from '../../../shared/errors/app-error.js';
import { can, isMember, notAllowedText } from '../../shop/services/access.js';
import { savePendingDocs } from '../../../shared/state/persistence.js';
import { hasCap } from '../../shop/services/shop-caps.js';

/* ---------- the original document ---------- */
const EXT = { "application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/heic": "heic" };
/* The shop's folder in the cloud (the owner's account; a team member's shop) */
const shopFolder = () => isMember() ? store.access && store.access.shopId : store.authUser && store.authUser.id;
export const documentPath = (importId, file) => { const f = shopFolder(); const ext = EXT[file && file.type] || String(file && file.name || "").split(".").pop().toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 5) || "bin"; return f ? `${f}/${importId}.${ext}` : ""; };
/* Keeps the chosen file: on this device at once, then in the cloud. → { local, cloud, path } (never throws) */
export async function keepBillDocument(importId, file){
  const out = { local: false, cloud: false, path: documentPath(importId, file) };
  try{ await use("blobStore").put(importId, { blob: file, name: file.name, type: file.type }); out.local = true; }catch(e){ logger.warn("Bill kept in memory only:", e); }
  if(out.path){
    try{ await use("cloud").uploadBillDocument(out.path, file, file.type); out.cloud = true; }
    catch(e){ logger.warn("Bill not in the cloud yet:", e); }
  }
  // one the cloud doesn't have yet goes up later (pendingDocs: retried whenever the app connects)
  const P = store.pendingDocs || (store.pendingDocs = {});
  if(out.cloud){ delete P[importId]; if(out.local) use("blobStore").remove(importId).catch(() => {}); }
  else if(out.local) P[importId] = { path: out.path, name: file.name || "", type: file.type || "", t: Date.now(), saved: false };
  savePendingDocs();
  return out;
}
/* The merchant closed a bill without saving it (or chose another file): its original isn't kept waiting on this device
   (one that already reached the shop's private folder stays there, unused) */
export function discardBillDocument(importId){
  const P = store.pendingDocs || {};
  if(!importId || !P[importId] || P[importId].saved) return false;
  delete P[importId]; savePendingDocs(); use("blobStore").remove(importId).catch(() => {});
  return true;
}
/* The bill was saved: a document still waiting for the cloud will be attached to it when it arrives */
function markSaved(importId){ const P = store.pendingDocs || {}; if(P[importId]){ P[importId].saved = true; savePendingDocs(); } }
/* Documents that couldn't reach the cloud yet: sent now (and pointed at by their saved bill). → how many went up */
export async function sendPendingDocs(){
  const P = store.pendingDocs || {}; let n = 0;
  for(const [id, d] of Object.entries(P)){
    try{
      const f = await use("blobStore").get(id); if(!f){ delete P[id]; continue; }
      const path = d.path || documentPath(id, f.blob); if(!path) continue;
      await use("cloud").uploadBillDocument(path, f.blob, f.type);
      if(d.saved) await use("cloud").setImportDocument(id, path);
      delete P[id]; await use("blobStore").remove(id).catch(() => {}); n++;
    }catch(e){ logger.warn("Bill document still waiting:", e); }
  }
  savePendingDocs();
  return n;
}
/* A link to look at a saved bill's original (a private link valid for an hour) → { url } or { error }; on this device first */
export async function billDocumentLink(importId, path){
  try{ const f = await use("blobStore").get(importId); if(f && f.blob) return { url: URL.createObjectURL(f.blob), local: true }; }catch{ /* not on this device */ }
  if(!path) return { error: "The original of this bill wasn't kept." };
  try{ const url = await use("cloud").billDocumentUrl(path); return url ? { url } : { error: "The original couldn't be opened." }; }
  catch(e){ return { error: "The original couldn't be opened: " + (e && e.message || "no connection") + "." }; }
}

/* ---------- reading and reviewing ---------- */
/* The file's fingerprint and any earlier import of the same file ({ fileHash, dups }) */
export async function fingerprintBill(file){
  const fileHash = await use("files").sha256Hex(file);
  let dups = [];
  try{ dups = await use("inventoryImportService").findDuplicates({ fileHash }); }catch(e){ logger.warn("Duplicate check failed:", e); }
  return { fileHash, dups };
}
/* Earlier imports with this invoice number (checked again before confirming, after the merchant may have corrected it) */
export async function invoiceDuplicates(invoiceNo){
  if(!String(invoiceNo || "").trim()) return [];
  try{ return await use("inventoryImportService").findDuplicates({ invoiceNo }); }catch(e){ logger.warn("Duplicate check failed:", e); return []; }
}
/* The decimals a line's quantity may have: its product's unit (an existing product), else the unit chosen on the line;
   how its product is tracked (serial number, batch with or without expiry dates) */
function withUnit(l){
  const p = l.targetProductId && prod(l.targetProductId);
  l.dp = decimalsOf(p ? p.unit : l.unit);
  l.tracking = p ? trackingOfP(p) : "none";
  l.expiry = !!(p && expiryKept(p));
  l.reasons = reviewReasons(l); l.needsReview = l.reasons.length > 0;
  return l;
}
/* Reads the bill → { ext, lines }: lines matched to the catalog with suggested actions. Nothing is added to stock. */
export async function readSupplierBill(file, fileHash){
  const ext = await use("documentExtractionService").extract(file, { fileHash });
  return { ext, lines: prepareLines(newReviewLines(ext, { uid }), products()).map(withUnit) };
}
export const addBlankLine = () => withUnit(prepareLines([blankReviewLine({ uid })], products())[0]);
/* After the merchant edits a line: reasons and the catalog match are worked out again */
export function refreshLine(l){
  prepareLines([l], products());
  return withUnit(l);
}
const noteFor = b => ["Supplier bill", b.invoiceNo, b.supplier].filter(Boolean).join(" · ").replace("Supplier bill · ", "Supplier bill ");
/* What the reviewed bill would add: { newProducts, updatedProducts, newVariants, moves, lines, summary, errors }. Lines of
   products tracked by serial number or batch are checked here (serials one per piece and not in stock already; batch and,
   where kept, expiry date) and carry them into their stock-in records. */
export function planSupplierBill(b){
  const seen = new Set(), errs = [], ctx = { serialState, batchOf, today: today() };
  const lines = b.lines.map(l0 => {
    const l = withUnit(l0);
    if(l.include === false || l.action === "skip" || l.tracking === "none" || !l.targetProductId) return l;
    const x = { ...l };
    if(l.tracking === "serial"){
      const ps = parseSerials(l.snText || "");
      if(ps.error){ errs.push({ lineId: l.id, message: ps.error }); return l; }
      x.sn = ps.serials;
    } else x.batch = { no: l.bno || "", exp: l.bexp || "" };
    const e = lineTrackingError({ v: l.targetVariantId, q: l.qty, serials: x.sn, batch: x.batch }, 0, { tracking: l.tracking, expiry: l.expiry }, seen, ctx);
    if(e){ errs.push({ lineId: l.id, message: e.replace(/^Line 0: /, "") }); return l; }
    if(x.batch){ const known = batchOf(l.targetVariantId, x.batch.no); x.batch = { no: normBatch(x.batch.no), exp: x.batch.exp || (known && known.exp) || "" }; }
    return x;
  });
  const plan = planImport(lines, products(), { uid, now: Date.now(), deviceId: store.dev, importId: b.importId, note: noteFor(b), colorIndex: products().length });
  lines.filter(l=>l.include!==false&&l.action!=="skip").forEach(l=>{
    if((l.action==="new-variant"||(l.action==="new-product"&&(l.options||[]).length))&&!hasCap("uses_variants")) plan.errors.push({lineId:l.id,message:"Product variants are switched off for this shop."});
    if(l.action==="new-product"&&isWeighed(l.unit)&&!hasCap("uses_weight")) plan.errors.push({lineId:l.id,message:"Weight-based products are switched off for this shop."});
  });
  if(errs.length){ plan.errors.push(...errs); plan.moves = []; plan.lines = []; }
  if(plan.errors.length){ plan.moves=[]; plan.lines=[]; }
  return plan;
}
/* The bill as a purchase from a supplier (its lines at cost with GST, nothing paid yet): the fields of the import record */
export function purchaseFields(b, plan){
  const sup = b.supplierId && supplierById(b.supplierId);
  if(!sup) return null;
  let tx = 0, tax = 0;
  const lines = (plan.lines || []).map(l => { const m = lineMoney({ q: l.q, cost: l.cost, gst: l.gst }); tx += m.tx; tax += m.tax;
    return { p: l.p, v: l.v, n: l.n, vl: l.vl, sku: l.sku, q: l.q, cost: l.cost, gst: l.gst, tx: toRupees(m.tx), tax: toRupees(m.tax), total: toRupees(m.total) }; });
  return { kind: "purchase", supplierId: sup.id, supplier: sup.name, gstin: sup.gstin || b.gstin || "", lines, sub: toRupees(tx), tax: toRupees(tax), total: toRupees(tx + tax) };
}
/* Saves the bill in one step. Throws an AppError (CONFLICT with details.kind for a likely repeat, unless allowDuplicate;
   PERMISSION when a team member's role can't add supplier bills, or can't add the new products the bill needs). */
export async function confirmSupplierBill(b, plan, { allowDuplicate = false } = {}){
  if(!can("create_purchase")) throw new AppError(ERROR_CODES.PERMISSION, notAllowedText("add supplier bills"));
  const makes = plan && ((plan.newProducts || []).length || (plan.updatedProducts || []).length || (plan.newVariants || []).length);
  if(makes && !can("manage_products")) throw new AppError(ERROR_CODES.PERMISSION, notAllowedText("add products") + " Match every line to a product the shop has.");
  const used = b.lines.filter(l => l.include !== false && l.action !== "skip");
  const totals = used.map(l => l.total).filter(x => x != null);
  // the original: in the cloud already, or (still waiting) attached as soon as it gets there
  if(b.file && !b.doc) b.doc = await keepBillDocument(b.importId, b.file);
  if(b.file && b.doc && !b.doc.cloud && b.doc.path){ try{ await use("cloud").uploadBillDocument(b.doc.path, b.file, b.file.type); b.doc.cloud = true; }catch{ /* goes up later */ } }
  const pf = purchaseFields(b, plan);
  const meta = { id: b.importId, fileHash: b.fileHash, fileName: b.file && b.file.name, fileType: b.file && b.file.type,
    supplier: pf ? pf.supplier : b.supplier, gstin: pf ? pf.gstin : b.gstin, invoiceNo: b.invoiceNo, invoiceDate: b.invoiceDate,
    amount: pf ? pf.total : totals.length ? Math.round(totals.reduce((a, x) => a + x, 0) * 100) / 100 : null,
    lines: pf ? pf.lines : used.map(l => ({ name: l.name, brand: l.brand || null, options: l.options, qty: l.qty, cost: l.unitCost, price: l.sellPrice, sku: l.sku || null, barcode: l.barcode || null,
      hsn: l.hsn || null, gst: l.gst, action: l.action, product: l.targetProductId || null, variant: l.targetVariantId || null, confidence: l.confidence })),
    extraction: b.ext ? { provider: b.ext.provider || null, model: b.ext.model || null, warnings: b.ext.warnings || [] } : { provider: "manual" },
    documentPath: b.doc && b.doc.cloud ? b.doc.path : null, purchase: pf, allowDuplicate };
  const res = await use("inventoryImportService").commit(plan, meta);
  if(b.doc && !b.doc.cloud) markSaved(b.importId);
  else if(b.doc && b.doc.cloud){ const P = store.pendingDocs || {}; if(P[b.importId]){ delete P[b.importId]; savePendingDocs(); } use("blobStore").remove(b.importId).catch(() => {}); }
  if(res && res.status === "already_imported") await pullFromSupabase(false);
  else if(pf) await pullPurchases().catch(e => logger.warn("Purchases not downloaded:", e));
  return res;
}
