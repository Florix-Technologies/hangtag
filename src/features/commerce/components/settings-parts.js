// What the commerce batch adds to Settings (app/modules.js registers each part where the shop uses it): Selling → price
// lists, gift vouchers, GST documents; Advanced → integrations (webhooks).
import { allLists } from '../use-cases/price-lists.js';
import { esc } from '../../../shared/dom.js';

export function priceListsSettingsHTML(){
  const n = allLists().length, d = allLists().find(l => l.isDefault);
  return `<div class="setpart"><h5 class="subh">Price lists</h5><p class="note" style="margin:0">${n ? `${n} list${n === 1 ? "" : "s"}${d ? ` · default: ${esc(d.name)}` : ""}` : "Wholesale, distributor or special prices. The bill picks the right one by itself."}</p>
    <div class="setactions"><button type="button" class="btn sm" data-biz="plmanage">${n ? "Open price lists" : "Add a price list"}</button></div></div>`;
}
