// Pieces sold by each of the products' own options — Size, Colour, Storage, RAM, Pack Size, Shade… whatever the shop named
// them (spec Phase 19: variant performance never assumes clothing). lines: [{ pid, name, q, amt, opts: [{ n, v }] }], the
// option snapshot of what was sold (returns as negative quantities). An option is matched by its name, whatever its case.
// Pure.
//   optionBreakdown(lines, { orderOf }) → { names (most pieces first), plain (pieces of products without options), of(name) }
//   of(name) → { name, total, values: [{ value, q, share }] (orderOf's order, else as first seen), products: [{ pid, name, q, amt, by: { value: q } }] }
const key = (n) => String(n == null ? '' : n).trim().toLowerCase();
const r3 = (n) => Math.round(n * 1000) / 1000;

export function optionBreakdown(lines, { orderOf = null } = {}){
  const by = new Map(); let plain = 0;
  for(const l of lines || []){
    const q = +l.q || 0; if(!q) continue;
    const opts = (Array.isArray(l.opts) ? l.opts : []).filter((o) => o && key(o.n) && o.v != null && String(o.v).trim() !== '');
    if(!opts.length){ plain += q; continue; }
    for(const o of opts){
      const k = key(o.n), v = String(o.v).trim();
      const e = by.get(k) || { name: String(o.n).trim(), total: 0, values: new Map(), products: new Map() };
      e.total += q; e.values.set(v, (e.values.get(v) || 0) + q);
      const p = e.products.get(l.pid) || { pid: l.pid, name: l.name || '', q: 0, amt: 0, by: {} };
      p.q += q; p.amt += +l.amt || 0; p.by[v] = r3((p.by[v] || 0) + q);
      e.products.set(l.pid, p); by.set(k, e);
    }
  }
  const names = [...by.values()].filter((e) => e.total > 0).sort((a, b) => b.total - a.total || a.name.localeCompare(b.name)).map((e) => e.name);
  function of(name){
    const e = by.get(key(name)); if(!e) return null;
    const seen = [...e.values.keys()], ordered = (orderOf && orderOf(e.name, seen)) || seen;
    const rest = seen.filter((v) => !ordered.includes(v)), total = r3([...e.values.values()].filter((q) => q > 0).reduce((a, q) => a + q, 0));
    const values = [...ordered, ...rest].filter((v) => (e.values.get(v) || 0) > 0).map((v) => ({ value: v, q: r3(e.values.get(v)), share: total ? Math.round(e.values.get(v) / total * 100) : 0 }));
    const products = [...e.products.values()].filter((p) => p.q > 0).sort((a, b) => b.q - a.q || b.amt - a.amt).map((p) => ({ ...p, q: r3(p.q), amt: Math.round(p.amt * 100) / 100 }));
    return { name: e.name, total, values, products };
  }
  return { names, plain: r3(plain), of };
}
