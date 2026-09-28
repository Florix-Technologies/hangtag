const H=require('../helpers/env.cjs');
// The 15 acceptance tests from the brief, driven through the real UI where it matters.
const puppeteer=require('puppeteer-core');const fs=require('fs');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let fails=0;const check=(name,ok,info)=>{if(!ok)fails++;console.log((ok?'PASS ':'FAIL ')+name+(info!==undefined?'  '+JSON.stringify(info):''))};
const html=H.indexHtml();
const hooked=H.hookedHtml();
const SHOT=H.ARTIFACTS+'/';
async function page(ctx,w=1280,h=900,seed){
  const p=await ctx.newPage();await p.setViewport({width:w,height:h});
  p.on('pageerror',e=>{fails++;console.log('[pageerror]',e.message)});
  p.on('console',m=>{if(m.type()==='error'&&!/Failed to load resource/.test(m.text())){fails++;console.log('[console.error]',m.text())}});
  if(seed)await p.evaluateOnNewDocument(s=>{if(location.hostname==='localhost'&&!sessionStorage.__s){sessionStorage.__s=1;for(const [k,v] of Object.entries(s))localStorage.setItem(k,v)}},seed);
  await p.setRequestInterception(true);
  p.on('request',r=>{const u=r.url();if(u==='http://localhost:3210/')r.respond({status:200,contentType:'text/html',body:hooked});else if(u.includes('supabase.co'))r.abort();else r.continue()});
  await p.goto('http://localhost:3210/',{waitUntil:'domcontentloaded'});await sleep(700);
  await p.evaluate(()=>__ev('hideGate();hideSetup();renderAll()'));
  return p;
}
const run=(p,b,a)=>p.evaluate((b,a)=>__ev('(async(arg)=>{'+b+'})')(a),b,a===undefined?null:a);
const vis=(p,sel)=>p.$eval(sel,e=>!e.hidden&&getComputedStyle(e).display!=="none"&&e.getClientRects().length>0).catch(()=>false);
const txt=(p,sel)=>p.$eval(sel,e=>e.textContent.trim()).catch(()=>null);
async function type(p,sel,v){await p.$eval(sel,e=>{e.value=''});await p.type(sel,String(v))}
const vid=(c,s)=>`const p=products().find(x=>x.name==="Street Tee");return p.variants.find(v=>v.o[0]===${JSON.stringify(c)}&&v.o[1]===${JSON.stringify(s)}).id`;
(async()=>{
  await H.ensureServer();
  const browser=await puppeteer.launch({executablePath:H.CHROME,headless:true});
  try{
    const ctx=await browser.createBrowserContext();const A=await page(ctx);
    // ---------------- TEST 1: 4 colours x 5 sizes = 20 variants, created in the editor UI ----------------
    await A.click('[data-tab="products"]');await sleep(200);
    await A.click('.ptools [data-act="addp"]');await sleep(200);
    await type(A,'#edName','Street Tee');
    await type(A,'[data-ed="price"]','599');await type(A,'[data-ed="cost"]','320');await type(A,'[data-ed="cat"]','T-shirts');
    await A.click('[data-edtoggle="hasOpts"]');await sleep(150);
    await A.type('#optAdd','Colour');await A.keyboard.press('Enter');await sleep(150);   // option 1: typed name
    for(const c of ['Black','White','Navy','Red']){await A.type('[data-valadd="0"]',c);await A.keyboard.press('Enter');await sleep(80)}
    await A.click('[data-optsugg="Size"]');await sleep(150);                            // option 2: a suggested name
    await A.$eval('[data-preset="1:0"]',b=>b.scrollIntoView({block:"center"}));
    await A.click('[data-preset="1:0"]');await sleep(150);      // S–XXL
    const n1=await run(A,'return edCombos().length');
    check('TEST 1: 4 colours × 5 sizes → 20 variant cells in the editor',n1===20,n1);
    // ---------------- TEST 2: a different stock for every variant, typed into the matrix ----------------
    const inputs=await A.$$('.vdet [data-edf="stock"]');
    for(let i=0;i<inputs.length;i++){await inputs[i].evaluate(e=>e.scrollIntoView({block:"center"}));await inputs[i].click({count:3});await inputs[i].type(String(i+1))}
    check('TEST 2: summary shows 20 variants · 210 pieces',/20 variants · 210 pieces/.test((await txt(A,'.edsum span'))||''),await txt(A,'.edsum span'));
    await A.screenshot({path:SHOT+'t12_editor.png'});
    await A.click('[data-act="edsave"]');await sleep(300);
    const st=await run(A,`const p=products().find(x=>x.name==="Street Tee");return {n:p.variants.length,stocks:p.variants.map(v=>stockOf(v.id))}`);
    check('TEST 1: saved product has 20 variants',st.n===20,st.n);
    check('TEST 2: every variant kept its own stock (1…20)',JSON.stringify(st.stocks)===JSON.stringify(Array.from({length:20},(_,i)=>i+1)),st.stocks);
    const ids={BL:await run(A,vid('Black','L')),BXL:await run(A,vid('Black','XL')),WM:await run(A,vid('White','M'))};
    const before=await run(A,'return Object.fromEntries(products().find(x=>x.name==="Street Tee").variants.map(v=>[v.id,stockOf(v.id)]))');
    // ---------------- TEST 3 + 4: one picker interaction, mixed variants ----------------
    await A.click('[data-tab="sell"]');await sleep(200);
    const pid=await run(A,'return products().find(x=>x.name==="Street Tee").id');
    await A.click(`.tile[data-pid="${pid}"]`);await sleep(200);
    await A.click(`[data-cellplus="${ids.BL}"]`);await A.click(`[data-cellplus="${ids.BL}"]`);   // Black L x2 by tapping
    await A.click(`[data-cellplus="${ids.BXL}"]`);                                              // Black XL x1
    await A.click(`[data-cellqty="${ids.WM}"]`,{count:3});await A.keyboard.type('3');         // White M x3 typed
    await sleep(100);
    check('TEST 3: picker summary 6 pieces · ₹3,594',/6 pieces · ₹3,594/.test(await txt(A,'#pickSum')||''),await txt(A,'#pickSum'));
    await A.screenshot({path:SHOT+'t12_picker.png'});
    await A.click('#addPickBtn');await sleep(200);
    const lines=await run(A,'return cart.map(c=>[c.c,c.s,c.q])');
    check('TEST 4: bill keeps separate lines for each variant',JSON.stringify(lines)===JSON.stringify([["Black","L",2],["Black","XL",1],["White","M",3]]),lines);
    check('TEST 4: bill shows colour / size on each line',(await A.$$eval('#billPanel .li .szl',x=>x.map(e=>e.textContent))).join("|")==="Black / L|Black / XL|White / M");
    await A.keyboard.press('c');await sleep(300);   // pay cash with the shortcut: the payment screen opens on Cash
    check('C opens the payment screen with Cash chosen',await vis(A,'#paySheet')&&(await A.$eval('#paySheet [data-paymode="cash"]',b=>b.getAttribute('aria-pressed')))==='true');
    await A.keyboard.press('Enter');await sleep(400);   // Enter completes the sale
    check('checkout by keyboard shows Payment successful',await vis(A,'#sheetHost [data-paid]'));
    await A.keyboard.press('Enter');await sleep(150);
    const after=await run(A,'return Object.fromEntries(products().find(x=>x.name==="Street Tee").variants.map(v=>[v.id,stockOf(v.id)]))');
    const changed=Object.keys(after).filter(k=>after[k]!==before[k]).map(k=>[k===ids.BL?"BL":k===ids.BXL?"BXL":k===ids.WM?"WM":k,before[k]-after[k]]);
    check('TEST 3: only Black/L −2, Black/XL −1, White/M −3 changed',JSON.stringify(changed.sort())===JSON.stringify([["BL",2],["BXL",1],["WM",3]].sort()),changed);
    const sid=await run(A,'return D().sales[D().sales.length-1].id');
    // ---------------- TEST 5: return Black/L x1 ----------------
    const bl0=await run(A,`return stockOf(${JSON.stringify(ids.BL)})`);
    await run(A,`openBillView(${JSON.stringify(sid)})`);await sleep(150);
    await A.click(`[data-return="${sid}"]`);await sleep(150);
    await A.click('[data-rtp="0"]');await sleep(100);
    await A.screenshot({path:SHOT+'t12_return.png'});
    await A.click('[data-act="rtsave"]');await sleep(200);
    check('TEST 5: Black/L back by exactly 1',(await run(A,`return stockOf(${JSON.stringify(ids.BL)})`))===bl0+1);
    // over-return blocked
    await run(A,`openReturn(${JSON.stringify(sid)})`);await sleep(100);
    for(let k=0;k<3;k++){const b=await A.$('[data-rtp="0"]');if(b&&!(await b.evaluate(x=>x.disabled)))await b.click();await sleep(60)}
    const plusDisabled=await A.$eval('[data-rtp="0"]',b=>b.disabled);
    check('TEST 5: can\'t return more than bought and not already returned (1 left of Black/L)',plusDisabled===true&&(await run(A,'return retState.q[0]'))===1);
    await run(A,'retState=null;closeSheets()');
    // ---------------- TEST 6: exchange Black/L -> Black/XL ----------------
    const L0=await run(A,`return stockOf(${JSON.stringify(ids.BL)})`),XL0=await run(A,`return stockOf(${JSON.stringify(ids.BXL)})`);
    await run(A,`openReturn(${JSON.stringify(sid)})`);await sleep(100);
    await A.click('[data-rtmode="exchange"]');await sleep(100);
    await A.click('[data-rtp="0"]');await sleep(80);
    await A.click('[data-act="exadd"]');await sleep(150);
    await A.click(`[data-choose="${pid}"]`);await sleep(150);
    await A.click(`[data-cellplus="${ids.BXL}"]`);await A.click('#addPickBtn');await sleep(150);
    check('TEST 6: exchange shows Even exchange ₹0',/Even exchange/.test(await txt(A,'.retsheet .rt-sum')||''),await txt(A,'.retsheet .rt-sum'));
    await A.screenshot({path:SHOT+'t12_exchange.png'});
    await A.click('[data-act="rtsave"]');await sleep(300);
    const L1=await run(A,`return stockOf(${JSON.stringify(ids.BL)})`),XL1=await run(A,`return stockOf(${JSON.stringify(ids.BXL)})`);
    check('TEST 6: Black/L +1, Black/XL −1',L1===L0+1&&XL1===XL0-1,{L0,L1,XL0,XL1});
    const ex=await run(A,'const r=Object.values(returnsMap).find(r=>r.kind==="exchange");const s=D().sales.find(s=>s.ex===r.ex);return {r:!!r,s:!!s,credit:s&&s.credit,refund:r&&r.refund,link:r&&r.sale}');
    check('TEST 6: exchange recorded as a return + new bill linked to the original (not delete-and-recreate)',ex.r&&ex.s&&ex.credit===599&&ex.refund===0&&ex.link===sid,ex);
    await run(A,'closeSheets()');
    // exchange to a pricier item collects the difference
    await run(A,`openReturn(${JSON.stringify(sid)});retState.mode="exchange";retState.q[2]=1;const p=products().find(x=>x.name==="Street Tee");const v=p.variants.find(v=>v.o[0]==="Navy"&&v.o[1]==="M");v.price=699;addToLines(retState.newItems,v.id,1);renderReturnSheet()`);
    check('exchange to a ₹699 item: customer pays ₹100',/Customer pays\s*₹100/.test((await txt(A,'.retsheet .rt-sum'))||''),await txt(A,'.retsheet .rt-sum'));
    await run(A,'closeSheets();retState=null;const p=products().find(x=>x.name==="Street Tee");p.variants.find(v=>v.o[0]==="Navy"&&v.o[1]==="M").price=null;');
    // ---------------- TEST 7 + 8: change price and cost after the sale ----------------
    const rec0=await run(A,`return receiptText(D().saleById[${JSON.stringify(sid)}])`);
    const gp0=await run(A,`const l=netLines([D().saleById[${JSON.stringify(sid)}]],[]);return l.reduce((a,x)=>a+x.rev-(x.cost||0),0)`);
    await run(A,`const p=products().find(x=>x.name==="Street Tee");p.price=799;p.cost=500;saveCatalog();renderAll()`);
    const rec1=await run(A,`return receiptText(D().saleById[${JSON.stringify(sid)}])`);
    const gp1=await run(A,`const l=netLines([D().saleById[${JSON.stringify(sid)}]],[]);return l.reduce((a,x)=>a+x.rev-(x.cost||0),0)`);
    check('TEST 7: old bill still shows ₹599 after the price changed to ₹799',rec0===rec1&&/× 2 = ₹1,198/.test(rec1),rec1.split("\n").slice(4,7));
    check('TEST 8: old gross profit unchanged after the cost changed',gp0===gp1&&Math.round(gp0)===Math.round(6*(599-320)),{gp0,gp1});
    await run(A,`const p=products().find(x=>x.name==="Street Tee");p.price=599;p.cost=320;saveCatalog()`);
    // ---------------- TEST 13: low stock names the exact variant ----------------
    await run(A,`settings.lowStock=3;saveSettings();setTab("stock")`);await sleep(200);
    const alerts=await A.$$eval('#stockBody .alerts .al',x=>x.map(e=>e.textContent.replace(/\s+/g," ").trim()));
    check('TEST 13: low-stock warning names product / colour / size',alerts.some(a=>/^Street Tee\s*Black \/ S\s*\d+ left$/.test(a))&&alerts.some(a=>/^Street Tee\s*Black \/ M\s*\d+ left$/.test(a)),alerts.slice(0,4));
    await A.screenshot({path:SHOT+'t12_stock.png',fullPage:true});
    // stock in and adjustment through the UI
    await A.click('.vh-acts [data-act="stockin"]');await sleep(150);
    await A.click(`[data-choose="${pid}"]`);await sleep(150);
    const bxlIn=await run(A,`return stockOf(${JSON.stringify(ids.BXL)})`);
    await A.type(`[data-sov="${ids.BXL}"]`,'50');await A.type('#soCost','320');await A.type('#soNote','Invoice 42');
    await A.click('#soSave');await sleep(200);
    check('Stock in: Black/XL +50 with cost and note recorded',(await run(A,`return stockOf(${JSON.stringify(ids.BXL)})`))===bxlIn+50&&(await run(A,'const m=Object.values(moves).sort((a,b)=>b.t-a.t)[0];return m.type+"|"+m.q+"|"+m.cost+"|"+m.note'))==="RESTOCK|50|320|Invoice 42");
    await A.click('.vh-acts [data-act="stockadj"]');await sleep(150);await A.click(`[data-choose="${pid}"]`);await sleep(150);
    const cur=await run(A,`return stockOf(${JSON.stringify(ids.BXL)})`);
    await A.click(`[data-sov="${ids.BXL}"]`,{count:3});await A.keyboard.type(String(cur-1));await A.select('#soReason','Damaged');
    await A.click('#soSave');await sleep(200);
    check('Adjustment: −1 with reason recorded, never silent',(await run(A,`return stockOf(${JSON.stringify(ids.BXL)})`))===cur-1&&(await run(A,'const m=Object.values(moves).sort((a,b)=>b.t-a.t)[0];return m.type+"|"+m.q+"|"+m.note'))==="ADJUST|-1|Damaged");
    // ---------------- TEST 14: SKU / barcode / words search, and a scanner ----------------
    await run(A,`const p=products().find(x=>x.name==="Street Tee");p.variants.find(v=>v.o[0]==="Red"&&v.o[1]==="XL").sku="ST-RED-XL";p.variants.find(v=>v.o[0]==="Red"&&v.o[1]==="XL").bc="8900000000123";saveCatalog();setTab("sell")`);await sleep(150);
    await A.click('#sellSearch');await A.keyboard.type('red xl');await sleep(150);
    check('TEST 14: "red xl" finds Street Tee / Red / XL',/Street Tee.*Red \/ XL/.test((await txt(A,'#sellHits'))||''),await txt(A,'#sellHits'));
    await A.$eval('#sellSearch',e=>e.value='');await A.type('#sellSearch','ST-RED-XL');await sleep(100);
    const hits=await A.$$eval('#sellHits .hit-row',x=>x.length);
    check('TEST 14: SKU finds exactly that variant',hits===1&&/Red \/ XL/.test(await txt(A,'#sellHits')));
    await run(A,'cart=[];saveCart();renderAll()');
    await A.keyboard.press('Enter');await sleep(200);
    check('TEST 14: Enter on the SKU adds it to the bill',JSON.stringify(await run(A,'return cart.map(c=>[c.c,c.s,c.q])'))==='[["Red","XL",1]]');
    await A.evaluate(()=>{document.activeElement.blur()});
    for(const ch of '8900000000123'){await A.keyboard.press(ch,{delay:0})}await A.keyboard.press('Enter');await sleep(250);
    check('TEST 14: a barcode scanner (fast keys + Enter) adds the exact variant',JSON.stringify(await run(A,'return cart.map(c=>[c.c,c.s,c.q])'))==='[["Red","XL",2]]',await run(A,'return cart.map(c=>[c.c,c.s,c.q])'));
    check('scanner keys did not open a product by shortcut',!(await vis(A,'#sheetHost .picker')));
    // keyboard shortcuts still work when typed at human speed
    await run(A,'cart=[];saveCart();renderAll()');await A.evaluate(()=>{document.activeElement.blur()});
    const idx=await run(A,'return sellProducts().findIndex(p=>p.name==="Street Tee")+1');
    await A.keyboard.press(String(idx%10));await sleep(200);
    check('keyboard: product number opens the picker',await vis(A,'#sheetHost .picker'));
    await A.keyboard.press('3');await sleep(60);await A.keyboard.press('+');await sleep(60);await A.keyboard.press('Enter');await sleep(200);
    check('keyboard: size number + quantity + Enter adds',JSON.stringify(await run(A,'return cart.map(c=>[c.c,c.s,c.q])'))==='[["Black","L",2]]',await run(A,'return cart.map(c=>[c.c,c.s,c.q])'));
    await A.keyboard.press('u');await sleep(300);await A.keyboard.press('Escape');await sleep(100);
    // ---------------- TEST 9: archive ----------------
    const billsBefore=await run(A,'return D().sales.length');
    await run(A,`setArchived(${JSON.stringify(pid)},true)`);await sleep(100);
    check('TEST 9: archived product gone from the Sell grid',!(await A.$(`.tile[data-pid="${pid}"]`)));
    await A.$eval('#sellSearch',e=>e.value='');await A.type('#sellSearch','ST-RED-XL');await sleep(100);
    check('TEST 9: archived product not found by search or scan',(await A.$$('#sellHits .hit-row')).length===0&&(await run(A,'return findByCode("8900000000123")'))===null);
    await run(A,`openPicker(${JSON.stringify(pid)})`);
    check('TEST 9: no new sale possible (picker refuses)',!(await vis(A,'#sheetHost .picker')));
    check('TEST 9: its bills are intact',(await run(A,'return D().sales.length'))===billsBefore&&(await run(A,`return !!receiptText(D().saleById[${JSON.stringify(sid)}])`)));
    await run(A,`setArchived(${JSON.stringify(pid)},false)`);
    await A.$eval('#sellSearch',e=>e.value='');await run(A,'sellQuery="";renderGrid()');
    // ---------------- TEST 15: product totals = sum of variant lines ----------------
    await run(A,'prefs.period="all";setTab("report")');await sleep(300);
    const t15=await run(A,`const R=periodRange(),d=periodData(R.from,R.to),L=netLines(d.live,d.rets);const byP={},byV={};L.forEach(l=>{byP[l.pid]=(byP[l.pid]||0)+l.q;byV[l.vid]=(byV[l.vid]||0)+l.q});const p=products().find(x=>x.name==="Street Tee");const sumV=p.variants.reduce((a,v)=>a+(byV[v.id]||0),0);const K=kstats(d.live,d.rets);return {prod:byP[p.id],sumV,netPcs:K.pcs,linePcs:L.reduce((a,l)=>a+l.q,0),rev:K.rev,lineAmt:Math.round(L.reduce((a,l)=>a+l.amt,0))}`);
    check('TEST 15: product total = sum of its variants',t15.prod===t15.sumV,t15);
    check('TEST 15: pieces and sales in the KPIs = sum of all lines (net of returns)',t15.netPcs===t15.linePcs&&t15.rev===t15.lineAmt,t15);
    await A.screenshot({path:SHOT+'t12_report.png',fullPage:true});
    const profitTxt=await txt(A,'.gp');
    check('Reports: gross profit card shows sales, cost, profit and margin',/Gross profit/.test(profitTxt||'')&&/%/.test(profitTxt||''),profitTxt);
    // ---------------- receipts ----------------
    await run(A,`openBillView(${JSON.stringify(sid)})`);await sleep(150);
    const prev=await txt(A,'.rcpt-prev');
    check('receipt shows shop, bill number, colour / size and payment',/Bill/.test(prev)&&/Black \/ L/.test(prev)&&/Paid/.test(prev),prev.slice(0,120));
    await A.click(`.billview [data-print="${sid}"]`);await sleep(400);
    check('Print makes a print-only page (no app UI in it)',await A.evaluate(()=>{const f=[...document.querySelectorAll('iframe')].pop();return !!(f&&f.contentDocument.querySelector('.rcpt')&&!f.contentDocument.querySelector('.appbar'))}));
    const waUrl=await A.evaluate(()=>{let u=null;const o=window.open;window.open=x=>{u=x;return {}};document.querySelector('.billview [data-send^="whatsapp:"]').click();window.open=o;return u});
    check('WhatsApp opens wa.me with the bill text',/^https:\/\/wa\.me\/\?text=/.test(waUrl||'')&&decodeURIComponent(waUrl).includes('Street Tee (Black / L) × 2 = ₹1,198'),waUrl&&waUrl.slice(0,60));
    await run(A,'closeModal()');
    // ---------------- customers ----------------
    await run(A,'setTab("sell")');await A.click('[data-act="pickcust"]');await sleep(150);
    await A.click('[data-act="custnew"]');await sleep(100);
    await A.type('#custForm [name=name]','Meera Shah');await A.type('#custForm [name=phone]','9812345678');
    await A.click('#custForm [type=submit]');await sleep(150);
    check('customer added to the bill',/Meera Shah/.test(await txt(A,'#billPanel .custline')||''));
    await run(A,`addOne(${JSON.stringify(ids.WM)})`);await A.click('#billPanel [data-pay="upi"]');await sleep(200);await A.click('#payDone');await sleep(300);
    const cs=await run(A,'const s=D().sales[D().sales.length-1];return s.cust&&s.cust.name');
    check('bill carries the customer',cs==='Meera Shah');
    await A.keyboard.press('Escape');
    await run(A,'const c=Object.values(customers).find(c=>c.name==="Meera Shah");openCustHistory(c.id)');await sleep(100);
    check('customer history lists the bill and total',/1\s*Total spent\s*₹599/.test((await txt(A,'.custsheet .tmini'))||'')||/Bills\s*1/.test((await txt(A,'.custsheet .tmini'))||''),await txt(A,'.custsheet .tmini'));
    await run(A,'closeModal()');
    // ---------------- TEST 11: backup and restore into an empty account ----------------
    const backup=await run(A,'return JSON.stringify({app:"hangtag",version:3,exportedAt:new Date().toISOString(),profile,settings,catalog,images:imgs,days:Object.assign({},remoteDays,localDays),moves,returns:returnsMap,customers})');
    const snap=await run(A,'return {p:products().length,v:products().reduce((a,p)=>a+p.variants.length,0),stock:products().map(p=>p.variants.map(v=>stockOf(v.id)).join(",")).join("|"),bills:D().sales.length,rets:Object.keys(returnsMap).length,cust:Object.keys(customers).length}');
    const ctx2=await browser.createBrowserContext();const B=await page(ctx2);
    check('empty account starts empty',(await run(B,'return products().length'))===0);
    await run(B,'const f=new File([arg],"b.json",{type:"application/json"});await restoreBackup(f)',backup);await sleep(150);
    check('TEST 11: restore shows a preview first and changes nothing yet',await vis(B,'#modalHost [data-act="restorego"]')&&(await run(B,'return products().length'))===0);
    await B.click('#modalHost [data-act="restorego"]');await sleep(300);
    const snap2=await run(B,'return {p:products().length,v:products().reduce((a,p)=>a+p.variants.length,0),stock:products().map(p=>p.variants.map(v=>stockOf(v.id)).join(",")).join("|"),bills:D().sales.length,rets:Object.keys(returnsMap).length,cust:Object.keys(customers).length}');
    check('TEST 11: products, variants, stock, bills, returns and customers all survive',JSON.stringify(snap)===JSON.stringify(snap2),{snap,snap2});
    await run(B,'const f=new File(["{not json"],"x.json");await restoreBackup(f)');
    check('restore rejects a broken file without touching data',(await run(B,'return products().length'))===snap.p);
    await ctx2.close();
    // ---------------- TEST 12: migrating old size-only data keeps stock and sales ----------------
    const old={rc_catalog:JSON.stringify({example:false,products:[{id:"p1",name:"Oversized Tee – Black",price:599,color:"#1B1E24",sizes:[{s:"S",stock:10},{s:"XL",stock:10}]},{id:"p2",name:"Oversized Tee – White",price:599,color:"#ECEAE3",sizes:[{s:"M",stock:8}]}]}),
      rc_local:JSON.stringify({"2026-09-20_d1_0":{date:"2026-09-20",dev:"d1",chunk:0,sales:[{id:"s1",t:Date.parse("2026-09-20T10:00:00"),items:[{p:"p1",n:"Oversized Tee – Black",s:"XL",q:6,price:599},{p:"p2",n:"Oversized Tee – White",s:"M",q:1,price:599}],sub:4193,disc:0,total:4193,pay:"cash",dev:"d1"}],voids:[]}})};
    const ctx3=await browser.createBrowserContext();const M=await page(ctx3,1280,900,old);
    const mig=await run(M,'return {v:catalog.version,xl:stockOf("p1:XL"),s:stockOf("p1:S"),m:stockOf("p2:M"),opening:Object.values(moves).filter(m=>m.type==="OPENING").reduce((a,m)=>a+m.q,0)}');
    check('TEST 12: old catalog migrated in the app (now v3, any options) (XL 10−6=4, S 10, White M 8−1=7)',mig.v===3&&mig.xl===4&&mig.s===10&&mig.m===7&&mig.opening===28,mig);
    const oldRep=await run(M,'prefs.period="all";const R=periodRange(),d=periodData(R.from,R.to),K=kstats(d.live,d.rets);return {rev:K.rev,pcs:K.pcs}');
    check('TEST 12: old sales totals unchanged (₹4,193 · 7 pieces)',oldRep.rev===4193&&oldRep.pcs===7,oldRep);
    await run(M,'setTab("products")');await sleep(150);
    check('TEST 12: "Oversized Tee – Black / – White" offered for review, not merged automatically',/Oversized Tee/.test((await txt(M,'.grp'))||'')&&(await run(M,'return products().length'))===2);
    await M.click('[data-grouprev="Oversized Tee"]');await sleep(100);await M.click('[data-groupgo="Oversized Tee"]');await sleep(200);
    const merged=await run(M,'const p=products()[0];return {n:products().length,name:p.name,colors:p.opts[0]&&p.opts[0].v,xl:stockOf("p1:XL"),m:stockOf("p2:M"),blackXL:p.variants.find(v=>v.id==="p1:XL").o[0]}');
    check('TEST 12: after confirming, one product with colours and the same stock',merged.n===1&&merged.name==="Oversized Tee"&&JSON.stringify(merged.colors)==='["Black","White"]'&&merged.xl===4&&merged.m===7&&merged.blackXL==="Black",merged);
    const rep2=await run(M,'const R=periodRange(),d=periodData(R.from,R.to),L=netLines(d.live,d.rets),K=kstats(d.live,d.rets);return {rev:K.rev,pcs:K.pcs,prods:[...new Set(L.map(l=>l.pid))],billText:receiptText(d.all[0]).includes("Oversized Tee – Black")}');
    check('TEST 12: reports keep the same totals, now under one product; old bill text unchanged',rep2.rev===4193&&rep2.pcs===7&&rep2.prods.length===1&&rep2.billText,rep2);
    await ctx3.close();
    // ---------------- TEST 10: two accounts on one device stay apart ----------------
    const ctx4=await browser.createBrowserContext();const U=await page(ctx4);
    await run(U,'LS.set("hangtag_data_owner","userA");loadExamples();');
    const aP=await run(U,'return products().length');
    await run(U,'switchLocalDataTo("userB");loadUserState()');
    check('TEST 10: account B starts empty on the same device',(await run(U,'return products().length+Object.keys(moves).length+D().sales.length'))===0);
    await run(U,'switchLocalDataTo("userA");loadUserState()');
    check('TEST 10: account A gets its products and stock back',(await run(U,'return products().length'))===aP&&(await run(U,'return Object.keys(moves).length'))>0);
    await ctx4.close();
    // ---------------- mobile ----------------
    const ctx5=await browser.createBrowserContext();const P=await page(ctx5,375,780);
    await run(P,'loadExamples()');await sleep(100);
    const over=async()=>await P.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth+1);
    check('mobile: Sell fits',!(await over()));
    await P.click('.tile[data-pid="p1"]');await sleep(200);
    check('mobile: picker uses colour chips + one row of sizes',await vis(P,'#sheetHost .vchips')&&!(await over()));
    await P.screenshot({path:SHOT+'t12_m_picker.png'});
    await P.click('[data-color="White"]');await sleep(100);
    check('mobile: switching colour shows that colour\'s sizes',(await P.$$eval('#sheetHost [data-cellplus]',x=>x.map(b=>b.dataset.cellplus))).every(id=>/White/.test(id)));
    await run(P,'closeSheets();setTab("stock")');await sleep(150);check('mobile: Stock fits (matrix scrolls inside its card)',!(await over()));
    await P.screenshot({path:SHOT+'t12_m_stock.png',fullPage:true});
    await run(P,'setTab("products");openEditor("p1")');await sleep(200);check('mobile: product editor fits',!(await over()));
    await P.screenshot({path:SHOT+'t12_m_editor.png'});
    await run(P,'editor=null;closeModal();prefs.period="all";setTab("report")');await sleep(200);check('mobile: Reports fit',!(await over()));
    await ctx5.close();
  }finally{await browser.close()}
  console.log(fails?`\n${fails} FAILED`:'\nALL PASSED');process.exit(fails?1:0);
})();
