// One bottom sheet for the commerce batch's screens (price lists, purchase orders, vouchers, GST documents, kits, repack,
// webhooks): a head with a close button, a body, an error line and one sticky primary action. store.bizView holds what is
// open ({ kind, … }); closing clears it.
import { store } from '../../../shared/state/store.js';
import { closeModal } from '../../../shared/components/modal.js';
import { ICON } from '../../../shared/constants/icons.js';
import { $, esc } from '../../../shared/dom.js';

/* label: the sheet's title · body: markup · foot: the action buttons (the primary one last) · sub: a line under the title */
export function bizSheet({ label, sub = "", body, foot = "", cls = "" }){
  const err = store.bizView && store.bizView.err || "";
  $("#modalHost").innerHTML = `<div class="scrim" data-modal-scrim data-keep data-bizscrim><div class="sheet custsheet bizsheet ${esc(cls)}" role="dialog" aria-modal="true" aria-label="${esc(label)}">
    <div class="sh-head"><div class="sh-t"><h3>${esc(label)}</h3>${sub ? `<p>${esc(sub)}</p>` : ""}</div><button type="button" class="iconbtn" data-biz="close" aria-label="Close">${ICON.x}</button></div>
    <div class="biz-body">${body}</div>
    <p class="autherr biz-err" role="alert"${err ? "" : " hidden"}>${esc(err)}</p>
    ${foot ? `<div class="sh-foot biz-foot"><span></span><div class="sh-acts">${foot}</div></div>` : ""}</div></div>`;
}
export function closeBiz(){ store.bizView = null; closeModal(); }
/* Shows an error on the open sheet without drawing it again (what was typed stays) */
export function bizError(msg){
  if(store.bizView) store.bizView.err = msg || "";
  const p = document.querySelector("#modalHost .biz-err");
  if(p){ p.textContent = msg || ""; p.hidden = !msg; }
}
/* A status chip: ok (green), warn (amber), bad (red), muted */
export const chip = (text, tone = "muted") => `<span class="bizchip ${esc(tone)}">${esc(text)}</span>`;
