// Public mobile store / assisted cart input rules. This is deliberately small and pure: the storefront is only an
// interface over the existing catalog and sales-order engine. The database repeats every trust-boundary check and is
// authoritative for price and availability.
import { decimalsOf, unitId } from '../catalog/units.js';
import { validEmail } from '../../shared/validation/email.js';
import { validPhone } from '../../shared/validation/phone.js';

export const MOBILE_STORE_MODES = ['store', 'assisted'];
export const MOBILE_PAYMENT_CHOICES = ['counter', 'cash', 'upi'];

/* A public link keeps its opaque shop token in the fragment, so browsers do not send it as a referrer. */
export function mobileStoreLink(hash){
  const p = new URLSearchParams(String(hash || '').replace(/^#/, ''));
  const token = p.get('s') || '';
  const mode = p.get('mode') === 'assisted' ? 'assisted' : 'store';
  return { token:/^st_[A-Za-z0-9_-]{32,61}$/.test(token) ? token : '', mode };
}

export const mobileQtyStep = unit => 10 ** -decimalsOf(unitId(unit));

export function mobileQty(raw, unit){
  const n = Number(raw), decimals = decimalsOf(unitId(unit)), factor = 10 ** decimals;
  if(!Number.isFinite(n) || n <= 0 || n > 50 || Math.abs(n * factor - Math.round(n * factor)) > 1e-7) return null;
  return Math.round(n * factor) / factor;
}

export function cleanMobileCustomer(raw){
  const r = raw || {}, clean = (v, max) => String(v == null ? '' : v).trim().replace(/\s+/g, ' ').slice(0, max);
  return { name:clean(r.name, 80), phone:clean(r.phone, 20), email:clean(r.email, 120).toLowerCase() };
}

export function checkMobileCustomer(raw){
  const customer = cleanMobileCustomer(raw);
  if(!customer.name) return { error:'Enter your name.', field:'name', customer };
  if(!customer.phone || !validPhone(customer.phone)) return { error:'Enter a valid mobile number (at least 10 digits).', field:'phone', customer };
  if(customer.email && !validEmail(customer.email)) return { error:'Enter a valid email address.', field:'email', customer };
  return { customer };
}

/* Menu rows are trusted only as display data. The server resolves every variant again and ignores client prices. */
export function mobileOrderItems(cart, variants){
  const byId = new Map((variants || []).map(v => [v.v, v])), items = [];
  for(const [v, raw] of Object.entries(cart || {})){
    const item = byId.get(v), q = item && mobileQty(raw, item.unit);
    if(!item || q == null || q > +item.available) continue;
    items.push({ v, q });
  }
  return items.sort((a, b) => a.v.localeCompare(b.v));
}

/* Same no-discount customer total as checkout-totals: line money in paise, intra-state CGST/SGST rounded as equal
   halves, then the final payable amount rounded to the nearest rupee. */
export function mobileCartTotal(cart, variants, { taxOn=false, taxInclusive=true } = {}){
  const byId = new Map((variants || []).map(v => [v.v, v])); let paise = 0;
  Object.entries(cart || {}).forEach(([id, raw]) => { const v = byId.get(id), q = v && mobileQty(raw, v.unit); if(!v || q == null) return;
    const gross = Math.round(Math.round(q * 1000) * Math.round((+v.price || 0) * 100) / 1000), rate = taxOn ? Math.max(0, +v.gst || 0) : 0;
    const half = taxOn && !taxInclusive && rate ? Math.round(gross * rate / 200) : 0;
    paise += gross + 2 * half;
  });
  return Math.round(paise / 100);
}
