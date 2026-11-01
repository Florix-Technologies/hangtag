// CanonicalInvoice: the bill's one invoice PDF. It is the app's own A4 invoice document (receipts/services/doc-models.js
// invoiceModel, drawn by shared/utils/pdf.js), made once on this phone from the bill as saved, and registered once with
// the server (send-receipt "invoice"), which keeps the FIRST copy any phone registers as the bill's invoice for good. Every
// channel then uses that same file: the email attaches it, WhatsApp carries it (or its link), the SMS links to it, and
// Download and Share on this phone hand it over. Asking twice at once (two channels, a retry, another phone) gets the same
// invoice back, never a second one: the server keeps one per bill, and this phone keeps one request in flight per bill.
import { store } from '../../../shared/state/store.js';
import { use } from '../../../shared/di/services.js';
import { D } from '../../inventory/services/ledger.js';
import { invoiceModel } from '../../receipts/services/doc-models.js';
import { documentPdf } from '../../receipts/components/doc-actions.js';
import { messageDelivery } from '../repositories/delivery-service.js';
import { ERROR_CODES, userMessage } from '../../../shared/errors/app-error.js';
import { logger } from '../../../shared/logging/logger.js';

const online = () => !!store.sbClient && store.sbStatus === "connected";
const copies = {};     // sale id → this phone's copy { name, bytes } (made once per bill, then reused as it is)
const known = {};      // sale id → the registered invoice { id, number, sha256, size, filename }
const asking = {};     // sale id → the registration in flight
let unsupported = false;   // the server has no invoice PDFs (not set up, or an older function): asked once per session

/* This phone's copy of the bill's invoice PDF: made once from the bill as saved, then the same bytes every time */
export function localInvoicePdf(sid){
  if(copies[sid]) return copies[sid];
  const s = D().saleById[sid]; if(!s) return null;
  return (copies[sid] = documentPdf(invoiceModel(s)));
}
export const registeredInvoice = sid => known[sid] || null;
const base64 = bytes => { let s = ""; for(let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };
const why = e => e && e.details && e.details.error;
/* A refusal that says the server can't keep invoice PDFs (rather than this bill or this moment): the message then goes
   as before, and the app says so — it never claims a PDF went */
const noSupport = e => !!e && (e.code === ERROR_CODES.NOT_CONFIGURED || why(e) === "bad_request");

/* The bill's one invoice, registered with the server. → { invoice } once it exists; { none: true } when the server keeps
   no invoice PDFs (the message then goes without one); { error, code, temporary } when it can't be had now */
export function ensureInvoice(sid){
  if(known[sid]) return Promise.resolve({ invoice: known[sid] });
  if(unsupported) return Promise.resolve({ none: true });
  if(asking[sid]) return asking[sid];
  const run = (async () => {
    if(!online()) return { error: "You're offline. Sending needs the internet.", code: ERROR_CODES.NETWORK, temporary: true };
    if(typeof messageDelivery().invoice !== "function"){ unsupported = true; return { none: true }; }
    let f = null;
    try{ f = localInvoicePdf(sid); }
    catch(e){ logger.error("Invoice PDF couldn't be made:", e); return { error: "The bill's invoice PDF couldn't be made, so nothing was sent. Try Download PDF, or report this.", code: ERROR_CODES.UNKNOWN }; }
    if(!f) return { error: "That bill isn't on this device.", code: ERROR_CODES.VALIDATION };
    try{
      // the bill may have its invoice already (sent before, or from another phone): then this phone's copy isn't uploaded
      let r = null;
      try{ r = await messageDelivery().invoice({ saleId: sid }); }
      catch(e){ if(why(e) !== "no_invoice") throw e; }
      if(!(r && r.invoice)) r = await messageDelivery().invoice({ saleId: sid, pdf: base64(f.bytes) });
      if(!(r && r.invoice)) { unsupported = true; return { none: true }; }
      known[sid] = r.invoice;
      return { invoice: r.invoice, url: r.url || "" };
    }catch(e){
      if(noSupport(e)){ unsupported = true; return { none: true }; }
      logger.warn("Invoice PDF:", e && e.code);
      const temporary = [ERROR_CODES.NETWORK, ERROR_CODES.UNKNOWN, ERROR_CODES.AUTH].includes(e && e.code) || why(e) === "not_found";
      return { error: userMessage(e, "The bill's invoice PDF couldn't be prepared. Try again."), code: e && e.code, temporary };
    }
  })().finally(() => { delete asking[sid]; });
  return (asking[sid] = run);
}

/* The file Download and Share hand over: the bill's registered invoice — this phone's own copy when it is that file (the
   same hash), else the server's file — or, before one is registered (offline, or sending not set up), this phone's copy,
   the same document from the same saved bill. → { name, bytes } | { url, name } | null */
export async function invoicePdfFile(sid){
  const mine = localInvoicePdf(sid); if(!mine) return null;
  if(online() && !unsupported && !known[sid]) await ensureInvoice(sid);
  const reg = known[sid];
  if(!reg) return mine;
  const name = reg.filename || mine.name;
  try{ if(await use("files").sha256Hex(new Blob([mine.bytes])) === reg.sha256) return { name, bytes: mine.bytes }; }catch(e){ logger.warn("Invoice hash:", e); }
  // another phone registered the bill's invoice first: hand over that file
  try{ const r = await messageDelivery().invoice({ saleId: sid }); if(r && r.url) return { name, url: r.url }; }catch(e){ logger.warn("Invoice file:", e && e.code); }
  return { name, bytes: mine.bytes };
}
/* For the tests: forget this session's copies and answers */
export function resetInvoices(){ for(const o of [copies, known]) Object.keys(o).forEach(k => delete o[k]); unsupported = false; }
