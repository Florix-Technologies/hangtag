// The Platform Console's start (platform/index.html, platform/login/index.html): Hangtag's own staff, apart from the shop
// app. Its own Supabase session (PLATFORM_AUTH_KEY: signing in here never signs in to the shop app, nor the other way), its
// link to the database (the "platform" port), and the page (features/platform). It runs only on a page that says it is the
// console (<html data-surface="platform" | "platform-login">); the shop app never loads it (scripts/build.mjs keeps it out
// of the test hook, and checks it as a bundle of its own).
import { cloudConfigured, sbKey, sbUrl } from '../shared/config/app-config.js';
import { provide } from '../shared/di/services.js';
import { makeSbClient } from '../infrastructure/supabase/client.js';
import { createPlatformGateway } from '../infrastructure/supabase/platform-gateway.js';
import { startConsole } from '../features/platform/components/console-app.js';

export const PLATFORM_AUTH_KEY = "hangtag-platform-auth";

const surface = typeof document !== "undefined" ? document.documentElement.dataset.surface : "";
if(surface === "platform" || surface === "platform-login"){
  if(cloudConfigured) provide("platform", createPlatformGateway({ client: makeSbClient({ url: sbUrl, key: sbKey, storageKey: PLATFORM_AUTH_KEY, deviceKey: null }) }));
  startConsole(surface, { configured: cloudConfigured });
}
