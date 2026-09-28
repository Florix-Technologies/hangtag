// The "cloud" port: every call the app makes to Supabase (auth, tables, realtime, RPC), in one place.
// Features never see supabase-js. getClient() is read on every call, so the current client (or a test's fake) is used.
import { makeSbClient } from './client.js';
import { toAppError } from './errors.js';
import { AppError, ERROR_CODES } from '../../shared/errors/app-error.js';
import { sbFetchAll, sbOk } from './query.js';
import { billArgs, cashMoveRow, custRow, dayCloseRow, eventRow, moveRow, productRow, returnArgs, rowToCashMove, rowToCustomer, rowToDayClose, rowToDelivery, rowToEvent, rowToImport, rowToItem, rowToMove, rowToPayment, rowToProduct, rowToReturn, rowToReturnItem, rowToSale, rowToVariant, variantRows } from './mappers.js';

export function createCloudGateway({ getClient, url, key, storageKey }){
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
    if(code === "not_configured") throw E(ERROR_CODES.NOT_CONFIGURED, msg || `${what} isn't set up yet.`);
    if(code === "unauthorized" || (!code && status === 401)) throw E(ERROR_CODES.AUTH, "Sign in again.");
    if(code === "provider_error") throw E(ERROR_CODES.DELIVERY, msg || "The provider didn't accept the request.");
    if(code === "conflict") throw E(ERROR_CODES.CONFLICT, msg || "That was already done.");
    if(code === "not_found") throw E(ERROR_CODES.NOT_FOUND, msg || "It wasn't found.");
    if(code === "server_error") throw E(ERROR_CODES.NETWORK, msg || "The server couldn't do it. Try again.");
    if(code) throw E(ERROR_CODES.VALIDATION, msg || "The request was refused.");
    if(r.error && (status === 404 || /relay|404|not found/i.test(String(r.error.message || "")))) throw E(ERROR_CODES.NOT_CONFIGURED, `${what} isn't set up yet.`);
    if(r.error) throw toAppError(r.error);
    throw E(ERROR_CODES.UNKNOWN, "The server's answer wasn't understood.");
  }
  return {
    /* A new client for this app's project; supabase-js keeps the session under storageKey */
    createClient: () => makeSbClient({ url, key, storageKey }),
    auth,
    /* How an email signs in today: resolves the raw { data, error } of the RPC */
    signInMethods: email => db().rpc("hangtag_sign_in_methods", { p_email: email }),
    /* Quick check that the database has the current tables (schema.sql has been run; the events table is the newest).
       Resolves { error: null } or { error: AppError } — OUTDATED_DATABASE when the tables are missing. */
    async checkSchema(){
      const { error } = await table('hangtag_events').select('id', { head: true, count: 'exact' });
      if(!error) return { error: null };
      const missing = /hangtag_events|hangtag_payments|hangtag_stock_imports|hangtag_variants|PGRST205|42P01|does not exist|schema cache/i.test((error.code||"")+" "+(error.message||""));
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
    async setSaleVoid(id, isVoid, reason){ sbOk(await table('hangtag_sales').update({ is_void: isVoid, void_reason: isVoid ? String(reason || "").slice(0, 200) || null : null }).eq('id', id)); },
    /* index = the product's position in the list (its sort order) */
    async saveProduct(p, index){
      sbOk(await table('hangtag_products').upsert(productRow(p, index)));
      const rows = variantRows(p);
      if(rows.length) sbOk(await table('hangtag_variants').upsert(rows));
    },
    async deleteVariants(ids){ sbOk(await table('hangtag_variants').delete().in('id', ids)); },
    async deleteProduct(id){
      sbOk(await table('hangtag_products').delete().eq('id', id));
      sbOk(await table('hangtag_images').delete().eq('product_id', id));
    },
    /* dataUrl = the photo, or empty to remove it */
    async saveImage(productId, dataUrl){
      if(dataUrl) sbOk(await table('hangtag_images').upsert({ product_id:productId, image_data:dataUrl, updated_at:new Date().toISOString() }));
      else sbOk(await table('hangtag_images').delete().eq('product_id', productId));
    },
    async saveMove(m){ sbOk(await table('hangtag_stock_moves').upsert(moveRow(m))); },
    /* A return with its lines, all or nothing (RPC hangtag_save_return: the database refuses a return on a cancelled bill, or of
       more pieces than a bill line has left — also when another device returned them first). Saving it again is a safe retry. */
    async saveReturn(ret){ sbOk(await db().rpc('hangtag_save_return', returnArgs(ret))); },
    async saveCustomer(c){ sbOk(await table('hangtag_customers').upsert(custRow(c))); },
    async saveEvent(e){ sbOk(await table('hangtag_events').upsert(eventRow(e))); },
    /* The database refuses deleting an event that has bills */
    async deleteEvent(id){ sbOk(await table('hangtag_events').delete().eq('id', id)); },
    /* Cash entries are never changed: a repeat upload of the same entry does nothing */
    async saveCashMove(m){ sbOk(await table('hangtag_cash_moves').upsert(cashMoveRow(m), { onConflict:'owner_id,id', ignoreDuplicates:true })); },
    async saveDayClose(c){ sbOk(await table('hangtag_day_closes').upsert(dayCloseRow(c))); },
    async saveSettings(settings){ sbOk(await table('hangtag_meta').upsert({ key:'settings', value:settings, updated_at:new Date().toISOString() })); },
    /* The shop logo for receipts (a small data URL), or empty to remove it */
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
    async fetchLogo(){
      const { data } = sbOk(await table('hangtag_meta').select('value').eq('key','logo').maybeSingle());
      return data && data.value && typeof data.value.data === 'string' ? data.value.data : "";
    },
    /* A bill's messages to its customer, newest first */
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
    /* Edge Function payment-gateway (Razorpay UPI QR / card link intents; the keys stay in the function):
       body { action, ... } → its answer. Throws an AppError: NOT_CONFIGURED, VALIDATION, CONFLICT, NOT_FOUND, AUTH,
       DELIVERY (the provider refused), NETWORK. */
    paymentIntent: body => callFunction("payment-gateway", body, "Verified payments"),
    /* send-receipt: ask the providers what happened to a bill's messages (delivered / failed) → { updated } */
    deliveryRefresh: saleId => callFunction("send-receipt", { action:"refresh", sale_id:saleId }, "Sending bills"),
    /* send-receipt: the bill's secure invoice link (made once, kept 12 months) → { url, token, expiresAt } */
    invoiceLink: saleId => callFunction("send-receipt", { action:"link", sale_id:saleId }, "Invoice links"),
    /* Stops every invoice link of a bill from working */
    async revokeInvoiceLinks(saleId){
      sbOk(await table('hangtag_invoice_links').update({ revoked_at:new Date().toISOString() }).eq('sale_id', saleId).is('revoked_at', null));
    },
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
      if(info && info.error === "not_configured") throw new AppError(ERROR_CODES.NOT_CONFIGURED, msg || "Sending isn't set up yet.", { cause: r.error, details: info });
      if(info && ["missing_contact","cancelled","rate_limited","not_found","bad_request","bad_channel","too_long","busy"].includes(info.error)) throw new AppError(ERROR_CODES.VALIDATION, msg || "The bill couldn't be sent.", { cause: r.error, details: info });
      if(info && info.error === "unauthorized") throw new AppError(ERROR_CODES.AUTH, "Sign in again to send bills.", { cause: r.error, details: info });
      if(info && info.error === "provider_error") throw new AppError(ERROR_CODES.DELIVERY, msg || "The message wasn't accepted.", { cause: r.error, details: info });
      // not the function's own answer: the platform's (function not deployed, sign-in rejected)
      if(r.error && !(info && info.error) && (status === 404 || /relay|404|not found/i.test(String(r.error.message || "") + " " + String(info && (info.message || info.msg) || ""))))
        throw new AppError(ERROR_CODES.NOT_CONFIGURED, "Sending bills isn't set up yet.", { cause: r.error, details: info });
      if(r.error && !(info && info.error) && status === 401) throw new AppError(ERROR_CODES.AUTH, "Sign in again to send bills.", { cause: r.error, details: info });
      if(r.error) throw toAppError(r.error);
      throw new AppError(ERROR_CODES.DELIVERY, "The message wasn't confirmed as sent.", { details: info });
    },
    /* Supabase Edge Function extract-bill: { file_name, mime_type, data (base64), file_hash } → the extraction */
    async extractBill(body){
      let r;
      try{ r = await db().functions.invoke("extract-bill", { body }); }
      catch(e){ throw toAppError(e); }
      if(!r.error) return r.data;
      let info = null;
      try{ info = r.error.context && typeof r.error.context.json === "function" ? await r.error.context.json() : null; }catch{ info = null; }
      if(info && info.error === "not_configured") throw new AppError(ERROR_CODES.NOT_CONFIGURED, "Reading bills isn't set up yet.", { cause: r.error, details: info });
      if(info && info.message) throw new AppError(ERROR_CODES.VALIDATION, info.message, { cause: r.error, details: info });
      if(/relay|404|not found/i.test(String(r.error.message || "")) && !info) throw new AppError(ERROR_CODES.NOT_CONFIGURED, "Reading bills isn't set up yet.", { cause: r.error });
      throw toAppError(r.error);
    },
  };
}
