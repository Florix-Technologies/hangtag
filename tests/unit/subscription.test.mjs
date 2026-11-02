// The app's side of Hangtag plans (domain/billing/subscription.js): which states lock, the trusted time (a clock moved back
// never extends access, a restart keeps the latest time seen), days left, the lock screen's and Home banner's words; an
// upload refused with HT402 stays queued (never the review list) and maps to the SUBSCRIPTION error.
// Run: node tests/unit/subscription.test.mjs
import { bannerFor, daysLeft, isLocked, lockCopy, perMonth, planFacts, stateAt, statusChip, trustedNow } from '../../src/domain/billing/subscription.js';
import { failureAction } from '../../src/domain/sync/queue-rules.js';
import { toAppError } from '../../src/infrastructure/supabase/errors.js';
import { ERROR_CODES } from '../../src/shared/errors/app-error.js';

let fails = 0;
const check = (name, ok, info) => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (!ok && info !== undefined ? '  ' + JSON.stringify(info).slice(0, 400) : '')); };
const DAY = 86400000, T0 = Date.parse('2026-10-06T10:00:00Z');
const iso = (t) => new Date(t).toISOString();
const trial = (endsIn) => ({ state: 'trial_active', plan_code: null, trial_started_at: iso(T0 - 2 * DAY), trial_ends_at: iso(T0 + endsIn), access_until: iso(T0 + endsIn), server_now: iso(T0), is_owner: true });
const paid = (endsIn) => ({ state: 'paid_active', plan_code: 'm3', plan_label: '3 months', trial_started_at: iso(T0 - 40 * DAY), trial_ends_at: iso(T0 - 33 * DAY), period_start: iso(T0 - 60 * DAY), period_end: iso(T0 + endsIn), access_until: iso(T0 + endsIn), server_now: iso(T0) });

console.log('=== states and the lock ===');
check('a running trial: not locked', !isLocked(trial(5 * DAY), T0) && stateAt(trial(5 * DAY), T0) === 'trial_active');
check('a running paid plan: not locked', !isLocked(paid(30 * DAY), T0));
for (const s of ['trial_expired', 'paid_expired', 'suspended']) check(`${s}: locked`, isLocked({ state: s }, T0));
check('suspended locks even with paid time left', isLocked({ ...paid(30 * DAY), state: 'suspended' }, T0));
check('no plan yet (setup not finished) or the server can\'t say: never locked', !isLocked({ state: 'none' }, T0) && !isLocked({ state: 'unavailable' }, T0) && !isLocked(null, T0) && !isLocked({}, T0));
check('a trial the server called running locks itself the moment it runs out (no wait for the next check)', isLocked(trial(1000), T0 + 1000) && stateAt(trial(1000), T0 + 2000) === 'trial_expired');
check('…a paid plan likewise becomes "plan ended"', stateAt(paid(1000), T0 + 1000) === 'paid_expired');
check('an unknown time never locks a running plan', !isLocked(trial(5 * DAY), null));

console.log('=== the trusted time ===');
{
  const base = { serverAt: T0, perfAt: 1000, clientAt: T0 };
  check('in this session: server time + monotonic time since (the device clock is ignored)', trustedNow({ ...base, perfNow: 61000, clockNow: T0 - 365 * DAY }) === T0 + 60000);
  check('the device clock moved back a year after a restart: no time gained', trustedNow({ serverAt: T0, clientAt: T0, clockNow: T0 - 365 * DAY }) === T0);
  check('…and never earlier than the latest trusted time seen (floor)', trustedNow({ serverAt: T0, clientAt: T0, clockNow: T0 - DAY, floor: T0 + 3 * DAY }) === T0 + 3 * DAY);
  check('after a restart, real time passing counts (clock moved forward 2 days → 2 days later)', trustedNow({ serverAt: T0, clientAt: T0, clockNow: T0 + 2 * DAY }) === T0 + 2 * DAY);
  const s = trial(3 * DAY);
  const back = trustedNow({ serverAt: T0 + 4 * DAY, clientAt: T0 + 4 * DAY, clockNow: T0, floor: T0 + 4 * DAY });
  check('a trial that ran out stays locked when the clock is set back before its end', isLocked(s, back), back);
  check('a performance mark from before (another session) is not used', trustedNow({ serverAt: T0, perfAt: 5000, perfNow: 100, clientAt: T0, clockNow: T0 + 1000 }) === T0 + 1000);
  check('nothing known → null (the caller decides; nothing locks)', trustedNow({}) === null);
  // offline, restarted with the clock set back a year: the session moves on by monotonic time from where it started
  const off = { serverAt: T0, clientAt: T0, clockNow: T0 - 365 * DAY, floor: T0, sessionAt: T0, sessionPerf: 1000 };
  const t1 = trustedNow({ ...off, perfNow: 1000 + 2 * DAY });
  check('offline with the clock set back: time still moves on in the session (2 days open → 2 days later)', t1 === T0 + 2 * DAY, t1);
  check('…so a trial with 1 day left locks while the app is used offline', isLocked(trial(DAY), t1) && !isLocked(trial(DAY), trustedNow({ ...off, perfNow: 1000 + DAY / 2 })));
  check('…and the next start continues from the saved floor (open time adds up across restarts)', trustedNow({ ...off, floor: t1, sessionAt: t1, perfNow: 1000 + DAY }) === t1 + DAY);
  check('a session mark from the future of this page is ignored (performance time never goes back)', trustedNow({ ...off, perfNow: 500 }) === T0);
}

