// The "cloud" port: every call the app makes to Supabase (auth, tables, realtime, RPC), in one place.
// Features never see supabase-js. getClient() is read on every call, so the current client (or a test's fake) is used.
import { makeSbClient } from './client.js';
import { toAppError } from './errors.js';
import { AppError, ERROR_CODES } from '../../shared/errors/app-error.js';
import { sbFetchAll, sbOk } from './query.js';
import { billArgs, cashMoveRow, custRow, dayCloseRow, eventRow, moveRow, productRow, returnArgs, roleRow, rowToCashMove, rowToCustomer, rowToDayClose, rowToDelivery, rowToDevice, rowToEvent, rowToImport, rowToItem, rowToMember, rowToMove, rowToPayment, rowToProduct, rowToReturn, rowToReturnItem, rowToRole, rowToSale, rowToVariant, variantRows } from './mappers.js';
import { collectionRow, heldRow, orderArgs, rowToCollection, rowToHeld, rowToOrder, rowToOrderItem } from './mappers.js';
import { purchaseArgs, rowToPurchase, rowToSupplier, rowToSupplierPayment, supplierPaymentRow, supplierRow } from './mappers.js';
import { rowToSession, rowToTable, sessionRow, tableRow } from './mappers.js';
import { einvRow, ewayRow, poArgs, priceListRow, repackArgs, rowToDelivery as rowToHookDelivery, rowToEinv, rowToEndpoint, rowToEway, rowToPO, rowToPriceList, rowToRepack,
  rowToVoucher, bankAccountRow, bankMoveRow, rowToBankAccount, rowToBankMove } from './biz-mappers.js';

