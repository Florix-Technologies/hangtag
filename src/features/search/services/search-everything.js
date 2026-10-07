// Search everything (the app bar's Search, Ctrl+K): what was typed (domain/search/search-query.js) matched against the
// shop's records — bills (number or its last digits, a credit note, a UPI or card reference, an amount, the customer or a
// product on it, and the everyday filters: who, when, which, how paid, how much), customers (name, a phone written any way,
// email, GSTIN), products (name, SKU, barcode, HSN, a serial number or batch), quotations and sales orders, purchase orders
// and supplier bills, suppliers, bank accounts and entries, GST by month — exact matches first. A question goes to the
// Agent. Read-only; what a person can't open isn't listed.
import { store } from '../../../shared/state/store.js';
import { inr } from '../../../shared/formatting/money.js';
import { dayKey, dayLab, fmtDate } from '../../../shared/formatting/dates.js';
import { amountMatches, filterWords, parseSearch } from '../../../domain/search/search-query.js';
import { KIND_LABELS } from '../../../domain/orders/orders.js';
import { paymentsOf } from '../../../domain/sales/payments.js';
import { D } from '../../inventory/services/ledger.js';
import { liveProducts } from '../../products/services/catalog.js';
import { variantsOf, vLabel } from '../../../domain/catalog/variants.js';
import { allBatches, serialState } from '../../inventory/services/tracking.js';
import { purchasesList, supplierById, suppliersList } from '../../inventory/services/purchase-state.js';
import { orderRepository } from '../../orders/repositories/order-repository.js';
import { bizRepository } from '../../commerce/repositories/biz-repository.js';
import { bankAccounts, bankMoves } from '../../finance/use-cases/bank-accounts.js';
import { billContext, billState } from '../../bills/services/bill-status.js';
import { can, canAny } from '../../shop/services/access.js';
import { moduleShown } from '../../shop/services/modules.js';

const norm = v => String(v == null ? "" : v).toLowerCase().trim();
const compact = v => norm(v).replace(/[\s/]+/g, "");
const digitsOf = v => String(v == null ? "" : v).replace(/\D/g, "");
const tailOf = v => { const m = /(\d+)\D*$/.exec(String(v || "")); return m ? +m[1] : null; };
const prefixOf = v => (String(v || "").toLowerCase().match(/^[a-z]+/) || [""])[0];
/* a record's number against what was typed: the whole number ("INV-000003"), or its last digits — alone ("3") or with the
   same prefix ("inv 3"), never another prefix's (a SKU "KUR-01" isn't bill INV-000001) */
const sameNo = (no, q) => !!no && compact(no) === q;
const tailNo = (no, q) => { const n = tailOf(q), L = prefixOf(q); return !!no && n != null && tailOf(no) === n && (!L || prefixOf(no) === L); };
const hasAll = (words, ...vals) => { const hay = vals.map(norm).join(" "); return words.every(w => hay.includes(w)); };
const r = (kind, id, title, sub, attr, icon, extra) => ({ kind, id, title, sub, attr, icon, ...(extra || {}) });

