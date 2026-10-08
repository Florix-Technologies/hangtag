// Shops for tests, declared once and built through the app's own functions (the editor, the customer and supplier forms,
// the till's checkout) — never by writing records directly, so every rule the app applies on the way (stock moves, bill
// numbers, payments, what a customer owes) is the app's. A fixture also states its TRUTH: the figures a person would read
// off the bills by hand. Suites compare the app's answers with it; nothing here recomputes them.
//
//   const ids = await seedShop(device, BOUTIQUE);   // → { products: { Kurta: { id, variant } }, customers: { Riya: id }, suppliers, bills: [{ id, no, total }] }
//   BOUTIQUE.truth.today.sales === 4300

/* A clothing boutique: purchase orders on; four products (one without a cost price); two customers; a supplier the shop
   bought its two Dupattas from (paid); and five bills — three today (cash, UPI with its reference, part on Riya's account;
   the Dupattas sell out) and two older ones */
export const BOUTIQUE = Object.freeze({
  capabilities: { uses_purchase_orders: true },
  products: [
    { name: 'Kurta', price: 1000, cost: 600, stock: 40, sku: 'KUR-01', category: 'Ethnic' },
    { name: 'Tee', price: 500, cost: 250, stock: 40, sku: 'TEE-01', category: 'Casual' },
    { name: 'Dupatta', price: 400, cost: 200, stock: 0, category: 'Ethnic' },   // its 2 come from the purchase below
    { name: 'Belt', price: 300, stock: 10, category: 'Accessories' },   // no cost price: profit can't count it
  ],
  customers: [
    { name: 'Riya', phone: '98765 43210', email: 'riya@example.com' },
    { name: 'Arjun', phone: '91234 56789' },
  ],
  suppliers: [{ name: 'Lakshmi Textiles', phone: '9876500001' }],
  purchases: [{ supplier: 'Lakshmi Textiles', invoiceNo: 'LT-101', lines: [['Dupatta', 2, 200]], paid: 400, method: 'cash' }],
  bills: [
    { lines: [['Kurta', 2]], pay: 'cash' },
    { lines: [['Tee', 1], ['Dupatta', 2]], pay: { method: 'upi', ref: '412345678901', confirmed: true }, customer: 'Arjun' },
    { lines: [['Kurta', 1]], pay: [{ method: 'cash', amount: 300 }, { method: 'due', amount: 700 }], customer: 'Riya' },
    { lines: [['Tee', 2]], pay: 'cash', daysAgo: 8 },
    { lines: [['Kurta', 1]], pay: [{ method: 'cash', amount: 200 }, { method: 'due', amount: 800 }], customer: 'Riya', daysAgo: 10 },
  ],
  /* read off the bills above by hand */
  truth: Object.freeze({
    // UPI 1300: confirmed by hand at the till, so unverified until the provider's record says so
    today: Object.freeze({ sales: 4300, bills: 3, pieces: 6, averageBill: 1433.33, cash: 2300, upi: 1300, card: 0, onAccount: 700, grossProfit: 1850, upiUnverified: 1300 }),
    last30: Object.freeze({ sales: 6300, bills: 5 }),
    dues: Object.freeze({ total: 1500, customers: 1, top: 'Riya', topAmount: 1500 }),
    supplierDues: 0,
    stock: Object.freeze({ soldOut: ['Dupatta'], Kurta: 36, Tee: 37, Dupatta: 0, Belt: 10 }),
    billNos: Object.freeze(['INV-000001', 'INV-000002', 'INV-000003', 'INV-000004', 'INV-000005']),
  }),
});

const js = (v) => JSON.stringify(v);

/* Build a fixture shop on a device (tests/helpers/app.mjs). Bills are made in the order given; a bill `daysAgo` is made with
   the device's clock moved back only while it is made. → { products, customers, suppliers, bills } */
export async function seedShop(D, spec){
  const ids = await D.run(`
    ${spec.capabilities ? `{ const r = saveCapabilities(${js(spec.capabilities)}); if(r && r.error) throw new Error(r.error); }` : ''}
    for(const p of ${js(spec.products || [])}){
      openEditor(null); editor.name = p.name; editor.price = String(p.price);
      if(p.cost != null) editor.cost = String(p.cost); if(p.category) editor.cat = p.category; if(p.hsn) editor.hsn = p.hsn; if(p.gst != null) editor.gst = String(p.gst);
      const c = edCombos()[0].cell; c.stock = String(p.stock == null ? 0 : p.stock);
      if(p.sku || p.barcode){ editor.codesOn = true; if(p.sku) c.sku = p.sku; if(p.barcode) c.bc = p.barcode; }
      saveEditor();
    }
    for(const c of ${js(spec.customers || [])}) saveCustomer({ name: c.name, phone: c.phone || "", email: c.email || "" });
    for(const s of ${js(spec.suppliers || [])}) saveSupplier({ name: s.name, phone: s.phone || "", gstin: s.gstin || "" });
    // purchases: [supplier, invoice, lines [name, qty, cost], paid] — the stock they bring is the app's
    for(const pu of ${js(spec.purchases || [])}){
      const sup = suppliersList(true).find(s => s.name === pu.supplier), lines = pu.lines.map(([n, q, cost]) => ({ v: products().find(p => p.name === n).variants[0].id, q: String(q), cost: String(cost) }));
      const r = savePurchase({ supplierId: sup && sup.id, invoiceNo: pu.invoiceNo || "", lines, paid: String(pu.paid || 0), method: pu.method || "cash" });
      if(r && r.error) throw new Error("purchase: " + r.error);
    }
    closeModal(); await flushSbQueue();
    return { products: Object.fromEntries(products().map(p => [p.name, { id: p.id, variant: p.variants[0].id }])),
      customers: Object.fromEntries(Object.values(customers).map(c => [c.name, c.id])),
      suppliers: Object.fromEntries(suppliersList(true).map(s => [s.name, s.id])) };`);
  ids.bills = [];
  for(const b of spec.bills || []) ids.bills.push(await sellBill(D, ids, b));
  await D.run('await flushSbQueue()');
  return ids;
}

/* One bill through the till: its lines, the customer, a bill discount, how it was paid → { id, no, total } */
export async function sellBill(D, ids, b){
  const lines = b.lines.flatMap(([name, q]) => Array(q).fill(ids.products[name] && ids.products[name].variant));
  if(lines.some((v) => !v)) throw new Error('sellBill: unknown product in ' + js(b.lines));
  const pay = typeof b.pay === 'string' ? js(b.pay) : js(b.pay);
  return D.run(`await new Promise(r => setTimeout(r, 650));   // the till ignores a second checkout within 0.6 s (a double tap)
    closeModal(); closeSheets(); setTab("sell");
    ${b.customer ? `setBillCustomer(customers[${js(ids.customers[b.customer])}]);` : ''}
    ${js(lines)}.forEach(v => addOne(v));
    ${b.discount ? `disc = ${js(b.discount)};` : ''}
    const real = Date.now; ${b.daysAgo ? `lastCheckout = 0; Date.now = () => real() - ${+b.daysAgo} * 864e5;` : ''}
    let s; try{ const p = checkout(${pay}); Date.now = real; s = await p; } finally { Date.now = real; }
    closeModal(); closeSheets();
    return s && { id: s.id, no: s.no, total: s.total };`);
}
