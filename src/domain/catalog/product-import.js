// Bulk product import (Products → Import): a sheet (CSV or Excel) with one row per product, or one row per variant (rows
// with the same product name are one product; its Colour, Size… columns tell the variants apart). Every row is checked
// first and the import happens only when every row is right — never part of a file. Left out, and said so in the preview:
// notes (rows starting with #), the template's own example products and, when the merchant chooses, products the shop
// already has. Row numbers are the sheet's own, so a problem can be found in the file.
// Pure: rows of text in, products, variants and opening-stock records out.
import { checkOptions, cleanOptionName, cleanOptionValue, OPTION_LIMITS, OPTION_SUGGESTIONS, tupleKey } from './options.js';
import { codeError, cleanCode } from './barcode.js';
import { cleanProductName, validHsn } from './product-validation.js';
import { UNITS } from './units.js';
import { currencyMarkSource, currencySign, moneyRegion, stripMoney } from '../../shared/formatting/money.js';

/* Units a row may name (code, label, decimals a quantity may have): the app's units (domain/catalog/units.js) */
export const IMPORT_UNITS=UNITS.map(u=>[u.id,u.label,u.dp]);
export const MAX_IMPORT_ROWS=2000;
/* The columns a sheet may have. The first header of each list is the template's; the others are accepted too (among them
   the earlier template's: Name, Price, Cost, Opening stock, Option 1 name…). */
export const IMPORT_COLUMNS=[
  ["name","Product name","Name","Product","Item","Item name"],
  ["price","Selling price","Price","Sale price","MRP","Selling price per unit"],
  ["cost","Cost price","Cost","Purchase price","Buying price"],
  ["qty","Stock quantity","Opening stock","Qty","Quantity","Stock","Opening qty","In stock"],
  ["sku","SKU","Item code","Product code"],
  ["bc","Barcode","EAN","UPC","Barcode / QR","Barcode number"],
  ["cat","Category"],
  ["brand","Brand"],
  ["gst","GST %","GST","GST rate","Tax %","VAT %","Tax rate"],
  ["hsn","HSN code","HSN","HSN/SAC"],
  ["unit","Unit","UOM"],
  ["low","Low stock alert","Low stock","Reorder level","Min stock"],
  ["desc","Description","Details"],
  ["opt1n","Option 1 name"],["opt1v","Option 1 value"],
  ["opt2n","Option 2 name"],["opt2v","Option 2 value"],
  ["opt3n","Option 3 name"],["opt3v","Option 3 value"],
  // the "Problems" column of a file the preview gave back (fix the rows and choose it again): never imported
  ["note","Problems","Problem"],
];
/* a column's name, compared loosely: "Selling price (₹)", "Selling price (required)" and "selling_price *" are "selling price" */
const hkey=h=>String(h==null?"":h).replace(new RegExp("\\s*\\(\\s*"+currencyMarkSource()+"\\s*\\)\\s*$","i"),"")
  .replace(/\s*(\((required|optional)\)|\*)\s*$/i,"").toLowerCase().replace(/[\s_]+/g," ").trim();
const ALIASES=(()=>{const m={};IMPORT_COLUMNS.forEach(([k,...hs])=>hs.forEach(h=>{m[hkey(h)]=k}));return m})();
/* Option names that may be their own column (Colour, Size, Material, Storage…) */
const OPTION_COLUMNS=new Set([...OPTION_SUGGESTIONS,"Color","Colors","Colours","Sizes"].map(hkey));
/* A note for the person filling the sheet in: a row with one filled cell, starting with # (a product named "#1 Tee" has
   more filled cells, so it stays a product) */
