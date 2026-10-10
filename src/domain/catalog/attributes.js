// The shop's own product fields (custom attributes): Wattage, Material, Warranty (months), Pressing year… each with a type,
// its choices and rules, shown on the products it applies to (every product, or only some categories). A field is a record
// of the shop (hangtag_attributes, synced like price lists); a product keeps its values in attrs: { [field id]: value }
// (hangtag_products.attrs). Adding a field never needs a database change.
// What money and stock depend on stays structured and can't be a field: price, cost, stock, SKU, barcode, unit, GST, HSN,
// serial numbers, batches and expiry dates (a field with one of those names is refused, and the built-in feature named).
// A field of a type that can tell variants apart may also be a product's option (opts[i].a = the field's id): its values
// then come from the field, and the variants are made from them as from any option (domain/catalog/options.js). Pure.

/* ---------- types and limits ---------- */
export const ATTR_TYPES=Object.freeze([
  {key:"text",label:"Text",hint:"Any words, e.g. Hand-woven"},
  {key:"number",label:"Whole number",hint:"e.g. 12"},
  {key:"decimal",label:"Decimal number",hint:"e.g. 12.5"},
  {key:"date",label:"Date",hint:"e.g. 2026-12-31"},
  {key:"yesno",label:"Yes / no",hint:"Yes or No"},
  {key:"choice",label:"One choice from a list",hint:"e.g. Warm white, Cool white"},
  {key:"multi",label:"Several choices from a list",hint:"e.g. Bluetooth, Wi-Fi"},
]);
export const ATTR_TYPE_KEYS=ATTR_TYPES.map(t=>t.key);
export const attrTypeLabel=k=>(ATTR_TYPES.find(t=>t.key===k)||{label:k}).label;
/* Types whose values can tell variants apart (a product option linked to the field) */
export const VARIANT_TYPES=Object.freeze(["choice","text","number","decimal"]);
export const ATTR_LIMITS=Object.freeze({maxFields:60,nameLen:32,maxOptions:100,optionLen:40,textLen:300,defaultTextLen:120,unitLen:12,
  maxCategories:50,categoryLen:40,maxDp:4,defaultDp:2,maxAbs:1e12,maxValues:60});
const L=ATTR_LIMITS;
export const ATTR_ID_RE=/^[A-Za-z0-9_-]{1,40}$/;

/* ---------- names ---------- */
const str=x=>x==null?"":String(x);
const tidy=(s,max)=>{const t=str(s).replace(/[\u0000-\u001f\u007f]/g," ").replace(/\s+/g," ").trim();return max?[...t].slice(0,max).join("").trim():t};
const chars=s=>[...str(s)].length;
const low=s=>str(s).toLowerCase();
/* A field's name as typed: trimmed, single spaces, at most 32 characters */
export const cleanAttrName=s=>tidy(s,L.nameLen);
export const cleanAttrOption=s=>tidy(s,L.optionLen);
/* Names compared loosely: case, spaces, and a trailing "(required)", "(optional)" or "*" (as import headers carry them) */
export const nameKey=s=>low(tidy(s)).replace(/\s*(\((required|optional)\)|\*)\s*$/,"").replace(/[\s_]+/g," ").trim();
// Built-in fields a field may not be named after, with where that information lives instead
const BUILT_IN=[
  [["name","product","product name","item","item name"],"Every product already has a name."],
  [["price","selling price","sale price","selling price per unit"],"Selling price is built in (each variant can have its own)."],
  [["cost","cost price","purchase price","buying price"],"Cost price is built in: profit and stock value use it."],
  [["stock","stock quantity","quantity","qty","opening stock","opening qty","in stock"],"Stock comes from stock records (Stock in, purchases, bills, returns), so it can't be a field."],
  [["sku"],"SKU is built in: one per variant, checked for duplicates."],
  [["barcode","barcode / qr","qr code","barcode number"],"Barcode is built in: one per variant, checked for duplicates."],
  [["category"],"Category is built in. A field can be set to show only for some categories."],
  [["brand"],"Brand is built in."],
  [["description"],"Description is built in (under Advanced)."],
  [["unit","uom","sold by"],"The unit a product is sold in is built in. Add your own units under Units."],
  [["gst","gst %","gst rate","tax %","tax rate","vat %"],"The GST rate is built in: bills and GST returns use it."],
  [["hsn","hsn code","hsn/sac"],"HSN code is built in: GST returns use it."],
  [["low stock","low stock alert","reorder level","min stock"],"Low stock alert is built in."],
  [["serial","serial number","serial no","imei","imei number","imei 1","imei 2"],"Serial and IMEI numbers are kept per piece: choose Track stock by “Serial number”. Each number is then recorded when it comes in and when it is sold, and can't be sold twice."],
  [["batch","batch number","batch no","lot","lot number"],"Batches are kept with the stock: choose Track stock by “Batch”."],
  [["expiry","expiry date","exp date","best before","use by"],"Expiry dates are kept with each batch: choose Track stock by “Batch with expiry date”, so stock is warned about before it expires and isn't sold after."],
  [["variant","variants","option","options"],"Variants are made from options (Size, Colour, or one of your fields)."],
  [["problems","problem"],"An import file uses that column name for its problems."],
];
const RESERVED=new Map(BUILT_IN.flatMap(([names,why])=>names.map(n=>[n,why])));
/* Why a name can't be a field (a built-in field has it), or null */
export const reservedName=name=>RESERVED.get(nameKey(name))||null;

