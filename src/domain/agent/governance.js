// The Hangtag Agent's governance: what it may do, what it never does, and how every step is recorded. One policy for the
// tool host (every tool's result passes governToolResult before the provider or the screen sees it), the page (only
// these screens open; only these proposals can be saved, and only from a person's tap) and the Activity log (who, what,
// when, why, the tool, before, after, who approved it, the outcome). Pure.
//   may:   read the shop's records with the person's own role; open a screen; draft a proposal a person saves
//   never: change stock or prices; cancel, change or delete a bill; take a payment or mark one verified; send anything to a
//          customer or supplier; reach another shop's records; do what the person's role can't
export const AGENT_KINDS = Object.freeze(["read", "open", "draft"]);
export const AGENT_PREFIX = Object.freeze({ read: "get_", open: "open_", draft: "draft_" });
/* What a person can save from a proposal (agent-actions.js confirms it, with the same checks as by hand) */
export const AGENT_PROPOSALS = Object.freeze(["purchase_order"]);
/* The screens the Agent may open (assistant-page.js performAgentAction) */
export const AGENT_OPEN_TARGETS = Object.freeze(["bill", "product", "customer", "report", "reconcile", "cashbook", "bankbook", "customers", "bills", "banks", "reorder", "pos", "stock"]);
export const AGENT_NEVER = Object.freeze([
  "change stock or a price",
  "cancel, change or delete a bill",
  "take a payment or mark one verified",
  "send anything to a customer or supplier",
  "see another shop's records",
  "do what your role can't",
]);
const TENANT = /^(owner|shop|user|tenant|account|org)_?id$|^(ownerId|shopId|userId|tenantId|accountId)$/;
const MUTATION = /^(set|update|delete|remove|void|cancel|refund|verify|adjust|send|pay|change|write|insert|drop)_/;

/* Drop shop, owner and user ids from what a tool returns (a tool works on the signed-in shop only; nothing names another) */
function withoutTenant(v, depth = 0){
  if(depth > 6) return null;
  if(Array.isArray(v)) return v.map(x => withoutTenant(x, depth + 1));
  if(!v || typeof v !== "object") return v;
  const o = {}; Object.keys(v).forEach(k => { if(!TENANT.test(k)) o[k] = withoutTenant(v[k], depth + 1); }); return o;
}
/* A tool's result, governed → { data, action, proposal, refused: [why] }: a proposal only from a draft tool and only of a
   kind a person can save (and always waiting for the person: requiresConfirmation); an action only to a screen the app has */
export function governToolResult(tool, result){
  const refused = [], r = result || {};
  if(!tool || !AGENT_KINDS.includes(tool.kind)) return { data: null, action: null, proposal: null, refused: ["not a tool the Agent may use"] };
  let proposal = r.proposal || null, action = r.action || null;
  if(proposal && (tool.kind !== "draft" || !AGENT_PROPOSALS.includes(proposal.kind))){ refused.push(`a proposal to ${String(proposal.kind || "change something").replace(/_/g, " ")}`); proposal = null; }
  if(proposal) proposal = { ...proposal, requiresConfirmation: true };
  if(action && !AGENT_OPEN_TARGETS.includes(action.target)){ refused.push(`opening “${String(action.target || "?").slice(0, 30)}”`); action = null; }
  return { data: withoutTenant(r.data || {}), action, proposal, refused };
}
/* What is wrong with a set of tool definitions (none, for the Agent's own): a kind it may not have, a name that doesn't say
   its kind or sounds like a change, a hint that it changes or reaches outside the shop, an argument naming a shop or user */
export function toolDefinitionProblems(tools){
  const out = [];
  (tools || []).forEach(t => {
    if(!AGENT_KINDS.includes(t.kind)) out.push(`${t.name}: kind “${t.kind}”`);
    else if(!String(t.name).startsWith(AGENT_PREFIX[t.kind])) out.push(`${t.name}: a ${t.kind} tool's name starts ${AGENT_PREFIX[t.kind]}`);
    if(MUTATION.test(String(t.name))) out.push(`${t.name}: sounds like a change`);
    const a = t.annotations || {};
    if(a.readOnlyHint !== true || a.destructiveHint !== false || a.openWorldHint !== false) out.push(`${t.name}: may change or reach outside the shop`);
    Object.keys((t.inputSchema && t.inputSchema.properties) || {}).forEach(k => { if(TENANT.test(k)) out.push(`${t.name}: takes ${k}`); });
    if(t.inputSchema && t.inputSchema.additionalProperties !== false) out.push(`${t.name}: takes any argument`);
  });
  return out;
}
/* The Agent's answer to a question, for the Activity log: who asked, why (the question), the tools it used, before and after
   (nothing changes by answering), the outcome; a proposal shown waits for the person — saving it is its own entry */
export function answerAudit({ question, tools, proposal, refused }){
  const used = [...new Set((tools || []).map(String))];
  return { rule: "agent", action: "answered", why: String(question || "").slice(0, 200), tool: used.join(", ").slice(0, 120),
    text: `Answered with ${used.length} tool${used.length === 1 ? "" : "s"}${proposal ? " · a proposal shown, not saved" : ""}${refused && refused.length ? ` · refused: ${refused.join("; ")}` : ""}`.slice(0, 240),
    before: "Read only", after: proposal ? "Nothing saved yet (waiting for the person)" : "Nothing changed", approvedBy: "Not needed (read only)",
    outcome: refused && refused.length ? "Answered; what it may not do was left out" : "Answered" };
}
