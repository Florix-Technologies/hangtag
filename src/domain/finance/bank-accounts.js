// The shop's bank accounts (schema.sql section 3s): each with its opening balance on a date, active or not, one of them the
// default, and which payment methods land in it (UPI → one account, the card machine's settlements → another). Money moves
// by hand too: money in, money out, a transfer between two accounts, an adjustment with its reason; entries are never
// changed or removed, a mistake is put right by reversing it. Each account's ledger is its opening balance, the UPI and card
// money of the bank book (domain/finance/books.js) that lands in it, and its own entries. Not double-entry accounting:
// a clear running balance per account. Pure; amounts in rupees, added in paise.
import { sumP, toPaise, toRupees, tooPrecise } from '../sales/paise.js';

export const BANK_MOVE_TYPES = ["in", "out", "transfer", "adjust", "reversal"];
export const BANK_MOVE_LABELS = { in: "Money in", out: "Money out", transfer: "Transfer", adjust: "Adjustment", reversal: "Reversal" };
export const BANK_METHODS = ["upi", "card"];
export const MAX_BANK_AMOUNT = 1000000000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const clean = (s, max) => String(s == null ? "" : s).replace(/[\u0000-\u001f\u007f]/g, " ").trim().replace(/\s+/g, " ").slice(0, max);

/* A typed account → { account } or { error, field }. input: { id, name, bank, last4, opening, openingDate, active,
   isDefault, methods }; today: "YYYY-MM-DD" */
export function checkBankAccount(input, today){
  const x = input || {}, name = clean(x.name, 60), bank = clean(x.bank, 60), last4 = String(x.last4 == null ? "" : x.last4).trim();
  if(!name) return { error: "Give the account a name, e.g. HDFC Current.", field: "name" };
  if(last4 && !/^\d{4}$/.test(last4)) return { error: "Enter only the last 4 digits of the account number, or leave it empty.", field: "last4" };
  const o = String(x.opening == null ? "" : x.opening).trim(), opening = o === "" ? 0 : +o;
  if(!Number.isFinite(opening) || Math.abs(opening) > MAX_BANK_AMOUNT) return { error: "Enter the opening balance in rupees.", field: "opening" };
  if(tooPrecise(opening)) return { error: "Use at most 2 decimal places.", field: "opening" };
  const day = String(x.openingDate || today || "").trim();
  if(!DAY_RE.test(day)) return { error: "Choose the date of the opening balance.", field: "openingDate" };
  if(today && day > today) return { error: "The opening balance can't be in the future.", field: "openingDate" };
  const methods = [...new Set((x.methods || []).filter(m => BANK_METHODS.includes(m)))];
  return { account: { id: String(x.id || ""), name, bank, last4, opening: +opening.toFixed(2), openingDate: day, active: x.active !== false, isDefault: !!x.isDefault, methods } };
}

/* Which account each payment method lands in: the account that takes it, else the default account (an active one) */
export function methodAccounts(accounts){
  const live = (accounts || []).filter(a => a && a.active !== false), def = live.find(a => a.isDefault) || null, out = {};
  BANK_METHODS.forEach(m => { const a = live.find(x => (x.methods || []).includes(m)) || def; out[m] = a ? a.id : null; });
  return out;
}
/* Setting one account as default, or giving it methods, takes them off the others: → the other accounts that change */
export function exclusiveChanges(accounts, acct){
  const out = [];
  (accounts || []).forEach(a => {
    if(!a || a.id === acct.id) return;
    const methods = (a.methods || []).filter(m => !(acct.methods || []).includes(m)), isDefault = acct.isDefault ? false : !!a.isDefault;
    if(methods.length !== (a.methods || []).length || isDefault !== !!a.isDefault) out.push(Object.assign({}, a, { methods, isDefault }));
  });
  return out;
}

/* A typed entry → { move } or { error, field }. input: { id, type: in|out|transfer|adjust, account, to, amount,
   direction ("up"|"down", an adjustment), reason, t }; ctx: { accounts } */
export function checkBankMove(input, ctx = {}){
  const x = input || {}, accounts = ctx.accounts || [], byId = id => accounts.find(a => a.id === id);
  if(!["in", "out", "transfer", "adjust"].includes(x.type)) return { error: "Choose money in, money out, transfer or adjustment.", field: "type" };
  const acct = byId(x.account);
  if(!acct) return { error: "Choose the account.", field: "account" };
  if(acct.active === false) return { error: `${acct.name} is switched off. Switch it on to record money in it.`, field: "account" };
  const v = String(x.amount == null ? "" : x.amount).trim(), amount = +v;
  if(v === "" || !Number.isFinite(amount) || amount <= 0) return { error: "Enter the amount.", field: "amount" };
  if(amount > MAX_BANK_AMOUNT) return { error: "That amount is too large for one entry.", field: "amount" };
  if(tooPrecise(amount)) return { error: "Use at most 2 decimal places.", field: "amount" };
  const reason = clean(x.reason, 200);
  const move = { id: String(x.id || ""), type: x.type, account: acct.id, amount: +amount.toFixed(2), t: +x.t || 0 };
  if(x.type === "transfer"){
    const to = byId(x.to);
    if(!to) return { error: "Choose the account the money goes to.", field: "to" };
    if(to.id === acct.id) return { error: "A transfer goes to another account.", field: "to" };
    if(to.active === false) return { error: `${to.name} is switched off.`, field: "to" };
    move.to = to.id;
  }
  if(x.type === "adjust"){
    if(reason.length < 3) return { error: "Say why the balance is adjusted (at least 3 characters).", field: "reason" };
    if(x.direction === "down") move.amount = -move.amount;
  }
  if(reason) move.reason = reason;
  return { move };
}
/* Reverse an entry made by mistake → { move } or { error }. ctx: { moves } */
export function reverseBankMove(id, reason, ctx = {}){
  const moves = ctx.moves || [], m = moves.find(x => x.id === id), why = clean(reason, 200);
  if(!m) return { error: "That entry was not found." };
  if(m.type === "reversal") return { error: "A reversal can't be reversed. Record a new entry instead." };
  if(moves.some(x => x.reverses === id)) return { error: "This entry is already reversed." };
  if(why.length < 3) return { error: "Say why it is reversed (at least 3 characters)." };
  return { move: { id: "", type: "reversal", account: m.account, ...(m.to ? { to: m.to } : {}), amount: m.amount, reverses: m.id, reason: why, t: 0 } };
}

