// A shop's Hangtag plan as the app applies it (pure). The server decides the plan (schema.sql section 3t:
// hangtag_subscription_status) and refuses every business write once it has ended (SQLSTATE HT402); the app locks itself
// to match, using a time it can trust — never the bare device clock — so moving the clock back cannot extend access.
//   states: trial_active · paid_active · trial_expired · paid_expired · suspended · none (setup not finished) ·
//           unavailable (the server can't say yet, e.g. the database update isn't applied: nothing is locked)
import { dateText } from '../../shared/formatting/dates.js';

export const ACTIVE_STATES = Object.freeze(["trial_active", "paid_active"]);
export const LOCKED_STATES = Object.freeze(["trial_expired", "paid_expired", "suspended"]);
const DAY = 86400000;
const at = v => { const t = typeof v === "number" ? v : Date.parse(v); return Number.isFinite(t) ? t : null; };
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

/* The time the lock trusts:
     in this session  the server's time at the last check + the monotonic time since (performance.now: unaffected by the
                      device clock);
     after a restart  the server's time + how far the device clock moved since (never negative);
   and never earlier than the latest trusted time this device has seen (floor). Moving the clock back can't extend access;
   moving it forward can only lock sooner — and the next check with the server puts it right. */
export function trustedNow({ serverAt, perfAt, perfNow, clientAt, clockNow, floor } = {}){
  let t = null;
  if(Number.isFinite(serverAt)){
    if(Number.isFinite(perfAt) && Number.isFinite(perfNow) && perfNow >= perfAt) t = serverAt + (perfNow - perfAt);
    else if(Number.isFinite(clientAt) && Number.isFinite(clockNow)) t = serverAt + Math.max(0, clockNow - clientAt);
    else t = serverAt;
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

/* Whole days left (a part day counts as a day), 0 when locked or unknown */
export function daysLeft(status, now){
  const until = at(status && status.access_until);
  if(until == null || now == null || isLocked(status, now)) return 0;
  return Math.max(0, Math.ceil((until - now) / DAY));
}
const when = v => { const t = at(v); return t == null ? "" : dateText(t); };

/* The chip next to the plan: { label, tone: ok | warn | bad | muted } */
export function statusChip(status, now){
  const s = stateAt(status, now), n = daysLeft(status, now);
  if(s === "trial_active") return { label: n <= 2 ? `Trial · ${plural(n, "day")} left` : "Free trial", tone: n <= 2 ? "warn" : "ok" };
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
  const s = stateAt(status, now), n = daysLeft(status, now);
  if(s === "trial_active") return { tone: n <= 2 ? "warn" : "info", text: `Free trial · ${plural(n, "day")} left · ends ${when(status.access_until)}`, cta: "Choose a plan" };
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
  return rows;
}

/* "₹449/month" hint for a plan of several months (the amount comes from the server's price) */
export const perMonth = plan => plan && plan.months > 1 && +plan.price > 0 ? Math.round(+plan.price / plan.months) : null;

/* A plan payment's line in the history */
export const PAYMENT_STATUS = Object.freeze({ paid: "Paid", created: "Not completed", failed: "Failed", cancelled: "Cancelled", expired: "Expired" });
