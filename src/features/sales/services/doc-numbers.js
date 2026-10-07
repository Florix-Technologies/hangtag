// The shop's document numbers on this device (rules: domain/documents/numbering.js): bills, credit notes, quotations,
// sales orders, kitchen tickets and purchase orders, each type in its own series. This device's series (the shop's main
// series, or a till letter when another device already makes documents) is kept on the device once it has made one.
// A preview (the payment screen's "Bill INV-000128") claims nothing: only a document actually made does.
import { store } from '../../../shared/state/store.js';
import { storage } from '../../../shared/state/persistence.js';
import { DOC_PREFIXES, nextDocNo, numberingOf, tillAfterConflict, tillFor } from '../../../domain/documents/numbering.js';
import { quotePrefix } from '../../../domain/orders/orders.js';
import { D } from '../../inventory/services/ledger.js';
import { orderRepository } from '../../orders/repositories/order-repository.js';
import { bizRepository } from '../../commerce/repositories/biz-repository.js';

const TILL_KEY = "hangtag_till";
/* A document type's numbering: bills follow Settings → Bills & Documents → Bill numbering; every other type has its own
   prefix (quotations: the shop's quotation prefix) and the bills' digits and suffix, starting at 1 */
export function numberingFor(type){
  const s = store.settings || {}, bill = numberingOf({ prefix: s.prefix, start: s.invoiceStart, padding: s.invoicePadding, suffix: s.invoiceSuffix });
  if(type === "invoice") return bill;
  return { prefix: type === "quote" ? quotePrefix(s.quotePrefix) : DOC_PREFIXES[type] || "DOC-", start: 1, padding: bill.padding, suffix: bill.suffix };
}
/* Every document this device knows, of every type, with its numbering: which series other devices use */
function knownDocs(){
  const L = D(), cfg = { invoice: numberingFor("invoice"), credit: numberingFor("credit"), po: numberingFor("po") }, of = k => cfg[k] || (cfg[k] = numberingFor(k));
  const orders = (() => { try { return orderRepository().list(); } catch { return []; } })();
  const pos = (() => { try { return bizRepository().list("po"); } catch { return []; } })();
  return [
    ...L.sales.map(s => ({ no: s.no, dev: s.dev, t: s.t, cfg: of("invoice") })),
    ...L.rets.map(r => ({ no: r.no, dev: r.dev, t: r.t, cfg: of("credit") })),
    ...orders.map(o => ({ no: o.no, dev: o.dev, t: o.t, cfg: of(o.kind) })),
    ...pos.map(p => ({ no: p.no, dev: p.dev, t: p.t, cfg: of("po") })),
  ];
}
/* This device's series: "" (the shop's main series) or its till letter */
export function deviceTill(){
  const stored = storage.get(TILL_KEY, null);
  return tillFor({ stored, dev: store.dev, docs: stored == null ? knownDocs() : [] });
}
/* The number for a document of a type made at time t on this device. docs: the documents of that type ({ no }), from
   every device. claim: the document is being made now (this device then keeps its series) */
export function nextNumber(type, docs, t = Date.now(), { claim = false } = {}){
  const till = deviceTill();
  if(claim && storage.get(TILL_KEY, null) !== till) storage.set(TILL_KEY, till);
  return nextDocNo(docs, numberingFor(type), t, till);
}
/* A number this device made was refused because another device of the shop has it (both took the same series): this
   device moves to a series no other device uses, for this document and every later one. → the new till letter */
export function moveTillAfterConflict(){
  const till = tillAfterConflict(deviceTill(), { dev: store.dev, docs: knownDocs() });
  storage.set(TILL_KEY, till);
  return till;
}
