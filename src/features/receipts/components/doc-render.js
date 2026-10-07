// One look for every A4 document (tax invoice, bill, quotation, sales order, delivery challan, credit note, purchase
// order): the shop's template (Standard, Classic, Modern, Compact) and accent colour from Settings → Bills & Documents → Templates
// (domain/documents/doc-settings.js). The same model also makes the PDF (shared/utils/pdf.js docPdfBytes) and the preview.
// The 80 mm receipt keeps its own compact layout (components/receipt-view.js).
//   model: { kind, title, number, meta: [[label, value]], seller: { name, lines }, logo, parties: [{ label, name, lines }],
//            columns: [labels], left (how many columns from the start are text), rows: [[cell | { t, sub }]],
//            tax: { head, rows } | null, totals: [[label, value, grand?]], words, notes, terms, bank, signature, notice,
//            signImg, stampImg (the authorised signature and company stamp pictures, when printed),
//            footer, cancelled (the reason shown), status }
import { esc } from '../../../shared/dom.js';

const br = s => esc(s).replace(/\r?\n/g, "<br>");
const cell = c => c && typeof c === "object" ? `${esc(c.t)}${c.sub ? `<small>${esc(c.sub)}</small>` : ""}` : esc(c == null ? "" : c);
export function documentHTML(m, o = {}){
  if(!m) return "";
  const tpl = o.template || "modern", left = Math.max(1, Math.min(3, m.left || 2));
  return `<article class="doc t-${esc(tpl)}${m.cancelled ? " cancelled" : ""}" style="--acc:${esc(o.accent || "#1D5BBF")}">
<header class="d-head"><div class="d-brand">${m.logo ? `<img class="d-logo" src="${esc(m.logo)}" alt="">` : ""}<div><h2>${esc(m.seller.name)}</h2>${(m.seller.lines || []).filter(Boolean).map(l => `<p>${esc(l)}</p>`).join("")}</div></div>
<div class="d-title"><h1>${esc(m.title)}</h1><dl class="d-meta">${(m.meta || []).filter(r => r && r[1]).map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join("")}</dl></div></header>
${m.cancelled ? `<div class="d-void">CANCELLED${m.cancelled === true ? "" : " — " + esc(m.cancelled)}</div>` : ""}
${(m.parties || []).length ? `<section class="d-parties">${m.parties.map(p => `<div class="d-party"><b class="d-lab">${esc(p.label)}</b><h3>${esc(p.name || "—")}</h3>${(p.lines || []).filter(Boolean).map(l => `<p>${esc(l)}</p>`).join("")}</div>`).join("")}</section>` : ""}
<table class="d-table l${left}"><thead><tr>${m.columns.map(c => `<th>${esc(c)}</th>`).join("")}</tr></thead><tbody>${m.rows.map(r => `<tr>${r.map(c => `<td>${cell(c)}</td>`).join("")}</tr>`).join("") || `<tr><td colspan="${m.columns.length}">No items</td></tr>`}</tbody></table>
<div class="d-lower"><div class="d-left">${m.tax && m.tax.rows.length ? `<table class="d-tax"><thead><tr>${m.tax.head.map(h => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${m.tax.rows.map(r => `<tr>${r.map(c => `<td>${esc(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>` : ""}
${m.words ? `<p class="d-words"><b class="d-lab">Amount in words</b>${esc(m.words)}</p>` : ""}${m.notes ? `<section><b class="d-lab">Notes</b><p>${br(m.notes)}</p></section>` : ""}${m.terms ? `<section><b class="d-lab">Terms &amp; conditions</b><p>${br(m.terms)}</p></section>` : ""}${m.bank ? `<section><b class="d-lab">Bank &amp; payment details</b><p>${br(m.bank)}</p></section>` : ""}</div>
${(m.totals || []).length ? `<div class="d-totals">${m.totals.map(([k, v, g]) => `<div${g ? ' class="d-grand q-grand"' : ""}><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join("")}</div>` : ""}</div>
<div class="d-end">${m.notice ? `<p class="d-note">${esc(m.notice)}</p>` : "<span></span>"}<div class="d-sign${m.signImg ? " has-img" : ""}">${m.stampImg ? `<img class="d-stamp" src="${esc(m.stampImg)}" alt="Company stamp">` : ""}${m.signature ? `<p>${br(m.signature)}</p>` : `<p>For ${esc(m.seller.name)}</p>`}${m.signImg ? `<img class="d-signimg" src="${esc(m.signImg)}" alt="Authorised signature">` : ""}<span>Authorised signatory</span></div></div>
${m.footer ? `<footer>${br(m.footer)}</footer>` : ""}</article>`;
}
/* The page's CSS for a template: A4 with sensible margins, printed colours kept */
export function documentCSS(){
  return `@page{size:A4;margin:14mm}*{box-sizing:border-box}
html,body{background:#fff}body{margin:0;color:#1b1f2a;font:11.5px/1.45 "Instrument Sans",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.doc{max-width:182mm;margin:0 auto}
.d-head{display:flex;justify-content:space-between;gap:16px;align-items:flex-start;padding-bottom:12px;margin-bottom:14px;border-bottom:2px solid var(--acc)}
.d-brand{display:flex;gap:12px;align-items:flex-start;max-width:60%}.d-logo{max-width:34mm;max-height:20mm;object-fit:contain}
.d-brand h2{margin:0 0 3px;font-size:17px;line-height:1.2}.d-brand p{margin:0;color:#4a5060;font-size:10.5px}
.d-title{text-align:right;min-width:62mm}.d-title h1{margin:0 0 6px;font-size:20px;letter-spacing:.06em;text-transform:uppercase;color:var(--acc);line-height:1.15}
.d-meta{margin:0;display:grid;gap:2px}.d-meta div{display:flex;justify-content:flex-end;gap:10px}.d-meta dt{color:#6b7185}.d-meta dd{margin:0;font-weight:600;min-width:30mm;text-align:right}
.d-void{border:2px solid #c93636;color:#c93636;text-align:center;font-weight:700;letter-spacing:.08em;padding:6px;margin:0 0 12px}
.d-parties{display:grid;grid-template-columns:repeat(auto-fit,minmax(60mm,1fr));gap:14px;margin-bottom:14px}
.d-lab{display:block;font-size:9px;letter-spacing:.1em;text-transform:uppercase;color:#6b7185;margin-bottom:3px;font-weight:700}
.d-party h3{margin:0 0 2px;font-size:13px}.d-party p{margin:0;color:#3a4050}
.d-table{width:100%;border-collapse:collapse;margin-bottom:12px}
.d-table th{font-size:9.5px;letter-spacing:.05em;text-transform:uppercase;text-align:right;padding:7px 6px;color:#3a4050;border-bottom:1.5px solid #c9ccd5}
.d-table td{padding:7px 6px;border-bottom:1px solid #e4e6ec;text-align:right;vertical-align:top;font-variant-numeric:tabular-nums}
.d-table.l1 :is(th,td):nth-child(-n+1),.d-table.l2 :is(th,td):nth-child(-n+2),.d-table.l3 :is(th,td):nth-child(-n+3){text-align:left}
.d-table td small{display:block;color:#6b7185;font-size:9.5px}.d-table tr{break-inside:avoid}
.d-lower{display:flex;gap:18px;justify-content:space-between;align-items:flex-start;break-inside:avoid}
.d-left{flex:1;display:flex;flex-direction:column;gap:10px;min-width:0}.d-left section p,.d-words{margin:0}
.d-tax{border-collapse:collapse;font-size:10px}.d-tax th,.d-tax td{border:1px solid #d7dae2;padding:3px 6px;text-align:right}.d-tax th{background:#f4f5f8}
.d-totals{min-width:68mm;display:flex;flex-direction:column;gap:3px}.d-totals div{display:flex;justify-content:space-between;gap:12px}.d-totals b{font-variant-numeric:tabular-nums}
.d-grand{margin-top:4px;padding:8px 10px;background:var(--acc);color:#fff;border-radius:4px;font-size:14px}
.d-end{display:flex;justify-content:space-between;align-items:flex-end;gap:16px;margin-top:24px;break-inside:avoid}
.d-note{margin:0;color:#6b7185;font-size:10px;max-width:60%}.d-sign{margin-left:auto;text-align:center;min-width:56mm}.d-sign p{margin:0 0 28px;font-weight:600}
.d-sign span{display:block;border-top:1px solid #9aa0ae;padding-top:4px;color:#6b7185;font-size:10px}
.d-sign{position:relative}.d-sign.has-img p{margin-bottom:4px}.d-signimg{display:block;margin:0 auto 4px;max-width:46mm;max-height:16mm;object-fit:contain}
.d-stamp{position:absolute;right:calc(100% + 4mm);bottom:0;width:26mm;height:26mm;object-fit:contain;opacity:.95}
footer{margin-top:16px;padding-top:8px;border-top:1px solid #e4e6ec;text-align:center;color:#4a5060;font-size:10.5px}
.cancelled .d-table,.cancelled .d-lower{opacity:.55}
.t-modern .d-head{background:var(--acc);border:0;border-radius:6px;padding:14px 16px}.t-modern .d-head *{color:#fff}.t-modern .d-meta dt{opacity:.8}
.t-modern .d-table thead th{background:color-mix(in srgb,var(--acc) 10%,#fff);color:var(--acc);border-bottom:0}
.t-classic .d-brand h2,.t-classic .d-title h1,.t-classic .d-party h3{font-family:Georgia,"Times New Roman",serif;letter-spacing:.02em}
.t-classic .d-head{border-bottom:3px double var(--acc)}.t-classic .d-party{border:1px solid #c9ccd5;padding:8px 10px}
.t-classic .d-table th,.t-classic .d-table td{border:1px solid #c9ccd5}.t-classic .d-table thead th{background:#f2f3f6;color:#1b1f2a}
.t-classic .d-grand{border-radius:0}
:is(.t-standard,.t-minimal) .d-head{border-bottom:1px solid #d7dae2}:is(.t-standard,.t-minimal) .d-title h1{font-weight:500;letter-spacing:.16em;color:#1b1f2a}
:is(.t-standard,.t-minimal) .d-table th{border-bottom:1px solid #1b1f2a;color:#1b1f2a}:is(.t-standard,.t-minimal) .d-table td{border-bottom-color:#eef0f3}
:is(.t-standard,.t-minimal) .d-grand{background:none;color:var(--acc);border-top:2px solid var(--acc);border-radius:0;padding:8px 0}
/* Compact: the same details, denser — smaller type and tighter rows, so long bills take fewer pages */
.t-compact{font-size:10px;line-height:1.35}.t-compact .d-head{padding-bottom:8px;margin-bottom:9px;border-bottom:1.5px solid var(--acc)}
.t-compact .d-brand h2{font-size:14px}.t-compact .d-title h1{font-size:15px;margin-bottom:3px}.t-compact .d-parties{gap:10px;margin-bottom:9px}
.t-compact .d-table th{padding:4px 5px;font-size:8.5px;background:#f4f5f8;border-bottom:1px solid #c9ccd5}.t-compact .d-table td{padding:3.5px 5px}
.t-compact .d-totals{min-width:58mm}.t-compact .d-grand{padding:5px 8px;font-size:12px;border-radius:3px}.t-compact .d-end{margin-top:14px}.t-compact .d-sign p{margin-bottom:20px}`;
}
/* A preview in the app: the document in its own frame, scaled to the width it has */
export function documentFrameHTML(m, o){
  const doc = `<!doctype html><html><head><meta charset="utf-8"><style>${documentCSS()}body{padding:22px}</style></head><body>${documentHTML(m, o)}</body></html>`;
  return `<div class="docprev"><iframe class="docframe" title="Document preview" srcdoc="${esc(doc)}" data-docframe></iframe></div>`;
}
/* Fit previews to their width (call after drawing one) */
export function fitDocFrames(root){
  (root || document).querySelectorAll("iframe[data-docframe]").forEach(f => {
    const fit = () => { try{ const d = f.contentDocument; if(!d || !d.documentElement) return; const z = Math.min(1, (f.clientWidth || 800) / 800); d.documentElement.style.zoom = String(z); f.style.height = Math.max(240, Math.ceil(d.documentElement.scrollHeight * z) + 4) + "px"; }catch{ /* not ready */ } };
    if(f.contentDocument && f.contentDocument.readyState === "complete") fit(); f.addEventListener("load", fit, { once: true });
  });
}
