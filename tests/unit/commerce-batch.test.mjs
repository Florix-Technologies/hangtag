// The commerce batch's rules: kits (availability from components, saved as component lines that add up exactly, returns
// restore components), partial fulfilment of sales orders (no double counting), e-invoice / e-way bill payloads (only
// what is missing is asked; never an IRN or EWB number), repack (quantity and value reconcile), gift vouchers (a way to
// pay, codes, balances) and the upload queue's handling of the batch's records.
import { checkBundle, demandOf, explodeKits, groupByKit, kitPriceError, kitSnapshot, kitsAvailable } from '../../src/domain/catalog/bundles.js';
import { computeCheckout } from '../../src/domain/sales/checkout-totals.js';
import { CUSTOMER_LABELS, customerStage, fulfil, fulfilmentPlan, orderCartLines, soldFromOrder } from '../../src/domain/orders/orders.js';
import { einvoiceApplies, einvoicePayload, einvoiceRecord, einvoiceState } from '../../src/domain/gst/einvoice.js';
import { cleanVehicle, ewayApplies, ewayPayload, ewayState, transportFieldsNeeded, vehicleOk } from '../../src/domain/gst/eway.js';
import { cleanRepacks, repackPlan } from '../../src/domain/inventory/repack.js';
import { checkIssue, normCode, redeemable, voucherCode, voucherPartError, voucherState } from '../../src/domain/sales/vouchers.js';
import { settlePayments, payLabel } from '../../src/domain/sales/payments.js';
import { BIZ_UPLOAD_PERMISSIONS, dependsOn, itemKey, mergeIntoQueue, uploadAllowed } from '../../src/domain/sync/queue-rules.js';
import { CAP_KEYS, capsFor, defaultCaps } from '../../src/domain/shop/capabilities.js';

let passed = 0, failed = 0;
const check = (name, ok, info) => { if(ok) passed++; else failed++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (!ok && info !== undefined ? '  ' + JSON.stringify(info) : '')); };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/* ---------- kits ---------- */
const cat = { A: { p: { id: 'pa', name: 'Phone case', unit: 'pcs' }, v: { id: 'A' } }, B: { p: { id: 'pb', name: 'Charger', unit: 'pcs' }, v: { id: 'B' } },
  S: { p: { id: 'ps', name: 'Phone', unit: 'pcs', tracking: 'serial' }, v: { id: 'S' } }, K: { p: { id: 'pk', name: 'Kit', unit: 'pcs', bundle: [{ v: 'A', q: 1 }] }, v: { id: 'K' } },
  R: { p: { id: 'pr', name: 'Rice', unit: 'kg' }, v: { id: 'R' } } };
const look = v => cat[v] || null, trk = p => p.tracking || 'none';
check('kit availability = the fewest kits the components allow (A×2 with 10, B×1 with 3 → 3)', kitsAvailable([{ v: 'A', q: 2 }, { v: 'B', q: 1 }], v => ({ A: 10, B: 3 })[v]) === 3);
check('…a missing component means no kit; decimals work', kitsAvailable([{ v: 'A', q: 2 }, { v: 'B', q: 1 }], v => ({ A: 10, B: 0 })[v]) === 0 && kitsAvailable([{ v: 'R', q: 0.5 }], () => 2.25) === 4);
check('kit checks: name, price, items; no kit in a kit, no serial items, no item twice', checkBundle({ id: 'n', name: '', price: 10, bundle: [{ v: 'A', q: 1 }] }, look, trk).field === 'name'
  && checkBundle({ id: 'n', name: 'K', price: 0, bundle: [{ v: 'A', q: 1 }] }, look, trk).field === 'price'
  && checkBundle({ id: 'n', name: 'K', price: 10, bundle: [] }, look, trk).field === 'bundle'
  && /kit itself/.test(checkBundle({ id: 'n', name: 'K', price: 10, bundle: [{ v: 'K', q: 1 }] }, look, trk).error)
  && /serial/.test(checkBundle({ id: 'n', name: 'K', price: 10, bundle: [{ v: 'S', q: 1 }] }, look, trk).error)
  && /twice/.test(checkBundle({ id: 'n', name: 'K', price: 10, bundle: [{ v: 'A', q: 1 }, { v: 'A', q: 2 }] }, look, trk).error)
  && checkBundle({ id: 'n', name: 'K', price: 10, bundle: [{ v: 'A', q: 1 }, { v: 'B', q: 2 }] }, look, trk) === null);
