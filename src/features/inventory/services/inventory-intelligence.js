// Live adapter for the pure inventory intelligence model, plus the seam where a future AI/provider may add advice.
// The provider receives a calculated snapshot and can return explanations only; this service has no mutation ports.
import { analyzeInventory } from '../../../domain/inventory/inventory-intelligence.js';
import { liveProducts } from '../../products/services/catalog.js';
import { D } from './ledger.js';
import { store } from '../../../shared/state/store.js';

/* The synchronous, deterministic snapshot used by Smart Reorder and read-only business queries. */
export function inventoryIntelligence({ now = Date.now(), config } = {}){
  // the shop's planning (Settings → Purchasing) unless a caller asks for its own
  return analyzeInventory({ products: liveProducts(), entries: D().ledger, now, config: Object.assign({}, store.settings && store.settings.reorder, config) });
}

/* `enhancer` may later be an AI-backed function. It gets the immutable-in-practice baseline as its only business input and
   returns optional advice; it cannot replace calculated quantities or write stock. A provider failure keeps the baseline. */
export function createInventoryRecommender({ enhancer = null, calculate = analyzeInventory } = {}){
  const baseline = input => calculate(input);
  return {
    baseline,
    async recommend(input){
      const analysis = baseline(input);
      if(typeof enhancer !== 'function') return { source: 'deterministic', analysis, advice: null };
      try{
        // Isolate calculated facts from provider code: even a provider that edits its input cannot edit the baseline.
        const providerInput = JSON.parse(JSON.stringify(analysis));
        const advice = await enhancer(providerInput);
        return { source: 'enhanced', analysis, advice: advice == null ? null : advice };
      }catch(_error){
        return { source: 'deterministic', analysis, advice: null, enhancerUnavailable: true };
      }
    },
  };
}
