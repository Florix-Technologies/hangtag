// Generic product options (Colour, Size, Storage, RAM …): combinations, labels, matrix views, the v2 → v3 catalog
// upgrade and the product editor's option operations. Pure: no browser, no app state.
/* ================= options model =================
   Product.opts = [{ n:"Colour", v:["Black","White"] }, { n:"Size", v:["S","M"] }]   0–3 options, in display order
   Variant.o    = ["Black","M"]: one value per option. A simple product has opts:[] and one variant with o:[].
   Active variants always fit the options ("aligned"). An inactive variant kept for its history keeps the tuple it had
   (a "leftover"), even when that value or option is gone: it keeps its label, is never placed in a matrix, and is
   revived (same id, same history) when the merchant adds the value or option back.
   Values, tuples and option names compare case-insensitively. An option with no values yet takes no part in the
   combinations (the editor adds an option before its values). */

export const OPTION_LIMITS=Object.freeze({maxOptions:3,maxValues:100,maxVariants:400,nameLen:24,valueLen:40});
export const OPTION_SUGGESTIONS=Object.freeze(["Colour","Size","Storage","RAM","Weight","Capacity","Pack Size","Model","Shade","Material","Length","Style","Flavour"]);
const L=OPTION_LIMITS;

/* ---------- names and values ---------- */
const low=x=>String(x).toLowerCase();
const str=x=>x==null?"":String(x);
const chars=s=>[...s].length;   // code points: a cut never splits an emoji
function tidy(s,max,slash){
  let t=str(s).replace(/[\u0000-\u001f\u007f]/g," ").replace(/\s+/g," ").trim();
  if(slash)t=t.replace(/ ?\/ ?/g,"/");
  return max?[...t].slice(0,max).join("").trim():t;
}
/* Option name: trimmed, single spaces, at most 24 characters */
export const cleanOptionName=s=>tidy(s,L.nameLen);
/* Option value: trimmed, single spaces, no spaces around "/", at most 40 characters. With no " / " inside a value,
   the " / "-joined labels of matrix rows can never be confused ("Black/White / Cotton" vs "Black / White/Cotton"). */
export const cleanOptionValue=s=>tidy(s,L.valueLen,true);
/* Colour/size names matter only for legacy compatibility (bill line c/s, the database's color/size columns, swatches) */
export const isColourOption=name=>/^(colou?rs?|shades?)$/i.test(tidy(name));
export const isSizeOption=name=>/^sizes?$/i.test(tidy(name));

/* ---------- combinations ---------- */
/* The options that take part in combinations (those with values): values as strings, blanks and repeats (any case)
   left out; m maps each lower-case value to its listed spelling */
function liveOpts(opts){
  const out=[];
  (Array.isArray(opts)?opts:[]).forEach(op=>{
    const m=new Map();
    (op&&Array.isArray(op.v)?op.v:[]).forEach(x=>{if(x==null)return;const s=String(x),k=low(s);if(s.trim()&&!m.has(k))m.set(k,s)});
    if(m.size)out.push({n:str(op.n),v:[...m.values()],m});
  });
  return out;
}
const cross=live=>live.reduce((acc,op)=>acc.flatMap(t=>op.v.map(x=>[...t,x])),[[]]);
/* Every combination, first option slowest: [["Black","S"],["Black","M"],["White","S"],…]; [[]] with no options */
export const combos=opts=>cross(liveOpts(opts));
export const variantCount=opts=>liveOpts(opts).reduce((n,op)=>n*op.v.length,1);
/* Case-insensitive key of a value tuple (unique per product; the database enforces it too) */
export const tupleKey=o=>(Array.isArray(o)?o:[]).map(x=>String(x).toLowerCase()).join("\u0001");
/* o in the options' own spelling when it fits them (one listed value per option), else null */
function fit(live,o){
  if(!Array.isArray(o)||o.length!==live.length)return null;
  const t=[];
  for(let k=0;k<o.length;k++){const hit=o[k]==null?undefined:live[k].m.get(low(o[k]));if(hit===undefined)return null;t.push(hit)}
  return t;
}
/* true when tuple o fits the options (an active variant must; a leftover may not) */
export const isAligned=(opts,o)=>fit(liveOpts(opts),o)!==null;

