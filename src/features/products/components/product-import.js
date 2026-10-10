// Products → Import: download the template (Excel or CSV: notes on how to fill it in, then example products), fill it in,
// choose it; every row is checked and shown, problems in red with what to change, and the file can be downloaded again
// with the problems written next to each row. Import works only when every row is right — never part of a file.
// store.prodImport = { fileName, kind ("csv"|"xlsx"), rows (the sheet's cells), check (validateImport), err, busy, filter,
//   skipExisting (products the shop already has are left out instead of refused) }
import { store } from '../../../shared/state/store.js';
import { importHelpRows, importProblemRows, importTemplateColumns, importTemplateNotes, importTemplateRows } from '../../../domain/catalog/product-import.js';
import { checkImportRows, importProducts } from '../use-cases/import-products.js';
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

const SHOW_ROWS=500;
const XLSX_TYPE="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const plural=(n,one,many)=>`${n} ${n===1?one:many}`;
export function openProductImport(){
  if(refuse("manage_products","import products")) return;
  store.prodImport={fileName:"",kind:"",rows:null,check:null,err:"",busy:false,filter:"all",skipExisting:false};
  renderProductImport();
}

/* ---------- the template ---------- */
/* The Excel template: the products sheet (notes in grey, column names in bold, wide columns, codes kept as text) and a
   column-by-column help sheet */
