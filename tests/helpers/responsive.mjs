// Layout checks for a screen as drawn, in the browser: whatever the screen size, nothing makes the page scroll sideways;
// no control sits off the screen (unless it is in a row that scrolls on its own); an open sheet fits the screen or
// scrolls inside; and on a touch screen every control is at least `minTap` px (24 by default: WCAG 2.2's minimum target
// size; a link inside a sentence is exempt, as WCAG allows); and every control has a name a screen reader can say (its text, an
// aria-label, a <label>, a title — a placeholder alone is not a name).
//   const issues = await layoutIssues(page, { touch: true });   // [{ kind: 'sideways' | 'off-screen' | 'sheet' | 'small-target' | 'unnamed', el, … }]
export async function layoutIssues(page, { touch = false, minTap = 24, scope = 'body', names = true } = {}){
  return page.evaluate(({ touch, minTap, scope, names }) => {
    const out = [], W = document.documentElement.clientWidth, H = window.innerHeight;
    // (folded away, e.g. inside a closed <details>, which Chrome lays out but doesn't show, counts as not shown)
    const shown = (el) => { const r = el.getBoundingClientRect(), s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && +s.opacity !== 0 && (!el.checkVisibility || el.checkVisibility()); };
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
      // a text field squeezed too narrow to type in (a row that should have wrapped)
      if(/^(INPUT|TEXTAREA)$/.test(el.tagName) && (el.tagName === 'TEXTAREA' || /^(text|search|email|tel|url|password)$/.test(el.type)) && r.width < 80) out.push({ kind: 'narrow-field', el: label(el), w: Math.round(r.width) });
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
    // a bar fixed to the screen (the phone's tab bar, a sticky header): page content passes under it on purpose
    const pinned = (el) => { for(let p = el; p && p !== document.body; p = p.parentElement){ const s = getComputedStyle(p).position; if(s === 'fixed' || s === 'sticky') return p; } return null; };
    // two controls drawn over each other (a button over a field, two buttons on top of one another): the layout broke
    // the part of a control actually drawn: cut to every box around it that clips or scrolls (a chip scrolled out of its row
    // isn't under the button next to the row)
    const drawn = (el) => { const r = el.getBoundingClientRect(); let L = r.left, T = r.top, Rr = r.right, B = r.bottom;
      for(let p = el.parentElement; p && p !== document.body; p = p.parentElement){ const st = getComputedStyle(p);
        if(st.overflowX !== 'visible'){ const q = p.getBoundingClientRect(); L = Math.max(L, q.left); Rr = Math.min(Rr, q.right); }
        if(st.overflowY !== 'visible'){ const q = p.getBoundingClientRect(); T = Math.max(T, q.top); B = Math.min(B, q.bottom); } }
      return { left: L, top: T, right: Rr, bottom: B, width: Rr - L, height: B - T }; };
    const boxes = controls.map((el) => ({ el, r: drawn(el), pin: pinned(el) })).filter((b) => b.r.width > 2 && b.r.height > 2);
    const seen = new Set();
    for(let i = 0; i < boxes.length; i++) for(let j = i + 1; j < boxes.length; j++){
      const a = boxes[i], b = boxes[j];
      if(a.pin !== b.pin || a.el.contains(b.el) || b.el.contains(a.el)) continue;
      const lab = (e) => e.closest('label');
      if(lab(a.el) && lab(a.el) === lab(b.el)) continue;   // a field and its own label's button
      // a button set inside a field on purpose (the search box's voice or clear button)
      const field = (e) => /^(INPUT|TEXTAREA|SELECT)$/.test(e.tagName);
      if((field(a.el) && a.el.parentElement && a.el.parentElement.contains(b.el)) || (field(b.el) && b.el.parentElement && b.el.parentElement.contains(a.el))) continue;
      const x = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left), y = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
      if(x > 4 && y > 4){ const k = label(a.el) + '|' + label(b.el); if(!seen.has(k)){ seen.add(k); out.push({ kind: 'overlap', el: label(a.el), with: label(b.el), x: Math.round(x), y: Math.round(y) }); } }
    }
    // two cards drawn over each other (a grid or a negative margin gone wrong)
    const cards = [...root].flatMap((r) => [...r.querySelectorAll('.card')]).filter(shown).map((el) => ({ el, r: drawn(el), pin: pinned(el) })).filter((b) => b.r.width > 2 && b.r.height > 2);
    for(let i = 0; i < cards.length; i++) for(let j = i + 1; j < cards.length; j++){
      const a = cards[i], b = cards[j];
      if(a.pin !== b.pin || a.el.contains(b.el) || b.el.contains(a.el)) continue;
      const x = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left), y = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
      if(x > 4 && y > 4) out.push({ kind: 'overlap', el: label(a.el), with: label(b.el), x: Math.round(x), y: Math.round(y) });
    }
    // a control cut off by a box that hides what overflows it (and doesn't scroll to show it)
    for(const { el } of boxes){
      const r = el.getBoundingClientRect();
      for(let p = el.parentElement; p && p !== document.body; p = p.parentElement){
        const s = getComputedStyle(p), hx = /(hidden|clip)/.test(s.overflowX), hy = /(hidden|clip)/.test(s.overflowY);
        if(!hx && !hy) continue;
        if((/(auto|scroll)/.test(s.overflowX) && p.scrollWidth > p.clientWidth + 1) || (/(auto|scroll)/.test(s.overflowY) && p.scrollHeight > p.clientHeight + 1)) break;
        const pr = p.getBoundingClientRect();
        if(pr.width < 4 || pr.height < 4) break;   // a visually hidden box (sr-only) holds it on purpose
        const cut = (hx && (r.left < pr.left - 2 || r.right > pr.right + 2)) || (hy && (r.top < pr.top - 2 || r.bottom > pr.bottom + 2));
        if(cut) out.push({ kind: 'clipped', el: label(el), by: label(p) });
        break;
      }
    }
    return out;
  }, { touch, minTap, scope, names });
}
/* Scrolled to the very end, does anything stay under a bar fixed to the bottom of the screen (the phone's tab bar)?
   The page must leave room to scroll its last controls above it. → [{ kind: 'covered', el, bar }] */
