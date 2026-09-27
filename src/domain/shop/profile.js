// Shop profile fields and completeness rule.

/* ---------- Profile: required shop details, the same for every sign-in method ---------- */

export const BUSINESS_TYPES = ["Clothing boutique", "Pop-up or exhibition stall", "Retail store", "Online seller", "Wholesale", "Other"];
export const PROFILE_FIELDS = [
  { k: "full_name", label: "Your name", req: true, ac: "name", max: 80 },
  { k: "shop_name", label: "Shop name", req: true, ac: "organization", max: 80 },
  { k: "phone", label: "Phone number", req: true, ac: "tel", type: "tel", im: "tel", max: 20, hint: "10 digits, or with country code" },
  { k: "business_type", label: "Type of business", select: BUSINESS_TYPES },
  { k: "city", label: "City", req: true, ac: "address-level2", max: 60 },
  { k: "state", label: "State", req: true, ac: "address-level1", max: 60 },
  { k: "address", label: "Shop address", ac: "street-address", full: true, max: 200, hint: "Optional. Shown on bills later." },
  { k: "gstin", label: "GST number", max: 15, hint: "Optional. 15 characters, e.g. 27ABCDE1234F1Z5", upper: true }
];
export const REQUIRED_PROFILE = PROFILE_FIELDS.filter(f => f.req).map(f => f.k);
export const profileComplete = p => !!p && REQUIRED_PROFILE.every(k => String(p[k] || "").trim());
