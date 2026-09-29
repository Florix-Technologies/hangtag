// SaveShopProfile: store the shop details (first-time setup or settings) in the cloud and on this device.
import { store } from '../../../shared/state/store.js';
import { authErrorText } from '../../auth/services/auth-errors.js';
import { saveProfile } from '../../../shared/state/persistence.js';
import { use } from '../../../shared/di/services.js';
import { isMember, notAllowedText } from '../services/access.js';

/* values: checked profile fields (domain/shop/profile-validation.js). Throws an Error with a message for the person on failure. */
export async function saveShopProfile(values){
  // the shop's details (and its type of business) are the owner's: a team member works with them as they are
  if(isMember()) throw new Error(notAllowedText("change the shop's details"));
  const row = Object.assign({ id: store.authUser.id, email: store.authUser.email || null, updated_at: new Date().toISOString() }, values);
  if(!store.profile || !store.profile.onboarded_at) row.onboarded_at = new Date().toISOString();
  const { error } = await use("cloud").saveProfile(row);
  if(error){
    if(/column .* does not exist|schema cache/i.test(error.message || "")) throw new Error("The database needs the latest update (schema.sql) before profiles can be saved.");
    throw new Error(authErrorText(error));
  }
  store.profile = Object.assign({}, store.profile || {}, row);
  saveProfile();
}
