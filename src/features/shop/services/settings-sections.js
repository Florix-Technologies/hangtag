// Settings, in sections: which sections the person signed in sees, and the parts other features add to a section
// (e.g. Team & Devices → the weighing scale). A section shows when the person's role may use it (perms; owner: the shop's
// owner only) and, for the ones that belong to some shops only, when the shop uses one of its capabilities or is of one
// of its types. What a section may change is still checked by its use cases (and the database); a section with nothing
// in it for this person is not shown (components/settings-page.js).
import { can, isMember } from './access.js';
import { shopCaps, shopType } from './shop-caps.js';

/* key, label, sub (what it is for), icon (shared/ui/kit.js UI_ICON), keywords (for the search), who: owner (the shop's
   owner only) or perms (any of these; the owner has all), and for whom: caps (any of these on) / types (business types) */
export const SETTINGS_SECTIONS = [
  { key: "business", label: "Business", icon: "store", perms: ["manage_settings"], sub: "Your shop's details, its type of business and the features it uses.",
    keywords: "shop name owner phone address city state gstin gst number type of business retail grocery restaurant electronics features capabilities recommended" },
  { key: "plans", label: "Plans & Billing", icon: "receipt", owner: true, sub: "Your Hangtag plan: the free trial, renewing, promo codes and payments.",
    keywords: "plan plans subscription trial free trial renew renewal upgrade pay payment promo code coupon discount price expiry expires hangtag billing invoice" },
  { key: "payments", label: "Payments & Banks", icon: "bank", perms: ["manage_settings"], sub: "How customers pay you, your bank accounts and the cash drawer.",
    keywords: "upi id qr verified razorpay card machine bank account accounts balance opening transfer money in out adjustment default expense categories cash drawer" },
  { key: "billing", label: "Billing & Documents", icon: "receipt", perms: ["manage_settings"], sub: "Bill numbers, document templates, your logo, GST on bills and receipts sent to customers.",
    keywords: "bill number prefix invoice receipt paper 80mm a4 footer template modern classic minimal compact thermal logo accent colour terms signature bank details gst tax rate inclusive b2cl e-invoice e-way quotation whatsapp sms email send automatically" },
  { key: "inventory", label: "Products & Inventory", icon: "box", perms: ["manage_settings", "manage_products", "manage_inventory"], sub: "Stock alerts and expiry dates.",
    keywords: "low stock alert pieces expiry batch days warning sell expired" },
  { key: "sales", label: "Sales & Customers", icon: "tag", perms: ["manage_settings", "manage_products"], sub: "Price lists and gift vouchers.",
    keywords: "price list wholesale retail special prices customer gift voucher code" },
  { key: "purchasing", label: "Purchasing", icon: "truck", perms: ["manage_settings", "create_purchase"], sub: "How far ahead Smart reorder plans your purchases.",
    keywords: "reorder lead time supplier days safety stock cover purchase orders" },
  { key: "storefront", label: "Storefront", icon: "store", perms: ["manage_settings"], caps: ["uses_sales_orders", "uses_mobile_store"], sub: "Your public mobile store: customers browse and order from their phone.",
    keywords: "mobile store online shop qr link share orders customers" },
  { key: "restaurant", label: "Restaurant", icon: "doc", perms: ["manage_settings"], caps: ["uses_tables", "uses_kitchen"], types: ["restaurant"], sub: "Tables, table QR codes and the kitchen.",
    keywords: "tables table qr kitchen server ordering guests" },
  { key: "automation", label: "Automation", icon: "settings", perms: ["manage_settings"], sub: "What Hangtag does by itself, what waits for your OK, and a record of each.",
    keywords: "automation automatic rules approvals approve ask me first dismiss reminder payment reminder dues whatsapp reorder draft purchase order upi verify provider audit activity log policy" },
  { key: "devices", label: "Team & Devices", icon: "user", sub: "The people in your shop, their roles and phones, and this device's printer and scale.",
    keywords: "team staff members roles permissions devices phones shop code printer epson thermal scale weighing account sign out you" },
  { key: "integrations", label: "Integrations", icon: "link", owner: true, sub: "Connections to other software. Most shops never need these.",
    keywords: "webhooks api payment gateway razorpay whatsapp sms email channels invoice link page" },
  { key: "advanced", label: "Advanced", icon: "settings", owner: true, sub: "Your data: backups, restore and exports.",
    keywords: "backup restore download export csv data sync" },
];
/* May this person use the section, in this shop? */
export function sectionShown(s){
  if(s.owner ? isMember() : s.perms && !s.perms.some(p => can(p))) return false;
  if(!s.caps && !s.types) return true;
  const caps = shopCaps();
  return (s.caps || []).some(k => caps[k]) || (s.types || []).includes(shopType());
}
/* The sections this person sees, in order */
export const settingsSections = () => SETTINGS_SECTIONS.filter(sectionShown);

const PARTS = new Map();
/* Add a part to a section: { id, order, perms: [any of these] (none: everyone who sees the section), html(): markup }.
   Registering the same id again replaces it. */
export function registerSettingsPart(section, def){
  if(!PARTS.has(section)) PARTS.set(section, new Map());
  PARTS.get(section).set(def.id, Object.assign({ order: 100, perms: [] }, def));
}
/* The markup of a section's added parts (the ones this person may use) */
export function settingsPartsHTML(section){
  const list = [...(PARTS.get(section) || new Map()).values()].filter(d => !d.perms.length || d.perms.some(p => can(p))).sort((a, b) => a.order - b.order);
  return list.map(d => { try{ return d.html() || ""; }catch{ return ""; } }).join("");
}