const snap = kitSnapshot([{ v: 'A', q: 1 }, { v: 'B', q: 2 }], v => ({ p: cat[v].p.id, name: cat[v].p.name, price: v === 'A' ? 300 : 450, cost: 100 }));
check('a kit line carries its items as they are now', snap.kit.length === 2 && snap.kit[1].q === 2 && snap.kit[1].price === 450);
check('a kit dearer than its items is refused (its price is shared out as a discount)', !!kitPriceError(1300, snap.kit) && kitPriceError(1100, snap.kit) === null);
const kitLine = { v: 'K', p: 'pk', name: 'Phone starter kit', q: 3, price: 1100, kit: snap.kit };
const X = explodeKits([kitLine, { v: 'R', p: 'pr', name: 'Rice', q: 1.5, price: 60 }], () => 18);
check('a kit line becomes its component lines (quantities × kits), others stay', X.lines.length === 3 && X.lines[0].v === 'A' && X.lines[0].q === 3 && X.lines[1].q === 6 && X.lines[2].v === 'R' && X.lines[0].kit.name === 'Phone starter kit' && X.lines[0].kit.n === 3);
const sumNet = ls => ls.reduce((a, l) => a + Math.round(l.q * l.price * 100) - Math.round((l.disc ? l.disc.value : 0) * 100), 0);
check('the component lines come to exactly the kit price (3 × ₹1,100), with fixed discounts', sumNet(X.lines.slice(0, 2)) === 330000 && X.lines[0].disc.type === 'fixed' && X.lines.slice(0, 2).every(l => l.gst === 18), X.lines);
const gst = { mode: 'intra', inclusive: false };
const T1 = computeCheckout({ lines: X.lines.map(l => ({ q: l.q, price: l.price, disc: l.disc, rate: l.gst || 0 })), gst });
check('the bill calculation on the component lines is consistent (taxable = kit price + rice)', T1.taxable === 3300 + 90, T1);
const odd = explodeKits([{ ...kitLine, q: 1, price: 999.99, disc: { type: 'percent', value: 10 } }]);
check('odd prices and a discount on the kit line still add up to the paisa', sumNet(odd.lines) === Math.round(99999 * 0.9), odd.lines);
check('what a bill needs of each item counts kits as their items', eq(demandOf([kitLine, { v: 'A', q: 1 }]), { A: 4, B: 6 }));
const grouped = groupByKit(X.lines);
check('saved lines group back into their kit for the receipt', grouped.length === 2 && grouped[0].kit.name === 'Phone starter kit' && grouped[0].lines.length === 2 && grouped[1].kit === null);
check('a kit dearer than its items at sale time is refused at checkout', !!explodeKits([{ ...kitLine, price: 1300 }]).error);
// returns restore components: a return is of the bill's lines, which are the components
const saleItems = X.lines.map((l, k) => ({ ...l, ln: k }));
check('returning a kit returns its component lines (each restocks its own item)', saleItems.filter(i => i.kit && i.kit.v === 'K').map(i => i.v).join() === 'A,B');

