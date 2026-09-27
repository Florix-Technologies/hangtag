// Supplier bill import: review lines from an extraction, matching against the catalog, and the plan of what a confirmed
// bill adds (new products, new variants, stock-in moves). Pure: no browser, no app state, no network.
import { tupleKey } from '../catalog/options.js';
import { COLORS } from '../../shared/utils/colors.js';

export const REVIEW_CONFIDENCE = 0.8;
const low = s => String(s == null ? "" : s).toLowerCase();
/* names compared without case, punctuation or extra spaces ("T-Shirt  (Black)" ~ "t shirt black") */
export const normName = s => low(s).replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const clean = (s, max) => { const t = String(s == null ? "" : s).replace(/\s+/g, " ").trim(); return max ? t.slice(0, max) : t; };
const num = v => (v === null || v === undefined || v === "" || !Number.isFinite(+v)) ? null : +v;
const money = v => { const n = num(v); return n == null || n < 0 ? null : Math.round(n); };
const isQty = q => Number.isInteger(q) && q > 0;

/* ---------- review lines ---------- */
/* Why a line needs a second look (empty list = looks fine). Recomputed after every edit. */
export function reviewReasons(l){
  const r = [];
  if(!clean(l.name)) r.push("No product name");
  if(l.qty == null) r.push("No quantity");
  else if(!isQty(l.qty)) r.push("Quantity should be a whole number, 1 or more");
  if(l.confidence != null && l.confidence < REVIEW_CONFIDENCE) r.push(`Not sure it was read correctly (${Math.round(l.confidence * 100)}%)`);
  if(l.qty != null && l.unitCost != null && l.total != null && Math.abs(l.qty * l.unitCost - l.total) > Math.max(1, l.total * 0.01))
    r.push("Quantity × price doesn't match the line total");
  if(l.note) r.push(l.note);
  return r;
}
/* extraction (supabase/functions/extract-bill response) → review lines; nothing is invented: missing stays null/"" */
export function newReviewLines(extraction, { uid }){
  const lines = (extraction && Array.isArray(extraction.lines) ? extraction.lines : []).map(x => {
    const l = {
      id: "L" + uid(), include: true, confirmed: false,
      name: clean(x.name, 120), brand: clean(x.brand, 60), desc: clean(x.description, 300),
      options: (Array.isArray(x.options) ? x.options : []).map(o => ({ n: clean(o && o.name, 24), v: clean(o && o.value, 40) })).filter(o => o.n && o.v),
      qty: num(x.quantity), unitCost: num(x.unit_price), total: num(x.total_price), mrp: num(x.mrp),
      sellPrice: money(x.mrp), sku: clean(x.sku, 40), barcode: clean(x.barcode, 64), hsn: clean(x.hsn, 8), gst: num(x.gst_rate),
      confidence: num(x.confidence), note: clean(x.notes, 300),
      match: null, action: "", targetProductId: "", targetVariantId: "",
    };
    l.reasons = reviewReasons(l); l.needsReview = l.reasons.length > 0;
    return l;
  });
  return lines;
}
/* A blank line the merchant fills in (bill read badly, or "Enter lines by hand") */
export const blankReviewLine = ({ uid }) => { const l = newReviewLines({ lines: [{}] }, { uid })[0]; l.confirmed = false; return l; };

/* ---------- matching ---------- */
export function buildIndex(products){
  const sku = new Map(), bc = new Map(), name = new Map();
  (products || []).forEach(p => {
    (p.variants || []).forEach(v => {
      if(v.sku) sku.set(low(v.sku.trim()), { p, v });
      if(v.bc) bc.set(v.bc.trim(), { p, v });
    });
    const k = normName(p.name); if(!k) return;
    if(!name.has(k)) name.set(k, []);
    name.get(k).push(p);
  });
  return { sku, bc, name };
}
const label = (p, v) => [p.name, ...((v && v.o) || [])].filter(Boolean).join(" → ");
/* the line's value for each of the product's options (by option name, any case), or null when one is missing */
function tupleFor(p, options){
  const out = [];
  for(const op of p.opts || []){
    const hit = (options || []).find(o => low(o.n) === low(op.n));
    if(!hit) return null;
    out.push((op.v || []).find(x => low(x) === low(hit.v)) || hit.v);
  }
  return out;
}
const extraOptions = (p, options) => (options || []).filter(o => !(p.opts || []).some(op => low(op.n) === low(o.n)));
/* { kind: "sku"|"barcode"|"variant"|"product"|"none", productId, variantId, label } — exact codes first, then the same
   product name (and brand, when both have one) with the same option values. No fuzzy matching. */
