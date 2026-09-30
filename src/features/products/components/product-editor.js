// Product editor dialog: details, HSN/GST, optional options (Colour, Size, Storage …) with every combination as a variant,
// and per variant: stock, SKU, barcode/QR code, price and cost. The fields follow what the shop uses (Settings →
// Capabilities, domain/shop/capabilities.js productFieldsFor): options and variants with Product variants (a product that
// already has them keeps showing them), how pieces are tracked (none / serial / batch) with serial or batch tracking,
// a note on expiry dates with expiry tracking and on selling by weight with weight-based products.
import { store } from '../../../shared/state/store.js';
import { szRank } from '../../../domain/catalog/sizes.js';
import { variantsOf } from '../../../domain/catalog/variants.js';
import { OPTION_LIMITS, OPTION_SUGGESTIONS, addOption, addValues, affectedBy, editorCombos, editorState, isColourOption, isSizeOption,
  removeOption, removeValue, removedCells, renameOption, renameValue } from '../../../domain/catalog/options.js';
import { generateEan13, symbologyFor } from '../../../domain/catalog/barcode.js';
import { stockOf } from '../../inventory/services/stock.js';
import { thumb } from './thumb.js';
import { openStickers } from './stickers.js';
import { saveProduct } from '../use-cases/save-product.js';
import { categories, prod, products } from '../services/catalog.js';
import { hasHistory } from '../../inventory/services/ledger.js';
import { renderSync } from '../../sync/components/sync-status.js';
import { flushSbQueue } from '../../sync/services/outbox.js';
import { closeModal } from '../../../shared/components/modal.js';
import { toast } from '../../../shared/components/toast.js';
import { ICON } from '../../../shared/constants/icons.js';
import { $, $$, esc } from '../../../shared/dom.js';
import { use } from '../../../shared/di/services.js';
import { renderAll } from '../../../shared/ui/render.js';
import { COLORS, okColor, swatchOf } from '../../../shared/utils/colors.js';
import { uid } from '../../../shared/utils/ids.js';
import { refuse } from '../../shop/services/access.js';
import { productFieldsFor, trackingChoiceOf, trackingChoices, trackingFromChoice } from '../../../domain/shop/capabilities.js';
import { shopCaps } from '../../shop/services/shop-caps.js';

import { UNITS, decimalsOf, unitId, unitOf } from '../../../domain/catalog/units.js';

/* ---------- product editor ----------
   store.editor = { isNew, id, name, cat, brand, desc, price, cost, color, img, archived, hsn, gst, unit (what it is sold by: pcs, kg…), tracking (none|serial|batch|expiry: batch with expiry dates),
                    hasOpts, opts, cells, codesOn, code, sel:{ [cellKey]: true } (rows ticked for stickers), addName, err }
   opts/cells follow domain/catalog/options.js (editorState). A simple product has no options and one cell (key ""). */

export const SIZE_PRESETS=[["S–XXL",["S","M","L","XL","XXL"]],["XS–XL",["XS","S","M","L","XL"]],["28–36",["28","30","32","34","36"]],["Free size",["Free size"]]];
export function openEditor(pid){
  if(refuse("manage_products","add or edit products"))return;
  const p=pid?prod(pid):null;
  if(pid&&!p)return;
  const st=editorState(p,stockOf);
  const e={isNew:!p,id:p?p.id:"p"+uid(),name:p?p.name:"",cat:p?p.cat||"":"",brand:p?p.brand||"":"",desc:p?p.desc||"":"",price:p?String(p.price):"",cost:p&&p.cost!=null?String(p.cost):"",
    color:p?okColor(p.color):COLORS[products().length%COLORS.length],img:undefined,archived:p?!!p.archived:false,hsn:p?p.hsn||"":"",gst:p&&p.gst!=null?String(p.gst):"",unit:unitId(p&&p.unit),
    hasOpts:!!(p&&p.opts&&p.opts.length),opts:st.opts,cells:st.cells,codesOn:!!(p&&p.code),code:p&&p.code?p.code:"barcode",sel:{},addName:"",err:"",
    tracking:trackingChoiceOf(p)};
  store.editor=e;renderEditor();
  const n=$("#edName");if(n&&e.isNew)n.focus();
}
/* The current combinations [{ o, key, cell }] (one blank cell per new combination is added to the editor) */
export const edCombos=()=>editorCombos(store.editor);
const cellByKey=k=>store.editor.cells[k];
const pieces=()=>edCombos().reduce((a,x)=>a+Math.max(0,Math.round(+x.cell.stock||0)),0);

