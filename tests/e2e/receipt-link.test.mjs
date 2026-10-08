// The public receipt page behind a secure invoice link (receipt.html#<token>), end to end in Chrome. The "receipt" Edge
// Function is stood in for by the same steps it takes (supabase/functions/receipt/index.ts): the token is looked up in
// hangtag_invoice_links (PGlite running the real schema.sql), a revoked or expired one is "not valid any more", the bill is
// read only from the link's own shop, and the answer is shaped by the function's own billView and shopLogo (send-receipt/core.js).
// Checked: the right bill of the right shop (two shops use the same bill id), cancelled bills say CANCELLED, bad links
// are refused without asking anything, the page sends only the token with the publishable key (no service key anywhere
// in what the browser loads), the shop's logo on the side it chose and none when the shop switched it off.
import puppeteer from 'puppeteer-core';
import fs from 'fs';
import path from 'path';
import H from '../helpers/env.mjs';
import { createPgRest, CORS } from '../helpers/pg-rest.mjs';
import { ITEM_COLUMNS, PAYMENT_COLUMNS, PROFILE_COLUMNS, SALE_COLUMNS, billView, liveLink, shopLogo } from '../../supabase/functions/send-receipt/core.js';
await H.ensureServer();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const check = (n, ok, i) => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + n + (!ok && i !== undefined ? '  ' + JSON.stringify(i).slice(0, 500) : '')); };
const A = 'aaaaaaaa-0000-0000-0000-0000000000e1', B = 'bbbbbbbb-0000-0000-0000-0000000000e2';
const pg = await createPgRest(H.SCHEMA_PATH, { uid: A, email: 'a@example.com', users: [{ id: B, email: 'b@example.com' }] });
for (const [id, shop, total] of [[A, 'Aura Threads', 1050], [B, 'Other Shop', 99]]) {
  await pg.db.query(`INSERT INTO public.hangtag_profiles (id, email, shop_name, phone, city, state, onboarded_at) VALUES ($1, $2, $3, '9876543210', 'Pune', 'Maharashtra', now())
    ON CONFLICT (id) DO UPDATE SET shop_name = EXCLUDED.shop_name, city = EXCLUDED.city, state = EXCLUDED.state`, [id, id === A ? 'a@example.com' : 'b@example.com', shop]);
  await pg.db.query(`INSERT INTO public.hangtag_sales (owner_id, id, timestamp, subtotal, total, payment_method, bill_no) VALUES ($1, 's1', 1790000000000, $2, $4, 'cash', $3)`, [id, total, id === A ? 'INV-260929-ABC001' : 'B-1', total]);
  await pg.db.query(`INSERT INTO public.hangtag_sale_items (owner_id, sale_id, line_no, product_id, product_name, size, quantity, unit_price) VALUES ($1, 's1', 0, 'p1', $2, 'M', 1, $3)`, [id, id === A ? 'Kurta' : 'Secret item', total]);
}
const tok = (c) => c.repeat(43);
const link = (owner, t, extra = '') => pg.db.query(`INSERT INTO public.hangtag_invoice_links (token, owner_id, sale_id, expires_at${extra ? ', revoked_at' : ''}) VALUES ($1, $2, 's1', $3${extra ? ', now()' : ''})`,
  [t, owner, extra === 'expired' ? new Date(Date.now() - 864e5).toISOString() : new Date(Date.now() + 365 * 864e5).toISOString()]);
await link(A, tok('A')); await link(B, tok('B')); await link(A, tok('R'), 'revoked');
await pg.db.query(`INSERT INTO public.hangtag_invoice_links (token, owner_id, sale_id, expires_at) VALUES ($1, $2, 's1', now() - interval '1 day')`, [tok('E'), A]);

// the receipt function's steps, on the real tables (as the service role does: the token is the only key)
const fnCalls = [];
async function receiptFn(r) {
  if (r.method() === 'OPTIONS') return r.respond({ status: 204, headers: CORS });
  const h = r.headers(), body = JSON.parse(r.postData() || '{}');
  fnCalls.push({ apikey: h['apikey'] || null, auth: h['authorization'] || null, keys: Object.keys(body) });
  const reply = (status, b) => r.respond({ status, contentType: 'application/json', headers: CORS, body: JSON.stringify(b) });
  const gone = () => reply(404, { ok: false, error: 'not_found', message: "This invoice link isn't valid any more. Ask the shop for a new one." });
  const token = typeof body.token === 'string' ? body.token.trim() : '';
  if (!/^[A-Za-z0-9_-]{32,64}$/.test(token)) return gone();
  const l = (await pg.db.query(`SELECT token, owner_id, sale_id, expires_at, revoked_at, views FROM public.hangtag_invoice_links WHERE token = $1`, [token])).rows[0];
  if (!liveLink(l ? { ...l, expires_at: new Date(l.expires_at).toISOString() } : null)) return gone();
  const sale = (await pg.db.query(`SELECT ${SALE_COLUMNS} FROM public.hangtag_sales WHERE owner_id = $1 AND id = $2`, [l.owner_id, l.sale_id])).rows[0];
  if (!sale) return gone();
  const items = (await pg.db.query(`SELECT ${ITEM_COLUMNS} FROM public.hangtag_sale_items WHERE owner_id = $1 AND sale_id = $2 ORDER BY line_no`, [l.owner_id, sale.id])).rows;
  const payments = (await pg.db.query(`SELECT ${PAYMENT_COLUMNS} FROM public.hangtag_payments WHERE owner_id = $1 AND sale_id = $2 ORDER BY id`, [l.owner_id, sale.id])).rows;
  const shop = (await pg.db.query(`SELECT ${PROFILE_COLUMNS} FROM public.hangtag_profiles WHERE id = $1`, [l.owner_id])).rows[0];
  const meta = async (key) => ((await pg.db.query(`SELECT value FROM public.hangtag_meta WHERE owner_id = $1 AND key = $2`, [l.owner_id, key])).rows[0] || {}).value;
  const L = shopLogo(await meta('logo'), await meta('settings'));
  await pg.db.query(`UPDATE public.hangtag_invoice_links SET views = views + 1, last_viewed_at = now() WHERE token = $1`, [token]);
  return reply(200, { ok: true, bill: billView({ sale, items, payments, shop, customer: null }), cancelled: !!sale.is_void, logo: L ? L.url : null, logoAlign: L ? L.align : 'left', expiresAt: l.expires_at });
}

