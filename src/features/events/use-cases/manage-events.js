// Event Mode use cases: create or change an event, close or reopen it, delete one that has no bills, and choose what this
// device sells at. Rules: domain/events/event.js. Events are saved through the "eventRepository" port; the device's choice
// is its own preference (never uploaded).
import { EVENT_STATUS, STORE, normalizeEvent, validateEvent } from '../../../domain/events/event.js';
import { store } from '../../../shared/state/store.js';
import { D } from '../../inventory/services/ledger.js';
import { eventRepository } from '../repositories/event-repository.js';
import { flushSbQueue } from '../../sync/services/outbox.js';
import { savePrefs } from '../../../shared/state/persistence.js';
import { uid } from '../../../shared/utils/ids.js';

/* How many bills are tagged with an event (on this device's copy of the shop's bills) */
export const eventBillCount=id=>D().sales.filter(s=>s.event===id).length;

/* e: { id? (to change one), name, start, end, place } → { event } or { error } */
export function saveEvent(e){
  const bad=validateEvent(e); if(bad) return {error:bad};
  const old=e.id?eventRepository().get(e.id):null;
  if(e.id&&!old) return {error:"That event isn't here any more."};
  const ev=normalizeEvent({...(old||{}),...e,id:old?old.id:"e"+uid(),status:old?old.status:EVENT_STATUS.ACTIVE,t:old?old.t:Date.now()});
  eventRepository().save(ev); flushSbQueue();
  return {event:ev};
}
/* Close (no more bills tagged with it) or reopen an event → { event } or { error } */
export function setEventStatus(id,status){
  const old=eventRepository().get(id); if(!old) return {error:"That event isn't here any more."};
  const ev={...old,status:status===EVENT_STATUS.CLOSED?EVENT_STATUS.CLOSED:EVENT_STATUS.ACTIVE};
  eventRepository().save(ev);
  if(ev.status===EVENT_STATUS.CLOSED&&store.prefs.event===id){ store.prefs.event=STORE; savePrefs(); }
  flushSbQueue();
  return {event:ev};
}
/* Delete an event: only one without bills (close it otherwise) → { ok } or { error } */
export function deleteEvent(id){
  if(!eventRepository().get(id)) return {error:"That event isn't here any more."};
  const n=eventBillCount(id);
  if(n) return {error:`This event has ${n} bill${n===1?"":"s"}, so it can't be deleted. Close it instead.`};
  eventRepository().remove(id);
  if(store.prefs.event===id){ store.prefs.event=STORE; savePrefs(); }
  flushSbQueue();
  return {ok:true};
}
/* What this device sells at: an active event's id, or "store" → { ok } or { error } */
export function setSellingAt(id){
  if(id&&id!==STORE){
    const ev=eventRepository().get(id);
    if(!ev) return {error:"That event isn't here any more."};
    if(ev.status!==EVENT_STATUS.ACTIVE) return {error:"That event is closed. Reopen it first."};
  }
  store.prefs.event=id||STORE; savePrefs();
  return {ok:true};
}
