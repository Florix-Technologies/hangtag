// No hard-coded currency in the app: every amount goes through the shared formatter (src/shared/formatting/money.js),
// every money label through moneyLabel(), and numbers / dates through the region's locale — so another country is a
// region, not a search through the app. This scans the code (comments ignored) of src/ and the public pages' scripts for
// "₹", "Rs." / "Rs " and "en-IN" and fails on any that isn't on the explicit, commented allowlist below.
// Run: node tests/unit/currency-hardcoding.test.mjs        (LIST=1 prints every finding)
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
let fails = 0;
const check = (name, ok, info) => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (!ok && info !== undefined ? '  ' + JSON.stringify(info, null, 1).slice(0, 4000) : '')); };

/* Where these literals are the point, file by file (path → why). Anything else is a hard-coded currency. */
const ALLOW = {
  'src/shared/formatting/regions.js': 'the region definitions themselves (India: ₹, Rs., en-IN)',
  'src/shared/formatting/money.js': 'the one formatter (its comments and examples name the symbols)',
  'src/shared/formatting/dates.js': 'the default locale until the region configures it',
  // the privacy filter must recognise any amount written in any of India's ways, whatever the shop's region
  'src/shared/logging/diagnostics.js': 'removes amounts (₹ / Rs / INR) from diagnostics text',
  // speech recognition and voices: the language of the person speaking (Indian English), not money
  'src/infrastructure/browser/browser-speech.js': 'speech language en-IN (Indian English voices), not a currency',
  'src/features/search/components/voice-search.js': 'speech language en-IN (Indian English voices), not a currency',
};
/* Single lines that are legitimately India-specific (file:fragment → why) */
const ALLOW_LINES = [
  // UPI is an Indian payment system: its links are always in rupees
  ['src/domain/sales/upi.js', '["cu","INR"]', 'UPI links are always INR'],
];

function files(){
  const out = [];
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { if (!/[\\/]vendor$/.test(p)) walk(p); } else if (p.endsWith('.js')) out.push(p);
  });
  walk(path.join(ROOT, 'src'));
  for (const f of ['store.js', 'order.js', 'receipt.js']) out.push(path.join(ROOT, f));
  return out;
}
/* The code without its comments (strings kept), line numbers kept */
function stripComments(src){
  let out = '', i = 0, q = null;
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (q) {
      out += c;
      if (c === '\\') { out += n || ''; i += 2; continue; }
      if (c === q) q = null;
      i++; continue;
    }
    if (c === '"' || c === "'" || c === '`') { q = c; out += c; i++; continue; }
    if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && n === '*') { const e = src.indexOf('*/', i + 2), end = e < 0 ? src.length : e + 2; out += src.slice(i, end).replace(/[^\n]/g, ' '); i = end; continue; }
    // a regular expression literal: copied as it is (so a quote inside it doesn't start a string)
    if (c === '/' && /[=(,:!&|?{};\[]\s*$/.test(out.slice(-3))) {
      let j = i + 1, cls = false;
      while (j < src.length && src[j] !== '\n') { const ch = src[j]; if (ch === '\\') { j += 2; continue; } if (ch === '[') cls = true; else if (ch === ']') cls = false; else if (ch === '/' && !cls) break; j++; }
      out += src.slice(i, j + 1); i = j + 1; continue;
    }
    out += c; i++;
  }
  return out;
}
const PATTERN = /₹|\bRs\.|["'`(\s]Rs\s|\ben-IN\b|\bINR\b/;
const findings = [];
for (const f of files()) {
  const rel = path.relative(ROOT, f).replace(/\\/g, '/');
  if (ALLOW[rel]) continue;
  stripComments(fs.readFileSync(f, 'utf8')).split('\n').forEach((line, i) => {
    if (!PATTERN.test(line)) return;
    if (ALLOW_LINES.some(([file, frag]) => file === rel && line.includes(frag))) return;
    findings.push(`${rel}:${i + 1}: ${line.trim().slice(0, 160)}`);
  });
}
if (process.env.LIST) findings.forEach((x) => console.log('  ' + x));
check('no hard-coded ₹ / Rs / INR / en-IN outside the formatter and the commented allowlist', findings.length === 0, findings);

// the guard itself: a newly added hard-coded symbol is caught, a comment is not
const probe = stripComments('const a = 1; // ₹ in a comment\nconst label = "Price (₹)";\n/* Rs. 5 */ const b = `${x} Rs. 10`;').split('\n');
check('the scan catches a new hard-coded "₹" label and "Rs." text, and ignores comments', !PATTERN.test(probe[0]) && PATTERN.test(probe[1]) && PATTERN.test(probe[2]), probe);
const rx = stripComments('const r = /["\']/g; const t = "₹5";');
check('a regular expression with a quote in it doesn\'t hide what follows', PATTERN.test(rx), rx);

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
