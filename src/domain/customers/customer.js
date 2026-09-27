// Customer rules: tidy and check the details, find a customer already saved with the same mobile or GSTIN, and search
// by name or mobile. Pure.
import { validGstin } from '../../shared/validation/gstin.js';
import { validPhone } from '../../shared/validation/phone.js';
import { validEmail } from '../../shared/validation/email.js';

export const CUSTOMER_TYPES = [["individual", "Individual"], ["business", "Business"]];
export const typeLabel = t => (CUSTOMER_TYPES.find(x => x[0] === t) || CUSTOMER_TYPES[0])[1];
export const digitsOf = s => String(s == null ? "" : s).replace(/\D/g, "");
/* The number that identifies a mobile: its last 10 digits (so "+91 98765 43210" and "9876543210" are the same) */
export const mobileKey = s => { const d = digitsOf(s); return d.length >= 10 ? d.slice(-10) : d; };

/* Form values → { name, phone, email, gstin, type } trimmed; GSTIN upper case without spaces */
export function tidyCustomer(raw){
  const r = raw || {}, s = v => String(v == null ? "" : v).trim().replace(/\s+/g, " ");
  return { name: s(r.name).slice(0, 80), phone: s(r.phone), email: s(r.email).toLowerCase(), gstin: s(r.gstin).toUpperCase().replace(/\s/g, ""),
    type: r.type === "business" ? "business" : "individual" };
}
/* The first problem as { error, field }, or null */
export function checkCustomer(c){
  if(!c.name) return { error: c.type === "business" ? "Enter the business name." : "Enter the customer's name.", field: "name" };
  if(c.phone && !validPhone(c.phone)) return { error: "Enter a valid mobile number (at least 10 digits).", field: "phone" };
  if(c.email && !validEmail(c.email)) return { error: "Enter a valid email address.", field: "email" };
  if(c.gstin && !validGstin(c.gstin)) return { error: "GSTIN should be 15 letters and digits, like 27ABCDE1234F1Z5.", field: "gstin" };
  return null;
}
/* A customer already saved (other than exceptId) with the same mobile or GSTIN, and which one matched */
export function findDuplicate(list, c, exceptId){
  const m = mobileKey(c.phone);
  for(const x of list || []){
    if(!x || x.id === exceptId) continue;
    if(m.length >= 10 && mobileKey(x.phone) === m) return { customer: x, by: "phone" };
    if(c.gstin && x.gstin && x.gstin.toUpperCase() === c.gstin) return { customer: x, by: "gstin" };
  }
  return null;
}
/* Customers matching q by name (any word start or anywhere) or mobile digits; best matches first, then most recent.
   stats: { [id]: { last } } (optional) orders the rest by last visit. */
export function searchCustomers(list, q, stats){
  const t = String(q == null ? "" : q).trim().toLowerCase(), d = digitsOf(t), all = (list || []).filter(Boolean);
  const recent = c => (stats && stats[c.id] && stats[c.id].last) || c.t || 0;
  if(!t) return all.slice().sort((a, b) => recent(b) - recent(a));
  const score = c => {
    const n = String(c.name || "").toLowerCase(), p = digitsOf(c.phone);
    if(d.length >= 3 && p && (p === d || p.endsWith(d))) return 4;
    if(n === t) return 3;
    if(n.startsWith(t) || n.split(/\s+/).some(w => w.startsWith(t))) return 2;
    if(n.includes(t) || (d.length >= 3 && p.includes(d)) || String(c.email || "").includes(t) || String(c.gstin || "").toLowerCase().includes(t)) return 1;
    return 0;
  };
  return all.map(c => ({ c, s: score(c) })).filter(x => x.s > 0).sort((a, b) => b.s - a.s || recent(b.c) - recent(a.c)).map(x => x.c);
}
