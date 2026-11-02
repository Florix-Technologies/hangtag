// The checkout's steps (Items → Customer → Review → Payment) as shown on the checkout sheets and the payment screen: the
// step on screen, the steps done, and the steps skipped (a sale paid straight from the bill's Cash / UPI / Card buttons skips
// Customer and Review: they say "Skipped", never done).
import { esc } from '../../../shared/dom.js';

export const CHECKOUT_STEPS = [["items", "Items"], ["customer", "Customer"], ["review", "Review"], ["payment", "Payment"]];
/* The steps, the one on screen marked: flow { customer, review } → "done" | "skipped" (Items is always done by then) */
export function progressHTML(cur, flow = {}){
  return `<ol class="checkout-progress" aria-label="Checkout steps">${CHECKOUT_STEPS.map(([k, l]) => {
    const st = k === cur ? "on" : k === "items" || flow[k] === "done" ? "done" : flow[k] === "skipped" ? "skipped" : "";
    const said = st === "done" ? "done" : st === "skipped" ? "skipped" : st === "on" ? "current step" : "to do";
    return `<li class="${st}" data-step="${k}"${st === "on" ? ' aria-current="step"' : ""}><span class="cs-l">${esc(l)}</span>${st === "skipped" ? '<small>Skipped</small>' : ""}<span class="sr"> (${said})</span></li>`;
  }).join("")}</ol>`;
}
