// Purchase orders (domain/inventory/purchase-orders.js): make one in three steps (supplier → products → quantities), turn
// Smart reorder's suggestion into drafts without typing anything again, receive what arrived (an ordinary purchase that
// points at the PO: only receiving changes stock), keep the supplier's bill with it and let Hangtag compare the three.
// A team member needs create_purchase (the database checks it too, and that the capability is on).
import { PO_PREFIX, canMovePO, checkPO, checkPOBill, discrepancies, draftsFromReorder, lastSupplierOf, openDiscrepancies, poProgress, receiveBlock, receiveDefaults,
  receivingInput } from '../../../domain/inventory/purchase-orders.js';
import { vCost, vLabel } from '../../../domain/catalog/variants.js';
import { nextDocNo } from '../../../domain/sales/sale.js';
import { store } from '../../../shared/state/store.js';
import { uid } from '../../../shared/utils/ids.js';
import { denied, userId } from '../../shop/services/access.js';
import { hasCap } from '../../shop/services/shop-caps.js';
import { bizRepository } from '../../commerce/repositories/biz-repository.js';
import { renderSync } from '../../sync/components/sync-status.js';
import { flushSbQueue } from '../../sync/services/outbox.js';
import { vRec } from '../services/ledger.js';
import { purchasesList, supplierById } from '../services/purchase-state.js';
import { inventoryIntelligence } from '../services/inventory-intelligence.js';
import { savePurchase } from './record-purchase.js';

const upload = () => { renderSync(); flushSbQueue(); };
const off = () => hasCap("uses_purchase_orders") ? null : { error: "Purchase orders are switched off for this shop. Switch them on in Settings → Capabilities." };
export const poList = () => bizRepository().list("po").slice().sort((a, b) => b.t - a.t);
export const poById = id => bizRepository().get("po", id);
/* What is ordered, received and still to come on each line, and the shown status */
export const poProgressOf = po => poProgress(po, purchasesList());
export const poReceipts = po => purchasesList().filter(p => p.poId === po.id);
/* A line for a catalog variant, at its last cost price (the agreed price; changeable) */
export function poLine(vid, q){
  const r = vRec(vid); if(!r) return null;
  return { p: r.p.id, v: vid, name: r.p.name, vl: vLabel(r.v), ...(r.p.unit && r.p.unit !== "pcs" ? { u: r.p.unit } : {}), q: +q || 1, price: vCost(r.p, r.v), ...(r.p.gst != null && r.p.gst !== "" ? { gst: +r.p.gst } : {}) };
}
export const newPODraft = ({ supplierId = "", items = [], source = "staff" } = {}) => {
  const t = Date.now();
  return { id: "po" + uid(), no: "", supplierId, status: "draft", expected: "", notes: "", items: items.map((l, k) => ({ ...l, ln: k })), bill: null, review: [], source, version: 0, t, updatedT: t, dev: store.dev };
};
/* Saves a new or changed PO → { po } or { error, field?, line? } (nothing changes) */
export function savePO(draft){
  const no = denied("create_purchase", "make purchase orders") || off(); if(no) return no;
  const prev = draft && draft.id ? poById(draft.id) : null;
  const known = new Set(((prev && prev.items) || []).map(l => l.ln));
  let next = Math.max(-1, ...known) + 1;
  const items = (draft.items || []).filter(l => l && +l.q > 0).map((l, k) => ({ ...l, ln: !prev ? k : known.has(l.ln) ? l.ln : next++ }));
  const po = { ...draft, items, notes: String(draft.notes || "").trim() };
  const bad = checkPO(po); if(bad) return bad;
  const sup = supplierById(po.supplierId); if(!sup) return { error: "Choose the supplier.", field: "supplier" };
  if(prev){
    if(draft.updatedT != null && prev.updatedT != null && +draft.updatedT !== +prev.updatedT) return { error: "This purchase order changed while it was open. Close it and open it again." };
    if(prev.status === "cancelled") return { error: "This purchase order is cancelled." };
    if(!canMovePO(prev.status, po.status)) return { error: `A ${prev.status} purchase order can't become ${po.status}.`, field: "status" };
    if(poReceipts(prev).some(p => p.status !== "cancelled") && JSON.stringify(prev.items) !== JSON.stringify(items))
      return { error: "Goods were already received on this purchase order: its lines stay. Make a new purchase order for anything else.", field: "items" };
  }
  const t = Date.now();
  const saved = { ...po, no: po.no || (prev && prev.no) || nextDocNo(PO_PREFIX, poList(), t, store.dev), t: prev ? prev.t : po.t || t, updatedT: t, version: prev ? prev.version : 0, dev: prev ? prev.dev : store.dev };
  bizRepository().save("po", saved); upload();
  return { po: saved };
}
/* Send / close / cancel / back to draft → { po } or { error } */
export function setPOStatus(id, status){
  const po = poById(id); if(!po) return { error: "That purchase order isn't on this device." };
  return savePO({ ...po, status });
}
/* ---------- Smart reorder → draft purchase orders ---------- */
/* Smart reorder's suggestion grouped by supplier (the one each product was last bought from; unknown ones together)
   → [{ supplierId, supplier, items: [{ p, v, name, vl, u, q, price }], total }] */