console.log('=== days left and words ===');
{
  check('days left: a part day counts as a day; 7 days at the start of a trial', daysLeft(trial(7 * DAY), T0) === 7 && daysLeft(trial(6.2 * DAY), T0) === 7 && daysLeft(trial(1), T0) === 1);
  check('days left: never negative; 0 when locked', daysLeft(trial(-DAY), T0) === 0 && daysLeft({ state: 'suspended', access_until: iso(T0 + DAY) }, T0) === 0);
  const tl = lockCopy({ state: 'trial_expired', trial_ends_at: iso(T0) }, T0 + DAY, true);
  check('trial ended (owner): "Your free trial has ended", the date, data is safe', tl.title === 'Your free trial has ended' && tl.chip === 'Trial expired' && !!tl.ended && /data is safe/.test(tl.body), tl);
  const pl = lockCopy({ state: 'paid_expired', period_end: iso(T0) }, T0 + DAY, true);
  check('plan ended: "Your plan has ended", "Plan expired"', pl.title === 'Your plan has ended' && pl.chip === 'Plan expired', pl);
  const mem = lockCopy({ state: 'paid_expired', period_end: iso(T0) }, T0 + DAY, false);
  check('a team member is asked to get the owner to renew (no payment)', /Ask the owner/.test(mem.body), mem);
  const su = lockCopy({ state: 'suspended' }, T0, true);
  check('suspended: its own words', su.title === 'Your shop is suspended' && /support/.test(su.body), su);
  check('chips', statusChip(trial(5 * DAY), T0).label === 'Free trial' && statusChip(trial(DAY), T0).tone === 'warn' && statusChip(paid(60 * DAY), T0).label === 'Active'
    && statusChip({ state: 'trial_expired' }, T0).tone === 'bad' && statusChip({ state: 'none' }, T0).tone === 'muted');
  const b = bannerFor(trial(5 * DAY), T0);
  check('Home banner during the trial: days left, the end date, "Choose a plan"', b && /Free trial · 5 days left · ends /.test(b.text) && b.cta === 'Choose a plan', b);
  check('Home banner: a paid plan with a week or less: "Renew"; more than a week: none', bannerFor(paid(3 * DAY), T0).cta === 'Renew' && bannerFor(paid(30 * DAY), T0) === null);
  check('no banner when locked or before setup', bannerFor({ state: 'trial_expired' }, T0) === null && bannerFor({ state: 'none' }, T0) === null);
  const f = planFacts(trial(5 * DAY), T0).map((r) => r.label);
  check('plan facts: plan, trial, ends on, days remaining', f.includes('Plan') && f.includes('Trial') && f.includes('Trial ends on') && f.includes('Days remaining'), f);
  check('"a month" hint only for plans of several months, from the server\'s price', perMonth({ months: 3, price: 1349 }) === 450 && perMonth({ months: 1, price: 499 }) === null && perMonth({ months: 6, price: 0 }) === null);
}

