// A product's photo, or (without one) its soft placeholder: the product's colour as a tint, its initials, on a card a tag glyph.
import { store } from '../../../shared/state/store.js';
import { esc } from '../../../shared/dom.js';
import { isLight, okColor, shade, tint } from '../../../shared/utils/colors.js';
import { initials } from '../../../shared/utils/text.js';

export function thumb(p,cls,src){
  if(src===undefined)src=p&&store.imgs[p.id];
  if(src)return `<span class="ph ${cls}"><img src="${esc(src)}" alt="" decoding="async"></span>`;
  return `<span class="ph noimg ${cls}"${phStyle(p)}>${phInner(p)}</span>`;
}
/* A product without a photo: a soft tint of its colour (never a big block of colour) with its initials in a readable ink;
   a large thumbnail (a product card) also gets a tag glyph above the initials */
export const phStyle=p=>{const c=okColor(p&&p.color);return ` style="background:${tint(c,isLight(c)?.55:.86)};color:${shade(c,isLight(c)?.62:.25)}"`};
const TAG='<svg class="ph-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 12.1V5a1.5 1.5 0 0 1 1.5-1.5h7.1a1.5 1.5 0 0 1 1.06.44l7.4 7.4a1.5 1.5 0 0 1 0 2.12l-7.1 7.1a1.5 1.5 0 0 1-2.12 0l-7.4-7.4a1.5 1.5 0 0 1-.44-1.06z"/><circle cx="8.3" cy="8.3" r="1.6"/></svg>';
export const phInner=(p,big)=>`${big?TAG:""}<span class="ini">${esc(initials(p&&p.name))}</span>`;
