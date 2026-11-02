// Units a product is sold in, and quantities in them. Pieces, boxes, packs and dozens are counted in whole numbers; kg and
// litres keep 3 decimals, metres 2; grams and ml are whole. Every quantity in the app (bill lines, returns, stock records)
// is rounded to at most 3 decimals and added up in thousandths, so 0.1 + 0.2 kg is 0.3 kg, never 0.30000000000000004.
// Pure.

/* id · label (the product form) · sym (after a quantity: "2.5 kg") · dp (decimals allowed) · kind · uqc (GST unit code) */
export const UNITS=[
  {id:"pcs",label:"Piece",sym:"pcs",dp:0,kind:"count",uqc:"PCS"},
  {id:"box",label:"Box",sym:"box",dp:0,kind:"count",uqc:"BOX"},
  {id:"pack",label:"Pack",sym:"pack",dp:0,kind:"count",uqc:"PAC"},
  {id:"dozen",label:"Dozen",sym:"doz",dp:0,kind:"count",uqc:"DOZ"},
  {id:"kg",label:"Kg",sym:"kg",dp:3,kind:"weight",uqc:"KGS"},
  {id:"g",label:"Gram",sym:"g",dp:0,kind:"weight",uqc:"GMS"},
  {id:"l",label:"Litre",sym:"L",dp:3,kind:"volume",uqc:"LTR"},
  {id:"ml",label:"ml",sym:"ml",dp:0,kind:"volume",uqc:"MLT"},
  {id:"m",label:"Meter",sym:"m",dp:2,kind:"length",uqc:"MTR"},
];
export const UNIT_IDS=UNITS.map(u=>u.id);
export const DEFAULT_UNIT="pcs";
/* Most decimals any quantity keeps (the database columns are NUMERIC(12,3)) */
export const QTY_DP=3;
const BY=Object.fromEntries(UNITS.map(u=>[u.id,u]));

/* ---------- the shop's own units ----------
   A shop can add units Hangtag doesn't have (Roll, Pair, Sq ft, Bundle…): { id (its code, shown after a quantity: "roll",
   "sqft"), label, dp (decimals a quantity may have, 0–3), kind ("count" or "measure"), uqc (its GST unit code), archived }.
   They are records of the shop (hangtag_units, synced like price lists). The app hands them over with setShopUnits
   whenever they load or change, so every rule here knows them; nothing else in this file keeps state. A code nobody
   defined on this device (a unit added on another phone, not downloaded yet) is shown as its code, with up to 3 decimals. */
export const GST_UQC=[["PCS","Pieces"],["NOS","Numbers"],["UNT","Units"],["SET","Sets"],["PRS","Pairs"],["DOZ","Dozens"],["BOX","Box"],["PAC","Packs"],
  ["BAG","Bags"],["BAL","Bale"],["BDL","Bundles"],["BKL","Buckles"],["BOU","Billion of units"],["BTL","Bottles"],["BUN","Bunches"],["CAN","Cans"],
  ["CTN","Cartons"],["DRM","Drums"],["GGK","Great gross"],["GRS","Gross"],["ROL","Rolls"],["TBS","Tablets"],["TUB","Tubes"],["THD","Thousands"],
  ["KGS","Kilograms"],["GMS","Grams"],["TGM","Ten grams"],["QTL","Quintal"],["TON","Tonnes"],["MTS","Metric ton"],["LTR","Litres"],["MLT","Millilitres"],
  ["KLR","Kilolitre"],["CBM","Cubic metres"],["CCM","Cubic centimetres"],["MTR","Metres"],["CMS","Centimetres"],["KME","Kilometre"],["YDS","Yards"],
  ["GYD","Gross yards"],["SQF","Square feet"],["SQM","Square metres"],["SQY","Square yards"],["UGS","US gallons"],["OTH","Others"]];