/* ---------- labels and bill/return line snapshots ---------- */
export const vLabel=v=>(v&&Array.isArray(v.o)?v.o:[]).filter(Boolean).join(" / ");
/* New lines carry vl; old lines only have colour c and size s */
export const lineLabel=line=>line?line.vl||[line.c,line.s].filter(Boolean).join(" / "):"";
/* [{ n, v }] of variant v, for bill and return lines (a leftover that no longer fits: its values, names unknown) */
export function optionSnapshot(p,v){
  const live=liveOpts(p&&p.opts),o=v&&Array.isArray(v.o)?v.o:[],t=fit(live,o);
  return t?t.map((x,k)=>({n:live[k].n,v:x})):o.filter(x=>x!=null&&x!=="").map(x=>({n:"",v:String(x)}));
}
/* { c, s }: the values of the colour-named and size-named options in tuple o ("" when there is none), which old reports
   ("Pieces by size") and the database's color/size columns read */
export function legacyCS(opts,o){
  const live=liveOpts(opts),out={c:"",s:""};
  if(!Array.isArray(o)||o.length!==live.length)return out;
  const ci=live.findIndex(op=>isColourOption(op.n)),si=live.findIndex(op=>isSizeOption(op.n));
  if(ci>-1)out.c=str(o[ci]);
  if(si>-1)out.s=str(o[si]);
  return out;
}

/* ---------- matrix views (sell picker, stock grid, stock in/adjust, exchange picker) ----------
   rows = combinations of every option but the last, joined " / " ([""] with one option or none);
   cols = values of the last option ([""] with no options). Only variants that fit the options are placed. */
export function rowVals(p){const live=liveOpts(p&&p.opts);return live.length<2?[""]:cross(live.slice(0,-1)).map(t=>t.join(" / "))}
export function colVals(p){const live=liveOpts(p&&p.opts);return live.length?live[live.length-1].v.slice():[""]}
/* The row / column of variant v, as rowVals / colVals spell it; null for a leftover that doesn't fit */
export function rowKey(p,v){const live=liveOpts(p&&p.opts),t=fit(live,v&&v.o);return t?(live.length<2?"":t.slice(0,-1).join(" / ")):null}
export function colKey(p,v){const live=liveOpts(p&&p.opts),t=fit(live,v&&v.o);return t?(live.length?t[t.length-1]:""):null}
/* How many values the product's colour-named option has (0 when it has none) */
export function colourCount(p){const op=liveOpts(p&&p.opts).find(o=>isColourOption(o.n));return op?op.v.length:0}
/* true when the matrix has rows and they start with a colour (row headers then show a swatch) */
export function rowIsColour(p){const live=liveOpts(p&&p.opts);return live.length>1&&isColourOption(live[0].n)}
/* Header names: { row:"Colour / Material" | "", col:"Size" | "" } */
export function matrixNames(p){
  const live=liveOpts(p&&p.opts);
  return {row:live.length<2?"":live.slice(0,-1).map(op=>op.n).join(" / "),col:live.length?live[live.length-1].n:""};
}
/* The variant in that cell (active ones only, unless all), or null */
export function findVariant(p,row,col,all){
  const live=liveOpts(p&&p.opts),r=low(str(row)),c=low(str(col));
  let t=[];
  if(live.length){
    const x=live[live.length-1].m.get(c);
    if(x===undefined)return null;
    let pre=[];
    if(live.length>1){pre=cross(live.slice(0,-1)).find(q=>low(q.join(" / "))===r);if(!pre)return null}
    else if(r)return null;
    t=[...pre,x];
  }else if(r||c)return null;
  const key=tupleKey(t);
  return (p&&Array.isArray(p.variants)?p.variants:[]).find(v=>v&&(all||v.active!==false)&&Array.isArray(v.o)&&v.o.length===t.length&&tupleKey(v.o)===key)||null;
}
/* Tile/card text: "4 colours · 3 sizes" when the options are a colour and/or a size, else "12 variants" (for sale);
   "" for a simple product */
