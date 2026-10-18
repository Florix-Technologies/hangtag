// One diagnostic per active download incident, followed by one recovery when that download succeeds again.
// The state is scoped to the shop/account in this tab and deliberately stays in memory: Diagnostics keeps the durable
// history, while a reload is a new attempt whose first failure should be visible.
import { store } from '../../../shared/state/store.js';
import { AppError, ERROR_CODES } from '../../../shared/errors/app-error.js';
import { logger } from '../../../shared/logging/logger.js';

export const DOWNLOAD_FAILURE_KIND = 'sync-download';
const incidents = new Map();

const accountKey = () => String((store.access && store.access.shopId) || (store.authUser && store.authUser.id) || 'local');
const accountIncidents = () => {
  const key = accountKey();
  if(!incidents.has(key)) incidents.set(key, new Set());
  return incidents.get(key);
};
const cleanParts = parts => [...new Set((Array.isArray(parts) ? parts : [parts]).map(x => String(x || '').trim().toLowerCase()).filter(Boolean))];
const detailsOf = (parts, recorded = true) => ({ kind: DOWNLOAD_FAILURE_KIND, parts: cleanParts(parts), diagnosticRecorded: recorded });

export const isReportedDownloadFailure = error => !!(error && error.details && error.details.kind === DOWNLOAD_FAILURE_KIND && error.details.diagnosticRecorded === true);

/* Returns an explicit error so callers can propagate the original failure without logging it again. log: what the
   incident's first failure records instead of the structured event (the full download keeps its own wording, which
   names the table: "Pull from Supabase failed: … (table:hangtag_meta)") */
export function downloadFailed(op, error, { level = 'warn', log } = {}){
  if(isReportedDownloadFailure(error)) return error;
  const part = cleanParts(op)[0] || 'download', active = accountIncidents();
  if(!active.has(part)){
    active.add(part);
    if(log) log(error);
    else logger.event('sync', 'download-failed', { op: part, code: error && error.code, status: error && (error.status || error.statusCode) }, level);
  }
  const code = error && error.code || ERROR_CODES.NETWORK;
  return new AppError(code, `Couldn't download ${part}.`, { cause: error, details: detailsOf([part]) });
}
/* One part of a check (orders, price lists…): → null when it came down (closing its incident, if any) or the database
   doesn't have it yet; otherwise the recorded failure, for the caller to pass on without logging it again */
export async function pullPart(pull, op){
  try{ await pull(); downloadRecovered(op); return null; }
  catch(e){
    if(e && e.code === ERROR_CODES.OUTDATED_DATABASE) return null;
    return downloadFailed(op, e, { level: 'warn' });
  }
}
/* The parts a recorded failure is about */
export const failedParts = error => error && error.details && Array.isArray(error.details.parts) ? error.details.parts : [];

/* A healthy check is quiet unless it closes an incident. */
export function downloadRecovered(op){
  const part = cleanParts(op)[0] || 'download', active = accountIncidents();
  if(!active.delete(part)) return false;
  logger.event('sync', 'download-recovered', { op: part }, 'info');
  return true;
}

/* Combines already-recorded part failures into one typed error. Missing incident records are created defensively so an
   aggregate can never suppress the only useful diagnostic. */
export function aggregateDownloadFailure(parts, message = 'Not everything was downloaded.'){
  const list = cleanParts(parts), active = accountIncidents();
  list.forEach(part => {
    if(active.has(part)) return;
    active.add(part);
    logger.event('sync', 'download-failed', { op: part, code: ERROR_CODES.NETWORK }, 'warn');
  });
  return new AppError(ERROR_CODES.NETWORK, message, { details: detailsOf(list.length ? list : ['download']) });
}

/* Test isolation only; production code never clears either incidents or the Diagnostics history. */
export const resetDownloadHealthForTests = () => incidents.clear();