/* What one entry does to one account (paise, signed) */
function effect(m, acctId, byId){
  if(m.type === "reversal"){ const o = byId[m.reverses]; return o ? -effect(o, acctId, byId) : 0; }
  const a = toPaise(m.amount);
  if(m.type === "transfer") return m.account === acctId ? -a : m.to === acctId ? a : 0;
  if(m.account !== acctId) return 0;
  return m.type === "out" ? -a : a;   // in, adjust (signed)
}
const dayStart = d => { const [y, mo, da] = String(d).split("-").map(Number); return new Date(y, mo - 1, da).getTime(); };
/* One account's ledger: { account, opening, entries: [{ id, t, kind, label, amount (signed), balance, ref?, saleId?, moveId?,
   reverses?, reason?, status }], in, out, balance }. bankEntries: the bank book's entries (books.js bankBook().entries);
   moves: this shop's bank entries; accounts: every account (for the method mapping and transfer names) */
export function bankLedger(acct, { accounts = [], moves = [], bankEntries = [] } = {}){
  const byId = Object.fromEntries((moves || []).map(m => [m.id, m])), names = Object.fromEntries((accounts || []).map(a => [a.id, a.name]));
  const map = methodAccounts(accounts), from = dayStart(acct.openingDate);
  const rows = [];
  (bankEntries || []).forEach(e => {
    if(map[e.method] !== acct.id || e.t < from) return;
    const amt = toPaise(e.in) - toPaise(e.out);
    if(!amt) return;
    rows.push({ id: e.id, t: e.t, kind: e.type === "refund" ? "refund" : e.type === "collection" ? "collection" : "receipt", method: e.method,
      label: (e.type === "refund" ? "Refund" : e.type === "collection" ? "Payment from customer" : "Sale") + " · " + (e.method === "upi" ? "UPI" : "Card") + (e.billNo ? " · " + e.billNo : ""),
      p: amt, ref: e.ref || "", saleId: e.saleId || null, status: e.status, verification: e.verification || "" });
  });
  (moves || []).forEach(m => {
    const p = effect(m, acct.id, byId);
    if(!p) return;
    const o = m.type === "reversal" ? byId[m.reverses] : null;
    const label = m.type === "transfer" ? (m.account === acct.id ? "Transfer to " + (names[m.to] || "another account") : "Transfer from " + (names[m.account] || "another account"))
      : m.type === "reversal" ? "Reversal of " + (o ? BANK_MOVE_LABELS[o.type].toLowerCase() : "an entry") : BANK_MOVE_LABELS[m.type];
    rows.push({ id: m.id, t: m.t, kind: m.type, label, p, reason: m.reason || "", moveId: m.id, reverses: m.reverses || null, status: "posted" });
  });
  rows.sort((a, b) => a.t - b.t || String(a.id).localeCompare(String(b.id)));
  let bal = toPaise(acct.opening);
  const entries = rows.map(r => { if(r.status === "posted") bal += r.p; return Object.assign({}, r, { amount: toRupees(r.p), balance: toRupees(bal) }); });
  const live = rows.filter(r => r.status === "posted");
  return { account: acct, opening: acct.opening, openingDate: acct.openingDate, entries,
    in: toRupees(sumP(live.filter(r => r.p > 0).map(r => r.p))), out: toRupees(sumP(live.filter(r => r.p < 0).map(r => -r.p))), balance: toRupees(bal) };
}
/* Every account's balance: [{ account, balance, in, out }] (active first, then by name), and their total */
export function bankBalances(ctx){
  const list = (ctx.accounts || []).slice().sort((a, b) => (b.active !== false) - (a.active !== false) || (b.isDefault ? 1 : 0) - (a.isDefault ? 1 : 0) || a.name.localeCompare(b.name));
  const rows = list.map(a => { const L = bankLedger(a, ctx); return { account: a, balance: L.balance, in: L.in, out: L.out }; });
  return { rows, total: toRupees(sumP(rows.filter(r => r.account.active !== false).map(r => toPaise(r.balance)))) };
}