const browser = await puppeteer.launch({ executablePath: H.CHROME, headless: true });
const P = await (await browser.createBrowserContext()).newPage();
await P.setViewport({ width: 390, height: 844, isMobile: true });
P.on('pageerror', (e) => { fails++; console.log('[pageerror]', e.message); });
const loaded = [];
await P.setRequestInterception(true);
P.on('request', async (r) => {
  const u = r.url();
  if (u.startsWith('http://localhost:3210/')) { loaded.push(u); return r.continue(); }
  if (u.includes('.supabase.co/functions/v1/receipt')) return receiptFn(r);
  if (u.includes('.supabase.co/')) return r.abort();
  r.continue();
});
const open = async (hash) => { await P.goto('about:blank'); fnCalls.length = 0; await P.goto('http://localhost:3210/receipt.html' + hash, { waitUntil: 'networkidle0' }); await sleep(200); return P.$eval('#inv', (e) => e.innerText); };

let t = await open('#' + tok('A'));
check('a valid link shows that one bill: the shop, its number, the line and the total', /Aura Threads/.test(t) && /INV-260929-ABC001/.test(t) && /Kurta/.test(t) && /1,050/.test(t) && !/CANCELLED/.test(t), t.slice(0, 300));
check('…never the other shop\'s bill with the same id', !/Secret item|Other Shop/.test(t));
check('the page sends only the token, with the publishable key (as apikey and bearer) — no session, no service key', fnCalls.length === 1 && JSON.stringify(fnCalls[0].keys) === '["token"]' && /^sb_publishable_|^eyJ/.test(fnCalls[0].apikey || '')
  && fnCalls[0].auth === 'Bearer ' + fnCalls[0].apikey, fnCalls);
check('the link\'s views are counted', (await pg.db.query(`SELECT views FROM public.hangtag_invoice_links WHERE token = $1`, [tok('A')])).rows[0].views === 1);
// the shop's logo, as the shop prints it (Settings → Bills & Documents → Logo; hangtag_meta "logo" and "settings")
const putMeta = (key, value) => pg.db.query(`INSERT INTO public.hangtag_meta (owner_id, key, value) VALUES ($1, $2, $3) ON CONFLICT (owner_id, key) DO UPDATE SET value = EXCLUDED.value`, [A, key, JSON.stringify(value)]);
const logoOf = () => P.evaluate(() => { const i = document.querySelector('img.logo'); return i ? i.className + '|' + i.src.slice(0, 22) : ''; });
await putMeta('logo', { data: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==' });
t = await open('#' + tok('A'));
check('the shop\'s logo heads the online receipt, on the left when the shop chose no side (Auto)', (await logoOf()) === 'logo logo-left|data:image/png;base64,' && /Aura Threads/.test(t), await logoOf());
await putMeta('settings', { docLogo: true, docLogoAlign: 'right' });
t = await open('#' + tok('A'));
check('…on the right when the shop put it there', (await logoOf()) === 'logo logo-right|data:image/png;base64,', await logoOf());
await putMeta('settings', { docLogo: false, docLogoAlign: 'right' });
t = await open('#' + tok('A'));
check('…and none when the shop switched it off (the shop\'s name still heads it)', (await logoOf()) === '' && /Aura Threads/.test(t) && /Kurta/.test(t), await logoOf());
t = await open('#' + tok('B'));
check('shop B\'s link shows shop B\'s bill (the token decides the shop)', /Other Shop/.test(t) && /Secret item/.test(t) && !/Aura Threads/.test(t));
await pg.db.query(`UPDATE public.hangtag_sales SET is_void = true WHERE owner_id = $1 AND id = 's1'`, [A]);
t = await open('#' + tok('A'));
check('a cancelled bill: the page says CANCELLED', /CANCELLED/.test(t) && /Kurta/.test(t));
t = await open('#' + tok('R'));
check('a revoked link: "isn\'t valid any more" (nothing of the bill)', /isn't valid any more/.test(t) && !/Kurta/.test(t));
t = await open('#' + tok('E'));
check('an expired link: the same', /isn't valid any more/.test(t) && !/Kurta/.test(t));
t = await open('#' + tok('Z'));
check('a link nobody made: the same', /isn't valid any more/.test(t));
t = await open('#abc');
check('an incomplete link is refused on the page, without asking the server', /incomplete/.test(t) && fnCalls.length === 0);
const files = [...new Set(loaded.map((u) => new URL(u).pathname))].filter((f) => /\.(js|html)$/.test(f));
const shipped = files.map((f) => fs.readFileSync(path.join(H.ROOT, f === '/' ? 'index.html' : f), 'utf8')).join('\n');
check('nothing the page loads holds a service key or a secret', files.length >= 2 && !/service_role|SERVICE_ROLE|sb_secret_/.test(shipped), files);

await browser.close(); await pg.db.close();
console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