/* ---------- bills ---------- */
function billSearch(P){
  if(!canAny(["view_reports", "create_sale", "perform_return", "collect_credit"])) return { exact: [], list: null };
  const d = D(), exact = [], seen = new Set(), add = (s, why) => { if(!s || seen.has(s.id)) return; seen.add(s.id);
    exact.push(r("bill", s.id, s.no || "Bill", `${why} · ${s.cust && s.cust.name || "Walk-in"} · ${inr(s.total)}${s.void ? " · cancelled" : ""}`, `data-billview="${s.id}"`, "receipt")); };
  if(P.idLike){
    const q = compact(P.q).replace(/^#/, "");
    d.sales.forEach(s => { if(sameNo(s.no, q)) add(s, "Bill"); });
    if(!exact.length) d.sales.slice().reverse().filter(s => tailNo(s.no, q)).slice(0, 3).forEach(s => add(s, "Bill"));
    d.rets.forEach(x => { if(sameNo(x.no, q)){ const s = d.saleById[x.sale]; if(s){ seen.delete(s.id); add(s, `Credit note ${x.no} on ${s.no || "this bill"}`); } } });
  }
  // a UPI / card reference (UTR, approval number) on a bill's payment — a 12-digit UTR looks like a phone number too
  if(P.raw.length >= 6) d.sales.forEach(s => { if(paymentsOf(s).some(p => p.ref && norm(p.ref) === norm(P.raw))) add(s, "Payment reference"); });
  // the list: the everyday filters, or the customer / product named
  const filtered = !!(P.status || P.period || P.method || P.amount || P.billWord);
  if(!filtered && !P.words.length) return { exact, list: null };
  const ctx = P.status ? billContext() : null;
  const list = d.sales.slice().reverse().filter(s => {
    if(P.period && (dayKey(s.t) < P.period.from || dayKey(s.t) > P.period.to)) return false;
    if(P.amount && !amountMatches(P.amount, s.total)) return false;
    if(P.method && !paymentsOf(s).some(p => p.method === P.method)) return false;
    if(P.words.length && !hasAll(P.words, s.no, s.cust && s.cust.name, s.cust && s.cust.phone, ...(s.items || []).flatMap(i => [i.n, i.sku, i.vl]))) return false;
    if(P.status){ const st = billState(s, ctx);
      if(P.status === "unpaid" && st.key !== "unpaid") return false; if(P.status === "paid" && st.key !== "paid") return false; if(P.status === "cancelled" && !s.void) return false;
      if(P.status === "returns" && !st.returned) return false; if(P.status === "credit" && !st.credit) return false;
      if(P.status === "unsent" && !(st.receipt && (st.receipt.state === "failed" || st.receipt.state === "queued"))) return false; }
    else if(s.void) return false;
    return !seen.has(s.id);
  });
  // no bills: say so for a filter ("unpaid today: 0 bills"), but not beside an exact match or for a name
  if(!list.length && (exact.length || !filtered)) return { exact, list: null };
  const live = list.filter(s => !s.void);
  return { exact, list: { rows: list.slice(0, 8).map(s => r("bill", s.id, s.no || "Bill", `${dayLab(dayKey(s.t))} · ${s.cust && s.cust.name || "Walk-in"} · ${inr(s.total)}`, `data-billview="${s.id}"`, "receipt")),
    count: list.length, total: Math.round(live.reduce((a, s) => a + (+s.total || 0), 0) * 100) / 100, words: filterWords(P, inr), filter: P } };
}

/* ---------- people, products, orders, purchases, money ---------- */
function customerSearch(P, exact){
  if(!moduleShown("customers")) return [];
  const all = Object.values(store.customers || {}).filter(Boolean), out = [];
  all.forEach(c => {
    const ph = digitsOf(c.phone).slice(-10);
    if((P.phone && ph === P.phone) || (P.gstin && norm(c.gstin) === norm(P.gstin))) exact.push(r("customer", c.id, c.name, P.gstin ? `GSTIN ${c.gstin}` : c.phone || "Customer", `data-custhist="${c.id}"`, "user"));
    else if(P.words.length && hasAll(P.words, c.name, c.email, c.phone)) out.push(r("customer", c.id, c.name, c.phone || c.email || "Customer", `data-custhist="${c.id}"`, "user"));
    else if(P.digits && P.digits.length >= 4 && !P.phone && digitsOf(c.phone).includes(P.digits)) out.push(r("customer", c.id, c.name, c.phone, `data-custhist="${c.id}"`, "user"));
  });
  return out.slice(0, 6);
}
function productSearch(P, exact){
  if(!canAny(["view_products", "manage_products", "create_sale"])) return [];
  const out = [], q = norm(P.raw);
  liveProducts().forEach(p => {
    const vs = variantsOf(p), hit = vs.find(v => (v.sku && norm(v.sku) === q) || (v.bc && norm(v.bc) === q) || (v.barcode && norm(v.barcode) === q));
    if(hit) exact.push(r("product", p.id, p.name, `${vLabel(hit) ? vLabel(hit) + " · " : ""}${hit.sku && norm(hit.sku) === q ? "SKU" : "barcode"} ${P.raw}`, `data-commandproduct="${p.id}"`, "box"));
    else if(P.words.length && hasAll(P.words, p.name, p.cat, p.brand, ...vs.map(v => v.sku))) out.push(r("product", p.id, p.name, [p.cat, p.hsn && "HSN " + p.hsn].filter(Boolean).join(" · ") || "Product", `data-commandproduct="${p.id}"`, "box"));
    else if(P.digits && P.digits.length >= 4 && P.digits.length <= 8 && String(p.hsn || "") === P.digits) out.push(r("product", p.id, p.name, "HSN " + p.hsn, `data-commandproduct="${p.id}"`, "box"));
  });
  // a serial number or a batch: where that piece is
  if(P.raw.length >= 3 && !/\s/.test(P.raw)){
    const sn = serialState(P.raw);
    if(sn){ const rec = D().vIdx[sn.vid], s = sn.saleId && D().saleById[sn.saleId];
      exact.push(r("serial", sn.sn, `Serial ${sn.sn}`, `${rec ? rec.p.name + (vLabel(rec.v) ? " " + vLabel(rec.v) : "") : "Product"} · ${s ? `sold on ${s.no}` : sn.status === "IN_STOCK" ? "in stock" : sn.status.toLowerCase().replace(/_/g, " ")}`,
        `data-commandtrack="${sn.sn}"`, "box")); }
    else { const b = allBatches().find(x => x && norm(x.b) === q); if(b){ const rec = D().vIdx[b.vid];
      exact.push(r("batch", b.b, `Batch ${b.b}`, `${rec ? rec.p.name : "Product"} · ${b.qty} left${b.exp ? " · expires " + dayLab(b.exp) : ""}`, `data-commandtrack="${b.b}"`, "box")); } }
  }
  return out.slice(0, 6);
}
function orderSearch(P, exact){
  if(!moduleShown("orders")) return [];
  let all = []; try{ all = orderRepository().list().filter(o => o && o.kind !== "table").sort((a, b) => (b.t || 0) - (a.t || 0)); }catch{ all = []; }
  const out = [], q = compact(P.q);
  all.forEach(o => {
    if(P.idLike && (sameNo(o.no, q) || tailNo(o.no, q))) exact.push(r("order", o.id, o.no, `${KIND_LABELS[o.kind] || "Order"} · ${o.cust && o.cust.name || ""}`, `data-ordopen="${o.id}"`, "doc"));
    else if(P.words.length && hasAll(P.words, o.no, o.cust && o.cust.name, o.cust && o.cust.phone, ...(o.items || []).map(l => l.name))) out.push(r("order", o.id, o.no || KIND_LABELS[o.kind] || "Order", [KIND_LABELS[o.kind], o.cust && o.cust.name, o.total ? inr(o.total) : ""].filter(Boolean).join(" · "), `data-ordopen="${o.id}"`, "doc"));
  });
  return out.slice(0, 5);
}
function purchaseSearch(P, exact){
  if(!canAny(["create_purchase", "manage_inventory"])) return { pos: [], bills: [] };
  const q = compact(P.q), pos = [], bills = [];
  bizRepository().list("po").filter(Boolean).forEach(o => { const sup = (supplierById(o.supplierId) || {}).name || "Supplier";
    if(P.idLike && (sameNo(o.no, q) || tailNo(o.no, q))) exact.push(r("po", o.id, o.no, `Purchase order · ${sup}`, `data-navsub="stock:pos"`, "doc"));
    else if(P.words.length && hasAll(P.words, o.no, sup)) pos.push(r("po", o.id, o.no || "Purchase order", `${sup} · ${o.status}`, `data-navsub="stock:pos"`, "doc")); });
  purchasesList().forEach(pu => { const sup = (supplierById(pu.supplierId) || {}).name || "Supplier";
    if(pu.invoiceNo && compact(pu.invoiceNo) === q) exact.push(r("purchase", pu.id, `Supplier bill ${pu.invoiceNo}`, `${sup}${pu.total ? " · " + inr(pu.total) : ""}`, `data-commandsupplier="${pu.supplierId}"`, "doc"));
    else if(P.amount && P.amount.op === "eq" && amountMatches(P.amount, pu.total) && !P.words.length) bills.push(r("purchase", pu.id, `Supplier bill ${pu.invoiceNo || ""}`.trim(), `${sup} · ${inr(pu.total)}`, `data-commandsupplier="${pu.supplierId}"`, "doc")); });
  return { pos: pos.slice(0, 5), bills: bills.slice(0, 5) };
}
function supplierSearch(P, exact){
  if(!canAny(["create_purchase", "manage_inventory"])) return [];
  const out = [];
  suppliersList(true).forEach(x => {
    if((P.phone && digitsOf(x.phone).slice(-10) === P.phone) || (P.gstin && norm(x.gstin) === norm(P.gstin))) exact.push(r("supplier", x.id, x.name, P.gstin ? `Supplier · GSTIN ${x.gstin}` : `Supplier · ${x.phone}`, `data-commandsupplier="${x.id}"`, "user"));
    else if(P.words.length && hasAll(P.words, x.name, x.phone, x.gstin)) out.push(r("supplier", x.id, x.name, x.phone || x.gstin || "Supplier", `data-commandsupplier="${x.id}"`, "user"));
  });
  return out.slice(0, 5);
}
function bankSearch(P){
  if(!can("view_reports")) return [];
  const out = [], book = `data-reportgo="30d|bankBook"`;
  let accts = [], moves = []; try{ accts = bankAccounts(); moves = bankMoves(); }catch{ return []; }
  accts.filter(a => a && P.words.length && hasAll(P.words, a.name, a.bank, a.number)).forEach(a => out.push(r("bank", a.id, a.name || "Bank account", "Bank account", book, "bank")));
  moves.filter(m => m && ((P.words.length && hasAll(P.words, m.reason, m.ref)) || (P.amount && P.amount.op === "eq" && amountMatches(P.amount, m.amount)))).slice(0, 4)
    .forEach(m => out.push(r("bankmove", m.id, `${inr(m.amount)} · ${m.type === "in" ? "money in" : m.type === "out" ? "money out" : m.type}`, `${dayLab(dayKey(m.t))}${m.reason ? " · " + m.reason : ""}`, book, "bank")));
  return out.slice(0, 5);
}
function gstSearch(P){
  if(!P.gst || !can("view_reports") || !(store.settings && store.settings.taxOn)) return [];
  const [y, m] = P.gst.month.split("-").map(Number), name = fmtDate(new Date(y, m - 1, 1), { month: "long", year: "numeric" });
  return [r("gst", P.gst.month, `GST for ${name}`, "Prepare the returns: GSTR-1 and GSTR-3B figures, export", `data-act="gstview" data-gstmonth="${P.gst.month}"`, "doc")];
}

/* text → { parsed, exact: [result], bills: { rows, count, total, words, filter } | null, groups: [{ key, title, results }], ask } */
export function searchEverything(text, { now = Date.now() } = {}){
  const P = parseSearch(text, { now }), exact = [];
  if(!P.q) return { parsed: P, exact, bills: null, groups: [], ask: null };
  const B = billSearch(P); exact.push(...B.exact);
  // a month's name alone ("june") is also someone's or something's name
  const N = P.alsoName && !P.words.length ? { ...P, words: [P.alsoName] } : P;
  const groups = [
    { key: "customers", title: "Customers", results: customerSearch(N, exact) },
    { key: "products", title: "Products", results: productSearch(N, exact) },
    { key: "orders", title: "Quotations and orders", results: orderSearch(N, exact) },
  ];
  const PU = purchaseSearch(N, exact);
  groups.push({ key: "pos", title: "Purchase orders", results: PU.pos }, { key: "purchases", title: "Supplier bills", results: PU.bills },
    { key: "suppliers", title: "Suppliers", results: supplierSearch(N, exact) }, { key: "bank", title: "Bank", results: bankSearch(N) }, { key: "gst", title: "GST", results: gstSearch(P) });
  const ask = P.ask && moduleShown("assistant") ? P.raw : null;
  return { parsed: P, exact, bills: B.list, groups: groups.filter(g => g.results.length), ask };
}
