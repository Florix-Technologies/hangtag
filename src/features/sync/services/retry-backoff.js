// A small, timer-free retry clock shared by the background download schedulers. Callers keep ownership of their
// existing timers and single-flight rules; this only answers whether a routine poll may try and records outcomes.
export const RETRY_DELAYS_MS = Object.freeze([60e3, 2 * 60e3, 4 * 60e3, 5 * 60e3]);

export function retryDelay(failures){
  const count = Math.max(1, Math.floor(Number(failures) || 1));
  return RETRY_DELAYS_MS[Math.min(count - 1, RETRY_DELAYS_MS.length - 1)];
}

export function createRetryBackoff({ now = () => Date.now() } = {}){
  let failures = 0, nextRetryAt = 0;
  return {
    // User/device signals may bypass the delay. Routine polling waits for the current retry window.
    canTry({ immediate = false, at = now() } = {}){
      return immediate || failures === 0 || at >= nextRetryAt;
    },
    failed(at = now()){
      failures += 1;
      nextRetryAt = at + retryDelay(failures);
      return nextRetryAt;
    },
    succeeded(){ failures = 0; nextRetryAt = 0; },
    state: () => ({ failures, nextRetryAt }),
  };
}
