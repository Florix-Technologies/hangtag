// Repack / unit conversion (grocery): opening a 25 kg sack into loose kg, or a carton of 24 into bottles. Two products of
// the catalog — what is opened (the source) and what it becomes (the target) — and how many target units one source unit
// gives ("per"). A conversion is two stock records under one id, never a stock number: the source goes out (ADJUST −q) and
// the target comes in (RESTOCK +q × per) carrying the source's cost spread over the new units, so the quantity and the
// value both reconcile. The database saves the pair together, with an audit row (supabase/schema.sql section 3r).
// Not manufacturing: no recipes, no production. Pure.
import { decimalsOf, qtyText, roundQty, unitOf } from '../catalog/units.js';

/* A product's saved conversions: [{ f: source variant id, t: target variant id, per }] */
export function cleanRepacks(list){
  const out = [];
  (Array.isArray(list) ? list : []).forEach(r => {
    const per = +(r && r.per);
    if(r && r.f && r.t && r.f !== r.t && Number.isFinite(per) && per > 0 && per <= 100000 && !out.some(x => x.f === r.f && x.t === r.t)) out.push({ f: String(r.f), t: String(r.t), per: roundQty(per) });
  });
  return out.slice(0, 20);
}
/* q × per exactly, in millionths (the database keeps both to 3 decimals) */
const millionths = (q, per) => Math.round(roundQty(q) * 1000) * Math.round(roundQty(per) * 1000);
const gcd = (a, b) => { while(b){ [a, b] = [b, a % b]; } return a; };
/* How a source quantity becomes the target's: q × per exactly, or null when the target's unit can't hold that amount
   (2.5 pieces). Such a repack is refused, never rounded, so it can't make stock out of nothing. */
export function repackOutput(q, per, targetUnit){
  const m = millionths(q, per), step = 10 ** (6 - decimalsOf(targetUnit));
  return m % step === 0 ? roundQty(m / 1e6) : null;
}
/* The nearest amounts to open, at most what is in stock, whose output the target's unit can hold: [{ q, out }], below
   first (opening 1 kg at 2.5 pieces a kg: 0.8 kg makes 2, 1.2 kg makes 3) */
export function repackNearest(q, per, sourceUnit, targetUnit, available){
  const stepF = 10 ** (3 - decimalsOf(sourceUnit)), perM = Math.round(roundQty(per) * 1000), step = 10 ** (6 - decimalsOf(targetUnit));
  if(!(perM > 0)) return [];
  const every = stepF * (step / gcd(stepF * perM, step));   // thousandths of the source between amounts that fit
  const at = Math.round(roundQty(q) * 1000), lo = Math.floor(at / every) * every, avail = Math.round(roundQty(+available || 0) * 1000);
  return [lo, lo + every].filter(x => x > 0 && x <= avail && x !== at).map(x => ({ q: x / 1000, out: roundQty(x * perM / 1e6) }));
}
const amount = (q, unit) => unitOf(unit).id === "pcs" ? `${q} piece${q === 1 ? "" : "s"}` : qtyText(q, unit);
/* A conversion checked and turned into its two stock records.
   x: { id, from: { p, v, unit, name, tracking, cost }, to: { p, v, unit, name, tracking }, q (source units opened), per,
        available (source stock now), batch: { b, exp } (the source batch it comes from, when tracked by batch), t, dev }
   → { error } or { moves: [out, in], out: q, in: q × per, unitCost, value } */
export function repackPlan(x){
  const f = x && x.from, to = x && x.to;
  if(!f || !to || !f.v || !to.v) return { error: "Choose what is opened and what it becomes." };
  if(f.v === to.v) return { error: "Choose a different product to repack into." };
  if(f.tracking === "serial" || to.tracking === "serial") return { error: "Products tracked by serial number can't be repacked." };
  // per is kept to 3 decimals, as the database keeps it (0.3333 is 0.333), so the plan is exactly what is saved
  const q = roundQty(+x.q), per = roundQty(+x.per), dpF = decimalsOf(f.unit);
  if(!(Number.isFinite(per) && per > 0)) return { error: `How many ${to.name} does one ${f.name} make?` };
  if(!(q > 0)) return { error: `Enter how many ${f.name} to open.` };
  if(Math.abs(q * 10 ** dpF - Math.round(q * 10 ** dpF)) > 1e-6) return { error: dpF ? `Use at most ${dpF} decimal places.` : `Open whole ${f.name}.` };
  if(q > roundQty(+x.available || 0)) return { error: `Only ${qtyText(Math.max(0, +x.available || 0), f.unit)} of ${f.name} in stock.` };
  if(f.tracking === "batch" && !(x.batch && x.batch.b)) return { error: `Choose the batch of ${f.name} to open.` };
  const out = repackOutput(q, per, to.unit);
  if(out == null){
    const near = repackNearest(q, per, f.unit, to.unit, x.available), dpT = decimalsOf(to.unit);
    const fits = dpT ? `keeps at most ${dpT} decimal place${dpT === 1 ? "" : "s"}` : "is counted in whole numbers";
    return { error: `${amount(q, f.unit)} of ${f.name} would make ${roundQty(millionths(q, per) / 1e6, 6)} ${unitOf(to.unit).id === "pcs" ? "pieces" : unitOf(to.unit).sym} of ${to.name}, which ${fits}. `
      + (near.length ? `Open ${near.map(n => `${amount(n.q, f.unit)} (makes ${amount(n.out, to.unit)})`).join(" or ")}.` : "Open a different amount."), near };
  }
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
  return { moves, out: q, in: out, per, unitCost, value };
}
/* The record kept for audit (one per conversion) */
export const repackRecord = (x, plan) => ({ id: x.id, fromV: x.from.v, fromP: x.from.p, toV: x.to.v, toP: x.to.p, fromQty: plan.out, toQty: plan.in, per: plan.per,
  value: plan.value, unitCost: plan.unitCost, t: x.t, dev: x.dev || "" });
