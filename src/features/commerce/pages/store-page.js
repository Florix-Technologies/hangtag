// The Store area (owner and managers): the shop's public mobile store as a product of its own. Its status (open or
// closed), Share Store, the link to copy or preview, the QR code to show, download or print for the counter, and the
// orders customers placed from it. The in-store assisted cart has its own link and QR, kept apart from the public store.
// The storefront itself is store.html (no sign-in; the shop is found by its store token, prices and stock are the
// database's: schema.sql sections 3q / 3r / 3s). Opening or closing the store switches the "Mobile store" feature.
import { store } from '../../../shared/state/store.js';
import { $, esc } from '../../../shared/dom.js';
import { use } from '../../../shared/di/services.js';
import { toast } from '../../../shared/components/toast.js';
import { printDoc } from '../../../shared/ui/print-doc.js';
import { renderAll } from '../../../shared/ui/render.js';
import { logger } from '../../../shared/logging/logger.js';
import { inr } from '../../../shared/formatting/money.js';
import { agoText } from '../../../shared/formatting/dates.js';
import { UI_ICON, emptyStateHTML, sheetHTML, statusChip } from '../../../shared/ui/kit.js';
import { can } from '../../shop/services/access.js';
import { hasCap } from '../../shop/services/shop-caps.js';
import { saveCapabilities } from '../../shop/use-cases/save-capabilities.js';
import { flushSbQueue } from '../../sync/services/outbox.js';
import { products } from '../../products/services/catalog.js';
import { stockOf } from '../../inventory/services/stock.js';
import { variantsOf } from '../../../domain/catalog/variants.js';

const token = () => String((store.profile && store.profile.store_token) || "");
/* The public links: the store, and the in-store assisted cart (a separate QR for customers standing in the shop) */
export function storeLinks(){
  const t = token(); if(!t) return null;
  try{
    const base = new URL("store.html", location.href); base.search = ""; base.hash = "s=" + t;
    const assisted = new URL(base.href); assisted.hash = "s=" + t + "&mode=assisted";
    return { store: base.href, assisted: assisted.href, local: /^(localhost|127\.0\.0\.1)$/.test(base.hostname) || base.protocol === "file:" };
  }catch{ return null; }
}
export const storeOpen = () => hasCap("uses_mobile_store");
const shopName = () => (store.profile && store.profile.shop_name) || "Our shop";
const qrSvg = (text, size) => { try{ return use("qrCodeService").render(text, { unit: "px", size, margin: 2 }); }catch(e){ logger.warn("QR:", e); return ""; } };
/* The orders customers sent from the store (newest first) */
export const storeOrders = () => Object.values(store.orders || {}).filter(o => o && o.kind === "sales" && o.source === "customer").sort((a, b) => (b.t || 0) - (a.t || 0));
/* What customers see in the store: the products on sale (not archived, not kits, with an active variant) and how many of them are sold out */
export function storeShelf(){
  const onSale = products().filter(p => !p.archived && !p.bundle && variantsOf(p).length);
  const soldOut = onSale.filter(p => variantsOf(p).every(v => stockOf(v.id) <= 0)).length;
  return { onSale: onSale.length, soldOut };
}
/* A store order's stage as the customer's status page names it (store.html): new until the shop works on it */
const stageOf = o => o.status === "cancelled" ? ["Cancelled", "muted"] : o.status === "completed" ? ["Completed", "ok"] : o.status === "partial" ? ["Partly ready", "warn"]
  : (+o.version || 1) > 1 ? ["Confirmed", "info"] : ["Received", "warn"];

