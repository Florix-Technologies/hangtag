// Restaurant / hotel: tables, their sessions (guests seated at a table until their bill is paid) and the kitchen. Pure.
// Nothing here is a second billing engine: a table's orders are orders of kind "table" (domain/orders/orders.js: new →
// accepted → preparing → ready → served, or cancelled), never touching stock; the bill is the ordinary bill (checkout:
// discounts, GST, payments, receipt), and paying it closes the table's session.
//   table    { id, name ("T01"), area, seats, sort, active, qr (token of its QR code: identifies the shop and the table only) }
//   session  { id, table, status: open | billing | closed, t (opened), closedT, sale (the bill that closed it), guests, user, dev }
import { normalizeDiscount } from '../sales/discounts.js';
import { roundQty } from '../catalog/units.js';

export const TABLE_STATES={available:"Available",occupied:"Occupied",preparing:"Preparing",ready:"Ready",billing:"Billing"};
export const TABLE_STATE_KEYS=Object.keys(TABLE_STATES);
/* The kitchen's steps, in order (cancelled is not a step: any order not yet served can be cancelled) */
export const KITCHEN_FLOW=["new","accepted","preparing","ready","served"];
export const KITCHEN_LABELS={new:"New",accepted:"Accepted",preparing:"Preparing",ready:"Ready",served:"Served",cancelled:"Cancelled"};
/* The next step of a kitchen ticket (null when served / cancelled) */
export const nextKitchenStep=st=>{const i=KITCHEN_FLOW.indexOf(st);return i>-1&&i<KITCHEN_FLOW.length-1?KITCHEN_FLOW[i+1]:null};
/* Moves the kitchen may make: forward only (a step can be skipped: new → ready), or cancelled while not served */
export function kitchenMoveOk(from,to){
  if(from===to) return true;
  if(to==="cancelled") return from!=="served"&&from!=="cancelled";
  const a=KITCHEN_FLOW.indexOf(from), b=KITCHEN_FLOW.indexOf(to);
  return a>-1&&b>a;
}
export const MAX_TABLES=300;
const clean=(s,max)=>String(s==null?"":s).replace(/[\u0000-\u001f\u007f]/g," ").trim().replace(/\s+/g," ").slice(0,max||200);
/* A table as typed → { table } or { error, field }. others: the shop's tables (a name is used once among those in use) */
export function checkTable(input,others=[]){
  const x=input||{}, name=clean(x.name,40);
  if(!name) return {error:"Give the table a name or number, like T1 or Garden 2.",field:"name"};
  if(name.length>20) return {error:"A table's name can be at most 20 characters.",field:"name"};
  const same=(others||[]).find(o=>o&&o.id!==x.id&&o.active!==false&&clean(o.name).toLowerCase()===name.toLowerCase());
  if(same) return {error:`There's already a table called ${same.name}.`,field:"name"};
  const seatsRaw=String(x.seats==null?"":x.seats).trim(), seats=seatsRaw===""?null:Number(seatsRaw);
  if(seats!=null&&(!Number.isInteger(seats)||seats<1||seats>99)) return {error:"Seats: a whole number from 1 to 99, or leave it empty.",field:"seats"};
  const area=clean(x.area,60); if(area.length>30) return {error:"The area can be at most 30 characters.",field:"area"};
  if(!x.id&&(others||[]).filter(o=>o&&o.active!==false).length>=MAX_TABLES) return {error:`A shop can have up to ${MAX_TABLES} tables.`};
  return {table:{id:x.id,name,area,seats,sort:Number.isFinite(+x.sort)?+x.sort:0,active:x.active!==false,qr:x.qr||""}};
}
/* A QR token: what a table's QR code carries (43 characters, base64url of 32 random bytes) */
export const QR_TOKEN_RE=/^[A-Za-z0-9_-]{32,64}$/;
export const tokenFromBytes=bytes=>{let s="";for(const b of bytes)s+=String.fromCharCode(b);return (typeof btoa==="function"?btoa(s):"").replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"")};
/* The address a table's QR opens: the shop's ordering page with the token after "#" (it never reaches a server log) */
export const tableOrderUrl=(pageUrl,token)=>pageUrl&&token?String(pageUrl).split("#")[0]+"#t="+token:"";
/* A natural order for tables: by their sort number, then name with numbers in order (T2 before T10) */
export const tableOrder=(a,b)=>(+a.sort||0)-(+b.sort||0)||String(a.name).localeCompare(String(b.name),undefined,{numeric:true,sensitivity:"base"});