export function reorderGroups(){
  const data = inventoryIntelligence(), recs = [];
  data.products.filter(r => r.shouldReorder).forEach(row => row.variants.filter(v => v.shouldReorder && v.suggestedReorderQty > 0).forEach(v => {
    const r = vRec(v.id); if(!r) return;
    recs.push({ v: v.id, p: row.id, name: row.name, vl: vLabel(r.v), u: row.unit, q: v.suggestedReorderQty, cost: vCost(r.p, r.v) });
  }));
  const purchases = purchasesList();
  return draftsFromReorder(recs, vid => lastSupplierOf(vid, purchases)).map(g => ({ ...g, supplier: g.supplierId ? (supplierById(g.supplierId) || {}).name || "" : "",
    total: g.items.reduce((a, l) => a + (l.price == null ? 0 : l.price * l.q), 0) }));
}
/* One supplier's suggestion as a draft PO (the owner reviews it before sending) → { po } or { error } */
export function poFromReorder(supplierId, items){
  if(!supplierId) return { error: "Choose the supplier for these products.", field: "supplier" };
  return savePO(newPODraft({ supplierId, items: items.map(l => ({ ...l, q: +l.q })), source: "reorder" }));
}
/* ---------- receiving ---------- */
export const receiveStart = po => receiveDefaults(po, purchasesList());
/* counts: { [variant]: qty now } · extra: { [variant]: { serials? | snText?, batch? } } · opts: { invoiceNo, invoiceDate, allowOver }
   → { purchase, progress } · { error } · { over: [{ name, q, remaining }] } (more than is still to come: ask, then again with allowOver) */
export function receivePO(id, counts, extra, opts = {}){
  const no = denied("create_purchase", "receive stock") || off(); if(no) return no;
  const po = poById(id), block = receiveBlock(po); if(block) return { error: block };
  const r = receivingInput(po, purchasesList(), counts, extra, opts); if(r.error) return r;
  if(r.over.length && !opts.allowOver) return { over: r.over };
  const p = savePurchase({ ...r.input, ...(r.over.length ? { allowOver: true } : {}) }, { allowDuplicate: true });
  if(p.error) return p;
  upload();
  return { purchase: p.purchase, progress: poProgressOf(po) };
}
/* ---------- the supplier's bill and the comparison ---------- */
/* The bill as on paper (never stock: the goods came in when received) → { po } or { error } */
export function savePOBill(id, bill){
  const no = denied("create_purchase", "record supplier bills") || off(); if(no) return no;
  const po = poById(id); if(!po) return { error: "That purchase order isn't on this device." };
  const b = checkPOBill(bill); if(b.error) return b;
  return savePO({ ...po, bill: b.bill });
}
/* The bill's lines to start from: what was received at the agreed prices (a person corrects what the paper says) */
export function billStart(po){
  const P = poProgressOf(po);
  return { no: po.bill && po.bill.no || (poReceipts(po).find(p => p.invoiceNo) || {}).invoiceNo || "", date: po.bill && po.bill.date || "",
    lines: po.bill ? po.bill.lines : P.lines.filter(l => l.received > 0).map(l => ({ v: l.v, name: l.name + (l.vl ? " · " + l.vl : ""), q: l.received, price: l.price == null ? 0 : l.price, ...(l.gst != null ? { gst: l.gst } : {}) })) };
}
/* PO vs goods received vs supplier bill → [{ key, kind, name, text, accepted }] */
export function poDifferences(po){
  const list = discrepancies(po, purchasesList(), po.bill), open = new Set(openDiscrepancies(list, po.review).map(d => d.key));
  return list.map(d => ({ ...d, accepted: !open.has(d.key), note: ((po.review || []).filter(r => r.key === d.key && r.note).slice(-1)[0] || {}).note || "" }));
}
/* Accept a difference, or note why it is so (the PO, receipts and bill stay as they are; who and when are kept) */
export function reviewDifference(id, key, action, note){
  const no = denied("create_purchase", "review purchase differences") || off(); if(no) return no;
  const po = poById(id); if(!po) return { error: "That purchase order isn't on this device." };
  if(!["accepted", "note"].includes(action)) return { error: "Accept it or add a note." };
  const n = String(note || "").trim().slice(0, 200);
  if(action === "note" && n.length < 2) return { error: "Write a short note." };
  return savePO({ ...po, review: [...(po.review || []), { key, action, ...(n ? { note: n } : {}), t: Date.now(), ...(userId() ? { by: userId() } : {}) }].slice(-400) });
}