export function productSummary(p){
  const live=liveOpts(p&&p.opts);
  if(!live.length)return "";
  const kinds=live.map(op=>isColourOption(op.n)?(/^shade/i.test(tidy(op.n))?"shade":"colour"):isSizeOption(op.n)?"size":"");
  const colourLike=kinds.filter(k=>k==="colour"||k==="shade").length,sizes=kinds.filter(k=>k==="size").length;
  if(kinds.every(Boolean)&&colourLike<=1&&sizes<=1)return live.map((op,k)=>op.v.length+" "+kinds[k]+(op.v.length===1?"":"s")).join(" · ");
  const n=(Array.isArray(p.variants)?p.variants:[]).filter(v=>v&&v.active!==false&&fit(live,v.o)).length;
  return n+" variant"+(n===1?"":"s");
}
/* The first problem with a product's options as { error }, or null. Names and values are compared as
   cleanOptionName / cleanOptionValue leave them; every option needs a value; the limits of OPTION_LIMITS apply. */
export function checkOptions(opts){
  const list=Array.isArray(opts)?opts:[];
  if(list.length>L.maxOptions)return {error:`A product can have up to ${L.maxOptions} options.`};
  const names=new Set();
  for(let k=0;k<list.length;k++){
    const op=list[k]||{},n=cleanOptionName(op.n);
    if(!n)return {error:`Give option ${k+1} a name.`};
    if(chars(tidy(op.n))>L.nameLen)return {error:`Option names can be up to ${L.nameLen} characters (${n}…).`};
    if(names.has(low(n)))return {error:`There's already an option called ${n}.`};
    names.add(low(n));
    const vals=Array.isArray(op.v)?op.v:[],seen=new Set();
    if(!vals.length)return {error:`Add at least one value to ${n}, or remove it.`};
    if(vals.length>L.maxValues)return {error:`${n} can have up to ${L.maxValues} values.`};
    for(const x of vals){
      const v=cleanOptionValue(x);
      if(!v)return {error:`${n} has an empty value.`};
      if(chars(tidy(x,0,true))>L.valueLen)return {error:`Values can be up to ${L.valueLen} characters (${v}…).`};
      if(seen.has(low(v)))return {error:`${n} has ${v} twice.`};
      seen.add(low(v));
    }
  }
  const count=variantCount(list);
  if(count>L.maxVariants)return {error:`These options make ${count} variants. A product can have up to ${L.maxVariants}.`};
  return null;
}

/* ---------- catalog v2 → v3 ---------- */
/* Tuple o with its last value suffixed " (2)", " (3)"… ("(2)" for an empty tuple) until taken(key, tuple) is false */
function bumped(o,taken){
  for(let n=2;;n++){
    const t=o.length?[...o.slice(0,-1),(str(o[o.length-1])+" ("+n+")").trim()]:["("+n+")"];
    if(!taken(tupleKey(t),t))return t;
  }
}
const legacyVal=x=>str(x).replace(/\s+/g," ").trim();
function valueList(values){
  const out={v:[],m:new Map()};
  (Array.isArray(values)?values:[]).forEach(x=>{const s=legacyVal(x);if(s&&!out.m.has(low(s))){out.m.set(low(s),s);out.v.push(s)}});
  return out;
}
/* One product from colours/sizes (v2) to options (v3); a product that already has opts is returned as is.
   opts: Colour (p.colors) if any, then Size (p.sizes) if any; with neither list at all (a database row without
   them), the values its active variants use. A variant is aligned when it has a colour exactly when the product has
   colours, and a size exactly when it has sizes: then o = [colour][, size] in the list's spelling (values match
   case-insensitively; an active variant's value missing from the list is added to it, so nothing for sale is lost;
   an inactive one keeps its own value: a colour or size removed in the old editor stays removed). Otherwise o = its
   non-empty values and it becomes inactive (a leftover). Tuples stay unique per product: active variants claim
   theirs first, then inactive ones that fit, then the rest; a later clash gets " (2)", " (3)"… on its last value
   and is inactive. ids, SKUs, barcodes, prices and costs are kept; c, s, colors and sizes are dropped. */
