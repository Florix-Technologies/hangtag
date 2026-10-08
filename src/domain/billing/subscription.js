// A shop's Hangtag plan as the app applies it (pure). The server decides the plan (schema.sql section 3t:
// hangtag_subscription_status) and refuses every business write once it has ended (SQLSTATE HT402); the app locks itself
// to match, using a time it can trust — never the bare device clock — so moving the clock back cannot extend access.
//   states: trial_active · trial_setup (the trial waits for AutoPay: locked until the owner sets it up) · paid_active ·
//           renewal_due (AutoPay is collecting the renewal: open for a grace) · trial_expired · paid_expired · suspended ·
//           none (setup not finished) · unavailable (the server can't say yet, e.g. the database update isn't applied)
//   lifecycle (the server's word for where the plan is): trial · trial_ending · autopay_required · active · renewing ·
//           past_due · cancelled · halted · expired · suspended · none
import { dateText } from '../../shared/formatting/dates.js';

export const ACTIVE_STATES = Object.freeze(["trial_active", "paid_active", "renewal_due"]);
export const LOCKED_STATES = Object.freeze(["trial_expired", "paid_expired", "suspended", "trial_setup"]);
const DAY = 86400000;
const at = v => { const t = typeof v === "number" ? v : Date.parse(v); return Number.isFinite(t) ? t : null; };
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

/* The time the lock trusts:
     in this session  the server's time at the last check + the monotonic time since (performance.now: unaffected by the
                      device clock);
     after a restart  the server's time + how far the device clock moved since (never negative);
     every session    at least where the session started (sessionAt) + the monotonic time since (sessionPerf): a session
                      that hasn't heard from the server (offline, the clock set back) still moves on;
   and never earlier than the latest trusted time this device has seen (floor, saved as it moves). Moving the clock back
   can't stop the time the lock uses (only the hours the app was closed go uncounted until the server is reached);
   moving it forward can only lock sooner — and the next check with the server puts it right. */
export function trustedNow({ serverAt, perfAt, perfNow, clientAt, clockNow, floor, sessionAt, sessionPerf } = {}){
  let t = null;
  if(Number.isFinite(serverAt)){
    if(Number.isFinite(perfAt) && Number.isFinite(perfNow) && perfNow >= perfAt) t = serverAt + (perfNow - perfAt);
    else if(Number.isFinite(clientAt) && Number.isFinite(clockNow)) t = serverAt + Math.max(0, clockNow - clientAt);
    else t = serverAt;
  }
  if(Number.isFinite(sessionAt) && Number.isFinite(sessionPerf) && Number.isFinite(perfNow) && perfNow >= sessionPerf){
    const s = sessionAt + (perfNow - sessionPerf);
    if(t == null || s > t) t = s;
  }
  if(Number.isFinite(floor) && (t == null || floor > t)) t = floor;
  return t;
}

/* The state at a moment: a plan the server called running is over once its end has passed (the lock doesn't wait for the
   next check) */
export function stateAt(status, now){
  const s = status && status.state;
  if(!s) return "none";
  if(ACTIVE_STATES.includes(s)){
    const until = at(status.access_until);
    if(until != null && now != null && until <= now) return s === "paid_active" || status.plan_code ? "paid_expired" : "trial_expired";
  }
  return s;
}
export const isLocked = (status, now) => LOCKED_STATES.includes(stateAt(status, now));

/* Where the plan is in its life: the server's word — unless its time ran out since the server said */
export function lifecycleOf(status, now){
  const s = stateAt(status, now);
  if(status && s !== status.state && (s === "trial_expired" || s === "paid_expired")) return "expired";
  if(status && typeof status.lifecycle === "string" && status.lifecycle) return status.lifecycle;
  return { trial_active: "trial", trial_setup: "autopay_required", paid_active: "active", renewal_due: "renewing", trial_expired: "expired", paid_expired: "expired" }[s] || s;
}
/* The shop's AutoPay is on, or on its way (set up at the provider, waiting for the owner's approval) */
export const autopayLive = ap => !!ap && (ap.status === "active" || ap.status === "past_due" || (ap.status === "pending" && !!ap.set_up));
/* The shop's AutoPay in words (the amount is added by the screen, in the shop's money) */
export function autopayText(ap){
  if(!ap) return "";
  if(ap.status === "active") return ap.next_charge_at ? `On · next charge on ${when(ap.next_charge_at)}` : "On";
  if(ap.status === "past_due") return "On · the last charge failed, the bank is asked again";
  if(ap.status === "pending") return ap.set_up ? "Waiting for your approval" : "Not set up";
  if(ap.status === "halted") return "Stopped · the charges failed";
  if(ap.status === "cancelled") return "Off";
  return "Not set up";
}

/* Whole days left (a part day counts as a day), 0 when locked or unknown */
export function daysLeft(status, now){
  const until = at(status && status.access_until);
  if(until == null || now == null || isLocked(status, now)) return 0;
  return Math.max(0, Math.ceil((until - now) / DAY));
}
const when = v => { const t = at(v); return t == null ? "" : dateText(t); };

