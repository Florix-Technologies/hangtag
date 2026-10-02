// A table's QR code: it opens the shop's ordering page for that table (order.html#t=<token>). The token identifies the
// shop's table and nothing else — no password, key or sign-in is in it; a new QR code makes the old one stop working.
// Preview, print (one table or all) and download (SVG).
import { store } from '../../../shared/state/store.js';
import { tableOrderUrl } from '../../../domain/restaurant/tables.js';
import { tableById, tableQrOn, tablesList, tablesOn } from '../services/restaurant-state.js';
import { use } from '../../../shared/di/services.js';
import { ICON } from '../../../shared/constants/icons.js';
import { $, esc } from '../../../shared/dom.js';
import { printDoc } from '../../../shared/ui/print-doc.js';
import { toast } from '../../../shared/components/toast.js';
import { logger } from '../../../shared/logging/logger.js';

/* The ordering page next to the app (the same site: GitHub Pages, or wherever the app is opened from) */
export const orderPageUrl = () => { try{ return new URL("order.html", location.href).href.split("#")[0].split("?")[0]; }catch{ return ""; } };
export const tableQrUrl = t => tableOrderUrl(orderPageUrl(), t && t.qr);
const shopName = () => (store.profile && store.profile.shop_name) || "Our restaurant";
const qrSvg = (text, size) => { try{ return use("qrCodeService").render(text, { unit: "px", size, margin: 2 }); }catch(e){ logger.warn("QR:", e); return ""; } };
/* One table's card: shop, table, the QR and a line of help */
export const qrCardHTML = (t, size = 220) => `<div class="tqr-card"><b class="tqr-shop">${esc(shopName())}</b><div class="tqr-code">${qrSvg(tableQrUrl(t), size)}</div><b class="tqr-name">Table ${esc(t.name)}</b><span class="tqr-help">Scan to see the menu and order</span></div>`;
export function openTableQr(id){
  if(!tablesOn() || !tableQrOn()){ toast("Table QR is switched off for this shop."); return; }
  const t = tableById(id); if(!t) return;
  store.tableView = Object.assign({}, store.tableView, { qr: id });
  $("#modalHost").innerHTML = `<div class="scrim" data-modal-scrim><div class="sheet tqr-sheet" role="dialog" aria-modal="true" aria-label="QR code of table ${esc(t.name)}">
    <div class="sh-head"><div class="sh-t"><h3>QR code · ${esc(t.name)}</h3><p>Guests scan it to see the menu and order for this table. It opens: <span class="tqr-url">${esc(tableQrUrl(t))}</span></p></div><button class="iconbtn" data-modal-close aria-label="Close">${ICON.x}</button></div>
    <div class="tqr-prev">${qrCardHTML(t, 240)}</div>
    <div class="sh-foot"><button class="btn sm danger" data-tqrreset="${esc(t.id)}">New QR code</button><div class="sh-acts"><button class="btn sm" data-tqrdl="${esc(t.id)}">Download SVG</button><button class="btn sm primary" data-tqrprint="${esc(t.id)}">Print</button></div></div>
  </div></div>`;
}
const PRINT_CSS = `@page{size:A4;margin:12mm}body{margin:0;font:14px system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#111}
  .g{display:grid;grid-template-columns:repeat(2,1fr);gap:10mm}.tqr-card{display:flex;flex-direction:column;align-items:center;gap:6px;border:1px dashed #999;border-radius:8px;padding:8mm 4mm;break-inside:avoid}
  .tqr-shop{font-size:16px}.tqr-name{font-size:22px}.tqr-help{font-size:12px;color:#555}.tqr-code svg{display:block;width:60mm;height:60mm}`;
/* Print one table's card, or every table in use */
export function printTableQrs(ids){
  if(!tablesOn() || !tableQrOn()){ toast("Table QR is switched off for this shop."); return; }
  const list = (ids && ids.length ? ids.map(tableById) : tablesList()).filter(t => t && t.qr);
  if(!list.length){ toast("No tables to print."); return; }
  printDoc("Table QR codes", PRINT_CSS, `<div class="g">${list.map(t => qrCardHTML(t, 260)).join("")}</div>`);
}
export async function downloadTableQr(id){
  if(!tablesOn() || !tableQrOn()){ toast("Table QR is switched off for this shop."); return; }
  const t = tableById(id); if(!t) return;
  const svg = qrSvg(tableQrUrl(t), 600); if(!svg){ toast("Couldn't make the QR code."); return; }
  await use("files").saveFile(`table-${String(t.name).replace(/[^\w-]+/g, "-").toLowerCase()}-qr.svg`, svg, "image/svg+xml");
}
