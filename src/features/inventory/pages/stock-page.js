// Stock page: KPIs, alerts, per-product matrix, history.
import { matrixOf } from '../../products/services/matrix.js';
import { store } from '../../../shared/state/store.js';
import { priceRange, vCost, vLabel, vPrice, variantsOf } from '../../../domain/catalog/variants.js';
import { levelOf, lowAt } from '../services/stock-levels.js';
import { productLeft, stockOf } from '../services/stock.js';
import { reservedAll } from '../../orders/services/reservations.js';
import { thumb } from '../../products/components/thumb.js';
import { emptyProductsHTML } from '../../products/pages/products-page.js';
import { liveProducts } from '../../products/services/catalog.js';
import { D, vRec } from '../services/ledger.js';
import { MOVE_LABELS, MOVE_TYPES, filterEntries, withBalance } from '../../../domain/inventory/stock-ledger.js';
import { kpi } from '../../../shared/components/kpi.js';
import { ICON } from '../../../shared/constants/icons.js';
import { $, esc } from '../../../shared/dom.js';
import { dayKey, dayLab, hhmm } from '../../../shared/formatting/dates.js';
import { intakeCardHTML } from '../components/code-intake.js';
import { inr, numberText } from '../../../shared/formatting/money.js';
import { qtyText, roundQty } from '../../../domain/catalog/units.js';
import { batchesOf, expiryDays, expiryOf, serialsOf, trackingOfP } from '../services/tracking.js';
import { expiryAlerts } from '../services/alerts.js';
export { expiryAlerts };
import { EXPIRY_LABELS } from '../../../domain/inventory/tracking.js';
import { usesRepack } from '../use-cases/repack.js';
import { isKit } from '../../../domain/catalog/bundles.js';
import { can } from '../../shop/services/access.js';
/* Repack (grocery): open this product's stock into loose units — only where the shop repacks and the product has stock */
const repackHere=p=>{if(!usesRepack()||!can("manage_inventory")||isKit(p)||trackingOfP(p)==="serial")return "";const v=variantsOf(p).find(x=>stockOf(x.id)>0);return v?`<button class="btn xs" data-rpknew="${esc(v.id)}">Repack</button>`:""};

/* A tracked product's detail under its stock: the serials in stock, or its batches with their expiry */
export function trackedStockHTML(p){
  const t=trackingOfP(p); if(t==="none") return "";
  const vs=variantsOf(p), many=vs.length>1;
  if(t==="serial"){
    const rows=vs.map(v=>{const list=serialsOf(v.id,{available:true});return list.length?`<div class="trk-row">${many?`<b>${esc(vLabel(v)||"One size")}</b> `:""}${list.slice(0,24).map(s=>`<span class="snchip ro">${esc(s.sn)}</span>`).join("")}${list.length>24?` <span class="note">+${list.length-24} more</span>`:""}</div>`:""}).join("");
    return `<div class="trk" data-trk="${esc(p.id)}"><span class="note">Serial numbers in stock</span>${rows||`<p class="note">None in stock.</p>`}</div>`;
  }
  const rows=vs.flatMap(v=>batchesOf(v.id).map(b=>({v,b})));
  if(!rows.length) return `<div class="trk" data-trk="${esc(p.id)}"><p class="note">No batch in stock.</p></div>`;
  return `<div class="trk" data-trk="${esc(p.id)}"><table class="trk-bt"><thead><tr>${many?"<th>Variant</th>":""}<th>Batch</th><th>Expiry</th><th class="num">In stock</th></tr></thead><tbody>${rows.map(({v,b})=>{const x=expiryOf(b.exp);
    return `<tr class="${x||""}">${many?`<td>${esc(vLabel(v)||"One size")}</td>`:""}<td>${esc(b.b)}</td><td>${b.exp?esc(b.exp):"—"}${x&&x!=="fresh"?` <em class="exp ${x}">${EXPIRY_LABELS[x]}</em>`:""}</td><td class="num">${esc(qtyText(b.qty,p.unit))}</td></tr>`}).join("")}</tbody></table></div>`;
}
function expiryCardHTML(){
  const list=expiryAlerts(); if(!list.length) return "";
  const n=list.filter(a=>a.x==="expired").length;
  return `<div class="card expcard" style="margin-top:14px"><div class="card-h"><h3>Expiry</h3><span class="note">${n?`${n} batch${n===1?"":"es"} expired · `:""}${list.length-n} expiring within ${expiryDays()} days</span></div>
    <div class="alerts">${list.slice(0,40).map(a=>`<button class="al ${a.x==="expired"?"out":"low"}" data-stockadjp="${esc(a.r.p.id)}" title="Adjust this batch">${a.x==="expired"?ICON.out:ICON.warn}<b>${esc(a.r.p.name)}</b>${vLabel(a.r.v)?`<span class="szl">${esc(vLabel(a.r.v))}</span>`:""}<span class="st">Batch ${esc(a.b.b)} · ${esc(qtyText(a.b.qty,a.r.p.unit))} · ${a.x==="expired"?"expired":"expires"} ${esc(a.b.exp)}</span></button>`).join("")}${list.length>40?`<span class="note">+${list.length-40} more in Inventory → Serials &amp; batches</span>`:""}</div></div>`;
}

