// An owner's device catching up on what realtime missed (catch-up-core.js says when and how): the app's own upload queue,
// and the change check a team member's phone already makes (pull.js: pullShopChanges, pullOrderChanges, pullBizChanges),
// so the same row security, the same downloads and the same handling of work still waiting to upload apply. A team
// member's phone keeps its own 30-second look (connection.js memberPoll); this is for the shop owner's devices.
import { store } from '../../../shared/state/store.js';
import { ERROR_CODES } from '../../../shared/errors/app-error.js';
import { logger } from '../../../shared/logging/logger.js';
import { isMember } from '../../shop/services/access.js';
import { flushSbQueue } from './outbox.js';
import { forgetShopChanges, pullBizChanges, pullFromSupabase, pullOrderChanges, pullShopChanges } from './pull.js';
import { createCatchUp } from './catch-up-core.js';
import { aggregateDownloadFailure, failedParts, isReportedDownloadFailure, pullPart } from './download-health.js';

const isOutdated = e => !!(e && e.code === ERROR_CODES.OUTDATED_DATABASE);

const C = createCatchUp({
  now: () => Date.now(),
  eligible: () => !!(store.authUser && store.sbClient && store.sbStatus === "connected" && !isMember()),
  busy: () => !!store.syncing,
  flush: () => flushSbQueue(),
  sleep: ms => new Promise(r => setTimeout(r, ms)),
  check: async () => {
    await pullShopChanges();
    // orders, held bills and collections; price lists, purchase orders…: each noted once when it fails (a database
    // without them yet has nothing to bring: that isn't a failure)
    const orders = await pullPart(pullOrderChanges, 'orders'), biz = await pullPart(pullBizChanges, 'commerce');
    const failures = [orders, biz].filter(Boolean);
    if(failures.length) throw aggregateDownloadFailure(failures.flatMap(failedParts), "Not everything was downloaded.");
  },
  fullPull: async () => { forgetShopChanges(); return !!(await pullFromSupabase(false)); },
  isOutdated,
  warn: e => { if(!isReportedDownloadFailure(e)) logger.warn("Catching up:", e); },
});

/* reason: realtime | online | foreground | poll → whether a check ran */
export const catchUp = (reason, opts) => C.catchUp(reason, opts);
/* realtime's status callback (connection.js): a join after a drop catches up */
export const onRealtimeStatus = s => C.realtimeStatus(s);
export const resetRealtimeCatchUp = () => C.realtimeReset();
/* connected and downloaded everything (connection.js initSupabase) */
export const catchUpConnected = () => C.connected();
/* once at start-up (app/main.js): the page's events and the 5-minute look → removes them. onForeground({ hiddenFor }):
   also told each time the app is back on screen (a team member's phone has no catch-up of its own: connection.js) */
export const installCatchUp = (onForeground) => C.install({ win: window, doc: document, onForeground,
  timers: { setInterval: (f, ms) => setInterval(f, ms), clearInterval: (t) => clearInterval(t) } });
