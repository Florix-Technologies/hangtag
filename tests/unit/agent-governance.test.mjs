// The Hangtag Agent's governance (src/domain/agent/governance.js): it may read, open a screen the app has, and draft a
// proposal a person saves — nothing else gets through, whatever a tool's result (or a provider) tries: a proposal to change
// stock, a price, a bill or a payment is dropped; a draft always waits for the person; an unknown screen isn't opened;
// another shop's or user's id never leaves; the Agent's own tools pass the definition check and a changing tool wouldn't;
// every answer is an audit entry (who, why, tools, before, after, approved by, outcome). Run: npm run test:unit
import { AGENT_NEVER, AGENT_OPEN_TARGETS, AGENT_PROPOSALS, answerAudit, governToolResult, toolDefinitionProblems } from '../../src/domain/agent/governance.js';
import { AGENT_TOOLS } from '../../src/domain/agent/agent-tools.js';
import { logEntry, mergeLogs, ANSWER_MAX, LOG_ACTIONS } from '../../src/domain/automation/rules.js';

let passed = 0, failed = 0;
const check = (n, ok, info) => { if (ok) { passed++; console.log('PASS ' + n); } else { failed++; console.log('FAIL ' + n + (info !== undefined ? '  ' + JSON.stringify(info).slice(0, 600) : '')); } };
const draft = { name: 'draft_purchase_order', kind: 'draft' }, read = { name: 'get_today_sales', kind: 'read' }, open = { name: 'open_bill', kind: 'open' };

check('the boundaries, in words: stock and prices, bills, payments, messages, other shops, roles', AGENT_NEVER.length === 6 && /stock or a price/.test(AGENT_NEVER[0]) && /delete a bill/.test(AGENT_NEVER[1])
  && /verified/.test(AGENT_NEVER[2]) && /send/.test(AGENT_NEVER[3]) && /another shop/.test(AGENT_NEVER[4]) && /role/.test(AGENT_NEVER[5]));
check('only a purchase order can be saved from a proposal', JSON.stringify(AGENT_PROPOSALS) === '["purchase_order"]');

let g = governToolResult(draft, { data: { lines: 2 }, proposal: { kind: 'purchase_order', supplierId: 's1', items: [{ v: 'v1', q: 2 }] } });
check('a draft tool\'s purchase order passes — always waiting for the person', g.proposal && g.proposal.kind === 'purchase_order' && g.proposal.requiresConfirmation === true && !g.refused.length, g);
g = governToolResult(draft, { proposal: { kind: 'purchase_order', requiresConfirmation: false } });
check('…even if a result says it needn\'t wait', g.proposal.requiresConfirmation === true);
for (const kind of ['stock_adjustment', 'price_change', 'void_bill', 'delete_bill', 'verify_payment', 'refund', 'send_message']) {
  g = governToolResult(draft, { proposal: { kind } });
  check(`a proposal to ${kind.replace(/_/g, ' ')} is dropped and said`, g.proposal === null && g.refused.length === 1 && g.refused[0].includes(kind.replace(/_/g, ' ')), g);
}
g = governToolResult(read, { proposal: { kind: 'purchase_order' } });
check('a read tool can\'t propose anything (not even a purchase order)', g.proposal === null && g.refused.length === 1);
g = governToolResult(open, { action: { kind: 'open', target: 'bill', id: 'b1' } });
check('opening a screen the app has passes', g.action && g.action.target === 'bill' && !g.refused.length);
g = governToolResult(open, { action: { kind: 'open', target: 'deleteBill', id: 'b1' } });
check('…one it doesn\'t (or a disguised change) is dropped', g.action === null && /deleteBill/.test(g.refused[0]), g);
check('every screen the Agent opens is on the list', ['bill', 'product', 'customer', 'report', 'reconcile', 'cashbook', 'bankbook', 'customers', 'bills', 'banks', 'reorder', 'pos', 'stock'].every((t) => AGENT_OPEN_TARGETS.includes(t)));
g = governToolResult(read, { data: { total: 5, owner_id: 'o1', shopId: 's9', rows: [{ name: 'Riya', user_id: 'u1', amount: 3 }], nested: { tenant_id: 't', ok: 1 } } });
check('no shop, owner, user or tenant id leaves a tool (at any depth)', JSON.stringify(g.data) === JSON.stringify({ total: 5, rows: [{ name: 'Riya', amount: 3 }], nested: { ok: 1 } }), g.data);
check('a tool that isn\'t read / open / draft gets nothing through', governToolResult({ name: 'set_price', kind: 'write' }, { data: { a: 1 } }).data === null && governToolResult(null, {}).refused.length === 1);