/* The chip next to the plan: { label, tone: ok | warn | bad | muted } */
export function statusChip(status, now){
  const s = stateAt(status, now), n = daysLeft(status, now), lc = lifecycleOf(status, now);
  if(lc === "autopay_required") return { label: "AutoPay needed", tone: "warn" };
  if(lc === "past_due") return { label: "Payment failed · retrying", tone: "warn" };
  if(lc === "renewing") return { label: "Renewing", tone: "ok" };
  if(lc === "halted") return { label: "Payment failed", tone: "bad" };
  if(lc === "cancelled" && ACTIVE_STATES.includes(s)) return { label: `${s === "trial_active" ? "Trial" : "Active"} · AutoPay off`, tone: "muted" };
  if(s === "trial_active") return { label: n <= 2 || lc === "trial_ending" ? `Trial · ${plural(n, "day")} left` : "Free trial", tone: n <= 2 || lc === "trial_ending" ? "warn" : "ok" };
  if(s === "paid_active") return { label: n <= 7 ? `Active · ${plural(n, "day")} left` : "Active", tone: n <= 7 ? "warn" : "ok" };
  if(s === "trial_expired") return { label: "Trial expired", tone: "bad" };
  if(s === "paid_expired") return { label: "Plan expired", tone: "bad" };
  if(s === "suspended") return { label: "Suspended", tone: "bad" };
  return { label: "Not started", tone: "muted" };
}

/* The lock screen's words: { title, body, chip, ended (date text or "") } — the owner pays; a team member asks the owner */
export function lockCopy(status, now, owner){
  const s = stateAt(status, now);
  if(s === "suspended") return { title: "Your shop is suspended", chip: "Suspended", ended: "",
    body: owner ? "Hangtag has paused this shop's account. Your data is safe. Contact Hangtag support to restore it." : "Your shop's Hangtag account is paused. Ask the shop owner." };
  if(s === "trial_setup") return { title: `Start your ${+(status && status.trial_days) || 30}-day free trial`, chip: "AutoPay needed", ended: "",
    body: owner ? "AutoPay is required for the free trial. Set it up below: nothing to pay today, the plan after your trial, and you can cancel any time before it renews."
      : "Your shop's free trial starts once the owner sets up AutoPay. Ask the shop owner." };
  if(lifecycleOf(status, now) === "halted") return { title: "Your plan's payment didn't go through", chip: "Payment failed", ended: when(status && (status.period_end || status.access_until)),
    body: owner ? "AutoPay couldn't collect the renewal. Your data is safe and nothing has been deleted. Choose a plan to keep selling." : "Your shop's Hangtag plan has ended. Ask the owner to renew it — your work is safe." };
  const trial = s === "trial_expired";
  return {
    title: trial ? "Your free trial has ended" : "Your plan has ended",
    chip: trial ? "Trial expired" : "Plan expired",
    ended: when(trial ? status && status.trial_ends_at : (status && (status.period_end || status.access_until))),
    body: owner ? "Your shop's data is safe and nothing has been deleted. Choose a plan to keep selling." : "Your shop's Hangtag plan has ended. Ask the owner to renew it — your work is safe.",
  };
}

/* Home's slim banner for the owner and managers: during the trial, and when a paid plan has a week or less left */
export function bannerFor(status, now){
  const s = stateAt(status, now), n = daysLeft(status, now), lc = lifecycleOf(status, now), ap = status && status.autopay;
  if(lc === "past_due") return { tone: "warn", text: "AutoPay couldn't collect your plan's renewal. Your bank is asked again — or pay now.", cta: "Pay now" };
  if(lc === "renewing") return { tone: "info", text: "Your plan is renewing by AutoPay.", cta: "View" };
  if(s === "trial_active"){
    const on = ap && ap.status === "active", ending = n <= 2 || lc === "trial_ending";
    return { tone: ending ? "warn" : "info", text: `Free trial · ${plural(n, "day")} left · ends ${when(status.access_until)}` + (on ? ` · AutoPay from ${when(ap.next_charge_at || status.trial_ends_at)}` : ""),
      cta: on ? "Manage" : "Choose a plan" };
  }
  if(s === "paid_active" && n <= 7) return { tone: "warn", text: `Your plan ends in ${plural(n, "day")} (${when(status.access_until)})`, cta: "Renew" };
  return null;
}

/* The plan facts for Plans & Billing: [{ label, value }] */
export function planFacts(status, now){
  const s = stateAt(status, now), rows = [];
  if(!status || s === "none" || s === "unavailable") return rows;
  rows.push({ label: "Plan", value: status.plan_label ? status.plan_label : "Free trial" });
  if(status.trial_started_at) rows.push({ label: "Trial", value: `${when(status.trial_started_at)} – ${when(status.trial_ends_at)}` });
  if(status.period_start) rows.push({ label: "Paid plan started", value: when(status.period_start) });
  if(status.access_until) rows.push({ label: LOCKED_STATES.includes(s) ? "Ended on" : (s === "trial_active" ? "Trial ends on" : "Expires on"), value: when(status.access_until) });
  if(ACTIVE_STATES.includes(s)) rows.push({ label: "Days remaining", value: plural(daysLeft(status, now), "day") });
  if(status.autopay && status.autopay.status !== "none") rows.push({ label: "AutoPay", value: autopayText(status.autopay) });
  return rows;
}

/* "₹449/month" hint for a plan of several months (the amount comes from the server's price) */
export const perMonth = plan => plan && plan.months > 1 && +plan.price > 0 ? Math.round(+plan.price / plan.months) : null;

/* A plan payment's line in the history */
export const PAYMENT_STATUS = Object.freeze({ paid: "Paid", created: "Not completed", failed: "Failed", cancelled: "Cancelled", expired: "Expired" });
/* The AutoPay terms the owner agrees to, in words (money already written the shop's way): what today, how much and how often
   after, from when — the screen shows exactly this next to the tick box */
export function autopayConsentText({ price, today, months, firstChargeOn }){
  const every = +months > 1 ? `every ${months} months` : "every month";
  return `I agree to AutoPay: Hangtag charges ${price} ${every} from ${firstChargeOn}, until I cancel. ${today} is charged today. I can cancel any time before a renewal.`;
}
