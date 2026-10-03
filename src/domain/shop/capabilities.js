// Business types and capabilities: what kind of shop this is, and which parts of the app it uses. Pure.
// Capability = "does this shop use X?" — only decides which screens, fields and switches are shown.
// Permission (domain/shop/permissions.js) = "may this person do X?" — the database enforces it. The two are never mixed:
// a capability being on never lets a role do more, and a permission never switches a capability on.
// The business type lives in the shop profile (hangtag_profiles.business_type); the shop's own capability choices in the
// synced settings (hangtag_meta 'settings': settings.caps = { uses_x: true|false } where they differ from the type's
// defaults, settings.capsAt = when they were last changed). Every device, sign-in and offline copy gets them from there.

/* ---------- business types ---------- */
export const BUSINESS_TYPES = [
  { key: "retail", label: "Retail", hint: "Clothing, footwear, gifts, general store" },
  { key: "grocery", label: "Grocery", hint: "Kirana, supermarket, fruit and vegetables" },
  { key: "restaurant", label: "Hotel / Restaurant", hint: "Restaurant, café, hotel, food stall" },
  { key: "electronics", label: "Electronics", hint: "Mobiles, appliances, computers" },
  { key: "other", label: "Other", hint: "Anything else" },
];
export const BUSINESS_TYPE_KEYS = BUSINESS_TYPES.map(t => t.key);
/* The kind of business a stored profile value means. Profiles saved before business types had these keys said e.g.
   "Clothing boutique", "Pop-up or exhibition stall", "Retail store", "Online seller" or "Wholesale" (all retail) or "Other";
   a profile without one is a retail shop. */
export function businessKind(type){
  const t = String(type || "").trim().toLowerCase();
  if(!t) return "retail";
  if(BUSINESS_TYPE_KEYS.includes(t)) return t;
  if(/restaurant|hotel|cafe|café|food/.test(t)) return "restaurant";
  if(/grocer|kirana|supermarket/.test(t)) return "grocery";
  if(/electronic|mobile/.test(t)) return "electronics";
  if(t === "other") return "other";
  return "retail";
}
export const businessLabel = type => BUSINESS_TYPES.find(t => t.key === businessKind(type)).label;

/* ---------- capabilities ----------
   group: where Settings → Capabilities lists it; needs: it builds on that one (off while that one is off) */
