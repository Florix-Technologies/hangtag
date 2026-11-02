// A shared device keeps each account's data apart (features/auth/services/account-data.js): every key the app stores is
// either put away and brought back per account (USER_KEYS) or deliberately the device's (DEVICE_KEYS). A new key that is
// neither would carry one shop's data — or hide its warnings — into the next account that signs in on the device.
// Run: node tests/unit/account-keys.test.mjs
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

let fails = 0;
const check = (name, ok, info) => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (!ok && info !== undefined ? '  ' + JSON.stringify(info).slice(0, 600) : '')); };
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..');
const src = readFileSync(path.join(root, 'src/features/auth/services/account-data.js'), 'utf8');
const listOf = (name) => new Set([...(src.match(new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\];`)) || [, ''])[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]));
const USER = listOf('USER_KEYS'), DEVICE = listOf('DEVICE_KEYS');

const walk = (d) => readdirSync(d).flatMap((f) => { const p = path.join(d, f); return statSync(p).isDirectory() ? walk(p) : p.endsWith('.js') ? [p] : []; });
const used = new Map();
for (const f of walk(path.join(root, 'src'))) {
  const s = readFileSync(f, 'utf8');
  const keys = [...s.matchAll(/(?:storage\.(?:get|set|remove|getRaw|setRaw)|localStorage\.(?:getItem|setItem|removeItem))\(\s*["'`]([a-z][a-z0-9_]+)["'`]/g)].map((m) => m[1])
    .concat([...s.matchAll(/\b(?:const|let)\s+[A-Z_]+\s*=\s*"((?:hangtag|rc)_[a-z0-9_]+)"/g)].map((m) => m[1]).filter((k) => !/^hangtag_platform_/.test(k) && !/_(?:moves|orders|items|links)$/.test(k) || false));
  for (const k of keys) { if (!used.has(k)) used.set(k, new Set()); used.get(k).add(path.relative(root, f)); }
}
const stray = [...used.keys()].filter((k) => !USER.has(k) && !DEVICE.has(k) && !/^hangtag_(u|dev)_$/.test(k));
check(`every key the app stores is either kept per account or deliberately the device's (${used.size} keys)`, used.size > 30 && stray.length === 0,
  stray.map((k) => `${k} (${[...used.get(k)].join(', ')})`));
check('no key is both', [...USER].every((k) => !DEVICE.has(k)));
check('the last full sync and the backup log are per account (another account\'s must not hide this one\'s warnings)', USER.has('hangtag_last_sync') && USER.has('hangtag_backup_log'));
check('…and the sync time is read again when an account\'s data is brought back', /store\.lastSyncAt = \+storage\.get\("hangtag_last_sync"/.test(src.slice(src.indexOf('export function loadUserState'))));
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
