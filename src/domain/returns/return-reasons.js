// Why things come back. Each returned line keeps its own reason; a damaged or faulty piece stays off the shelf unless
// someone says otherwise; the return's note keeps every reason in words (what an older app reads). Pure.
export const RETURN_REASONS = Object.freeze(["Didn't fit", "Wrong size", "Didn't like it", "Damaged or faulty", "Other"]);
export const DAMAGED = "Damaged or faulty";
export const REASON_MAX = 60;
/* A reason as saved: trimmed, single-spaced, at most 60 characters ("" when none) */
export const cleanReason = r => String(r == null ? "" : r).trim().replace(/\s+/g, " ").slice(0, REASON_MAX);
/* Should a piece returned for this reason go back on the shelf by default? */
export const resaleableFor = reason => cleanReason(reason) !== DAMAGED;
/* The return's note from its lines' reasons: each once, in order ("Wrong size; Damaged or faulty"), at most 200 characters */
export const reasonsNote = reasons => [...new Set((reasons || []).map(cleanReason).filter(Boolean))].join("; ").slice(0, 200);
/* After-sales in a period: why things came back, what came back most, and what went back on the shelf or stayed off it.
   rets: returns (each with items { p, n, q, value, restock, reason }) → { count, pieces, value, reasons: [{ reason, pieces,
   value }], products: [{ id, name, pieces, value, top (its most common reason) }], shelf: { pieces, value }, off: { pieces,
   value } } — biggest first; value with GST, as refunded or credited */
export function returnsByReason(rets){
  const R = {}, P = {}, shelf = { pieces: 0, value: 0 }, off = { pieces: 0, value: 0 }, r2 = x => Math.round(x * 100) / 100;
  let pieces = 0, value = 0;
  (rets || []).forEach(ret => { const why = lineReasons(ret);
    (ret.items || []).forEach((i, k) => { const q = +i.q || 0, v = +i.value || 0, reason = why[k];
      pieces += q; value += v;
      const o = R[reason] || (R[reason] = { reason, pieces: 0, value: 0 }); o.pieces += q; o.value += v;
      const p = P[i.p || i.n] || (P[i.p || i.n] = { id: i.p || null, name: i.n || "Item", pieces: 0, value: 0, by: {} }); p.pieces += q; p.value += v; p.by[reason] = (p.by[reason] || 0) + q;
      const s = i.restock === false ? off : shelf; s.pieces += q; s.value += v; }); });
  const fix = o => ({ ...o, pieces: Math.round(o.pieces * 1000) / 1000, value: r2(o.value) });
  return { count: (rets || []).length, pieces: Math.round(pieces * 1000) / 1000, value: r2(value),
    reasons: Object.values(R).map(fix).sort((a, b) => b.pieces - a.pieces || b.value - a.value),
    products: Object.values(P).map(p => ({ id: p.id, name: p.name, pieces: Math.round(p.pieces * 1000) / 1000, value: r2(p.value), top: Object.entries(p.by).sort((a, b) => b[1] - a[1])[0][0] }))
      .sort((a, b) => b.pieces - a.pieces || b.value - a.value),
    shelf: fix(shelf), off: fix(off) };
}
/* The reasons of a return's lines: each line's own, else the return's note (returns saved before lines had reasons, when
   the note is one of the reasons) → [reason per line] */
export function lineReasons(ret){
  const note = cleanReason(ret && ret.note), fallback = RETURN_REASONS.includes(note) ? note : "";
  return ((ret && ret.items) || []).map(i => cleanReason(i.reason) || fallback || "Not given");
}