/* Stock matrix for one product: combinations of the first options down (e.g. colours), the last option across (e.g. sizes) */

export function stockMatrixHTML(p){
  const {colors,sizes,find,names,sw}=matrixOf(p);
  const hasC=colors[0]!=="", hasS=sizes[0]!=="";
  return `<div class="tw"><table class="smx"><thead><tr><th>${esc(names.row)}</th>${sizes.map(s=>`<th>${esc(s||"Stock")}</th>`).join("")}${hasS&&sizes.length>1?`<th class="tot">Total</th>`:""}</tr></thead><tbody>${colors.map(c=>{
    let tot=0;
    const cells=sizes.map(s=>{const v=find(c,s);if(!v)return `<td class="na">—</td>`;const n=stockOf(v.id);tot+=Math.max(0,n);const lv=levelOf(n,p);return `<td class="${lv}" title="${esc(p.name+" "+vLabel(v)+": "+n+" left")}">${n}${lv!=="ok"?`<em>${lv==="out"?"out":"low"}</em>`:""}</td>`}).join("");
    return `<tr><th>${hasC?`${sw(c).replace("<i ",'<i class="sw2" ')}${esc(c)}`:""}</th>${cells}${hasS&&sizes.length>1?`<td class="tot">${tot}</td>`:""}</tr>`}).join("")}</tbody></table></div>`;
}
export const MOVE_LABEL=MOVE_LABELS;
export function renderStock(){
  const host=$("#stockBody"),ps=liveProducts();
  if(!ps.length){host.innerHTML=emptyProductsHTML();return}
  let pcs=0,val=0,costVal=0,costKnown=true;const alerts=[];
  ps.forEach(p=>variantsOf(p).forEach(v=>{const l=stockOf(v.id),n=Math.max(0,l);pcs=roundQty(pcs+n);val+=n*vPrice(p,v);const c=vCost(p,v);if(c==null){if(n)costKnown=false}else costVal+=n*c;const lv=levelOf(l,p);if(lv!=="ok")alerts.push({p,v,l,k:lv})}));
  alerts.sort((a,b)=>a.l-b.l);
  const outN=alerts.filter(a=>a.k==="out").length,lowN=alerts.length-outN,t=lowAt(),negN=alerts.filter(a=>a.l<0).length;
  let h=`<div class="kpis four">${kpi("Pieces in hand",numberText(pcs),`across ${ps.length} product${ps.length===1?"":"s"}`)}${kpi("Stock value",inr(val),"at selling price"+(costVal?` · ${inr(costVal)} at cost${costKnown?"":" (some costs missing)"}`:""))}${kpi("Running low",String(lowN),`variants with 1–${t} pieces`,lowN?"warn":"")}${kpi("Sold out",String(outN),negN?`variants at zero · ${negN} below zero (check the count)`:"variants at zero",outN?"crit":"")}</div>`;
  h+=`<div class="card"><div class="card-h"><h3>Restock soon</h3><span class="note">Variants with ${t} piece${t===1?"":"s"} or fewer · change this in Settings → Business</span></div>${alerts.length?`<div class="alerts">${alerts.slice(0,60).map(a=>`<button class="al ${a.k}" data-stockin="${esc(a.p.id)}">${a.k==="out"?ICON.out:ICON.warn}<b>${esc(a.p.name)}</b>${vLabel(a.v)?`<span class="szl">${esc(vLabel(a.v))}</span>`:""}<span class="st">${a.l<0?a.l+" (below zero)":a.k==="out"?"sold out":a.l+" left"}</span></button>`).join("")}${alerts.length>60?`<span class="note">+${alerts.length-60} more</span>`:""}</div>`:`<p class="okline">${ICON.ok}Every variant has more than ${t} piece${t===1?"":"s"}.</p>`}</div>`;
  h+=expiryCardHTML();
  const RES=reservedAll(), resOf=p=>variantsOf(p).reduce((a,v)=>a+(RES.get(v.id)||0),0);
  const shown=ps.filter(p=>store.stockView==="all"||variantsOf(p).some(v=>{const lv=levelOf(stockOf(v.id),p);return store.stockView==="low"?lv!=="ok":lv==="out"}));
  h+=`<div class="card flush" style="margin-top:14px"><div class="card-h"><h3>Every product, every variant</h3><div class="seg" role="group" aria-label="Show">${[["all","All"],["low","Low or out"],["out","Sold out"]].map(([k,l])=>`<button data-stockview="${k}" aria-pressed="${store.stockView===k}">${l}</button>`).join("")}</div></div>`;
  h+=shown.length?shown.map(p=>`<div class="spc"><div class="spc-h">${thumb(p,"sm")}<div><b>${esc(p.name)}</b><span class="sub">${esc([p.cat,priceRange(p)].filter(Boolean).join(" · "))} · ${esc(qtyText(productLeft(p),p.unit))} in hand${resOf(p)>0?` · <span class="resv" data-reserved="${esc(p.id)}">${esc(qtyText(resOf(p),p.unit))} reserved for online orders</span>`:""}</span></div><button class="btn xs" data-stockin="${esc(p.id)}">+ Stock in</button>${trackingOfP(p)!=="none"?`<button class="btn xs" data-stockadjp="${esc(p.id)}">Adjust</button>`:""}${repackHere(p)}</div>${stockMatrixHTML(p)}${trackedStockHTML(p)}</div>`).join(""):`<p class="muted" style="padding:0 16px 16px">Nothing to show here.</p>`;
  h+=`</div>`;
  h+=stockHistoryHTML(ps);
  host.innerHTML=intakeCardHTML()+h;
}
/* Stock history: every change (stock in, adjustments, sales, returns, exchanges) from the stock ledger, newest first, with
   the variant's stock after it. Filter by product, variant and kind (store.stockHist). */
