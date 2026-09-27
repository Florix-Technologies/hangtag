// Full-screen gates (sign-in, shop setup): element lookup, making the app behind them inert, focusing the card.

export const aEl = id => document.getElementById(id);
export function setAppInert(on){
  document.querySelectorAll("body > *").forEach(el => { if(el.id !== "authGate" && el.id !== "setupGate" && el.tagName !== "SCRIPT") el.inert = on; });
}
export function focusCard(gate){ if(!gate.contains(document.activeElement)) gate.querySelector(".authcard").focus({ preventScroll: true }); }
