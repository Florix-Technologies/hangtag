// extract-bill with the REAL Claude API: the function's own provider (providers/claude.js), request (core.js buildRequest:
// the extraction schema, adaptive thinking, the effort, the server-side fallback) and reading of the answer
// (parseModelResponse, normalizeExtraction), on a made-up supplier bill. Only the HTTP call is this script's (the function
// uses the Anthropic SDK, streaming; this streams the same request with fetch). It costs money and needs a key, so it runs
// only when asked; it is not one of the suites `npm test` runs:
//   HANGTAG_EVAL_ANTHROPIC_KEY=sk-ant-… npm run eval:extract-bill
//   optional: EXTRACT_MODEL, EXTRACT_EFFORT (default: the function's own), HANGTAG_EVAL_ANTHROPIC_URL (a stand-in server)
// Without a key it says so and exits 0. Pass: the API takes the request (the schema compiles — AUDIT item 16), the answer
// parses, and the bill's number, GSTIN and every line with its quantity and rate come back. Nothing is logged but the
// checks and the token counts; the full result goes to tests/.artifacts/extract-bill-eval.json.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClaudeProvider } from '../../supabase/functions/extract-bill/providers/claude.js';
import { DEFAULT_EFFORT, DEFAULT_MODEL } from '../../supabase/functions/extract-bill/core.js';

const key = process.env.HANGTAG_EVAL_ANTHROPIC_KEY || process.env.ANTHROPIC_API_KEY || '';
if (!key) {
  console.log('SKIP the real-provider check of extract-bill: set HANGTAG_EVAL_ANTHROPIC_KEY (an Anthropic API key) to run it.');
  process.exit(0);
}
const URL_ = process.env.HANGTAG_EVAL_ANTHROPIC_URL || 'https://api.anthropic.com/v1/messages';
const model = process.env.EXTRACT_MODEL || DEFAULT_MODEL, effort = process.env.EXTRACT_EFFORT || DEFAULT_EFFORT;

// The SDK's client.beta.messages.stream(params).finalMessage(), over fetch: betas go in the anthropic-beta header,
// the events are collected into the final message
async function finalMessage(res) {
  const dec = new TextDecoder(), blocks = [];
  let buf = '', msg = null;
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true }).replace(/\r\n/g, '\n');
    for (let i; (i = buf.indexOf('\n\n')) >= 0;) {
      const data = buf.slice(0, i).split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
      buf = buf.slice(i + 2);
      if (!data) continue;
      const ev = JSON.parse(data);
      if (ev.type === 'message_start') msg = { ...ev.message, content: [] };
      else if (ev.type === 'content_block_start') blocks[ev.index] = { ...ev.content_block };
      else if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta') blocks[ev.index].text = (blocks[ev.index].text || '') + ev.delta.text;
      else if (ev.type === 'message_delta') { msg.stop_reason = ev.delta && ev.delta.stop_reason; msg.usage = { ...msg.usage, ...ev.usage }; }
      else if (ev.type === 'error') throw Object.assign(new Error(`stream error: ${ev.error && ev.error.type}: ${ev.error && ev.error.message}`), { status: 500 });
    }
  }
  return msg && { ...msg, content: blocks.filter(Boolean) };
}
let usage = null, stopReason = null;
const client = { beta: { messages: { stream: ({ betas, ...params }) => ({ finalMessage: async () => {
  const res = await fetch(URL_, { method: 'POST', body: JSON.stringify({ ...params, stream: true }), headers: {
    'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json', ...(betas && betas.length ? { 'anthropic-beta': betas.join(',') } : {}) } });
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 600)}`), { status: res.status });
  const m = await finalMessage(res);
  usage = m && m.usage; stopReason = m && m.stop_reason;
  return m;
} }) } } };

// A made-up bill as a one-page PDF (Courier, so its columns line up as a printed bill's do)
const BILL = ['TAX INVOICE', 'Sample Wholesale Textiles (test data)        GSTIN: 27AAAAA0000A1Z5', 'Invoice No: EV-1042                         Date: 03-10-2026',
  'Bill to: Test Retail Shop', '', 'Sr  Description            HSN    Qty  Unit   Rate      Amount', '1   Cotton shirt blue M    6205    10  PCS    450.00    4500.00',
  '2   Denim jeans 32         6203     6  PCS    899.00    5394.00', '3   Silk scarf red         6214    12  PCS    250.00    3000.00', '',
  '                                  Taxable value      12894.00', '                                  CGST 2.5%            322.35',
  '                                  SGST 2.5%            322.35', '                                  Grand total    Rs. 13538.70'];
const WANT = [{ name: /shirt/i, quantity: 10, unit_price: 450 }, { name: /jeans/i, quantity: 6, unit_price: 899 }, { name: /scarf/i, quantity: 12, unit_price: 250 }];
function pdf(lines) {
  const esc = (s) => s.replace(/[\\()]/g, (c) => '\\' + c);
  const content = ['BT', '/F1 10 Tf', '14 TL', '40 800 Td', ...lines.flatMap((l) => [`(${esc(l)}) Tj`, 'T*']), 'ET'].join('\n');
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>', `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`];
  let out = '%PDF-1.4\n';
  const at = objs.map((o, i) => { const n = Buffer.byteLength(out, 'latin1'); out += `${i + 1} 0 obj\n${o}\nendobj\n`; return n; });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${at.map((n) => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

let fails = 0;
const check = (name, ok, info) => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (!ok && info !== undefined ? '\n     ' + JSON.stringify(info).slice(0, 900) : '')); };
console.log(`extract-bill on the real provider: ${model}, effort ${effort}${process.env.HANGTAG_EVAL_ANTHROPIC_URL ? ' (stand-in server)' : ''}`);
const t0 = Date.now();
let r, err = null;
try { r = await createClaudeProvider(client, { model, effort }).extract({ data: pdf(BILL).toString('base64'), mimeType: 'application/pdf', fileName: 'eval-bill.pdf' }); }
catch (e) { err = { status: e.status, message: String(e.message || e) }; }
const secs = Math.round((Date.now() - t0) / 100) / 10;
check('the API takes the request (the extraction schema compiles, the model and options are accepted)', !err, err);
check('the answer is read as a bill (not refused, not cut short, valid JSON)', !!r && r.ok === true, r && { error: r.error, message: r.message, stopReason });
const res = (r && r.result) || { lines: [] };
check('the invoice number and the supplier\'s GSTIN', res.invoice && res.invoice.number === 'EV-1042' && res.supplier && res.supplier.gstin === '27AAAAA0000A1Z5', { invoice: res.invoice, gstin: res.supplier && res.supplier.gstin });
for (const w of WANT) {
  const line = res.lines.find((l) => w.name.test(l.name || ''));
  check(`the line ${w.name.source}: ${w.quantity} at ${w.unit_price}`, !!line && line.quantity === w.quantity && line.unit_price === w.unit_price, line);
}
check('no other lines (totals and tax rows are not products)', res.lines.length === WANT.length, res.lines.map((l) => l.name));
check(`answered within the platform's limits (${secs}s; the function streams, but a bill this size should be quick)`, secs < 150, secs);
console.log(`tokens: ${usage ? `${usage.input_tokens} in, ${usage.output_tokens} out` : 'n/a'}; stop: ${stopReason}; ${secs}s`);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
fs.mkdirSync(path.join(ROOT, 'tests', '.artifacts'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'tests', '.artifacts', 'extract-bill-eval.json'), JSON.stringify({ model, effort, secs, usage, stopReason, err, result: r }, null, 2));
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
