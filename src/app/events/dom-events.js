// Delegated click/input/change/submit handling for the whole app.
import { store } from '../../shared/state/store.js';
import { renderNav } from '../navigation.js';
import { restoreBackup } from '../../features/backup/components/restore-dialog.js';
import { applyRestore, downloadBackup } from '../../features/backup/services/backup-file.js';
import { custBack, custFormType, editCustomerForm, newCustomerForm, openCustHistory, openCustPicker, pickCustomer, renderCustPicker, saveCustomerForm } from '../../features/customers/components/customer-picker.js';
import { renderCustomerList } from '../../features/customers/pages/customers-page.js';
import { setBillCustomer } from '../../features/customers/use-cases/save-customer.js';
import { chosenProduct, openProductChooser, renderChooser } from '../../features/inventory/components/product-chooser.js';
import { openStockOp, saveStockOp, updateStockOp } from '../../features/inventory/components/stock-operation.js';
import { renderStock } from '../../features/inventory/pages/stock-page.js';
import { applyGroup, openGroupPreview } from '../../features/products/components/colour-groups.js';
import { SIZE_PRESETS, edAction, edAddOption, edAddValues, edCombos, edFieldInput, edFocusKeep, edGenCode, edRemoveOption, edRemoveValue, edRenameOption, edRenameValue, edToggleOptions,
  openEditor, renderEditor, saveEditor } from '../../features/products/components/product-editor.js';
import { openStickers, stickerAction, stickerChange } from '../../features/products/components/stickers.js';
import { billImportChange, billImportClick, billImportInput, openBillImport } from '../../features/inventory/components/bill-import.js';
import { openScanner, scanAction } from '../../features/sales/components/camera-scan.js';
import { renderProducts } from '../../features/products/pages/products-page.js';
import { loadExamples } from '../../features/products/services/examples.js';
import { deleteProduct, setArchived } from '../../features/products/components/product-actions.js';
import { photoFromFile } from '../../features/products/use-cases/product-photo.js';
import { openBillView } from '../../features/receipts/components/bill-view.js';
import { downloadReceipt, shareReceipt, whatsappReceipt } from '../../features/receipts/services/receipt-output.js';
import { onPrint } from '../../features/printing/components/print-actions.js';
import { onDeliveryRefresh, onInvoiceLink, onRevokeLinks, onSend } from '../../features/delivery/components/send-actions.js';
import { renderReport, showTable } from '../../features/reports/pages/report-page.js';
import { exportCsv } from '../../features/reports/services/csv-export.js';
import { openReturn, renderReturnSheet, saveReturn } from '../../features/returns/components/return-sheet.js';
import { exAvail } from '../../features/returns/services/return-rules.js';
import { closeSheets, renderBill, renderBillSheet, updateBillTotals } from '../../features/sales/components/bill-panel.js';
import { addPicked, openPicker, renderPicker, setPickQty } from '../../features/sales/components/variant-picker.js';
import { renderGrid } from '../../features/sales/pages/sell-page.js';
import { addOne, availOf, removeLine, setLineQty } from '../../features/sales/services/cart.js';
import { unvoid } from '../../features/sales/use-cases/checkout.js';
import { openVoidForm, submitVoidForm, voidFormChange } from '../../features/sales/components/void-form.js';
import { setBillDiscount } from '../../features/sales/use-cases/discounts.js';
import { applyLineDiscount, lineDiscountInput, lineDiscountType, openLineDiscount } from '../../features/sales/components/discount-sheet.js';
import { cashFormChange, openCashForm, submitCashForm } from '../../features/finance/components/cash-form.js';
import { checkUnverified, loadUnmatched, resolveUnmatched } from '../../features/finance/components/reconcile-view.js';
import { completePayment, openPayment, payClosed, payInput, payIntent, payMode, payQuick, payRest, paySend, payVia } from '../../features/sales/components/payment-sheet.js';
import { openBook } from '../../features/finance/components/books-view.js';
import { enqueue, flushSbQueue } from '../../features/sync/services/outbox.js';
import { openSyncPanel, syncDiscard, syncNow, syncRetry } from '../../features/sync/components/sync-panel.js';
import { chooseSellingAt, deleteEventAction, eventStatusAction, openEventForm, openEventSummary, submitEventForm } from '../../features/events/components/events-view.js';
import { gstExport, gstMonthChosen, openGstView } from '../../features/reports/components/report-sections.js';
import { exportGstCsv } from '../../features/reports/services/gst-data.js';
import { exportSummaryCsv } from '../../features/reports/services/summary-export.js';
import { closeModal } from '../../shared/components/modal.js';
import { toast } from '../../shared/components/toast.js';
import { $, $$ } from '../../shared/dom.js';
import { addDays, dayKey } from '../../shared/formatting/dates.js';
import { saveCart, savePrefs, saveSettings } from '../../shared/state/persistence.js';
import { renderAll, setTab } from '../../shared/ui/render.js';
import { logger } from '../../shared/logging/logger.js';

