// Choose a product for stock in / adjust / exchange.
import { store } from '../../../shared/state/store.js';
import { variantsOf } from '../../../domain/catalog/variants.js';
import { openStockOp } from './stock-operation.js';
import { productLeft } from '../services/stock.js';
import { thumb } from '../../products/components/thumb.js';
import { liveProducts } from '../../products/services/catalog.js';
import { openPicker } from '../../sales/components/variant-picker.js';
import { productText, variantText } from '../../sales/services/search.js';
import { closeModal } from '../../../shared/components/modal.js';
import { ICON } from '../../../shared/constants/icons.js';
import { $, esc } from '../../../shared/dom.js';
import { norm } from '../../../shared/utils/text.js';
import { refuse } from '../../shop/services/access.js';

export function openProductChooser(forWhat){
  if(forWhat==="exchange"?refuse("perform_return","exchange items"):refuse("manage_inventory","add or adjust stock"))return;
  store.chooserFor=forWhat; store.chooserQ="";
  renderChooser();
  const i=$("#chooseQ"); if(i) i.focus();
}
export function renderChooser(){
  const toks=norm(store.chooserQ).split(/\s+/).filter(Boolean);
  const list=liveProducts().filter(p=>!toks.length||toks.every(t=>productText(p).includes(t)||variantsOf(p).some(v=>variantText(p,v).includes(t)))).slice(0,40);
  const title=store.chooserFor==="adjust"?"Adjust stock":store.chooserFor==="exchange"?"Exchange for":"Stock in";
  $("#modalHost").innerHTML=`<div class="scrim" data-modal-scrim><div class="sheet custsheet" role="dialog" aria-modal="true" aria-label="${title}">
    <div class="sh-head"><div class="sh-t"><h3>${title}</h3><p>Pick the product.${store.chooserFor==="in"?` Or <button type="button" class="link" data-act="billimport">upload a supplier bill</button> to add many at once.`:""}</p></div><button class="iconbtn" data-modal-close aria-label="Close">${ICON.x}</button></div>
    <div class="search"><input id="chooseQ" type="search" placeholder="Search name, colour, size or SKU" value="${esc(store.chooserQ)}" autocomplete="off"></div>
    <div class="custlist" id="chooseList">${list.length?list.map(p=>`<button class="custpick" data-choose="${esc(p.id)}">${thumb(p,"sm")}<span><b>${esc(p.name)}</b><small>${esc([p.cat,variantsOf(p).length+" variant"+(variantsOf(p).length===1?"":"s"),productLeft(p)+" in hand"].filter(Boolean).join(" · "))}</small></span></button>`).join(""):`<p class="muted">No products match.</p>`}</div>
  </div></div>`;
}
export function chosenProduct(pid){
  const f=store.chooserFor; closeModal();
  if(f==="exchange"){ openPicker(pid,"exchange"); return; }
  openStockOp(f==="adjust"?"adjust":"in",pid);
}
