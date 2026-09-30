// Bulk product import (Products → Import): a sheet (CSV or Excel) with one row per product, or one row per variant
// (rows with the same product name and option columns form one product's variants). Every row is checked first; the
// import happens only when every row is valid — never part of a file. Pure: rows of text in, products, variants and
// opening-stock records out.
import { checkOptions, cleanOptionName, cleanOptionValue, OPTION_LIMITS, OPTION_SUGGESTIONS, tupleKey } from './options.js';
import { codeError, cleanCode } from './barcode.js';
import { cleanProductName, validHsn } from './product-validation.js';
import { UNITS } from './units.js';

/* Units a row may name (code, label, decimals a quantity may have): the app's units (domain/catalog/units.js) */
export const IMPORT_UNITS=UNITS.map(u=>[u.id,u.label,u.dp]);
export const MAX_IMPORT_ROWS=2000;
/* The columns of the template, in order; the first header of each list is the one the template uses */
export const IMPORT_COLUMNS=[
  ["name","Name","Product","Product name","Item","Item name"],
  ["cat","Category"],
  ["brand","Brand"],
  ["opt1n","Option 1 name"],["opt1v","Option 1 value"],
  ["opt2n","Option 2 name"],["opt2v","Option 2 value"],
  ["opt3n","Option 3 name"],["opt3v","Option 3 value"],
  ["sku","SKU"],
  ["bc","Barcode","EAN","UPC","Barcode / QR"],
  ["price","Price","Selling price","Sale price","Price (₹)","Selling price (₹)","MRP"],
  ["cost","Cost","Cost price","Purchase price","Cost (₹)","Cost price (₹)"],
  ["gst","GST %","GST","GST rate","Tax %"],
  ["hsn","HSN","HSN code","HSN/SAC"],
  ["qty","Opening stock","Qty","Quantity","Stock","Opening qty"],
  ["unit","Unit"],
  ["low","Low stock alert","Low stock","Reorder level","Min stock"],
  ["desc","Description"],
];
const hkey=h=>String(h==null?"":h).toLowerCase().replace(/[\s_]+/g," ").trim();
const ALIASES=(()=>{const m={};IMPORT_COLUMNS.forEach(([k,...hs])=>hs.forEach(h=>{m[hkey(h)]=k}));return m})();
/* Option names that may be their own column (e.g. "Colour", "Size") */
const OPTION_COLUMNS=new Set([...OPTION_SUGGESTIONS,"Color","Colors","Colours","Sizes"].map(hkey));

/* The template: header row + example rows (a simple product, and a product with two variants) */
export function importTemplateRows(){
  const head=IMPORT_COLUMNS.map(c=>c[1]);
  const row=o=>IMPORT_COLUMNS.map(([k])=>o[k]==null?"":o[k]);
  return [head,
    row({name:"Cotton Tote Bag",cat:"Bags",brand:"Aura",sku:"TOTE-01",bc:"8901234567890",price:349,cost:180,gst:5,hsn:"4202",qty:25,unit:"pcs",low:5,desc:"Canvas, one size"}),
    row({name:"Oversized Tee",cat:"T-shirts",opt1n:"Colour",opt1v:"Black",opt2n:"Size",opt2v:"M",sku:"TEE-BLK-M",price:599,cost:300,gst:5,hsn:"6109",qty:10,unit:"pcs",low:3}),
    row({name:"Oversized Tee",cat:"T-shirts",opt1n:"Colour",opt1v:"Black",opt2n:"Size",opt2v:"L",sku:"TEE-BLK-L",price:599,cost:300,gst:5,hsn:"6109",qty:8,unit:"pcs",low:3})];
}
/* Which column holds what: { map: { key: index }, optionCols: [{ i, name }], unknown: [header…] } or { error } */
export function mapImportHeader(header){
  const map={}, optionCols=[], unknown=[];
  (header||[]).forEach((h,i)=>{
    const k=ALIASES[hkey(h)];
    if(k){ if(map[k]==null) map[k]=i; return; }
    if(OPTION_COLUMNS.has(hkey(h))){ optionCols.push({i,name:cleanOptionName(h)}); return; }
    if(String(h==null?"":h).trim()) unknown.push(String(h).trim());
  });
  if(map.name==null) return {error:"The first row must be the column names, with a Name column (download the template to see them)."};
  if(map.price==null) return {error:"The sheet needs a Price column (download the template to see the columns)."};
  return {map,optionCols,unknown};
}
const txt=v=>String(v==null?"":v).replace(/[\u0000-\u001f\u007f]/g," ").trim().replace(/\s+/g," ");
const numTxt=v=>txt(v).replace(/[₹,%]/g,"").replace(/\s/g,"");
const same=(a,b)=>String(a).toLowerCase()===String(b).toLowerCase();