/* deviceKey: () => this phone's team device key or "" (sent as x-hangtag-device by every client this makes; see client.js) */
export function createCloudGateway({ getClient, url, key, storageKey, deviceKey }){
  const db = () => getClient();
  const table = t => db().from(t);
  const auth = {
    getSession: () => db().auth.getSession(),
    onAuthStateChange: cb => db().auth.onAuthStateChange(cb),
    signInWithOAuth: args => db().auth.signInWithOAuth(args),
    signInWithPassword: args => db().auth.signInWithPassword(args),
    signUp: args => db().auth.signUp(args),
    resend: args => db().auth.resend(args),
    resetPasswordForEmail: (email, options) => db().auth.resetPasswordForEmail(email, options),
    updateUser: attrs => db().auth.updateUser(attrs),
    verifyOtp: args => db().auth.verifyOtp(args),
    signOut: options => db().auth.signOut(options),
    /* Which sign-in services are switched on for this project (public endpoint, publishable key) */
    async settings(){
      const r = await fetch(url.replace(/\/+$/, "") + "/auth/v1/settings", { headers: { apikey: key }, cache: "no-store" });
      if(!r.ok) throw new Error("Auth settings " + r.status);
      return r.json();
    },
  };

  /* An Edge Function's answer, or an AppError the app can act on (the function's own refusal, or the platform's when the
     function isn't deployed / the sign-in is refused) */
  async function callFunction(name, body, what){
    let r;
    try{ r = await db().functions.invoke(name, { body }); }
    catch(e){ throw toAppError(e); }
    if(!r.error && r.data && r.data.ok !== false && !r.data.error) return r.data;
    let info = null;
    try{ info = r.error && r.error.context && typeof r.error.context.json === "function" ? await r.error.context.json() : (r.data || null); }catch{ info = null; }
    const msg = info && info.message, code = info && info.error, status = r.error && r.error.context && r.error.context.status;
    const E = (c, m) => new AppError(c, m, { cause: r.error, details: info });
    if(code === "subscription_inactive") throw E(ERROR_CODES.SUBSCRIPTION, msg || "This shop's Hangtag plan has ended. Renew it in Plans & Billing.");
    if(code === "not_configured") throw E(ERROR_CODES.NOT_CONFIGURED, msg || `${what} isn't set up yet.`);
    if(code === "unauthorized" || (!code && status === 401)) throw E(ERROR_CODES.AUTH, "Sign in again.");
    if(code === "forbidden") throw E(ERROR_CODES.PERMISSION, msg || "Your role can't do that.");
    if(code === "provider_error") throw E(ERROR_CODES.DELIVERY, msg || "The provider didn't accept the request.");
    if(code === "conflict") throw E(ERROR_CODES.CONFLICT, msg || "That was already done.");
    if(code === "not_found") throw E(ERROR_CODES.NOT_FOUND, msg || "It wasn't found.");
    if(code === "server_error") throw E(ERROR_CODES.NETWORK, msg || "The server couldn't do it. Try again.");
    if(code) throw E(ERROR_CODES.VALIDATION, msg || "The request was refused.");
    if(r.error && (status === 404 || /relay|404|not found/i.test(String(r.error.message || "")))) throw E(ERROR_CODES.NOT_CONFIGURED, `${what} isn't set up yet.`);
    if(r.error) throw toAppError(r.error);
    throw E(ERROR_CODES.UNKNOWN, "The server's answer wasn't understood.");
  }
  /* An update or delete that must reach its rows. Row security quietly skips rows a person may see but not change (a team
     member whose role doesn't allow it; never the owner), so the written rows are asked back: none, and the rows are still
     there → refused (PERMISSION: the upload queue keeps it for review, with the reason); none there any more → nothing to do.
     write(q) makes the change, where(q) picks the rows, key: a column to read back. */
  async function mustReach(t, key, write, where){
    const { data } = sbOk(await where(write(table(t))).select(key));
    if(Array.isArray(data) && data.length) return data.length;
    const { data: still } = sbOk(await where(table(t).select(key)).limit(1));
    if(Array.isArray(still) && still.length) throw new AppError(ERROR_CODES.PERMISSION, "The shop's cloud copy didn't take this change: your role may not make it.");
    return 0;
  }
  return {
    /* A new client for this app's project; supabase-js keeps the session under storageKey */
    createClient: () => makeSbClient({ url, key, storageKey, deviceKey }),
    auth,
    /* How an email signs in today: resolves the raw { data, error } of the RPC */
    signInMethods: email => db().rpc("hangtag_sign_in_methods", { p_email: email }),
    /* Quick check that the database has the current tables (schema.sql has been run; the table-ordering tables are newest).
       Resolves { error: null } or { error: AppError } — OUTDATED_DATABASE when the tables are missing. */
    async checkSchema(){
      const { error } = await table('hangtag_tables').select('id', { head: true, count: 'exact' });
      if(!error) return { error: null };
      const missing = /hangtag_tables|hangtag_table_sessions|hangtag_events|hangtag_payments|hangtag_stock_imports|hangtag_variants|PGRST205|42P01|does not exist|schema cache/i.test((error.code||"")+" "+(error.message||""));
      return { error: missing ? new AppError(ERROR_CODES.OUTDATED_DATABASE, "The database needs the latest update (schema.sql).", { cause: error }) : toAppError(error) };
    },

    /* ---------- live updates ---------- */
    /* handlers get the realtime payloads (database rows): { sale, saleLine, catalog, image, move, returns, customers, settings } */
    subscribe(h, onStatus){
      const on = (ch, event, t, fn) => ch.on('postgres_changes', { event, schema: 'public', table: t }, fn);
      let ch = db().channel('hangtag-realtime-sync');
      ch = on(ch, '*', 'hangtag_sales', h.sale);
      ch = on(ch, 'INSERT', 'hangtag_sale_items', h.saleLine);
      ch = on(ch, '*', 'hangtag_products', h.catalog);
      ch = on(ch, '*', 'hangtag_variants', h.catalog);
      ch = on(ch, '*', 'hangtag_images', h.image);
      ch = on(ch, '*', 'hangtag_stock_moves', h.move);
      ch = on(ch, '*', 'hangtag_returns', h.returns);
      ch = on(ch, '*', 'hangtag_return_items', h.returns);
      ch = on(ch, '*', 'hangtag_customers', h.customers);
      ch = on(ch, '*', 'hangtag_meta', h.settings);
      if(h.events) ch = on(ch, '*', 'hangtag_events', h.events);
      // section 3m: orders, held bills and payments collected, between the shop's own tills
      if(h.orders) ch = on(ch, '*', 'hangtag_orders', h.orders);
      if(h.held) ch = on(ch, '*', 'hangtag_held_carts', h.held);
      if(h.collections) ch = on(ch, '*', 'hangtag_collections', h.collections);
      // section 3o: a restaurant's tables and sessions
      if(h.tables){ ch = on(ch, '*', 'hangtag_tables', h.tables); ch = on(ch, '*', 'hangtag_table_sessions', h.tables); }
      // section 3r: price lists, purchase orders, vouchers
      if(h.biz) ['hangtag_price_lists','hangtag_purchase_orders','hangtag_vouchers','hangtag_einvoices','hangtag_eway_bills','hangtag_bank_accounts','hangtag_bank_moves'].forEach(t => { ch = on(ch, '*', t, h.biz); });
      return ch.subscribe(onStatus);
    },
    removeChannel: ch => db().removeChannel(ch),
    /* Realtime payloads carry database rows: these turn them into app records */
    records: { toSale: rowToSale, toSaleLine: rowToItem, toMove: rowToMove },

    /* ---------- uploads (one per queued change; each throws on failure so the queue keeps it) ---------- */
    /* A bill with its lines and payments, all or nothing (RPC hangtag_save_sales: the database refuses payments that
       don't add up to the amount due, and posts the financial transactions and cash / bank book entries itself) */
    async saveSale(sale){ sbOk(await db().rpc('hangtag_save_sales', { p_bills: [billArgs(Object.assign({}, sale, { void:false }))] })); },
    /* Cancelling a bill needs a reason (kept with it); restoring clears it */
    async setSaleVoid(id, isVoid, reason){
      await mustReach('hangtag_sales', 'id', q => q.update({ is_void: isVoid, void_reason: isVoid ? String(reason || "").slice(0, 200) || null : null }), q => q.eq('id', id));
    },
    /* index = the product's position in the list (its sort order) */
    async saveProduct(p, index){
      sbOk(await table('hangtag_products').upsert(productRow(p, index)));
      const rows = variantRows(p);
      if(rows.length) sbOk(await table('hangtag_variants').upsert(rows));
    },
    /* An edit: the columns of the fields it changed and the variants it added or changed, so another till's edit of other
       fields or variants of the product stays; a product the cloud doesn't have yet is saved whole */
    async patchProduct(p, index, fields, variantIds){
      const row = productRow(p, index), COLS = { name:'name', price:'price', color:'color', cat:'category', brand:'brand', desc:'description', cost:'cost_price', archived:'archived',
        hsn:'hsn', gst:'gst_rate', code:'code_type', opts:'options', tracking:'tracking', unit:'unit', low:'low_stock', expiry:'tracks_expiry', bundle:'bundle', repack:'repack' };
      const patch = { updated_at:row.updated_at };
      (fields || []).forEach(f => { const col = COLS[f]; if(col) patch[col] = col in row ? row[col] : null; });
      const r = await table('hangtag_products').update(patch).eq('id', p.id).select('id'); sbOk(r);
      const rows = variantRows(p), ids = new Set(variantIds || []);
      if(!r.data || !r.data.length){ sbOk(await table('hangtag_products').upsert(row)); if(rows.length) sbOk(await table('hangtag_variants').upsert(rows)); return; }
      const changed = rows.filter(v => ids.has(v.id));
      if(changed.length) sbOk(await table('hangtag_variants').upsert(changed));
    },
    async deleteVariants(ids){ await mustReach('hangtag_variants', 'id', q => q.delete(), q => q.in('id', ids)); },
    async deleteProduct(id){
      await mustReach('hangtag_products', 'id', q => q.delete(), q => q.eq('id', id));
      await mustReach('hangtag_images', 'product_id', q => q.delete(), q => q.eq('product_id', id));
    },
    /* dataUrl = the photo, or empty to remove it */
    async saveImage(productId, dataUrl){
      if(dataUrl) sbOk(await table('hangtag_images').upsert({ product_id:productId, image_data:dataUrl, updated_at:new Date().toISOString() }));
      else await mustReach('hangtag_images', 'product_id', q => q.delete(), q => q.eq('product_id', productId));
    },
    async saveMove(m){ sbOk(await table('hangtag_stock_moves').upsert(moveRow(m))); },
    /* A return with its lines, all or nothing (RPC hangtag_save_return: the database refuses a return on a cancelled bill, or of
       more pieces than a bill line has left — also when another device returned them first). Saving it again is a safe retry. */
    async saveReturn(ret){ sbOk(await db().rpc('hangtag_save_return', returnArgs(ret))); },
    async saveCustomer(c){ sbOk(await table('hangtag_customers').upsert(custRow(c))); },
    /* An edit: only the columns of the fields it changed; a customer the cloud doesn't have yet is saved whole */
    async patchCustomer(c, fields){
      const row = custRow(c), COLS = { name: ['name'], phone: ['phone'], email: ['email'], gstin: ['gstin'], type: ['customer_type'], addr: ['address'], priceList: ['price_list_id'] };
      const patch = {}; fields.forEach(f => (COLS[f] || []).forEach(col => { if(col in row) patch[col] = row[col]; else if(f === 'addr' || f === 'priceList') patch[col] = null; }));
      if(!Object.keys(patch).length) return;
      const r = await table('hangtag_customers').update(patch).eq('id', c.id).select('id'); sbOk(r);
      if(!r.data || !r.data.length) sbOk(await table('hangtag_customers').upsert(row));
    },
    async saveEvent(e){ sbOk(await table('hangtag_events').upsert(eventRow(e))); },
    /* The database refuses deleting an event that has bills */
    async deleteEvent(id){ await mustReach('hangtag_events', 'id', q => q.delete(), q => q.eq('id', id)); },
    /* Cash entries are never changed: a repeat upload of the same entry does nothing */
    async saveCashMove(m){ sbOk(await table('hangtag_cash_moves').upsert(cashMoveRow(m), { onConflict:'owner_id,id', ignoreDuplicates:true })); },
    async saveDayClose(c){ sbOk(await table('hangtag_day_closes').upsert(dayCloseRow(c))); },
    async saveSettings(settings){ sbOk(await table('hangtag_meta').upsert({ key:'settings', value:settings, updated_at:new Date().toISOString() })); },
    /* The shop logo for receipts (a small data URL), or empty to remove it */
    /* The authorised signature or company stamp (hangtag_meta "doc_signature" / "doc_stamp"); "" removes it */
    async saveDocImage(kind, dataUrl){
      if(kind !== 'signature' && kind !== 'stamp') throw new Error('Unknown document picture.');
      if(dataUrl) sbOk(await table('hangtag_meta').upsert({ key:'doc_' + kind, value:{ data:dataUrl }, updated_at:new Date().toISOString() }));
      else sbOk(await table('hangtag_meta').delete().eq('key','doc_' + kind));
    },
    /* The automation log of one device (its own entries, newest first, bounded) */
    async saveAutomationLog(dev, entries){
      sbOk(await table('hangtag_meta').upsert({ key:'autolog:' + String(dev).slice(0, 20), value:{ entries:(entries || []).slice(0, 100) }, updated_at:new Date().toISOString() }));
    },
    async saveLogo(dataUrl){
      if(dataUrl) sbOk(await table('hangtag_meta').upsert({ key:'logo', value:{ data:dataUrl }, updated_at:new Date().toISOString() }));
      else sbOk(await table('hangtag_meta').delete().eq('key','logo'));
    },
    /* Every bill (with its cancelled flag, lines and payments), 100 bills per call */
    async saveAllSales(sales){
      for(let i = 0; i < sales.length; i += 100) sbOk(await db().rpc('hangtag_save_sales', { p_bills: sales.slice(i, i + 100).map(billArgs) }));
    },

    /* ---------- downloads (throw on failure unless noted) ---------- */
    fetchProducts: async () => (await sbFetchAll(db(), 'hangtag_products', ['sort_order','id'])).map(rowToProduct),
    /* [{ productId, variant }] in display order */
    fetchVariants: async () => (await sbFetchAll(db(), 'hangtag_variants', ['product_id','sort_order','id'])).map(v => ({ productId: v.product_id, variant: rowToVariant(v) })),
    /* [{ productId, data }], or null when they couldn't be read (never throws) */
    async fetchImages(){
      const { data } = await table('hangtag_images').select('*');
      return data ? data.map(im => ({ productId: im.product_id, data: im.image_data })) : null;
    },
    fetchMoves: async () => (await sbFetchAll(db(), 'hangtag_stock_moves', ['t','id'])).map(rowToMove),
    /* Returns with their lines */
    async fetchReturns(){
      const rows = await sbFetchAll(db(), 'hangtag_returns', ['t','id']);
      const items = await sbFetchAll(db(), 'hangtag_return_items', ['return_id','line_no']);
      const byRet = {};
      items.forEach(i => { (byRet[i.return_id] = byRet[i.return_id] || []).push(rowToReturnItem(i)); });
      return rows.map(r => rowToReturn(r, byRet[r.id] || []));
    },
    fetchCustomers: async () => (await sbFetchAll(db(), 'hangtag_customers', ['created_at','id'])).map(rowToCustomer),
    fetchEvents: async () => (await sbFetchAll(db(), 'hangtag_events', ['start_date','id'])).map(rowToEvent),
    fetchCashMoves: async () => (await sbFetchAll(db(), 'hangtag_cash_moves', ['t','id'])).map(rowToCashMove),
    fetchDayCloses: async () => (await sbFetchAll(db(), 'hangtag_day_closes', ['day','id'])).map(rowToDayClose),
    /* The saved settings object, or null */
    async fetchSettings(){
      const { data } = sbOk(await table('hangtag_meta').select('value').eq('key','settings').maybeSingle());
      return data ? data.value : null;
    },
    /* The shop logo (data URL), "" when there is none */
    /* { signature, stamp }: the pictures the shop keeps for its A4 documents ("" when none) */
    async fetchDocImages(){
      const { data } = sbOk(await table('hangtag_meta').select('key,value').in('key', ['doc_signature','doc_stamp']));
      const out = { signature:'', stamp:'' };
      (data || []).forEach(r => { const v = r.value && r.value.data; if(typeof v === 'string' && /^data:image\//.test(v)) out[r.key.slice(4)] = v; });
      return out;
    },
    /* Every device's automation log, as one list */
    async fetchAutomationLogs(){
      const { data } = sbOk(await table('hangtag_meta').select('key,value').like('key', 'autolog:%'));
      return (data || []).flatMap(r => r.value && Array.isArray(r.value.entries) ? r.value.entries : []);
    },
    async fetchLogo(){
      const { data } = sbOk(await table('hangtag_meta').select('value').eq('key','logo').maybeSingle());
      return data && data.value && typeof data.value.data === 'string' ? data.value.data : "";
    },
    /* A quotation's messages to its customer (send-receipt with order_id), newest first */
    async fetchOrderDeliveries(orderId){
      const { data } = sbOk(await table('hangtag_deliveries').select('*').eq('order_id', orderId).order('created_at', { ascending:false }).limit(50));
      return (data || []).map(rowToDelivery);
    },
    /* A bill's messages to its customer, newest first */
    /* Every send of the last days, newest first (bills' receipts and quotations), at most 500 */
    async fetchRecentDeliveries(since){
      const { data } = sbOk(await table('hangtag_deliveries').select('*').gte('created_at', new Date(since).toISOString()).order('created_at', { ascending:false }).limit(500));
      return (data || []).map(rowToDelivery);
    },
    async fetchDeliveries(saleId){
      const { data } = sbOk(await table('hangtag_deliveries').select('*').eq('sale_id', saleId).order('created_at', { ascending:false }));
      return (data || []).map(rowToDelivery);
    },

    /* Every bill with its lines and payments */
    async fetchSales(){
      const sales = await sbFetchAll(db(), 'hangtag_sales', ['timestamp','id']);
      const items = await sbFetchAll(db(), 'hangtag_sale_items', ['sale_id','line_no']);
      const pays = await sbFetchAll(db(), 'hangtag_payments', ['sale_id','id']);
      const itemsBySale = {}, paysBySale = {};
      items.forEach(it => { (itemsBySale[it.sale_id] = itemsBySale[it.sale_id] || []).push(rowToItem(it)); });
      pays.forEach(p => { (paysBySale[p.sale_id] = paysBySale[p.sale_id] || []).push(rowToPayment(p)); });
      return sales.map(s => rowToSale(s, itemsBySale[s.id] || [], paysBySale[s.id]));
    },
    /* ---------- a team member's phone: only what changed (it gets no live updates) ---------- */
    /* One small fingerprint per part of the shop (RPC hangtag_shop_changes; row security decides what is counted):
       { catalog, images, moves, returns, customers, events, cash, settings, sales, sales_count, sales_since, sales_voids } */
    async shopChanges(){
      const r = await db().rpc('hangtag_shop_changes');
      if(r.error) throw toAppError(r.error);
      return r.data && typeof r.data === 'object' ? r.data : {};
    },
    /* Bills saved in the cloud since a time (the database's saved-at, ISO), with their lines and payments: up to 1000
       (a caller that gets 1000 downloads everything instead) */
    async fetchSalesSince(iso){
      const { data } = sbOk(await table('hangtag_sales').select('*').gte('created_at', iso).order('created_at').limit(1000));
      const sales = data || [];
      if(!sales.length) return [];
      const ids = sales.map(s => s.id), items = [], pays = [];
      for(let i = 0; i < ids.length; i += 100){
        const part = ids.slice(i, i + 100);
        items.push(...(sbOk(await table('hangtag_sale_items').select('*').in('sale_id', part)).data || []));
        pays.push(...(sbOk(await table('hangtag_payments').select('*').in('sale_id', part)).data || []));
      }
      const itemsBySale = {}, paysBySale = {};
      items.sort((x, y) => x.line_no - y.line_no).forEach(it => { (itemsBySale[it.sale_id] = itemsBySale[it.sale_id] || []).push(rowToItem(it)); });
      pays.sort((x, y) => String(x.id).localeCompare(String(y.id))).forEach(p => { (paysBySale[p.sale_id] = paysBySale[p.sale_id] || []).push(rowToPayment(p)); });
      return sales.map(s => rowToSale(s, itemsBySale[s.id] || [], paysBySale[s.id]));
    },
    /* The cancelled bills: [{ id, reason }] (a few small rows) */
    async fetchVoidedSales(){
      const out = [];
      for(let from = 0; ; from += 1000){
        const { data } = sbOk(await table('hangtag_sales').select('id,void_reason').eq('is_void', true).order('id').range(from, from + 999));
        out.push(...(data || []).map(r => ({ id: r.id, reason: r.void_reason || "" })));
        if(!data || data.length < 1000) break;
      }
      return out;
    },
    /* One bill's payments (for a bill that arrived live) */
    async fetchSalePayments(saleId){
      const { data } = sbOk(await table('hangtag_payments').select('*').eq('sale_id', saleId).order('id'));
      return (data || []).map(rowToPayment);
    },
    /* One bill's line rows (for a bill that arrived live) */
    async fetchSaleLineRows(saleId){
      const { data } = sbOk(await table('hangtag_sale_items').select('*').eq('sale_id', saleId).order('line_no'));
      return data || [];
    },

    /* ---------- customer credit, held bills, orders (section 3m) ---------- */
    /* A payment collected from a customer: added once (a retry changes nothing); a cancelled one (the owner's) then gets
       its status, which takes its book entry out of the balances */
    async saveCollection(c){
      sbOk(await table('hangtag_collections').upsert(collectionRow(c), { onConflict:'owner_id,id', ignoreDuplicates:true }));
      if(c.status === "cancelled") await mustReach('hangtag_collections', 'id', q => q.update({ status:'cancelled' }), q => q.eq('id', c.id));
    },
    async saveHeldCart(h){ sbOk(await table('hangtag_held_carts').upsert(heldRow(h))); },
    /* Recalled on some till: gone for every till (already gone is fine) */
    async deleteHeldCart(id){ await mustReach('hangtag_held_carts', 'id', q => q.delete(), q => q.eq('id', id)); },
    /* An order with its lines, all or nothing (RPC hangtag_save_order). o.version is the version this device last saw; the
       database refuses a save made on an older one (CONFLICT: changed on another device) → { version } now in the cloud */
    async saveOrder(o){
      const { data } = sbOk(await db().rpc('hangtag_save_order', orderArgs(o)));
      return { version: data && +data.version || (+o.version || 0) + 1 };
    },
    async fetchOrders(){
      const rows = await sbFetchAll(db(), 'hangtag_orders', ['t','id']);
      const items = await sbFetchAll(db(), 'hangtag_order_items', ['order_id','line_no']);
      const byOrder = {};
      items.forEach(i => { (byOrder[i.order_id] = byOrder[i.order_id] || []).push(rowToOrderItem(i)); });
      return rows.map(r => rowToOrder(r, byOrder[r.id] || []));
    },
    fetchHeldCarts: async () => (await sbFetchAll(db(), 'hangtag_held_carts', ['t','id'])).map(rowToHeld),
    fetchCollections: async () => (await sbFetchAll(db(), 'hangtag_collections', ['t','id'])).map(rowToCollection),
    /* ---------- a restaurant's tables, their sessions, the kitchen (section 3o) ---------- */
    async saveTable(t){ sbOk(await table('hangtag_tables').upsert(tableRow(t))); },
    async saveTableSession(s){ sbOk(await table('hangtag_table_sessions').upsert(sessionRow(s))); },
    fetchTables: async () => (await sbFetchAll(db(), 'hangtag_tables', ['sort_order','id'])).map(rowToTable),
    /* sessions still going, and those closed in the last two days (a table's recent history) */
    async fetchTableSessions(){
      const since = Date.now() - 2 * 864e5, N = 1000, all = async where => { const out = [];
        for(let from = 0; ; from += N){ const { data } = sbOk(await where(table('hangtag_table_sessions').select('*')).order('opened_t').order('id').range(from, from + N - 1));
          out.push(...(data || [])); if(!data || data.length < N) break; }
        return out; };
      const [live, recent] = await Promise.all([all(q => q.neq('status', 'closed')), all(q => q.gte('closed_t', since))]);
      const by = {}; [...live, ...recent].forEach(r => { by[r.id] = r; });
      return Object.values(by).map(rowToSession);
    },
    /* A table order moved along by the kitchen (or served, or cancelled): RPC hangtag_order_status → { status, version } */
    async setOrderStatus(id, status){
      const { data } = sbOk(await db().rpc('hangtag_order_status', { p_id: id, p_status: status }));
      return { status: data && data.status || status, version: data && +data.version || 0 };
    },
    /* A member's poll: one fingerprint each for orders, held bills and collections (RPC hangtag_order_changes) */
    async orderChanges(){
      const r = await db().rpc('hangtag_order_changes');
      if(r.error) throw toAppError(r.error);
      return r.data && typeof r.data === 'object' ? r.data : {};
    },

    /* ---------- the commerce batch (schema.sql section 3r) ---------- */
    /* One record as the upload queue sends it. kind: pl (price list), po (purchase order, on the version this device last
       saw: CONFLICT when changed elsewhere), ei / ew (e-invoice / e-way bill readiness), rpk (a repack and its two stock
       records, one RPC) → { version? } */
    async saveBiz(kind, rec){
      if(kind === "pl"){ sbOk(await table('hangtag_price_lists').upsert(priceListRow(rec))); return {}; }
      if(kind === "po"){ const { data } = sbOk(await db().rpc('hangtag_save_purchase_order', poArgs(rec))); return { version: data && +data.version || (+rec.version || 0) + 1 }; }
      if(kind === "ei"){ sbOk(await table('hangtag_einvoices').upsert(einvRow(rec), { onConflict: 'owner_id,sale_id' })); return {}; }
      if(kind === "ew"){ sbOk(await table('hangtag_eway_bills').upsert(ewayRow(rec), { onConflict: 'owner_id,sale_id' })); return {}; }
      if(kind === "rpk"){ sbOk(await db().rpc('hangtag_save_repack', repackArgs(rec, rec.moves))); return {}; }
      // bank accounts and their entries (section 3s): an account is saved again when it changes; an entry only once
      if(kind === "ba"){ sbOk(await table('hangtag_bank_accounts').upsert(bankAccountRow(rec), { onConflict: 'owner_id,id' })); return {}; }
      if(kind === "bm"){ sbOk(await table('hangtag_bank_moves').upsert(bankMoveRow(rec), { onConflict: 'owner_id,id', ignoreDuplicates: true })); return {}; }
      throw new AppError(ERROR_CODES.VALIDATION, "Unknown record: " + kind);
    },
    /* A price list removed (customers on it go back to the default list) */
    async deleteBiz(kind, id){
      if(kind === "pl") await mustReach('hangtag_price_lists', 'id', q => q.delete(), q => q.eq('id', id));
    },
    /* Every record of the batch; a kind the database doesn't have yet (schema.sql not re-run) comes back null */
    async fetchBiz(){
      const get = async (t, orders, map) => { try{ return (await sbFetchAll(db(), t, orders)).map(map); }catch(_e){ return null; } };
      const [pl, po, ei, ew, gv, rpk] = await Promise.all([get('hangtag_price_lists', ['created_at','id'], rowToPriceList), get('hangtag_purchase_orders', ['t','id'], rowToPO),
        get('hangtag_einvoices', ['created_at','sale_id'], rowToEinv), get('hangtag_eway_bills', ['created_at','sale_id'], rowToEway),
        get('hangtag_vouchers', ['t','id'], rowToVoucher), get('hangtag_repacks', ['t','id'], rowToRepack)]);
      const [ba, bm] = await Promise.all([get('hangtag_bank_accounts', ['created_at','id'], rowToBankAccount), get('hangtag_bank_moves', ['t','id'], rowToBankMove)]);
      return { pl, po, ei, ew, gv, rpk, ba, bm };
    },
    /* A team member's poll: fingerprints of price lists, POs, vouchers and GST records (RPC hangtag_biz_changes) */
    async bizChanges(){
      const r = await db().rpc('hangtag_biz_changes');
      if(r.error) throw toAppError(r.error);
      return r.data && typeof r.data === 'object' ? r.data : {};
    },
    /* Gift vouchers: issued, looked up, spent and released only online (the database locks the voucher) */
    async issueVoucher(p){ const { data } = sbOk(await db().rpc('hangtag_issue_voucher', { p })); return rowToVoucher(data.voucher); },
    async voucherLookup(code){ const { data } = sbOk(await db().rpc('hangtag_voucher_lookup', { p_code: code })); return data || { ok: false }; },
    async redeemVoucher(code, amount, saleId, paymentId, t){
      const { data } = sbOk(await db().rpc('hangtag_redeem_voucher', { p_code: code, p_amount: amount, p_sale: saleId, p_payment: paymentId, p_t: t || null }));
      return data || { ok: false };
    },
    async releaseVoucher(paymentId){ const { data } = sbOk(await db().rpc('hangtag_release_voucher', { p_payment: paymentId })); return data || { ok: false }; },
    async cancelVoucher(id, reason){ const { data } = sbOk(await db().rpc('hangtag_cancel_voucher', { p_id: id, p_reason: reason })); return data || { ok: false }; },
    async voucherHistory(id){
      const { data } = sbOk(await table('hangtag_voucher_redemptions').select('*').eq('voucher_id', id).order('t'));
      return (data || []).map(r => ({ id: r.id, saleId: r.sale_id, amount: +r.amount, kind: r.kind, t: Number(r.t) || 0 }));
    },
    /* Outbound webhooks (the owner's; the secret is returned only by create and rotate) */
    async webhookEndpoints(){ const { data } = sbOk(await table('hangtag_webhook_endpoints').select('*').order('created_at')); return (data || []).map(rowToEndpoint); },
    async webhookDeliveries(limit){
      const { data } = sbOk(await table('hangtag_webhook_deliveries').select('*').order('created_at', { ascending: false }).limit(limit || 30));
      const rows = data || [], ids = [...new Set(rows.map(r => r.event_id))];
      const types = {};
      if(ids.length){ const ev = sbOk(await table('hangtag_webhook_events').select('id,type').in('id', ids)); (ev.data || []).forEach(e => { types[e.id] = e.type; }); }
      return rows.map(r => ({ ...rowToHookDelivery(r), type: types[r.event_id] || "" }));
    },
    async webhookCreate(url, events, description){
      const { data } = sbOk(await db().rpc('hangtag_webhook_create', { p_url: url, p_events: events, p_description: description || null }));
      return { endpoint: rowToEndpoint(data.endpoint), secret: data.secret };
    },
    async webhookRotate(id){ const { data } = sbOk(await db().rpc('hangtag_webhook_rotate', { p_id: id })); return data && data.secret || ""; },
    async webhookUpdate(id, patch){
      const x = patch || {};
      const { data } = sbOk(await db().rpc('hangtag_webhook_update', { p_id: id, p_url: x.url == null ? null : x.url, p_events: x.events == null ? null : x.events, p_active: x.active == null ? null : !!x.active }));
      return rowToEndpoint(data.endpoint);
    },
    async webhookDelete(id){ sbOk(await db().rpc('hangtag_webhook_delete', { p_id: id })); },
    async webhookTest(id){ sbOk(await db().rpc('hangtag_webhook_test', { p_id: id })); },

    /* ---------- shop profile ---------- */
    getProfile: id => table("hangtag_profiles").select("*").eq("id", id).maybeSingle(),
    createProfile: p => table("hangtag_profiles").upsert(p),
    updateProfile: (id, patch) => table("hangtag_profiles").update(patch).eq("id", id),
    saveProfile: row => table("hangtag_profiles").upsert(row),

    /* ---------- supplier bills ---------- */
    /* One confirmed bill, all or nothing (RPC hangtag_import_stock). A repeat throws CONFLICT with details.kind "file"|"invoice". */
    async importStock(args){
      const r = await db().rpc("hangtag_import_stock", args);
      if(r.error) throw toAppError(r.error);
      return r.data;
    },
    /* A supplier bill's original (photo or PDF) in the shop's private folder of the "hangtag-bills" bucket (section 3p) */
    async uploadBillDocument(path, blob, type){
      const st = db().storage; if(!st) throw new AppError(ERROR_CODES.NOT_CONFIGURED, "File storage isn't available.");
      const r = await st.from('hangtag-bills').upload(path, blob, { upsert: true, contentType: type || (blob && blob.type) || 'application/octet-stream' });
      if(r.error) throw toAppError(r.error);
      return path;
    },
    /* A private link to it, valid for an hour */
    async billDocumentUrl(path){
      const r = await db().storage.from('hangtag-bills').createSignedUrl(path, 3600);
      if(r.error) throw toAppError(r.error);
      return r.data && r.data.signedUrl || "";
    },
    /* A saved bill gets its original once the file reached the cloud after it */
    async setImportDocument(id, path){ sbOk(await table('hangtag_stock_imports').update({ document_path: path }).eq('id', id)); },

    /* ---------- suppliers, purchases and payments to suppliers (schema.sql section 3l) ---------- */
    async saveSupplier(s){ sbOk(await table('hangtag_suppliers').upsert(supplierRow(s))); },
    /* A purchase with its stock-in records, all or nothing (RPC hangtag_save_purchase; the same id again changes nothing)
       → { status: "saved"|"already_saved", purchase_id } */
    async savePurchase(p, moves){
      const r = await db().rpc('hangtag_save_purchase', purchaseArgs(p, moves));
      if(r.error) throw toAppError(r.error);
      return r.data;
    },
    /* Cancel a purchase: its stock goes back out and cash paid comes back (RPC hangtag_cancel_purchase; again: nothing changes) */
    async cancelPurchase(id, reason, device, t){
      const r = await db().rpc('hangtag_cancel_purchase', { p_id: id, p_reason: reason, p_device: device || null, p_t: t || null });
      if(r.error) throw toAppError(r.error);
      return r.data;
    },
    /* Payments are only ever added (a mistake gets a reversal): an upload sent twice leaves the first one as it is */
    async saveSupplierPayment(x){ sbOk(await table('hangtag_supplier_payments').upsert(supplierPaymentRow(x), { onConflict:'owner_id,id', ignoreDuplicates:true })); },
    fetchSuppliers: async () => (await sbFetchAll(db(), 'hangtag_suppliers', ['created_at','id'])).map(rowToSupplier),
    async fetchPurchases(){
      const out = [], N = 1000;
      for(let from = 0; ; from += N){
        const { data } = sbOk(await table('hangtag_stock_imports').select('*').eq('kind', 'purchase').order('t').order('id').range(from, from + N - 1));
        out.push(...(data || []));
        if(!data || data.length < N) break;
      }
      return out.map(rowToPurchase);
    },
    fetchSupplierPayments: async () => (await sbFetchAll(db(), 'hangtag_supplier_payments', ['t','id'])).map(rowToSupplierPayment),
    /* A fingerprint of suppliers, purchases and supplier payments (a team member's phone downloads them only when it moved) */
    async purchaseChanges(){
      const r = await db().rpc('hangtag_purchase_changes');
      if(r.error) throw toAppError(r.error);
      return String(r.data == null ? "" : r.data);
    },
    /* Edge Function payment-gateway (Razorpay UPI QR / card link intents; the keys stay in the function):
       body { action, ... } → its answer. Throws an AppError: NOT_CONFIGURED, VALIDATION, CONFLICT, NOT_FOUND, AUTH,
       DELIVERY (the provider refused), NETWORK. */
    paymentIntent: body => callFunction("payment-gateway", body, "Verified payments"),
    /* agent: the Hangtag Agent's optional AI provider ({ action: "config" } or one "step") */
    agentStep: body => callFunction("agent", body, "The Hangtag Agent's AI"),
    /* Hangtag plans (schema.sql section 3t): the shop's plan (works while it is locked), the plans on sale, a plan's price
       with a promo code (computed by the database), the owner's plan payments, and the subscription function (checkout,
       verify) — the browser never sends a price, discount or amount */
    async subscriptionStatus(){ const { data } = sbOk(await db().rpc('hangtag_subscription_status')); return data || null; },
    async subscriptionPlans(){ const { data } = sbOk(await db().rpc('hangtag_subscription_plans')); return Array.isArray(data) ? data : []; },
    async subscriptionQuote(plan, promo){ const { data } = sbOk(await db().rpc('hangtag_subscription_quote', { p_plan: plan, p_promo: promo || null })); return data || null; },
    async subscriptionAutopayQuote(){ const { data } = sbOk(await db().rpc('hangtag_autopay_quote')); return data || null; },
    async subscriptionPayments(){
      const { data } = sbOk(await table('hangtag_subscription_payments').select('id, plan_code, price, discount, amount, currency, promo_code, status, kind, created_at, paid_at, period_start, period_end')
        .order('created_at', { ascending: false }).limit(20));
      return Array.isArray(data) ? data : [];
    },
    subscriptionCall: body => callFunction("subscription", body, "Online payment"),
    /* send-receipt: ask the providers what happened to a bill's messages (delivered / failed) → { updated } */
    deliveryRefresh: saleId => callFunction("send-receipt", { action:"refresh", sale_id:saleId }, "Sending bills"),
    /* send-receipt: the bill's secure invoice link (made once, kept 12 months) → { url, token, expiresAt } */
    invoiceLink: saleId => callFunction("send-receipt", { action:"link", sale_id:saleId }, "Invoice links"),
    /* Stops every invoice link of a bill from working */
    async revokeInvoiceLinks(saleId){
      await mustReach('hangtag_invoice_links', 'token', q => q.update({ revoked_at:new Date().toISOString() }), q => q.eq('sale_id', saleId).is('revoked_at', null));
    },
    /* An Edge Function's answer (body { action, ... }); throws an AppError (see callFunction above). what = the feature, for
       "… isn't set up yet" */
    callFunction,

    /* ---------- the shop's team (section 3i; members, devices and enrollment tokens are written by the team function) ---------- */
    /* This phone's standing in its shop: { shopId, role, deviceId } (shopId null: a member whose phone no longer reaches the
       shop: revoked, disabled or no key). Also keeps "last seen" of a member's device. */
    async touchDevice(){
      const r = await db().rpc('hangtag_touch_device');
      if(r.error) throw toAppError(r.error);
      const d = r.data && typeof r.data === 'object' && !Array.isArray(r.data) ? r.data : {};
      return { shopId: d.shop_id || null, role: d.role || null, deviceId: d.device_id || null };
    },
    /* The owner reads the whole team; a member only its own row (row security) */
    fetchMembers: async () => (sbOk(await table('hangtag_members').select('user_id,shop_id,name,username,role,status,created_at,last_seen_at').order('created_at')).data || []).map(rowToMember),
    /* The owner reads every device of the shop; a member its own (the key's hash is never read) */
    fetchDevices: async () => (sbOk(await table('hangtag_devices').select('id,user_id,name,platform,status,enrolled_at,last_seen_at,revoked_at').order('enrolled_at')).data || []).map(rowToDevice),
    /* The shop's own permission lists per role (no row = the defaults) */
    fetchRoles: async () => (sbOk(await table('hangtag_roles').select('role,label,permissions,updated_at')).data || []).map(rowToRole),
    /* The owner saves a role's permissions (the database refuses anyone else, and unknown permissions) */
    async saveRole(r){ sbOk(await table('hangtag_roles').upsert(roleRow(r))); },

    /* Earlier imports with the same file fingerprint or invoice number (newest first) */
    async findImports({ fileHash, invoiceNo }){
      const cols = "id,file_hash,file_name,supplier_name,supplier_gstin,invoice_no,invoice_date,units,created_at";
      const out = [];
      if(fileHash) out.push(...sbOk(await table("hangtag_stock_imports").select(cols).eq("file_hash", fileHash).order("created_at", { ascending: false }).limit(5)).data || []);
      if(invoiceNo) out.push(...sbOk(await table("hangtag_stock_imports").select(cols).ilike("invoice_no", String(invoiceNo).trim().replace(/[\\%_]/g, m => "\\" + m)).order("created_at", { ascending: false }).limit(5)).data || []);
      const seen = new Set();
      return out.filter(r => !seen.has(r.id) && seen.add(r.id)).map(rowToImport);
    },
    /* ---------- sending bills to customers (Edge Function send-receipt; provider keys live there) ---------- */
    /* Which channels the shop's server has a provider for: { email, whatsapp, sms } (null when it can't be asked) */
    async deliveryChannels(){
      try{
        const r = await db().functions.invoke("send-receipt", { body: { action: "channels" } });
        return !r.error && r.data && r.data.channels ? r.data.channels : null;
      }catch{ return null; }
    },
    /* body: { channel, sale_id } → { status: "sent", recipient, provider, provider_message_id }. Throws an AppError when it
       wasn't sent: NOT_CONFIGURED, VALIDATION (no contact, cancelled, too many), AUTH, DELIVERY (the provider refused) */
    async sendReceipt(body){
      let r;
      try{ r = await db().functions.invoke("send-receipt", { body: { action: "send", ...body } }); }
      catch(e){ throw toAppError(e); }
      if(!r.error && r.data && (r.data.status === "sent" || r.data.status === "delivered") && r.data.provider_message_id) return r.data;
      let info = null;
      try{ info = r.error && r.error.context && typeof r.error.context.json === "function" ? await r.error.context.json() : (r.data || null); }catch{ info = null; }
      const msg = info && info.message, status = r.error && r.error.context && r.error.context.status;
      if(info && info.error === "subscription_inactive") throw new AppError(ERROR_CODES.SUBSCRIPTION, msg || "This shop's Hangtag plan has ended. Renew it in Plans & Billing.", { cause: r.error, details: info });
      if(info && info.error === "not_configured") throw new AppError(ERROR_CODES.NOT_CONFIGURED, msg || "Sending isn't set up yet.", { cause: r.error, details: info });
      // bad_recipient / provider_setup: the provider refused for good (the customer's contact, the shop's set-up) — final
      if(info && ["missing_contact","cancelled","rate_limited","not_found","bad_request","bad_channel","too_long","busy","bad_recipient","provider_setup"].includes(info.error)) throw new AppError(ERROR_CODES.VALIDATION, msg || "The bill couldn't be sent.", { cause: r.error, details: info });
      if(info && info.error === "unauthorized") throw new AppError(ERROR_CODES.AUTH, "Sign in again to send bills.", { cause: r.error, details: info });
      if(info && info.error === "provider_error") throw new AppError(ERROR_CODES.DELIVERY, msg || "The message wasn't accepted.", { cause: r.error, details: info });
      // not the function's own answer: the platform's (function not deployed, sign-in rejected)
      if(r.error && !(info && info.error) && (status === 404 || /relay|404|not found/i.test(String(r.error.message || "") + " " + String(info && (info.message || info.msg) || ""))))
        throw new AppError(ERROR_CODES.NOT_CONFIGURED, "Sending bills isn't set up yet.", { cause: r.error, details: info });
      if(r.error && !(info && info.error) && status === 401) throw new AppError(ERROR_CODES.AUTH, "Sign in again to send bills.", { cause: r.error, details: info });
      if(r.error) throw toAppError(r.error);
      throw new AppError(ERROR_CODES.DELIVERY, "The message wasn't confirmed as sent.", { details: info });
    },
    /* Supabase Edge Function extract-bill: { file_name, mime_type, data (base64), file_hash } → the extraction. Its refusals
       come as an error status (before reading starts) or, once the answer streams, as 200 with { ok:false, error, message }. */
    async extractBill(body){
      let r;
      try{ r = await db().functions.invoke("extract-bill", { body }); }
      catch(e){ throw toAppError(e); }
      if(!r.error && !(r.data && r.data.ok === false)) return r.data;
      let info = r.error ? null : r.data;
      if(r.error){ try{ info = r.error.context && typeof r.error.context.json === "function" ? await r.error.context.json() : null; }catch{ info = null; } }
      const E = (c, m) => new AppError(c, m, { cause: r.error || undefined, details: info });
      if(info && info.error === "subscription_inactive") throw E(ERROR_CODES.SUBSCRIPTION, info.message || "This shop's Hangtag plan has ended. Renew it in Plans & Billing.");
      if(info && info.error === "not_configured") throw E(ERROR_CODES.NOT_CONFIGURED, "Reading bills isn't set up yet.");
      if(info && info.error === "unauthorized") throw E(ERROR_CODES.AUTH, "Sign in again to read bills.");
      // busy, rate-limited or the reading service failing: worth trying again (the message says when)
      if(info && ["busy", "rate_limited", "provider_error", "no_response", "bad_output"].includes(info.error)) throw E(ERROR_CODES.NETWORK, info.message || "The bill couldn't be read right now. Try again.");
      if(info && info.message) throw E(ERROR_CODES.VALIDATION, info.message);
      if(r.error && /relay|404|not found/i.test(String(r.error.message || "")) && !info) throw E(ERROR_CODES.NOT_CONFIGURED, "Reading bills isn't set up yet.");
      if(r.error) throw toAppError(r.error);
      throw E(ERROR_CODES.UNKNOWN, "The bill couldn't be read. Try again, or enter the lines by hand.");
    },
  };
}