/* Tracked by serial number or batch: its stock only moves with serials / batches (Purchases, Stock in, bills) */
const tracked=e=>trackingFromChoice(e.tracking).tracking!=="none";
/* ---------- rendering ---------- */
function codePreview(code,type){
  if(!code)return "";
  try{return type==="qr"?use("qrCodeService").render(code,{unit:"px",size:40,margin:1}):use("barcodeService").render(code,{unit:"px",module:1,height:30,fontSize:8,quiet:2})}
  catch{return `<span class="codebad">Can't print</span>`}
}
function optionHTML(op,i){
  const size=isSizeOption(op.n),colour=isColourOption(op.n);
  return `<div class="optbox" data-opt="${i}">
    <div class="opthead"><label class="f"><span class="lab">Option ${i+1}</span><input data-optname="${i}" value="${esc(op.n)}" maxlength="${OPTION_LIMITS.nameLen}" list="optNames" autocomplete="off" aria-label="Option ${i+1} name"></label>
      <button type="button" class="link xs danger" data-optrm="${i}">Remove option</button></div>
    <div class="chips">${op.v.map((x,j)=>`<span class="chip">${colour?`<i style="background:${swatchOf(x)}"></i>`:""}<button type="button" class="chipname" data-valren="${i}:${j}" title="Rename ${esc(x)}">${esc(x)}</button><button type="button" data-valrm="${i}:${j}" aria-label="Remove ${esc(x)}">×</button></span>`).join("")}
      <span class="chipadd"><input data-valadd="${i}" placeholder="+ Add ${esc((op.n||"value").toLowerCase())}" maxlength="${OPTION_LIMITS.valueLen}" autocomplete="off" aria-label="Add a value to ${esc(op.n)}"></span></div>
    ${size?`<div class="presets"><span class="note">Quick sizes:</span>${SIZE_PRESETS.map(([l],k)=>`<button type="button" class="btn xs" data-preset="${i}:${k}">${esc(l)}</button>`).join("")}</div>`:""}
  </div>`;
}
function rowHTML(x,e){
  const c=x.cell,k=esc(x.key),lab=x.o.join(" / ")||"One size",inherit=f=>esc(e[f]||"");
  return `<tr data-row="${k}"${c.active===false?' class="off"':""}>
    <td class="ck"><input type="checkbox" data-edsel="${k}"${e.sel[x.key]?" checked":""} aria-label="Select ${esc(lab)} for stickers"></td>
    <th>${esc(lab)}${c.exists?"":` <small class="new">new</small>`}</th>
    <td class="ck"><input type="checkbox" data-edf="active" data-k="${k}"${c.active!==false?" checked":""} aria-label="${esc(lab)} on sale"></td>
    <td><input type="number" inputmode="${decimalsOf(e.unit)?"decimal":"numeric"}" min="0" step="${decimalsOf(e.unit)?"any":"1"}" data-edf="stock" data-k="${k}" value="${esc(c.stock)}" placeholder="0" aria-label="Stock ${esc(lab)}"${tracked(e)?" disabled":""}></td>
    <td><input data-edf="sku" data-k="${k}" value="${esc(c.sku)}" maxlength="40" placeholder="—" aria-label="SKU ${esc(lab)}"></td>
    ${e.codesOn?`<td class="codecell"><div class="coderow"><input data-edf="bc" data-k="${k}" value="${esc(c.bc)}" maxlength="64" placeholder="Scan or type" aria-label="${e.code==="qr"?"QR code":"Barcode"} ${esc(lab)}"><button type="button" class="btn xs" data-edgen="${k}">Generate</button></div><div class="codeprev" data-prev="${k}">${codePreview(c.bc,e.code)}</div></td>`:""}
    <td><input type="number" inputmode="numeric" min="0" data-edf="price" data-k="${k}" value="${esc(c.price)}" placeholder="${inherit("price")}" aria-label="Price ${esc(lab)}"></td>
    <td><input type="number" inputmode="numeric" min="0" data-edf="cost" data-k="${k}" value="${esc(c.cost)}" placeholder="${inherit("cost")}" aria-label="Cost ${esc(lab)}"></td>
  </tr>`;
}
export function renderEditor(){
  const e=store.editor;if(!e)return;
  const src=e.img!==undefined?e.img:store.imgs[e.id], cats=categories();
  const combos=edCombos(), simple=!e.hasOpts, one=combos[0], removed=removedCells(e).length;
  const codeName=e.code==="qr"?"QR code":"Barcode";
  const soldAny=!e.isNew&&variantsOf(prod(e.id),true).some(v=>hasHistory(v.id));
  const nSel=combos.filter(x=>e.sel[x.key]).length;
  const fx=productFieldsFor(shopCaps(),{hasOpts:e.hasOpts,...trackingFromChoice(e.tracking)});   // the fields this shop uses
  const stockNote=e.isNew?"":`<p class="note">Changing a stock number here records a stock adjustment, so history is kept. For new deliveries use Stock in on the Stock page.</p>`;
  const trackHTML=fx.tracking||fx.expiry||fx.weight?`<div class="edsec edcap" data-edcap><h4>Stock tracking</h4>
      ${fx.tracking?`<div class="pgrid"><label class="f"><span class="lab">Track stock by</span><select data-ed="tracking" id="edTracking">${trackingChoices(fx).map(m=>`<option value="${m.key}"${m.key===e.tracking?" selected":""}>${esc(m.label)}</option>`).join("")}</select><span class="fhint">Serial: each piece has its own serial or IMEI number. Batch: stock kept by batch or lot number${fx.expiry?", with its expiry date if you choose it":""}.</span></label></div>`:""}
      ${fx.expiry?`<p class="capnote" data-capnote="expiry">Expiry dates are kept with each batch: choose “Batch with expiry date” for a product that expires.</p>`:""}
      ${tracked(e)?`<p class="capnote" data-capnote="tracked">Stock of this product comes in through Purchases or Stock in, with its ${trackingFromChoice(e.tracking).tracking==="serial"?"serial numbers":"batch number"}, and leaves on bills; the stock boxes here are read-only.</p>`:""}
      ${fx.weight?`<p class="capnote" data-capnote="weight">Sold loose by weight or volume? Set the price for one kg (or litre) and sell any amount, typed in or read from the weighing scale. Packed items with a fixed weight are sold by the piece.</p>`:""}
    </div>`:"";
  const simpleHTML=simple&&one?`<div class="pgrid">
      <label class="f"><span class="lab">SKU</span><input data-edf="sku" data-k="${esc(one.key)}" value="${esc(one.cell.sku)}" maxlength="40" placeholder="Optional" autocomplete="off"></label>
      <label class="f"><span class="lab">${unitOf(e.unit).id==="pcs"?"Pieces in stock now":"In stock now ("+esc(unitOf(e.unit).sym)+")"}</span><input type="number" inputmode="${decimalsOf(e.unit)?"decimal":"numeric"}" min="0" step="${decimalsOf(e.unit)?"any":"1"}" data-edf="stock" data-k="${esc(one.key)}" value="${esc(one.cell.stock)}" placeholder="0"${tracked(e)?" disabled":""}></label>
      ${e.codesOn?`<label class="f full"><span class="lab">${codeName}</span><span class="coderow"><input data-edf="bc" data-k="${esc(one.key)}" value="${esc(one.cell.bc)}" maxlength="64" placeholder="Scan or type an existing code, or generate one" autocomplete="off"><button type="button" class="btn xs" data-edgen="${esc(one.key)}">Generate</button></span><span class="codeprev" data-prev="${esc(one.key)}">${codePreview(one.cell.bc,e.code)}</span></label>`:""}
    </div>`:"";
  const tableHTML=!simple?(e.opts.some(op=>op.v.length)?`<div class="tw vtab"><table class="vdet"><thead><tr>
      <th class="ck"><input type="checkbox" data-edselall${nSel&&nSel===combos.length?" checked":""} aria-label="Select all for stickers"></th><th>Variant</th><th>On sale</th><th>Stock</th><th>SKU</th>${e.codesOn?`<th>${codeName}</th>`:""}<th>Price ₹</th><th>Cost ₹</th></tr></thead>
      <tbody>${combos.map(x=>rowHTML(x,e)).join("")}</tbody></table></div>
    <div class="edsum"><span><b>${combos.length}</b> variant${combos.length===1?"":"s"} · <b>${pieces()}</b> piece${pieces()===1?"":"s"}</span>
      <button type="button" class="link xs" data-edact="fillstock">Set stock for all…</button><button type="button" class="link xs" data-edact="fillprice">Set price for all…</button><button type="button" class="link xs" data-edact="fillcost">Set cost for all…</button><button type="button" class="link xs" data-edact="edsku">Fill empty SKUs</button>${e.codesOn?`<button type="button" class="link xs" data-edact="gencodes">Generate missing codes</button>`:""}</div>
    ${removed?`<p class="note">${removed} earlier variant${removed===1?" is":"s are"} no longer a combination. ${removed===1?"It is":"They are"} kept (hidden from selling) if ${removed===1?"it has":"they have"} stock history or sales, otherwise deleted when you save.</p>`:""}`
    :`<p class="note">Add values to an option to create the variants.</p>`):"";
  const printBtns=e.isNew&&!e.name?"":simple?`<button type="button" class="btn sm" data-edact="print1">${ICON.print||""}Print sticker</button>`
    :`<button type="button" class="btn sm" data-edact="printsel"${nSel?"":" disabled"}>Print selected${nSel?` (${nSel})`:""}</button><button type="button" class="btn sm" data-edact="printall">Print all variants</button>`;
  const openSheet=$("#modalHost [data-editor] .sheet.editor"),scrollTop=openSheet?openSheet.scrollTop:0,tab=openSheet&&openSheet.querySelector(".vtab"),tabTop=tab?tab.scrollTop:0;
  const html=`<div class="scrim" data-modal-scrim data-editor><div class="sheet editor" role="dialog" aria-modal="true" aria-labelledby="edTitle">
    <div class="sh-head"><div class="sh-t"><h3 id="edTitle">${e.isNew?"Add product":"Edit product"}</h3><p>${e.isNew?(fx.variants?"Basic details first. Tick “multiple options” for sizes, colours, storage and so on.":"Basic details first."):esc(e.name)}</p></div><button class="iconbtn" data-edclose aria-label="Close">${ICON.x}</button></div>
    <form id="edForm" novalidate>
    <div class="edsec"><h4>Basic information</h4>
      <div class="edtop"><div class="pc-photo">${thumb({id:e.id,name:e.name||"New",color:e.color},"lg",src||null)}<label class="btn xs" for="edPhoto">${ICON.cam}${src?"Change":"Add photo"}</label><input id="edPhoto" class="sr" type="file" accept="image/*" data-edphoto>${src?`<button type="button" class="link xs danger" data-edact="edrmphoto">Remove photo</button>`:""}</div>
      <div class="pgrid grow">
        <label class="f full"><span class="lab">Product name<span class="req">*</span></span><input id="edName" data-ed="name" value="${esc(e.name)}" maxlength="80" autocomplete="off" placeholder="e.g. Oversized Tee"></label>
        <label class="f"><span class="lab">Category</span><input data-ed="cat" value="${esc(e.cat)}" list="catList" maxlength="40" autocomplete="off" placeholder="e.g. T-shirts"><datalist id="catList">${cats.map(c=>`<option value="${esc(c)}">`).join("")}</datalist></label>
        <label class="f"><span class="lab">Brand</span><input data-ed="brand" value="${esc(e.brand)}" maxlength="40" autocomplete="off" placeholder="Optional"></label>
        <label class="f"><span class="lab">Selling price ₹<span class="req">*</span></span><input data-ed="price" type="number" inputmode="numeric" min="0" value="${esc(e.price)}"></label>
        <label class="f"><span class="lab">Cost price ₹</span><input data-ed="cost" type="number" inputmode="numeric" min="0" value="${esc(e.cost)}" placeholder="For gross profit"></label>
        <label class="f"><span class="lab">HSN code</span><input data-ed="hsn" value="${esc(e.hsn)}" inputmode="numeric" maxlength="8" autocomplete="off" placeholder="4, 6 or 8 digits"></label>
        <label class="f"><span class="lab">GST %</span><input data-ed="gst" type="number" inputmode="decimal" min="0" max="100" step="0.01" value="${esc(e.gst)}" placeholder="e.g. 5"></label>
        <label class="f"><span class="lab">Sold by</span><select data-ed="unit" id="edUnit">${UNITS.map(u=>`<option value="${u.id}"${unitId(e.unit)===u.id?" selected":""}>${esc(u.label)}${u.dp?` (up to ${u.dp} decimals)`:""}</option>`).join("")}</select><span class="fhint">Kg and litres are weighed on the bill; prices are per ${esc(unitOf(e.unit).id==="pcs"?"piece":unitOf(e.unit).sym)}</span></label>
      </div></div>
      <label class="f"><span class="lab">Description</span><textarea data-ed="desc" rows="2" maxlength="300" placeholder="Optional">${esc(e.desc)}</textarea></label>
      <div class="f"><span>Tile colour <span class="hintx">· shown when there's no photo</span></span><div class="colors">${COLORS.map(cc=>`<button type="button" data-tilecolor="${cc}" aria-label="Tile colour ${cc}" aria-pressed="${cc===e.color}" style="background:${cc}"></button>`).join("")}</div></div>
    </div>
    <div class="edsec"><h4>Barcode / QR code</h4>
      <label class="chk"><input type="checkbox" data-edtoggle="codesOn"${e.codesOn?" checked":""}> Enable barcode / QR code</label>
      ${e.codesOn?`<div class="codetype" role="radiogroup" aria-label="Code type"><span class="lab">Code type:</span><label class="chk"><input type="radio" name="edCode" value="barcode" data-edcode${e.code!=="qr"?" checked":""}> Barcode <small>(EAN-13 for new codes)</small></label><label class="chk"><input type="radio" name="edCode" value="qr" data-edcode${e.code==="qr"?" checked":""}> QR code</label></div>
        <p class="note">Enter a code that's already on the product, or tap Generate. A code belongs to one ${simple?"product":"variant"} and scanning it finds exactly that one.</p>`:""}
      ${simpleHTML}
      ${fx.variants?"":stockNote}
    </div>
    ${fx.variants?`<div class="edsec"><h4>Options and variants</h4>
      <label class="chk"><input type="checkbox" data-edtoggle="hasOpts"${e.hasOpts?" checked":""}> This product has multiple options / variants</label>
      ${e.hasOpts?`${e.opts.map(optionHTML).join("")}
        ${e.opts.length<OPTION_LIMITS.maxOptions?`<div class="optadd"><input id="optAdd" list="optNames" value="${esc(e.addName)}" maxlength="${OPTION_LIMITS.nameLen}" placeholder="Option name, e.g. Size" autocomplete="off" aria-label="New option name"><button type="button" class="btn xs" data-edact="addopt">+ Add option</button>
          <span class="optsugg">${OPTION_SUGGESTIONS.filter(n=>!e.opts.some(op=>op.n.toLowerCase()===n.toLowerCase())).slice(0,8).map(n=>`<button type="button" class="btn xs ghost" data-optsugg="${esc(n)}">${esc(n)}</button>`).join("")}</span></div>`:""}
        <datalist id="optNames">${OPTION_SUGGESTIONS.map(n=>`<option value="${esc(n)}">`).join("")}</datalist>
        ${tableHTML}`:`<p class="note">Sold as one product. Tick the box for sizes, colours, storage, weight and so on — every combination becomes a variant with its own stock, SKU, code and price.</p>`}
      ${stockNote}
    </div>`:""}
    ${trackHTML}
    <p id="edErr" class="autherr"${e.err?"":" hidden"}>${esc(e.err)}</p>
    </form>
    <div class="sh-foot edfoot">${e.isNew?"":e.archived?`<button class="btn sm" data-unarchive="${esc(e.id)}">Unarchive</button>`:`<button class="btn sm" data-archive="${esc(e.id)}">Archive</button>`}${!e.isNew&&!soldAny?`<button class="link xs danger" data-delp="${esc(e.id)}">Delete</button>`:""}
      <span class="edprint">${printBtns}</span>
      <div class="sh-acts"><button class="btn sm" data-edclose>Cancel</button><button class="btn sm primary" data-act="edsave">${e.isNew?"Add product":"Save changes"}</button></div></div>
  </div></div>`;
  // already open: swap the contents only (no fade again; the dialog and the variants table keep their scroll position)
  if(openSheet){const t=document.createElement("div");t.innerHTML=html;openSheet.innerHTML=t.querySelector(".sheet").innerHTML;openSheet.scrollTop=scrollTop;const v=openSheet.querySelector(".vtab");if(v)v.scrollTop=tabTop}
  else $("#modalHost").innerHTML=html;
}
/* Re-render without losing the focused field */
export function edFocusKeep(fn){
  const a=document.activeElement,id=a&&a.id,dk=a&&a.dataset?(a.dataset.k&&a.dataset.edf?a.dataset.edf+"|"+a.dataset.k:a.dataset.valadd!=null?"va|"+a.dataset.valadd:null):null;
  fn();
  if(id){const x=document.getElementById(id);if(x)x.focus()}
  else if(dk){const x=$$("#modalHost input").find(i=>(i.dataset.k&&i.dataset.edf?i.dataset.edf+"|"+i.dataset.k:i.dataset.valadd!=null?"va|"+i.dataset.valadd:null)===dk);if(x)x.focus()}
}

/* ---------- option operations (pure rules in domain/catalog/options.js) ---------- */
function apply(r,focusSel){
  const e=store.editor;
  if(r.error){toast(r.error);return false}
  e.opts=r.opts;e.cells=r.cells;e.err="";renderEditor();
  if(focusSel){const x=$(focusSel);if(x)x.focus()}
  return true;
}
export function edAddOption(name){const e=store.editor;const r=addOption(e,name);if(apply(r,`[data-valadd="${e.opts.length}"]`))e.addName=""}
export function edRenameOption(i,name){apply(renameOption(store.editor,i,name))}
export function edAddValues(i,names){
  const r=addValues(store.editor,i,names);
  if(!r.error&&isSizeOption(r.opts[i].n)){const o=r.opts[i];o.v=o.v.slice().sort((a,b)=>szRank(a)-szRank(b))}
  apply(r,`[data-valadd="${i}"]`);
}
export function edRenameValue(i,j,name){apply(renameValue(store.editor,i,j,name))}
function confirmRemoval(list,what){
  const kept=list.filter(r=>hasHistory(r.cell.id)||stockOf(r.cell.id)>0).length;
  return !kept||confirm(`${what} ${kept} variant${kept===1?" has":"s have"} stock or past sales. ${kept===1?"It":"They"} will be hidden from selling but kept in bills and reports. Remove?`);
}
export function edRemoveValue(i,j){
  const e=store.editor,x=e.opts[i]&&e.opts[i].v[j];if(x==null)return;
  if(!confirmRemoval(affectedBy(e,i,j),`${x}:`))return;
  apply(removeValue(e,i,j));
}
export function edRemoveOption(i){
  const e=store.editor,op=e.opts[i];if(!op)return;
  if(!confirmRemoval(affectedBy(e,i),`Removing ${op.n||"this option"} keeps the ${op.v[0]||"first"} variants.`))return;
  apply(removeOption(e,i));
}
/* Tick "multiple options": the single variant becomes the first combination once the first option gets a value.
   Untick: every option goes (the first combination stays as the one variant). */
export function edToggleOptions(on){
  const e=store.editor;
  if(on){e.hasOpts=true;renderEditor();const x=$("#optAdd");if(x)x.focus();return}
  if(e.opts.length&&edCombos().length>1&&!confirmRemoval(edCombos().slice(1),"Only the first variant will stay."))return renderEditor();
  let st=e;for(let i=e.opts.length-1;i>=0;i--){const r=removeOption(st,i);if(r.error)return toast(r.error);st=r}
  e.opts=st.opts;e.cells=st.cells;e.hasOpts=false;renderEditor();
}

/* ---------- bulk and generated values ---------- */
const CODE=s=>String(s||"").toUpperCase().replace(/[^A-Z0-9]/g,"");
/* "Dress" → DR, "Oversized Tee" → OT, "Black" → BLK, "White" → WHT, "M" → M, "128 GB" → 128GB */
export function productCode(name){const w=String(name||"").trim().split(/\s+/).map(CODE).filter(Boolean);return w.length>1?w.slice(0,3).map(x=>x[0]).join(""):(w[0]||"PR").slice(0,2)}
export function valueCode(v){const s=CODE(v);if(s.length<=3||/\d/.test(s))return s.slice(0,6);const l=s[0]+s.slice(1).replace(/[AEIOU]/g,"");return l.length>=3?l[0]+l[1]+l[l.length-1]:s.slice(0,3)}
function takenSet(kind){
  const e=store.editor,t=new Set();
  products().forEach(p=>{if(p.id===e.id)return;variantsOf(p,true).forEach(v=>{const x=v[kind];if(x)t.add(kind==="sku"?x.toLowerCase():x)})});
  Object.values(e.cells).forEach(c=>{const x=c[kind];if(x)t.add(kind==="sku"?x.toLowerCase():x)});
  return t;
}
export function edGenSkus(){
  const e=store.editor,taken=takenSet("sku"),base=productCode(e.name);
  edCombos().forEach(({o,cell})=>{
    if(cell.sku)return;
    const stem=[base,...o.map(valueCode)].filter(Boolean).join("-");let s=stem,n=2;
    while(taken.has(s.toLowerCase()))s=stem+"-"+(n++);
    cell.sku=s;taken.add(s.toLowerCase());
  });
  edFocusKeep(renderEditor);
}
export function edGenCode(key){
  const cell=cellByKey(key);if(!cell)return;
  cell.bc=generateEan13(takenSet("bc"));
  edFocusKeep(renderEditor);
}
export function edGenCodes(){
  const taken=takenSet("bc");let n=0;
  edCombos().forEach(({cell})=>{if(!cell.bc&&cell.active!==false){cell.bc=generateEan13(taken);taken.add(cell.bc);n++}});
  edFocusKeep(renderEditor);
  toast(n?`${n} code${n===1?"":"s"} generated. Save to keep them.`:"Every variant already has a code.");
}
export function edSetAll(field){
  const label={stock:"Pieces for every variant:",price:"Selling price ₹ for every variant (empty = the product price):",cost:"Cost ₹ for every variant (empty = the product cost):"}[field];
  const v=prompt(label,field==="stock"?"0":"");if(v==null)return;
  const t=v.trim();if(t!==""&&(isNaN(+t)||+t<0))return toast("Enter 0 or more.");
  if(field==="stock"&&t==="")return;
  edCombos().forEach(({cell})=>{if(cell.active!==false)cell[field]=t===""?"":String(Math.round(+t))});
  edFocusKeep(renderEditor);
}
/* A typed code: preview it and warn at once about a mistyped EAN check digit */
export function edCodeTyped(key){
  const cell=cellByKey(key),box=$(`#modalHost [data-prev="${CSS.escape(key)}"]`);
  if(box&&cell)box.innerHTML=codePreview(cell.bc,store.editor.code);
  return cell&&cell.bc?symbologyFor(cell.bc.trim()):null;
}

