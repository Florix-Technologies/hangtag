// Logging discipline: code must never put a customer's, staff member's, supplier's or shop's name (or phone, email,
// address, GSTIN, note, label, document title) into diagnostics as free text — a bare name can't be recognised and removed
// reliably afterwards (src/shared/logging/diagnostics.js, "THE RULE"). This scans every logging call in src/
// (logger.error / warn / info / event, recordDiagnostic, recordEvent) and fails when an argument's code — not its plain
// string text — reads a personal or business identifier (a variable or property such as .name, customer, phone, email,
// address, gstin, shopName, note, label, title). A deliberate exception must be listed below with the reason.
// Run: node tests/unit/logging-discipline.test.mjs        (LIST=1 prints every logging call it checked)
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
let fails = 0;
const check = (name, ok, info) => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (!ok && info !== undefined ? '  ' + JSON.stringify(info, null, 1).slice(0, 3000) : '')); };

const CALL = /\b(?:logger\.(?:error|warn|info|event)|recordDiagnostic|recordEvent|recordLatency|traceStep|startTrace)\s*\(/g;
const PERSONAL = /(?:^|[^\w$])(?:\.\s*)?(names?|full_?name|fullName|first_?name|user_?name|username|cust(?:omer)?s?|custName|supplier(?:Name)?s?|buyer|party|guest(?:Name)?|phones?|mobile|e_?mails?|address(?:es)?|gstin|pan|shop_?name|shopName|business_?name|label|title|notes?|description)\b/i;
/* Deliberate exceptions: [file, the exact argument text, why it is not personal] */
const ALLOW = [
  ['src/features/assistant/services/agent-runner.js', '{ op: c.name }', 'c is the Agent\'s tool call: its name is the tool\'s (get_low_stock), not a person\'s'],
];

/* The text of a call's arguments (balanced parentheses; strings and template literals respected) */
function argsAt(src, open){
  let depth = 1, i = open, q = null, tpl = 0;
  for(; i < src.length; i++){
    const c = src[i];
    if(q){ if(c === '\\'){ i++; continue; } if(q === '`' && c === '$' && src[i + 1] === '{'){ tpl++; q = null; i++; continue; } if(c === q) q = null; continue; }
    if(c === '"' || c === "'" || c === '`'){ q = c; continue; }
    if(c === '}' && tpl){ tpl--; q = '`'; continue; }
    if(c === '(') depth++;
    else if(c === ')' && --depth === 0) break;
  }
  return src.slice(open, i);
}
/* The code of the arguments without plain string text: "Payment failed:" → "", `for ${c.name}` → ${c.name} */
function codeOnly(args){
  let out = '', i = 0, q = null, tpl = 0;
  while(i < args.length){
    const c = args[i];
    if(q){
      if(c === '\\'){ i += 2; continue; }
      if(q === '`' && c === '$' && args[i + 1] === '{'){ tpl++; q = null; out += '${'; i += 2; continue; }
      if(c === q){ q = null; out += c; }
      i++; continue;
    }
    if(c === '"' || c === "'" || c === '`'){ q = c; out += c; i++; continue; }
    if(c === '}' && tpl){ tpl--; q = '`'; out += '}'; i++; continue; }
    out += c; i++;
  }
  return out;
}
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/(^|[^:"'`\\])\/\/[^\n]*/g, '$1');

const files = [];
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => { const p = path.join(d, e.name); if(e.isDirectory()){ if(!/[\\/]vendor$/.test(p)) walk(p); } else if(p.endsWith('.js')) files.push(p); });
walk(path.join(ROOT, 'src'));
const calls = [], bad = [];
for(const f of files){
  const rel = path.relative(ROOT, f).replace(/\\/g, '/');
  if(rel === 'src/shared/logging/diagnostics.js' || rel === 'src/shared/logging/logger.js') continue;   // the definitions themselves
  const src = stripComments(fs.readFileSync(f, 'utf8'));
  for(const m of src.matchAll(CALL)){
    const args = argsAt(src, m.index + m[0].length), code = codeOnly(args), line = src.slice(0, m.index).split('\n').length;
    calls.push(`${rel}:${line}: ${m[0]}${args.slice(0, 90)})`);
    const hit = PERSONAL.exec(code);
    if(hit && !ALLOW.some(([file, text]) => file === rel && args.includes(text))) bad.push(`${rel}:${line}: ${m[0]}${args.slice(0, 160)}) — reads "${hit[1]}"`);
  }
}
if(process.env.LIST) calls.forEach((c) => console.log('  ' + c));
check(`every logging call in src (${calls.length}) logs technical facts only — no names, contact details, notes or labels`, bad.length === 0, bad);
check('the scan found the app\'s logging calls (it isn\'t silently scanning nothing)', calls.length > 40, calls.length);

// the guard itself: a call that would log a name is caught; plain message text and technical fields are not
const probe = (s) => { const i = s.indexOf('(') + 1; return PERSONAL.test(codeOnly(argsAt(s, i))); };
check('caught: a template with a customer\'s name', probe('logger.warn(`Failed for ${customer.name}`)'));
check('caught: concatenating a supplier, a phone or a shop name', probe('logger.error("Failed: " + supplier)') && probe('logger.info("x", p.phone)') && probe('recordDiagnostic({ message: store.profile.shop_name })'));
check('caught: an event whose op is a person\'s name', probe('logger.event("sync", "x", { op: cust.name })'));
check('not caught: a plain message, an error object, a type or a code', !probe('logger.warn("Name and phone are required:", e)') && !probe('logger.event("sync", "upload-failed", { op: item.type, code: err && err.code })'));

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