/* Registered once at start-up (app/main.js). */
export function installDomEvents(){
  /* ================= events ================= */

  document.addEventListener("click",async e=>{
    const t=e.target;if(!t.closest)return;
    const sc=t.closest("[data-scan]");if(sc&&store.scan){scanAction(sc.dataset.scan);return}
    const re=t.closest("[data-repevent]");if(re){store.prefs.repEvent=re.dataset.repevent;store.showAllBills=false;savePrefs();closeModal();if(re.dataset.tab)setTab(re.dataset.tab);else renderReport();return}
    const tab=t.closest("[data-tab]");if(tab){closeModal();setTab(tab.dataset.tab);return}
    const tile=t.closest(".tile");if(tile){openPicker(tile.dataset.pid);return}
    // variant picker
    const cp=t.closest("[data-cellplus]");if(cp&&store.pick){const v=cp.dataset.cellplus;setPickQty(v,(store.pick.qty[v]||0)+1);return}
    const cm=t.closest("[data-cellminus]");if(cm&&store.pick){const v=cm.dataset.cellminus;setPickQty(v,(store.pick.qty[v]||0)-1);return}
    const pc=t.closest("[data-color]");if(pc&&store.pick){store.pick.color=pc.dataset.color;renderPicker();return}
    const addv=t.closest("[data-addv]");if(addv){addOne(addv.dataset.addv);store.sellQuery="";const si=$("#sellSearch");if(si)si.value="";renderGrid();return}
    if(t.matches("[data-scrim]")){if(t.matches("[data-paid]")){closeSheets();return}if(store.pick&&store.pick.target==="exchange"){store.pick=null;renderReturnSheet();return}store.retState=null;closeSheets();return}
    if(store.billImport&&t.closest("[data-billimp]")&&billImportClick(t))return;
    if(t.matches("[data-modal-scrim]")||t.closest("[data-modal-close]")){if(t.matches("[data-editor]")&&store.editor)return;if(t.matches("[data-billimp]")&&store.billImport)return;if(store.payState)payClosed();store.payState=null;store.lineDisc=null;store.syncOpen=false;store.evForm=null;store.cashForm=null;store.voidForm=null;closeModal();return}
    // sync panel
    const sr=t.closest("[data-syncretry]");if(sr){syncRetry(+sr.dataset.syncretry);return}
    const sd=t.closest("[data-syncdiscard]");if(sd){if(sd.dataset.confirm){syncDiscard(+sd.dataset.syncdiscard)}else{sd.dataset.confirm="1";sd.textContent="Tap again to discard"}return}
    if(t.closest("[data-edclose]")){store.editor=null;closeModal();return}
    // discounts and payment
    const pay=t.closest("[data-pay]");if(pay&&!pay.disabled){openPayment(pay.dataset.pay);return}
    const pm=t.closest("[data-paymode]");if(pm&&store.payState){payMode(pm.dataset.paymode);return}
    const prs=t.closest("[data-payrest]");if(prs&&store.payState){payRest(prs.dataset.payrest);return}
    const pq=t.closest("[data-payquick]");if(pq&&store.payState){payQuick(pq.dataset.payquick);return}
    const cf=t.closest("[data-cashform]");if(cf){openCashForm(cf.dataset.cashform);return}
    const ge=t.closest("[data-gstexp]");if(ge){gstExport(ge.dataset.gstexp);return}
    const um=t.closest("[data-unm]");if(um){resolveUnmatched(um.dataset.unm);return}
    const pvia=t.closest("[data-payvia]");if(pvia&&store.payState){payVia(pvia.dataset.payvia);return}
    const pi=t.closest("[data-payintent]");if(pi&&!pi.disabled&&store.payState){payIntent(pi.dataset.payintent);return}
    const ld=t.closest("[data-linedisc]");if(ld){openLineDiscount(+ld.dataset.linedisc);return}
    const ldt=t.closest("[data-ldtype]");if(ldt&&store.lineDisc){lineDiscountType(ldt.dataset.ldtype);return}
    const dty=t.closest("[data-disctype]");if(dty&&!dty.disabled){const d=store.disc||{value:""};setBillDiscount({type:dty.dataset.disctype,value:d.value});const w=dty.closest(".bp-foot"),id=w&&w.querySelector("[data-disc]")&&w.querySelector("[data-disc]").id;renderAll();if(store.billOpen)renderBillSheet();const i=id&&document.getElementById(id);if(i)i.focus();return}
    const bk=t.closest("[data-book]");if(bk){openBook(bk.dataset.book);return}
    const inc=t.closest("[data-inc]");if(inc){const c=store.cart[+inc.dataset.inc];if(c){if(availOf(c.v)<=0){toast("No more in stock.");return}c.q++;saveCart();renderAll()}return}
    const rl=t.closest("[data-rmline]");if(rl){removeLine(+rl.dataset.rmline);renderAll();if(store.billOpen&&store.cart.length)renderBillSheet();return}
    const dec=t.closest("[data-dec]");if(dec){const i=+dec.dataset.dec,c=store.cart[i];if(c){c.q--;if(c.q<=0)store.cart.splice(i,1);if(!store.cart.length)store.disc=null;saveCart();renderAll()}return}
    const den=t.closest("[data-density]");if(den){store.prefs.density=den.dataset.density;savePrefs();renderNav();renderGrid();return}
    const per=t.closest("[data-period]");if(per){store.prefs.period=per.dataset.period;if(per.dataset.period==="custom"&&!store.prefs.from){store.prefs.from=addDays(dayKey(Date.now()),-6);store.prefs.to=dayKey(Date.now())}store.showAllBills=false;savePrefs();renderReport();return}
    const tb=t.closest("[data-table]");if(tb){showTable[tb.dataset.table]=!showTable[tb.dataset.table];renderReport();return}
    // bills
    const bv=t.closest("[data-billview]");if(bv){closeSheets();openBillView(bv.dataset.billview);return}
    const bp=t.closest("[data-billpaper]");if(bp){const i=bp.dataset.billpaper.indexOf(":");openBillView(bp.dataset.billpaper.slice(i+1),bp.dataset.billpaper.slice(0,i));return}
    const pr=t.closest("[data-print]");if(pr){onPrint(pr.dataset.print);return}
    const pb=t.closest("[data-printbrowser]");if(pb){onPrint(pb.dataset.printbrowser,{browser:true});return}
    const dl=t.closest("[data-dlreceipt]");if(dl){downloadReceipt(dl.dataset.dlreceipt);return}
    const il=t.closest("[data-invlink]");if(il){onInvoiceLink(il.dataset.invlink);return}
    const ir=t.closest("[data-invrevoke]");if(ir){onRevokeLinks(ir.dataset.invrevoke);return}
    const dr=t.closest("[data-dlrefresh]");if(dr){onDeliveryRefresh(dr.dataset.dlrefresh);return}
    const snd=t.closest("[data-send]");if(snd&&!snd.disabled){const i=snd.dataset.send.indexOf(":");onSend(snd.dataset.send.slice(i+1),snd.dataset.send.slice(0,i));return}
    const sh=t.closest("[data-share]");if(sh){shareReceipt(sh.dataset.share);return}
    const wa=t.closest("[data-wa]");if(wa){whatsappReceipt(wa.dataset.wa);return}
    const us=t.closest("[data-undosale]");if(us){closeSheets();openVoidForm(us.dataset.undosale);return}
    const v=t.closest("[data-void]");if(v){openVoidForm(v.dataset.void);return}
    const uv=t.closest("[data-unvoid]");if(uv){closeModal();unvoid(uv.dataset.unvoid);return}
    const rt=t.closest("[data-return]");if(rt){openReturn(rt.dataset.return);return}
    // returns / exchanges
    const rtm=t.closest("[data-rtm]");if(rtm&&store.retState){const ln=+rtm.dataset.rtm;store.retState.q[ln]=Math.max(0,(store.retState.q[ln]||0)-1);renderReturnSheet();return}
    const rtp=t.closest("[data-rtp]");if(rtp&&store.retState){const ln=+rtp.dataset.rtp;store.retState.q[ln]=(store.retState.q[ln]||0)+1;renderReturnSheet();return}
    const rmo=t.closest("[data-rtmode]");if(rmo&&store.retState){store.retState.mode=rmo.dataset.rtmode;renderReturnSheet();return}
    const rpy=t.closest("[data-rtpay]");if(rpy&&store.retState){const [k,val]=rpy.dataset.rtpay.split(":");store.retState[k]=val;renderReturnSheet();return}
    const exm=t.closest("[data-exm]");if(exm&&store.retState){const i=+exm.dataset.exm,c=store.retState.newItems[i];if(c){c.q--;if(c.q<=0)store.retState.newItems.splice(i,1)}renderReturnSheet();return}
    const exp=t.closest("[data-exp]");if(exp&&store.retState){const c=store.retState.newItems[+exp.dataset.exp];if(c&&exAvail(c.v)>0)c.q++;renderReturnSheet();return}
    // events
    const evs=t.closest("[data-evsum]");if(evs){openEventSummary(evs.dataset.evsum);return}
    const eve=t.closest("[data-evedit]");if(eve){openEventForm(eve.dataset.evedit);return}
    const evc=t.closest("[data-evclose]");if(evc){eventStatusAction(evc.dataset.evclose,"closed");return}
    const evo=t.closest("[data-evopen]");if(evo){eventStatusAction(evo.dataset.evopen,"active");return}
    const evd=t.closest("[data-evdel]");if(evd){if(evd.dataset.confirm)deleteEventAction(evd.dataset.evdel);else{evd.dataset.confirm="1";evd.textContent="Tap again to delete"}return}
    const sat=t.closest("[data-sellat]");if(sat){chooseSellingAt(sat.dataset.sellat);return}
    // customers
    const cpk=t.closest("[data-custpick]");if(cpk){pickCustomer(cpk.dataset.custpick);return}
    const ch=t.closest("[data-custhist]");if(ch){openCustHistory(ch.dataset.custhist);return}
    const ced=t.closest("[data-custedit]");if(ced){editCustomerForm(ced.dataset.custedit);return}
    // stock
    const si=t.closest("[data-stockin]");if(si){openStockOp("in",si.dataset.stockin);return}
    const sv=t.closest("[data-stockview]");if(sv){store.stockView=sv.dataset.stockview;renderStock();return}
    const chs=t.closest("[data-choose]");if(chs){chosenProduct(chs.dataset.choose);return}
    // products
    const ep=t.closest("[data-editp]");if(ep){openEditor(ep.dataset.editp);return}
    const sk=t.closest("[data-stickers]");if(sk){openStickers(sk.dataset.stickers);return}
    const sa=t.closest("[data-stkact]");if(sa){stickerAction(sa.dataset.stkact);return}
    const sp=t.closest("[data-sellp]");if(sp){setTab("sell");openPicker(sp.dataset.sellp);return}
    const ar=t.closest("[data-archive]");if(ar){setArchived(ar.dataset.archive,true);return}
    const ua=t.closest("[data-unarchive]");if(ua){setArchived(ua.dataset.unarchive,false);return}
    const dp=t.closest("[data-delp]");if(dp){deleteProduct(dp.dataset.delp);return}
    const pv=t.closest("[data-prodview]");if(pv){store.prodView=pv.dataset.prodview;renderProducts();return}
    const gr=t.closest("[data-grouprev]");if(gr){openGroupPreview(gr.dataset.grouprev);return}
    const gg=t.closest("[data-groupgo]");if(gg){applyGroup(gg.dataset.groupgo);return}
    const gn=t.closest("[data-groupno]");if(gn){store.settings.groupDismissed=[...(store.settings.groupDismissed||[]),gn.dataset.groupno.toLowerCase()];saveSettings();enqueue({type:"settings"});flushSbQueue();closeModal();renderProducts();return}
    // product editor
    if(store.editor){
      const tc=t.closest("[data-tilecolor]");if(tc){store.editor.color=tc.dataset.tilecolor;renderEditor();return}
      const vr=t.closest("[data-valrm]");if(vr){const [i,j]=vr.dataset.valrm.split(":");edRemoveValue(+i,+j);return}
      const vn=t.closest("[data-valren]");if(vn){const [i,j]=vn.dataset.valren.split(":"),op=store.editor.opts[+i],cur=op&&op.v[+j];const x=cur!=null?prompt(`Rename ${cur} to:`,cur):null;if(x&&x.trim()&&x.trim()!==cur)edRenameValue(+i,+j,x);return}
      const or=t.closest("[data-optrm]");if(or){edRemoveOption(+or.dataset.optrm);return}
      const os=t.closest("[data-optsugg]");if(os){edAddOption(os.dataset.optsugg);return}
      const gn=t.closest("[data-edgen]");if(gn){edGenCode(gn.dataset.edgen);return}
      const ea=t.closest("[data-edact]");if(ea){edAction(ea.dataset.edact);return}
      const ps=t.closest("[data-preset]");if(ps){const [i,k]=ps.dataset.preset.split(":"),pr=SIZE_PRESETS[+k];if(pr)edAddValues(+i,pr[1]);return}
    }
    const actEl=t.closest("[data-act]");const act=actEl&&actEl.dataset.act;if(!act)return;
    switch(act){
      case "closesheet":if(store.pick&&store.pick.target==="exchange"){store.pick=null;renderReturnSheet();break}store.retState=null;closeSheets();break;
      case "openbill":store.billOpen=true;store.pick=null;renderBillSheet();break;
      case "addpicked":addPicked();break;
      case "newsale":closeSheets();{const s=$("#sellSearch");if(s&&window.innerWidth>=1000)s.focus()}break;
      case "clear":store.cart=[];store.disc=null;store.cartCust=null;saveCart();closeSheets();renderAll();break;
      case "paydone":completePayment();break;
      case "ldapply":applyLineDiscount(false);break;
      case "ldremove":applyLineDiscount(true);break;
      case "pickcust":openCustPicker();break;
      case "nocust":setBillCustomer(null);store.custForm=null;closeModal();renderAll();break;
      case "custnew":newCustomerForm("sell");break;
      case "custadd":newCustomerForm("page");break;
      case "custback":custBack();break;
      case "gosetup":setTab("products");break;
      case "examples":loadExamples();break;
      case "export":exportCsv();break;
      case "backup":downloadBackup();break;
      case "restorego":applyRestore();break;
      case "allbills":store.showAllBills=true;renderReport();break;
      case "stockin":openProductChooser("in");break;
      case "stockadj":openProductChooser("adjust");break;
      case "billimport":openBillImport();break;
      case "scan":openScanner();break;
      case "sosave":saveStockOp();break;
      case "rtsave":saveReturn();break;
      case "syncpanel":openSyncPanel();break;
      case "stockmore":store.stockHist.n+=50;renderStock();break;
      case "evnew":openEventForm(null);break;
      case "gstview":openGstView();break;
      case "gstcsv":exportGstCsv();break;
      case "verifyupi":checkUnverified(false);break;
      case "unmatched":loadUnmatched();break;
      case "sumcsv":exportSummaryCsv();break;
      case "syncnow":syncNow();break;
      case "exadd":openProductChooser("exchange");break;
      case "addp":openEditor(null);break;
      case "edsave":saveEditor();break;
    }
  });
  document.addEventListener("input",e=>{
    const t=e.target;
    if(t.matches("[data-cellqty]")&&store.pick){const v=t.dataset.cellqty;setPickQty(v,t.value===""?0:t.value);return}
    if(t.matches("[data-disc]")){setBillDiscount({type:store.disc&&store.disc.type,value:t.value});updateBillTotals();return}
    if(t.id==="ldVal"){lineDiscountInput(t.value);return}
    if(t.matches("[data-payf]")&&store.payState){payInput(t);return}
    if(t.id==="sellSearch"){store.sellQuery=t.value;renderGrid();return}
    if(t.id==="prodSearch"){store.prodQuery=t.value;renderProducts();return}
    if(t.id==="custSearch"){store.custPageQ=t.value;renderCustomerList();return}
    if(t.id==="custQ"){store.custQ=t.value;const pos=t.selectionStart;renderCustPicker();const i=$("#custQ");if(i){i.focus();i.setSelectionRange(pos,pos)}return}
    if(t.id==="chooseQ"){store.chooserQ=t.value;const pos=t.selectionStart;renderChooser();const i=$("#chooseQ");if(i){i.focus();i.setSelectionRange(pos,pos)}return}
    if(t.matches("[data-sov]")&&store.stockOp){store.stockOp.val[t.dataset.sov]=t.value;updateStockOp();return}
    if(store.billImport&&billImportInput(t))return;
    if(store.editor){
      if(t.dataset.ed){store.editor[t.dataset.ed]=t.value;if(t.dataset.ed==="price"||t.dataset.ed==="cost"){const k=t.dataset.ed;$$("#modalHost [data-edf='"+k+"']").forEach(i=>{i.placeholder=t.value})}return}
      if(t.dataset.edf&&t.dataset.k!=null){edFieldInput(t);return}
      if(t.id==="optAdd"){store.editor.addName=t.value;return}
    }
  });
  document.addEventListener("submit",e=>{
    if(e.target.id==="custForm"){e.preventDefault();saveCustomerForm(e.target);return}
    if(e.target.id==="edForm"){e.preventDefault();return}
    if(e.target.id==="evForm"){e.preventDefault();submitEventForm(e.target);return}
    if(e.target.id==="cashForm"){e.preventDefault();submitCashForm(e.target);return}
    if(e.target.id==="voidForm"){e.preventDefault();submitVoidForm(e.target);return}
  });
  document.addEventListener("change",async e=>{
    const t=e.target;
    if(t.id==="repFrom"||t.id==="repTo"){if(t.value){store.prefs[t.id==="repFrom"?"from":"to"]=t.value;store.prefs.period="custom";savePrefs();renderReport()}return}
    if(t.id==="sellCat"){store.sellCat=t.value;renderGrid();return}
    if(t.id==="sellAt"){chooseSellingAt(t.value);return}
    if(t.id==="shProd"||t.id==="shVar"||t.id==="shType"){const F=store.stockHist;if(F){if(t.id==="shProd"){F.pid=t.value;F.vid=""}else if(t.id==="shVar")F.vid=t.value;else F.type=t.value;F.n=30}renderStock();return}
    if(t.id==="prodCat"){store.prodCat=t.value;renderProducts();return}
    if(t.id==="rtReason"&&store.retState){store.retState.reason=t.value;return}
    if(t.matches("[data-rtnfr]")&&store.retState){store.retState.nfr[t.dataset.rtnfr]=t.checked;renderReturnSheet();return}
    if(t.matches("[data-rtkeep]")&&store.retState){store.retState.keepDisc=t.checked;renderReturnSheet();return}
    if(t.matches("[data-rtprov]")&&store.retState){store.retState.provRefund=t.checked;return}
    if(t.matches("[data-paysend]")&&store.payState){paySend(t.checked);return}
    if(t.id==="gstMonth"){gstMonthChosen(t.value);return}
    if(t.closest&&t.closest("#voidForm")&&t.name==="reason"){voidFormChange(t.form);return}
    if(t.closest&&t.closest("#cashForm")&&(t.name==="day"||t.name==="scope")){cashFormChange(t.form);return}
    if(t.id==="rtRef"&&store.retState){store.retState.collectRef=t.value;return}
    if(t.id==="rtLast4"&&store.retState){store.retState.collectLast4=t.value.replace(/\D/g,"").slice(0,4);return}
    if(t.id==="soReason"&&store.stockOp){store.stockOp.reason=t.value;return}
    if(t.id==="soNote"&&store.stockOp){store.stockOp.note=t.value;return}
    if(t.id==="soCost"&&store.stockOp){store.stockOp.cost=t.value;return}
    if(t.id==="soSetCost"&&store.stockOp){store.stockOp.setCost=t.checked;return}
    if(t.matches("[data-disc]")){renderBill();return}
    if(t.matches("[data-restore]")){const f=t.files&&t.files[0];t.value="";if(f)await restoreBackup(f);return}
    if(t.matches("[data-lineqty]")){const r=setLineQty(+t.dataset.lineqty,t.value);if(!r.ok&&r.message)toast(r.message);t.blur();renderAll();if(store.billOpen)renderBillSheet();return}
    if(t.matches("#custForm [name=type]")){custFormType(t.form);return}
    if(store.stickers&&stickerChange(t))return;
    if(store.billImport&&await billImportChange(t))return;
    if(store.editor){
      const tg=t.dataset.edtoggle;if(tg){if(tg==="hasOpts")edToggleOptions(t.checked);else{store.editor.codesOn=t.checked;edFocusKeep(renderEditor)}return}
      if(t.matches("[data-edcode]")){store.editor.code=t.value==="qr"?"qr":"barcode";renderEditor();return}
      if(t.dataset.edf==="active"){const c=store.editor.cells[t.dataset.k];if(c){c.active=t.checked;const tr=t.closest("tr");if(tr)tr.classList.toggle("off",!t.checked)}return}
      if(t.matches("[data-edsel]")){store.editor.sel[t.dataset.edsel]=t.checked;edFocusKeep(renderEditor);return}
      if(t.matches("[data-edselall]")){edCombos().forEach(x=>{store.editor.sel[x.key]=t.checked});renderEditor();return}
      if(t.dataset.optname!=null){edRenameOption(+t.dataset.optname,t.value);return}
      if(t.dataset.valadd!=null&&t.value.trim()){const v=t.value,i=+t.dataset.valadd;t.value="";setTimeout(()=>edAddValues(i,v),0);return}
      if(t.matches("[data-edphoto]")){const f=t.files&&t.files[0];if(!f)return;try{store.editor.img=await photoFromFile(f);renderEditor()}catch(err){logger.warn("Photo read failed:",err);toast("Couldn't read that photo. Try a JPG or PNG.")}return}
    }
  });
}
