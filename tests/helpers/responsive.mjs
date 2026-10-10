// Layout checks for a screen as drawn, in the browser: whatever the screen size, nothing makes the page scroll sideways;
// no control sits off the screen (unless it is in a row that scrolls on its own); an open sheet fits the screen or
// scrolls inside; and on a touch screen every control is at least `minTap` px (24 by default: WCAG 2.2's minimum target
// size; a link inside a sentence is exempt, as WCAG allows); and every control has a name a screen reader can say (its text, an
// aria-label, a <label>, a title — a placeholder alone is not a name).
//   const issues = await layoutIssues(page, { touch: true });   // [{ kind: 'sideways' | 'off-screen' | 'sheet' | 'small-target' | 'unnamed', el, … }]
export async function layoutIssues(page, { touch = false, minTap = 24, scope = 'body', names = true } = {}){
  return page.evaluate(({ touch, minTap, scope, names }) => {
    const out = [], W = document.documentElement.clientWidth, H = window.innerHeight;
    const shown = (el) => { const r = el.getBoundingClientRect(), s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && +s.opacity !== 0; };
    const label = (el) => {
      const ds = Object.keys(el.dataset || {})[0], txt = (el.innerText || el.value || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, 30);
      return `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : ''}${ds ? `[data-${ds.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())}]` : ''}${txt ? ` “${txt}”` : ''}`;
    };
    /* inside a row that scrolls (or clips) sideways on its own: being past the edge there is by design */
    const inScroller = (el) => { for(let p = el.parentElement; p && p !== document.body; p = p.parentElement){ const s = getComputedStyle(p); if(/(auto|scroll|hidden|clip)/.test(s.overflowX) && p.scrollWidth > p.clientWidth + 1) return true; } return false; };
    if(document.documentElement.scrollWidth > W + 1) out.push({ kind: 'sideways', by: document.documentElement.scrollWidth - W });
    const root = document.querySelectorAll(scope);
    const controls = [...root].flatMap((r) => [...r.querySelectorAll('button, a[href], input:not([type=hidden]), select, textarea, [role="button"]')]).filter(shown);
    const t = (v) => (v || '').replace(/\s+/g, ' ').trim();
    const named = (el) => {
      if(t(el.getAttribute('aria-label')) || t(el.getAttribute('title'))) return true;
      const by = el.getAttribute('aria-labelledby');
      if(by && by.split(/\s+/).some((id) => t((document.getElementById(id) || {}).textContent))) return true;
      if(/^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName)){
        const lab = el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        return !!((lab && t(lab.textContent)) || (el.closest('label') && t(el.closest('label').textContent)) || (/^(submit|button|reset)$/.test(el.type) && t(el.value)));
      }
      return !!(t(el.innerText) || [...el.querySelectorAll('img[alt], svg[aria-label]')].some((i) => t(i.getAttribute('alt') || i.getAttribute('aria-label'))));
    };
    for(const el of controls){
      const r = el.getBoundingClientRect();
      if(names && r.width > 2 && r.height > 2 && !named(el)) out.push({ kind: 'unnamed', el: label(el) });
      if((r.right > W + 1 || r.left < -1) && !inScroller(el)) out.push({ kind: 'off-screen', el: label(el), left: Math.round(r.left), right: Math.round(r.right) });
      // a visually hidden control (a file input behind its button, an sr-only box) isn't a target of its own
      if(touch && r.width > 2 && r.height > 2 && Math.min(r.width, r.height) < minTap){
        const inText = /^(P|SMALL|SPAN|LI|H[1-6]|LABEL|DD|TD)$/.test(el.parentElement && el.parentElement.tagName) && /\blink\b/.test(el.className || '') || el.tagName === 'A';
        const box = (el.type === 'checkbox' || el.type === 'radio') && el.closest('label');
        const big = box && Math.min(box.getBoundingClientRect().width, box.getBoundingClientRect().height) >= minTap;
        if(!inText && !big) out.push({ kind: 'small-target', el: label(el), w: Math.round(r.width), h: Math.round(r.height) });
      }
    }
    for(const sh of document.querySelectorAll('.sheet')){
      if(!shown(sh)) continue;
      const r = sh.getBoundingClientRect(), scrolls = (e) => /(auto|scroll)/.test(getComputedStyle(e).overflowY) && e.scrollHeight > e.clientHeight;
      const inside = [sh, ...sh.querySelectorAll('*')].some((e) => scrolls(e));
      if((r.bottom > H + 1 || r.top < -1) && !inside) out.push({ kind: 'sheet', el: label(sh), top: Math.round(r.top), bottom: Math.round(r.bottom), H });
      if(r.width > W + 1) out.push({ kind: 'sheet', el: label(sh), width: Math.round(r.width), W });
    }
    return out;
  }, { touch, minTap, scope, names });
}