export async function coveredAtEnd(page, { scope = 'body' } = {}){
  return page.evaluate(async ({ scope }) => {
    const H = window.innerHeight, shown = (el) => { const r = el.getBoundingClientRect(), s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && (!el.checkVisibility || el.checkVisibility()); };
    const bars = [...document.querySelectorAll('body *')].filter((e) => { const s = getComputedStyle(e); if(s.position !== 'fixed' || !shown(e)) return false; const r = e.getBoundingClientRect(); return r.bottom >= H - 2 && r.height < H / 3 && r.width > 200; });
    if(!bars.length) return [];
    const scroller = document.scrollingElement || document.documentElement, before = scroller.scrollTop;
    scroller.scrollTop = scroller.scrollHeight; await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const inBar = (el) => bars.some((b) => b.contains(el)), out = [];
    const controls = [...document.querySelectorAll(scope)].flatMap((r) => [...r.querySelectorAll('button, a[href], input:not([type=hidden]), select, textarea')]).filter((e) => shown(e) && !inBar(e));
    for(const el of controls){
      const r = el.getBoundingClientRect(); if(r.height < 3) continue;
      for(const b of bars){ const br = b.getBoundingClientRect(); if(r.bottom > br.top + 2 && r.top < br.bottom && r.right > br.left && r.left < br.right) out.push({ kind: 'covered', el: (el.innerText || el.getAttribute('aria-label') || el.tagName).trim().slice(0, 30), bar: b.className || b.tagName }); }
    }
    scroller.scrollTop = before;
    return out;
  }, { scope });
}