/* ---------- save ---------- */
export function saveEditor(){
  const e=store.editor, err=m=>{e.err=m;renderEditor();const x=$("#edErr");if(x)x.scrollIntoView({block:"nearest"})};
  const r=saveProduct({draft:e});
  if(r.error){err(r.error);return null}
  store.editor=null;closeModal();renderAll();renderSync();flushSbQueue();
  toast(r.created?`${r.name} added with ${r.activeCount} variant${r.variantCount===1?"":"s"}.`:"Product saved.");
  return r;
}

/* ---------- events (wired in app/events) ---------- */
/* A typed field of one variant row (checkboxes are handled on change) */
export function edFieldInput(t){
  const e=store.editor,cell=e&&e.cells[t.dataset.k],f=t.dataset.edf;
  if(!cell||t.type==="checkbox")return;
  cell[f]=t.value;
  if(f==="stock"){const n=edCombos().length,pcs=pieces(),sum=$("#modalHost .edsum span");if(sum)sum.innerHTML=`<b>${n}</b> variant${n===1?"":"s"} · <b>${pcs}</b> piece${pcs===1?"":"s"}`}
  if(f==="bc")edCodeTyped(t.dataset.k);
}
/* Buttons with data-edact */
export function edAction(act){
  const e=store.editor;if(!e)return;
  switch(act){
    case "addopt":edAddOption(($("#optAdd")||{}).value||e.addName);break;
    case "edsku":edGenSkus();break;
    case "gencodes":edGenCodes();break;
    case "fillstock":edSetAll("stock");break;
    case "fillprice":edSetAll("price");break;
    case "fillcost":edSetAll("cost");break;
    case "edrmphoto":e.img=null;renderEditor();break;
    case "print1":case "printsel":case "printall":{
      // stickers show what is saved, so the codes printed are the ones stored against the variants
      const keys=act==="printsel"?edCombos().filter(x=>e.sel[x.key]).map(x=>x.key):edCombos().filter(x=>x.cell.active!==false).map(x=>x.key);
      const pid=e.id,r=saveEditor();if(!r)return;
      openStickers(pid,keys.map(k=>r.ids[k]).filter(Boolean));
      break;
    }
  }
}