export function matchLine(l, idx){
  const none = { kind: "none", productId: "", variantId: "", label: "" };
  if(l.sku){ const h = idx.sku.get(low(l.sku.trim())); if(h) return { kind: "sku", productId: h.p.id, variantId: h.v.id, label: label(h.p, h.v) }; }
  if(l.barcode){ const h = idx.bc.get(l.barcode.trim()); if(h) return { kind: "barcode", productId: h.p.id, variantId: h.v.id, label: label(h.p, h.v) }; }
  const cands = (idx.name.get(normName(l.name)) || []).filter(p => !l.brand || !p.brand || normName(p.brand) === normName(l.brand));
  if(!cands.length) return none;
  for(const p of cands){
    if(extraOptions(p, l.options).length) continue;
    const t = tupleFor(p, l.options); if(!t) continue;
    const v = (p.variants || []).find(x => x.active !== false && Array.isArray(x.o) && tupleKey(x.o) === tupleKey(t));
    if(v) return { kind: "variant", productId: p.id, variantId: v.id, label: label(p, v) };
  }
  const p = cands.find(x => !x.archived) || cands[0];
  return { kind: "product", productId: p.id, variantId: "", label: p.name };
}
/* The suggested action for a matched line: add stock to what was found, add a new variant to the product, or create a
   new product. "" means the merchant has to decide (the reasons say why). */
export function defaultAction(l, products){
  const m = l.match || { kind: "none" };
  if(m.kind === "sku" || m.kind === "barcode" || m.kind === "variant") return { action: "existing", targetProductId: m.productId, targetVariantId: m.variantId, reason: "" };
  if(m.kind === "product"){
    const p = (products || []).find(x => x.id === m.productId);
    if(p && (p.opts || []).length && !extraOptions(p, l.options).length && tupleFor(p, l.options))
      return { action: "new-variant", targetProductId: p.id, targetVariantId: "", reason: "" };
    return { action: "", targetProductId: p ? p.id : "", targetVariantId: "", reason: `${p ? p.name : "A product"} already exists, but this line's options don't fit it. Pick a variant, or create a new product.` };
  }
  return { action: "new-product", targetProductId: "", targetVariantId: "", reason: "" };
}
/* Matches every line and sets its suggested action (lines the merchant already decided keep their choice) */
export function prepareLines(lines, products){
  const idx = buildIndex(products);
  lines.forEach(l => {
    l.match = matchLine(l, idx);
    if(l.decided) return;
    const d = defaultAction(l, products);
    l.action = d.action; l.targetProductId = d.targetProductId; l.targetVariantId = d.targetVariantId; l.decisionNote = d.reason;
  });
  return lines;
}

/* ---------- the plan ---------- */
/* lines: reviewed lines; products: the catalog (v3); ctx: { uid, now, deviceId, importId, note, colorIndex }.
   → { newProducts, updatedProducts:[{id, opts}], newVariants:[{productId, variant}], moves, summary, errors:[{lineId, message}] }
   Nothing here changes the catalog; applyPlan() does, once the database has accepted the same plan. */
