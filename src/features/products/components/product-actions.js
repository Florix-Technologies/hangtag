// Archive, restore and delete buttons: confirm, run the use case, and show the result.
import { store } from '../../../shared/state/store.js';
import { archiveProduct, productHasSales, removeProduct } from '../use-cases/product-lifecycle.js';
import { prod } from '../services/catalog.js';
import { flushSbQueue } from '../../sync/services/outbox.js';
import { closeModal } from '../../../shared/components/modal.js';
import { toast } from '../../../shared/components/toast.js';
import { saveCart } from '../../../shared/state/persistence.js';
import { renderAll } from '../../../shared/ui/render.js';
import { refuse } from '../../shop/services/access.js';

export function setArchived(pid,on){
  if(refuse("manage_products","change products"))return;
  const p=archiveProduct(pid,on);if(!p)return;
  if(p.error){toast(p.error);return}
  flushSbQueue();
  store.cart=store.cart.filter(c=>c.p!==pid||!on);saveCart();
  if(store.editor&&store.editor.id===pid){store.editor=null;closeModal()}
  renderAll();toast(on?`${p.name} archived. It's hidden from selling; past bills and reports keep it.`:`${p.name} is back on sale.`);
}
export function deleteProduct(pid){
  if(refuse("manage_products","delete products"))return;
  const p=prod(pid);if(!p)return;
  if(productHasSales(pid)){toast("This product has sales, so it can only be archived.");return}
  if(!confirm(`Delete ${p.name} for good? Its stock records go too.`))return;
  const r=removeProduct(pid);if(r&&r.error){toast(r.error);return}
  flushSbQueue();
  store.editor=null;closeModal();renderAll();toast(`${p.name} deleted.`);
}