export function migrateProductV3(p){
  if(!p||typeof p!=="object"||Array.isArray(p.opts))return p;
  const vs=(Array.isArray(p.variants)?p.variants:[]).filter(v=>v&&typeof v==="object");
  const noLists=!Array.isArray(p.colors)&&!Array.isArray(p.sizes),forSale=vs.filter(v=>v.active!==false);
  const C=valueList(noLists?forSale.map(v=>v.c):p.colors),S=valueList(noLists?forSale.map(v=>v.s):p.sizes);
  const hasC=C.v.length>0,hasS=S.v.length>0;
  const aligned=v=>hasC===(legacyVal(v.c)!=="")&&hasS===(legacyVal(v.s)!=="");
  const join=(list,x)=>{if(!list.m.has(low(x))){list.m.set(low(x),x);list.v.push(x)}};
  forSale.forEach(v=>{if(!aligned(v))return;if(hasC)join(C,legacyVal(v.c));if(hasS)join(S,legacyVal(v.s))});
  const rows=vs.map((v,i)=>{
    const c=legacyVal(v.c),s=legacyVal(v.s);
    if(!aligned(v))return {v,o:[c,s].filter(Boolean),active:false,rank:2,i};
    const fits=(!hasC||C.m.has(low(c)))&&(!hasS||S.m.has(low(s))),active=v.active!==false&&fits;
    const o=[...(hasC?[C.m.has(low(c))?C.m.get(low(c)):c]:[]),...(hasS?[S.m.has(low(s))?S.m.get(low(s)):s]:[])];
    return {v,o,active,rank:active?0:fits?1:2,i};
  });
  const opts=[...(hasC?[{n:"Colour",v:C.v}]:[]),...(hasS?[{n:"Size",v:S.v}]:[])],live=liveOpts(opts),seen=new Set();
  rows.slice().sort((a,b)=>a.rank-b.rank||a.i-b.i).forEach(r=>{
    if(seen.has(tupleKey(r.o))){r.o=bumped(r.o,(k,t)=>seen.has(k)||fit(live,t)!==null);r.active=false}
    seen.add(tupleKey(r.o));
  });
  const variants=rows.map(({v,o,active})=>{
    const {c:_c,s:_s,o:_o,active:_a,id,sku,bc,price,cost,...more}=v;
    return {id,o,sku:str(sku),bc:str(bc),price:price===undefined?null:price,cost:cost===undefined?null:cost,active,...more};
  });
  const {colors:_cl,sizes:_sz,variants:_vs,hsn,gst,code,...rest}=p;
  return {...rest,hsn:typeof hsn==="string"?hsn:"",gst:typeof gst==="number"&&Number.isFinite(gst)?gst:null,
    code:code===""||code==="barcode"||code==="qr"?code:(variants.some(v=>v.bc)?"barcode":""),opts,variants};
}
/* A product downloaded from the database: rows written with options keep their values (the colour/size copies are
   dropped); rows from before options existed (or from an older app version) go through the same upgrade as v2 */
export function finishDownloadedProduct(p){
  if(!p||!Array.isArray(p.opts))return migrateProductV3(p);
  return {...p,variants:(Array.isArray(p.variants)?p.variants:[]).map(v=>{const {c:_c,s:_s,...rest}=v;return rest})};
}
/* Catalog v2 → v3 (chain it after upgradeCatalog's v1 → v2). A v3 catalog, or anything that isn't a v2 catalog,
   is returned unchanged (the same object), so running it again changes nothing. */
export function migrateCatalogV3(cat){
  if(!cat||cat.version!==2||!Array.isArray(cat.products))return cat;
  return {...cat,version:3,example:!!cat.example,products:cat.products.map(migrateProductV3)};
}

/* ---------- product editor state ----------
   state = { opts, cells, …other editor fields (kept) }
   cells = { [tupleKey(o)]: { id|null, o, sku, bc, price, cost, stock, orig, active, exists } }: form fields as strings,
           exists = a saved variant. A saved cell that is not a current combination is "removed" (kept for its
           history on save, or deleted if it has none).
   The operations never change the state they get: they return a new { …state, opts, cells } or { error } (a message
   for the merchant). Option index i and value index j count from 0. */
