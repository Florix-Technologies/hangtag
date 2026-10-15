// What changed on this device while a download was on its way. A download reads the cloud at one moment: an upload that
// lands after that moment, or another device's change that realtime brings after it, isn't in what it brings back — and
// replacing this device's copy with it would lose that change here (a stock move gone, so the stock wrong, a return or a
// bill missing, a deleted record back) until the next download. So each download notes when it begins (beginPull), keeps
// this device's copy of every record noted after that (changedSince), and never replaces what a download of the same part
// that began after it has already brought (mayApply).
// Counted in steps, not by the clock: a clock set back can't make a later change look earlier.
import { itemKey } from '../../../domain/sync/queue-rules.js';

const KEEP = 2000;   // notes kept: far more than can change during the longest download
const notes = [];    // { key: "move:<id>" | "biz:pl:<id>" | "settings:" …, step }
const started = {}, applied = {};
let step = 0;

/* a record changed here after the cloud may have been read: uploaded (outbox.js), or another device's change applied
   from realtime (remote-events.js). key: "<type>:<id>", as the upload queue names records (queue-rules.js itemKey) */
export function noteChange(key){
  if(!key) return;
  notes.push({ key, step: ++step });
  if(notes.length > KEEP) notes.splice(0, notes.length - KEEP);
}
/* an upload the cloud took (one that isn't a single record — the settings, the logo, a photo — by its kind) */
export const noteSent = item => item && item.type && noteChange(itemKey(item) || item.type + ":" + (item.id || item.kind || ""));
/* a download of part begins, before it asks the cloud → { part, since, ticket } */
export function beginPull(part){
  started[part] = (started[part] || 0) + 1;
  return { part, since: step, ticket: started[part] };
}
/* the ids of the records of a type ("move", "biz:pl", "settings"…) noted after download g began */
export function changedSince(type, g){
  const ids = new Set(), pre = type + ":";
  if(g) for(const n of notes) if(n.step > g.since && n.key.startsWith(pre)) ids.add(n.key.slice(pre.length));
  return ids;
}
/* may download g replace this device's copy of its part? Not when a download of the same part that began after it has
   already done so (it read the cloud later) */
export function mayApply(g){
  if(g.ticket < (applied[g.part] || 0)) return false;
  applied[g.part] = g.ticket;
  return true;
}
