// Print from a bill (payment screen, bill view): shows "Printing…", then "Printed" only when the printer confirmed it,
// or the reason it didn't with Try again and the browser's print dialog as a fallback.
import { store } from '../../../shared/state/store.js';
import { printReceipt } from '../use-cases/print-receipt.js';
import { $$, esc } from '../../../shared/dom.js';

function stateHTML(sid){
  const p=store.printState; if(!p||p.sid!==sid) return "";
  if(p.status==="printing") return `<span class="dl-busy">Printing on the receipt printer…</span>`;
  if(p.status==="done") return `<span class="dl-ok">✓ Printed on the receipt printer.</span>`;
  return `<span class="dl-err">${esc(p.message)}</span> <button type="button" class="link xs" data-print="${esc(sid)}">Try again</button> <button type="button" class="link xs" data-printbrowser="${esc(sid)}">Use the print dialog</button>`;
}
/* The status line under a bill's buttons */
export const printStateHTML=sid=>`<p class="printstate" data-printstate="${esc(sid)}" role="status">${stateHTML(sid)}</p>`;
const render=sid=>$$(`[data-printstate="${sid}"]`).forEach(p=>{p.innerHTML=stateHTML(sid)});

export async function onPrint(sid,{browser}={}){
  if(store.printState&&store.printState.sid===sid&&store.printState.status==="printing") return;
  const epson=!browser&&store.printer&&store.printer.kind==="epson";
  if(epson){ store.printState={sid,status:"printing"}; render(sid); }
  const r=await printReceipt(sid,{browser});
  if(!epson) return;
  store.printState=r.error?{sid,status:"error",message:r.error}:{sid,status:"done"};
  render(sid);
}
