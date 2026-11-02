// The plumbing of extract-bill-provider.eval.mjs, proven without a key against a local stand-in for the Messages API:
// the request is the one the extract-bill function sends (its key and version headers, the server-side fallback as the
// anthropic-beta header and not in the body, streaming, the JSON-schema answer format, adaptive thinking, the bill as a
// PDF document whose cross-reference table points at its objects); an answer streamed in pieces is put back together and
// read by the function's own code; a refused schema fails the check; and without a key the evaluation is skipped.
// Run: node tests/eval/extract-bill-provider-plumbing.test.mjs
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { FALLBACK_BETA } from '../../supabase/functions/extract-bill/core.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let fails = 0;
const check = (name, ok, info) => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (!ok && info !== undefined ? '\n     ' + JSON.stringify(info).slice(0, 900) : '')); };

const ANSWER = JSON.stringify({ supplier: { name: 'Sample Wholesale Textiles', gstin: '27AAAAA0000A1Z5' }, invoice: { number: 'EV-1042', date: '2026-10-03' }, currency: 'INR',
  lines: [['Cotton shirt blue M', 10, 450], ['Denim jeans 32', 6, 899], ['Silk scarf red', 12, 250]].map(([name, quantity, unit_price]) => ({
    name, description: '', brand: '', options: [], quantity, unit: 'PCS', unit_price, total_price: quantity * unit_price, mrp: null, sku: '', barcode: '', hsn: '', gst_rate: 5,
    tax_amount: null, confidence: 0.95, notes: '' })), warnings: [] });
const ev = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
const quarter = Math.ceil(ANSWER.length / 4);
const STREAM = [ev('message_start', { message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'stand-in', content: [], stop_reason: null, usage: { input_tokens: 1200, output_tokens: 1 } } }),
  ev('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '' } }), ev('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'Reading the bill.' } }),
  ev('content_block_stop', { index: 0 }), ev('content_block_start', { index: 1, content_block: { type: 'text', text: '' } }),
  ...[0, 1, 2, 3].map((k) => ev('content_block_delta', { index: 1, delta: { type: 'text_delta', text: ANSWER.slice(k * quarter, (k + 1) * quarter) } })),
  ev('content_block_stop', { index: 1 }), ev('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 320 } }), ev('message_stop', {})].join('');

let mode = 'answer';
const seen = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    seen.push({ headers: req.headers, body: JSON.parse(body) });
    if (mode === 'refuse') {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'Schema is too complex for compilation.' } }));
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    // in odd-sized pieces: events arrive split across reads, as they do over a real connection
    let i = 0;
    const step = () => { if (i >= STREAM.length) return res.end(); res.write(STREAM.slice(i, i + 97)); i += 97; setImmediate(step); };
    step();
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const run = (env) => new Promise((resolve) => {
  const child = spawn(process.execPath, [path.join(ROOT, 'tests', 'eval', 'extract-bill-provider.eval.mjs')], { cwd: ROOT,
    env: { ...process.env, ANTHROPIC_API_KEY: '', HANGTAG_EVAL_ANTHROPIC_URL: `http://127.0.0.1:${server.address().port}/v1/messages`, ...env } });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  child.on('close', (code) => resolve({ code, out }));
});

let r = await run({ HANGTAG_EVAL_ANTHROPIC_KEY: 'test-key' });
check('with a key, an answer streamed in pieces passes every check of the evaluation', r.code === 0 && /all passed/.test(r.out) && !/FAIL/.test(r.out), r.out.slice(-900));
const { headers: h, body: b } = seen[0] || { headers: {}, body: {} };
check('the key and the API version go in their headers', h['x-api-key'] === 'test-key' && h['anthropic-version'] === '2023-06-01');
check('the server-side fallback goes as the anthropic-beta header, not in the body', h['anthropic-beta'] === FALLBACK_BETA && !('betas' in b) && b.fallbacks === 'default', { beta: h['anthropic-beta'], betas: b.betas });
check('streamed, with the answer held to the JSON schema, adaptive thinking and the default effort', b.stream === true && b.output_config && b.output_config.format.type === 'json_schema'
  && !!b.output_config.format.schema && b.output_config.effort === 'high' && b.thinking && b.thinking.type === 'adaptive', { output_config: b.output_config && b.output_config.effort, thinking: b.thinking });
const doc = b.messages && b.messages[0].content[0];
const pdf = doc ? Buffer.from(doc.source.data, 'base64').toString('latin1') : '';
const sx = +(/startxref\n(\d+)/.exec(pdf) || [])[1];
const offsets = pdf.slice(sx).split('\n').filter((l) => / 00000 n $/.test(l)).map((l) => +l.slice(0, 10));
check('the bill goes as a PDF document whose cross-reference table points at each of its objects', doc && doc.type === 'document' && doc.source.media_type === 'application/pdf'
  && pdf.startsWith('%PDF-') && pdf.slice(sx, sx + 4) === 'xref' && offsets.length === 5 && offsets.every((o, i) => pdf.slice(o).startsWith(`${i + 1} 0 obj`)) && pdf.includes('EV-1042'), offsets);

mode = 'refuse';
r = await run({ HANGTAG_EVAL_ANTHROPIC_KEY: 'test-key' });
check('a refused request (the API\'s "Schema is too complex") fails the evaluation and says why', r.code === 1 && /FAIL the API takes the request/.test(r.out) && /Schema is too complex/.test(r.out), r.out.slice(-600));
r = await run({ HANGTAG_EVAL_ANTHROPIC_KEY: '' });
check('without a key it is skipped, not failed', r.code === 0 && /^SKIP /.test(r.out.trim()), r.out);
server.close();

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
