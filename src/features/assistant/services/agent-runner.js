// The Hangtag Agent with an AI provider (the "agentProvider" port → Edge Function agent). The provider only decides which
// tools to call and words the answer; the tools run here, through the tool host (services/agent-tools.js), on this shop's
// records with this person's role — so the provider sees only what the tools return and can't change anything: what an
// open tool finds comes back as a button, what a draft tool prepares as a proposal the person confirms.

const MAX_STEPS = 4, MAX_CALLS = 6, MAX_RESULT = 6000;
/* What the provider gets back from a tool: its text and its figures, bounded */
const resultText = r => { const text = (r.content || []).map(c => c.text).join("\n"), s = r.structuredContent ? JSON.stringify(r.structuredContent) : ""; return (s ? `${text}\n${s}` : text).slice(0, MAX_RESULT); };
const sameAction = (a, b) => a.target === b.target && a.id === b.id;

/* → { text, toolsUsed, actions, proposal } or null when the provider gave no answer */
export async function runAgent({ question, provider, host, maxSteps = MAX_STEPS }){
  const tools = host.listTools();
  if(!tools.length) return null;
  const transcript = [], used = [], actions = [], proposals = [];
  for(let i = 0; i < maxSteps; i++){
    const r = await provider.step({ question, tools, transcript });
    if(r && r.type === "answer" && String(r.text || "").trim()) return { text: String(r.text).trim(), toolsUsed: used, actions, proposal: proposals[0] || null };
    if(!r || r.type !== "tool_calls" || !Array.isArray(r.calls) || !r.calls.length) return null;
    const calls = r.calls.slice(0, MAX_CALLS).map(c => ({ id: String(c.id), name: String(c.name), input: c.input && typeof c.input === "object" && !Array.isArray(c.input) ? c.input : {} }));
    const results = calls.map(c => {
      const res = host.callTool(c.name, c.input), sc = res.structuredContent || {};
      used.push(c.name);
      if(!res.isError){ if(sc.action && !actions.some(a => sameAction(a, sc.action))) actions.push(sc.action); if(sc.proposal) proposals.push(sc.proposal); }
      return { id: c.id, content: resultText(res), isError: !!res.isError };
    });
    transcript.push({ role: "assistant", text: String(r.text || "").slice(0, 2000), calls }, { role: "tool", results });
  }
  return null;
}

/* The provider as the Agent's fallback (services/business-assistant.js), for questions it doesn't know by itself. Whether
   it is set up is asked when first needed (prepare() may ask earlier); host: () => the tool host for the person signed in */
export function createAgentAI({ provider, host, online = () => true }){
  let cfg = null;
  const ready = async () => { if(!cfg || !cfg.available) cfg = await provider.config(); return !!(cfg && cfg.available); };
  return Object.freeze({
    prepare: async () => online() && ready(),
    /* worth trying: online, and not known to be off */
    available: () => online() && !(cfg && !cfg.available),
    async answerReadOnly(question){
      if(!online() || !(await ready())) return null;
      const r = await runAgent({ question, provider, host: host() });
      return r ? { title: "Hangtag Agent", text: r.text, rows: [], actions: r.actions, proposal: r.proposal, toolsUsed: r.toolsUsed } : null;
    },
  });
}