export const UQC_CODES=GST_UQC.map(u=>u[0]);
export const UNIT_CODE_RE=/^[a-z][a-z0-9]{0,11}$/;
export const UNIT_KINDS=["count","measure"];
let SHOP=[], SHOP_BY={};
const cleanShopUnit=u=>{
  if(!u||typeof u!=="object"||!UNIT_CODE_RE.test(String(u.id||""))||BY[u.id])return null;
  const dp=Math.round(+u.dp);
  return {id:u.id,label:String(u.label||u.id).replace(/\s+/g," ").trim().slice(0,20)||u.id,sym:u.id,dp:Number.isInteger(dp)&&dp>=0&&dp<=QTY_DP?dp:0,
    kind:u.kind==="measure"?"measure":"count",uqc:UQC_CODES.includes(u.uqc)?u.uqc:"OTH",archived:!!u.archived};
};
/* The shop's own units, as loaded (archived ones too: products and bill lines may still use them) */
export function setShopUnits(list){
  SHOP=(Array.isArray(list)?list:[]).map(cleanShopUnit).filter(Boolean).sort((a,b)=>a.label.localeCompare(b.label));
  SHOP_BY=Object.fromEntries(SHOP.map(u=>[u.id,u]));
}
export const shopUnits=()=>SHOP.slice();
/* The units a product can be put in now: Hangtag's, then the shop's own (not archived) */
export const allUnits=()=>[...UNITS,...SHOP.filter(u=>!u.archived)];
const generic=id=>({id,label:id,sym:id,dp:QTY_DP,kind:"count",uqc:"OTH"});

/* A unit's record. A code that isn't a unit at all (or none: products and bill lines saved before units) is a piece. */
export const unitOf=id=>BY[id]||SHOP_BY[id]||(UNIT_CODE_RE.test(String(id||""))?generic(String(id)):BY[DEFAULT_UNIT]);
export const unitId=id=>BY[id]||SHOP_BY[id]||UNIT_CODE_RE.test(String(id||""))?String(id):DEFAULT_UNIT;
/* A unit being added or changed. input: { id (its code; made from the label when empty), label, dp, kind, uqc, archived }.
   ctx: { units: the shop's units, before: the unit as saved (null for a new one), used: how many products are sold in it }.
   → { unit } or { error }. A unit in use keeps its code and decimals (products, stock and bill lines carry them). */
export function checkShopUnit(input,ctx={}){
  const x=input||{}, before=ctx.before?cleanShopUnit(ctx.before):null, all=(ctx.units||[]).map(cleanShopUnit).filter(Boolean);
  const label=String(x.label==null?"":x.label).replace(/[\u0000-\u001f\u007f]/g," ").replace(/\s+/g," ").trim();
  if(!label)return {error:"Give the unit a name, e.g. Roll or Sq ft."};
  if([...label].length>20)return {error:"A unit's name can be up to 20 characters."};
  const id=before?before.id:String(x.id||label).toLowerCase().replace(/[^a-z0-9]/g,"").slice(0,12);
  if(!UNIT_CODE_RE.test(id))return {error:"The unit's short code needs to start with a letter (letters and digits, up to 12), e.g. roll or sqft."};
  const builtIn=UNITS.find(u=>[u.id,u.sym.toLowerCase(),u.label.toLowerCase()].includes(id)||u.label.toLowerCase()===label.toLowerCase());
  if(builtIn)return {error:`Hangtag already has ${builtIn.label}: choose it under Sold by.`};
  if(!before&&all.some(u=>u.id===id))return {error:`There's already a unit with the code ${id}${all.find(u=>u.id===id).archived?" (archived: restore it instead)":""}.`};
  {const same=all.find(u=>u.id!==id&&!u.archived&&u.label.toLowerCase()===label.toLowerCase());if(same)return {error:`There's already a unit called ${same.label}.`};}
  const dp=x.dp==null||x.dp===""?0:+x.dp;
  if(!Number.isInteger(dp)||dp<0||dp>QTY_DP)return {error:`Decimals: 0 (counted, like pieces) to ${QTY_DP}.`};
  if(before&&ctx.used>0&&dp!==before.dp)return {error:`${before.label} is used by ${ctx.used} product${ctx.used===1?"":"s"}, so its decimals can't change.`};
  const uqc=x.uqc?String(x.uqc).toUpperCase():"OTH";
  if(!UQC_CODES.includes(uqc))return {error:"Choose the GST unit code from the list (Others if none fits)."};
  const kind=x.kind?String(x.kind):(dp>0?"measure":"count");
  if(!UNIT_KINDS.includes(kind))return {error:"A unit is counted or measured."};
  return {unit:{id,label,sym:id,dp,kind,uqc,archived:x.archived!=null?!!x.archived&&x.archived!=="false":!!(before&&before.archived)}};
}
export const decimalsOf=id=>unitOf(id).dp;
/* Sold in parts (kg, litres, metres): typed, not stepped by one */
export const isDecimalUnit=id=>unitOf(id).dp>0;
/* Measured rather than counted (kg, g, l, ml, m): a bill line of it is one item, whatever its quantity */
export const isMeasured=id=>unitOf(id).kind!=="count";
/* Put on a scale (weight or volume): adding it to a bill asks for the weight */
export const isWeighed=id=>{const k=unitOf(id).kind;return k==="weight"||k==="volume"};