export function renderStorePage(){
  const host = document.getElementById("v-store"); if(!host) return;
  const open = storeOpen(), L = storeLinks(), orders = storeOrders(), edit = can("manage_settings");
  const waiting = orders.filter(o => o.status === "draft" || o.status === "confirmed").length, shelf = storeShelf();
  const head = `<div class="viewhead"><div><h2 class="vt">Store</h2><p>Your shop online: customers scan your QR or open your link, browse live stock, and send an order — no app, no sign-in. You confirm it and make the bill.</p></div>
    <div class="vh-acts">${open && L ? `<button type="button" class="btn primary lg" data-store="share">${UI_ICON.share} Share Store</button>` : ""}</div></div>`;
  const status = `<section class="card storestatus"><div class="ss-main"><span class="ss-dot ${open ? "on" : ""}" aria-hidden="true"></span><div><b>${open ? "Your store is open" : "Your store is closed"}</b>
      <p class="note">${open ? "Customers can see your products and send orders. Closing it shows them “not open right now”; links and QR codes keep working for when you open again." : "Open it to let customers browse and order from their phones. Nothing is visible to them until you do."}</p></div></div>
      ${edit ? `<div class="btnrow">${open ? `<button type="button" class="btn" data-store="close">Close store</button>` : `<button type="button" class="btn primary" data-store="open">Open store</button>`}</div>` : ""}</section>`;
  let body = "";
  if(!L) body = `<section class="card"><p class="note" style="margin:0">Your store link appears once this shop has connected to the cloud. Check the sync status at the top and try again.</p></section>`;
  else{
    body = `<div class="storegrid">
      <section class="card"><div class="card-h"><h3>Store link</h3>${statusChip(open ? "Open" : "Closed", open ? "ok" : "muted")}</div>
        <div class="storelink"><code>${esc(L.store)}</code></div>
        <div class="btnrow"><button type="button" class="btn" data-store="copy">${UI_ICON.copy} Copy link</button><a class="btn" href="${esc(L.store)}" target="_blank" rel="noopener">${UI_ICON.open} Preview</a>${open ? `<button type="button" class="btn" data-store="share">${UI_ICON.share} Share</button>` : ""}</div>
        ${L.local ? `<p class="note">This is a local address: customers' phones can't open it. Use the app from its public https address to share your store (see the hosting notes in README).</p>` : ""}
      </section>
      <section class="card storeshelf"><div class="card-h"><h3>What customers see</h3></div>
        <div class="shelf-n"><div><b>${shelf.onSale}</b><span>product${shelf.onSale === 1 ? "" : "s"} on sale</span></div><div><b>${shelf.soldOut}</b><span>sold out (shown as "Sold out")</span></div></div>
        <p class="note">Live prices and stock from your shop. Few left shows "Only 2 left"; GST follows your billing settings. Archived products and kits aren't shown.</p>
        <div class="btnrow"><a class="btn" href="${esc(L.store)}" target="_blank" rel="noopener">${UI_ICON.open} See your store</a><button type="button" class="btn" data-tab="stock">Manage products</button></div></section>
      <section class="card storeqr"><div class="card-h"><h3>QR code</h3></div><div class="sq-code">${qrSvg(L.store, 200)}</div>
        <p class="note">Put it on the counter, the door or your bags. It opens the store above.</p>
        <div class="btnrow"><button type="button" class="btn" data-store="qr">${UI_ICON.qr} Show</button><button type="button" class="btn" data-store="dl">${UI_ICON.download} Download</button><button type="button" class="btn" data-store="print">${UI_ICON.print} Print</button></div></section>
    </div>`;
    body += `<section class="card"><div class="card-h"><div><h3>Store orders</h3><p>${orders.length ? `${waiting} waiting for you · ${orders.length} in all` : "Orders customers send from your store appear here and in Orders → Sales orders."}</p></div>${orders.length ? `<button type="button" class="link xs" data-tab="orders" data-subview="orders:sales">All sales orders ${UI_ICON.chevron}</button>` : ""}</div>
      ${orders.length ? `<div class="olist">${orders.slice(0, 12).map(o => `<button type="button" class="orow chev" data-ordopen="${esc(o.id)}"><span class="o-main"><span class="o-t">${esc(o.no || "Order")} · ${esc((o.cust && o.cust.name) || o.custName || "Customer")}</span><span class="o-s">${esc(o.t ? agoText(o.t) : "")}${o.checkoutMode === "assisted" ? " · in-store cart" : ""}${o.paymentPreference ? " · " + esc({ upi: "prefers UPI", cash: "prefers cash", counter: "pays at the counter" }[o.paymentPreference] || "") : ""}</span></span><span class="o-end"><span class="o-amt">${inr(o.total || 0)}</span>${statusChip(stageOf(o)[0], stageOf(o)[1])}</span></button>`).join("")}</div>`
        : emptyStateHTML({ icon: "store", title: "No store orders yet", text: open ? "Share your store link or QR to get the first one." : "Open your store and share it to start taking orders.", cls: "compact plain" })}</section>`;
    body += `<section class="card"><div class="card-h"><div><h3>In-store assisted cart</h3><p>A separate link for customers standing in the shop: they build a cart on their phone and your staff finish it at the counter. Keep its QR near the trial room or the counter, apart from the public store QR.</p></div></div>
      <div class="btnrow"><button type="button" class="btn" data-store="copyassisted">${UI_ICON.copy} Copy assisted-cart link</button><button type="button" class="btn" data-store="qrassisted">${UI_ICON.qr} Show its QR</button></div></section>`;
  }
  host.innerHTML = head + status + body;
}
function qrSheet(kind){
  const L = storeLinks(); if(!L) return;
  const url = kind === "assisted" ? L.assisted : L.store;
  $("#modalHost").innerHTML = sheetHTML({ id: "storeQr", cls: "tqr-sheet", title: kind === "assisted" ? "Assisted cart QR" : "Store QR code", sub: esc(url),
    body: `<div class="tqr-prev"><div class="tqr-card"><b class="tqr-shop">${esc(shopName())}</b><div class="tqr-code">${qrSvg(url, 260)}</div><b class="tqr-name">${kind === "assisted" ? "Build your cart here" : "Order from your phone"}</b><span class="tqr-help">Scan with your phone's camera</span></div></div>`,
    foot: `<button class="btn" data-store="${kind === "assisted" ? "dlassisted" : "dl"}">${UI_ICON.download} Download</button><button class="btn primary" data-store="${kind === "assisted" ? "printassisted" : "print"}">${UI_ICON.print} Print</button>` });
}
const PRINT_CSS = `@page{size:A4;margin:16mm}body{margin:0;font:14px system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#111}
  .poster{display:flex;flex-direction:column;align-items:center;gap:8mm;padding:18mm 10mm;border:1px solid #ddd;border-radius:6mm;text-align:center}
  .poster h1{font-size:30px;margin:0}.poster p{font-size:16px;margin:0;color:#444}.poster svg{display:block;width:110mm;height:110mm}.poster small{color:#777;word-break:break-all}`;