/* ---------- partial fulfilment ---------- */
const so = { id: 'o1', kind: 'sales', status: 'confirmed', items: [{ ln: 0, v: 'A', name: 'Case', q: 10, fq: 0, price: 300 }, { ln: 1, v: 'B', name: 'Charger', q: 2, fq: 0, price: 450 }] };
let plan = fulfilmentPlan(so, v => ({ A: 6, B: 5 })[v]);
check('10 ordered, 6 in stock → 6 now, 4 remaining (no separate backorder)', plan.lines[0].now === 6 && plan.lines[0].later === 4 && plan.now === 8 && plan.later === 4 && plan.canFulfil);
const cl = orderCartLines(so, v => ({ A: 6, B: 5 })[v]);
check('the bill gets only what is in stock, at the order\'s prices', cl.lines[0].q === 6 && cl.lines[0].short === 4 && cl.lines[1].q === 2 && cl.lines[0].price === 300);
const sale1 = { id: 's1', items: [{ ord: 'o1', oln: 0, q: 6 }, { ord: 'o1', oln: 1, q: 2 }] };
let o2 = fulfil(so, soldFromOrder(sale1, 'o1'), 's1', 1);
check('after the first bill: partly fulfilled, 4 still to deliver', o2.status === 'partial' && o2.items[0].fq === 6 && o2.items[1].fq === 2);
plan = fulfilmentPlan(o2, () => 10);
check('later fulfilment against the same order', plan.lines[0].now === 4 && plan.lines[1].now === 0 && plan.later === 0);
const o3 = fulfil(o2, { 0: 4 }, 's2', 2);
check('…completes it; delivering more than ordered is never counted', o3.status === 'completed' && fulfil(o3, { 0: 5 }, 's3', 3).items[0].fq === 10);
check('a kit\'s component lines deliver the kit once (not once per item)', eq(soldFromOrder({ items: [{ ord: 'o9', oln: 0, q: 2, kit: { v: 'K', n: 2 } }, { ord: 'o9', oln: 0, q: 4, kit: { v: 'K', n: 2 } }] }, 'o9'), { 0: 2 }));
check('what the customer sees: Confirmed → Partially ready → Ready → Completed', customerStage(so) === 'confirmed' && customerStage(o2) === 'partial' && customerStage(o3) === 'ready'
  && customerStage(o3, { paid: true }) === 'completed' && CUSTOMER_LABELS.partial === 'Partially ready' && customerStage({ ...so, status: 'cancelled' }) === 'cancelled');

/* ---------- e-invoice ---------- */
const settings = { taxOn: true, einv: { on: true, pin: '411001' }, eway: { on: true, threshold: 50000 } };
const shop = { shop_name: 'Aura Electronics', gstin: '27ABCDE1234F1Z5', address: '12 MG Road, Camp', city: 'Pune', state: 'Maharashtra', phone: '9876543210' };
const buyer = { id: 'c1', name: 'Kiran Traders', gstin: '29AAACK1234M1Z2', phone: '9988776655', addr: { line: '4 Market St', city: 'Bengaluru', pin: '560001', state: 'Karnataka' } };
const sale = { id: 's9', no: 'INV-2610-A1', t: Date.UTC(2026, 9, 3, 5), kind: 'sale', total: 59000, roundOff: 0, cgst: 0, sgst: 0, igst: 9000, cust: { id: 'c1', name: 'Kiran Traders', gstin: buyer.gstin },
  items: [{ p: 'ph', n: 'Phone', vl: '128 GB', q: 2, price: 25000, u: 'pcs', gst: 18, hsn: '8517', tx: 50000, igst: 9000, cgst: 0, sgst: 0, lt: 59000, dAmt: 0, bdAmt: 0 }] };
const ctx = { shop, settings, customer: buyer, products: () => null };
check('e-invoice applies to a business bill of a shop that switched it on (and the rule is the shop\'s)', einvoiceApplies(sale, settings) && !einvoiceApplies({ ...sale, cust: { name: 'Walk-in' } }, settings)
  && einvoiceApplies({ ...sale, cust: { name: 'X' } }, { ...settings, einv: { on: true, b2bOnly: false } }) && !einvoiceApplies(sale, { ...settings, einv: { on: false } }));