/* ---------- sessions and the state of a table ---------- */
export const liveSession=s=>!!s&&(s.status==="open"||s.status==="billing");
/* A table's sessions still going (not closed), oldest first — two tills seating the same table offline both count */
export const liveSessionsOf=(sessions,tableId)=>(sessions||[]).filter(s=>s&&s.table===tableId&&liveSession(s)).sort((a,b)=>(a.t||0)-(b.t||0));
/* The state of a table from its live sessions and their orders (cancelled orders don't count):
   billing (its bill is being taken) > ready (food waiting to be served) > preparing (the kitchen has orders) > occupied
   (guests seated) > available */
export function tableState(sessions,orders,hasKitchen=true){
  const live=(sessions||[]).filter(liveSession);
  if(!live.length) return "available";
  if(live.some(s=>s.status==="billing")) return "billing";
  if(!hasKitchen) return "occupied";
  const os=(orders||[]).filter(o=>o&&o.status!=="cancelled");
  if(os.some(o=>o.status==="ready")) return "ready";
  if(os.some(o=>["new","accepted","preparing"].includes(o.status))) return "preparing";
  return "occupied";
}
/* The bill of a table: every line of its orders that weren't cancelled, the same item at the same price and discount
   put together (2 + 1 masala dosa = 3), at the orders' prices. → [{ v, p, name, vl, q, price, disc? }] */
export function sessionBillLines(orders){
  const out=[], key=l=>[l.v,+l.price,l.u||"",l.gst==null?"":+l.gst,JSON.stringify(normalizeDiscount(l.disc)||null)].join("|"), at={};
  (orders||[]).filter(o=>o&&o.kind==="table"&&o.status!=="cancelled").sort((a,b)=>(a.t||0)-(b.t||0)).forEach(o=>(o.items||[]).forEach(l=>{
    if(!l.v||!(+l.q>0)) return;
    const k=key(l);
    if(at[k]!=null){ out[at[k]].q=roundQty(out[at[k]].q+ +l.q); return; }
    const d=normalizeDiscount(l.disc);
    at[k]=out.length; out.push({v:l.v,p:l.p,name:l.name,vl:l.vl||"",q:roundQty(+l.q),price:+l.price,...(l.u&&l.u!=="pcs"?{u:l.u}:{}),...(l.gst!=null?{gst:+l.gst}:{}),...(d?{disc:d}:{})});
  }));
  return out;
}
/* The kitchen's tickets: table orders not yet served nor cancelled, oldest first, by step */
export function kitchenTickets(orders){
  const by={new:[],accepted:[],preparing:[],ready:[]};
  (orders||[]).filter(o=>o&&o.kind==="table"&&by[o.status]).sort((a,b)=>(a.t||0)-(b.t||0)).forEach(o=>by[o.status].push(o));
  return by;
}

/* ---------- ordering from the table's QR (the public page, and the database's check of it) ---------- */
export const MAX_QR_LINES=50, MAX_QR_QTY=50;
/* A guest's order → { items: [{ v, q, note? }] } or { error } */
export function checkGuestOrder(lines){
  const items=(lines||[]).filter(l=>l&&l.v&&+l.q>0);
  if(!items.length) return {error:"Add something to your order first."};
  if(items.length>MAX_QR_LINES) return {error:`An order can have up to ${MAX_QR_LINES} different items.`};
  if(new Set(items.map(l=>String(l.v))).size!==items.length) return {error:"Choose each menu item only once."};
  for(const l of items){
    const q=+l.q;
    if(!Number.isFinite(q)||q<=0||q>MAX_QR_QTY||Math.abs(q*1000-Math.round(q*1000))>1e-6) return {error:`Choose from 1 to ${MAX_QR_QTY} of each item.`};
  }
  return {items:items.map(l=>({v:String(l.v),q:roundQty(+l.q),...(clean(l.note,120)?{note:clean(l.note,120)}:{})}))};
}
