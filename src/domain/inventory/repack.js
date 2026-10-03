// Repack / unit conversion (grocery): opening a 25 kg sack into loose kg, or a carton of 24 into bottles. Two products of
// the catalog — what is opened (the source) and what it becomes (the target) — and how many target units one source unit
// gives ("per"). A conversion is two stock records under one id, never a stock number: the source goes out (ADJUST −q) and
// the target comes in (RESTOCK +q × per) carrying the source's cost spread over the new units, so the quantity and the
// value both reconcile. The database saves the pair together, with an audit row (supabase/schema.sql section 3r).
// Not manufacturing: no recipes, no production. Pure.
import { decimalsOf, qtyText, roundQty } from '../catalog/units.js';

/* A product's saved conversions: [{ f: source variant id, t: target variant id, per }] */
export function cleanRepacks(list){
  const out = [];
  (Array.isArray(list) ? list : []).forEach(r => {
    const per = +(r && r.per);
    if(r && r.f && r.t && r.f !== r.t && Number.isFinite(per) && per > 0 && per <= 100000 && !out.some(x => x.f === r.f && x.t === r.t)) out.push({ f: String(r.f), t: String(r.t), per: roundQty(per) });
  });
  return out.slice(0, 20);
}
/* How a source quantity becomes the target's: q × per, in the target's decimals */
export const repackOutput = (q, per, targetUnit) => roundQty((+q || 0) * (+per || 0), decimalsOf(targetUnit));
/* A conversion checked and turned into its two stock records.
   x: { id, from: { p, v, unit, name, tracking, cost }, to: { p, v, unit, name, tracking }, q (source units opened), per,
        available (source stock now), batch: { b, exp } (the source batch it comes from, when tracked by batch), t, dev }
   → { error } or { moves: [out, in], out: q, in: q × per, unitCost, value } */
export function repackPlan(x){
  const f = x && x.from, to = x && x.to;
  if(!f || !to || !f.v || !to.v) return { error: "Choose what is opened and what it becomes." };
  if(f.v === to.v) return { error: "Choose a different product to repack into." };
  if(f.tracking === "serial" || to.tracking === "serial") return { error: "Products tracked by serial number can't be repacked." };
  const q = roundQty(+x.q), per = +x.per, dpF = decimalsOf(f.unit);
  if(!(Number.isFinite(per) && per > 0)) return { error: `How many ${to.name} does one ${f.name} make?` };
  if(!(q > 0)) return { error: `Enter how many ${f.name} to open.` };
  if(Math.abs(q * 10 ** dpF - Math.round(q * 10 ** dpF)) > 1e-6) return { error: dpF ? `Use at most ${dpF} decimal places.` : `Open whole ${f.name}.` };
  if(q > roundQty(+x.available || 0)) return { error: `Only ${qtyText(Math.max(0, +x.available || 0), f.unit)} of ${f.name} in stock.` };
  if(f.tracking === "batch" && !(x.batch && x.batch.b)) return { error: `Choose the batch of ${f.name} to open.` };
  const out = repackOutput(q, per, to.unit);
  if(!(out > 0)) return { error: "That makes nothing. Check the quantity." };
  // the value moves with the stock: the target's cost per unit is the source cost of what was opened, spread over what it made
  const value = f.cost == null ? null : Math.round(q * (+f.cost) * 100) / 100, unitCost = value == null ? null : Math.round(value / out * 10000) / 10000;
  const note = `Repacked ${qtyText(q, f.unit)} ${f.name} → ${qtyText(out, to.unit)} ${to.name}`.slice(0, 200);
  const batch = x.batch && x.batch.b ? x.batch : null, tBatch = to.tracking === "batch" ? (batch || { b: "RPK-" + String(x.t || 0).slice(-6) }) : null;
  const moves = [
    { id: `rpk:${x.id}:out`, v: f.v, p: f.p, type: "ADJUST", q: -q, cost: null, note, t: x.t, dev: x.dev || "", ...(f.tracking === "batch" ? { b: batch.b } : {}) },
    { id: `rpk:${x.id}:in`, v: to.v, p: to.p, type: "RESTOCK", q: out, cost: unitCost == null ? null : Math.round(unitCost), note, t: x.t, dev: x.dev || "",
      ...(tBatch ? { b: tBatch.b, ...(tBatch.exp ? { exp: tBatch.exp } : {}) } : {}) },
  ];
  return { moves, out: q, in: out, unitCost, value };
}
/* The record kept for audit (one per conversion) */
export const repackRecord = (x, plan) => ({ id: x.id, fromV: x.from.v, fromP: x.from.p, toV: x.to.v, toP: x.to.p, fromQty: plan.out, toQty: plan.in, per: +x.per,
  value: plan.value, unitCost: plan.unitCost, t: x.t, dev: x.dev || "" });
