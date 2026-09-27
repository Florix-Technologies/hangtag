// Stock page: KPIs, alerts, per-product matrix, history.
import { matrixOf } from '../../products/services/matrix.js';
import { store } from '../../../shared/state/store.js';
import { priceRange, vCost, vLabel, vPrice, variantsOf } from '../../../domain/catalog/variants.js';
import { levelOf, lowAt } from '../services/stock-levels.js';
import { productLeft, stockOf } from '../services/stock.js';
import { thumb } from '../../products/components/thumb.js';
import { emptyProductsHTML } from '../../products/pages/products-page.js';
import { liveProducts } from '../../products/services/catalog.js';
import { vRec } from '../services/ledger.js';
import { kpi } from '../../../shared/components/kpi.js';
import { ICON } from '../../../shared/constants/icons.js';
import { $, esc } from '../../../shared/dom.js';
import { dayKey, dayLab, hhmm } from '../../../shared/formatting/dates.js';
import { inr } from '../../../shared/formatting/money.js';

/* Stock matrix for one product: combinations of the first options down (e.g. colours), the last option across (e.g. sizes) */

export function stockMatrixHTML(p){
  const {colors,sizes,find,names,sw}=matrixOf(p);
  const hasC=colors[0]!=="", hasS=sizes[0]!=="";
  return `<div class="tw"><table class="smx"><thead><tr><th>${esc(names.row)}</th>${sizes.map(s=>`<th>${esc(s||"Stock")}</th>`).join("")}${hasS&&sizes.length>1?`<th class="tot">Total</th>`:""}</tr></thead><tbody>${colors.map(c=>{
    let tot=0;
    const cells=sizes.map(s=>{const v=find(c,s);if(!v)return `<td class="na">—</td>`;const n=stockOf(v.id);tot+=Math.max(0,n);const lv=levelOf(n);return `<td class="${lv}" title="${esc(p.name+" "+vLabel(v)+": "+n+" left")}">${n}${lv!=="ok"?`<em>${lv==="out"?"out":"low"}</em>`:""}</td>`}).join("");
    return `<tr><th>${hasC?`${sw(c).replace("<i ",'<i class="sw2" ')}${esc(c)}`:""}</th>${cells}${hasS&&sizes.length>1?`<td class="tot">${tot}</td>`:""}</tr>`}).join("")}</tbody></table></div>`;
}
export const MOVE_LABEL={OPENING:"Opening stock",RESTOCK:"Stock in",ADJUST:"Adjustment"};
export function renderStock(){
  const host=$("#stockBody"),ps=liveProducts();
  if(!ps.length){host.innerHTML=emptyProductsHTML();return}
  let pcs=0,val=0,costVal=0,costKnown=true;const alerts=[];
  ps.forEach(p=>variantsOf(p).forEach(v=>{const l=stockOf(v.id),n=Math.max(0,l);pcs+=n;val+=n*vPrice(p,v);const c=vCost(p,v);if(c==null){if(n)costKnown=false}else costVal+=n*c;const lv=levelOf(l);if(lv!=="ok")alerts.push({p,v,l,k:lv})}));
  alerts.sort((a,b)=>a.l-b.l);
  const outN=alerts.filter(a=>a.k==="out").length,lowN=alerts.length-outN,t=lowAt();
  let h=`<div class="kpis four">${kpi("Pieces in hand",pcs.toLocaleString("en-IN"),`across ${ps.length} product${ps.length===1?"":"s"}`)}${kpi("Stock value",inr(val),"at selling price"+(costVal?` · ${inr(costVal)} at cost${costKnown?"":" (some costs missing)"}`:""))}${kpi("Running low",String(lowN),`variants with 1–${t} pieces`,lowN?"warn":"")}${kpi("Sold out",String(outN),"variants at zero",outN?"crit":"")}</div>`;
  h+=`<div class="card"><div class="card-h"><h3>Restock soon</h3><span class="note">Variants with ${t} piece${t===1?"":"s"} or fewer · change this in Profile &amp; shop settings</span></div>${alerts.length?`<div class="alerts">${alerts.slice(0,60).map(a=>`<button class="al ${a.k}" data-stockin="${esc(a.p.id)}">${a.k==="out"?ICON.out:ICON.warn}<b>${esc(a.p.name)}</b>${vLabel(a.v)?`<span class="szl">${esc(vLabel(a.v))}</span>`:""}<span class="st">${a.k==="out"?"sold out":a.l+" left"}</span></button>`).join("")}${alerts.length>60?`<span class="note">+${alerts.length-60} more</span>`:""}</div>`:`<p class="okline">${ICON.ok}Every variant has more than ${t} piece${t===1?"":"s"}.</p>`}</div>`;
  const shown=ps.filter(p=>store.stockView==="all"||variantsOf(p).some(v=>{const lv=levelOf(stockOf(v.id));return store.stockView==="low"?lv!=="ok":lv==="out"}));
  h+=`<div class="card flush" style="margin-top:14px"><div class="card-h"><h3>Every product, every variant</h3><div class="seg" role="group" aria-label="Show">${[["all","All"],["low","Low or out"],["out","Sold out"]].map(([k,l])=>`<button data-stockview="${k}" aria-pressed="${store.stockView===k}">${l}</button>`).join("")}</div></div>`;
  h+=shown.length?shown.map(p=>`<div class="spc"><div class="spc-h">${thumb(p,"sm")}<div><b>${esc(p.name)}</b><span class="sub">${esc([p.cat,priceRange(p)].filter(Boolean).join(" · "))} · ${productLeft(p)} in hand</span></div><button class="btn xs" data-stockin="${esc(p.id)}">+ Stock in</button></div>${stockMatrixHTML(p)}</div>`).join(""):`<p class="muted" style="padding:0 16px 16px">Nothing to show here.</p>`;
  h+=`</div>`;
  // recent history (stock in, adjustments, opening stock)
  const recent=Object.values(store.moves).filter(m=>m&&m.t).sort((a,b)=>b.t-a.t).slice(0,25);
  h+=`<div class="card" style="margin-top:14px"><div class="card-h"><h3>Stock history</h3><span class="note">Stock in and adjustments. Sales and returns change stock automatically.</span></div>${recent.length?`<div class="mvlist">${recent.map(m=>{const r=vRec(m.v),nm=r?r.p.name:"(removed product)",lab=r?vLabel(r.v):"";return `<div class="mv"><span class="mv-t">${esc(dayLab(dayKey(m.t)))} ${esc(hhmm(m.t))}</span><span class="mv-n"><b>${esc(nm)}</b>${lab?` <span class="szl">${esc(lab)}</span>`:""}<small>${esc(MOVE_LABEL[m.type]||m.type)}${m.note?" · "+esc(m.note):""}${m.cost!=null?" · cost "+inr(m.cost):""}</small></span><span class="mv-q ${m.q<0?"neg":"pos"}">${m.q>0?"+":""}${m.q}</span></div>`}).join("")}</div>`:`<p class="muted">No stock changes yet.</p>`}</div>`;
  host.innerHTML=h;
}