let E = einvoicePayload(sale, ctx);
check('a complete bill: ready, nothing to ask', E.missing.length === 0 && E.problems.length === 0 && einvoiceState(sale, ctx, null).state === 'ready', E);
check('the payload carries the standard fields from the bill, shop and customer', E.payload.Version === '1.1' && E.payload.SellerDtls.Gstin === shop.gstin && E.payload.BuyerDtls.Gstin === buyer.gstin
  && E.payload.BuyerDtls.Pos === '29' && E.payload.DocDtls.Dt === '03/10/2026' && E.payload.ItemList[0].HsnCd === '8517' && E.payload.ItemList[0].Unit === 'PCS'
  && E.payload.ItemList[0].IgstAmt === 9000 && E.payload.ValDtls.TotInvVal === 59000 && E.payload.ValDtls.AssVal === 50000);
E = einvoicePayload({ ...sale, cust: { id: 'c1', name: 'Kiran Traders' } }, { ...ctx, customer: { id: 'c1', name: 'Kiran Traders' } });
check('only what is missing is asked: the buyer\'s GSTIN and address', E.missing.map(m => m.key).join() === 'buyer_gstin,buyer_address,buyer_city,buyer_pin' && E.missing.every(m => m.where === 'customer'), E.missing);
check('…the GSTIN typed on the bill counts even if the customer record has none', !einvoicePayload(sale, { ...ctx, customer: { id: 'c1', name: 'Kiran Traders' } }).missing.some(m => m.key === 'buyer_gstin'));
E = einvoicePayload({ ...sale, items: [{ ...sale.items[0], hsn: '' }] }, { ...ctx, shop: { ...shop, address: '' } });
check('…a missing HSN or shop address is asked of the product / shop', E.missing.some(m => m.key === 'hsn:ph' && m.where === 'product') && E.missing.some(m => m.key === 'seller_address'));
check('a wrong tax split is spotted (inter-state bill with CGST + SGST)', einvoicePayload({ ...sale, items: [{ ...sale.items[0], igst: 0, cgst: 4500, sgst: 4500 }], igst: 0, cgst: 4500, sgst: 4500 }, ctx).problems.some(p => /IGST/.test(p)));
check('never an IRN from the app: only ready / pending / not needed can be kept', !!einvoiceRecord(sale, {}, 'generated').error && einvoiceRecord(sale, {}, 'ready').record.status === 'ready' && !('irn' in einvoiceRecord(sale, {}, 'ready').record));
check('a provider\'s answer shows as it is', einvoiceState(sale, ctx, { status: 'generated', irn: 'x'.repeat(64) }).state === 'generated');

/* ---------- e-way bill ---------- */
check('e-way applies from the shop\'s own limit', ewayApplies(sale, settings) && !ewayApplies({ ...sale, total: 49999 }, settings) && ewayApplies({ ...sale, total: 20000 }, { eway: { on: true, threshold: 10000 } }));
let W = ewayPayload(sale, { ...ctx, transport: {} });
check('without transport: only the transport is asked (vehicle, distance)', transportFieldsNeeded(W.missing).join() === 'distance,vehicle' && W.missing.every(m => m.where === 'transport'));
W = ewayPayload(sale, { ...ctx, transport: { mode: 'road', vehicle: 'mh 12 ab 1234', distance: 840 } });
check('with the vehicle and distance: ready, with the standard payload', W.missing.length === 0 && W.payload.vehicleNo === 'MH12AB1234' && W.payload.transMode === '1' && W.payload.toGstin === buyer.gstin
  && W.payload.fromPincode === 411001 && W.payload.toPincode === 560001 && W.payload.itemList[0].igstRate === 18 && W.payload.totInvValue === 59000);