function templateWorkbook(){
  const rows=importTemplateRows(), cols=importTemplateColumns(), head=importTemplateNotes().length;
  const textCols=cols.map(([k],j)=>["sku","bc","hsn"].includes(k)?j:-1).filter(j=>j>=0);
  return xlsxBytes([
    {name:"Products",rows,heads:[head],notes:rows.slice(0,head).map((_,i)=>i),widths:cols.map(([k,h])=>k==="name"||k==="desc"?30:Math.max(10,h.length+2)),textCols},
    {name:"Help",rows:importHelpRows(),widths:[26,10,64,26]},
  ]);
}
export async function downloadImportTemplate(kind){
  const files=use("files");
  if(kind==="xlsx") await files.saveFile("hangtag-products-template.xlsx",templateWorkbook(),XLSX_TYPE);
  else await files.saveFile("hangtag-products-template.csv","﻿"+csvText(importTemplateRows()),"text/csv");
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
const recheck=s=>{ s.check=checkImportRows(s.rows,{skipExisting:s.skipExisting}); if(s.check.error){ s.err=s.check.error; s.check=null; } };
export async function chooseImportFile(file){
  const s=store.prodImport; if(!s||!file) return;
  s.busy=true; s.err=""; s.fileName=file.name||"file"; s.filter="all"; renderProductImport();
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
  const [head,...rows]=importHelpRows();
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
  </ol>`;
}
function rowHTML(x){
  const st=stateOf(x), opts=x.opts.map(o=>`<span class="im-opt">${esc(o.n)}: ${esc(o.v)}</span>`).join("");
  const status=st==="bad"?`<ul class="im-errs">${x.errors.map(e=>`<li>${esc(e)}</li>`).join("")}</ul>`
    :st==="skip"?`<span class="im-skip">${x.skip==="example"?"Example from the template: not imported":"Already in your shop: left out"}</span>`:`<span class="im-ok">${ICON.ok}Ready</span>`;
  const money=v=>v==null?"":esc(formatMoney(v));
  return `<tr class="im-r ${st}"><td class="num" data-l="Row">${x.line}</td><td data-l="Product"><b>${esc(x.name||"—")}</b>${opts?`<span class="im-opts">${opts}</span>`:""}</td>
    <td data-l="SKU · Barcode">${esc([x.sku,x.bc].filter(Boolean).join(" · "))||'<span class="muted">—</span>'}</td><td class="num" data-l="Price">${money(x.price)}</td><td class="num" data-l="Cost">${money(x.cost)}</td>
    <td class="num" data-l="Stock">${x.qty?esc(x.qty+(x.unit&&x.unit!=="pcs"?" "+x.unit:"")):""}</td><td data-l="Check">${status}</td></tr>`;
}
function previewHTML(s){
  const c=s.check, n={all:c.rows.length,bad:c.rows.filter(x=>stateOf(x)==="bad").length,ok:c.rows.filter(x=>stateOf(x)==="ok").length,skip:c.rows.filter(x=>stateOf(x)==="skip").length};
  const list=c.rows.filter(x=>s.filter==="all"||stateOf(x)===s.filter).sort((a,b)=>a.line-b.line);
  const box=(v,l,cls="")=>`<div class="im-card ${cls}"><b>${esc(v)}</b><span>${esc(l)}</span></div>`;
  const nothing=!c.errorCount&&!c.summary.products;
  const banner=c.errorCount?`<div class="im-sum bad" role="alert">${ICON.warn}<div><b>${plural(c.errorCount,"row needs","rows need")} fixing.</b> Nothing is imported until every row is right. Fix ${c.errorCount===1?"it":"them"} in your file and choose it again.
      <button type="button" class="btn xs" data-imp="problems">Download the file with the problems written in</button></div></div>`
    :nothing?`<div class="im-sum bad" role="alert">${ICON.warn}<div><b>There is nothing to import.</b> Every row is an example from the template${c.summary.skipped?" or a product your shop already has":""}: add your own products to the file and choose it again.</div></div>`
    :`<div class="im-sum ok" role="status">${ICON.ok}<div><b>Everything looks right.</b> Check the list, then press Import.</div></div>`;
  const notes=[
    c.summary.examples?`${plural(c.summary.examples,"example row","example rows")} from the template ${c.summary.examples===1?"is":"are"} left out.`:"",
    c.unknown&&c.unknown.length?`Columns not used: ${c.unknown.join(", ")}.`:"",
  ].filter(Boolean);
  const existing=c.existing&&c.existing.length?`<label class="im-exist"><input type="checkbox" id="impSkipEx"${s.skipExisting?" checked":""}>
    <span>${plural(c.existing.length,"product is","products are")} already in your shop (${esc(c.existing.slice(0,3).join(", "))}${c.existing.length>3?"…":""}). <b>Leave ${c.existing.length===1?"it":"them"} out and import the rest.</b> Nothing about ${c.existing.length===1?"it":"them"} changes.</span></label>`:"";
  const chips=[["all","All"],["bad","Needs fixing"],["ok","Ready"],["skip","Left out"]].filter(([k])=>k==="all"||n[k])
    .map(([k,l])=>`<button type="button" class="chipbtn" data-imp-filter="${k}" aria-pressed="${s.filter===k}">${l} <span class="count">${n[k]}</span></button>`).join("");
  return `<div class="im-cards">${box(c.summary.products,c.summary.products===1?"product":"products")}${box(c.summary.variants,c.summary.variants===1?"row (size, colour…)":"rows (sizes, colours…)")}${box(c.summary.pieces,"in stock")}${box(c.errorCount,"to fix",c.errorCount?"bad":"")}</div>
    ${banner}${existing}${notes.length?`<p class="note">${notes.map(esc).join(" ")}</p>`:""}
    <div class="im-chips" role="group" aria-label="Show">${chips}</div>
    <div class="tw im-tw"><table class="pu-lines ro im"><thead><tr><th class="num">Row</th><th>Product</th><th>SKU · Barcode</th><th class="num">Price</th><th class="num">Cost</th><th class="num">Stock</th><th>Check</th></tr></thead>
      <tbody>${list.slice(0,SHOW_ROWS).map(rowHTML).join("")||`<tr><td colspan="7" class="muted">No rows here.</td></tr>`}</tbody></table></div>
    ${list.length>SHOW_ROWS?`<p class="note">Showing the first ${SHOW_ROWS} of ${list.length} rows.</p>`:""}`;
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
    <div class="sh-foot"><span class="note">${ready?`${plural(c.summary.products,"product","products")} · ${c.summary.pieces} in stock`:""}</span><div class="sh-acts"><button class="btn sm" data-modal-close>Cancel</button><button class="btn sm primary" data-imp="go" id="impGo"${ready?"":" disabled"}>${ready?`Import ${plural(c.summary.products,"product","products")}`:"Import"}</button></div></div>
  </div></div>`;
  const again=$("#modalHost .im-tw"); if(again&&top) again.scrollTop=top;
}
function runImport(){
  const s=store.prodImport; if(!s||!s.rows||s.importing) return;
  s.importing=true;
  const r=importProducts(s.rows,{skipExisting:s.skipExisting});
  s.importing=false;
  if(r.error){ s.err=r.error; if(r.check) s.check=r.check; renderProductImport(); return; }
  store.prodImport=null; closeModal(); renderSync(); flushSbQueue(); renderAll();
  toast(`Imported ${plural(r.products,"product","products")} (${plural(r.variants,"variant","variants")}${r.pieces?`, ${r.pieces} in stock`:""}).`);
}
/* ---------- events (from app/events/dom-events.js) ---------- */
export function importClick(t){
  const s=store.prodImport; if(!s) return false;
  const f=t.closest("[data-imp-filter]"); if(f){ s.filter=f.dataset.impFilter; renderProductImport(); return true; }
  const b=t.closest("[data-imp]"); if(!b) return false;
  const a=b.dataset.imp;
  if(a==="tplcsv"||a==="tplxlsx") downloadImportTemplate(a==="tplxlsx"?"xlsx":"csv");
  else if(a==="problems") downloadProblems();
  else if(a==="go") runImport();
  else return false;
  return true;
}
export async function importChange(t){
  const s=store.prodImport; if(!s) return false;
  if(t.id==="impSkipEx"){ s.skipExisting=t.checked; s.err=""; if(s.rows){ recheck(s); if(s.filter!=="all"&&s.check&&!s.check.rows.some(x=>stateOf(x)===s.filter)) s.filter="all"; } renderProductImport(); return true; }
  if(t.id!=="impFile") return false;
  const f=t.files&&t.files[0]; t.value="";
  if(f) await chooseImportFile(f);
  return true;
}
