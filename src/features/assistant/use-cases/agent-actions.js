// What the Hangtag Agent may save, and only when the person confirms it on the screen: a draft tool's proposal. The Agent
// (and any AI provider behind it) never calls this; the page does, from the person's tap. Today: a draft purchase order
// from Smart reorder's suggestion — saved as a draft (never sent), with the same checks as making one by hand
// (create_purchase, purchase orders switched on, the supplier, the lines).
// Every confirmation (saved or refused) and every "Not now" is written to the automation log as an audit entry: who (the
// person signed in), what, when, why (the question asked), the tool, before and after, the approval (the person's tap) and
// the outcome. The Agent cannot change stock, prices, bills or payments: there is no such proposal kind.
import { poFromReorder, poList } from '../../inventory/use-cases/purchase-orders.js';
import { logAutomation } from '../../automation/services/automation.js';
import { inr } from '../../../shared/formatting/money.js';

const MAX_LINES = 200;
const lines = n => `${n} line${n === 1 ? "" : "s"}`;
const toolOf = (proposal, ctx) => (ctx && ctx.tool) || (proposal && proposal.kind === "purchase_order" ? "draft_purchase_order" : "draft");
/* → { po } or { error }. ctx: { question (why: what the person asked), tool } */
export function confirmAgentProposal(proposal, ctx = {}){
  const why = String((ctx && ctx.question) || "").slice(0, 200), tool = toolOf(proposal, ctx);
  if(!proposal || proposal.requiresConfirmation !== true){
    logAutomation({ rule: "agent", action: "failed", key: `agent:refused:${Date.now()}`, text: "An Agent action without a person's confirmation was refused.", why, tool,
      before: "Nothing", after: "Nothing saved", outcome: "Refused: there was nothing to confirm" });
    return { error: "There is nothing to confirm." };
  }
  if(proposal.kind === "purchase_order"){
    const items = Array.isArray(proposal.items) ? proposal.items.filter(l => l && l.v && +l.q > 0).slice(0, MAX_LINES) : [];
    const who = proposal.supplier || "the supplier";
    let drafts = 0;
    try{ drafts = poList().filter(p => p.supplierId === proposal.supplierId && p.status === "draft").length; }catch{ drafts = 0; }
    const before = drafts ? `${drafts} draft purchase order${drafts === 1 ? "" : "s"} for ${who} already` : `No draft purchase order for ${who}`;
    if(!items.length){
      logAutomation({ rule: "agent", action: "failed", key: `agent:po:${proposal.supplierId || "none"}:${Date.now()}`, text: `Draft purchase order for ${who}: no lines.`, why, tool,
        before, after: "Nothing saved", outcome: "Refused: the draft has no lines" });
      return { error: "This draft has no lines." };
    }
    const r = poFromReorder(proposal.supplierId, items.map(l => ({ p: l.p, v: l.v, name: l.name, vl: l.vl || "", ...(l.u ? { u: l.u } : {}), q: +l.q, price: l.price == null ? null : +l.price, ...(l.gst != null ? { gst: l.gst } : {}) })));
    if(r.error){
      logAutomation({ rule: "agent", action: "failed", key: `agent:po:${proposal.supplierId || "none"}:${Date.now()}`, text: `Draft purchase order for ${who} was refused.`, why, tool,
        before, after: "Nothing saved", outcome: `Refused: ${r.error}` });
      return r;
    }
    logAutomation({ rule: "agent", action: "approved", key: `agent:po:${r.po.id}`, text: `Draft purchase order ${r.po.no} for ${who} saved from the Agent's proposal. Not sent.`, why, tool,
      before, after: `Draft ${r.po.no} for ${who}: ${lines(items.length)}${proposal.total ? `, about ${inr(proposal.total)}` : ""}`,
      outcome: "Saved as a draft after the person tapped Save (not sent to the supplier)" });
    return r;
  }
  logAutomation({ rule: "agent", action: "failed", key: `agent:kind:${Date.now()}`, text: "The Agent proposed something it can't save.", why, tool, before: "Nothing", after: "Nothing saved",
    outcome: `Refused: "${String(proposal.kind || "unknown").slice(0, 30)}" is not something the Agent may save` });
  return { error: "The Agent can't save that." };
}
/* The person chose "Not now": nothing saved, and the log says so */
export function dismissAgentProposal(proposal, ctx = {}){
  if(!proposal) return { ok: true };
  const who = proposal.supplier || "the supplier";
  logAutomation({ rule: "agent", action: "dismissed", key: `agent:dismissed:${Date.now()}`, text: proposal.kind === "purchase_order" ? `Draft purchase order for ${who} not saved.` : "The Agent's proposal was not saved.",
    why: String((ctx && ctx.question) || "").slice(0, 200), tool: toolOf(proposal, ctx), before: "Nothing", after: "Nothing saved", outcome: "Dismissed by the person (Not now)" });
  return { ok: true };
}