function printQr(kind){
  const L = storeLinks(); if(!L) return;
  const url = kind === "assisted" ? L.assisted : L.store;
  printDoc(shopName() + " · store QR", PRINT_CSS, `<div class="poster"><h1>${esc(shopName())}</h1><p>${kind === "assisted" ? "Build your cart on your phone — we'll finish it at the counter" : "Scan to browse and order from your phone"}</p>${qrSvg(url, 600)}<small>${esc(url)}</small></div>`);
}
async function downloadQr(kind){
  const L = storeLinks(); if(!L) return;
  const svg = qrSvg(kind === "assisted" ? L.assisted : L.store, 800); if(!svg){ toast("Couldn't make the QR code."); return; }
  await use("files").saveFile(kind === "assisted" ? "assisted-cart-qr.svg" : "store-qr.svg", svg, "image/svg+xml");
}
async function copy(text, what){
  try{ await navigator.clipboard.writeText(text); toast(what + " copied."); }
  catch{ toast("Couldn't copy here. Long-press the link to copy it."); }
}
async function share(){
  const L = storeLinks(); if(!L) return;
  const data = { title: shopName(), text: `Order from ${shopName()} on your phone:`, url: L.store };
  if(navigator.share){ try{ await navigator.share(data); return; }catch(e){ if(e && e.name === "AbortError") return; } }
  copy(L.store, "Store link");
}
function setOpen(on){
  if(!can("manage_settings")) return;
  const r = saveCapabilities(on ? { uses_sales_orders: true, uses_mobile_store: true } : { uses_mobile_store: false });
  if(r && r.error){ toast(r.error); return; }
  flushSbQueue(); renderAll(); toast(on ? "Your store is open." : "Your store is closed.");
}
/* Registered once at start-up (app/modules.js) */
let on = false;
export function installStoreEvents(){
  if(on) return; on = true;
  document.addEventListener("click", e => {
    const b = e.target && e.target.closest && e.target.closest("[data-store]"); if(!b) return;
    const L = storeLinks(), a = b.dataset.store;
    if(a === "open" || a === "close") return setOpen(a === "open");
    if(a === "share") return share();
    if(a === "copy" && L) return copy(L.store, "Store link");
    if(a === "copyassisted" && L) return copy(L.assisted, "Assisted-cart link");
    if(a === "qr") return qrSheet("store");
    if(a === "qrassisted") return qrSheet("assisted");
    if(a === "dl") return downloadQr("store");
    if(a === "dlassisted") return downloadQr("assisted");
    if(a === "print") return printQr("store");
    if(a === "printassisted") return printQr("assisted");
  });
}
