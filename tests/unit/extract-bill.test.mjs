// Supplier bill extraction (supabase/functions/extract-bill): upload checks, the request sent to Claude (PDF as a document,
// photos as images, JSON schema output), stop reasons, and normalisation. A fake SDK client records requests; no network.
// Run: npm run test:unit
import { ACCEPTED_TYPES, EXTRACTION_SCHEMA, FALLBACK_BETA, MAX_BYTES, SYSTEM_PROMPT, buildRequest, extractRateLimits, normalizeExtraction, normalizeUnit, parseModelResponse, rateSubject, toNumber, validateUpload } from '../../supabase/functions/extract-bill/core.js';
import { readFileSync } from 'node:fs';
import { createClaudeProvider } from '../../supabase/functions/extract-bill/providers/claude.js';
import { MOCK_EXTRACTION, createMockProvider } from '../../supabase/functions/extract-bill/providers/mock.js';

let passed = 0, failed = 0;
function check(name, ok, info) {
  if (ok) passed++; else failed++;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (!ok && info !== undefined ? '\n     ' + JSON.stringify(info) : ''));
}
// a tiny real PDF and PNG (content doesn't matter here: extraction is faked)
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF').toString('base64');
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

// ---------- upload checks ----------
check('a PDF upload is accepted', validateUpload({ file_name: 'bill.pdf', mime_type: 'application/pdf', data: PDF, file_hash: 'abc' }).ok);
check('an image upload is accepted (data: prefix stripped)', (() => { const r = validateUpload({ mime_type: 'image/png', data: 'data:image/png;base64,' + PNG }); return r.ok && r.data === PNG; })());
check('PDF, JPG, PNG and WebP are the accepted types', ACCEPTED_TYPES.join() === 'application/pdf,image/jpeg,image/png,image/webp');
check('other types → 415 unsupported_type', validateUpload({ mime_type: 'text/html', data: PNG }).status === 415);
check('missing data → 400', validateUpload({ mime_type: 'image/png' }).status === 400 && validateUpload(null).status === 400);
check('not base64 → 400', validateUpload({ mime_type: 'image/png', data: 'not base64!!' }).status === 400);
check('over 15 MB → 413 too_large', validateUpload({ mime_type: 'image/jpeg', data: 'A'.repeat(Math.ceil((MAX_BYTES + 10) * 4 / 3)) }).status === 413);

// ---------- request ----------
const pdfReq = buildRequest({ data: PDF, mimeType: 'application/pdf', fileName: 'bill.pdf' });
const imgReq = buildRequest({ data: PNG, mimeType: 'image/png', fileName: 'photo.png', model: 'claude-sonnet-5' });
const block = (r) => r.messages[0].content[0];
check('PDF → a base64 document block before the instruction', block(pdfReq).type === 'document' && block(pdfReq).source.media_type === 'application/pdf' && block(pdfReq).source.data === PDF && pdfReq.messages[0].content[1].type === 'text');
check('photo → a base64 image block', block(imgReq).type === 'image' && block(imgReq).source.media_type === 'image/png');
check('default model claude-opus-5; EXTRACT_MODEL-style override honoured', pdfReq.model === 'claude-opus-5' && imgReq.model === 'claude-sonnet-5');
check('answer constrained to the JSON schema (structured outputs), adaptive thinking, room for long bills',
  pdfReq.output_config.format.type === 'json_schema' && pdfReq.output_config.format.schema === EXTRACTION_SCHEMA && pdfReq.thinking.type === 'adaptive' && pdfReq.max_tokens >= 32000);
check('server-side refusal fallback on by default', pdfReq.fallbacks === 'default' && pdfReq.betas.includes(FALLBACK_BETA));
check('the prompt says never to invent values', /Never invent/.test(SYSTEM_PROMPT) && /null/.test(SYSTEM_PROMPT) && !pdfReq.tool_choice);
const everyObjectClosed = (s) => s.type !== 'object' ? (s.items ? everyObjectClosed(s.items) : (s.anyOf || []).every(everyObjectClosed))
  : s.additionalProperties === false && Object.keys(s.properties).every((k) => s.required.includes(k)) && Object.values(s.properties).every(everyObjectClosed);
check('schema: every object closed, every field required (unknown = null)', everyObjectClosed(EXTRACTION_SCHEMA));
check('schema: no unsupported constraints (minimum/maximum/minLength)', !/minimum|maximum|minLength|maxLength/.test(JSON.stringify(EXTRACTION_SCHEMA)));

