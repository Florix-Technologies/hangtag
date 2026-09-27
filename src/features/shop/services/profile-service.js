// Loads this account's shop profile (saving: use-cases/save-shop-profile.js).
import { store } from '../../../shared/state/store.js';
import { saveProfile, storage } from '../../../shared/state/persistence.js';
import { use } from '../../../shared/di/services.js';
import { logger } from '../../../shared/logging/logger.js';

/* Load this account's profile from the cloud (or this device when offline). fresh = came from the cloud. */

export async function loadProfile(user){
  const m = user.user_metadata || {};
  try{
    const cloud = use("cloud");
    const { data, error } = await cloud.getProfile(user.id);
    if(error) throw error;
    let p = data;
    if(!p){
      // The sign-up trigger didn't make one (older database): make it now
      p = { id: user.id, email: user.email || null, full_name: m.full_name || m.name || null, avatar_url: m.avatar_url || m.picture || null };
      const r = await cloud.createProfile(p);
      if(r.error) logger.warn("Profile not created:", r.error.message);
    }
    // Keep email and photo current; never overwrite details the person typed
    const patch = { last_seen_at: new Date().toISOString() };
    if(user.email && p.email !== user.email) patch.email = user.email;
    if(!p.avatar_url && (m.avatar_url || m.picture)) patch.avatar_url = m.avatar_url || m.picture;
    cloud.updateProfile(user.id, patch).then(r => { if(r.error) logger.warn("Profile not updated:", r.error.message); }, () => {});
    store.profile = Object.assign({}, p, patch);
    if(!store.profile.full_name && (m.full_name || m.name)) store.profile.full_name = m.full_name || m.name;
    saveProfile();
    return { profile:store.profile, fresh: true };
  }catch(e){
    logger.warn("Profile from this device:", e && e.message || e);
    store.profile = storage.get("hangtag_profile", null);
    return { profile:store.profile, fresh: false };
  }
}
