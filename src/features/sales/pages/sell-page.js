// Sell page: product grid and search hits.
import { colourCount, colVals, legacyCS } from '../../../domain/catalog/options.js';
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
import { emptyStateHTML, sheetHTML } from '../../../shared/ui/kit.js';
import { businessExamples } from '../../../domain/shop/capabilities.js';
import { shopType } from '../../shop/services/shop-caps.js';

/* A product on the Sell grid: photo (or initials on its colour), name, option chips (sizes), price, stock level,
   and a full-width + Add button. Keys 1–0 show only once the keyboard is used. */
export function tileHTML(p,i){
  const left=productLeft(p)-cartQtyP(p.id), st=left<=0?"out":left<=lowAt()?"low":"", q=cartQtyP(p.id);
  const lab=left<=0?"Sold out":left+" left", src=store.imgs[p.id], c=okColor(p.color), vs=variantsOf(p);
  const bg=src?"":` style="background:${c};color:${isLight(c)?"#10131F":"#FFFFFF"}"`;
  const inner=src?`<img src="${esc(src)}" alt="" decoding="async" loading="lazy">`:`<span class="ini">${esc(initials(p.name))}</span>`;
  const nc=colourCount(p), sum=(nc>1?nc+" colours":"")+(nc>1&&vs.length>1?" · ":"")+(vs.length>1?vs.length+" options":"");
  // Size/option chips: up to 3 shown, remainder as +N
  const optVals=colVals(p); // values of the last option (usually Size)
  const CHIP_MAX=3;
  const chipsHTML=optVals.length>1
    ? `<span class="tchips" aria-hidden="true">${optVals.slice(0,CHIP_MAX).map(v=>`<span class="tchip">${esc(v)}</span>`).join("")}${optVals.length>CHIP_MAX?`<span class="tchip more">+${optVals.length-CHIP_MAX}</span>`:""}</span>`
    : "";
  return `<button class="tile${q?" on":""}${st==="out"?" out":""}" data-pid="${esc(p.id)}" aria-label="${esc(p.name)}, ${esc(priceRange(p))}, ${esc(lab)}${q?", "+q+" in bill":""}">` +
    `<span class="ph"${bg}>${inner}${i<10?`<span class="kc" aria-hidden="true">${(i+1)%10}</span>`:""}${q?`<span class="qb${store.justAdded===p.id?" pop":""}" aria-hidden="true">${q}</span>`:""}</span>`+
    `<span class="tb"><span class="tn">${esc(p.name)}</span>${sum?`<span class="tv">${esc(sum)}</span>`:""}<span class="tpr"><span class="tp">${esc(priceRange(p))}</span><span class="tl ${st}">${st?"<i></i>":""}${esc(lab)}</span></span>${chipsHTML}${st==="out"?"":`<span class="tadd-btn" aria-hidden="true">+ Add</span>`}</span>`+
    `</button>`;
}
/* The category chips over the grid (none when the shop has no categories) */
function catChipsHTML(cs){
  if(!cs.length) return "";
  return [["","All"],...cs.map(c=>[c,c])].map(([k,l])=>`<button type="button" class="chipbtn" data-sellcat="${esc(k)}" aria-pressed="${(store.sellCat||"")===k}">${esc(l)}</button>`).join("");
}
export function hitHTML(h){
  const a = availOf(h.v.id), lv = levelOf(a);
  return `<div class="hit-row"><span class="hit-sw" style="background:${swatchOf(legacyCS(h.p.opts,h.v.o).c)}"${legacyCS(h.p.opts,h.v.o).c?"":" hidden"}></span>${thumb(h.p,"sm")}<div class="hit-t"><b>${esc(h.p.name)}</b><span>${esc(vLabel(h.v)||"One size")} · ${inr(vPrice(h.p,h.v))}${h.v.sku?" · "+esc(h.v.sku):""}</span></div><span class="hit-l ${lv}">${a<=0?"Sold out":a+" left"}</span><button class="btn sm" data-addv="${esc(h.v.id)}"${a<=0?" disabled":""}>Add</button></div>`;
}
export function renderGrid(){
  const g=$("#grid"),ban=$("#sellBanner"),hits=$("#sellHits"),all=liveProducts();
  const si=$("#sellSearch"),ph=businessExamples(shopType()).search; if(si&&si.placeholder!==ph) si.placeholder=ph;
  const cs=categories(),chips=$("#sellCats");
  if(store.sellCat&&!cs.includes(store.sellCat)) store.sellCat="";
  if(chips){ const h=catChipsHTML(cs); if(chips._h!==h){chips.innerHTML=h;chips._h=h} chips.hidden=!h; }
  g.className="grid"+(store.prefs.density==="list"?" list":"");
  if(!all.length){
    g.innerHTML="";hits.innerHTML="";
    ban.innerHTML=emptyStateHTML({icon:"box",title:"No products yet",text:"Add what you sell with its price and stock — or start from example products and edit them.",actions:`<button class="btn primary" data-act="gosetup">Add products</button><button class="btn" data-act="examples">Load example products</button>`});
    return;
  }
  ban.innerHTML=sellingBannerHTML()+(store.catalog&&store.catalog.example?`<div class="banner"><span><b>These are example products.</b> Rename them, add photos and set your real stock before the sale.</span><button class="btn sm" data-act="gosetup">Edit products</button></div>`:"");
  const vh=variantHits();
  hits.innerHTML=vh.length?`<div class="hits" aria-label="Matching sizes and colours">${vh.map(hitHTML).join("")}</div>`:"";
  const ps=sellProducts();
  if(!ps.length){g.innerHTML=emptyStateHTML({icon:"search",title:"Nothing matches",text:store.sellQuery?`No product matches “${store.sellQuery}”${store.sellCat?" in "+store.sellCat:""}. Check the spelling, or search by SKU or barcode.`:`No products in ${store.sellCat}.`,cls:"compact"});g._n=0;return}
  patchList(g,ps.map(tileHTML));
  store.justAdded=null;
}

/* A tap on a category chip: true when it was one */
export function sellCatClick(t){
  const c=t.closest("[data-sellcat]"); if(!c) return false;
  store.sellCat=c.dataset.sellcat; renderGrid(); return true;
}
/* The keyboard shortcuts, for whoever wants them (kept out of the way of everyone else) */
export function openKeyboardHelp(){
  const rows=[["/","Search"],["1 – 0","Open product 1 to 10"],["1 – 9","Size in the open product"],["+ / −","Quantity"],["Enter","Add to the bill"],["C · U · K","Pay by cash, UPI, card"],["Esc","Close"]];
  $("#modalHost").innerHTML=sheetHTML({id:"kbdHelp",title:"Keyboard shortcuts",sub:"Barcode scanners work anywhere on Sell.",body:`<dl class="kv kbdkv">${rows.map(([k,v])=>`<dt>${k.split(" ").map(x=>/^[A-Za-z0-9/+−–·]+$/.test(x)&&x!=="·"&&x!=="–"?`<kbd>${esc(x)}</kbd>`:esc(x)).join(" ")}</dt><dd>${esc(v)}</dd>`).join("")}</dl>`});
}