/* ---------- definitions ---------- */
const bool=v=>v===true||v==="true"||v==="on"||v===1||v==="1";
/* A number typed loosely: "1,200", " 12.5 ", "-3"; null when empty, NaN when it isn't one */
export function looseNumber(raw){
  if(typeof raw==="number")return Number.isFinite(raw)?raw:NaN;
  const t=str(raw).trim().replace(/\s/g,"");
  if(t==="")return null;
  if(!/^[-+]?(\d{1,3}(,\d{3})+|\d+)(\.\d+)?$|^[-+]?\.\d+$/.test(t))return NaN;
  return Number(t.replace(/,/g,""));
}
const decs=n=>{const s=String(n);if(/e/i.test(s))return 0;const i=s.indexOf(".");return i<0?0:s.length-i-1};
/* A field as kept: { id, name, type, options, required, min, max, dp, unit, maxLen, cats, archived, sort } */
export function normalizeAttr(a){
  const x=a&&typeof a==="object"?a:{};
  const type=ATTR_TYPE_KEYS.includes(x.type)?x.type:"text", list=type==="choice"||type==="multi";
  const num=v=>v==null||v===""||!Number.isFinite(+v)?null:+v;
  return {id:str(x.id),name:cleanAttrName(x.name),type,options:list&&Array.isArray(x.options)?x.options.map(cleanAttrOption).filter(Boolean):[],
    required:!!x.required,min:type==="number"||type==="decimal"?num(x.min):null,max:type==="number"||type==="decimal"?num(x.max):null,
    dp:type==="decimal"?Math.min(L.maxDp,Math.max(1,Math.round(num(x.dp)??L.defaultDp))):type==="number"?0:null,
    unit:type==="number"||type==="decimal"?tidy(x.unit,L.unitLen):"",maxLen:type==="text"?Math.min(L.textLen,Math.max(1,Math.round(num(x.maxLen)??L.defaultTextLen))):null,
    cats:Array.isArray(x.cats)?x.cats.map(c=>tidy(c,L.categoryLen)).filter(Boolean):[],archived:!!x.archived,sort:Number.isFinite(+x.sort)?Math.round(+x.sort):0,
    ...(x.t!=null?{t:+x.t}:{})};
}
const splitList=v=>Array.isArray(v)?v:str(v).split(/[,\n]/);
/* A field being made or changed. input: { id, name, type, options: [label] or [{ was, now }] (was: the label it had, null
   for a new one; now: "" to remove it), required, min, max, dp, unit, maxLen, cats: [name] or "a, b", sort }.
   ctx: { attrs: the shop's fields, before: the field as saved (null for a new one), usage: attrUsage(products, before) }.
   → { attr, renames: [[from, to]] } or { error }: the first problem, for the person. An option in use can be renamed (the
   products using it are changed with it) but not removed; a field in use keeps its type. */