const own=(obj,k)=>!!obj&&Object.prototype.hasOwnProperty.call(obj,k);
// defineProperty, so a value such as "__proto__" is an ordinary key
const put=(obj,k,val)=>{Object.defineProperty(obj,k,{value:val,writable:true,enumerable:true,configurable:true});return val};
const fail=error=>({error});
const at=(list,i)=>{const n=typeof i==="string"&&/^\d+$/.test(i)?+i:i;return Number.isInteger(n)&&n>=0&&n<list.length?n:-1};
const tidyOpts=opts=>(Array.isArray(opts)?opts:[]).map(op=>{const l=liveOpts([op])[0];return {n:str(op&&op.n),v:l?l.v:[]}});
const liveCount=opts=>opts.filter(op=>op.v.length).length;
// position of option i inside a tuple (options without values take no place)
const posOf=(opts,i)=>opts.slice(0,i).filter(op=>op.v.length).length;
function copyCells(cells){
  const out={};
  if(cells&&typeof cells==="object")Object.keys(cells).forEach(k=>{const c=cells[k];if(c&&typeof c==="object")put(out,k,{...c,o:Array.isArray(c.o)?c.o.slice():[]})});
  return out;
}
/* ids of the saved cells that are current combinations (for sale or not) */
function liveIds(opts,cells){
  const ids=new Set();
  combos(opts).forEach(o=>{const k=tupleKey(o);if(own(cells,k)&&cells[k]&&cells[k].exists)ids.add(cells[k].id)});
  return ids;
}
/* Give cells new tuples: moves = [[key, newTuple]] (changes cells in place). Every moving cell leaves its key first.
   Where a cell that isn't moving already has the new tuple: an unsaved one is dropped; a saved one stays and is
   revived when the moving cell is unsaved; when both are saved, mode "bump" gives the one already there a suffixed
   tuple (" (2)") and mode "error" stops with { clash:true }. */
function moveCells(cells,moves,opts,mode){
  const live=liveOpts(opts),targets=new Set(moves.map(m=>tupleKey(m[1]))),moving=moves.map(([k,o])=>[cells[k],o]);
  moves.forEach(([k])=>{delete cells[k]});
  for(const [cell,o] of moving){
    const key=tupleKey(o),there=own(cells,key)?cells[key]:null;
    if(there&&there.exists){
      if(!cell.exists)continue;
      if(mode==="error")return {clash:true};
      const b=bumped(there.o,(k,t)=>own(cells,k)||targets.has(k)||fit(live,t)!==null);
      put(cells,tupleKey(b),{...there,o:b});
    }
    put(cells,key,{...cell,o});
  }
  return {clash:false};
}
/* After an operation (changes cells in place): each combination's cell takes the options' spelling; a saved variant
   that becomes a combination again (a value or option added back) is for sale again; a combination with no saved
   variant takes a removed saved variant with the same values in another order (an option added back in a new place). */
function settle(opts,cells,before){
  const list=combos(opts),keys=new Set(list.map(tupleKey)),sig=o=>o.length+":"+o.map(low).sort().join("\u0001");
  let spare=null;
  const takeSpare=o=>{
    if(!spare){
      spare=new Map();
      Object.keys(cells).forEach(k=>{const c=cells[k];if(keys.has(k)||!c||!c.exists)return;const g=sig(c.o);if(!spare.has(g))spare.set(g,[]);spare.get(g).push(k)});
    }
    const q=spare.get(sig(o));
    return q&&q.length?q.shift():undefined;
  };
  list.forEach(o=>{
    const key=tupleKey(o);
    let cell=own(cells,key)?cells[key]:null;
    if(!cell||!cell.exists){const k=takeSpare(o);if(k!==undefined){cell={...cells[k],active:true};delete cells[k]}}
    if(!cell)return;
    if(cell.exists&&!cell.active&&!before.has(cell.id))cell={...cell,active:true};
    if(cell.o.length!==o.length||cell.o.some((x,k)=>x!==o[k]))cell={...cell,o:o.slice()};
    if(cells[key]!==cell)put(cells,key,cell);
  });
}
const done=(state,opts,cells,before)=>{settle(opts,cells,before);return {...state,opts,cells}};