export function planImport(lines, products, ctx){
  const { uid, now, deviceId, importId, note } = ctx;
  const errors = [], err = (l, message) => errors.push({ lineId: l.id, message });
  const byId = new Map((products || []).map(p => [p.id, p]));
  const taken = new Map();   // "s:<sku>" / "b:<code>" → owner label, across the shop and this bill
  (products || []).forEach(p => (p.variants || []).forEach(v => { if(v.sku) taken.set("s:" + low(v.sku.trim()), label(p, v)); if(v.bc) taken.set("b:" + v.bc.trim(), label(p, v)); }));
  const claim = (l, sku, bc, owner) => {
    for(const [k, val, what] of [["s:" + low(sku), sku, "SKU"], ["b:" + bc, bc, "Barcode"]]){
      if(!val) continue;
      const had = taken.get(k);
      if(had && had !== owner){ err(l, `${what} ${val} is already used by ${had}.`); return false; }
      taken.set(k, owner);
    }
    return true;
  };
  const moves = [], newVariants = [], updated = new Map(), newProducts = [], touched = new Set();
  let k = 0, units = 0;
  const addMove = (l, p, v) => {
    moves.push({ id: "imp:" + importId + ":" + (k++), v: v.id, p: p.id, type: "RESTOCK", q: l.qty, cost: money(l.unitCost), note: clean(note, 200), t: now, dev: deviceId, imp: importId });
    units += l.qty;
  };
  const used = lines.filter(l => l.include !== false && l.action !== "skip");
  used.forEach(l => {
    if(!isQty(l.qty)) err(l, "Quantity should be a whole number, 1 or more.");
    if(l.needsReview && !l.confirmed) err(l, "Check this line and tap Confirm, or remove it.");
    if(!l.action) err(l, l.decisionNote || "Choose: add stock to an existing product, or create a new one.");
  });
  const ok = l => !errors.some(e => e.lineId === l.id);

  // 1. stock for variants that exist
  used.filter(l => l.action === "existing" && ok(l)).forEach(l => {
    const p = byId.get(l.targetProductId), v = p && (p.variants || []).find(x => x.id === l.targetVariantId);
    if(!v){ err(l, "Pick the product and variant to add this stock to."); return; }
    touched.add(p.id); addMove(l, p, v);
  });
  // 2. new variants of existing products (their new option values are added to the product)
  const fresh = new Map();   // productId|tupleKey → variant made by this bill
  used.filter(l => l.action === "new-variant" && ok(l)).forEach(l => {
    const p0 = byId.get(l.targetProductId);
    if(!p0){ err(l, "Pick the product to add this variant to."); return; }
    if(!(p0.opts || []).length){ err(l, `${p0.name} has no options. Add stock to it, or create a new product.`); return; }
    const extra = extraOptions(p0, l.options);
    if(extra.length){ err(l, `${p0.name} has no option called ${extra[0].n}.`); return; }
    const t = tupleFor(p0, l.options);
    if(!t){ const miss = (p0.opts || []).find(op => !(l.options || []).some(o => low(o.n) === low(op.n))); err(l, `Needs a value for ${miss ? miss.n : "every option"}.`); return; }
    const cur = updated.get(p0.id) || { id: p0.id, opts: (p0.opts || []).map(op => ({ n: op.n, v: op.v.slice() })) };
    const key = p0.id + "|" + tupleKey(t);
    const have = (p0.variants || []).find(x => Array.isArray(x.o) && tupleKey(x.o) === tupleKey(t));
    if(have){
      if(have.active === false){ err(l, `${label(p0, have)} is off sale. Turn it back on in the product editor first.`); return; }
      touched.add(p0.id); addMove(l, p0, have); return;   // it exists after all: just stock
    }
    let v = fresh.get(key);
    if(!v){
      const sku = clean(l.sku, 40), bc = clean(l.barcode, 64);
      if(!claim(l, sku, bc, label(p0, { o: t }))) return;
      t.forEach((x, i) => { if(!cur.opts[i].v.some(y => low(y) === low(x))) cur.opts[i].v.push(x); });
      updated.set(p0.id, cur);
      v = { id: "v" + uid(), o: t, sku, bc, price: money(l.sellPrice) != null && money(l.sellPrice) !== +p0.price ? money(l.sellPrice) : null,
            cost: money(l.unitCost) != null && money(l.unitCost) !== p0.cost ? money(l.unitCost) : null, active: true };
      fresh.set(key, v); newVariants.push({ productId: p0.id, variant: v });
    }
    touched.add(p0.id); addMove(l, p0, v);
  });
  // 3. new products: lines with the same name (and brand) become one product; each distinct set of values one variant
  const groups = new Map();
  used.filter(l => l.action === "new-product" && ok(l)).forEach(l => {
    if(!clean(l.name)){ err(l, "Enter a product name."); return; }
    const g = normName(l.name) + "|" + normName(l.brand);
    if(!groups.has(g)) groups.set(g, []);
    groups.get(g).push(l);
  });
  let ci = ctx.colorIndex || 0;
  groups.forEach(ls => {
    const names = [];
    ls.forEach(l => (l.options || []).forEach(o => { if(!names.some(n => low(n) === low(o.n))) names.push(o.n); }));
    if(names.length > 3){ ls.forEach(l => err(l, "A product can have up to 3 options.")); return; }
    const bad = ls.filter(l => names.some(n => !(l.options || []).some(o => low(o.n) === low(n))));
    bad.forEach(l => { const miss = names.find(n => !(l.options || []).some(o => low(o.n) === low(n))); err(l, `Needs a value for ${miss} (other lines of ${clean(l.name)} have one). Add it, or remove the option from those lines.`); });
    const good = ls.filter(l => !bad.includes(l));
    if(!good.length) return;
    const first = good[0], price = good.map(l => money(l.sellPrice)).find(x => x != null);
    if(price == null){ good.forEach(l => err(l, "Enter a selling price for this new product.")); return; }
    const cost = good.map(l => money(l.unitCost)).find(x => x != null) ?? null;
    const opts = names.map(n => ({ n, v: [] })), variants = [], byTuple = new Map();
    const pid = "p" + uid(), pname = clean(first.name, 80);
    let failed = false;
    good.forEach(l => {
      const t = names.map((n, i) => {
        const x = l.options.find(o => low(o.n) === low(n)).v;
        const have = opts[i].v.find(y => low(y) === low(x));
        if(!have) opts[i].v.push(x);
        return have || x;
      });
      let v = byTuple.get(tupleKey(t));
      if(!v){
        const sku = clean(l.sku, 40), bc = clean(l.barcode, 64);
        if(!claim(l, sku, bc, label({ name: pname }, { o: t }))){ failed = true; return; }
        const vp = money(l.sellPrice), vc = money(l.unitCost);
        v = { id: "v" + uid(), o: t, sku, bc, price: vp != null && vp !== price ? vp : null, cost: vc != null && vc !== cost ? vc : null, active: true };
        byTuple.set(tupleKey(t), v); variants.push(v);
      }else if((l.sku && v.sku && low(l.sku) !== low(v.sku)) || (l.barcode && v.bc && l.barcode !== v.bc)){
        err(l, `Two lines for ${label({ name: pname }, v)} have different codes.`); failed = true; return;
      }
      l._variant = v;
    });
    if(failed) return;
    const hsn = (good.map(l => l.hsn).find(Boolean) || "").replace(/\D/g, "");
    const gst = good.map(l => l.gst).find(x => x != null) ?? null;
    const p = { id: pid, name: pname, cat: "", brand: clean(first.brand, 40), desc: clean(first.desc, 300), price, cost, color: COLORS[(ci++) % COLORS.length],
      archived: false, hsn: /^\d{4}(\d{2}){0,2}$/.test(hsn) ? hsn : "", gst: gst != null && gst >= 0 && gst <= 100 ? gst : null,
      code: variants.some(v => v.bc) ? "barcode" : "", opts, variants };
    newProducts.push(p);
    good.forEach(l => { addMove(l, p, l._variant); delete l._variant; });
  });
  const summary = {
    productsToCreate: newProducts.length,
    variantsToCreate: newVariants.length + newProducts.reduce((a, p) => a + p.variants.length, 0),
    existingMatched: touched.size, units, lines: used.length,
  };
  return { newProducts, updatedProducts: [...updated.values()], newVariants, moves: errors.length ? [] : moves, summary, errors };
}
/* The catalog after the plan: new values and variants on existing products, then the new products (a new array).
   Safe to run twice (a retried import): products and variants already there are not added again. */
export function applyPlan(products, plan){
  const list = products || [], have = new Set(list.map(p => p.id));
  const upd = new Map(plan.updatedProducts.map(u => [u.id, u.opts]));
  const add = new Map();
  plan.newVariants.forEach(({ productId, variant }) => { if(!add.has(productId)) add.set(productId, []); add.get(productId).push(variant); });
  const out = list.map(p => {
    if(!upd.has(p.id) && !add.has(p.id)) return p;
    const ids = new Set((p.variants || []).map(v => v.id));
    return { ...p, opts: upd.get(p.id) || p.opts, variants: [...(p.variants || []), ...(add.get(p.id) || []).filter(v => !ids.has(v.id))] };
  });
  return [...out, ...plan.newProducts.filter(p => !have.has(p.id))];
}
/* "Dress → Black → M" for a move or line target */
export const targetLabel = (p, v) => label(p, v);