check('rail / air / ship need the transport document instead of a vehicle', transportFieldsNeeded(ewayPayload(sale, { ...ctx, transport: { mode: 'rail', distance: 900 } }).missing).join() === 'trans_doc');
check('a transporter can be given instead of the vehicle (they add it later)', ewayPayload(sale, { ...ctx, transport: { mode: 'road', transporterId: '29AAACT1234M1Z9', distance: 10 } }).missing.length === 0);
check('vehicle numbers as typed', cleanVehicle('ka-01 ab 0001') === 'KA01AB0001' && vehicleOk('KA01AB0001') && !vehicleOk('12345'));
check('the e-way state keeps a saved transport and never claims an EWB number', ewayState(sale, ctx, { status: 'ready', transport: { mode: 'road', vehicle: 'KA01AB0001', distance: 5 } }).state === 'ready'
  && !('ewbNo' in (ewayState(sale, ctx, null))));

/* ---------- repack ---------- */
const from = { p: 'sack', v: 'sack', unit: 'pcs', name: '25 kg Sack', tracking: 'none', cost: 1000 }, to = { p: 'loose', v: 'loose', unit: 'kg', name: 'Rice loose', tracking: 'none' };
let rp = repackPlan({ id: 'r1', from, to, q: 2, per: 25, available: 5, t: 1, dev: 'D' });
check('repack: the source goes out, the target comes in (2 sacks → 50 kg)', !rp.error && rp.moves[0].q === -2 && rp.moves[0].type === 'ADJUST' && rp.moves[1].q === 50 && rp.moves[1].type === 'RESTOCK' && rp.moves[0].id === 'rpk:r1:out');
check('quantity and value reconcile (₹2,000 out = 50 kg × ₹40)', rp.value === 2000 && rp.unitCost === 40 && rp.moves[1].cost === 40);
check('repack refuses more than in stock, serial products, the same product', /Only/.test(repackPlan({ id: 'r', from, to, q: 6, per: 25, available: 5 }).error)
  && !!repackPlan({ id: 'r', from: { ...from, tracking: 'serial' }, to, q: 1, per: 2, available: 5 }).error && !!repackPlan({ id: 'r', from, to: from, q: 1, per: 2, available: 5 }).error);
rp = repackPlan({ id: 'r2', from: { ...from, unit: 'box', name: 'Carton' }, to: { ...to, unit: 'pcs', name: 'Bottle' }, q: 1, per: 24, available: 3 });
check('1 carton → 24 bottles', rp.moves[1].q === 24);
check('a batch-tracked source names its batch; the target keeps it', !!repackPlan({ id: 'r', from: { ...from, tracking: 'batch' }, to, q: 1, per: 25, available: 5 }).error
  && repackPlan({ id: 'r', from: { ...from, tracking: 'batch' }, to: { ...to, tracking: 'batch' }, q: 1, per: 25, available: 5, batch: { b: 'B1', exp: '2027-01-01' } }).moves[1].b === 'B1');
check('saved conversions are cleaned', cleanRepacks([{ f: 'a', t: 'b', per: 25 }, { f: 'a', t: 'b', per: 30 }, { f: 'a', t: 'a', per: 2 }, { f: 'x', t: 'y', per: 0 }]).length === 1);

/* ---------- gift vouchers ---------- */
const code = voucherCode(new Uint8Array([0, 31, 7, 200, 1, 2, 3, 4, 5, 6, 7, 8]));
check('codes: GV-XXXX-XXXX-XXXX with no 0/O/1/I; typed or scanned codes are read back', /^GV-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/.test(code) && normCode(code.toLowerCase().replace(/-/g, ' ')) === code && normCode('GV-1234') === '');
check('issuing: an amount, how it was paid, a future last day', checkIssue({ amount: 0, method: 'cash' }).field === 'amount' && checkIssue({ amount: 500, method: 'bitcoin' }).field === 'method'
  && checkIssue({ amount: 500, method: 'cash', expires: '2026-01-01' }, '2026-10-03').field === 'expires' && checkIssue({ amount: 500, method: 'upi' }, '2026-10-03') === null);
