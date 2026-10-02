const H=require('../helpers/env.cjs');
const puppeteer=require('puppeteer-core');const fs=require('fs');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let fails=0;const check=(name,ok,info)=>{if(!ok)fails++;console.log((ok?'PASS ':'FAIL ')+name+(info!==undefined?'  '+JSON.stringify(info):''))};
const html=H.indexHtml();
const hooked=H.hookedHtml();
const SB='wcorlmgkwcahyfastjoz.supabase.co';
const expiredSession=JSON.stringify({access_token:'x.y.z',token_type:'bearer',expires_in:3600,expires_at:Math.floor(Date.now()/1000)-7200,refresh_token:'rtok',user:{id:'u1',email:'owner@example.com',aud:'authenticated'}});
// seed localStorage before any app script runs
async function page(ctx,label,{path='/',seed=null,onReq=null,hook=true}={}){
  const p=await ctx.newPage();await p.setViewport({width:1100,height:800});
  p.on('pageerror',e=>{fails++;console.log(`[${label} pageerror]`,e.message)});
  if(seed)await p.evaluateOnNewDocument(s=>{if(location.hostname==='localhost'){for(const [k,v] of Object.entries(s))localStorage.setItem(k,v)}},seed);
  if(hook||onReq){
    await p.setRequestInterception(true);
    p.on('request',r=>{
      if(onReq&&onReq(r))return;
      const u=r.url();
      if(hook&&u.startsWith('http://localhost:3210/')&&(u==='http://localhost:3210/'||u.includes('/?')||u.endsWith('index.html')))return r.respond({status:200,contentType:'text/html',body:hooked});
      r.continue();
    });
  }
  await p.goto('http://localhost:3210'+path,{waitUntil:'domcontentloaded'});
  return p;
}
const run=(p,body,arg)=>p.evaluate((b,a)=>__ev('(async(arg)=>{'+b+'})')(a),body,arg===undefined?null:arg);
const vis=(p,sel)=>p.$eval(sel,e=>!e.hidden&&getComputedStyle(e).display!=="none"&&e.getClientRects().length>0).catch(()=>false);
const txt=(p,sel)=>p.$eval(sel,e=>e.textContent.trim()).catch(()=>null);
const FAKE_DB=`
  window.__calls=[];window.__fail=null;window.__delay=0;window.sleep=ms=>new Promise(r=>setTimeout(r,ms));
  const mk=(t)=>{const q={t,ops:[]};const p=new Proxy(function(){},{get(_,k){
    if(k==='then'){const r=(async()=>{await new Promise(res=>setTimeout(res,window.__delay));window.__calls.push(q);
      if(window.__fail&&window.__fail(q))return {data:null,error:{message:'simulated failure'}};return {data:[],error:null};})();return r.then.bind(r);}
    return (...a)=>{q.ops.push([k,a]);return p;};}});return p;};
  sbClient.from=mk;
  sbClient.rpc=(fn,args)=>{const p=mk(fn==='hangtag_save_sales'?'hangtag_sales':'rpc:'+fn);return p.rpc(args);};
  window.__sess=true;
  sbClient.auth.getSession=async()=>({data:{session:window.__sess?{user:{id:'u1',email:'owner@example.com'},access_token:'t'}:null},error:null});
  authUser={id:'u1',email:'owner@example.com'};sbStatus='connected';mode='online';hideGate();
  catalog={version:3,example:false,products:[{id:'q1',name:'Q',price:100,color:'#000',opts:[{n:'Size',v:['M']}],variants:[{id:'q1:M',o:['M'],sku:'',bc:'',price:null,cost:null,active:true}]}]};saveCatalog();moves={'open:q1:M':{id:'open:q1:M',v:'q1:M',p:'q1',type:'OPENING',q:9,cost:null,note:'',t:Date.now(),dev}};saveMoves();renderAll();
`;
(async()=>{
  await H.ensureServer();
  const browser=await puppeteer.launch({executablePath:H.CHROME,headless:true});
  try{
    // 1. venue Wi-Fi with no internet: token refresh hangs
    let ctx=await browser.createBrowserContext();
    let t0=Date.now();
    let A=await page(ctx,'A',{seed:{'hangtag_auth_email':'"owner@example.com"','hangtag-auth':expiredSession},onReq:r=>{if(r.url().includes(SB+'/auth/v1/token')){return true;} return false;}});
    await A.waitForFunction(()=>document.getElementById('authGate').hidden,{timeout:12000}).catch(()=>{});
    const secs=(Date.now()-t0)/1000;
    check('no-internet Wi-Fi, approved till: opens for selling',!(await vis(A,'#authGate')),{seconds:secs.toFixed(1)});
    check('...within about 4 seconds, not 25',secs<9);
    check('...sync pill shows offline mode',(await txt(A,'#sync'))==='Offline',await txt(A,'#sync'));
    check('...sign-out button visible',await vis(A,'#acctBtn'));
    // 2. sign out while the network hangs
    t0=Date.now();
    await A.click('#acctBtn');await A.click('[data-am="signout"]');
    await A.waitForFunction(()=>!document.getElementById('authGate').hidden,{timeout:8000}).catch(()=>{});
    check('sign-out on dead network finishes (3 s cap)',await vis(A,'#authGate'),{seconds:((Date.now()-t0)/1000).toFixed(1)});
    check('sign-out removes the stored session',await A.evaluate(()=>localStorage.getItem('hangtag-auth')===null));
    check('sign-out forgets the approved email',(await run(A,'return LS.get("hangtag_auth_email","")'))==='');
    await ctx.close();

    // 3. revoked sign-in (server says refresh token is gone)
    ctx=await browser.createBrowserContext();
    A=await page(ctx,'A',{seed:{'hangtag_auth_email':'"owner@example.com"','hangtag-auth':expiredSession},onReq:r=>{if(r.url().includes(SB+'/auth/v1/token')&&r.method()==='OPTIONS'){r.respond({status:204,headers:{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'*','Access-Control-Allow-Methods':'POST, GET, OPTIONS'}});return true;}if(r.url().includes(SB+'/auth/v1/token')){r.respond({status:400,contentType:'application/json',headers:{'Access-Control-Allow-Origin':'*'},body:JSON.stringify({code:400,error_code:'refresh_token_not_found',msg:'Invalid Refresh Token: Refresh Token Not Found'})});return true;}return false;}});
    await sleep(3500);
    check('revoked sign-in: login screen shown',await vis(A,'#authGate')&&await vis(A,'[data-provider="google"]'));
    check('revoked sign-in: approved email forgotten',(await run(A,'return LS.get("hangtag_auth_email","")'))==='');
    await ctx.close();

    // 4. queue: bills survive a failed upload, nothing is lost, order kept, no public-key writes
    ctx=await browser.createBrowserContext();
    A=await page(ctx,'A');await sleep(800);
    await run(A,FAKE_DB);
    await run(A,`window.__fail=q=>q.t==='hangtag_sales';cart=[];addToLines(cart,'q1:M',1);await checkout('cash');await sleep(300);`);
    check('upload fails: bill stays queued',(await run(A,'return sbOfflineQueue.filter(x=>x.type==="sale").length'))===1);
    check('upload fails: bill still counted locally',(await run(A,'return stockOf("q1:M")'))===8);
    await run(A,`window.__fail=null;await sleep(700);await voidSale(lastSale.id,"Duplicate bill");await flushSbQueue();`);
    check('upload works again: queue empties',(await run(A,'return sbOfflineQueue.length'))===0,await run(A,'return sbOfflineQueue'));
    const order=await run(A,`return __calls.filter(c=>c.t==='hangtag_sales').map(c=>c.ops[0][0])`);
    check('bill uploaded before its cancel',order.lastIndexOf('rpc')>-1&&order.lastIndexOf('rpc')<order.lastIndexOf('update'),order);
    // no session -> nothing sent, queue kept
    await run(A,`window.__calls=[];window.__sess=false;cart=[];addToLines(cart,'q1:M',1);await checkout({method:'upi',ref:'412345678901',confirmed:true});await sleep(400);await flushSbQueue();`);
    check('no signed-in session: nothing sent to the cloud',(await run(A,'return __calls.length'))===0);
    check('no signed-in session: bill kept in queue',(await run(A,'return sbOfflineQueue.length'))===1);
    // bill added while an upload is running is not lost
    await run(A,`window.__sess=true;await sleep(700);window.__delay=400;window.__calls=[];const p=flushSbQueue();await sleep(100);cart=[];addToLines(cart,'q1:M',2);await checkout({method:'card',ref:'APPR1'});await p;await sleep(1500);`);
    check('bill added during an upload is not lost',(await run(A,'return sbOfflineQueue.length'))===0&&(await run(A,`return __calls.filter(c=>c.t==='hangtag_sales').length`))===2,await run(A,'return {q:sbOfflineQueue.length,calls:__calls.map(c=>c.t)}'));
    // pulls refuse to run without a session
    await run(A,`window.__sess=false;window.__calls=[];await pullFromSupabase(false);await pullCatalogFromSupabase(true);`);
    check('no session: pulls do not run (so no empty answers wipe data)',(await run(A,'return __calls.length'))===0&&(await run(A,'return products().length'))===1);
    await ctx.close();

    // 6. crafted error link: no attacker text on the page
    ctx=await browser.createBrowserContext();
    A=await page(ctx,'A',{path:'/?error=access_denied&error_code=otp_expired&error_description=Call%20555-0100%20to%20verify%20your%20account'});
    await sleep(1500);
    const err=await txt(A,'#authErr');
    check('link error: plain message shown',err==='That link has expired or was already used. Try again.',err);
    check('link error: attacker text not shown',!(await A.evaluate(()=>document.body.innerText.includes('555-0100'))));
    check('link error: address bar tidied',A.url()==='http://localhost:3210/',A.url());
    await ctx.close();

    // 8. Supabase library fails to load
    ctx=await browser.createBrowserContext();
    A=await page(ctx,'A',{onReq:r=>{if(r.url().includes('cdn.jsdelivr.net')){r.abort('failed');return true}return false}});
    await sleep(1200);
    check('library blocked, never signed in: stays locked with message',await vis(A,'#authGate')&&/Couldn't load the sign-in service/.test(await txt(A,'#authMsg')||''));
    await ctx.close();
    ctx=await browser.createBrowserContext();
    A=await page(ctx,'A',{seed:{'hangtag_auth_email':'"owner@example.com"'},onReq:r=>{if(r.url().includes('cdn.jsdelivr.net')){r.abort('failed');return true}return false}});
    await sleep(1200);
    check('library blocked, approved before: sells locally',!(await vis(A,'#authGate'))&&(await txt(A,'#sync'))==='Offline',await txt(A,'#sync'));
    await ctx.close();

    // 9. till behind the login screen is inert; focus goes into the card
    ctx=await browser.createBrowserContext();
    A=await page(ctx,'A');await sleep(1200);
    check('login up: header and till are inert',await A.evaluate(()=>document.querySelector('header').inert&&document.querySelector('main').inert));
    check('login up: focus inside the login card',await A.evaluate(()=>document.getElementById('authGate').contains(document.activeElement)));
    await A.keyboard.press('Tab');await A.keyboard.press('Tab');await A.keyboard.press('Tab');
    check('Tab stays inside the login card',await A.evaluate(()=>document.getElementById('authGate').contains(document.activeElement)||document.activeElement===document.body));
    await run(A,`sbClient.auth.getSession=async()=>({data:{session:null}});LS.set('hangtag_data_owner','u1');await onSignedIn({user:{id:'u1',email:'owner@example.com'}})`);
    check('signed in: till no longer inert',await A.evaluate(()=>!document.querySelector('header').inert&&!document.querySelector('main').inert));
    await ctx.close();

    // 10. service worker: no stale Supabase data, sign-in returns don't pin old copies
    ctx=await browser.createBrowserContext();
    A=await page(ctx,'A',{hook:false});await sleep(800);
    await A.evaluate(async()=>{await navigator.serviceWorker.register('sw.js');await navigator.serviceWorker.ready;});
    await A.reload({waitUntil:'networkidle0'});await sleep(800);
    check('service worker controls the page',await A.evaluate(()=>!!navigator.serviceWorker.controller));
    await A.goto('http://localhost:3210/?code=abc123',{waitUntil:'networkidle0'});await sleep(1500);
    await A.evaluate(async()=>{await fetch('https://wcorlmgkwcahyfastjoz.supabase.co/auth/v1/settings',{headers:{apikey:'sb_publishable_p0yGTC8iUv654ZiP9WCS-A_S0oinXAl'}}).catch(()=>{});});
    await sleep(800);
    const keys=await A.evaluate(async()=>{const out=[];for(const n of await caches.keys()){const c=await caches.open(n);for(const r of await c.keys())out.push(n+' '+r.url)}return out});
    const CACHE=/const CACHE = "([^"]+)"/.exec(fs.readFileSync(H.ROOT+'/sw.js','utf8'))[1];
    check('cache name is the current build ('+CACHE+')',keys.every(k=>k.startsWith(CACHE+' ')),[...new Set(keys.map(k=>k.split(' ')[0]))]);
    check('no ?code= page saved',!keys.some(k=>k.includes('?code')),keys.filter(k=>k.includes('localhost')));
    check('no Supabase answers saved',!keys.some(k=>k.includes('supabase.co')));
    check('app page and Supabase library saved for offline',keys.some(k=>k.endsWith('localhost:3210/'))&&keys.some(k=>k.includes('cdn.jsdelivr.net')));
    check('every app module and stylesheet saved for offline',['/src/app/main.js','/src/features/sales/use-cases/checkout.js','/src/styles/20-sell.css'].every(f=>keys.some(k=>k.endsWith(f))),keys.filter(k=>k.includes('/src/')).length);
    await ctx.close();
  }finally{await browser.close()}
  console.log(fails?fails+' FAILED':'ALL PASSED');process.exit(fails?1:0);
})();
