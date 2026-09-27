// Suggests and merges "Name – Colour" products into one product.
import { store } from '../../../shared/state/store.js';
import { szRank } from '../../../domain/catalog/sizes.js';
import { variantsOf } from '../../../domain/catalog/variants.js';
import { isColourOption, isSizeOption } from '../../../domain/catalog/options.js';
import { D } from '../../inventory/services/ledger.js';
import { productLeft } from '../../inventory/services/stock.js';
import { liveProducts, products } from '../services/catalog.js';
import { enqueue, flushSbQueue } from '../../sync/services/outbox.js';
import { closeModal } from '../../../shared/components/modal.js';
import { toast } from '../../../shared/components/toast.js';
import { ICON } from '../../../shared/constants/icons.js';
import { $, esc } from '../../../shared/dom.js';
import { inr } from '../../../shared/formatting/money.js';
import { saveCatalog, saveMoves } from '../../../shared/state/persistence.js';
import { renderAll } from '../../../shared/ui/render.js';
import { SWATCH } from '../../../shared/utils/colors.js';

/* ---------- colour groups: "Oversized Tee – Black" + "Oversized Tee – White" (asks first, never guesses) ---------- */

export const COLOR_WORDS=new Set(Object.keys(SWATCH).concat(["offwhite","darkblue","lightblue","darkgreen","lightgrey","darkgrey","peach","rust","sand","stone","coral","lilac","multicolour","multicolor"]));
export function splitColorName(name){
  const m=String(name||"").match(/^(.+?)\s*[–—-]\s*([A-Za-z][A-Za-z ]{1,20})$/);
  if(!m)return null;
  const col=m[2].trim(),key=col.toLowerCase().replace(/[^a-z]/g,"");
  return COLOR_WORDS.has(key)?{base:m[1].trim(),color:col.replace(/\b\w/g,x=>x.toUpperCase())}:null;
}
export function colorGroups(){
  const g={};
  // only products without a colour option and with at most one other option (e.g. Size) can be combined
  liveProducts().forEach(p=>{const os=p.opts||[];if(os.length>1||os.some(o=>isColourOption(o.n)))return;const s=splitColorName(p.name);if(!s)return;const k=s.base.toLowerCase();(g[k]=g[k]||{base:s.base,items:[]}).items.push({p,color:s.color})});
  const optNames=x=>new Set(x.items.map(i=>(i.p.opts||[]).map(o=>o.n.toLowerCase()).join()).filter(Boolean));
  return Object.values(g).filter(x=>x.items.length>1&&optNames(x).size<=1&&new Set(x.items.map(i=>i.color.toLowerCase())).size===x.items.length&&!(store.settings.groupDismissed||[]).includes(x.base.toLowerCase()));
}
export function openGroupPreview(base){
  const grp=colorGroups().find(x=>x.base===base);if(!grp)return;
  const sizes=[...new Set([].concat(...grp.items.map(i=>((i.p.opts||[])[0]||{v:[]}).v)))];
  const prices=[...new Set(grp.items.map(i=>+i.p.price||0))];
  const hist=grp.items.reduce((a,i)=>a+variantsOf(i.p,true).reduce((b,v)=>b+(D().sold[v.id]||0),0),0);
  $("#modalHost").innerHTML=`<div class="scrim" data-modal-scrim><div class="sheet custsheet" role="dialog" aria-modal="true" aria-label="Combine colours">
    <div class="sh-head"><div class="sh-t"><h3>Make “${esc(grp.base)}” one product with colours?</h3><p>Nothing changes until you confirm. Here's what will happen:</p></div><button class="iconbtn" data-modal-close aria-label="Close">${ICON.x}</button></div>
    <div class="rt-sum">${grp.items.map(i=>`<div class="row"><span>${esc(i.p.name)}</span><span>→ ${esc(grp.base)} · <b>${esc(i.color)}</b> · ${variantsOf(i.p,true).length} size${variantsOf(i.p,true).length===1?"":"s"} · ${productLeft(i.p)} pcs</span></div>`).join("")}</div>
    <ul class="gp-notes"><li>Every size keeps its exact stock.</li><li>${hist} piece${hist===1?"":"s"} already sold stay on their bills exactly as they were printed; reports count them under ${esc(grp.base)}.</li><li>Sizes: ${esc(sizes.filter(Boolean).join(", ")||"one size")}.</li>${prices.length>1?`<li>The products have different prices (${prices.map(inr).join(", ")}). Each colour keeps its own price.</li>`:""}</ul>
    <div class="setactions"><button class="btn sm primary" data-groupgo="${esc(grp.base)}">Combine into one product</button><button class="btn sm" data-groupno="${esc(grp.base)}">They're different products</button></div>
  </div></div>`;
}
export function applyGroup(base){
  const grp=colorGroups().find(x=>x.base===base);if(!grp)return;
  const parent=grp.items[0].p,basePrice=+parent.price||0;
  const sizes=[],variants=[],other=(grp.items.map(i=>(i.p.opts||[])[0]).find(Boolean)||{}).n;
  grp.items.forEach(({p,color})=>{
    ((p.opts||[])[0]||{v:[]}).v.forEach(x=>{if(!sizes.some(y=>y.toLowerCase()===x.toLowerCase()))sizes.push(x)});
    // variant ids stay the same, so old bills and stock records still point at the right colour + size
    variantsOf(p,true).forEach(v=>variants.push(Object.assign({},v,{o:[color,...(v.o||[])],price:(+p.price||0)!==basePrice?(v.price!=null?v.price:+p.price):v.price,cost:v.cost!=null?v.cost:(p.cost!=null?p.cost:null)})));
  });
  if(isSizeOption(other||""))sizes.sort((a,b)=>szRank(a)-szRank(b));
  const opts=[{n:"Colour",v:grp.items.map(i=>i.color)},...(other?[{n:other,v:sizes}]:[])];
  const merged=Object.assign({},parent,{name:grp.base,opts,variants});
  const others=grp.items.slice(1).map(i=>i.p.id);
  store.catalog.products=products().filter(p=>!others.includes(p.id)).map(p=>p.id===parent.id?merged:p);
  // moves keep their variant ids; only the product link is updated
  Object.values(store.moves).forEach(m=>{if(others.includes(m.p)){m.p=parent.id;enqueue({type:"move",id:m.id,move:m})}});
  saveMoves();saveCatalog();
  enqueue({type:"prod",id:parent.id});others.forEach(id=>{enqueue({type:"prod",id:parent.id});enqueue({type:"proddel",id})});
  closeModal();renderAll();flushSbQueue();
  toast(`${grp.base} now has ${grp.items.length} colours.`);
}