export const CAPABILITIES = [
  { key: "uses_variants", label: "Product variants", help: "Sizes, colours, storage … each with its own stock, SKU, barcode and price.", group: "products" },
  { key: "uses_serials", label: "Serial number tracking", help: "Each piece's serial or IMEI number, recorded when it comes in and when it is sold.", group: "products" },
  { key: "uses_batches", label: "Batch tracking", help: "Stock kept by batch or lot number.", group: "products" },
  { key: "uses_expiry", label: "Expiry tracking", help: "Expiry dates on batches, with a warning before stock expires.", group: "products" },
  { key: "uses_weight", label: "Weight-based products", help: "Sell by kg, gram or litre, typed in or read from a weighing scale.", group: "products" },
  { key: "uses_quotations", label: "Quotations", help: "Price quotes for a customer, turned into a bill when they agree.", group: "orders" },
  { key: "uses_sales_orders", label: "Sales orders", help: "Take an order now, deliver and bill it later (in parts if needed).", group: "orders" },
  { key: "uses_mobile_store", label: "Mobile store", help: "Customers browse live stock and send an order from their phone; staff still confirms payment and makes the bill.", group: "orders", needs: "uses_sales_orders" },
  { key: "uses_tables", label: "Table ordering", help: "Tables with their own running orders and bills.", group: "restaurant" },
  { key: "uses_table_qr", label: "Table QR", help: "A QR code on each table.", group: "restaurant", needs: "uses_tables" },
  { key: "uses_customer_ordering", label: "Customer table ordering", help: "Guests order from their own phone by scanning the table's QR.", group: "restaurant", needs: "uses_table_qr" },
  { key: "uses_server_ordering", label: "Server ordering", help: "Servers take orders at the table on their phone.", group: "restaurant", needs: "uses_tables" },
  { key: "uses_kitchen", label: "Kitchen", help: "A kitchen screen with the orders to prepare.", group: "restaurant", needs: "uses_tables" },
  // the commerce batch (schema.sql section 3r)
  { key: "uses_price_lists", label: "Price lists", help: "Retail, wholesale or special prices: pick a list on the bill, or give a customer their own.", group: "selling" },
  { key: "uses_bundles", label: "Kits and bundles", help: "Sell a few products together as one item at one price; stock comes from the items inside.", group: "selling" },
  { key: "uses_vouchers", label: "Gift vouchers", help: "Sell a voucher with a code and QR; customers pay with it later, all at once or in parts.", group: "selling" },
  { key: "uses_purchase_orders", label: "Purchase orders", help: "Order stock from a supplier, receive it in parts, and see what doesn't match the bill.", group: "products" },
  { key: "uses_repack", label: "Repack", help: "Open a sack or carton into loose units (25 kg sack → loose kg) with the stock kept right.", group: "products" },
  { key: "uses_einvoice", label: "E-invoice", help: "Prepare business bills for e-invoicing: Hangtag checks the details and exports the JSON.", group: "gst" },
  { key: "uses_eway", label: "E-way bill", help: "Prepare e-way bills for big deliveries: only the transport details are asked.", group: "gst" },
];
export const CAP_KEYS = CAPABILITIES.map(c => c.key);
export const CAP_LABELS = Object.fromEntries(CAPABILITIES.map(c => [c.key, c.label]));
export const CAP_GROUPS = [
  { key: "products", label: "Products and stock" },
  { key: "selling", label: "Selling" },
  { key: "orders", label: "Orders" },
  { key: "gst", label: "GST documents" },
  { key: "restaurant", label: "Restaurant and table service" },
];
/* What each business type starts with (only defaults: any shop can switch on more, e.g. grocery + serials) */
export const DEFAULT_CAPS = {
  retail: ["uses_variants", "uses_quotations", "uses_sales_orders", "uses_purchase_orders"],
  grocery: ["uses_variants", "uses_batches", "uses_expiry", "uses_weight", "uses_quotations", "uses_sales_orders", "uses_purchase_orders", "uses_repack"],
  electronics: ["uses_variants", "uses_serials", "uses_quotations", "uses_sales_orders", "uses_purchase_orders", "uses_bundles"],
  restaurant: ["uses_tables", "uses_table_qr", "uses_customer_ordering", "uses_server_ordering", "uses_kitchen"],
  other: ["uses_variants"],
};
/* { uses_x: true|false } for every capability: the type's defaults */
export function defaultCaps(type){
  const on = DEFAULT_CAPS[businessKind(type)];
  return Object.fromEntries(CAP_KEYS.map(k => [k, on.includes(k)]));
}
/* The shop's own choices as stored: only known capabilities with true/false (anything else is ignored) */
export function cleanCapOverrides(overrides){
  const out = {};
  if(overrides && typeof overrides === "object" && !Array.isArray(overrides)) CAP_KEYS.forEach(k => { if(typeof overrides[k] === "boolean") out[k] = overrides[k]; });
  return out;
}
/* What the shop uses: the type's defaults, then the shop's own choices; one that builds on another is off while that one is */
export function capsFor(type, overrides){
  const base = defaultCaps(type), own = cleanCapOverrides(overrides), out = {};
  CAP_KEYS.forEach(k => { out[k] = k in own ? own[k] : base[k]; });
  CAPABILITIES.forEach(c => { if(c.needs && !out[c.needs]) out[c.key] = false; });
  return out;
}
/* The overrides to store after changes ({ uses_x: true|false }): only what differs from the type's defaults.
   → { overrides } or { error } for a capability that doesn't exist or a value that isn't on/off */
export function capOverridesAfter(type, overrides, changes){
  const ch = changes && typeof changes === "object" ? changes : {};
  for(const k of Object.keys(ch)){
    if(!CAP_KEYS.includes(k)) return { error: "Unknown capability: " + k };
    if(typeof ch[k] !== "boolean") return { error: "A capability is either on or off." };
  }
  const base = defaultCaps(type), next = Object.assign(cleanCapOverrides(overrides), ch), out = {};
  CAP_KEYS.forEach(k => { if(k in next && next[k] !== base[k]) out[k] = next[k]; });
  return { overrides: out };
}
/* Settings arriving (a download, or the upload of a phone holding an older copy) against the copy kept: the capability
   choices changed last win, so an older copy — or an app version that doesn't know capabilities — never wipes them.
   The database does the same for uploads (supabase/schema.sql section 3j, hangtag_settings_keep_caps). */
