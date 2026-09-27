// Camera scanning rules: which scanned texts can be product codes, and not counting one sticker many times. Pure.
import { CODE_MAX_LEN, isPrintableCode } from '../catalog/barcode.js';

/* A code seen again within this time (ms) of the last sighting is the same sticker still in view, not a new scan */
export const REPEAT_MS = 1500;

/* Why scanned text can't be a product code in this shop (a message for the cashier), or null when it can */
export function scanCodeError(raw){
  const t = String(raw == null ? "" : raw).trim();
  if(!t) return "No code was read. Try again.";
  if(t.length > CODE_MAX_LEN || !isPrintableCode(t)) return "That code can't belong to a product in this shop.";
  return null;
}

/* pass(code, now) is true the first time a code is seen, and false while the same code keeps being seen (each sighting
   within `ms` of the previous one extends the wait), so a sticker held in front of the camera is added once. To add the
   same item again the cashier moves the camera away and back. A different code passes at once. */
export function createScanGate(ms = REPEAT_MS){
  let last = "", seen = -Infinity;
  return {
    pass(code, now){
      const c = String(code == null ? "" : code).trim();
      if(c === last && now - seen < ms){ seen = now; return false; }
      last = c; seen = now;
      return true;
    },
    reset(){ last = ""; seen = -Infinity; },
  };
}
