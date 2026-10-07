// Smart quick actions: the order of the app bar's New sheet. Not random and not a guess — the actions of the workspace the
// person is in come first (on Stock: receive stock, a supplier bill, a purchase order), then what this person starts most
// on this device (recent use counts more: a start counts half after two weeks), then the role's usual order (a cashier's
// day starts with a sale, a manager's with stock). Only what was offered is ranked: the caller decides what this person
// may do (their permissions, the modules that are on). Pure.
export const ROLE_QUICK = Object.freeze({
  owner: ["sale", "stock", "purchase", "product", "customer", "expense", "quote", "order", "po", "cash", "bank", "voucher"],
  manager: ["stock", "purchase", "po", "product", "customer", "quote", "order", "sale", "expense", "cash", "bank", "voucher"],
  cashier: ["sale", "customer", "cash", "expense", "voucher", "quote", "order"],
  server: ["sale", "customer", "order", "quote"],
  kitchen: [],
});
const HALF_LIFE = 14 * 864e5;
const OFTEN = 1.5;   // about two starts in the last few days, or more over the last weeks; one start isn't "often"
const KEEP = 20;

/* How much a person uses an action now: its starts, each counting less as it ages ({ n, t } → number) */
export const useScore = (u, now = Date.now()) => u && u.n > 0 ? u.n * Math.pow(0.5, Math.max(0, now - (+u.t || 0)) / HALF_LIFE) : 0;

/* The use record after starting `id` (kept to the 20 most recent actions): usage → usage */
export function noteQuickUse(usage, id, now = Date.now()){
  const u = { ...(usage || {}) };
  u[id] = { n: Math.round((useScore(u[id], now) + 1) * 1000) / 1000, t: now };
  Object.keys(u).sort((a, b) => (u[b].t || 0) - (u[a].t || 0)).slice(KEEP).forEach(k => { delete u[k]; });
  return u;
}

/* actions [{ id, area }] → { suggested: [{ ...action, why }], rest, list }. Suggested: the workspace's own ("here"), then the
   most used ("often": about two recent starts or more); when neither applies nothing is suggested — the list is the role's
   order */
export function rankQuickActions(actions, { role = "owner", area = "", usage = {}, now = Date.now(), suggest = 4 } = {}){
  // the role's order; anything else after it, in the owner's
  const base = ROLE_QUICK[role] || ROLE_QUICK.owner, pos = id => { const i = base.indexOf(id), o = ROLE_QUICK.owner.indexOf(id); return i >= 0 ? i : base.length + (o < 0 ? 99 : o); };
  const usual = (actions || []).slice().sort((a, b) => pos(a.id) - pos(b.id));
  const here = area ? usual.filter(a => a.area === area) : [];
  const often = usual.filter(a => !here.includes(a) && useScore(usage[a.id], now) >= OFTEN)
    .sort((a, b) => useScore(usage[b.id], now) - useScore(usage[a.id], now) || pos(a.id) - pos(b.id));
  const suggested = [...here.map(a => ({ ...a, why: "here" })), ...often.map(a => ({ ...a, why: "often" }))].slice(0, suggest);
  const picked = new Set(suggested.map(a => a.id)), rest = usual.filter(a => !picked.has(a.id));
  return { suggested, rest, list: [...suggested, ...rest] };
}
