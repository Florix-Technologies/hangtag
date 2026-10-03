// Serial numbers at the till: a product tracked by serial number goes on the bill as the exact pieces sold, chosen by their
// serial / IMEI numbers from those ready to sell (in stock, or back from a return) — ticked, searched or scanned. A serial
// already on the bill isn't offered again; the database refuses one sold twice, on any device.
// store.snPick = { pid, vid (one variant, or null: every variant of the product), q (search), sel: [serials], target: "cart" | "exchange" }
import { store } from '../../../shared/state/store.js';
import { vLabel, vPrice, variantsOf } from '../../../domain/catalog/variants.js';
import { normSerial } from '../../../domain/inventory/tracking.js';
import { prod } from '../../products/services/catalog.js';
import { thumb } from '../../products/components/thumb.js';
import { serialsOf } from '../../inventory/services/tracking.js';
import { addSerials, onSerialPick, removeSerial, serialsOnLines } from '../services/cart.js';
import { renderReturnSheet } from '../../returns/components/return-sheet.js';
import { closeSheets } from './bill-panel.js';
import { toast } from '../../../shared/components/toast.js';
import { ICON } from '../../../shared/constants/icons.js';
import { $, esc } from '../../../shared/dom.js';
import { inr } from '../../../shared/formatting/money.js';
import { saveCart } from '../../../shared/state/persistence.js';
import { renderAll } from '../../../shared/ui/render.js';

