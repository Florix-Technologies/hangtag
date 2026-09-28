// Event Mode: a named, dated selling occasion (a pop-up, an exhibition, a fair). A device chooses what it sells at: the
// store, or one active event. Bills made while a device sells at an event are tagged with it, and returns and exchanges
// follow their original bill, so the event's takings can be reported apart. Nothing else changes: stock, prices, GST,
// payments and the cash and bank books stay the shop's own.
//   · status "active": devices can sell at it · "closed": no new bills are tagged with it (it can be reopened)
//   · the end date is required and never before the start; selling outside the dates only warns
//   · an event with bills can't be deleted, only closed
// Pure.
export const EVENT_STATUS={ACTIVE:"active",CLOSED:"closed"};
export const STORE="store";
const DAY=/^\d{4}-\d{2}-\d{2}$/;

/* The first problem with an event's details, or null. e: { name, start, end, place } */
export function validateEvent(e){
  const name=String(e&&e.name||"").trim();
  if(!name) return "Give the event a name.";
  if(name.length>80) return "Keep the event name under 80 characters.";
  if(!DAY.test(e.start||"")) return "Choose the start date.";
  if(!DAY.test(e.end||"")) return "Choose the end date.";
  if(e.end<e.start) return "The end date can't be before the start date.";
  if(String(e.place||"").length>120) return "Keep the place under 120 characters.";
  return null;
}
/* A clean event record: { id, name, start, end, place, status, t } */
export function normalizeEvent(e){
  return {id:String(e.id),name:String(e.name||"").trim(),start:e.start,end:e.end,place:String(e.place||"").trim(),
    status:e.status===EVENT_STATUS.CLOSED?EVENT_STATUS.CLOSED:EVENT_STATUS.ACTIVE,t:+e.t||0};
}
/* What a device sells at. events: { id: event } · chosen: the device's choice (an event id, or empty for the store) ·
   today: "yyyy-mm-dd" → { event (null = the store), notice: "closed" | "missing" | null, outside: the event runs on other days } */
export function sellingContext(events,chosen,today){
  if(!chosen||chosen===STORE) return {event:null,notice:null,outside:false};
  const ev=(events||{})[chosen];
  if(!ev) return {event:null,notice:"missing",outside:false};
  if(ev.status===EVENT_STATUS.CLOSED) return {event:null,notice:"closed",closed:ev,outside:false};
  return {event:ev,notice:null,outside:!!today&&(today<ev.start||today>ev.end)};
}
/* Which bills belong to a report filter: "" everything · "store" bills made at the store · an event id that event's bills */
export const inFilter=(sale,filter)=>!filter?true:filter===STORE?!sale.event:sale.event===filter;
/* Events in the order a list shows them: active first (soonest end first), then closed (latest first) */
export function sortEvents(list){
  return (list||[]).slice().sort((a,b)=>a.status!==b.status?(a.status===EVENT_STATUS.ACTIVE?-1:1)
    :a.status===EVENT_STATUS.ACTIVE?(a.end<b.end?-1:a.end>b.end?1:0):(a.end<b.end?1:a.end>b.end?-1:0));
}
