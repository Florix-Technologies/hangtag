// Products → Import: download the template (CSV or Excel), fill it in, choose it; every row is checked and shown (problems
// in red); Import works only when every row is right — never part of a file. store.prodImport = { fileName, rows (the
// file's cells), check (validateImport), err, busy }
import { store } from '../../../shared/state/store.js';
import { IMPORT_COLUMNS, importTemplateRows } from '../../../domain/catalog/product-import.js';
import { checkImportRows, importProducts } from '../use-cases/import-products.js';
import { renderSync } from '../../sync/components/sync-status.js';
import { flushSbQueue } from '../../sync/services/outbox.js';
import { refuse } from '../../shop/services/access.js';
import { use } from '../../../shared/di/services.js';
import { closeModal } from '../../../shared/components/modal.js';
import { toast } from '../../../shared/components/toast.js';
import { ICON } from '../../../shared/constants/icons.js';
import { $, esc } from '../../../shared/dom.js';
import { csvText, parseCsv } from '../../../shared/utils/csv.js';
import { xlsxBytes } from '../../../shared/utils/xlsx.js';
import { readXlsx } from '../../../shared/utils/xlsx-read.js';
import { logger } from '../../../shared/logging/logger.js';
import { renderAll } from '../../../shared/ui/render.js';

const SHOW_ROWS=500;
const XLSX_TYPE="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
export function openProductImport(){
  if(refuse("manage_products","import products")) return;
  store.prodImport={fileName:"",rows:null,check:null,err:"",busy:false};
  renderProductImport();
}
const HELP=[["Column","What to put"],["Name","Required. Rows with the same name (and option columns) are one product's variants."],["Category, Brand, Description","Optional."],
  ["Option 1-3 name / value","E.g. Colour / Black, Size / M. Every row of a product names the same options; each combination once."],["SKU, Barcode","Optional. Unique in the file and in your shop; 8, 12 or 13 digit barcodes must be valid EAN / UPC."],
  ["Price","Required. Whole rupees. Cost: optional, whole rupees."],["GST %","0-100, e.g. 5, 12, 18. HSN: 4, 6 or 8 digits."],["Opening stock","Pieces in hand now (kg, litre, metre may have decimals). Unit: pcs, box, pack, dozen, kg, g, l, ml or m."],
  ["Low stock alert","Optional: warn when this product has this many or fewer left."]];