const MAX_SHOWN=200;
const targetLines=t=>t==="exchange"?(store.retState?store.retState.newItems:[]):store.cart;
export function openSerialPicker(pid,vid,target){
  const p=prod(pid); if(!p||p.archived) return;
  store.snPick={pid,vid:vid||null,q:"",sel:[],target:target||"cart"};
  store.pick=null; store.billOpen=false;
  renderSerialPicker();
  const q=$("#snQ"); if(q) q.focus({preventScroll:true});
}
onSerialPick(openSerialPicker);
/* The serials that can be chosen: ready to sell, of the product (or the one variant), not already on the bill */
function choices(){
  const S=store.snPick, p=prod(S.pid); if(!p) return [];
  const on=serialsOnLines(targetLines(S.target)), out=[];
  variantsOf(p).filter(v=>!S.vid||v.id===S.vid).forEach(v=>serialsOf(v.id,{available:true}).forEach(s=>{ if(!on.has(s.sn)) out.push({s,v}); }));
  return out;
}
export function renderSerialPicker(){
  const S=store.snPick, p=S&&prod(S.pid); if(!p){ store.snPick=null; closeSheets(); return; }
  document.body.style.overflow="hidden";
  const all=choices(), q=normSerial(S.q), list=q?all.filter(x=>x.s.sn.includes(q)):all, shown=list.slice(0,MAX_SHOWN);
  const one=S.vid?variantsOf(p).find(v=>v.id===S.vid):null, ex=S.target==="exchange";
  const rows=shown.map(({s,v})=>`<label class="snrow"><input type="checkbox" data-snsel="${esc(s.sn)}"${S.sel.includes(s.sn)?" checked":""}><b>${esc(s.sn)}</b><small>${esc([vLabel(v),inr(vPrice(p,v)),s.status==="RETURNED"?"returned earlier":""].filter(Boolean).join(" · "))}</small></label>`).join("");
  $("#sheetHost").innerHTML=`<div class="scrim" data-scrim><div class="sheet picker snpick" role="dialog" aria-modal="true" aria-label="Choose serial numbers of ${esc(p.name)}">
    <div class="sh-head">${thumb(p,"md")}<div class="sh-t"><h3>${esc(p.name)}${one&&vLabel(one)?" · "+esc(vLabel(one)):""}</h3><p>Choose the pieces by serial number · ${all.length} ready to sell</p></div><button class="iconbtn" data-act="closesheet" aria-label="Close">${ICON.x}</button></div>
    <form id="snForm" class="search" autocomplete="off"><input id="snQ" type="search" placeholder="Search, or scan a serial number" value="${esc(S.q)}" enterkeyhint="done" aria-label="Serial number"></form>
    ${shown.length?`<div class="snlist" role="group" aria-label="Serial numbers in stock">${rows}</div>${list.length>shown.length?`<p class="note">${list.length-shown.length} more: search to narrow down.</p>`:""}`
      :`<p class="muted" style="padding:12px 0">${all.length?"No serial number matches.":"No serial numbers of this product are in stock. Add stock through Purchases or Stock in, with its serial numbers."}</p>`}
    <div class="sh-foot"><span class="pk-sum" id="snSum">${S.sel.length?`<b>${S.sel.length} chosen</b>`:"Nothing chosen yet"}</span>
      <div class="sh-acts"><button class="btn sm" data-act="closesheet">Cancel</button><button class="btn sm primary" data-snpickgo id="snAddBtn"${S.sel.length?"":" disabled"}>${ex?"Use for exchange":"Add to bill"}</button></div></div>
  </div></div>`;
}
function updateSum(){
  const S=store.snPick, sum=$("#snSum"), b=$("#snAddBtn");
  if(sum) sum.innerHTML=S.sel.length?`<b>${S.sel.length} chosen</b>`:"Nothing chosen yet"; if(b) b.disabled=!S.sel.length;
}
export function toggleSerial(sn,on){
  const S=store.snPick; if(!S) return;
  S.sel=S.sel.filter(x=>x!==sn); if(on) S.sel.push(sn); updateSum();
}
/* The chosen serials onto the bill (or the exchange's new items), each on its variant's line */
export function addPickedSerials(){
  const S=store.snPick; if(!S||!S.sel.length) return;
  const by={}; choices().forEach(({s,v})=>{ if(S.sel.includes(s.sn)) (by[v.id]=by[v.id]||[]).push(s.sn); });
  const lines=targetLines(S.target), n=S.sel.length, p=prod(S.pid);
  Object.entries(by).forEach(([vid,list])=>addSerials(lines,vid,list));
  store.snPick=null;
  if(S.target==="exchange"){ renderReturnSheet(); return; }
  store.justAdded=S.pid; saveCart(); closeSheets(); renderAll();
  toast(`Added ${n} ${p?p.name:"piece"}${n>1?"s":""} by serial number.`);
}
/* ---------- events (app/events/tracking-events.js) ---------- */
export function serialPickClick(t){
  const S=store.snPick;
  if(S&&(t.matches("[data-scrim]")||t.closest("[data-act=closesheet]"))){
    store.snPick=null;
    if(S.target==="exchange") renderReturnSheet(); else closeSheets();
    return true;
  }
  if(S&&t.closest("[data-snpickgo]")){ addPickedSerials(); return true; }
  // a bill line's serials: take one off, or choose more
  const rm=t.closest("[data-snrm]");
  if(rm){ const k=rm.dataset.snrm.indexOf("|"), i=+rm.dataset.snrm.slice(0,k), sn=rm.dataset.snrm.slice(k+1);
    removeSerial(store.cart,i,sn); if(!store.cart.length) store.disc=null; saveCart(); renderAll(); return true; }
  const add=t.closest("[data-snadd]");
  if(add){ const c=store.cart[+add.dataset.snadd]; if(c) openSerialPicker(c.p,c.v,"cart"); return true; }
  return false;
}
export function serialPickInput(t){
  if(t.id==="snQ"&&store.snPick){ store.snPick.q=t.value; const pos=t.selectionStart; renderSerialPicker(); const i=$("#snQ"); if(i){ i.focus(); i.setSelectionRange(pos,pos); } return true; }
  return false;
}
export function serialPickChange(t){
  if(t.matches("[data-snsel]")&&store.snPick){ toggleSerial(t.dataset.snsel,t.checked); return true; }
  return false;
}
/* Enter in the search box (a scanner ends with Enter): an exact serial is ticked and the box cleared */
export function serialPickSubmit(e){
  if(e.target.id!=="snForm"||!store.snPick) return false;
  e.preventDefault();
  const S=store.snPick, sn=normSerial(S.q), hit=choices().find(x=>x.s.sn===sn);
  if(hit){ if(!S.sel.includes(sn)) S.sel.push(sn); S.q=""; }
  else toast(sn?`Serial ${sn} isn't in stock for this product (or is already on the bill).`:"Type or scan a serial number.");
  renderSerialPicker(); const i=$("#snQ"); if(i) i.focus();
  return true;
}