export function stockHistoryHTML(ps){
  const F=store.stockHist||(store.stockHist={pid:"",vid:"",type:"",n:30});
  const p=F.pid?ps.find(x=>x.id===F.pid)||null:null; if(!p){F.pid="";F.vid=""}
  const vs=p?variantsOf(p):[]; if(F.vid&&!vs.some(v=>v.id===F.vid)) F.vid="";
  const list=filterEntries(withBalance(D().ledger),{pid:F.pid,vid:F.vid,type:F.type}).reverse(), shown=list.slice(0,F.n);
  const sel=(id,label,opts,cur)=>`<select id="${id}" class="sel" aria-label="${label}">${opts.map(([v,l])=>`<option value="${esc(v)}"${v===cur?" selected":""}>${esc(l)}</option>`).join("")}</select>`;
  const filters=`<div class="filters" style="margin:0 0 8px">${sel("shProd","Product",[["","All products"],...ps.map(x=>[x.id,x.name])],F.pid)}${p&&vs.length>1?sel("shVar","Variant",[["","All variants"],...vs.map(v=>[v.id,vLabel(v)||"One size"])],F.vid):""}${sel("shType","Kind",[["","Every kind"],...MOVE_TYPES.map(k=>[k,MOVE_LABELS[k]])],F.type)}</div>`;
  const rows=shown.map(m=>{const r=vRec(m.vid),nm=r?r.p.name:"(removed product)",lab=r?vLabel(r.v):"";
    return `<div class="mv"><span class="mv-t">${esc(dayLab(dayKey(m.t)))} ${esc(hhmm(m.t))}</span><span class="mv-n"><b>${esc(nm)}</b>${lab?` <span class="szl">${esc(lab)}</span>`:""}<small>${esc(MOVE_LABELS[m.type]||m.type)}${m.ref?" · "+esc(m.ref):""}${m.note?" · "+esc(m.note):""}${m.cost!=null&&(m.type==="RESTOCK"||m.type==="OPENING")?" · cost "+inr(m.cost):""}${m.sn?" · SN "+esc(m.sn.join(", ")):""}${m.bt?" · batch "+esc(m.bt.map(x=>x.b).join(", ")):""} · ${m.balance} after</small></span><span class="mv-q ${m.q<0?"neg":"pos"}">${m.type==="NOT_FOR_RESALE"?"0 ("+m.pieces+" off shelf)":(m.q>0?"+":"")+m.q}</span></div>`}).join("");
  return `<div class="card" style="margin-top:14px"><div class="card-h"><h3>Stock history</h3><span class="note">Every change: stock in, adjustments, sales, returns and exchanges</span></div>${filters}
    ${shown.length?`<div class="mvlist">${rows}</div>${list.length>shown.length?`<div class="row c" style="padding-top:10px"><button class="btn sm" data-act="stockmore">Show more (${list.length-shown.length} older)</button></div>`:""}`:`<p class="muted">No stock changes${F.pid||F.type?" for this choice":" yet"}.</p>`}</div>`;
}
