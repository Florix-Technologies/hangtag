// Purchase orders: a PO never changes stock; receiving (a purchase pointing at it) does, in parts, with serials, batches and
// decimals going through the ordinary purchase rules; more than is still to come needs "the supplier sent extra"; Smart
// reorder becomes draft POs by supplier; PO vs goods received vs supplier bill is compared automatically.
import { checkPO, discrepancies, draftsFromReorder, lastSupplierOf, openDiscrepancies, poProgress, receiveDefaults, receivingInput, checkPOBill, canMovePO } from '../../src/domain/inventory/purchase-orders.js';
import { buildPurchase } from '../../src/domain/inventory/purchase.js';

let passed = 0, failed = 0;
const check = (name, ok, info) => { if(ok) passed++; else failed++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (!ok && info !== undefined ? '  ' + JSON.stringify(info) : '')); };

const po = { id: 'po1', no: 'PO-1', supplierId: 's1', status: 'sent', items: [
  { ln: 0, p: 'cab', v: 'cab', name: 'USB cable', q: 100, price: 80, gst: 18 },
  { ln: 1, p: 'chg', v: 'chg', name: 'Charger', q: 12, price: 300, gst: 18 },
  { ln: 2, p: 'rice', v: 'rice', name: 'Rice', u: 'kg', q: 25.5, price: 50 }] };
check('a valid PO passes its checks', checkPO(po) === null, checkPO(po));
check('PO checks: supplier, lines, quantities, each product once', checkPO({ ...po, supplierId: '' }).field === 'supplier' && checkPO({ ...po, items: [] }).field === 'items'
  && checkPO({ ...po, items: [{ ...po.items[0], q: 0 }] }).field === 'qty' && checkPO({ ...po, items: [po.items[0], { ...po.items[0], ln: 9 }] }).field === 'items'
  && checkPO({ ...po, items: [{ ...po.items[1], q: 1.5 }] }).field === 'qty' && checkPO({ ...po, items: [{ ...po.items[2], q: 1.2345 }] }).field === 'qty');
check('status moves: draft → sent → closed; cancelled is final', canMovePO('draft', 'sent') && canMovePO('sent', 'closed') && !canMovePO('cancelled', 'sent') && !canMovePO('closed', 'sent'));

// nothing received: the PO alone changes nothing — no purchase points at it
let P = poProgress(po, []);
check('a PO alone adds no stock: nothing received, everything still to come', P.received === 0 && P.lines.every(l => l.remaining === l.ordered) && P.status === 'sent');
check('receiving starts at what is still to come', JSON.stringify(receiveDefaults(po, [])) === JSON.stringify({ cab: 100, chg: 12, rice: 25.5 }));

// first delivery: 40 cables and 10.25 kg rice
let rin = receivingInput(po, [], { cab: 40, rice: 10.25 }, {}, { invoiceNo: 'INV-7' });
check('a receiving session becomes ordinary purchase lines for what arrived (decimals kept)', !rin.error && rin.input.lines.length === 2 && rin.input.poId === 'po1' && rin.input.lines[1].q === '10.25' && rin.over.length === 0, rin);
const b1 = buildPurchase({ ...rin.input, id: 'pur1', lines: rin.input.lines.map(l => ({ ...l, n: l.v, dec: l.v === 'rice' ? 3 : 0 })), supplierName: 'ABC', t: 1, dev: 'D1' }, { today: '2026-10-03', purchases: [] });
check('…saved with the stock ledger\'s own records (RESTOCK at the agreed cost), pointing at the PO', !b1.error && b1.purchase.poId === 'po1' && b1.moves.length === 2 && b1.moves.every(m => m.type === 'RESTOCK' && m.imp === 'pur1') && b1.moves[0].cost === 80, b1);
P = poProgress(po, [b1.purchase]);
check('partly received: ordered, received, remaining per line', P.status === 'partial' && P.lines[0].received === 40 && P.lines[0].remaining === 60 && P.lines[2].remaining === 15.25, P.lines);
// second delivery: the rest of the cables
rin = receivingInput(po, [b1.purchase], { cab: 60 }, {}, {});
const b2 = buildPurchase({ ...rin.input, id: 'pur2', lines: rin.input.lines.map(l => ({ ...l, n: l.v })), t: 2 }, { today: '2026-10-03' });
P = poProgress(po, [b1.purchase, b2.purchase]);
check('a second session receives against the same PO', P.lines[0].remaining === 0 && P.lines[1].remaining === 12 && P.status === 'partial');
rin = receivingInput(po, [b1.purchase, b2.purchase], { cab: 5 }, {}, {});
check('the same goods again (more than is still to come) is flagged, never silently added', rin.over.length === 1 && rin.over[0].remaining === 0, rin.over);
const cancelled = { ...b2.purchase, status: 'cancelled' };
check('a cancelled receipt no longer counts as received', poProgress(po, [b1.purchase, cancelled]).lines[0].received === 40);
check('a closed or cancelled PO can\'t be received', receivingInput({ ...po, status: 'closed' }, [], { cab: 1 }).error && receivingInput({ ...po, status: 'cancelled' }, [], { cab: 1 }).error);
check('nothing typed: nothing received', !!receivingInput(po, [], {}).error);