export const blankCell=o=>({id:null,o:Array.isArray(o)?o.slice():[],sku:"",bc:"",price:"",cost:"",stock:"",orig:0,active:true,exists:false});
/* Editor state for product p (null for a new product); stockOf(variantId) → pieces in hand now */
export function editorState(p,stockOf){
  const live=liveOpts(p&&p.opts),opts=live.map(op=>({n:op.n,v:op.v.slice()})),cells={};
  const vs=(p&&Array.isArray(p.variants)?p.variants:[]).filter(v=>v&&typeof v==="object");
  // variants that fit claim their tuples first, so a clash in bad data never displaces one for sale
  vs.map((v,i)=>{const t=fit(live,v.o);return {v,o:t||(Array.isArray(v.o)?v.o.map(str):[]),rank:t?(v.active!==false?0:1):2,i}})
    .sort((a,b)=>a.rank-b.rank||a.i-b.i).forEach(({v,o})=>{
      if(own(cells,tupleKey(o)))o=bumped(o,(k,t)=>own(cells,k)||fit(live,t)!==null);
      const n=typeof stockOf==="function"?(+stockOf(v.id)||0):0;
      put(cells,tupleKey(o),{id:v.id,o,sku:str(v.sku),bc:str(v.bc),price:v.price==null?"":String(v.price),cost:v.cost==null?"":String(v.cost),
        stock:String(Math.max(0,n)),orig:n,active:v.active!==false,exists:true});
    });
  return {opts,cells};
}
/* [{ o, key, cell }] for every current combination, in order. Adds a blank cell to state.cells for a combination that
   has none (the one change it makes: the form edits these cell objects as the merchant types). */
export function editorCombos(state){
  const cells=state.cells||(state.cells={});
  return combos(state.opts).map(o=>{const key=tupleKey(o);return {o,key,cell:own(cells,key)&&cells[key]?cells[key]:put(cells,key,blankCell(o))}});
}
/* [{ o, key, cell }] for saved cells that are no longer a combination; each keeps its own (old) tuple */
export function removedCells(state){
  const cells=state.cells||{},keys=new Set(combos(state.opts).map(tupleKey));
  return Object.keys(cells).filter(k=>!keys.has(k)&&cells[k]&&cells[k].exists).map(k=>({o:cells[k].o,key:k,cell:cells[k]}));
}
/* A new option goes last, with no values yet (it joins the combinations with its first value) */
export function addOption(state,name){
  const opts=tidyOpts(state.opts),n=cleanOptionName(name);
  if(opts.length>=L.maxOptions)return fail(`A product can have up to ${L.maxOptions} options.`);
  if(!n)return fail("Enter an option name.");
  if(opts.some(op=>low(cleanOptionName(op.n))===low(n)))return fail(`There's already an option called ${n}.`);
  return {...state,opts:[...opts,{n,v:[]}],cells:copyCells(state.cells)};
}
export function renameOption(state,i,name){
  const opts=tidyOpts(state.opts);i=at(opts,i);
  if(i<0)return fail("That option no longer exists.");
  const n=cleanOptionName(name);
  if(!n)return fail("Enter an option name.");
  if(opts.some((op,k)=>k!==i&&low(cleanOptionName(op.n))===low(n)))return fail(`There's already an option called ${n}.`);
  opts[i]={n,v:opts[i].v};
  return {...state,opts,cells:copyCells(state.cells)};
}
/* Variants whose value for option i is its FIRST value survive (the value leaves their tuple); the others are removed */
export function removeOption(state,i){
  const opts=tidyOpts(state.opts);i=at(opts,i);
  if(i<0)return fail("That option no longer exists.");
  const op=opts[i],next=opts.filter((_,k)=>k!==i),cells=copyCells(state.cells),before=liveIds(opts,state.cells);
  if(op.v.length){
    const n=liveCount(opts),pos=posOf(opts,i),first=low(op.v[0]),moves=[];
    Object.keys(cells).forEach(k=>{const o=cells[k].o;if(o.length===n&&low(o[pos])===first)moves.push([k,o.filter((_,j)=>j!==pos)])});
    moveCells(cells,moves,next,"bump");
  }
  return done(state,next,cells,before);
}
/* names: one value, "S, M, L" (split on commas and new lines) or an array. Blank values and ones already there (any
   case) are skipped. The first value given to an option that had none joins every existing tuple, so the variants
   keep their ids, stock and codes. A removed variant whose combination comes back is revived. */
