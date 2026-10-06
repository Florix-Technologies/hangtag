// The Hangtag Agent's safety boundary, checked in the code itself: it reads, opens and drafts — it can't change stock,
// prices, bills or payments; it saves nothing without the person's tap on the screen (and then only a draft purchase
// order, through the same checks as making one by hand); it can't use a tool the person's role can't; and the server
// side never touches the shop's tables, so it can't reach another shop. Every save, refusal and "Not now" is written to
// the automation log as an audit (who, what, when, why, the tool, before, after, the approval, the outcome).
// Run: npm run test:unit
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT_TOOLS, AGENT_TOOL_NAMES } from '../../src/domain/agent/agent-tools.js';
import { ALLOWED_TOOLS } from '../../supabase/functions/agent/core.js';
import { override } from '../../src/shared/di/services.js';
import { store } from '../../src/shared/state/store.js';
import { confirmAgentProposal, dismissAgentProposal } from '../../src/features/assistant/use-cases/agent-actions.js';

let passed = 0, failed = 0;
const check = (n, ok, info) => { if (ok) passed++; else failed++; console.log((ok ? 'PASS ' : 'FAIL ') + n + (!ok && info !== undefined ? '  ' + JSON.stringify(info).slice(0, 500) : '')); };
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = (p) => readFileSync(join(ROOT, p), 'utf8');
/* the names a file imports from a module path ending in `tail` */
const namesFrom = (code, tail) => [...code.matchAll(/import\s*\{([^}]*)\}\s*from\s*'([^']+)'/g)].filter((m) => m[2].endsWith(tail)).flatMap((m) => m[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0]).filter(Boolean));
const importsOf = (code) => [...code.matchAll(/from\s*'([^']+)'/g)].map((m) => m[1]);

// ---------- the tools ----------
const PREFIX = { read: 'get_', open: 'open_', draft: 'draft_' };
check('every tool reads, opens or drafts — and its name says which', AGENT_TOOLS.length > 0 && AGENT_TOOLS.every((t) => PREFIX[t.kind] && t.name.startsWith(PREFIX[t.kind])), AGENT_TOOLS.map((t) => [t.name, t.kind]));
const VERBS = /(^|_)(set|update|delete|remove|void|cancel|refund|verify|adjust|edit|change|pay|send|create|save|post|receive|approve|import)(_|$)/;
check('no tool changes stock, prices, bills or payments (no such verb in any tool)', AGENT_TOOLS.every((t) => !VERBS.test(t.name)));
check('every tool declares who may use it (the person\'s role is checked before it runs)', AGENT_TOOLS.every((t) => Array.isArray(t.perms) && t.perms.length > 0));
check('the server offers the AI only these tools (nothing else can be called)', ALLOWED_TOOLS.length > 0 && ALLOWED_TOOLS.every((n) => AGENT_TOOL_NAMES.includes(n)));

