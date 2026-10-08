// The Agent's provider path, evaluated: each case goes straight to the provider loop (src/features/assistant/services/
// agent-runner.js runAgent — no local guard in front, so the provider's own behaviour is what is scored), with the real
// tool host and governance on the evaluation shop, and the provider called exactly as the agent Edge Function calls it:
// supabase/functions/agent/core.js validateRequest → anthropicRequest → readAnthropic (the deployed code). Everything the
// tools returned is the evidence an answer's figures are checked against.
import { createAgentToolHost } from '../../../src/features/assistant/services/agent-tools.js';
import { runAgent } from '../../../src/features/assistant/services/agent-runner.js';
import { DEFAULT_MODEL, anthropicRequest, readAnthropic, validateRequest } from '../../../supabase/functions/agent/core.js';
import { evalShop } from './shop.mjs';
import { evidenceOf, scoreCase } from './evaluator.mjs';

/* The provider as the Edge Function speaks to it. url: another endpoint speaking the Messages API (a test stand-in) */
export function anthropicProvider({ key, model = DEFAULT_MODEL, maxTokens = 1024, url = null, fetchImpl = fetch } = {}){
  const cfg = { provider: 'anthropic', key, model, maxTokens };
  const calls = [];
  return {
    calls,
    config: async () => ({ available: !!key, provider: 'anthropic', model }),
    async step({ question, tools, transcript }){
      const v = validateRequest({ action: 'step', question, tools, transcript });
      if(!v.ok) throw new Error(`request refused by the function's checks: ${v.error}`);
      const req = anthropicRequest(cfg, v), t0 = Date.now();
      const res = await fetchImpl(url || req.url, { method: 'POST', headers: req.headers, body: JSON.stringify(req.body) });
      const json = await res.json().catch(() => null);
      calls.push({ ms: Date.now() - t0, status: res.status, usage: json && json.usage || null });
      if(!res.ok) throw new Error(`provider answered ${res.status}: ${json && json.error && json.error.message || ''}`.trim());
      return readAnthropic(json, v.tools.map((t) => t.name));
    },
  };
}

/* Run cases through the provider loop → [{ ...score, run }]. opts: { shop, role, repeat } */
export async function runProviderCases(provider, cases, truth, { shopOf = (c) => evalShop('A', { injection: c.category === 'injection' }), repeat = 1 } = {}){
  const out = [];
  for(const c of cases){
    for(let n = 0; n < repeat; n++){
      const shop = shopOf(c), seen = [];
      const base = createAgentToolHost({ access: { can: () => true, hasCap: () => true }, data: shop.data });
      const host = { listTools: base.listTools, allowed: base.allowed, callTool: (name, a) => { const r = base.callTool(name, a); seen.push(r.structuredContent || null, r.content); return r; } };
      let r = null, error = null;
      try{ r = await runAgent({ question: c.ask, provider, host }); }catch(e){ error = e.message; }
      const run = { answer: r ? r.text : '', tools: r ? r.toolsUsed : [], proposal: r ? r.proposal : null, evidence: evidenceOf(...seen), error: error || (r ? null : 'no answer') };
      const s = scoreCase(c, run, truth);
      out.push({ ...s, id: repeat > 1 ? `${c.id}#${n + 1}` : c.id, run });
    }
  }
  return out;
}
