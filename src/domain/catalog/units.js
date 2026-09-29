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

/* A unit's record; anything unknown (or missing: products and bill lines saved before units) is a piece */
export const unitOf=id=>BY[id]||BY[DEFAULT_UNIT];
export const unitId=id=>BY[id]?id:DEFAULT_UNIT;
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
