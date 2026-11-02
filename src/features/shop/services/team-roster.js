// The team by user id → { name, role, active }, so words can say who did what ("Asha: 12 bills"). From the members the
// owner last loaded on this device (More → Team), refreshed quietly once a session when Home asks for it. The names stay on
// this device, in memory only; nothing is logged.
import { store } from '../../../shared/state/store.js';
import { teamService } from './team.js';

let roster = null, lastTry = 0;
const RETRY = 5 * 60e3;
const owner = () => !(store.access && store.access.role && store.access.role !== "owner");
export const teamRoster = () => roster || {};
export const rosterKnown = () => roster !== null;
/* members: [{ userId, name, username, role, active }] (the team service's) */
export function rememberTeam(members){
  roster = Object.fromEntries((members || []).filter(m => m && m.userId && !(store.authUser && m.userId === store.authUser.id))
    .map(m => [m.userId, { name: m.name || m.username || "", role: m.role || "", active: m.active !== false }]));
}
/* For the owner, online: loads the members (at most once in five minutes) and calls done() when they arrive */
export function refreshTeamRoster(done){
  if(roster !== null || !owner() || !store.sbClient || store.sbStatus !== "connected" || Date.now() - lastTry < RETRY) return;
  lastTry = Date.now();
  Promise.resolve().then(() => teamService().members()).then(m => { rememberTeam(m); if(done) done(); }).catch(() => {});
}
