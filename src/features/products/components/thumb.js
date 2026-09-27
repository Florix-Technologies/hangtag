// Product photo or initials tile.
import { store } from '../../../shared/state/store.js';
import { esc } from '../../../shared/dom.js';
import { isLight, okColor } from '../../../shared/utils/colors.js';
import { initials } from '../../../shared/utils/text.js';

export function thumb(p,cls,src){
  if(src===undefined)src=p&&store.imgs[p.id];
  if(src)return `<span class="ph ${cls}"><img src="${esc(src)}" alt="" decoding="async"></span>`;
  const c=okColor(p&&p.color);
  return `<span class="ph ${cls}" style="background:${c};color:${isLight(c)?"#10131F":"#FFFFFF"}"><span class="ini">${esc(initials(p&&p.name))}</span></span>`;
}
