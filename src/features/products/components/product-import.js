// Products → Import: download the template (Excel or CSV: notes on how to fill it in, then example products), fill it in,
// choose it; every row is checked and shown, problems in red with what to change, and the file can be downloaded again
// with the problems written next to each row. Import works only when every row is right — never part of a file.
// The preview: a list (one line per row) or a grid (one card per product), searched, filtered (All, Needs fixing, Ready,
// Left out) and shown 50 at a time; each row says what it becomes (a new product, a new variant of one, or left out: a
// product the shop has already, which the import never changes); a stock quantity left empty is shown as not given and
// the product added without stock — never counted as 0 silently.
// store.prodImport = { fileName, kind ("csv"|"xlsx"), rows (the sheet's cells), check (validateImport), err, busy, filter,
//   skipExisting (products the shop already has are left out instead of refused), firstDescription (a product whose rows
//   have different descriptions keeps its first row's), view ("list"|"grid"), q (search), page (from 0) }
import { store } from '../../../shared/state/store.js';
import { existingNote, exportProductRows, importHelpRows, importProblemRows, importTemplateColumns, importTemplateNotes, importTemplateRows } from '../../../domain/catalog/product-import.js';
import { attrText, attrTypeLabel } from '../../../domain/catalog/attributes.js';
import { variantsOf } from '../../../domain/catalog/variants.js';
import { addImportFields, checkImportRows, importContext, importProducts } from '../use-cases/import-products.js';
import { products } from '../services/catalog.js';
import { attrById, shopAttrs } from '../services/shop-fields.js';
import { stockOf } from '../../inventory/services/stock.js';
import { can } from '../../shop/services/access.js';
import { renderSync } from '../../sync/components/sync-status.js';
import { flushSbQueue } from '../../sync/services/outbox.js';
import { refuse } from '../../shop/services/access.js';
import { use } from '../../../shared/di/services.js';
import { closeModal } from '../../../shared/components/modal.js';
import { toast } from '../../../shared/components/toast.js';
import { ICON } from '../../../shared/constants/icons.js';
import { $, esc } from '../../../shared/dom.js';
import { csvText, decodeCsvBytes, parseCsv } from '../../../shared/utils/csv.js';
import { xlsxBytes } from '../../../shared/utils/xlsx.js';
import { readXlsx } from '../../../shared/utils/xlsx-read.js';
import { logger } from '../../../shared/logging/logger.js';
import { renderAll } from '../../../shared/ui/render.js';
import { formatMoney } from '../../../shared/formatting/money.js';

const PAGE=50;
const XLSX_TYPE="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const plural=(n,one,many)=>`${n} ${n===1?one:many}`;
export function openProductImport(){
  if(refuse("manage_products","import products")) return;
  store.prodImport={fileName:"",kind:"",rows:null,check:null,err:"",busy:false,filter:"all",skipExisting:false,firstDescription:false,view:"list",q:"",page:0};
  renderProductImport();
}

/* ---------- the template ---------- */
/* The Excel template: the products sheet (notes in grey, column names in bold, wide columns, codes kept as text) and a
   column-by-column help sheet */
function templateWorkbook(){
  const ctx=importContext(), rows=importTemplateRows(ctx), cols=importTemplateColumns(ctx), head=importTemplateNotes(ctx).length;
  const textCols=cols.map(([k],j)=>["sku","bc","hsn"].includes(k)?j:-1).filter(j=>j>=0);
  return xlsxBytes([
    {name:"Products",rows,heads:[head],notes:rows.slice(0,head).map((_,i)=>i),widths:cols.map(([k,h])=>k==="name"||k==="desc"?30:Math.max(10,h.length+2)),textCols},
    {name:"Help",rows:importHelpRows(ctx),widths:[26,10,64,26]},
  ]);
}
export async function downloadImportTemplate(kind){
  const files=use("files");
  if(kind==="xlsx") await files.saveFile("hangtag-products-template.xlsx",templateWorkbook(),XLSX_TYPE);
  else await files.saveFile("hangtag-products-template.csv","﻿"+csvText(importTemplateRows(importContext())),"text/csv");
}
/* The shop's products in the template's columns (its own fields and options included), one row per variant: to edit and
   import into another shop, or keep */