// serial and batch lines go through the ordinary purchase rules
const tpo = { ...po, items: [{ ln: 0, p: 'ph', v: 'ph', name: 'Phone', q: 2, price: 9000 }, { ln: 1, p: 'med', v: 'med', name: 'Syrup', q: 10, price: 40 }] };
rin = receivingInput(tpo, [], { ph: 2, med: 10 }, { ph: { serials: ['SN1', 'SN2'] }, med: { batch: { no: 'B7', exp: '2027-01-31' } } });
const trk = l => l.v === 'ph' ? { tracking: 'serial' } : { tracking: 'batch', expiry: true };
const b3 = buildPurchase({ ...rin.input, id: 'pur3', lines: rin.input.lines.map(l => ({ ...l, n: l.v })), t: 3 }, { today: '2026-10-03', trackingOf: trk });
check('serials and batch + expiry come in with the receipt', !b3.error && JSON.stringify(b3.moves[0].sn) === '["SN1","SN2"]' && b3.moves[1].b === 'B7' && b3.moves[1].exp === '2027-01-31', b3);
const b4 = buildPurchase({ ...receivingInput(tpo, [], { ph: 2 }, { ph: { serials: ['SN1'] } }).input, id: 'pur4', t: 4, lines: [{ p: 'ph', v: 'ph', q: '2', cost: '9000', serials: ['SN1'], n: 'Phone' }] }, { today: '2026-10-03', trackingOf: trk });
check('a serial-tracked line needs one serial per piece', !!b4.error, b4);

// Smart reorder → drafts by supplier
const purchases = [{ id: 'a', supplierId: 's1', t: 1, lines: [{ v: 'cab' }] }, { id: 'b', supplierId: 's2', t: 5, lines: [{ v: 'cab' }, { v: 'case' }] }, { id: 'c', supplierId: 's3', t: 9, status: 'cancelled', lines: [{ v: 'cab' }] }];
check('the supplier a product was last bought from (cancelled purchases don\'t count)', lastSupplierOf('cab', purchases) === 's2' && lastSupplierOf('nope', purchases) === null);
const groups = draftsFromReorder([{ v: 'cab', p: 'cab', name: 'USB cable', q: 25, cost: 80 }, { v: 'case', p: 'case', name: 'Case', q: 18, cost: 60 }, { v: 'chg', p: 'chg', name: 'Charger', q: 12 }, { v: 'x', p: 'x', name: 'Zero', q: 0 }],
  v => lastSupplierOf(v, purchases));
check('recommended quantities grouped by supplier, unknown suppliers together last, nothing at 0', groups.length === 2 && groups[0].supplierId === 's2' && groups[0].items.length === 2
  && groups[0].items[0].q === 25 && groups[1].supplierId === null && groups[1].items[0].name === 'Charger', groups);

// PO vs goods received vs supplier bill
const rec = [{ id: 'r1', poId: 'po1', status: 'posted', lines: [{ v: 'cab', q: 100 }, { v: 'chg', q: 12 }, { v: 'rice', q: 25.5 }] }];
check('everything matches: no differences', discrepancies(po, rec, { lines: [{ v: 'cab', q: 100, price: 80, gst: 18 }, { v: 'chg', q: 12, price: 300, gst: 18 }, { v: 'rice', q: 25.5, price: 50 }] }).length === 0);
const d = discrepancies(po, [{ ...rec[0], lines: [{ v: 'cab', q: 100 }, { v: 'chg', q: 10 }, { v: 'case', q: 3 }] }],
  { lines: [{ v: 'cab', q: 100, price: 82, gst: 18 }, { v: 'chg', q: 12, price: 300, gst: 12 }, { v: 'bag', name: 'Bag', q: 1, price: 10 }] });
const kinds = d.map(x => x.kind).sort().join();
check('differences found by themselves: price, tax, quantity billed vs received, missing, unexpected (received and billed)', /price/.test(kinds) && /tax/.test(kinds) && /qty_billed/.test(kinds) && /missing/.test(kinds) && d.filter(x => x.kind === 'unexpected').length === 2, d);
check('a price difference reads like the shop says it', d.find(x => x.kind === 'price').text === 'Expected ₹80, bill ₹82');
check('accepted differences stop needing a look (the documents stay as they are)', openDiscrepancies(d, [{ key: d[0].key, action: 'accepted' }]).length === d.length - 1 && openDiscrepancies(d, [{ key: d[0].key, action: 'note', note: 'x' }]).length === d.length);
check('a typed bill needs a line with a quantity and a price', !!checkPOBill({ lines: [] }).error && checkPOBill({ no: 'B1', lines: [{ v: 'cab', q: 5, price: 80 }] }).bill.lines.length === 1 && !!checkPOBill({ lines: [{ v: 'cab', q: -1, price: 1 }] }).error);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