export function checkAttrDef(input,ctx={}){
  const x=input||{}, before=ctx.before?normalizeAttr(ctx.before):null, all=(ctx.attrs||[]).map(normalizeAttr);
  const usage=ctx.usage||{products:0,byOption:{}}, used=usage.products>0;
  const name=cleanAttrName(x.name);
  if(!name)return {error:"Give the field a name, e.g. Wattage or Material."};
  if(chars(tidy(x.name))>L.nameLen)return {error:`A field's name can be up to ${L.nameLen} characters.`};
  if(/^#/.test(name))return {error:"A field's name can't start with # (import files use it for notes)."};
  const why=reservedName(name);if(why)return {error:`${name} can't be a field: ${why}`};
  if(all.some(a=>a.id!==(before&&before.id)&&!a.archived&&nameKey(a.name)===nameKey(name)))return {error:`There's already a field called ${name}.`};
  const type=x.type==null&&before?before.type:x.type;
  if(!ATTR_TYPE_KEYS.includes(type))return {error:"Choose what kind of field it is."};
  if(before&&type!==before.type&&used)return {error:`${before.name} is used by ${usage.products} product${usage.products===1?"":"s"}, so its type can't change. Make a new field instead.`};
  const archived=x.archived!=null?bool(x.archived):!!(before&&before.archived);
  if(!before&&!archived&&all.filter(a=>!a.archived).length>=L.maxFields)return {error:`A shop can have up to ${L.maxFields} fields. Archive one you no longer use first.`};
  if(before&&before.archived&&!archived&&all.filter(a=>!a.archived&&a.id!==before.id).length>=L.maxFields)return {error:`A shop can have up to ${L.maxFields} fields in use. Archive another one first.`};
  // choices: each option kept, renamed, removed (only when unused) or added
  let options=[];const renames=[];
  if(type==="choice"||type==="multi"){
    const rows=splitList(x.options).map(o=>o&&typeof o==="object"?{was:o.was==null?null:str(o.was),now:str(o.now)}:{was:null,now:str(o)});
    const seen=new Set();
    for(const r of rows){
      const now=cleanAttrOption(r.now);
      if(r.now&&chars(tidy(r.now))>L.optionLen)return {error:`Choices can be up to ${L.optionLen} characters (${now}…).`};
      if(!now){
        if(r.was&&before&&type===before.type){const n=(usage.byOption||{})[low(r.was)]||0;if(n)return {error:`${r.was} is used by ${n} product${n===1?"":"s"}, so it can't be removed. Rename it, or change those products first.`}}
        continue;
      }
      if(seen.has(low(now)))return {error:`${now} is in the list twice.`};
      seen.add(low(now));options.push(now);
      if(r.was&&before&&type===before.type&&r.was!==now)renames.push([r.was,now]);
    }
    if(before&&type===before.type){
      // a saved choice left out of the list altogether counts as removed
      const kept=new Set(rows.filter(r=>r.was!=null).map(r=>low(r.was)));
      for(const o of before.options){if(kept.has(low(o)))continue;const n=(usage.byOption||{})[low(o)]||0;if(n)return {error:`${o} is used by ${n} product${n===1?"":"s"}, so it can't be removed. Rename it, or change those products first.`};}
    }
    if(!options.length)return {error:`Add at least one choice to ${name}.`};
    if(options.length>L.maxOptions)return {error:`A field can have up to ${L.maxOptions} choices.`};
  }
  // rules
  const out={id:str(x.id||(before&&before.id)),name,type,options,required:bool(x.required),min:null,max:null,dp:null,unit:"",maxLen:null,cats:[],archived,
    sort:Number.isFinite(+x.sort)?Math.round(+x.sort):(before?before.sort:0)};
  if(!ATTR_ID_RE.test(out.id))return {error:"That field has no valid id."};
  if(type==="number"||type==="decimal"){
    out.dp=type==="decimal"?looseNumber(x.dp==null||x.dp===""?L.defaultDp:x.dp):0;
    if(type==="decimal"&&(!Number.isInteger(out.dp)||out.dp<1||out.dp>L.maxDp))return {error:`Decimal places: 1 to ${L.maxDp}.`};
    for(const k of ["min","max"]){
      const v=looseNumber(x[k]);
      if(v==null)continue;
      if(Number.isNaN(v)||Math.abs(v)>L.maxAbs)return {error:`${k==="min"?"Lowest":"Highest"} value: enter a number.`};
      if(type==="number"&&!Number.isInteger(v))return {error:`${k==="min"?"Lowest":"Highest"} value of a whole-number field must be whole.`};
      if(type==="decimal"&&decs(v)>out.dp)return {error:`${k==="min"?"Lowest":"Highest"} value has more than ${out.dp} decimal places.`};
      out[k]=v;
    }
    if(out.min!=null&&out.max!=null&&out.min>out.max)return {error:"The lowest value is above the highest."};
    out.unit=tidy(x.unit,L.unitLen);
    if(chars(tidy(x.unit))>L.unitLen)return {error:`The unit shown after the number can be up to ${L.unitLen} characters (e.g. W, mAh, cm).`};
  }
  if(type==="text"){
    const m=looseNumber(x.maxLen==null||x.maxLen===""?L.defaultTextLen:x.maxLen);
    if(!Number.isInteger(m)||m<1||m>L.textLen)return {error:`Longest text: 1 to ${L.textLen} characters.`};
    out.maxLen=m;
  }
  const cats=[],cs=new Set();
  for(const c of splitList(x.cats)){const t=tidy(c);if(!t)continue;if(chars(t)>L.categoryLen)return {error:`Category names can be up to ${L.categoryLen} characters.`};if(!cs.has(low(t))){cs.add(low(t));cats.push(t)}}
  if(cats.length>L.maxCategories)return {error:`A field can be limited to up to ${L.maxCategories} categories.`};
  out.cats=cats;
  return {attr:out,renames};
}

/* ---------- values ---------- */
const DAY_RE=/^\d{4}-\d{2}-\d{2}$/;
const validDay=d=>DAY_RE.test(d)&&new Date(d+"T00:00:00Z").toISOString().slice(0,10)===d;
/* "2026-12-31", "31/12/2026", "31-12-2026", "31.12.2026", or an Excel day number (45291) → "yyyy-mm-dd", else null */
export function parseDay(raw){
  if(typeof raw==="number"&&Number.isInteger(raw)&&raw>20000&&raw<80000)return new Date(Date.UTC(1899,11,30)+raw*86400000).toISOString().slice(0,10);
  const t=str(raw).trim();
  if(/^\d{5}$/.test(t))return parseDay(+t);
  if(DAY_RE.test(t))return validDay(t)?t:null;
  const m=/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(t);
  if(!m)return null;
  const d=`${m[3]}-${m[2].padStart(2,"0")}-${m[1].padStart(2,"0")}`;
  return validDay(d)?d:null;
}
const YES=/^(yes|y|true|1|✓|✔)$/i, NO=/^(no|n|false|0)$/i;
const label=a=>a.name||"This field";
/* A value for field a, as typed in a form or a sheet's cell (or already a number, true/false or a list) →
   { value } | { empty: true } | { error } */
export function attrValue(attr,raw){
  const a=normalizeAttr(attr), n=label(a);
  if(raw==null||(typeof raw==="string"&&raw.trim()==="")||(Array.isArray(raw)&&!raw.length))return {empty:true};
  switch(a.type){
    case "text":{
      const t=tidy(raw);
      if(!t)return {empty:true};
      if(chars(t)>a.maxLen)return {error:`${n} can be up to ${a.maxLen} characters.`};
      return {value:t};
    }
    case "number": case "decimal":{
      let s=str(raw).trim();
      if(a.unit&&typeof raw==="string"){const u=low(a.unit);if(low(s).endsWith(u))s=s.slice(0,s.length-u.length).trim()}
      const v=looseNumber(typeof raw==="number"?raw:s);
      if(v==null)return {empty:true};
      if(Number.isNaN(v)||Math.abs(v)>L.maxAbs)return {error:`${n}: “${str(raw).slice(0,30)}” isn't a number.`};
      if(a.type==="number"&&!Number.isInteger(v))return {error:`${n} is a whole number (${str(raw).slice(0,30)} has decimals).`};
      if(a.type==="decimal"&&decs(v)>a.dp)return {error:`${n} can have up to ${a.dp} decimal place${a.dp===1?"":"s"}.`};
      if(a.min!=null&&v<a.min)return {error:`${n} can't be below ${a.min}${a.unit?" "+a.unit:""}.`};
      if(a.max!=null&&v>a.max)return {error:`${n} can't be above ${a.max}${a.unit?" "+a.unit:""}.`};
      return {value:v};
    }
    case "date":{
      const d=parseDay(raw);
      return d?{value:d}:{error:`${n}: “${str(raw).slice(0,30)}” isn't a date. Write it like 2026-12-31 or 31/12/2026.`};
    }
    case "yesno":{
      if(typeof raw==="boolean")return {value:raw};
      const t=str(raw).trim();
      if(YES.test(t))return {value:true};
      if(NO.test(t))return {value:false};
      return {error:`${n} is Yes or No (not “${t.slice(0,30)}”).`};
    }
    case "choice":{
      const t=tidy(raw), hit=a.options.find(o=>low(o)===low(t));
      return hit?{value:hit}:{error:`${n} has no choice “${t.slice(0,40)}”. ${choicesHint(a)}`};
    }
    case "multi":{
      const parts=(Array.isArray(raw)?raw:str(raw).split(/[,;|]/)).map(x=>tidy(x)).filter(Boolean), out=[];
      for(const p of parts){
        const hit=a.options.find(o=>low(o)===low(p));
        if(!hit)return {error:`${n} has no choice “${p.slice(0,40)}”. ${choicesHint(a)}`};
        if(!out.includes(hit))out.push(hit);
      }
      return out.length?{value:a.options.filter(o=>out.includes(o))}:{empty:true};
    }
  }
  return {error:`${n}: unknown kind of field.`};
}
const choicesHint=a=>a.options.length<=8?`Choose from: ${a.options.join(", ")}.`:`Add it to the field's choices first (Settings → Products & Inventory → Product fields).`;
/* A value for the person: "12.5 cm", "Yes", "Bluetooth, Wi-Fi" ("" for none) */
export function attrText(attr,v){
  if(v==null||v===""||(Array.isArray(v)&&!v.length))return "";
  const a=normalizeAttr(attr);
  if(a.type==="yesno")return v===true?"Yes":v===false?"No":str(v);
  if(Array.isArray(v))return v.map(str).join(", ");
  if((a.type==="number"||a.type==="decimal")&&typeof v==="number")return a.unit?`${v} ${a.unit}`:String(v);
  return str(v);
}
/* The value as a form field shows it: numbers without their unit, a list joined with ", " */
export const attrInput=(attr,v)=>v==null?"":Array.isArray(v)?v.join(", "):typeof v==="boolean"?(v?"yes":"no"):String(v);

/* ---------- which fields a product shows ---------- */
export const appliesTo=(attr,cat)=>{const a=normalizeAttr(attr);return !a.cats.length||a.cats.some(c=>low(c)===low(tidy(cat)))};
const order=(a,b)=>a.sort-b.sort||low(a.name).localeCompare(low(b.name));
/* The fields product p shows (cat: its category, maybe just typed): the shop's fields that apply to its category, and any
   other field (archived or for another category) it already has a value for, so nothing it has is hidden */
export function fieldsFor(attrs,p,cat){
  const vals=p&&p.attrs&&typeof p.attrs==="object"?p.attrs:{}, c=cat!=null?cat:p&&p.cat;
  return (attrs||[]).map(normalizeAttr).filter(a=>a.id&&((!a.archived&&appliesTo(a,c))||Object.prototype.hasOwnProperty.call(vals,a.id))).sort(order);
}
/* Fields that can make a product's variants (offered when an option is added) */
export const variantFields=attrs=>(attrs||[]).map(normalizeAttr).filter(a=>!a.archived&&VARIANT_TYPES.includes(a.type)).sort(order);
/* A product's values checked against its fields. typed: { [field id]: text as typed } for the fields shown (fieldsFor);
   values for fields this device doesn't know (made on another device, not downloaded yet) and for archived fields are
   kept as they are. → { attrs } (empty values left out) or { error } */
export function checkAttrs(attrs,p,typed,cat){
  const keep={}, prev=p&&p.attrs&&typeof p.attrs==="object"?p.attrs:{}, byId=new Map((attrs||[]).map(a=>[a.id,normalizeAttr(a)]));
  Object.keys(prev).forEach(k=>{const a=byId.get(k);if(!a||a.archived)keep[k]=prev[k]});
  const out={...keep};
  for(const a of fieldsFor(attrs,p,cat)){
    if(a.archived)continue;
    const raw=typed&&Object.prototype.hasOwnProperty.call(typed,a.id)?typed[a.id]:prev[a.id];
    const r=attrValue(a,raw);
    if(r.error)return {error:r.error};
    if(r.empty){if(a.required&&appliesTo(a,cat!=null?cat:p&&p.cat))return {error:`${a.name} is required for ${tidy(cat!=null?cat:p&&p.cat)||"these products"}.`};delete out[a.id];continue}
    out[a.id]=r.value;
  }
  if(Object.keys(out).length>L.maxValues)return {error:`A product can have up to ${L.maxValues} field values.`};
  return {attrs:out};
}
/* attrs as downloaded or restored: an object of plain values (anything else is dropped) */
export function cleanAttrValues(v){
  const out={};
  if(!v||typeof v!=="object"||Array.isArray(v))return out;
  Object.keys(v).forEach(k=>{
    if(!ATTR_ID_RE.test(k))return;
    const x=v[k];
    if(typeof x==="string"||typeof x==="boolean"||(typeof x==="number"&&Number.isFinite(x)))out[k]=x;
    else if(Array.isArray(x))out[k]=x.filter(y=>typeof y==="string");
  });
  return out;
}
/* Text of a product's values, for search ("cool white 9 w") */
export function attrSearchText(attrs,p){
  const vals=p&&p.attrs;if(!vals||typeof vals!=="object")return "";
  const byId=new Map((attrs||[]).map(a=>[a.id,a]));
  return Object.keys(vals).map(k=>byId.has(k)?attrText(byId.get(k),vals[k]):Array.isArray(vals[k])?vals[k].join(" "):str(vals[k])).join(" ");
}

/* ---------- usage, and renaming a choice everywhere ---------- */
/* Where field a is used: { products (with a value or an option linked to it), values, variants, byOption: { choice: n } }
   (n: products using that choice, as a value or as an option value of their variants) */
export function attrUsage(products,attr){
  const id=attr&&attr.id, out={products:0,values:0,variants:0,byOption:{}};
  if(!id)return out;
  (products||[]).forEach(p=>{
    if(!p)return;
    const hits=new Set();let any=false;
    const v=p.attrs&&p.attrs[id];
    if(v!=null&&v!==""&&!(Array.isArray(v)&&!v.length)){out.values++;any=true;(Array.isArray(v)?v:[v]).forEach(x=>hits.add(low(x)))}
    const linked=(Array.isArray(p.opts)?p.opts:[]).filter(o=>o&&o.a===id);
    if(linked.length){out.variants++;any=true;linked.forEach(o=>(o.v||[]).forEach(x=>hits.add(low(x))))}
    if(any)out.products++;
    hits.forEach(h=>{out.byOption[h]=(out.byOption[h]||0)+1});
  });
  return out;
}
/* Choice `from` of field a renamed to `to` in every product using it: its value, and the option linked to the field with
   its variants (they keep their ids, stock and codes: only the label changes). → the products that changed (new objects) */
export function renameAttrValue(products,attr,from,to){
  const id=attr&&attr.id, f=low(from), out=[];
  if(!id||!f||!str(to))return out;
  (products||[]).forEach(p=>{
    if(!p)return;
    let next=p;
    const v=p.attrs&&p.attrs[id];
    if(typeof v==="string"&&low(v)===f)next={...next,attrs:{...p.attrs,[id]:to}};
    else if(Array.isArray(v)&&v.some(x=>low(x)===f))next={...next,attrs:{...p.attrs,[id]:v.map(x=>low(x)===f?to:x)}};
    const opts=Array.isArray(p.opts)?p.opts:[];
    if(opts.some(o=>o&&o.a===id&&(o.v||[]).some(x=>low(x)===f))){
      // position in a variant's tuple: options with values only (domain/catalog/options.js)
      const pos=[];let k=0;opts.forEach(o=>{if(o&&Array.isArray(o.v)&&o.v.length){if(o.a===id)pos.push(k);k++}});
      next={...next,opts:opts.map(o=>o&&o.a===id?{...o,v:o.v.map(x=>low(x)===f?to:x)}:o),
        variants:(p.variants||[]).map(vr=>{const o=Array.isArray(vr.o)?vr.o:[];return pos.some(i=>low(o[i])===f)?{...vr,o:o.map((x,i)=>pos.includes(i)&&low(x)===f?to:x)}:vr})};
    }
    if(next!==p)out.push(next);
  });
  return out;
}
/* The values of an option linked to field a, checked: each must be a value of the field (a choice in its list, a number…)
   → { values } in the field's spelling, or { error } */
export function checkLinkedValues(attr,values){
  const a=normalizeAttr(attr),out=[];
  for(const raw of values||[]){
    const r=attrValue(a,raw);
    if(r.error)return {error:r.error};
    if(r.empty)continue;
    out.push(String(r.value));
  }
  return {values:out};
}
