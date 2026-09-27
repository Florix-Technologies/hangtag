// Keyboard shortcuts and barcode-scanner input.
import { closeScanner } from '../../features/sales/components/camera-scan.js';
import { store } from '../../shared/state/store.js';
import { edAddOption, edAddValues } from '../../features/products/components/product-editor.js';
import { prod } from '../../features/products/services/catalog.js';
import { renderReturnSheet } from '../../features/returns/components/return-sheet.js';
import { closeSheets } from '../../features/sales/components/bill-panel.js';
import { addPicked, openPicker, pickRows, renderPicker, setPickQty } from '../../features/sales/components/variant-picker.js';
import { renderGrid } from '../../features/sales/pages/sell-page.js';
import { addOne } from '../../features/sales/services/cart.js';
import { findByCode, sellProducts, variantHits } from '../../features/sales/services/search.js';
import { openPayment, completePayment } from '../../features/sales/components/payment-sheet.js';
import { applyLineDiscount } from '../../features/sales/components/discount-sheet.js';
import { closeModal } from '../../shared/components/modal.js';
import { toast } from '../../shared/components/toast.js';
import { hideTip } from '../../shared/components/tooltip.js';
import { $ } from '../../shared/dom.js';

export function runShortcut(e){
  const k=e.key.toLowerCase();
  if(/^[0-9]$/.test(k)){
    const i=(+k||10)-1;
    if(store.pick){const p=prod(store.pick.pid);if(!p)return;const {sizes,find}=pickRows(p);const s=sizes[i];if(s!=null&&k!=="0"){const v=find(store.pick.color||(pickRows(p).colors[0]||""),s);if(v){setPickQty(v.id,(store.pick.qty[v.id]||0)+1);const b=$("#addPickBtn");if(b&&!b.disabled)b.focus({preventScroll:true})}}}
    else{const p=sellProducts()[i];if(p)openPicker(p.id)}
    return;
  }
}
export function handleKey(e){
  const k=e.key.toLowerCase();
  if(/^[0-9]$/.test(k)){runShortcut(e);if(e.preventDefault)e.preventDefault();return}
  if(store.pick&&(k==="+"||k==="="||k==="-")&&store.pick.last){setPickQty(store.pick.last,(store.pick.qty[store.pick.last]||0)+(k==="-"?-1:1));e.preventDefault();return}
  if(store.pick&&(k==="arrowdown"||k==="arrowup")){const p=prod(store.pick.pid);const cs=p?pickRows(p).colors:[];if(cs.length>1){const i=cs.indexOf(store.pick.color);store.pick.color=cs[(i+(k==="arrowdown"?1:cs.length-1))%cs.length];renderPicker();e.preventDefault()}return}
  if(store.pick&&k==="enter"&&!(e.target.closest&&e.target.closest("[data-act],[data-color],[data-cellminus],.iconbtn"))){addPicked();e.preventDefault();return}
  if(!store.pick&&store.cart.length&&(k==="c"||k==="u"||k==="k")){openPayment(k==="c"?"cash":k==="u"?"upi":"card");if(e.preventDefault)e.preventDefault()}
}

/* Registered once at start-up (app/main.js). */
export function installKeyboard(){
  document.addEventListener("focusout",e=>{if(e.target.matches&&e.target.matches("[data-cellqty]")&&store.pick){const q=store.pick.qty[e.target.dataset.cellqty]||0;e.target.value=q||""}});
  document.addEventListener("keydown",e=>{
    if(e.key==="Escape"){
      if(store.scan){closeScanner();e.preventDefault();return}
      if(!$("#acctMenu").hidden)return;
      if($("#modalHost").innerHTML){if(store.editor||store.billImport)return; /* the product editor only closes with Cancel or ×, so work is never lost by accident */ store.payState=null;store.lineDisc=null;closeModal();e.preventDefault();return}
      if(store.pick&&store.pick.target==="exchange"){store.pick=null;renderReturnSheet();e.preventDefault();return}
      if(store.pick||store.billOpen||$("#sheetHost").innerHTML){store.retState=null;closeSheets();e.preventDefault()}hideTip();return;
    }
    if(!$("#authGate").hidden||!$("#setupGate").hidden)return;
    // Enter in the search box: a scanned code or a single match goes straight onto the bill
    if(e.key==="Enter"&&e.target.id==="sellSearch"){
      e.preventDefault();const q=e.target.value.trim();if(!q)return;
      const hit=findByCode(q)||(variantHits().length===1?variantHits()[0]:null);
      if(hit){addOne(hit.v.id);e.target.value="";store.sellQuery="";renderGrid();return}
      const ps=sellProducts();if(ps.length===1){openPicker(ps[0].id);return}
      toast(`Nothing found for “${q}”.`);return;
    }
    if(e.key==="Enter"&&store.pick&&e.target.matches&&e.target.matches("[data-cellqty]")){e.preventDefault();addPicked();return}
    if($("#sheetHost [data-paid]")&&(e.key==="Enter"||e.key===" ")&&!(e.target.closest&&e.target.closest("button"))){closeSheets();e.preventDefault();return}
    // Enter on the payment screen completes the sale (when the payments add up); in the line discount box it applies
    if(e.key==="Enter"&&store.payState&&e.target.closest&&e.target.closest("#paySheet")&&!(e.target.closest("button"))){e.preventDefault();const b=$("#payDone");if(b&&!b.disabled)completePayment();return}
    if(e.key==="Enter"&&store.lineDisc&&e.target.id==="ldVal"){e.preventDefault();applyLineDiscount(false);return}
    if($("#modalHost").innerHTML)return;
    if(store.prefs.tab!=="sell"||e.metaKey||e.ctrlKey||e.altKey)return;
    if(e.target.matches&&e.target.matches("input,select,textarea"))return;
    if(e.key==="/"&&!store.pick){const s=$("#sellSearch");if(s){s.focus();e.preventDefault()}return}
    const now=performance.now();
    // Scanner detection: printable keys arriving very fast are buffered; Enter completes a scan
    if(e.key.length===1&&e.key!==" "&&!store.pick){
      if(now-store.scanLast>60){store.scanBuf="";store.scanT0=now}
      store.scanBuf+=e.key;store.scanLast=now;
      clearTimeout(store.scanTimer);
      if(store.scanBuf.length===1){store.scanHeld=e;store.scanTimer=setTimeout(()=>{if(store.scanBuf.length===1)handleKey(store.scanHeld);store.scanBuf=""},70);e.preventDefault();return}
      e.preventDefault();return;
    }
    if(e.key==="Enter"&&!store.pick&&store.scanBuf.length>=3&&now-store.scanLast<100){
      e.preventDefault();const code=store.scanBuf;store.scanBuf="";clearTimeout(store.scanTimer);
      const hit=findByCode(code);
      if(hit)addOne(hit.v.id);else toast(`No product with code ${code}.`);
      return;
    }
    handleKey(e);
  });
  /* Product editor: Enter or comma adds option values; Enter in the new-option box adds the option */

  document.addEventListener("keydown",e=>{
    if(!store.editor)return;
    const t=e.target;
    if(t.dataset&&t.dataset.valadd!=null&&(e.key==="Enter"||e.key===",")){e.preventDefault();const v=t.value;t.value="";if(v.trim())edAddValues(+t.dataset.valadd,v);return}
    if(t.id==="optAdd"&&e.key==="Enter"){e.preventDefault();edAddOption(t.value);return}
    if(e.key==="Enter"&&t.matches&&t.matches("#edForm input:not([type=checkbox])")){e.preventDefault()}
  },true);
}