export const isNoteRow=r=>{const f=(r||[]).filter(v=>String(v==null?"":v).trim()!=="");return f.length===1&&/^\s*#/.test(String(f[0]))};

/* ---------- the template ---------- */
const taxLabel=()=>moneyRegion().tax==="vat"?"VAT %":"GST %";
/* Column by column: [key, or "opt:" + an option name; the header; what to put; an example] */
export function importTemplateColumns(){
  const cur=currencySign();
  return [
    ["name","Product name (required)","The product's name. Use the same name on every row of one product.","Cotton Round-Neck T-shirt"],
    ["opt:Colour","Colour","Only if it comes in colours: one row per colour.","Black"],
    ["opt:Size","Size","Only if it comes in sizes: one row per size.","M"],
    ["price","Selling price (required)",`What the customer pays, in ${cur}, without decimals.`,"499"],
    ["cost","Cost price",`What you pay for it, in ${cur}.`,"250"],
    ["qty","Stock quantity","How many you have now. kg, litre and metre may have decimals.","10"],
    ["sku","SKU","Your own code for it. Two rows can't have the same.","TSHIRT-BLK-M"],
    ["bc","Barcode","The number printed under the barcode (8, 12 or 13 digits).","8901234567890"],
    ["cat","Category","To group products, e.g. T-shirts.","T-shirts"],
    ["brand","Brand","","Aura"],
    ["gst",taxLabel(),"The tax rate, e.g. 0, 5, 12 or 18.","5"],
    ["hsn","HSN code","4, 6 or 8 digits.","6109"],
    ["unit","Unit",`${IMPORT_UNITS.map(u=>u[0]).join(", ")}. Empty means pcs.`,"pcs"],
    ["low","Low stock alert","Warn when this many or fewer are left.","3"],
    ["desc","Description","","100% cotton"],
  ];
}
/* The example products (left out if they stay in the file) */
const EXAMPLES=[
  {name:"Cotton Round-Neck T-shirt",Colour:"Black",Size:"M",price:499,cost:250,qty:10,sku:"TSHIRT-BLK-M",cat:"T-shirts",brand:"Aura",gst:5,hsn:"6109",unit:"pcs",low:3,desc:"100% cotton"},
  {name:"Cotton Round-Neck T-shirt",Colour:"Black",Size:"L",price:499,cost:250,qty:8,sku:"TSHIRT-BLK-L",cat:"T-shirts",brand:"Aura",gst:5,hsn:"6109",unit:"pcs",low:3,desc:"100% cotton"},
  {name:"Cotton Round-Neck T-shirt",Colour:"White",Size:"M",price:499,cost:250,qty:6,sku:"TSHIRT-WHT-M",cat:"T-shirts",brand:"Aura",gst:5,hsn:"6109",unit:"pcs",low:3,desc:"100% cotton"},
  {name:"Steel Water Bottle 1 L",price:349,cost:190,qty:24,sku:"BOTTLE-1L",bc:"8901234567890",cat:"Kitchen",brand:"Aura",gst:18,hsn:"7323",unit:"pcs",low:5,desc:"Keeps water cold for 12 hours"},
  {name:"Basmati Rice",price:120,cost:85,qty:25.5,sku:"RICE-BASMATI",cat:"Groceries",gst:5,hsn:"1006",unit:"kg",low:10,desc:"Sold loose: the price is per kg"},
];
const sameCode=(a,b)=>String(a||"").trim().toLowerCase()===String(b||"").trim().toLowerCase();
const isExample=x=>EXAMPLES.some(e=>sameCode(e.name,x.name)&&sameCode(e.sku,x.sku)&&sameCode(e.bc,x.bc));
/* The notes at the top of the template (rows starting with #) */
export function importTemplateNotes(){
  const units=IMPORT_UNITS.map(u=>u[0]).join(", ");
  return [
    "# HOW TO FILL THIS IN. Rows that start with # are notes for you: they are not imported.",
    "# 1. One row per product. A product in several colours or sizes gets one row for each, with the same Product name (see the T-shirt).",
    `# 2. Only Product name and Selling price are required. Leave any other column empty if you don't use it.`,
    `# 3. Prices in ${currencySign()} without decimals (499). Stock quantity is what you have now; kg, litre and metre may have decimals (25.5).`,
    "# 4. SKU and Barcode can't repeat. In Excel, set the Barcode column to Text before typing, or long numbers turn into 8.9E+12.",
    `# 5. Unit: ${units} (pcs if empty). Other options, such as Material or Storage: add a column with that name.`,
    "# 6. The example products below are not imported: replace them with your own, then save as CSV (or .xlsx) and choose the file in Hangtag.",
  ];
}
/* The template: notes, the header row, then the example products */
export function importTemplateRows(){
  const cols=importTemplateColumns();
  const row=o=>cols.map(([k])=>{const v=k.startsWith("opt:")?o[k.slice(4)]:o[k];return v==null?"":v});
  return [...importTemplateNotes().map(n=>[n]),cols.map(c=>c[1]),...EXAMPLES.map(row)];
}
/* What goes in each column (the Excel template's "Help" sheet and the import screen) */
export function importHelpRows(){
  return [["Column","Required?","What to put","Example"],
    ...importTemplateColumns().map(([k,head,what,ex])=>[head.replace(/\s*\(required\)$/,""),/\(required\)$/.test(head)?"Yes":"No",what||"Optional.",ex]),
    ["Material, Storage, Flavour…","No","Any other option: add a column with its name, one row per value.","Cotton"]];
}

/* ---------- reading the sheet ---------- */
/* Which column holds what: { map: { key: index }, labels: { key: header as written }, optionCols: [{ i, name }],
   unknown: [header…] } or { error } */
export function mapImportHeader(header){
  const map={}, labels={}, optionCols=[], unknown=[];
  (header||[]).forEach((h,i)=>{
    const k=ALIASES[hkey(h)];
    if(k){ if(map[k]==null){ map[k]=i; labels[k]=String(h).trim().replace(/\s*(\((required|optional)\)|\*)\s*$/i,""); } return; }
    if(OPTION_COLUMNS.has(hkey(h))){ optionCols.push({i,name:cleanOptionName(h)}); return; }
    if(String(h==null?"":h).trim()) unknown.push(String(h).trim());
  });
  if(map.name==null) return {error:"No Product name column was found. The column names must be in one row above the products: download the template to see them."};
  if(map.price==null) return {error:"No Selling price column was found. Add one (download the template to see the columns)."};
  return {map,labels,optionCols,unknown};
}
const txt=v=>String(v==null?"":v).replace(/[\u0000-\u001f\u007f]/g," ").trim().replace(/\s+/g," ");
const numTxt=v=>stripMoney(txt(v).replace(/%/g,""));
const same=(a,b)=>String(a).toLowerCase()===String(b).toLowerCase();
/* A long number Excel shortened when it saved the sheet ("8.90123E+12"): the digits are lost */
const excelNumber=s=>/^\d(\.\d+)?e\+\d+$/i.test(s);

/* rows: [[cell text…]…] as in the sheet (blank rows kept, so row numbers match it). ctx: { products (the catalog: codes and
   names already used), variantsOf, units ([[code, label, decimals]…], default IMPORT_UNITS), stockAllowed (false: stock
   must be empty), skipExisting (true: rows of products the shop already has are left out instead of refused) }
   → { error } (the file itself can't be used) or { rows: [{ line, name, errors: [], skip?: "example"|"existing", … }],
   products: [plan products], errorCount, ok, existing: [names], summary: { products, variants, pieces, examples, skipped },
   unknown, labels } */
export function validateImport(rows,ctx={}){
  const sheet=(rows||[]).map(r=>Array.isArray(r)?r:[]);
  const filled=r=>r.some(c=>txt(c)!=="");
  const at=sheet.findIndex(r=>filled(r)&&!isNoteRow(r));
  if(at<0) return {error:sheet.some(filled)?"There are only notes (rows starting with #) in that file: add the column names and your products.":"That file is empty."};
  const H=mapImportHeader(sheet[at]); if(H.error) return {error:H.error};
  const body=[]; sheet.forEach((r,i)=>{ if(i>at&&filled(r)&&!isNoteRow(r)) body.push({r,line:i+1}); });
  if(!body.length) return {error:"There are no products under the column names."};
  if(body.length>MAX_IMPORT_ROWS) return {error:`A file can have up to ${MAX_IMPORT_ROWS} products. Split it into smaller files.`};
  const L=k=>H.labels[k]||({price:"Selling price",cost:"Cost price",qty:"Stock quantity",gst:taxLabel(),hsn:"HSN code",low:"Low stock alert",unit:"Unit",bc:"Barcode",sku:"SKU",name:"Product name"})[k]||k;
  const units=ctx.units||IMPORT_UNITS, unitOf=u=>units.find(x=>same(x[0],u)||same(x[1],u));
  const variantsOf=ctx.variantsOf||((p,all)=>((p&&p.variants)||[]).filter(v=>all||v.active!==false));
  const taken={}, names={};
  (ctx.products||[]).forEach(p=>{names[cleanProductName(p.name).toLowerCase()]=p.name;variantsOf(p,true).forEach(v=>{const lab=(p.name+" "+(v.o||[]).join(" / ")).trim();if(v.sku)taken["s:"+v.sku.trim().toLowerCase()]=lab;if(v.bc)taken["b:"+v.bc.trim()]=lab})});
  const get=(r,k)=>H.map[k]==null?"":txt(r[H.map[k]]);
  const seen={}, out=[];
  body.forEach(({r,line})=>{
    const errors=[], x={line,errors};
    const name=cleanProductName(get(r,"name"));
    x.name=name;
    if(!name) errors.push(`${L("name")} is empty: every row needs one.`);
    else if(name.length>80) errors.push(`${L("name")} is too long (at most 80 letters).`);
    // money: whole amounts (the catalog keeps prices and costs without decimals)
    const money=(k,required)=>{
      const raw=get(r,k), s=numTxt(raw); if(s===""){ if(required) errors.push(`${L(k)} is empty: every row needs one.`); return null; }
      const n=Number(s);
      if(!Number.isFinite(n)||n<0){ errors.push(`${L(k)} “${raw}” isn't a number. Write just the amount, e.g. 499.`); return null; }
      if(!Number.isInteger(n)){ errors.push(`${L(k)} “${raw}” has decimals: use a whole amount (${Math.floor(n)} or ${Math.ceil(n)}).`); return null; }
      if(n>10000000){ errors.push(`${L(k)} “${raw}” is too large.`); return null; }
      return n;
    };
    x.price=money("price",true); x.cost=money("cost",false);
    const g=numTxt(get(r,"gst"));
    if(g!==""){ const n=Number(g); if(!Number.isFinite(n)||n<0||n>100||Math.abs(n*100-Math.round(n*100))>1e-6) errors.push(`${L("gst")} “${get(r,"gst")}” should be a rate from 0 to 100, e.g. 5 or 18.`); else x.gst=n; }
    else x.gst=null;
    const hsn=get(r,"hsn").replace(/\s/g,"");
    if(!validHsn(hsn)) errors.push(`${L("hsn")} “${hsn}” should be 4, 6 or 8 digits${/^\d{3}$|^\d{5}$|^\d{7}$/.test(hsn)?" (Excel may have removed a 0 at the start: set the column to Text and type it again)":""}.`);
    x.hsn=hsn;
    const u=get(r,"unit"), U=u?unitOf(u):null;
    if(u&&!U) errors.push(`${L("unit")} “${u}” isn't one Hangtag knows. Use one of: ${units.map(z=>z[0]).join(", ")}.`);
    x.unit=U?U[0]:"";   // "" = not given here (the product's unit, else pieces)
    const q=numTxt(get(r,"qty"));
    x.qty=0;
    if(q!==""){
      const n=Number(q);
      if(!Number.isFinite(n)||n<0) errors.push(`${L("qty")} “${get(r,"qty")}” isn't a number (0 or more).`);
      else if(n>1000000) errors.push(`${L("qty")} “${get(r,"qty")}” is too large.`);
      else if(n>0&&ctx.stockAllowed===false) errors.push(`Your role can't set stock: leave ${L("qty")} empty.`);
      else x.qty=n;
    }
    const lo=numTxt(get(r,"low"));
    if(lo!==""){ const n=Number(lo); if(!Number.isInteger(n)||n<0||n>100000) errors.push(`${L("low")} “${get(r,"low")}” should be a whole number from 0 to 100000.`); else x.low=n; }
    else x.low=null;
    x.cat=get(r,"cat").slice(0,40); x.brand=get(r,"brand").slice(0,40); x.desc=get(r,"desc").slice(0,300);
    // options: columns named like an option (Colour, Size…), and "Option N name / value" pairs
    const opts=[];
    H.optionCols.forEach(c=>{const v=cleanOptionValue(r[c.i]);if(v)opts.push({n:c.name,v})});
    for(const n of [1,2,3]){
      const on=cleanOptionName(get(r,"opt"+n+"n")), ov=cleanOptionValue(get(r,"opt"+n+"v"));
      if(on&&!ov) errors.push(`Option ${n} (${on}) has no value.`);
      else if(ov&&!on) errors.push(`Option ${n} value “${ov}” has no option name.`);
      else if(on) opts.push({n:on,v:ov});
    }
    if(opts.length>OPTION_LIMITS.maxOptions) errors.push(`A product can have up to ${OPTION_LIMITS.maxOptions} options (such as Colour and Size).`);
    const on=new Set(); opts.forEach(o=>{if(on.has(o.n.toLowerCase()))errors.push(`${o.n} is given twice.`);on.add(o.n.toLowerCase())});
    x.opts=opts;
    // codes: whole (not shortened by Excel), and unique in the file and in the shop
    const sku=get(r,"sku"), bc=cleanCode(get(r,"bc"));
    x.sku=sku; x.bc=bc;
    if(isExample(x)){ x.skip="example"; errors.length=0; out.push(x); return; }
    if(sku.length>64) errors.push(`${L("sku")} can be at most 64 characters.`);
    for(const [k,val] of [["sku",sku],["bc",bc]]) if(excelNumber(val)) errors.push(`${L(k)} “${val}” was shortened by Excel, and its digits are lost. In Excel, set the ${L(k)} column to Text, type the numbers again and save (or use the Excel template).`);
    const ce=!excelNumber(bc)&&codeError(get(r,"bc")); if(ce) errors.push(`${L("bc")}: ${ce}`);
    const existing=!!(name&&names[name.toLowerCase()]);
    if(existing&&ctx.skipExisting){ x.skip="existing"; errors.length=0; out.push(x); return; }
    if(existing) errors.push(`${names[name.toLowerCase()]} is already in your shop. Import adds new products only: leave it out, or give this one another name.`);
    else for(const [k,val,what] of [["s:"+sku.toLowerCase(),sku,L("sku")],["b:"+bc,bc,L("bc")]]){
      if(!val||excelNumber(val)) continue;
      if(taken[k]) errors.push(`${what} ${val} is already used by ${taken[k]} in your shop.`);
      else if(seen[k]) errors.push(`${what} ${val} is also on row ${seen[k]}.`);
      else seen[k]=line;
    }
    x.existing=existing;
    out.push(x);
  });
  // rows with the same name are one product: the same options (names, in order), a different combination each, and the same
  // product details (a detail left empty takes the product's)
  const used=out.filter(x=>!x.skip), groups=new Map();
  used.forEach(x=>{if(!x.name)return;const k=x.name.toLowerCase();if(!groups.has(k))groups.set(k,[]);groups.get(k).push(x)});
  const products=[];
  groups.forEach(list=>{
    const first=list[0], optNames=first.opts.map(o=>o.n), combos=new Set();
    list.forEach((x,i)=>{
      if(i&&!x.opts.length&&!first.opts.length){ x.errors.push(`${x.name} is also on row ${first.line}. Rows of one product need a Colour, Size or other option column to tell them apart; otherwise give it another name.`); return; }
      if(i&&(x.opts.length!==optNames.length||x.opts.some((o,k)=>!same(o.n,optNames[k])))){ x.errors.push(`Row ${first.line} of ${x.name} has ${optNames.join(" and ")||"no options"}: every row of one product needs the same (${x.opts.map(o=>o.n).join(" and ")||"none"} here).`); return; }
      const key=tupleKey(x.opts.map(o=>o.v));
      if(combos.has(key)){ x.errors.push(`${x.name} ${x.opts.map(o=>o.v).join(" / ")} is on an earlier row too.`); return; }
      combos.add(key);
      for(const [k,label] of [["cat","Category"],["brand","Brand"],["gst",L("gst")],["hsn",L("hsn")],["unit",L("unit")],["low",L("low")],["desc","Description"]]){
        const a=first[k], b=x[k];
        if(i&&b!=null&&b!==""&&a!=null&&a!==""&&String(a)!==String(b)) x.errors.push(`${label} “${b}” differs from row ${first.line} of ${x.name} (${a}): one product has one ${label.toLowerCase()}.`);
      }
    });
    // quantities in the product's unit: whole pieces unless the unit allows decimals (kg, litre, metre)
    const unitCode=(list.find(x=>x.unit)||{}).unit||"pcs", U=unitOf(unitCode), dec=U?U[2]:0;
    list.forEach(x=>{ if(x.qty&&Math.abs(x.qty*10**dec-Math.round(x.qty*10**dec))>1e-6){ x.errors.push(dec?`${L("qty")} can have at most ${dec} decimal places for ${unitCode}.`:`${L("qty")} “${x.qty}” must be a whole number for ${unitCode}.`); x.qty=0; } });
    const opts=optNames.map(n=>({n,v:[]}));
    list.forEach(x=>x.opts.forEach((o,k)=>{if(opts[k]&&!opts[k].v.some(v=>same(v,o.v)))opts[k].v.push(o.v)}));
    const bad=opts.length?checkOptions(opts):null;
    if(bad) first.errors.push(bad.error);
    const pick=k=>{const f=list.find(x=>x[k]!=null&&x[k]!=="");return f?f[k]:(k==="gst"||k==="low"?null:"")};
    products.push({name:first.name,rows:list,opts,cat:pick("cat"),brand:pick("brand"),desc:pick("desc"),gst:pick("gst"),hsn:pick("hsn"),unit:unitCode,low:pick("low"),
      price:first.price,cost:first.cost});
  });
  const errorCount=used.filter(x=>x.errors.length).length;
  const pieces=used.reduce((a,x)=>a+(x.qty||0),0);
  const existing=[...new Set(out.filter(x=>x.skip==="existing"||x.existing).map(x=>names[x.name.toLowerCase()]))];
  return {rows:out,products,errorCount,ok:errorCount===0&&products.length>0,existing,unknown:H.unknown,labels:H.labels,
    summary:{products:products.length,variants:used.filter(x=>x.name).length,pieces:Math.round(pieces*1000)/1000,
      examples:out.filter(x=>x.skip==="example").length,skipped:out.filter(x=>x.skip==="existing").length}};
}
/* The file given back with what is wrong written next to each row (a "Problems" column the import ignores): fix the
   rows in it and choose it again */
export function importProblemRows(rows,check){
  const sheet=(rows||[]).map(r=>Array.isArray(r)?r.slice():[]);
  const at=sheet.findIndex(r=>r.some(c=>txt(c)!=="")&&!isNoteRow(r));
  if(at<0||!check||!check.rows) return sheet;
  const width=Math.max(...sheet.map(r=>r.length)), H=mapImportHeader(sheet[at]), col=H.map&&H.map.note!=null?H.map.note:width;
  const pad=r=>{while(r.length<col)r.push("");return r};
  pad(sheet[at])[col]="Problems";
  const by=new Map(check.rows.map(x=>[x.line,x]));
  sheet.forEach((r,i)=>{ if(i<=at||isNoteRow(r)) return; const x=by.get(i+1); if(!x) return;
    pad(r)[col]=x.skip==="example"?"Example row: not imported":x.skip==="existing"?"Already in your shop: left out":x.errors.join(" ")||""; });
  return sheet;
}
/* A valid import → { products (catalog records with their variants), moves (OPENING stock records) }.
   ids: { product(), variant() } make new ids; colors: tile colours to cycle through; now, dev: the stock records' time and device. */
export function importPlan(v,{ids,colors,now,dev}){
  if(!v||!v.ok) return {error:"Fix the rows marked in red first: nothing is imported until every row is right."};
  const products=[], moves=[];
  v.products.forEach((g,i)=>{
    const pid=ids.product(), variants=[];
    g.rows.forEach(x=>{
      const id=ids.variant();
      variants.push({id,o:x.opts.map(o=>g.opts.find(op=>same(op.n,o.n)).v.find(val=>same(val,o.v))),sku:x.sku,bc:x.bc,price:x.price!=null&&x.price!==g.price?x.price:null,
        cost:x.cost!=null&&x.cost!==g.cost?x.cost:null,active:true});
      if(x.qty>0) moves.push({id:"open:"+id,v:id,p:pid,type:"OPENING",q:x.qty,cost:null,note:"Opening stock (import)",t:now,dev});
    });
    const p={id:pid,name:g.name,cat:g.cat||"",brand:g.brand||"",desc:g.desc||"",price:g.price,cost:g.cost,color:colors&&colors.length?colors[i%colors.length]:"#8E8A83",archived:false,
      hsn:g.hsn||"",gst:g.gst,code:variants.some(x=>x.bc)?"barcode":"",opts:g.opts.map(o=>({n:o.n,v:o.v.slice()})),variants};
    if(g.low!=null) p.low=g.low;
    if(g.unit&&g.unit!=="pcs") p.unit=g.unit;
    products.push(p);
  });
  return {products,moves};
}
