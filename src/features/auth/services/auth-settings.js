// Which sign-in methods are on; session checks; methods for an email.
import { store } from '../../../shared/state/store.js';
import { use } from '../../../shared/di/services.js';

export async function loadAuthSettings(){
  if(store.authSettings) return store.authSettings;
  store.authSettings = await use("cloud").auth.settings();
  return store.authSettings;
}
/* Cloud reads and writes need a live signed-in session. Without one supabase-js falls back to the
   public key, and the server would refuse or quietly answer with nothing. */

export async function sbSessionOk(){
  if(!store.sbClient) return false;
  try{ const { data } = await use("cloud").auth.getSession(); return !!(data && data.session); }catch(e){ return false; }
}
/* How does this email sign in today? ["google"], ["email"], both, or [] for a new person.
   null means we couldn't find out (database not updated yet, or offline). */

export async function signInMethodsFor(email){
  try{
    const { data, error } = await use("cloud").signInMethods(email);
    if(error) return null;
    return Array.isArray(data) ? data : [];
  }catch(e){ return null; }
}