export async function downloadImportTemplate(kind){
  const rows=importTemplateRows(), files=use("files");
  if(kind==="xlsx") await files.saveFile("products-template.xlsx",xlsxBytes([{name:"Products",rows},{name:"Help",rows:HELP}]),XLSX_TYPE);
  else await files.saveFile("products-template.csv","﻿"+csvText(rows),"text/csv");
}
/* A chosen file → its rows (CSV, or the first sheet of an Excel workbook with something in it) */
export async function readImportFile(file){
  const name=String(file&&file.name||"").toLowerCase();
  if(/\.xlsx$/.test(name)||file.type===XLSX_TYPE){
    const sheets=await readXlsx(new Uint8Array(await file.arrayBuffer()));
    const s=sheets.find(x=>/product/i.test(x.name)&&x.rows.some(r=>r.length))||sheets.find(x=>x.rows.some(r=>r.some(c=>String(c).trim())));
    return s?s.rows:[];
  }
  if(/\.xls$/.test(name)) throw new Error("Old .xls files can't be read. Save it as .xlsx or CSV and choose that.");
  return parseCsv(await file.text());
}
export async function chooseImportFile(file){
  const s=store.prodImport; if(!s||!file) return;
  s.busy=true; s.err=""; s.fileName=file.name||"file"; renderProductImport();
  try{
    if(file.size>5*1024*1024) throw new Error("That file is over 5 MB. Split it into smaller files.");
    const rows=await readImportFile(file);
    const check=checkImportRows(rows);
    if(check.error){ s.err=check.error; s.rows=null; s.check=null; }
    else{ s.rows=rows; s.check=check; }
  }catch(e){ logger.warn("Import file not read:",e); s.err=e&&e.message||"That file couldn't be read."; s.rows=null; s.check=null; }
  s.busy=false; renderProductImport();
}
function previewHTML(c){
  const opt=x=>x.opts.map(o=>o.n+": "+o.v).join(", ");
  const rows=c.rows.slice().sort((a,b)=>(b.errors.length>0)-(a.errors.length>0)||a.line-b.line).slice(0,SHOW_ROWS).map(x=>`<tr class="${x.errors.length?"bad":""}"><td class="num">${x.line}</td><td><b>${esc(x.name||"—")}</b>${x.opts.length?`<small>${esc(opt(x))}</small>`:""}</td><td>${esc([x.sku,x.bc].filter(Boolean).join(" · "))}</td><td class="num">${x.price==null?"":esc(x.price)}</td><td class="num">${esc(x.qty||"")}</td>
    <td>${x.errors.length?`<ul class="im-errs">${x.errors.map(e=>`<li>${esc(e)}</li>`).join("")}</ul>`:`<span class="im-ok">${ICON.ok}Ready</span>`}</td></tr>`).join("");
  return `<div class="im-sum ${c.ok?"ok":"bad"}">${c.ok?`${ICON.ok}<b>Every row is right.</b>`:`${ICON.warn||""}<b>${c.errorCount} row${c.errorCount===1?" needs":"s need"} fixing</b> — fix ${c.errorCount===1?"it":"them"} in the file and choose it again. Nothing is imported until every row is right.`}
    <span>${c.summary.products} product${c.summary.products===1?"":"s"} · ${c.summary.variants} variant${c.summary.variants===1?"":"s"} · ${c.summary.pieces} pcs opening stock</span></div>
    ${c.unknown&&c.unknown.length?`<p class="note">Columns not used: ${esc(c.unknown.join(", "))}</p>`:""}
    <div class="tw im-tw"><table class="pu-lines ro im"><thead><tr><th class="num">Row</th><th>Product</th><th>SKU · Barcode</th><th class="num">Price</th><th class="num">Stock</th><th>Check</th></tr></thead><tbody>${rows}</tbody></table></div>
    ${c.rows.length>SHOW_ROWS?`<p class="note">Showing ${SHOW_ROWS} of ${c.rows.length} rows (rows with problems first).</p>`:""}`;
}
export function renderProductImport(){
  const s=store.prodImport; if(!s){ closeModal(); return; }
  const c=s.check;
  $("#modalHost").innerHTML=`<div class="scrim" data-modal-scrim data-keep><div class="sheet im-sheet" role="dialog" aria-modal="true" aria-label="Import products">
    <div class="sh-head"><div class="sh-t"><h3>Import products</h3><p>Add many products at once from a sheet: one row per product, or one row per variant.</p></div><button class="iconbtn" data-modal-close aria-label="Close">${ICON.x}</button></div>
    <ol class="im-steps"><li>Download the template: <button type="button" class="btn xs" data-imp="tplxlsx">Excel</button> <button type="button" class="btn xs" data-imp="tplcsv">CSV</button> <span class="note">Columns: ${esc(IMPORT_COLUMNS.map(x=>x[1]).join(", "))}</span></li>
      <li>Fill it in (Excel, Google Sheets or LibreOffice), save it as .xlsx or .csv.</li>
      <li><label class="btn sm">Choose file<input type="file" id="impFile" accept=".csv,.xlsx,text/csv,${XLSX_TYPE}" hidden></label> ${s.fileName?`<span class="note">${esc(s.fileName)}</span>`:""}</li></ol>
    ${s.busy?`<p class="muted">Reading the file…</p>`:""}
    ${s.err?`<p class="autherr">${esc(s.err)}</p>`:""}
    ${c&&!s.busy?previewHTML(c):""}
    <div class="sh-foot"><span></span><div class="sh-acts"><button class="btn sm" data-modal-close>Cancel</button><button class="btn sm primary" data-imp="go" id="impGo"${c&&c.ok&&!s.busy?"":" disabled"}>${c&&c.ok?`Import ${c.summary.products} product${c.summary.products===1?"":"s"}`:"Import"}</button></div></div>
  </div></div>`;
}
function runImport(){
  const s=store.prodImport; if(!s||!s.rows) return;
  const r=importProducts(s.rows);
  if(r.error){ s.err=r.error; if(r.check) s.check=r.check; renderProductImport(); return; }
  store.prodImport=null; closeModal(); renderSync(); flushSbQueue(); renderAll();
  toast(`Imported ${r.products} product${r.products===1?"":"s"} (${r.variants} variant${r.variants===1?"":"s"}${r.pieces?`, ${r.pieces} pcs in stock`:""}).`);
}
/* ---------- events (from app/events/dom-events.js) ---------- */
export function importClick(t){
  if(!store.prodImport) return false;
  const b=t.closest("[data-imp]"); if(!b) return false;
  const a=b.dataset.imp;
  if(a==="tplcsv"||a==="tplxlsx") downloadImportTemplate(a==="tplxlsx"?"xlsx":"csv");
  else if(a==="go") runImport();
  else return false;
  return true;
}
export async function importChange(t){
  if(t.id!=="impFile"||!store.prodImport) return false;
  const f=t.files&&t.files[0]; t.value="";
  if(f) await chooseImportFile(f);
  return true;
}
