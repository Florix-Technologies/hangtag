// SaveCapabilities: what this shop uses (Settings → Business → Features). The choices are part of the shop's synced settings
// (settings.caps: only where they differ from the business type's defaults; settings.capsAt: when they changed, so an
// older copy on another phone never undoes them — domain/shop/capabilities.js keepNewerCaps, schema.sql section 3j).
// Saved on this device first, then uploaded. Needs manage_settings (the database refuses the upload without it too).
// A capability only changes what the app shows: it never lets anyone do more than its role's permissions.
import { store } from '../../../shared/state/store.js';
import { capOverridesAfter } from '../../../domain/shop/capabilities.js';
import { enqueue } from '../../sync/services/outbox.js';
import { saveSettings } from '../../../shared/state/persistence.js';
import { denied } from '../services/access.js';
import { shopCaps, shopType } from '../services/shop-caps.js';

/* changes: { uses_x: true|false } (any of them; the others stay as they are). → { error } (nothing changed) | { ok, caps } */
export function saveCapabilities(changes){
  const no = denied("manage_settings", "change what this shop uses"); if(no) return no;
  const r = capOverridesAfter(shopType(), store.settings.caps, changes);
  if(r.error) return { error: r.error };
  // later than the choices kept, even when this device's clock is behind the phone that made them
  const at = Math.max(Date.now(), (typeof store.settings.capsAt === "number" ? store.settings.capsAt : 0) + 1);
  store.settings = Object.assign({}, store.settings, { caps: r.overrides, capsAt: at });
  saveSettings(); enqueue({ type: "settings" });
  return { ok: true, caps: shopCaps() };
}