console.log('=== the upload queue and the server\'s refusal ===');
{
  check('SUBSCRIPTION → keep it queued (retry), never the review list — whatever the tries', failureAction('SUBSCRIPTION', 1, {}) === 'retry' && failureAction('SUBSCRIPTION', 99, { member: true }) === 'retry');
  const e = toAppError({ code: 'HT402', message: 'HANGTAG_SUBSCRIPTION_INACTIVE: This shop\'s Hangtag plan has ended. Renew it in Plans & Billing.' });
  check('the database\'s HT402 → SUBSCRIPTION with a plain message', e.code === ERROR_CODES.SUBSCRIPTION && /Plans & Billing/.test(e.message), e);
  const e2 = toAppError({ code: '400', message: 'HANGTAG_SUBSCRIPTION_INACTIVE: …' });
  check('…also when only the message says so', e2.code === ERROR_CODES.SUBSCRIPTION);
  check('other errors keep their codes', toAppError({ code: 'P0001', message: 'x' }).code === ERROR_CODES.VALIDATION && toAppError(new Error('Failed to fetch')).code === ERROR_CODES.NETWORK);
}

console.log('=== the 30-day trial with AutoPay: states and words ===');
{
  const { autopayConsentText, autopayLive, autopayText, lifecycleOf } = await import('../../src/domain/billing/subscription.js');
  const setup = { ...trial(30 * DAY), state: 'trial_setup', lifecycle: 'autopay_required', trial_days: 30, days_left: 0, autopay: { status: 'none', required: true } };
  check('a trial waiting for AutoPay is locked, with the set-up words for the owner (and "ask the owner" for staff)', isLocked(setup, T0) && lifecycleOf(setup, T0) === 'autopay_required'
    && lockCopy(setup, T0, true).title === 'Start your 30-day free trial' && /AutoPay is required/.test(lockCopy(setup, T0, true).body)
    && /owner sets up AutoPay/.test(lockCopy(setup, T0, false).body) && statusChip(setup, T0).label === 'AutoPay needed', lockCopy(setup, T0, true));
  const renewing = { ...paid(-DAY), state: 'renewal_due', lifecycle: 'renewing', access_until: iso(T0 + DAY), autopay: { status: 'active' } };
  check('AutoPay collecting the renewal: open (not locked) until the grace ends, then plan ended', !isLocked(renewing, T0) && statusChip(renewing, T0).label === 'Renewing'
    && isLocked(renewing, T0 + 2 * DAY) && stateAt(renewing, T0 + 2 * DAY) === 'paid_expired' && lifecycleOf(renewing, T0 + 2 * DAY) === 'expired');
  const pastDue = { ...renewing, lifecycle: 'past_due', autopay: { status: 'past_due' } };
  check('a failed renewal the bank is asked again for: a warning, a "Pay now" banner', statusChip(pastDue, T0).tone === 'warn' && bannerFor(pastDue, T0).cta === 'Pay now');
  const halted = { state: 'paid_expired', lifecycle: 'halted', plan_code: 'm1', period_end: iso(T0 - DAY), access_until: iso(T0 - DAY), autopay: { status: 'halted' } };
  check('AutoPay stopped after failed charges: locked, saying the payment didn\'t go through', isLocked(halted, T0) && /didn't go through/.test(lockCopy(halted, T0, true).title) && statusChip(halted, T0).tone === 'bad');
  const ending = { ...trial(2 * DAY), lifecycle: 'trial_ending', autopay: { status: 'active', next_charge_at: iso(T0 + 2 * DAY) } };
  check('the trial\'s last days with AutoPay on: a warning naming when AutoPay starts, "Manage"', statusChip(ending, T0).tone === 'warn' && /AutoPay from/.test(bannerFor(ending, T0).text) && bannerFor(ending, T0).cta === 'Manage');
  const off = { ...trial(10 * DAY), lifecycle: 'cancelled', autopay: { status: 'cancelled' } };
  check('AutoPay turned off during the trial: still open, "AutoPay off"', !isLocked(off, T0) && statusChip(off, T0).label === 'Trial · AutoPay off' && planFacts(off, T0).some((r) => r.label === 'AutoPay' && r.value === 'Off'));
  check('AutoPay in words; "live" while on, failing or waiting for approval', autopayText({ status: 'active', next_charge_at: iso(T0) }).startsWith('On · next charge on')
    && autopayLive({ status: 'pending', set_up: true }) && !autopayLive({ status: 'pending', set_up: false }) && autopayLive({ status: 'past_due' }) && !autopayLive({ status: 'cancelled' }) && !autopayLive(null));
  const consent = autopayConsentText({ price: 'X999', today: 'X0', months: 1, firstChargeOn: '7 Nov 2026' });
  check('the consent says what today, how much, how often, from when, until cancelled', /charges X999 every month from 7 Nov 2026, until I cancel/.test(consent) && /X0 is charged today/.test(consent) && /cancel any time before a renewal/.test(consent), consent);
}

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
