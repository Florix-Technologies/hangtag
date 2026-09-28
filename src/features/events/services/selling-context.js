// What this device is selling at (its own choice, kept in its preferences: each phone at a stall chooses the event, the
// shop's own phone keeps selling at the store). The rules are in domain/events/event.js.
import { sellingContext } from '../../../domain/events/event.js';
import { store } from '../../../shared/state/store.js';
import { dayKey } from '../../../shared/formatting/dates.js';

export const currentSelling=()=>sellingContext(store.events,store.prefs&&store.prefs.event,dayKey(Date.now()));
/* The event a new bill is tagged with, or null (the store). A closed or removed event never tags a bill. */
export const sellingEventId=()=>{const c=currentSelling();return c.event?c.event.id:null};
