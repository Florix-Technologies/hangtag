// Sell page: product grid and search hits.
import { colourCount, legacyCS } from '../../../domain/catalog/options.js';
import { store } from '../../../shared/state/store.js';
import { priceRange, vLabel, vPrice, variantsOf } from '../../../domain/catalog/variants.js';
import { levelOf, lowAt } from '../../inventory/services/stock-levels.js';
import { productLeft } from '../../inventory/services/stock.js';
import { thumb } from '../../products/components/thumb.js';
import { categories, liveProducts } from '../../products/services/catalog.js';
import { availOf, cartQtyP } from '../services/cart.js';
import { sellProducts, variantHits } from '../services/search.js';
import { $, esc, patchList } from '../../../shared/dom.js';
import { inr } from '../../../shared/formatting/money.js';
import { isLight, okColor, swatchOf } from '../../../shared/utils/colors.js';
import { initials } from '../../../shared/utils/text.js';
import { sellingBannerHTML } from '../../events/components/events-view.js';

export function tileHTML(p,i){
  const left=productLeft(p)-cartQtyP(p.id), st=left<=0?"out":left<=lowAt()?"low":"", q=cartQtyP(p.id);
  const lab=left<=0?"Sold out":left+" left", src=store.imgs[p.id], c=okColor(p.color), vs=variantsOf(p);
  const bg=src?"":` style="background:${c};color:${isLight(c)?"#10131F":"#FFFFFF"}"`;
  const inner=src?`<img src="${esc(src)}" alt="" decoding="async">`:`<span class="ini">${esc(initials(p.name))}</span>`;
  const nc=colourCount(p), sum=(nc>1?nc+" colours · ":"")+(vs.length>1?vs.length+" options":"");
  return `<button class="tile${q?" on":""}" data-pid="${esc(p.id)}" aria-label="${esc(p.name)}, ${esc(priceRange(p))}, ${esc(lab)}${q?", "+q+" in bill":""}">`+
    `<span class="ph"${bg}>${inner}${i<10?`<span class="kc" aria-hidden="true">${(i+1)%10}</span>`:""}<span class="lf ${st}" aria-hidden="true">${st?"<i></i>":""}${esc(lab)}</span>${q?`<span class="qb${store.justAdded===p.id?" pop":""}" aria-hidden="true">${q}</span>`:""}</span>`+
    `<span class="tb"><span class="tn">${esc(p.name)}</span><span class="tpr"><span class="tp">${esc(priceRange(p))}</span><span class="tl ${st}">${esc(lab)}</span></span>${sum?`<span class="tv">${esc(sum)}</span>`:""}</span></button>`;
}
export function hitHTML(h){
  const a = availOf(h.v.id), lv = levelOf(a);
  return `<div class="hit-row"><span class="hit-sw" style="background:${swatchOf(legacyCS(h.p.opts,h.v.o).c)}"${legacyCS(h.p.opts,h.v.o).c?"":" hidden"}></span>${thumb(h.p,"sm")}<div class="hit-t"><b>${esc(h.p.name)}</b><span>${esc(vLabel(h.v)||"One size")} · ${inr(vPrice(h.p,h.v))}${h.v.sku?" · "+esc(h.v.sku):""}</span></div><span class="hit-l ${lv}">${a<=0?"Sold out":a+" left"}</span><button class="btn sm" data-addv="${esc(h.v.id)}"${a<=0?" disabled":""}>Add</button></div>`;
}
export function renderGrid(){
  const g=$("#grid"),ban=$("#sellBanner"),hits=$("#sellHits"),all=liveProducts();
  const cs=categories(),sel=$("#sellCat");
  if(sel){ const opts=`<option value="">All categories</option>`+cs.map(c=>`<option${c===store.sellCat?" selected":""}>${esc(c)}</option>`).join(""); if(sel._h!==opts){sel.innerHTML=opts;sel._h=opts} sel.hidden=!cs.length; }
  g.className="grid"+(store.prefs.density==="list"?" list":"");
  if(!all.length){
    g.innerHTML="";hits.innerHTML="";
    ban.innerHTML=`<div class="empty"><b>No products yet</b><p>Add products you'll sell, with their colours, sizes and stock — or start with example products.</p><div class="row c"><button class="btn primary" data-act="examples">Load example products</button><button class="btn" data-act="gosetup">Add my own</button></div></div>`;
    return;
  }
  ban.innerHTML=sellingBannerHTML()+(store.catalog&&store.catalog.example?`<div class="banner"><span><b>These are example products.</b> Rename them, add photos and set your real stock before the sale.</span><button class="btn sm" data-act="gosetup">Edit products</button></div>`:"");
  const vh=variantHits();
  hits.innerHTML=vh.length?`<div class="hits" aria-label="Matching sizes and colours">${vh.map(hitHTML).join("")}</div>`:"";
  const ps=sellProducts();
  if(!ps.length){g.innerHTML=`<p class="muted">No products match “${esc(store.sellQuery)}”.</p>`;g._n=0;return}
  patchList(g,ps.map(tileHTML));
  store.justAdded=null;
}