// ---------- provider with a fake client ----------
const reqs = [];
const fake = (message) => ({ beta: { messages: { stream: (params) => { reqs.push(params); return { finalMessage: async () => message }; } } } });
const ok = { model: 'claude-opus-5', stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: JSON.stringify(MOCK_EXTRACTION) }] };
let r = await createClaudeProvider(fake(ok)).extract({ data: PDF, mimeType: 'application/pdf', fileName: 'bill.pdf' });
check('provider streams one request and returns the normalised lines', reqs.length === 1 && r.ok && r.result.lines.length === 4 && r.result.provider === 'claude' && r.result.supplier.gstin === '27ABCDE1234F1Z5', r);
check('multiple variants of one product come back as separate lines', r.result.lines.filter((l) => l.name === 'Dress').map((l) => l.options.map((o) => o.value).join('/')).join(',') === 'Black/M,Black/L,White/M');
r = await createClaudeProvider(fake({ stop_reason: 'refusal', content: [] })).extract({ data: PNG, mimeType: 'image/png' });
check('refusal → 422 refused (never treated as data)', !r.ok && r.status === 422 && r.error === 'refused');
r = await createClaudeProvider(fake({ stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"lines":[' }] })).extract({ data: PNG, mimeType: 'image/png' });
check('max_tokens → 422 truncated (a partial answer is not used)', !r.ok && r.error === 'truncated');
check('unparseable text → 502 bad_output', parseModelResponse({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'oops' }] }).error === 'bad_output');
const mock = await createMockProvider().extract();
check('mock provider returns a valid extraction without a key', mock.ok && mock.result.provider === 'mock' && mock.result.lines.length === 4);

// ---------- normalisation ----------
check('numbers: ₹, commas, % and Rs. are read; junk is null', toNumber('₹1,099.00') === 1099 && toNumber('5%') === 5 && toNumber('Rs. 12.5') === 12.5 && toNumber('abc') === null && toNumber('') === null);
const n = normalizeExtraction({ supplier: { name: '  Ravi   Textiles ', gstin: null }, invoice: { number: 'INV 9', date: '2026-02-30' }, lines: [
  { name: 'Kurta', options: [{ name: 'Size', value: 'XL' }, { name: '', value: 'x' }], quantity: '2', unit_price: '₹450', total_price: null, hsn: '6204 ', gst_rate: '5%', confidence: 1.7 },
  { name: null, description: null, options: [], quantity: null, unit_price: null, total_price: null, confidence: 0.2 },
  { name: 'Socks', options: [], quantity: 2.5, confidence: -1 },
], warnings: ['Skipped: freight'] });
check('strings trimmed; an impossible date becomes null', n.supplier.name === 'Ravi Textiles' && n.invoice.date === null && n.invoice.number === 'INV 9');
check('missing fields stay null (never invented)', n.lines[0].total_price === null && n.lines[0].mrp === null && n.lines[0].sku === null && n.lines[0].barcode === null && n.lines[0].brand === null);
check('parsed values: quantity 2, price 450, HSN digits, GST 5', n.lines[0].quantity === 2 && n.lines[0].unit_price === 450 && n.lines[0].hsn === '6204' && n.lines[0].gst_rate === 5);
check('confidence clamped to 0..1', n.lines[0].confidence === 1 && n.lines[1].confidence === 0);
check('fully empty lines are dropped; half-empty options removed', n.lines.length === 2 && n.lines[0].options.length === 1);
check('a fractional quantity is kept and warned about', n.lines[1].quantity === 2.5 && n.warnings.some((w) => /fractional; check the unit/.test(w)) && n.warnings[0] === 'Skipped: freight');
check('printed units are normalised to the catalog units (Nos → pcs, Ltrs → l, Kgs → kg); unknown or absent stays null',
  normalizeUnit('Nos') === 'pcs' && normalizeUnit('Ltrs.') === 'l' && normalizeUnit('KGS') === 'kg' && normalizeUnit('mtr') === 'm' && normalizeUnit('bundle') === null && normalizeUnit(null) === null && n.lines[1].unit === null);
const u = normalizeExtraction({ lines: [{ name: 'Rice', quantity: 2.5, unit: 'Kgs' }, { name: 'Cloth', quantity: 1.255, unit: 'mtr' }, { name: 'Soap', quantity: 3, unit: 'Nos' }] });
check('a decimal quantity in kg is kept without a warning; too many decimals for metres is warned about',
  u.lines[0].unit === 'kg' && u.lines[0].quantity === 2.5 && u.lines[2].unit === 'pcs' && u.warnings.length === 1 && /too many decimal places for m/.test(u.warnings[0]), u.warnings);
check('nothing at all → empty but valid result', (() => { const e = normalizeExtraction(null); return e.ok && e.lines.length === 0 && e.supplier.name === null && e.currency === 'INR'; })());

// the rate limit: a paid AI service behind a free trial — each user and shop reads only so many bills, on counters of
// their own (not the Agent's), checked before the provider is called; nothing is sent when it can't be checked
{
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const id1 = 'aaaaaaaa-0000-0000-0000-000000000001', a = await rateSubject(id1), b = await rateSubject('aaaaaaaa-0000-0000-0000-000000000002');
  check('rate counters: a UUID per id, the same every time, different per id and never the id itself (the Agent keeps its own)',
    UUID.test(a) && UUID.test(b) && a !== b && a === await rateSubject(id1) && a !== id1);
  const d = extractRateLimits({}), e = extractRateLimits({ EXTRACT_RATE_PER_MINUTE: '2', EXTRACT_SHOP_RATE_PER_DAY: '0', EXTRACT_RATE_PER_DAY: 'lots' });
  check('limits: 6 a minute and 60 a day per user, 12 and 150 per shop; settable, 0 = none, nonsense = the default',
    JSON.stringify(d) === JSON.stringify({ p_per_minute: 6, p_per_day: 60, p_shop_per_minute: 12, p_shop_per_day: 150 })
    && e.p_per_minute === 2 && e.p_shop_per_day === 0 && e.p_per_day === 60);
  const src = readFileSync(new URL('../../supabase/functions/extract-bill/index.ts', import.meta.url), 'utf8');
  const take = src.indexOf('rpc("hangtag_agent_take"'), call = src.indexOf('p.extract(');
  check('the function takes from the limiter (its own counters) before calling the provider; refuses when it can\'t check; 429 when over',
    take > 0 && call > take && /p_user: await rateSubject\(user\.id\), p_shop: await rateSubject\(shopId\)/.test(src)
    && /if \(takeErr\)[^\n]*return reply\(503/.test(src) && /status: 429/.test(src));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