// ---------- the code that runs the tools never writes ----------
const SERVICES = 'src/features/assistant/services';
const svc = readdirSync(join(ROOT, SERVICES)).filter((f) => f.endsWith('.js')).map((f) => ({ f, code: src(`${SERVICES}/${f}`) }));
const WRITES = /\bstore\.[A-Za-z_$][\w$]*\s*=(?!=)|\benqueue\(|\bsave[A-Z]\w*\(|\bsetItem\(|\bpoFromReorder\b|\bvoidSale\b|\bcheckout\(|\bsavePurchase\b|\badjustStock\b|\bsavePO\b/;
check('the Agent\'s tools, runner and assistant write nothing (no store writes, no saves, no sync)', svc.length >= 4 && svc.every((x) => !WRITES.test(x.code)), svc.filter((x) => WRITES.test(x.code)).map((x) => x.f));
const useCases = svc.flatMap((x) => importsOf(x.code).filter((p) => p.includes('/use-cases/')).map((p) => ({ f: x.f, p, names: namesFrom(x.code, p.split('/').pop()) })));
const READ_HELPERS = { 'purchase-orders.js': ['reorderGroups', 'reorderPlan'], 'bank-accounts.js': ['accountBalances'] };
check('...from use-cases they import only read helpers (Smart reorder\'s suggestion, account balances)', useCases.every((u) => { const ok = READ_HELPERS[u.p.split('/').pop()]; return ok && u.names.every((n) => ok.includes(n)); }), useCases);
check('...and nothing in them can confirm a proposal (only the page can, from a tap)', svc.every((x) => !importsOf(x.code).some((p) => /agent-actions/.test(p)) && !/confirmAgentProposal\(/.test(x.code)));

// ---------- saving needs the person's tap ----------
const page = src('src/features/assistant/pages/assistant-page.js');
check('the page saves only in confirmProposal(), and that runs only from the "Save draft" tap', (page.match(/confirmAgentProposal\(/g) || []).length === 1
  && /function confirmProposal\(\)\{[^}]*confirmAgentProposal\(/.test(page) && (page.match(/\bconfirmProposal\(\)/g) || []).length === 2
  && /closest\('\[data-agentconfirm\]'\)\)\{ event\.preventDefault\(\); confirmProposal\(\);/.test(page));
check('...once (a second tap after it\'s saved does nothing)', /if\(!p \|\| state\.saved\) return;/.test(page));
const actions = src('src/features/assistant/use-cases/agent-actions.js');
check('what can be saved: a draft purchase order, through the same checks as one made by hand', JSON.stringify(namesFrom(actions, 'purchase-orders.js')) === '["poFromReorder"]'
  && JSON.stringify([...new Set([...actions.matchAll(/kind === "([a-z_]+)"/g)].map((m) => m[1]))]) === '["purchase_order"]' && /requiresConfirmation !== true/.test(actions));

// ---------- the audit, run ----------
const mem = {};
override({ storage: { get: (k, f) => (k in mem ? mem[k] : f), set: (k, v) => { mem[k] = v; return true; }, getRaw: (k) => mem[k] ?? null, setRaw: (k, v) => { mem[k] = v; }, remove: (k) => { delete mem[k]; } } });
Object.assign(store, { dev: 'dev1', autoLog: [], access: { role: 'cashier', perms: ['create_sale'], shopName: 'Aura Threads', name: 'Ravi' }, settings: { capabilities: { uses_purchase_orders: true } } });
const last = () => store.autoLog[0];
const audited = (e) => e && e.rule === 'agent' && e.by && e.t > 0 && e.tool && 'after' in e && e.outcome;
let r = confirmAgentProposal(null, { question: 'reorder?' });
check('nothing to confirm: refused, and the refusal is in the log', r.error && audited(last()) && last().action === 'failed' && /nothing to confirm/.test(last().outcome), last());
r = confirmAgentProposal({ kind: 'purchase_order', supplierId: 's1', items: [{ v: 'v1', q: 2 }] }, { question: 'reorder?' });
check('a proposal that doesn\'t ask for confirmation: refused', r.error && last().action === 'failed' && store.autoLog.length === 2);
const kinds = ['set_price', 'adjust_stock', 'delete_bill', 'verify_payment', 'refund', undefined];
const refusals = kinds.map((kind) => confirmAgentProposal({ kind, requiresConfirmation: true, items: [{ v: 'v1', q: 1 }] }, { question: 'Make Kurta cheaper' }));
check('changing a price or stock, deleting a bill, verifying a payment, refunding: "The Agent can\'t save that." — each logged', refusals.every((x) => x.error === "The Agent can't save that.")
  && store.autoLog.slice(0, kinds.length).every((e) => audited(e) && e.action === 'failed' && /is not something the Agent may save/.test(e.outcome) && e.why === 'Make Kurta cheaper'), store.autoLog.slice(0, 2));
r = confirmAgentProposal({ kind: 'purchase_order', requiresConfirmation: true, supplierId: 's1', supplier: 'Lakshmi Textiles', items: [] }, { question: 'q' });
check('a draft with no lines: refused', r.error === 'This draft has no lines.' && last().action === 'failed' && /no lines/.test(last().outcome) && last().tool === 'draft_purchase_order');
r = confirmAgentProposal({ kind: 'purchase_order', requiresConfirmation: true, supplierId: 's1', supplier: 'Lakshmi Textiles', total: 1200, items: [{ p: 'p1', v: 'v1', name: 'Kurta', q: 2, price: 600 }] }, { question: 'Draft a PO for Lakshmi', tool: 'draft_purchase_order' });
check('a role that can\'t make purchase orders: the person\'s tap doesn\'t get round it (refused and logged, nothing saved)', /can't|cannot|not allowed|isn't allowed/i.test(r.error || '') && last().action === 'failed'
  && /^Refused: /.test(last().outcome) && last().after === 'Nothing saved' && last().why === 'Draft a PO for Lakshmi', { r, e: last() });
r = dismissAgentProposal({ kind: 'purchase_order', supplier: 'Lakshmi Textiles' }, { question: 'Draft a PO for Lakshmi' });
check('"Not now": nothing saved, and the log says the person dismissed it', r.ok && audited(last()) && last().action === 'dismissed' && last().outcome === 'Dismissed by the person (Not now)' && last().after === 'Nothing saved', last());
check('the log is kept on this device (and would sync for people who manage settings)', Array.isArray(mem.hangtag_autolog || Object.values(mem).find(Array.isArray)) && store.autoLog.every((e) => e.dev === 'dev1'));

// ---------- the server side ----------
const fn = src('supabase/functions/agent/index.ts');
check('the agent function never reads or writes the shop\'s tables (no .from()): shop data reaches the AI only through the person\'s own app', !/\.from\(/.test(fn));
check('...it calls only: which shop (as the person), may they (as the person), and the rate limit', JSON.stringify([...fn.matchAll(/\.rpc\("([a-z_]+)"/g)].map((m) => m[1]).sort()) === '["hangtag_agent_take","hangtag_can","hangtag_shop_id"]'
  && /db\.rpc\("hangtag_shop_id"\)/.test(fn) && /db\.rpc\("hangtag_can"/.test(fn) && /admin\.rpc\("hangtag_agent_take"/.test(fn));
check('...the service role is used only to read the owner\'s account (who may use it) and to count the rate limit', [...fn.matchAll(/\badmin\.([a-z]+(?:\.[a-zA-Z]+)*)/g)].map((m) => m[1]).every((u) => u === 'rpc' || u === 'auth.admin.getUserById'));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
