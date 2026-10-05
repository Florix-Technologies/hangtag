// The Hangtag Agent's AI provider port. The provider and its key live in the agent Edge Function; the browser only learns
// whether it is available and passes one step of the conversation at a time (the tools run on this device).
import { ERROR_CODES } from '../../shared/errors/app-error.js';

/* cloud: the cloud gateway (agentStep) */
export function createAgentProviderClient({ cloud }){
  let known = null;
  return Object.freeze({
    /* { available, provider, model } — asked once; not available when it isn't set up or can't be reached */
    async config(){
      if(known) return known;
      try{ const r = await cloud.agentStep({ action: "config" }); known = { available: !!(r && r.available), provider: (r && r.provider) || null, model: (r && r.model) || null }; }
      catch(e){
        const off = { available: false, provider: null, model: null };
        if(e && e.code === ERROR_CODES.NOT_CONFIGURED) known = off;   // not deployed / not set up: asked again only after forget()
        return off;                                                    // offline or a hiccup: asked again next time
      }
      return known;
    },
    step: ({ question, tools, transcript }) => cloud.agentStep({ action: "step", question, tools, transcript }),
    forget(){ known = null; },
  });
}
