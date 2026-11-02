// What someone typed in Search, understood. Exact identifiers first — a bill, credit note, order, quotation or purchase
// order number (or just its last digits), a phone number written any way, a GSTIN, an amount — and, for bills, the
// everyday ways people narrow them: who ("Riya"), when (today, yesterday, this week, last week, this month, last month, the
// last 7 / 30 days, a month's name), which (unpaid, paid, cancelled, returned, on credit, receipts not sent), how they paid
// (cash, UPI, card) and how much (over, under, between, around 2,000 — with or without the shop's currency mark, as the
// region writes it; 2k; 1.5 lakh). A question ("how much did I sell…") is for the Agent. No records are read here;
// services/search-everything.js matches them.
import { currencyMarkSource } from '../../shared/formatting/money.js';

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const MONTH_NAMES = MONTHS.map(m => m[0].toUpperCase() + m.slice(1));
const MONTH_RE = /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b(?:\s+(20\d\d))?/;
const pad = n => String(n).padStart(2, "0");
const key = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addD = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const STOP = new Set(["bill", "bills", "invoice", "invoices", "receipt", "receipts", "sale", "sales", "from", "of", "for", "by", "to", "the", "a", "an", "show", "find", "me", "all", "my",
  "with", "in", "on", "and", "paid", "pay", "payment", "payments", "made", "customer", "customers", "please", "list", "search", "open"]);

/* A money figure: "2,500", the shop's currency mark before it (its symbol, plain form or code), "2.5k", "1.5 lakh" → the
   amount, or null */
export function moneyOf(s){
  const m = new RegExp("^(?:" + currencyMarkSource() + "\\s*)?(\\d[\\d,]*(?:\\.\\d+)?)\\s*(k|thousand|l|lakh|lakhs|lac|cr|crore)?$", "i").exec(String(s || "").trim());
  if(!m) return null;
  const n = +m[1].replace(/,/g, ""), u = (m[2] || "").toLowerCase();
  if(!Number.isFinite(n)) return null;
  return Math.round(n * (u === "k" || u === "thousand" ? 1e3 : u === "l" || u.startsWith("lak") || u === "lac" ? 1e5 : u.startsWith("cr") ? 1e7 : 1) * 100) / 100;
}
/* An amount inside a sentence, its currency mark optional (worked out when parsing: the shop's region can change) */
const amt = () => "(?:" + currencyMarkSource() + "\\s*)?\\d[\\d,]*(?:\\.\\d+)?\\s*(?:k|thousand|lakhs?|lac|l|crore|cr)?";