check('the Agent\'s own tools pass the definition check (read get_, open open_, draft draft_; read-only hints; bounded arguments; no shop or user id)', toolDefinitionProblems(AGENT_TOOLS).length === 0, toolDefinitionProblems(AGENT_TOOLS));
const bad = [{ name: 'set_price', kind: 'write', annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false }, inputSchema: { type: 'object', properties: { owner_id: {} } } },
  { name: 'get_bill', kind: 'open', annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true }, inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'delete_bill', kind: 'draft', annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }, inputSchema: { type: 'object', properties: {}, additionalProperties: false } }];
const P = toolDefinitionProblems(bad);
check('…a changing tool would not: its kind, name, hints, a shop id argument, any argument at all', P.some((p) => /set_price: kind/.test(p)) && P.some((p) => /set_price: sounds like a change/.test(p)) && P.some((p) => /set_price: takes owner_id/.test(p))
  && P.some((p) => /set_price: takes any argument/.test(p)) && P.some((p) => /get_bill: a open tool's name starts open_/.test(p)) && P.some((p) => /get_bill: may change or reach outside/.test(p))
  && P.some((p) => /delete_bill: a draft tool's name starts draft_/.test(p)), P);

const A = answerAudit({ question: 'How much did I sell today?', tools: ['get_today_sales', 'get_today_sales', 'get_sales_trend'] });
check('an answer is audited: why (the question), the tools once each, nothing changed, no approval needed, answered', A.rule === 'agent' && A.action === 'answered' && A.why === 'How much did I sell today?'
  && A.tool === 'get_today_sales, get_sales_trend' && A.before === 'Read only' && A.after === 'Nothing changed' && /Not needed/.test(A.approvedBy) && A.outcome === 'Answered' && /2 tools/.test(A.text), A);
const B = answerAudit({ question: 'q', tools: ['draft_purchase_order'], proposal: { kind: 'purchase_order' }, refused: ['a proposal to stock adjustment'] });
check('…a proposal shown isn\'t saved by answering; what was refused is said', /proposal shown, not saved/.test(B.text) && /waiting for the person/.test(B.after) && /refused: a proposal to stock adjustment/.test(B.text) && /left out/.test(B.outcome), B);
const e = logEntry({ id: 'x', t: 1, ...A, by: 'owner@example.com', approvedBy: 'a'.repeat(200) });
check('in the log: who, when, what, why, tool, before, after, approved by, outcome — each bounded', e.by === 'owner@example.com' && e.action === 'answered' && e.approvedBy.length === 80 && e.why && e.tool && e.before && e.after && e.outcome && LOG_ACTIONS.answered === 'Answered by the Agent');
const answers = Array.from({ length: 150 }, (_, i) => ({ id: 'q' + i, t: 100 + i, rule: 'agent', action: 'answered', key: 'agent:answer:' + i, text: 'x' }));
const kept = mergeLogs([{ id: 'p', t: 1, rule: 'agent', action: 'approved', key: 'agent:po:1', text: 'saved' }], answers);
check('questions asked often never push an approval out of the log (answers keep their own ' + ANSWER_MAX + ')', kept.some((x) => x.id === 'p') && kept.filter((x) => x.action === 'answered').length === ANSWER_MAX);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