/* rows: [[cell text…]…] with the header first. ctx: { products (the catalog: codes and names already used), variantsOf, units
   ([[code, label, decimals]…], default IMPORT_UNITS), stockAllowed (false: opening stock must be empty) }
   → { error } (the file itself can't be used) or { rows: [{ line, name, errors: [] , …}], products: [plan products], errorCount,
   ok, summary: { products, variants, pieces }, unknown } */
export function validateImport(rows,ctx={}){
  const all=(rows||[]).filter(r=>Array.isArray(r)&&r.some(c=>txt(c)!==""));
  if(!all.length) return {error:"That file is empty."};
  const H=mapImportHeader(all[0]); if(H.error) return {error:H.error};
  const body=all.slice(1);
  if(!body.length) return {error:"There are no product rows under the column names."};
  if(body.length>MAX_IMPORT_ROWS) return {error:`A file can have up to ${MAX_IMPORT_ROWS} rows. Split it into smaller files.`};
  const units=ctx.units||IMPORT_UNITS, unitOf=u=>units.find(x=>same(x[0],u)||same(x[1],u));
  const variantsOf=ctx.variantsOf||((p,all)=>((p&&p.variants)||[]).filter(v=>all||v.active!==false));
  const taken={}, names={};
  (ctx.products||[]).forEach(p=>{names[cleanProductName(p.name).toLowerCase()]=p.name;variantsOf(p,true).forEach(v=>{const lab=(p.name+" "+(v.o||[]).join(" / ")).trim();if(v.sku)taken["s:"+v.sku.trim().toLowerCase()]=lab;if(v.bc)taken["b:"+v.bc.trim()]=lab})});
  const get=(r,k)=>H.map[k]==null?"":txt(r[H.map[k]]);
  const seen={}, out=[];
  body.forEach(r=>{
    const line=all.indexOf(r)+1, errors=[], x={line,errors};
    const name=cleanProductName(get(r,"name"));
    x.name=name;
    if(!name) errors.push("Name is missing.");
    else if(name.length>80) errors.push("Name can be at most 80 characters.");
    // money: whole rupees (the catalog keeps prices and costs in rupees)
    const money=(k,label,required)=>{
      const s=numTxt(get(r,k)); if(s===""){ if(required) errors.push(label+" is missing."); return null; }
      const n=Number(s);
      if(!Number.isFinite(n)||n<0){ errors.push(`${label} “${get(r,k)}” isn't a number of rupees (0 or more).`); return null; }
      if(!Number.isInteger(n)){ errors.push(`${label} must be whole rupees (${get(r,k)}).`); return null; }
      if(n>10000000){ errors.push(`${label} is too large.`); return null; }
      return n;
    };
    x.price=money("price","Price",true); x.cost=money("cost","Cost",false);
    const g=numTxt(get(r,"gst"));
    if(g!==""){ const n=Number(g); if(!Number.isFinite(n)||n<0||n>100||Math.abs(n*100-Math.round(n*100))>1e-6) errors.push(`GST % “${get(r,"gst")}” should be between 0 and 100.`); else x.gst=n; }
    else x.gst=null;
    const hsn=get(r,"hsn").replace(/\s/g,""); if(!validHsn(hsn)) errors.push(`HSN “${hsn}” should be 4, 6 or 8 digits.`); x.hsn=hsn;
    const u=get(r,"unit"), U=u?unitOf(u):null;
    if(u&&!U) errors.push(`Unit “${u}” isn't one of: ${units.map(z=>z[0]).join(", ")}.`);
    x.unit=U?U[0]:"";   // "" = not given here (the product's unit, else pieces)
    const q=numTxt(get(r,"qty"));
    x.qty=0;
    if(q!==""){
      const n=Number(q);
      if(!Number.isFinite(n)||n<0) errors.push(`Opening stock “${get(r,"qty")}” isn't a quantity (0 or more).`);
      else if(n>1000000) errors.push("Opening stock is too large.");
      else if(n>0&&ctx.stockAllowed===false) errors.push("Your role can't set stock: leave Opening stock empty.");
      else x.qty=n;
    }
    const lo=numTxt(get(r,"low"));
    if(lo!==""){ const n=Number(lo); if(!Number.isInteger(n)||n<0||n>100000) errors.push(`Low stock alert “${get(r,"low")}” should be a whole number from 0 to 100000.`); else x.low=n; }
    else x.low=null;
    x.cat=get(r,"cat").slice(0,40); x.brand=get(r,"brand").slice(0,40); x.desc=get(r,"desc").slice(0,300);
    // options: "Option N name / value" pairs, then columns named like an option (Colour, Size…)
    const opts=[];
    for(const n of [1,2,3]){
      const on=cleanOptionName(get(r,"opt"+n+"n")), ov=cleanOptionValue(get(r,"opt"+n+"v"));
      if(on&&!ov) errors.push(`Option ${n} (${on}) has no value.`);
      else if(ov&&!on) errors.push(`Option ${n} value “${ov}” has no option name.`);
      else if(on) opts.push({n:on,v:ov});
    }
    H.optionCols.forEach(c=>{const v=cleanOptionValue(r[c.i]);if(v)opts.push({n:c.name,v})});
    if(opts.length>OPTION_LIMITS.maxOptions) errors.push(`A product can have up to ${OPTION_LIMITS.maxOptions} options.`);
    const on=new Set(); opts.forEach(o=>{if(on.has(o.n.toLowerCase()))errors.push(`Option ${o.n} is given twice.`);on.add(o.n.toLowerCase())});
    x.opts=opts;
    // codes: unique in the file and in the shop
    const sku=get(r,"sku"), bc=cleanCode(get(r,"bc"));
    if(sku.length>64) errors.push("SKU can be at most 64 characters.");
    const ce=codeError(get(r,"bc")); if(ce) errors.push(ce);
    for(const [k,val,what] of [["s:"+sku.toLowerCase(),sku,"SKU"],["b:"+bc,bc,"Barcode"]]){
      if(!val) continue;
      if(taken[k]) errors.push(`${what} ${val} is already used by ${taken[k]}.`);
      else if(seen[k]) errors.push(`${what} ${val} is also on row ${seen[k]}.`);
      else seen[k]=line;
    }
    x.sku=sku; x.bc=bc;
    if(name&&names[name.toLowerCase()]) errors.push(`A product called ${names[name.toLowerCase()]} already exists. Import adds new products only: rename this one, or add the variants in the product editor.`);
    out.push(x);
  });
  // rows with the same name are one product: the same options (names, in order), a different combination each, and the same
  // product details (a detail left empty takes the product's)
  const groups=new Map();
  out.forEach(x=>{if(!x.name)return;const k=x.name.toLowerCase();if(!groups.has(k))groups.set(k,[]);groups.get(k).push(x)});
  const products=[];
  groups.forEach(list=>{
    const first=list[0], optNames=first.opts.map(o=>o.n), combos=new Set();
    list.forEach((x,i)=>{
      if(i&&!x.opts.length&&!first.opts.length){ x.errors.push(`${x.name} is also on row ${first.line}. Rows of one product need option columns (e.g. Size) to be its variants; otherwise give it another name.`); return; }
      if(i&&(x.opts.length!==optNames.length||x.opts.some((o,k)=>!same(o.n,optNames[k])))){ x.errors.push(`The options of ${x.name} should be the same as on row ${first.line} (${optNames.join(", ")||"none"}).`); return; }
      const key=tupleKey(x.opts.map(o=>o.v));
      if(combos.has(key)){ x.errors.push(`${x.name} ${x.opts.map(o=>o.v).join(" / ")} is on an earlier row too.`); return; }
      combos.add(key);
      for(const [k,label] of [["cat","Category"],["brand","Brand"],["gst","GST %"],["hsn","HSN"],["unit","Unit"],["low","Low stock alert"],["desc","Description"]]){
        const a=first[k], b=x[k];
        if(i&&b!=null&&b!==""&&a!=null&&a!==""&&String(a)!==String(b)) x.errors.push(`${label} differs from row ${first.line} of ${x.name} (${a}).`);
      }
    });
    // quantities in the product's unit: whole pieces unless the unit allows decimals (kg, litre, metre)
    const unitCode=(list.find(x=>x.unit)||{}).unit||"pcs", U=unitOf(unitCode), dec=U?U[2]:0;
    list.forEach(x=>{ if(x.qty&&Math.abs(x.qty*10**dec-Math.round(x.qty*10**dec))>1e-6){ x.errors.push(dec?`Opening stock can have at most ${dec} decimal places for ${unitCode}.`:`Opening stock must be a whole number (${unitCode}).`); x.qty=0; } });
    const opts=optNames.map((n,k)=>({n,v:[]}));
    list.forEach(x=>x.opts.forEach((o,k)=>{if(opts[k]&&!opts[k].v.some(v=>same(v,o.v)))opts[k].v.push(o.v)}));
    const bad=opts.length?checkOptions(opts):null;
    if(bad) first.errors.push(bad.error);
    const pick=k=>{const f=list.find(x=>x[k]!=null&&x[k]!=="");return f?f[k]:(k==="gst"||k==="low"?null:"")};
    products.push({name:first.name,rows:list,opts,cat:pick("cat"),brand:pick("brand"),desc:pick("desc"),gst:pick("gst"),hsn:pick("hsn"),unit:unitCode,low:pick("low"),
      price:first.price,cost:first.cost});
  });
  const errorCount=out.filter(x=>x.errors.length).length;
  const pieces=out.reduce((a,x)=>a+(x.qty||0),0);
  return {rows:out,products,errorCount,ok:errorCount===0,unknown:H.unknown,summary:{products:products.length,variants:out.filter(x=>x.name).length,pieces:Math.round(pieces*1000)/1000}};
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
