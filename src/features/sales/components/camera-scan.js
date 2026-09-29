// Sell → Scan: the camera scanner screen. Each code read is looked up in this shop's catalog and one piece of that exact
// variant goes on the bill; the screen stays open for the next item until the cashier taps Done or ×.
import { store } from '../../../shared/state/store.js';
import { createScanGate } from '../../../domain/sales/scan-rules.js';
import { scanToCart } from '../use-cases/scan-to-cart.js';
import { openWeigh } from './weigh-dialog.js';
import { cartPcs } from '../services/cart.js';
import { billTotals } from '../services/totals.js';
import { closeSheets } from './bill-panel.js';
import { ICON } from '../../../shared/constants/icons.js';
import { $, esc } from '../../../shared/dom.js';
import { use } from '../../../shared/di/services.js';
import { isAppError } from '../../../shared/errors/app-error.js';
import { inr } from '../../../shared/formatting/money.js';
import { logger } from '../../../shared/logging/logger.js';
import { renderAll } from '../../../shared/ui/render.js';

/* hintMs: with the camera on and no code read for this long, tips for a better read are shown */
export const SCAN_CONFIG = { hintMs: 8000 };
/* store.scan = { status: "starting" | "live" | "error", message, kind, last: scanToCart result + t, started, gate } */

export function openScanner(){
  if(store.scan) return;
  closeSheets();
  store.scan = { status: "starting", message: "", kind: "", last: null, started: 0, gate: createScanGate() };
  const host = document.createElement("div");
  host.id = "scanHost";
  host.innerHTML = `<div class="scan" role="dialog" aria-modal="true" aria-labelledby="scanT">
    <div class="scan-top"><b id="scanT">Scan barcode</b><button type="button" class="scan-x" data-scan="close" aria-label="Close the scanner">${ICON.x}</button></div>
    <div class="scan-view"><video id="scanVideo" playsinline muted aria-label="Camera picture"></video><div class="scan-frame" aria-hidden="true"></div></div>
    <div class="scan-status" id="scanStatus" role="status" aria-live="polite"></div>
    <div class="scan-foot"><span class="scan-bill" id="scanBill"></span><button type="button" class="btn sm" data-scan="type">Type code</button><button type="button" class="btn sm primary" data-scan="close">Done</button></div>
  </div>`;
  document.body.appendChild(host);
  document.body.style.overflow = "hidden";
  paint();
  start();
}
async function start(){
  const s = store.scan; if(!s) return;
  s.status = "starting"; s.message = ""; paint();
  try{
    const r = await use("barcodeScanner").start($("#scanVideo"), { onCode, onError: e => logger.warn("Scan read failed:", e) });
    if(store.scan !== s || (r && r.cancelled)) return;
    s.status = "live"; s.started = Date.now(); paint();
    s.hintT = setTimeout(function hint(){ if(store.scan === s){ paint(); s.hintT = setTimeout(hint, 1000); } }, SCAN_CONFIG.hintMs);
  }catch(e){
    if(store.scan !== s) return;
    logger.warn("Camera failed:", e);
    s.status = "error"; s.kind = isAppError(e) && e.details ? e.details.kind || "" : "";
    s.message = isAppError(e) ? e.message : "The camera couldn't start. Try again.";
    paint();
  }
}
/* A code read by the camera (called many times while one stays in view) */
export function onCode(text){
  const s = store.scan; if(!s || s.status !== "live") return;
  if(!s.gate.pass(text, Date.now())) return;   // the same sticker still in front of the camera
  const r = scanToCart(text);
  s.last = { ...r, t: Date.now() };
  try{ if(navigator.vibrate) navigator.vibrate(r.status === "added" ? 60 : [40, 60, 40]); }catch{ /* no vibration */ }
  if(r.status === "added") renderAll();
  // sold by weight: the camera closes and the weight dialog asks for its weight
  if(r.status === "weigh"){ closeScanner(); openWeigh(r.variantId, null); return; }
  paint();
}
export function closeScanner(){
  const s = store.scan; if(!s) return;
  clearTimeout(s.hintT);
  use("barcodeScanner").stop();
  const v = $("#scanVideo"); if(v) v.srcObject = null;
  const host = document.getElementById("scanHost"); if(host) host.remove();
  store.scan = null;
  document.body.style.overflow = "";
  renderAll();
}
/* Buttons inside the scanner (data-scan) */
export function scanAction(act){
  if(act === "close") return closeScanner();
  if(act === "retry") return start();
  if(act === "type"){ closeScanner(); const i = $("#sellSearch"); if(i){ i.value = ""; i.focus(); } }
}
/* The status line and the bill total, updated in place (the video keeps running) */
function paint(){
  const s = store.scan, box = $("#scanStatus"); if(!s || !box) return;
  const last = s.last && Date.now() - s.last.t < 6000 ? s.last : null;
  let cls = "", html;
  if(s.status === "starting") html = "Opening the camera…";
  else if(s.status === "error"){
    cls = "err";
    html = `${esc(s.message)}<span class="scan-acts">${s.kind === "denied" || s.kind === "unavailable" ? "" : `<button type="button" class="btn xs" data-scan="retry">Try again</button>`}<button type="button" class="btn xs" data-scan="type">Type the code instead</button></span>`;
  } else if(last){
    cls = last.status === "added" ? "ok" : "err";
    html = `${last.status === "added" ? ICON.ok : ICON.warn || ""}${esc(last.message)}`;
  } else if(Date.now() - s.started >= SCAN_CONFIG.hintMs && !s.last) html = "No barcode found yet. Hold it 10–20 cm from the camera, in good light, and keep it still.";
  else html = "Point the camera at the barcode or QR code.";
  box.className = "scan-status " + cls;
  box.innerHTML = html;
  const bill = $("#scanBill"), n = cartPcs();
  if(bill) bill.innerHTML = n ? `<b>${n} piece${n === 1 ? "" : "s"}</b> · ${inr(billTotals(store.cart, store.disc).total)}` : "Bill is empty";
}
/* The camera is released when the app goes to the background */
document.addEventListener("visibilitychange", () => { if(document.hidden && store.scan) closeScanner(); });
