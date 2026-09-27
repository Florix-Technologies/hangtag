// ImportSupplierBill: fingerprint and read a supplier bill, keep the review lines matched to the catalog, plan what the
// confirmed bill adds, and save it in one step. The review screen (components/bill-import.js) calls these.
import { store } from '../../../shared/state/store.js';
import { use } from '../../../shared/di/services.js';
import { blankReviewLine, newReviewLines, planImport, prepareLines, reviewReasons } from '../../../domain/inventory/bill-import.js';
import { products } from '../../products/services/catalog.js';
import { pullFromSupabase } from '../../sync/services/pull.js';
import { logger } from '../../../shared/logging/logger.js';
import { uid } from '../../../shared/utils/ids.js';

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
/* Reads the bill → { ext, lines }: lines matched to the catalog with suggested actions. Nothing is added to stock. */
export async function readSupplierBill(file, fileHash){
  const ext = await use("documentExtractionService").extract(file, { fileHash });
  return { ext, lines: prepareLines(newReviewLines(ext, { uid }), products()) };
}
export const addBlankLine = () => prepareLines([blankReviewLine({ uid })], products())[0];
/* After the merchant edits a line: reasons and the catalog match are worked out again */
export function refreshLine(l){
  l.reasons = reviewReasons(l); l.needsReview = l.reasons.length > 0;
  prepareLines([l], products());
  return l;
}
const noteFor = b => ["Supplier bill", b.invoiceNo, b.supplier].filter(Boolean).join(" · ").replace("Supplier bill · ", "Supplier bill ");
/* What the reviewed bill would add: { newProducts, updatedProducts, newVariants, moves, summary, errors } */
export function planSupplierBill(b){
  return planImport(b.lines, products(), { uid, now: Date.now(), deviceId: store.dev, importId: b.importId, note: noteFor(b), colorIndex: products().length });
}
/* Saves the bill in one step. Throws an AppError (CONFLICT with details.kind for a likely repeat, unless allowDuplicate). */
export async function confirmSupplierBill(b, plan, { allowDuplicate = false } = {}){
  const used = b.lines.filter(l => l.include !== false && l.action !== "skip");
  const totals = used.map(l => l.total).filter(x => x != null);
  const meta = { id: b.importId, fileHash: b.fileHash, fileName: b.file && b.file.name, fileType: b.file && b.file.type,
    supplier: b.supplier, gstin: b.gstin, invoiceNo: b.invoiceNo, invoiceDate: b.invoiceDate,
    amount: totals.length ? Math.round(totals.reduce((a, x) => a + x, 0) * 100) / 100 : null,
    lines: used.map(l => ({ name: l.name, brand: l.brand || null, options: l.options, qty: l.qty, cost: l.unitCost, price: l.sellPrice, sku: l.sku || null, barcode: l.barcode || null,
      hsn: l.hsn || null, gst: l.gst, action: l.action, product: l.targetProductId || null, variant: l.targetVariantId || null, confidence: l.confidence })),
    extraction: b.ext ? { provider: b.ext.provider || null, model: b.ext.model || null, warnings: b.ext.warnings || [] } : { provider: "manual" },
    allowDuplicate };
  const res = await use("inventoryImportService").commit(plan, meta);
  if(res && res.status === "already_imported") await pullFromSupabase(false);
  return res;
}