/* A quantity rounded to dp decimals (default 3), half up, without float noise (1.0005 → 1.001, 0.1+0.2 → 0.3) */
export function roundQty(q,dp=QTY_DP){
  const n=+q; if(!Number.isFinite(n)) return 0;
  const f=10**dp, r=Math.round(Math.abs(n)*f*(1+Number.EPSILON))/f;
  return (n<0?-r:r)||0;
}
/* A typed quantity with more decimals than its unit keeps (12.5 pieces, 2.555 m) → the message for the person; "" when it
   fits. Such a quantity is refused, never rounded, so a count is never silently changed. */
export function qtyPlacesError(raw,unit){
  const u=unitOf(unit), n=+String(raw==null?"":raw).trim().replace(",","."), f=10**u.dp;
  if(!Number.isFinite(n)||Math.abs(n*f-Math.round(n*f))<=1e-6) return "";
  return u.dp?`Use at most ${u.dp} decimal place${u.dp===1?"":"s"} for ${u.sym}.`:`Use whole numbers for ${u.id===DEFAULT_UNIT?"pieces":u.sym}.`;
}
/* Quantities added up exactly (in thousandths) */
export const sumQty=list=>(list||[]).reduce((a,x)=>a+Math.round(roundQty(x)*1000),0)/1000;
/* a − b, exactly */
export const subQty=(a,b)=>(Math.round(roundQty(a)*1000)-Math.round(roundQty(b)*1000))/1000;

/* A quantity for people: at most 3 decimals, no trailing zeros ("2.5", "0.125", "3"); unit: for the same call as qtyText */
export const fmtQty=(q,unit)=>String(roundQty(q));
/* A quantity with its unit: "2.5 kg", "3 box"; pieces are just the number ("3") */
export function qtyText(q,unit){
  const u=unitOf(unit);
  return u.id===DEFAULT_UNIT?fmtQty(q,u.id):fmtQty(q,u.id)+" "+u.sym;
}
/* A price per unit: "₹40/kg" (pieces: just the price) */
export const perUnit=(priceText,unit)=>unitOf(unit).id===DEFAULT_UNIT?priceText:priceText+"/"+unitOf(unit).sym;

/* A typed quantity in a unit → { q } (rounded to the unit's decimals), or { error } (a message for the person) and, when
   there is a usable nearest value, q: that value (e.g. what is in stock). opts: { max (what is in stock), zero (0 allowed) } */
export function checkQty(raw,unit,opts){
  const u=unitOf(unit), o=opts||{}, t=String(raw==null?"":raw).trim().replace(",",".");
  const name=u.id===DEFAULT_UNIT?"pieces":u.sym;
  if(!/^\d*\.?\d*$/.test(t)||!/\d/.test(t)) return {error:u.dp?`Enter a quantity in ${u.sym}, e.g. ${u.dp===3?"0.5":"1.25"}.`:`Enter a whole number of ${name}, 1 or more.`};
  const decs=(t.split(".")[1]||"").replace(/0+$/,"").length;
  if(decs>u.dp) return {error:u.dp?`Use at most ${u.dp} decimal place${u.dp===1?"":"s"} for ${u.sym}.`:`Enter a whole number of ${name}, 1 or more.`};
  const q=roundQty(+t,u.dp);
  if(q<0||(!o.zero&&q<=0)) return {error:u.dp?`Enter more than 0 ${u.sym}.`:"Enter 1 or more. To take it off the bill, tap Remove."};
  if(o.max!=null&&q>o.max) return o.max>0?{error:`Only ${qtyText(o.max,u.id)} in stock.`,q:roundQty(o.max,u.dp)}:{error:"That one is sold out."};
  return {q};
}
export const checkUnitQty=checkQty;

/* Weights and volumes a scale may report, in grams / ml */
const MEASURES={kg:["weight",1000],g:["weight",1],lb:["weight",453.59237],lbs:["weight",453.59237],oz:["weight",28.349523125],
  l:["volume",1000],ml:["volume",1]};
/* A reading in one unit as another (kg ↔ g, lb → kg, l ↔ ml), rounded to the target unit's decimals; null when they don't
   measure the same thing (a scale in kg for a product sold by the litre) */
export function convertQty(value,from,to){
  const a=MEASURES[String(from||"").toLowerCase()], b=MEASURES[String(to||"").toLowerCase()];
  if(!a||!b||a[0]!==b[0]||!Number.isFinite(+value)) return null;
  return roundQty(+value*a[1]/b[1],BY[to]?BY[to].dp:QTY_DP);
}
