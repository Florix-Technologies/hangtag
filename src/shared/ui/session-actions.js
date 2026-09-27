// Sign out and open the shop, for screens that sit around sign-in (shop setup, account menu, settings).
// The auth feature provides the "session" port at start-up (app/container.js), so those screens never import it.
import { use } from '../di/services.js';

export const requestSignOut = () => use("session").signOut();
export const requestEnterApp = firstTime => use("session").enterApp(firstTime);
