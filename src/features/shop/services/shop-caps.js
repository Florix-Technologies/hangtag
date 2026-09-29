// What this shop uses (read model): its type of business (the shop profile) and its capabilities (the type's defaults
// with the shop's own choices from the synced settings). Rules in domain/shop/capabilities.js. Only decides what is shown:
// what a person may do is its role's permissions (services/access.js), which the database enforces.
import { store } from '../../../shared/state/store.js';
import { businessKind, businessLabel, capsFor } from '../../../domain/shop/capabilities.js';

/* retail | grocery | restaurant | electronics | other (a profile without one, or an older value, counts as retail) */
export const shopType = () => businessKind(store.profile && store.profile.business_type);
export const shopTypeLabel = () => businessLabel(shopType());
/* { uses_x: true|false } for every capability */
export const shopCaps = () => capsFor(shopType(), store.settings && store.settings.caps);
export const hasCap = k => !!shopCaps()[k];
