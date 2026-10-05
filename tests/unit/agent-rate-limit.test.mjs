// The agent Edge Function's rate limit decisions (supabase/functions/agent/core.js rateLimits / rateDecision). The counting
// itself is in the database (supabase/tests/agent-rate.test.mjs); here: the limits from the secrets, the 429 reply with
// Retry-After, and that anything unexpected refuses (the limit protects the provider's cost).
// Run: node tests/unit/agent-rate-limit.test.mjs
import { rateDecision, rateLimits } from '../../supabase/functions/agent/core.js';

let fails = 0;
const check = (name, ok, info) => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (!ok && info !== undefined ? '  ' + JSON.stringify(info).slice(0, 400) : '')); };

const d = rateLimits({});
check('defaults: 10 a minute and 200 a day per person; 30 a minute and 600 a day per shop', d.p_per_minute === 10 && d.p_per_day === 200 && d.p_shop_per_minute === 30 && d.p_shop_per_day === 600, d);
const s = rateLimits({ AGENT_RATE_PER_MINUTE: '3', AGENT_RATE_PER_DAY: '50', AGENT_SHOP_RATE_PER_MINUTE: '0', AGENT_SHOP_RATE_PER_DAY: 'lots' });
check('from the secrets; 0 switches a window off; nonsense keeps the default', s.p_per_minute === 3 && s.p_per_day === 50 && s.p_shop_per_minute === 0 && s.p_shop_per_day === 600, s);
check('the shop is never taken from the request (only limits come from here)', !('p_shop' in d) && !('p_user' in d));

check('allowed → go ahead', rateDecision({ allowed: true, retry_after: 0 }).ok === true);
const m = rateDecision({ allowed: false, limit: 'user_minute', retry_after: 17 });
check('refused for the minute → 429, Retry-After 17, a plain message', !m.ok && m.status === 429 && m.headers['Retry-After'] === '17' && m.body.retry_after === 17
  && m.body.error === 'rate_limited' && m.body.limit === 'user_minute' && /last minute/.test(m.body.message) && /17 seconds/.test(m.body.message), m);
const day = rateDecision({ allowed: false, limit: 'shop_day', retry_after: 30000 });
check('refused for the day → hours, the shop\'s limit named', !day.ok && /today's limit/.test(day.body.message) && /9 hours/.test(day.body.message) && day.headers['Retry-After'] === '30000', day);
const weird = [rateDecision(null), rateDecision({}), rateDecision({ allowed: 'yes' })];
check('no answer or an unexpected one refuses (fails closed) with a sane retry time', weird.every((x) => !x.ok && x.status === 429 && x.retryAfter >= 1 && x.retryAfter <= 86400), weird);
check('Retry-After is at least 1 second', rateDecision({ allowed: false, limit: 'user_minute', retry_after: 0 }).retryAfter === 60 && rateDecision({ allowed: false, retry_after: 0.2 }).retryAfter === 1);

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