export async function downloadProductExport(kind){
  const rows=exportProductRows(products(),{attrs:shopAttrs(),variantsOf:p=>variantsOf(p),stockOf}), files=use("files"), day=new Date().toISOString().slice(0,10);
  if(kind==="xlsx") await files.saveFile(`hangtag-products-${day}.xlsx`,xlsxBytes([{name:"Products",rows,heads:[0],widths:rows[0].map(h=>Math.max(10,String(h).length+2)),textCols:rows[0].map((h,j)=>/^(SKU|Barcode|HSN code)$/.test(h)?j:-1).filter(j=>j>=0)}]),XLSX_TYPE);
  else await files.saveFile(`hangtag-products-${day}.csv`,"﻿"+csvText(rows),"text/csv");
  return rows.length-1;
}
/* The chosen file given back with a "Problems" column next to each row (the import ignores that column) */
async function downloadProblems(){
  const s=store.prodImport; if(!s||!s.rows||!s.check) return;
  const rows=importProblemRows(s.rows,s.check), base=String(s.fileName||"products").replace(/\.(csv|xlsx)$/i,"");
  const files=use("files");
  if(s.kind==="xlsx"){ const head=rows.findIndex(r=>r.includes("Problems")); await files.saveFile(base+" - problems.xlsx",xlsxBytes([{name:"Products",rows,heads:[Math.max(0,head)]}]),XLSX_TYPE); }
  else await files.saveFile(base+" - problems.csv","﻿"+csvText(rows),"text/csv");
}

/* ---------- reading the file ---------- */
/* A chosen file → { kind, rows } (CSV, or the products sheet of an Excel workbook); blank rows kept so row numbers match */
export async function readImportFile(file){
  const name=String(file&&file.name||"").toLowerCase();
  if(/\.xlsx$/.test(name)||file.type===XLSX_TYPE){
    const sheets=await readXlsx(new Uint8Array(await file.arrayBuffer()));
    const has=x=>x.rows.some(r=>r.some(c=>String(c).trim()));
    const s=sheets.find(x=>/product/i.test(x.name)&&has(x))||sheets.find(x=>!/^help$/i.test(x.name)&&has(x))||sheets.find(has);
    return {kind:"xlsx",rows:s?s.rows:[]};
  }
  if(/\.xls$/.test(name)) throw new Error("Old .xls files can't be read. In Excel, use Save As → Excel Workbook (.xlsx) or CSV, and choose that file.");
  if(/\.(numbers|ods|pdf|docx?|txt)$/.test(name)) throw new Error("Choose a .csv or .xlsx file. In your spreadsheet app, use Save As or Download as CSV or Excel.");
  return {kind:"csv",rows:parseCsv(decodeCsvBytes(new Uint8Array(await file.arrayBuffer())),{keepBlank:true})};
}
const recheck=s=>{ s.check=checkImportRows(s.rows,{skipExisting:s.skipExisting,firstDescription:s.firstDescription}); if(s.check.error){ s.err=s.check.error; s.check=null; } };
export async function chooseImportFile(file){
  const s=store.prodImport; if(!s||!file) return;
  s.busy=true; s.err=""; s.fileName=file.name||"file"; s.filter="all"; s.q=""; s.page=0; renderProductImport();
  try{
    if(file.size>5*1024*1024) throw new Error("That file is over 5 MB. Split it into smaller files.");
    const r=await readImportFile(file);
    s.kind=r.kind; s.rows=r.rows; s.check=null;
    recheck(s);
    if(s.err) s.rows=null;
    else if(s.check.errorCount) s.filter="bad";
  }catch(e){ logger.warn("Import file not read:",e); s.err=e&&e.message||"That file couldn't be read."; s.rows=null; s.check=null; }
  s.busy=false; renderProductImport();
}