export function keepNewerCaps(incoming, kept){
  if(!incoming || typeof incoming !== "object" || !kept || typeof kept !== "object" || !kept.caps || typeof kept.caps !== "object") return incoming;
  const at = s => typeof s.capsAt === "number" ? s.capsAt : -1;
  if(!incoming.caps || typeof incoming.caps !== "object" || at(incoming) < (typeof kept.capsAt === "number" ? kept.capsAt : 0)){
    const out = Object.assign({}, incoming, { caps: kept.caps });
    if(typeof kept.capsAt === "number") out.capsAt = kept.capsAt; else delete out.capsAt;
    return out;
  }
  return incoming;
}

/* ---------- Settings → Capabilities: grouped and recommended by business type ---------- */
/* [{ key, label, caps: [capability], open }]: first what the type recommends, then the other groups. The restaurant
   group stays folded for other businesses unless one of its capabilities is on. */
export function capSections(type, caps){
  const kind = businessKind(type), rec = DEFAULT_CAPS[kind], on = caps || capsFor(kind);
  const out = [{ key: "recommended", label: "Recommended for " + businessLabel(kind), caps: CAPABILITIES.filter(c => rec.includes(c.key)), open: true }];
  CAP_GROUPS.forEach(g => {
    const list = CAPABILITIES.filter(c => c.group === g.key && !rec.includes(c.key));
    if(list.length) out.push({ key: g.key, label: g.label, caps: list, open: g.key !== "restaurant" || kind === "restaurant" || list.some(c => on[c.key]) });
  });
  return out;
}

/* ---------- team roles to offer for the kind of business (one source: Settings → Team & devices uses it) ---------- */
export const ROLE_SUGGESTIONS = {
  retail: ["manager", "cashier"],
  grocery: ["manager", "cashier"],
  electronics: ["manager", "cashier"],
  restaurant: ["manager", "cashier", "server", "kitchen"],
  other: ["manager", "cashier"],
};
export const roleSuggestionsFor = type => ROLE_SUGGESTIONS[businessKind(type)] || ROLE_SUGGESTIONS.retail;

/* ---------- the product form: which fields a shop's capabilities call for ---------- */
export const TRACKING_MODES = [
  { key: "none", label: "None" },
  { key: "serial", label: "Serial number" },
  { key: "batch", label: "Batch" },
];
export const TRACKING_KEYS = TRACKING_MODES.map(m => m.key);
/* product: { hasOpts (it has options / variants), tracking } — what is already saved stays visible even with the
   capability off, so nothing is hidden from a product that uses it.
   → { variants, tracking, trackingModes: [keys], expiry, weight } */
export function productFieldsFor(caps, product){
  const c = caps || {}, p = product || {}, cur = TRACKING_KEYS.includes(p.tracking) ? p.tracking : "none";
  const modes = TRACKING_KEYS.filter(k => k === "none" || (k === "serial" && c.uses_serials) || (k === "batch" && c.uses_batches) || k === cur);
  const expiry = !!c.uses_expiry || !!p.expiry;
  return { variants: !!c.uses_variants || !!p.hasOpts, tracking: modes.length > 1 || expiry, trackingModes: modes, expiry, weight: !!c.uses_weight };
}
/* A product's tracking as typed: one of the modes, else none */
export const cleanTracking = t => TRACKING_KEYS.includes(t) ? t : "none";
/* The product form's "Track stock by" choices: the modes above, and "Batch with expiry date" (tracked by batch, each batch
   with its expiry date) where the shop keeps expiry dates. fx: productFieldsFor(…) */
export const EXPIRY_CHOICE = { key: "expiry", label: "Batch with expiry date" };
export const trackingChoices = fx => [...TRACKING_MODES.filter(m => fx.trackingModes.includes(m.key)), ...(fx.expiry ? [EXPIRY_CHOICE] : [])];
/* A product's choice ({ tracking, expiry }) and back */
export const trackingChoiceOf = p => cleanTracking(p && p.tracking) === "batch" && p.expiry ? "expiry" : cleanTracking(p && p.tracking);
export const trackingFromChoice = k => k === "expiry" ? { tracking: "batch", expiry: true } : { tracking: cleanTracking(k), expiry: false };

/* ---------- navigation: is a module (or one of its sub-views) shown? ----------
   def: { caps: [any of these capabilities] (none: every business), perms: [any of these permissions] (none: everyone),
   available: () => boolean (false while the module doesn't exist in this app) }. can(p): may the person signed in do p. */
export function featureShown(def, caps, can){
  if(!def) return false;
  if(def.caps && def.caps.length && !def.caps.some(k => caps && caps[k])) return false;
  if(def.perms && def.perms.length && !def.perms.some(p => can(p))) return false;
  return typeof def.available === "function" ? !!def.available() : true;
}