/* text, { now } → { raw, q, words, digits, phone, gstin, idLike, amount, period, status, method, gst, ask, billWord, alsoName } */
export function parseSearch(text, { now = Date.now() } = {}){
  const raw = String(text || "").trim(), q0 = raw.toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, " ");
  let q = q0;
  const out = { raw, q: q0, words: [], digits: "", phone: "", gstin: "", idLike: false, amount: null, period: null, status: null, method: null, gst: null, ask: false, billWord: false, alsoName: "" };
  if(!q0) return out;
  const today = new Date(now); today.setHours(12, 0, 0, 0);
  const take = re => { const m = re.exec(q); if(m) q = (q.slice(0, m.index) + " " + q.slice(m.index + m[0].length)).replace(/\s+/g, " ").trim(); return m; };

  // a question is for the Agent (it answers from the shop's records)
  out.ask = /^(how|what|why|who|which|when|is|are|did|do|does|can|should|tell me|give me)\b/.test(q0) || /\?\s*$/.test(raw);
  out.billWord = /\b(bills?|invoices?|receipts?|sales?)\b/.test(q0);
  // exact identifiers
  const gst = /\b(\d{2}[a-z]{5}\d{4}[a-z][1-9a-z]z[0-9a-z])\b/i.exec(raw);
  if(gst) out.gstin = gst[1].toUpperCase();
  out.idLike = /^#?\d{1,8}$/.test(q0) || /^[a-z]{1,6}[-/ ]?(?:[a-z][-/])?\d{1,8}$/.test(q0.replace(/\s+/g, " "));
  const digitsOnly = q0.replace(/[\s+()-]/g, "");
  if(/^\d{6,15}$/.test(digitsOnly)){ out.digits = digitsOnly; if(digitsOnly.length >= 10) out.phone = digitsOnly.slice(-10); }
  else if(/^#?\d{1,8}$/.test(q0)) out.digits = q0.replace("#", "");

  // when
  const P = (k, from, to, label) => ({ key: k, from: key(from), to: key(to), label });
  let m;
  if(take(/\btoday\b/)) out.period = P("today", today, today, "today");
  else if(take(/\byesterday\b/)) { const y = addD(today, -1); out.period = P("yesterday", y, y, "yesterday"); }
  else if(take(/\blast week\b/)) { const mon = addD(today, -((today.getDay() + 6) % 7) - 7); out.period = P("lastweek", mon, addD(mon, 6), "last week"); }
  else if(take(/\b(?:last|past) 7 days\b|\bthis week\b/)) {
    // this week: since Monday (the last 7 days when asked as such)
    const mon = addD(today, -((today.getDay() + 6) % 7));
    out.period = /7 days/.test(q0) ? P("7d", addD(today, -6), today, "the last 7 days") : P("week", mon, today, "this week"); }
  else if(take(/\b(?:last|past) 30 days\b/)) out.period = P("30d", addD(today, -29), today, "the last 30 days");
  else if(take(/\bthis month\b/)) out.period = P("month", new Date(today.getFullYear(), today.getMonth(), 1), today, "this month");
  else if(take(/\blast month\b/)) { const f = new Date(today.getFullYear(), today.getMonth() - 1, 1); out.period = P("lastmonth", f, new Date(today.getFullYear(), today.getMonth(), 0), "last month"); }
  else if((m = MONTH_RE.exec(q)) && !(m[1] === "may" && !/\b(in|of|for|during)\s+may\b|\bmay\s+20\d\d\b/.test(q))) {
    const mi = MONTHS.findIndex(x => x.startsWith(m[1].slice(0, 3))); let y = m[2] ? +m[2] : today.getFullYear();
    if(!m[2] && new Date(y, mi, 1) > today) y--;   // a month name alone: its last occurrence
    take(MONTH_RE);
    if(/^[a-z]+$/.test(q0)) out.alsoName = q0;   // "june" alone: that month's bills, and anyone or anything called June
    const f = new Date(y, mi, 1), last = new Date(y, mi + 1, 0);
    out.period = P("month:" + y + "-" + pad(mi + 1), f, last > today ? today : last, `${MONTH_NAMES[mi]} ${y}`);
  }
  // GST of a month ("gst september", "gstr-1 last month", "gst")
  if(/\b(gst|gstr-?1|gstr-?3b|gst return)\b/.test(q0) && !out.gstin){
    const mm = out.period && out.period.key.startsWith("month:") ? out.period.key.slice(6) : out.period && out.period.key === "lastmonth" ? out.period.from.slice(0, 7)
      : out.period && out.period.key === "month" ? out.period.from.slice(0, 7) : key(new Date(today.getFullYear(), today.getMonth() - 1, 1)).slice(0, 7);
    out.gst = { month: mm }; take(/\b(gst|gstr-?1|gstr-?3b|gst return)\b/);
  }
  // which
  const ST = [[/\b(unpaid|not paid|due|owed|owing|pending payment)\b/, "unpaid"], [/\b(cancelled|canceled|void(?:ed)?)\b/, "cancelled"], [/\b(returned|returns?|exchanged?|exchanges)\b/, "returns"],
    [/\b(on credit|on account|credit|udhaa?r)\b/, "credit"], [/\b(not sent|unsent|receipts? (?:not sent|failed)|failed receipts?)\b/, "unsent"], [/\bpaid\b(?! by)/, "paid"]];
  for(const [re, st] of ST){ if(take(re)){ out.status = st; break; } }
  // how they paid
  const ME = [[/\b(?:by |in |via )?(upi|gpay|google pay|phonepe|paytm|bhim)\b/, "upi"], [/\b(?:by |in |via )?(card|credit card|debit card)\b/, "card"], [/\b(?:by |in |via )?cash\b/, "cash"]];
  for(const [re, mt] of ME){ if(take(re)){ out.method = mt; break; } }
  // how much
  const AMT = amt(), MARK = currencyMarkSource();
  if((m = take(new RegExp("\\bbetween\\s+(" + AMT + ")\\s+(?:and|to|-)\\s+(" + AMT + ")", "i")))) out.amount = { op: "between", value: moneyOf(m[1]), value2: moneyOf(m[2]) };
  else if((m = take(new RegExp("(?:\\b(?:over|above|more than|greater than|at least|min(?:imum)?)\\s+|>\\s*)(" + AMT + ")", "i")))) out.amount = { op: "gt", value: moneyOf(m[1]) };
  else if((m = take(new RegExp("(?:\\b(?:under|below|less than|at most|max(?:imum)?)\\s+|<\\s*)(" + AMT + ")", "i")))) out.amount = { op: "lt", value: moneyOf(m[1]) };
  else if((m = take(new RegExp("\\b(?:around|about|approx(?:imately)?|nearly)\\s+(" + AMT + ")", "i")))) out.amount = { op: "about", value: moneyOf(m[1]) };
  else if((m = take(new RegExp(MARK + "\\s*(\\d[\\d,]*(?:\\.\\d+)?\\s*(?:k|lakhs?|lac|l)?)", "i")))) out.amount = { op: "eq", value: moneyOf(m[1]) };
  else if(!out.idLike && !out.phone && (m = take(/\b(\d[\d,]*(?:\.\d+)?\s*(?:k|lakhs?|lac))\b/i))) out.amount = { op: "eq", value: moneyOf(m[1]) };
  if(out.amount && (out.amount.value == null || (out.amount.op === "between" && out.amount.value2 == null))) out.amount = null;
  // a plain number: a bill's last digits, or an amount (both are tried)
  if(!out.amount && /^\d[\d,]*(?:\.\d+)?$/.test(q0) && !out.phone) out.amount = { op: "eq", value: moneyOf(q0) };
  // what is left: names, products, references
  out.words = out.phone ? [] : q.split(" ").map(w => w.replace(/[^a-z0-9@._#-]/g, "")).filter(w => w && !STOP.has(w) && !(out.ask && /^(how|what|why|who|which|when|is|are|did|do|does|can|should|much|many|i|we|sell|sold)$/.test(w)));
  return out;
}
/* Does an amount pass the filter? (about: within 5%) */
export function amountMatches(a, x){
  if(!a || x == null) return true;
  const v = +x;
  return a.op === "gt" ? v > a.value : a.op === "lt" ? v < a.value : a.op === "between" ? v >= Math.min(a.value, a.value2) && v <= Math.max(a.value, a.value2)
    : a.op === "about" ? Math.abs(v - a.value) <= Math.max(1, a.value * 0.05) : Math.round(v * 100) === Math.round(a.value * 100);
}
/* The words of a filter, for the list's heading ("unpaid · last week · over ₹2,000") */
export function filterWords(p, fmt = String){
  const A = p.amount, amt = !A ? "" : A.op === "gt" ? `over ${fmt(A.value)}` : A.op === "lt" ? `under ${fmt(A.value)}` : A.op === "between" ? `${fmt(A.value)}–${fmt(A.value2)}` : A.op === "about" ? `about ${fmt(A.value)}` : fmt(A.value);
  const ST = { unpaid: "unpaid", paid: "paid", cancelled: "cancelled", returns: "returned", credit: "on credit", unsent: "receipt not sent" }, MT = { cash: "cash", upi: "UPI", card: "card" };
  return [p.status && ST[p.status], p.method && "by " + MT[p.method], p.period && p.period.label, amt].filter(Boolean).join(" · ");
}
