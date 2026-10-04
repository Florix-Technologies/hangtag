// Products page: list, search, filters.
import { colourCount } from '../../../domain/catalog/options.js';
import { store } from '../../../shared/state/store.js';
import { priceRange, variantsOf } from '../../../domain/catalog/variants.js';
import { levelOf } from '../../inventory/services/stock-levels.js';
import { productLeft, stockOf } from '../../inventory/services/stock.js';
import { colorGroups } from '../components/colour-groups.js';
import { thumb } from '../components/thumb.js';
import { categories, products } from '../services/catalog.js';
import { productText, variantText } from '../../sales/services/search.js';
import { $, esc } from '../../../shared/dom.js';
import { norm } from '../../../shared/utils/text.js';
import { can } from '../../shop/services/access.js';
import { voiceSearchButtonHTML } from '../../search/components/voice-search.js';
import { actionsMenuHTML, statusChip } from '../../../shared/ui/kit.js';
import { hasCap } from '../../shop/services/shop-caps.js';

export function emptyProductsHTML(){return `<div class="empty"><b>No products yet</b><p>Add your products first — then stock and sales show up here.</p><div class="row c"><button class="btn primary" data-act="gosetup">Add products</button></div></div>`}
/* ---------- product list ---------- */

/* A product in the list: tap it for its details; Edit, and the rest under More (sell, stickers, archive) */
export function productCardHTML(p){
  const vs=variantsOf(p),left=productLeft(p),low=vs.filter(v=>levelOf(stockOf(v.id),p)!=="ok").length;
  const nc=colourCount(p), sum=[nc>1?nc+" colours":"",vs.length>1?vs.length+" variants":""].filter(Boolean).join(" · ");
  const chip=p.archived?statusChip("Archived","muted"):left<=0?statusChip("Sold out","bad"):low?statusChip(low===1&&vs.length===1?left+" left":low+" low","warn"):statusChip(left+" in stock","ok");
  const menu=actionsMenuHTML("pc-"+p.id,[p.archived?null:{label:"Sell",icon:"receipt",attrs:`data-sellp="${esc(p.id)}"`},p.archived?null:{label:"Print stickers",icon:"print",attrs:`data-stickers="${esc(p.id)}"`},
    can("manage_products")?(p.archived?{label:"Unarchive",icon:"archive",attrs:`data-unarchive="${esc(p.id)}"`}:{label:"Archive",icon:"archive",attrs:`data-archive="${esc(p.id)}"`}):null],{label:""});
  return `<div class="pcard${p.archived?" arch":""}" data-prodopen="${esc(p.id)}" role="button" tabindex="0" aria-label="${esc(p.name)}">${thumb(p,"sm")}<div class="pc-b"><b>${esc(p.name)}</b><span class="sub">${esc([[p.cat,p.brand].filter(Boolean).join(" · ")||"No category",sum].filter(Boolean).join(" · "))}</span></div>
    <div class="pc-p"><span>${esc(priceRange(p))}</span>${chip}</div><div class="pc-a"><button class="btn sm" data-editp="${esc(p.id)}">Edit</button>${menu}</div></div>`;
}
export function renderProducts(){
  const all=products(),toks=norm(store.prodQuery).split(/\s+/).filter(Boolean),cs=categories();
  const list=all.filter(p=>{
    if(store.prodView==="archived"?!p.archived:p.archived)return false;
    if(store.prodCat&&p.cat!==store.prodCat)return false;
    if(store.prodView==="low"&&!variantsOf(p).some(v=>levelOf(stockOf(v.id),p)!=="ok"))return false;
    return !toks.length||toks.every(t=>productText(p).includes(t)||variantsOf(p,true).some(v=>variantText(p,v).includes(t)));
  });
  let h=`<div class="ptools"><div class="search sellsearch prodsearch"><input id="prodSearch" type="search" placeholder="Search name, SKU or barcode" value="${esc(store.prodQuery)}" autocomplete="off">${voiceSearchButtonHTML('prodSearch')}</div>
    ${cs.length?`<select id="prodCat" class="sel"><option value="">All categories</option>${cs.map(c=>`<option${c===store.prodCat?" selected":""}>${esc(c)}</option>`).join("")}</select>`:""}
    <div class="seg" role="group" aria-label="Show">${[["active","Active"],["low","Low stock"],["archived","Archived"]].map(([k,l])=>`<button data-prodview="${k}" aria-pressed="${store.prodView===k}">${l}</button>`).join("")}</div>
    <button class="btn sm" data-act="prodimport">Import</button>${can('manage_products') ? '<button class="btn sm" data-product-draft>Draft from description</button>' : ''}${can('manage_products') && hasCap('uses_bundles') ? '<button class="btn sm" data-kitnew>New kit</button>' : ''}<button class="btn sm primary" data-act="addp">+ Add product</button></div>`;
  if(store.catalog&&store.catalog.example)h+=`<div class="banner"><span><b>These are example products.</b> Edit them to match your shop — names, colours, sizes, prices and real stock.</span></div>`;
  const groups=colorGroups();
  if(groups.length)h+=`<div class="card grp"><div class="card-h"><div><h3>Combine colours into one product?</h3><p class="note">These look like colours of the same product. Review each one first — nothing changes until you confirm.</p></div></div>${groups.map(g=>`<div class="row grp-row"><span><b>${esc(g.base)}</b> · ${g.items.map(i=>esc(i.color)).join(", ")}</span><button class="btn xs" data-grouprev="${esc(g.base)}">Review</button></div>`).join("")}</div>`;
  if(!all.length)h+=`<div class="empty"><b>No products yet</b><p>Add each product with its colours, sizes and how many pieces you have of each.</p><div class="row c"><button class="btn primary" data-act="addp">Add a product</button><button class="btn" data-act="examples">Load example products</button></div></div>`;
  else if(!list.length)h+=`<p class="muted">${store.prodView==="archived"?"No archived products.":"No products match."}</p>`;
  else h+=`<div class="plist2 olist">${list.map(productCardHTML).join("")}</div>`;
  const host=$("#prodBody"),a=document.activeElement,keep=a&&a.id==="prodSearch"?a.selectionStart:null;
  host.innerHTML=h;
  if(keep!=null){const i=$("#prodSearch");i.focus();i.setSelectionRange(keep,keep)}
  $("#saveBar").hidden=true;
}