check('states: active, fully used, expired, cancelled', voucherState({ balance: 10, status: 'active' }, '2026-10-03') === 'active' && voucherState({ balance: 0, status: 'active' }) === 'fully_redeemed'
  && voucherState({ balance: 10, status: 'active', expires: '2026-10-01' }, '2026-10-03') === 'expired' && voucherState({ balance: 10, status: 'cancelled' }) === 'cancelled');
check('partial use: never more than the balance or what is due', redeemable({ balance: 500, status: 'active' }, 300, '2026-10-03').amount === 300 && redeemable({ balance: 500, status: 'active' }, 800, '2026-10-03').amount === 500
  && !!redeemable({ balance: 0, status: 'active' }, 10).error && !!redeemable({ balance: 10, status: 'active' }, 0).error);
const vpart = { method: 'voucher', amount: 500, voucher: { id: 'gv1', code, amount: 500, redemption: 'gvr1' } };
let S = settlePayments(1200, [vpart, { method: 'cash', amount: 700, received: 1000 }]);
check('a voucher is a way to pay (not a discount): it settles part of the bill, cash the rest', S.ok && S.payments.length === 2 && S.payments[1].method === 'voucher' && S.payments[1].amount === 500 && S.payments[1].voucher === 'gv1' && S.change === 300, S);
check('…only the code\'s last 4 are kept on the payment', S.payments[1].ref === 'GV ···' + code.slice(-4) && !S.payments[1].ref.includes(code.slice(3, 7)));
check('a voucher not taken off yet (offline) never pays', !settlePayments(500, [{ ...vpart, voucher: { ...vpart.voucher, redemption: null } }]).ok && !!voucherPartError({ method: 'voucher', amount: 5 }));
check('one voucher per bill', !settlePayments(1000, [vpart, { ...vpart, voucher: { ...vpart.voucher, id: 'gv2' } }]).ok);
check('the bill\'s label says Gift voucher', payLabel({ payments: [{ method: 'voucher', amount: 500 }, { method: 'cash', amount: 700 }] }) === 'Gift voucher + Cash');

/* ---------- the upload queue ---------- */
const po = { type: 'biz', kind: 'po', id: 'po1', rec: { supplierId: 's1', items: [{ p: 'pa' }, { p: 'pa' }, { p: 'pb' }] } };
check('one waiting upload per record of the batch (kind + id)', itemKey(po) === 'biz:po:po1' && mergeIntoQueue([po, { type: 'biz', kind: 'pl', id: 'po1' }], { ...po, rec: {} }).length === 2);
check('a PO waits for its supplier and products; GST records for their bill; a receipt for its PO', eq(dependsOn(po), ['supplier:s1', 'prod:pa', 'prod:pb']) && eq(dependsOn({ type: 'biz', kind: 'ei', id: 's9' }), ['sale:s9'])
  && dependsOn({ type: 'purchase', purchase: { supplierId: 's1', poId: 'po1', lines: [] } }).includes('biz:po:po1'));
check('uploads of the batch need the right permission', !uploadAllowed({ type: 'biz', kind: 'po' }, p => p === 'create_sale') && uploadAllowed({ type: 'biz', kind: 'po' }, p => p === 'create_purchase')
  && !uploadAllowed({ type: 'biz', kind: 'pl' }, p => p === 'create_sale') && BIZ_UPLOAD_PERMISSIONS.rpk.includes('manage_inventory'));

/* ---------- capabilities ---------- */
check('the batch\'s capabilities exist, with sensible defaults per business', ['uses_price_lists', 'uses_bundles', 'uses_vouchers', 'uses_purchase_orders', 'uses_repack', 'uses_einvoice', 'uses_eway'].every(k => CAP_KEYS.includes(k))
  && defaultCaps('grocery').uses_repack && !defaultCaps('retail').uses_repack && defaultCaps('electronics').uses_bundles && defaultCaps('retail').uses_purchase_orders
  && !defaultCaps('restaurant').uses_purchase_orders && !defaultCaps('retail').uses_price_lists && !defaultCaps('retail').uses_einvoice && capsFor('retail', { uses_vouchers: true }).uses_vouchers);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
