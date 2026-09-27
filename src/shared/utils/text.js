// Text normalisation and initials.

export function initials(n){const w=String(n||"").split(/\s+/).map(x=>x.replace(/[^A-Za-z0-9]/g,"")).filter(Boolean);return (w.slice(0,2).map(x=>x[0]).join("")||"?").toUpperCase()}
/* ================= sell ================= */
/* ---------- search: product name, category, brand, colour, size, SKU, barcode ---------- */

export const norm = s => String(s == null ? "" : s).toLowerCase();
