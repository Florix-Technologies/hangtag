// ES-module entry to the shared test settings (see env.cjs).
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const env = require('./env.cjs');
export const { ROOT, PORT, BASE_URL, CHROME, ARTIFACTS, SCHEMA_PATH, indexHtml, hookedHtml, ensureServer } = env;
export default env;
