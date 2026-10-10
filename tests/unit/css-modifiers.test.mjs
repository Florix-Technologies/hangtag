// Modifier classes are styled only together with what they modify. "sm", "xs", "lg", "primary", "ghost", "danger", "icon"
// size or colour a button, a thumbnail, an avatar or an icon button (.btn.sm, .ph.sm, .avatar.sm …); a rule for one of
// them on its own styles every one of those at once. That happened: a leftover ".sm{margin-top:14px}" from an old stock
// list pushed every small button, product thumbnail and small avatar 14 px down, across the whole app.
// Run: node tests/unit/css-modifiers.test.mjs
import { readFileSync, readdirSync } from 'node:fs';

let fails = 0;
const check = (name, ok, info) => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (!ok && info !== undefined ? '  ' + JSON.stringify(info) : '')); };
const dir = new URL('../../src/styles/', import.meta.url);
const MODIFIERS = ['sm', 'xs', 'lg', 'primary', 'ghost', 'danger', 'icon', 'compact'];
const found = [];
for (const f of readdirSync(dir).filter((x) => x.endsWith('.css'))) {
  const css = readFileSync(new URL(f, dir), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of css.matchAll(/([^{}@;]+)\{/g)) {
    for (const sel of m[1].split(',').map((x) => x.trim())) {
      // the selector's last compound: a modifier alone there (".sm", "div .sm", ".x > .sm") styles everything that wears it
      const last = sel.split(/[\s>+~]+/).pop() || '';
      const mm = /^\.([A-Za-z0-9_-]+)(?::[\w-]+(?:\([^)]*\))?)*$/.exec(last);
      if (mm && MODIFIERS.includes(mm[1])) found.push(`${f}: ${sel}`);
    }
  }
}
check(`no modifier class (${MODIFIERS.join(', ')}) is styled on its own`, found.length === 0, found);
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
