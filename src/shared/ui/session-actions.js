// Sign out and open the shop, for screens that sit around sign-in (shop setup, account menu, settings).
// The auth feature provides the "session" port at start-up (app/container.js), so those screens never import it.
import { use } from '../di/services.js';

/* opts (optional): { message: shown on the sign-in screen, forgetDevice: a team member's phone lost the shop } */
export const requestSignOut = opts => use("session").signOut(opts);
export const requestEnterApp = firstTime => use("session").enterApp(firstTime);
