// Natural-language product draft parsing. This is deterministic and local: it prepares structured data for review and
// never writes a product. A future server-side AI provider can return the same validated shape.
import { cleanProductName } from './product-validation.js';
import { cleanOptionName, cleanOptionValue } from './options.js';
import { currencyMarkSource, inr } from '../../shared/formatting/money.js';

const money = value => Number(String(value || '').replace(/,/g, ''));
const tidy = value => String(value || '').replace(/^[,;\s]+|[,;\s]+$/g, '').replace(/\s+/g, ' ').trim();
const stripLead = value => tidy(value).replace(/^(?:please\s+)?(?:create|add|make|new)\s+(?:a\s+)?(?:product\s+)?/i, '');

function optionKind(values){
  if(values.every(v => /^\d+(?:\.\d+)?\s*(?:gb|tb)$/i.test(v))) return 'Storage';
  if(values.every(v => /^(?:xxs|xs|s|m|l|xl|xxl|xxxl|\d{1,3})$/i.test(v))) return 'Size';
  if(values.every(v => /^(?:black|white|blue|red|green|yellow|pink|purple|grey|gray|brown|beige|navy|orange)$/i.test(v))) return 'Colour';
  return 'Variant';
}

function nameAndFirstVariant(prefix, many){
  const parts = stripLead(prefix).split(',').map(tidy).filter(Boolean);
  if(parts.length > 1) return { name: parts.slice(0, -1).join(', '), variant: parts.at(-1) };
  const one = parts[0] || '';
  if(many){
    const match = /^(.*?)(\d+(?:\.\d+)?\s*(?:gb|tb|ml|l|kg|g|pcs|pack)|xxs|xs|s|m|l|xl|xxl|xxxl|black|white|blue|red|green|yellow|pink|purple|grey|gray|brown|beige|navy|orange)$/i.exec(one);
    if(match && tidy(match[1])) return { name: tidy(match[1]), variant: tidy(match[2]) };
  }
  return { name: one, variant: '' };
}

export function validateAssistedProductDraft(input){
  const d = input || {}, name = cleanProductName(d.name);
  if(!name) return { error: 'I could not find a product name.' };
  if(name.length > 80) return { error: 'The product name must be 80 characters or fewer.' };
  const gst = d.gst == null || d.gst === '' ? null : +d.gst;
  if(gst != null && (!Number.isFinite(gst) || gst < 0 || gst > 100)) return { error: 'GST must be between 0% and 100%.' };
  const rows = Array.isArray(d.variants) ? d.variants : [];
  if(!rows.length) return { error: `Include at least one selling price, such as ${inr(499)}.` };
  const variants = [], seen = new Set();
  for(const row of rows){
    const label = cleanOptionValue(row && row.label), price = +(row && row.price);
    if(!Number.isFinite(price) || price < 0) return { error: `Enter a valid selling price${label ? ` for ${label}` : ''}.` };
    const key = label.toLowerCase();
    if(key && seen.has(key)) return { error: `${label} is listed twice.` };
    if(key) seen.add(key);
    variants.push(Object.freeze({ label, price: Math.round(price) }));
  }
  if(variants.length > 1 && variants.some(v => !v.label)) return { error: 'Give each price a variant name, such as 256GB or Large.' };
  const optionName = variants.some(v => v.label) ? cleanOptionName(d.optionName || optionKind(variants.map(v => v.label).filter(Boolean))) : '';
  return { draft: Object.freeze({ name, gst, price: variants[0].price, optionName, variants: Object.freeze(variants), reviewRequired: true, source: d.source || 'local' }) };
}

export function parseProductDescription(text){
  const raw = tidy(text);
  if(!raw) return { error: 'Describe the product first.' };
  const gstMatch = /\bgst\s*(?:rate\s*)?(?:@|:)?\s*(\d+(?:\.\d+)?)\s*%?/i.exec(raw);
  const gst = gstMatch ? +gstMatch[1] : null;
  const withoutGst = tidy(raw.replace(/[,;]?\s*\bgst\s*(?:rate\s*)?(?:@|:)?\s*\d+(?:\.\d+)?\s*%?/ig, ''));
  const re = new RegExp(currencyMarkSource() + "\\s*([\\d,]+(?:\\.\\d{1,2})?)", "ig"), matches = [];
  let match;
  while((match = re.exec(withoutGst))) matches.push({ index: match.index, end: re.lastIndex, price: money(match[1]) });
  if(!matches.length) return { error: `Include a selling price, such as ${inr(499)}.` };
  const first = nameAndFirstVariant(withoutGst.slice(0, matches[0].index), matches.length > 1);
  const variants = [{ label: first.variant, price: matches[0].price }];
  for(let i = 1; i < matches.length; i++){
    const between = withoutGst.slice(matches[i - 1].end, matches[i].index).replace(/^\s*(?:,|;|and)\s*/i, '');
    variants.push({ label: tidy(between), price: matches[i].price });
  }
  const tail = tidy(withoutGst.slice(matches.at(-1).end));
  const warnings = tail ? [`Not included in the draft: ${tail}`] : [];
  const checked = validateAssistedProductDraft({ name: first.name, gst, variants, source: 'local' });
  return checked.error ? checked : { ...checked, warnings: Object.freeze(warnings) };
}

export function createProductDraftAssistant({ provider = null } = {}){
  return Object.freeze({
    async prepare(text){
      const local = parseProductDescription(text);
      if(!local.error) return local;
      if(provider && typeof provider.available === 'function' && provider.available() && typeof provider.prepareDraft === 'function'){
        const proposed = await provider.prepareDraft(String(text || ''));
        return validateAssistedProductDraft({ ...proposed, source: 'provider' });
      }
      return local;
    },
  });
}