export function addValues(state,i,names){
  const opts=tidyOpts(state.opts);i=at(opts,i);
  if(i<0)return fail("That option no longer exists.");
  const op=opts[i],have=new Set(op.v.map(low)),add=[];
  (Array.isArray(names)?names:str(names).split(/[,\n]/)).forEach(x=>{const v=cleanOptionValue(x);if(v&&!have.has(low(v))){have.add(low(v));add.push(v)}});
  const cells=copyCells(state.cells);
  if(!add.length)return {...state,opts,cells};
  if(op.v.length+add.length>L.maxValues)return fail(`${op.n||"An option"} can have up to ${L.maxValues} values.`);
  const next=opts.map((o,k)=>k===i?{n:o.n,v:[...o.v,...add]}:o),count=variantCount(next);
  if(count>L.maxVariants)return fail(`That would make ${count} variants. A product can have up to ${L.maxVariants}.`);
  const before=liveIds(opts,state.cells);
  if(!op.v.length){
    const n=liveCount(opts),pos=posOf(opts,i),moves=[];
    Object.keys(cells).forEach(k=>{const o=cells[k].o;if(o.length===n)moves.push([k,[...o.slice(0,pos),add[0],...o.slice(pos)]])});
    moveCells(cells,moves,next,"bump");
  }
  return done(state,next,cells,before);
}
/* Renames the value in the option and in every tuple that has it: ids, stock, SKUs and prices stay with the variants */
export function renameValue(state,i,j,name){
  const opts=tidyOpts(state.opts);i=at(opts,i);
  if(i<0)return fail("That option no longer exists.");
  const op=opts[i];j=at(op.v,j);
  if(j<0)return fail("That value no longer exists.");
  const old=op.v[j],x=cleanOptionValue(name);
  if(!x)return fail("Enter a value.");
  if(op.v.some((y,k)=>k!==j&&low(y)===low(x)))return fail(`${op.n} already has ${x}.`);
  const next=opts.map((o,k)=>k===i?{n:o.n,v:o.v.map((y,k2)=>k2===j?x:y)}:o),cells=copyCells(state.cells);
  if(x===old)return {...state,opts:next,cells};
  const n=liveCount(opts),pos=posOf(opts,i),before=liveIds(opts,state.cells),moves=[];
  Object.keys(cells).forEach(k=>{const o=cells[k].o;if(o.length===n&&low(o[pos])===low(old))moves.push([k,o.map((y,k2)=>k2===pos?x:y)])});
  if(moveCells(cells,moves,next,"error").clash)return fail(`${x} was removed from this product earlier and is kept for its history. Add it back instead, or use another name.`);
  return done(state,next,cells,before);
}
/* Cells with that value stop being combinations (saved ones are removed, and revived if the value comes back) */
export function removeValue(state,i,j){
  const opts=tidyOpts(state.opts);i=at(opts,i);
  if(i<0)return fail("That option no longer exists.");
  const op=opts[i];j=at(op.v,j);
  if(j<0)return fail("That value no longer exists.");
  const next=opts.map((o,k)=>k===i?{n:o.n,v:o.v.filter((_,k2)=>k2!==j)}:o);
  return done(state,next,copyCells(state.cells),liveIds(opts,state.cells));
}
/* [{ o, key, cell }]: the saved variants removeValue(state, i, j) — or removeOption(state, i) when j is omitted — would
   remove, for the confirmation prompt */
export function affectedBy(state,i,j){
  const opts=tidyOpts(state.opts);i=at(opts,i);
  if(i<0||!opts[i].v.length)return [];
  const op=opts[i],pos=posOf(opts,i),cells=state.cells||{};
  let hit;
  if(j==null){const first=low(op.v[0]);hit=o=>low(o[pos])!==first}
  else{j=at(op.v,j);if(j<0)return [];const x=low(op.v[j]);hit=o=>low(o[pos])===x}
  return combos(opts).filter(hit).map(o=>{const key=tupleKey(o);return {o,key,cell:own(cells,key)?cells[key]:null}}).filter(r=>r.cell&&r.cell.exists);
}