/* ---------- the screen ---------- */
const stateOf=x=>x.skip?"skip":x.errors.length?"bad":"ok";
function helpHTML(){
  const [head,...rows]=importHelpRows(importContext());
  return `<details class="im-help"><summary>What goes in each column</summary><div class="tw"><table class="pu-lines ro im-helpt"><thead><tr>${head.map(h=>`<th>${esc(h)}</th>`).join("")}</tr></thead>
    <tbody>${rows.map(r=>`<tr>${r.map((c,i)=>`<td${i===0?' class="im-col"':""}>${esc(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div></details>`;
}
const fileInput=()=>`<input type="file" id="impFile" accept=".csv,.xlsx,text/csv,${XLSX_TYPE}" hidden>`;
function stepsHTML(s){
  // a file is chosen: the steps make room for what it holds
  if(s.check&&!s.busy) return `<div class="im-chosen"><div class="im-chosen-t"><b class="im-file">${esc(s.fileName)}</b><span class="note">Fix any problem in the file and choose it again. Nothing is added until you press Import.</span></div>
    <span class="im-btns"><label class="btn sm">Choose another file${fileInput()}</label><button type="button" class="btn sm ghost" data-imp="tplxlsx">Excel template</button><button type="button" class="btn sm ghost" data-imp="tplcsv">CSV template</button></span></div>`;
  return `<ol class="im-steps">
    <li><b>Download the template</b><span class="note">It explains each column and has example products to copy.</span>
      <span class="im-btns"><button type="button" class="btn sm" data-imp="tplxlsx">Excel template</button><button type="button" class="btn sm" data-imp="tplcsv">CSV template</button></span></li>
    <li><b>Fill it in</b><span class="note">One row per product. A product in several colours or sizes: one row for each, with the same product name. Only Product name and Selling price are required.</span>${helpHTML()}</li>
    <li><b>Choose your file</b><span class="note">Save it as .xlsx or .csv first. Nothing is added until you check it here and press Import.</span>
      <span class="im-btns"><label class="btn sm primary">Choose file${fileInput()}</label>${s.fileName?`<span class="note im-file">${esc(s.fileName)}</span>`:""}</span></li>
  </ol>
  ${products().length?`<p class="note im-export">Your products as a file, in the same columns: <button type="button" class="link xs" data-imp="expxlsx">Export Excel</button> · <button type="button" class="link xs" data-imp="expcsv">Export CSV</button></p>`:""}`;
}
/* What each row becomes: a new product (its first row), a new variant of the new product named on that row, or left out */
function rolesOf(c){
  const role=new Map();
  (c.products||[]).forEach(g=>[...g.rows].sort((a,b)=>a.line-b.line).forEach((x,i)=>role.set(x.line,i?"variant":"new")));
  return role;
}
const roleText=(x,role)=>x.skip==="example"?"Example from the template: not imported":x.skip==="existing"?existingNote(x)
  :role.get(x.line)==="variant"?`New variant of ${x.name}`:"New product";
const STATE_LABEL={ok:"Ready",bad:"Needs fixing",skip:"Left out"};
const money=v=>v==null?"":esc(formatMoney(v));
/* Stock as given in the file: a count, or "not given" (an empty cell: the product is added without stock) */
const stockCell=x=>x.skip?"":x.qtyGiven?esc(x.qty+(x.unit&&x.unit!=="pcs"?" "+x.unit:"")):`<span class="im-noq" title="Not given: added without stock — count it in Stock later">—</span>`;
function rowHTML(x,role){
  const st=stateOf(x), opts=x.opts.map(o=>`<span class="im-opt">${esc(o.n)}: ${esc(o.v)}</span>`).join("")
    // the product's own field values (a value that makes variants is with the options above)
    +Object.entries(x.fv||{}).filter(([id])=>!x.opts.some(o=>o.a===id)).map(([id,v])=>{const a=attrById(id);return a?`<span class="im-opt im-attr">${esc(a.name)}: ${esc(attrText(a,v))}</span>`:""}).join("");
  const notes=(x.notes||[]).map(n=>`<span class="im-note">${esc(n)}</span>`).join("");
  const status=st==="bad"?`<ul class="im-errs">${x.errors.map(e=>`<li>${esc(e)}</li>`).join("")}</ul>`
    :st==="skip"?`<span class="im-skip">${esc(roleText(x,role))}</span>`:`<span class="im-ok">${ICON.ok}Ready</span><span class="im-role">${esc(roleText(x,role))}</span>${notes}`;
  return `<tr class="im-r ${st}"><td class="num" data-l="Row">${x.line}</td><td data-l="Product"><b>${esc(x.name||"—")}</b>${opts?`<span class="im-opts">${opts}</span>`:""}</td>
    <td data-l="SKU · Barcode">${esc([x.sku,x.bc].filter(Boolean).join(" · "))||'<span class="muted">—</span>'}</td><td class="num" data-l="Price">${money(x.price)}</td><td class="num" data-l="Cost">${money(x.cost)}</td>
    <td class="num" data-l="Stock">${stockCell(x)}</td><td data-l="Check">${status}</td></tr>`;
}
/* One card per product (its rows in the current filter and search): what it becomes, its colours and sizes, its stock and
   its problems by row */
function cardHTML(rows,role){
  const x0=rows[0], st=rows.some(x=>stateOf(x)==="bad")?"bad":rows.every(x=>x.skip)?"skip":"ok";
  const vals=new Map(); rows.forEach(x=>x.opts.forEach(o=>{const k=o.n;if(!vals.has(k))vals.set(k,[]);if(!vals.get(k).some(v=>v.toLowerCase()===o.v.toLowerCase()))vals.get(k).push(o.v)}));
  const prices=rows.map(x=>x.price).filter(v=>v!=null), lo=Math.min(...prices), hi=Math.max(...prices);
  const given=rows.filter(x=>!x.skip&&x.qtyGiven), pieces=given.reduce((a,x)=>a+(x.qty||0),0), noQty=rows.filter(x=>!x.skip&&!x.qtyGiven).length;
  const what=x0.skip?roleText(x0,role):rows.some(x=>role.get(x.line)==="new")?`New product${rows.length>1?` · ${plural(rows.length,"variant","variants")}`:""}`:`${plural(rows.length,"new variant","new variants")}`;
  const errs=rows.filter(x=>x.errors.length);
  return `<article class="im-pcard ${st}"><div class="im-pc-h"><b>${esc(x0.name||"—")}</b><span class="im-pill ${st}">${STATE_LABEL[st]}</span></div>
    <p class="im-pc-m">${esc(what)}${prices.length?` · ${lo===hi?money(lo):`${money(lo)}–${money(hi)}`}`:""}${x0.skip?"":` · ${given.length?`${Math.round(pieces*1000)/1000} in stock`:"no stock given"}${given.length&&noQty?`, ${noQty} without a quantity`:""}`}</p>
    ${[...vals].map(([n,vs])=>`<div class="im-pc-v"><span>${esc(n)}</span>${vs.slice(0,24).map(v=>`<i>${esc(v)}</i>`).join("")}${vs.length>24?`<i>+${vs.length-24}</i>`:""}</div>`).join("")}
    ${errs.length?`<ul class="im-errs">${errs.slice(0,3).map(x=>`<li><b>Row ${x.line}:</b> ${esc(x.errors[0])}${x.errors.length>1?` (+${x.errors.length-1} more)`:""}</li>`).join("")}${errs.length>3?`<li>…and ${plural(errs.length-3,"more row","more rows")} — see the list</li>`:""}</ul>`:""}
  </article>`;
}
/* The rows the search finds (every word somewhere in the row: name, codes, category, brand, colours and sizes, row number) */
function searched(rows,q){
  const ws=String(q||"").toLowerCase().split(/\s+/).filter(Boolean); if(!ws.length) return rows;
  return rows.filter(x=>{const hay=[x.name,x.sku,x.bc,x.cat,x.brand,...x.opts.map(o=>o.v),String(x.line)].join(" ").toLowerCase();return ws.every(w=>hay.includes(w))});
}
/* The filter chips, the rows (list) or products (grid) of this page, and the pages */
function browseHTML(s){
  const c=s.check, role=rolesOf(c), found=searched(c.rows,s.q);
  const n={all:found.length,bad:found.filter(x=>stateOf(x)==="bad").length,ok:found.filter(x=>stateOf(x)==="ok").length,skip:found.filter(x=>stateOf(x)==="skip").length};
  const list=found.filter(x=>s.filter==="all"||stateOf(x)===s.filter).sort((a,b)=>a.line-b.line);
  const chips=[["all","All"],["bad","Needs fixing"],["ok","Ready"],["skip","Left out"]].filter(([k])=>k==="all"||n[k]||s.filter===k)
    .map(([k,l])=>`<button type="button" class="chipbtn" data-imp-filter="${k}" aria-pressed="${s.filter===k}">${l} <span class="count">${n[k]}</span></button>`).join("");
  // the grid's unit is a product (its rows together), the list's a row
  const groups=[]; if(s.view==="grid"){ const at=new Map(); list.forEach(x=>{const k=(x.name||"").toLowerCase()+"\u0001"+(x.skip||"");if(!at.has(k)){at.set(k,groups.length);groups.push([])}groups[at.get(k)].push(x)}); }
  const total=s.view==="grid"?groups.length:list.length, pages=Math.max(1,Math.ceil(total/PAGE)), page=Math.min(Math.max(0,s.page||0),pages-1);
  s.page=page;
  const from=total?page*PAGE+1:0, to=Math.min(total,(page+1)*PAGE), unit=s.view==="grid"?"Products":"Rows";
  const body=s.view==="grid"
    ?(groups.slice(page*PAGE,(page+1)*PAGE).map(g=>cardHTML(g,role)).join("")||`<p class="muted">Nothing here${s.q?" for that search":""}.</p>`)
    :`<table class="pu-lines ro im"><thead><tr><th class="num">Row</th><th>Product</th><th>SKU · Barcode</th><th class="num">Price</th><th class="num">Cost</th><th class="num">Stock</th><th>Check</th></tr></thead>
      <tbody>${list.slice(page*PAGE,(page+1)*PAGE).map(x=>rowHTML(x,role)).join("")||`<tr><td colspan="7" class="muted">No rows here${s.q?" for that search":""}.</td></tr>`}</tbody></table>`;
  return `<div class="im-chips" role="group" aria-label="Show">${chips}</div>
    <div class="tw im-tw${s.view==="grid"?" im-grid":""}" id="impResults">${body}</div>
    ${total>PAGE?`<div class="im-pager" role="navigation" aria-label="Pages"><span class="note" id="impRange">${unit} ${from}–${to} of ${total}</span>
      <button type="button" class="btn xs" data-imp-page="prev"${page===0?" disabled":""}>Previous</button><span class="note">Page ${page+1} of ${pages}</span><button type="button" class="btn xs" data-imp-page="next"${page>=pages-1?" disabled":""}>Next</button></div>`
      :`<p class="note" id="impRange">${total?`${unit} ${from}–${to} of ${total}`:""}</p>`}`;
}
function previewHTML(s){
  const c=s.check;
  const box=(v,l,cls="")=>`<div class="im-card ${cls}"><b>${esc(v)}</b><span>${esc(l)}</span></div>`;
  const nothing=!c.errorCount&&!c.summary.products;
  const banner=c.errorCount?`<div class="im-sum bad" role="alert">${ICON.warn}<div><b>${plural(c.errorCount,"row needs","rows need")} fixing.</b> Nothing is imported until every row is right. Fix ${c.errorCount===1?"it":"them"} in your file and choose it again.
      <button type="button" class="btn xs" data-imp="problems">Download the file with the problems written in</button></div></div>`
    :nothing?`<div class="im-sum bad" role="alert">${ICON.warn}<div><b>There is nothing to import.</b> Every row is an example from the template${c.summary.skipped?" or a product your shop already has":""}: add your own products to the file and choose it again.</div></div>`
    :`<div class="im-sum ok" role="status">${ICON.ok}<div><b>Everything looks right.</b> Check the list, then press Import.</div></div>`;
  const notes=[
    c.above?`The column names are on row ${c.headerRow}: ${plural(c.above,"row","rows")} above them (a title or notes) ${c.above===1?"is":"are"} left out.`:"",
    c.summary.examples?`${plural(c.summary.examples,"example row","example rows")} from the template ${c.summary.examples===1?"is":"are"} left out.`:"",
  ].filter(Boolean);
  const existing=c.existing&&c.existing.length?`<label class="im-exist"><input type="checkbox" id="impSkipEx"${s.skipExisting?" checked":""}>
    <span>${plural(c.existing.length,"product is","products are")} already in your shop (${esc(c.existing.slice(0,3).join(", "))}${c.existing.length>3?"…":""}). <b>Leave ${c.existing.length===1?"it":"them"} out and import the rest.</b> Nothing about ${c.existing.length===1?"it":"them"} changes${c.summary.newVariantsOfExisting?` — ${plural(c.summary.newVariantsOfExisting,"row is a new colour or size","rows are new colours or sizes")} of ${c.existing.length===1?"it":"them"}: add ${c.summary.newVariantsOfExisting===1?"it":"them"} to the product in Products`:""}.</span></label>`:"";
  // descriptions written per row (one for each colour and size): the merchant may keep each product's first instead
  const desc=c.summary.descConflicts?`<label class="im-exist"><input type="checkbox" id="impFirstDesc"${s.firstDescription?" checked":""}>
    <span>${plural(c.summary.descConflicts,"row has","rows have")} a description different from ${c.summary.descConflicts===1?"its":"their"} product's first row, and a product has one description. <b>Keep each product's first description</b>; the other rows' are left out.</span></label>`:"";
  // stock left empty: added without stock, and said so (never taken as a count of 0)
  const noQty=c.summary.noQty?`<div class="im-noqty" role="status">${ICON.warn}<div><b>${plural(c.summary.noQty,"row has","rows have")} no stock quantity</b> (shown as —). ${c.summary.noQty===1?"It is":"They are"} added without stock: count ${c.summary.noQty===1?"it":"them"} in Stock when you know. Nothing is assumed.</div></div>`:"";
  return `<div class="im-cards">${box(c.summary.products,c.summary.products===1?"product":"products")}${box(c.summary.variants,c.summary.variants===1?"row (size, colour…)":"rows (sizes, colours…)")}${box(c.summary.pieces,"in stock")}${box(c.errorCount,"to fix",c.errorCount?"bad":"")}</div>
    ${banner}${existing}${desc}${noQty}${unknownHTML(c)}${notes.length?`<p class="note">${notes.map(esc).join(" ")}</p>`:""}
    <div class="im-tools"><input type="search" id="impQ" class="im-q" value="${esc(s.q||"")}" placeholder="Search name, SKU, barcode, colour, size, row…" aria-label="Search the rows" autocomplete="off">
      <div class="im-views" role="group" aria-label="View"><button type="button" class="chipbtn" data-imp-view="list" aria-pressed="${s.view!=="grid"}">List</button><button type="button" class="chipbtn" data-imp-view="grid" aria-pressed="${s.view==="grid"}">Grid</button></div></div>
    <div id="impBrowse">${browseHTML(s)}</div>`;
}
/* Columns of the file the shop has no field for: named, with what their values look like, and one tap to make them fields
   (then the file is read again). A column a built-in feature covers (IMEI, Expiry…) says where that lives instead. */
function unknownHTML(c){
  const cols=c.unknownCols||[]; if(!cols.length) return "";
  const can_=can("manage_products"), addable=cols.filter(x=>!x.why);
  return `<div class="im-unknown" role="status"><b>${cols.length===1?"1 column isn't":`${cols.length} columns aren't`} imported: your shop has no field for ${cols.length===1?"it":"them"}.</b>
    <ul>${cols.map(x=>`<li><b>${esc(x.name)}</b> · ${x.why?esc(x.why):`would be ${esc(attrTypeLabel(x.suggest.type).toLowerCase())}${x.suggest.options?`: ${esc(x.suggest.options.slice(0,6).join(", "))}${x.suggest.options.length>6?"…":""}`:""}`}</li>`).join("")}</ul>
    ${addable.length&&can_?`<button type="button" class="btn xs" data-imp="addfields">Add ${addable.length===1?esc(addable[0].name)+" as a field":"these as fields"} and read the file again</button>`:addable.length?`<span class="note">Someone who manages products can add them as fields.</span>`:""}</div>`;
}
export function renderProductImport(){
  const s=store.prodImport; if(!s){ closeModal(); return; }
  const c=s.check, ready=!!(c&&c.ok&&!s.busy);
  const list=$("#modalHost .im-tw"), top=list?list.scrollTop:0;
  $("#modalHost").innerHTML=`<div class="scrim" data-modal-scrim data-keep><div class="sheet im-sheet" role="dialog" aria-modal="true" aria-labelledby="impT">
    <div class="sh-head"><div class="sh-t"><h3 id="impT">Import products</h3><p>Add many products at once from a spreadsheet.</p></div><button class="iconbtn" data-modal-close aria-label="Close">${ICON.x}</button></div>
    <div class="im-body">${stepsHTML(s)}
    ${s.busy?`<p class="muted" role="status">Reading the file…</p>`:""}
    ${s.err?`<p class="autherr" role="alert">${esc(s.err)}</p>`:""}
    ${c&&!s.busy?previewHTML(s):""}</div>
    <div class="sh-foot"><span class="note">${ready?`${plural(c.summary.products,"product","products")} · ${c.summary.pieces} in stock${c.summary.noQty?` · ${c.summary.noQty} without a quantity`:""}`:""}</span><div class="sh-acts"><button class="btn sm" data-modal-close>Cancel</button><button class="btn sm primary" data-imp="go" id="impGo"${ready?"":" disabled"}>${ready?`Import ${plural(c.summary.products,"product","products")}`:"Import"}</button></div></div>
  </div></div>`;
  const again=$("#modalHost .im-tw"); if(again&&top) again.scrollTop=top;
}
function runImport(){
  const s=store.prodImport; if(!s||!s.rows||s.importing) return;
  s.importing=true;
  const r=importProducts(s.rows,{skipExisting:s.skipExisting,firstDescription:s.firstDescription});
  s.importing=false;
  if(r.error){ s.err=r.error; if(r.check) s.check=r.check; renderProductImport(); return; }
  store.prodImport=null; closeModal(); renderSync(); flushSbQueue(); renderAll();
  toast(`Imported ${plural(r.products,"product","products")} (${plural(r.variants,"variant","variants")}${r.pieces?`, ${r.pieces} in stock`:""}).${r.noQty?` ${plural(r.noQty,"variant has","variants have")} no stock yet: count ${r.noQty===1?"it":"them"} in Stock.`:""}`);
}
/* ---------- events (from app/events/dom-events.js) ---------- */
/* The chips, rows and pages again (the search box above keeps its focus); top: the list back to its first row */
function rebrowse(top){
  const s=store.prodImport, b=$("#modalHost #impBrowse"); if(!s||!s.check||!b) return;
  b.innerHTML=browseHTML(s);
  if(top) b.scrollIntoView({block:"nearest"});
}
export function importClick(t){
  const s=store.prodImport; if(!s) return false;
  const f=t.closest("[data-imp-filter]"); if(f){ s.filter=f.dataset.impFilter; s.page=0; rebrowse(true); return true; }
  const vw=t.closest("[data-imp-view]"); if(vw){ s.view=vw.dataset.impView==="grid"?"grid":"list"; s.page=0; renderProductImport(); return true; }
  const pg=t.closest("[data-imp-page]"); if(pg){ s.page=(s.page||0)+(pg.dataset.impPage==="next"?1:-1); rebrowse(true); return true; }
  const b=t.closest("[data-imp]"); if(!b) return false;
  const a=b.dataset.imp;
  if(a==="tplcsv"||a==="tplxlsx") downloadImportTemplate(a==="tplxlsx"?"xlsx":"csv");
  else if(a==="problems") downloadProblems();
  else if(a==="expcsv"||a==="expxlsx") downloadProductExport(a==="expxlsx"?"xlsx":"csv").then(n=>toast(`Exported ${plural(n,"row","rows")}.`));
  else if(a==="addfields"){
    if(!s.check) return true;
    const r=addImportFields((s.check.unknownCols||[]).filter(x=>!x.why));
    if(r.errors.length) s.err=r.errors.join(" "); else s.err="";
    if(r.added.length){ recheck(s); if(s.check&&s.check.errorCount) s.filter="bad"; else s.filter="all"; renderSync(); flushSbQueue(); toast(`Added ${r.added.join(", ")}.`); }
    renderProductImport();
  }
  else if(a==="go") runImport();
  else return false;
  return true;
}
/* Typing in the search box: the rows found, from the first page (app/events/dom-events.js's input listener) */
export function importInput(t){
  const s=store.prodImport; if(!s||!t||t.id!=="impQ") return false;
  s.q=t.value; s.page=0; rebrowse(false);
  return true;
}
export async function importChange(t){
  const s=store.prodImport; if(!s) return false;
  if(t.id==="impSkipEx"||t.id==="impFirstDesc"){
    if(t.id==="impSkipEx") s.skipExisting=t.checked; else s.firstDescription=t.checked;
    s.err=""; s.page=0;
    if(s.rows){ recheck(s); if(s.filter!=="all"&&s.check&&!s.check.rows.some(x=>stateOf(x)===s.filter)) s.filter="all"; }
    renderProductImport(); return true;
  }
  if(t.id!=="impFile") return false;
  const f=t.files&&t.files[0]; t.value="";
  if(f) await chooseImportFile(f);
  return true;
}
