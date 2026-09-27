const H=require('../helpers/env.cjs');
const puppeteer=require('puppeteer-core');const fs=require('fs');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let fails=0;const check=(name,ok,info)=>{if(!ok)fails++;console.log((ok?'PASS ':'FAIL ')+name+(info!==undefined?'  '+JSON.stringify(info):''))};
const html=H.indexHtml();
const hooked=H.hookedHtml();
const SHOT=H.ARTIFACTS+'/';
async function page(ctx,label,w=1100,h=820){
  const p=await ctx.newPage();await p.setViewport({width:w,height:h});
  p.on('pageerror',e=>{fails++;console.log(`[${label} pageerror]`,e.message)});
  await p.setRequestInterception(true);
  p.on('request',r=>{const u=r.url();if(u.startsWith('http://localhost:3210/')&&(u==='http://localhost:3210/'||u.includes('/?')||u.endsWith('index.html')))r.respond({status:200,contentType:'text/html',body:hooked});else r.continue()});
  await p.goto('http://localhost:3210/',{waitUntil:'networkidle0'});await sleep(500);
  return p;
}
const run=(p,body,arg)=>p.evaluate((b,a)=>__ev('(async(arg)=>{'+b+'})')(a),body,arg===undefined?null:arg);
const vis=(p,sel)=>p.$eval(sel,e=>!e.hidden&&getComputedStyle(e).display!=="none"&&e.getClientRects().length>0).catch(()=>false);
const txt=(p,sel)=>p.$eval(sel,e=>e.textContent.trim()).catch(()=>null);
const ls=(p,k)=>p.evaluate(k=>localStorage.getItem(k),k);
(async()=>{
  await H.ensureServer();
  const browser=await puppeteer.launch({executablePath:H.CHROME,headless:true});
  try{
    // ---------- login page ----------
    let ctx=await browser.createBrowserContext();let A=await page(ctx,'A');
    check('login screen shown',await vis(A,'#authGate'));
    check('Continue with Google shown',await vis(A,'[data-provider="google"]'));
    check('email box offered next to Google',await vis(A,'#authEmail'));
    check('offers "Create an account"',/New to Hangtag\? Create an account/.test(await txt(A,'#authSwitch')||''));
    await A.screenshot({path:SHOT+'g1-login.png'});
    // other sign-in services appear when switched on in Supabase
    await run(A,`authSettings={external:{google:true,azure:true,github:true,apple:false,email:true}};await renderProviders();`);
    const provs=await A.$$eval('#provBtns [data-provider]',b=>b.map(x=>x.dataset.provider+':'+x.textContent.trim()));
    check('switched-on services get buttons (Microsoft, GitHub), switched-off do not (Apple), email never',JSON.stringify(provs)===JSON.stringify(['google:Continue with Google','azure:Continue with Microsoft','github:Continue with GitHub']),provs);
    await A.screenshot({path:SHOT+'g2-providers.png'});
    await run(A,`window.__oauth=null;sbClient.auth.signInWithOAuth=async(o)=>{window.__oauth=o;return {error:null}}`);
    await A.click('[data-provider="azure"]');await sleep(300);
    const oa=await A.evaluate(()=>window.__oauth);
    check('Microsoft button asks Supabase for azure with email scope',oa&&oa.provider==='azure'&&oa.options.scopes==='email'&&oa.options.redirectTo==='http://localhost:3210/',oa);
    await run(A,`setAuthBusy(false)`);
    await A.click('[data-provider="google"]');await sleep(300);
    const og=await A.evaluate(()=>window.__oauth);
    check('Google button asks for google, without forcing the account chooser',og&&og.provider==='google'&&!og.options.queryParams,og);
    await run(A,`setAuthBusy(false);LS.set(PICK_ACCOUNT,"1")`);
    await A.click('[data-provider="google"]');await sleep(300);
    const og2=await A.evaluate(()=>window.__oauth);
    check('after a Sign out, Google shows the account chooser',og2&&og2.options.queryParams&&og2.options.queryParams.prompt==='select_account',og2);
    await run(A,`LS.set(PICK_ACCOUNT,"")`);
    await run(A,`setAuthBusy(false);authSettings={external:{google:false}}`);
    await A.click('[data-provider="google"]');await sleep(300);
    check('Google switched off: plain message, no redirect',/Google sign-in isn't switched on/.test(await txt(A,'#authErr')||''));
    // real Google redirect goes to Google (it is switched on in this project)
    await run(A,`authSettings=null;setAuthBusy(false);location.reload()`).catch(()=>{});await sleep(1200);
    const [nv]=await Promise.all([A.waitForNavigation({timeout:15000}).catch(()=>null),A.click('[data-provider="google"]')]);
    check('real click reaches Google sign-in',A.url().startsWith('https://accounts.google.com/')||A.url().includes('/auth/v1/authorize'),A.url().slice(0,60));
    await ctx.close();

    // ---------- each account keeps its own data on this device ----------
    ctx=await browser.createBrowserContext();A=await page(ctx,'A');
    const catA=JSON.stringify({version:3,example:false,products:[{id:'pa',name:'A shirt',price:500,color:'#000',opts:[{n:'Size',v:['M']}],variants:[{id:'pa:M',o:['M'],sku:'',bc:'',price:null,cost:null,active:true}]}]});
    await A.evaluate(c=>{localStorage.setItem('rc_catalog',c);localStorage.setItem('hangtag_sb_queue',JSON.stringify([{type:'void',id:'s9',isVoid:true}]));localStorage.setItem('rc_local',JSON.stringify({d:{sales:[{id:'sa'}]}}));},catA);
    // data from before accounts existed + first sign-in as user A -> legacy kept aside, A starts clean
    await Promise.all([A.waitForNavigation({timeout:10000}).catch(()=>null),run(A,`await doSignedIn({user:{id:'userA',email:'a@example.com'}})`).catch(()=>{})]);
    await sleep(800);
    check('first sign-in: older data put aside as "legacy", not shown to the account',(await ls(A,'hangtag_u_legacy_rc_catalog'))===catA&&(await ls(A,'rc_catalog'))===null);
    check('first sign-in: unsent queue kept aside too',(await ls(A,'hangtag_u_legacy_hangtag_sb_queue'))!==null&&(await ls(A,'hangtag_sb_queue'))===null);
    check('device now belongs to user A',JSON.parse(await ls(A,'hangtag_data_owner'))==='userA');
    // user A works: give A some data, then user B signs in on the same device
    await A.evaluate(c=>{localStorage.setItem('rc_catalog',c);localStorage.setItem('hangtag_sb_queue',JSON.stringify([{type:'sale',sale:{id:'sa1'}}]));localStorage.setItem('rc_cart',JSON.stringify([{p:'pa',q:1}]));},catA);
    await Promise.all([A.waitForNavigation({timeout:10000}).catch(()=>null),run(A,`await doSignedIn({user:{id:'userB',email:'b@example.com'}})`).catch(()=>{})]);
    await sleep(800);
    check("user B starts with an empty shop, not A's products",(await ls(A,'rc_catalog'))===null&&(await ls(A,'rc_cart'))===null&&(await ls(A,'hangtag_sb_queue'))===null);
    check("A's products, bill and unsent queue are kept for A",(await ls(A,'hangtag_u_userA_rc_catalog'))===catA&&(await ls(A,'hangtag_u_userA_hangtag_sb_queue'))!==null&&(await ls(A,'hangtag_u_userA_rc_cart'))!==null);
    check('B sees no products on screen',(await run(A,'return products().length'))===0);
    // B makes a product, then A signs back in
    const catB=JSON.stringify({version:3,example:false,products:[{id:'pb',name:'B tee',price:300,color:'#fff',opts:[{n:'Size',v:['S']}],variants:[{id:'pb:S',o:['S'],sku:'',bc:'',price:null,cost:null,active:true}]}]});
    await A.evaluate(c=>localStorage.setItem('rc_catalog',c),catB);
    await Promise.all([A.waitForNavigation({timeout:10000}).catch(()=>null),run(A,`await doSignedIn({user:{id:'userA',email:'a@example.com'}})`).catch(()=>{})]);
    await sleep(800);
    check("A signs back in: A's own products and queue come back",(await ls(A,'rc_catalog'))===catA&&JSON.parse(await ls(A,'hangtag_sb_queue'))[0].sale.id==='sa1');
    check("B's data kept for B",(await ls(A,'hangtag_u_userB_rc_catalog'))===catB);
    check('no leftover copy of A under A (it is live again)',(await ls(A,'hangtag_u_userA_rc_catalog'))===null);
    check('A sees A shirt on screen',JSON.stringify(await run(A,'return products().map(p=>p.name)'))==='["A shirt"]');
    // same account again: no reload, no swap
    await run(A,`window.__noReload=1;sbClient.auth.getSession=async()=>({data:{session:null}});await doSignedIn({user:{id:'userA',email:'a@example.com',user_metadata:{full_name:'Owner A'}}})`);
    check('same account signing in again: no reload, data untouched',(await A.evaluate(()=>window.__noReload))===1&&(await ls(A,'rc_catalog'))===catA);
    check('account name shown on the Sign out button',(await A.$eval('#acctBtn',e=>e.title))==='Signed in as Owner A (a@example.com)');
    // another tab switches the device to a different account -> this tab reloads
    await Promise.all([A.waitForNavigation({timeout:8000}).catch(()=>null),A.evaluate(()=>window.dispatchEvent(new StorageEvent('storage',{key:'hangtag_data_owner',newValue:JSON.stringify('userZ')})))]);
    await sleep(500);
    check('another tab switching account makes this tab reload',(await A.evaluate(()=>window.__noReload))===undefined);
    await ctx.close();

    // ---------- profile saved on sign-in; realtime ignores other accounts ----------
    ctx=await browser.createBrowserContext();A=await page(ctx,'A');
    await A.evaluate(()=>localStorage.setItem('hangtag_data_owner',JSON.stringify('userA')));
    await run(A,`
      window.__calls=[];
      const mk=(t)=>{const q={t,ops:[]};const p=new Proxy(function(){},{get(_,k){
        if(k==='then'){const sel=q.ops.some(o=>o[0]==='select');const r=Promise.resolve({data:t==='hangtag_profiles'&&sel?null:[],error:null,count:0});window.__calls.push(q);return r.then.bind(r);}
        return (...a)=>{q.ops.push([k,a]);return p;};}});return p;};
      sbClient.from=mk;sbClient.auth.getSession=async()=>({data:{session:{user:{id:'userA'},access_token:'t'}}});
      sbClient.channel=()=>({on(){return this},subscribe(){return this}});
      await doSignedIn({user:{id:'userA',email:'a@example.com',user_metadata:{full_name:'Owner A',avatar_url:'https://x/a.png'}}});
      await sleep(300);`.replace('await sleep(300);','await new Promise(r=>setTimeout(r,300));'));
    const prof=await A.evaluate(()=>{const c=__calls.find(c=>c.t==='hangtag_profiles'&&c.ops[0][0]==='upsert');return c&&c.ops[0]});
    check('profile row saved with name, email and photo',prof&&prof[0]==='upsert'&&prof[1][0].id==='userA'&&prof[1][0].full_name==='Owner A'&&prof[1][0].avatar_url==='https://x/a.png'&&prof[1][0].email==='a@example.com',prof);
    await run(A,`imgs={p1:'data:x'};await onRemoteImageEvent({eventType:'DELETE',old:{owner_id:'someoneElse',product_id:'p1'}})`);
    check("another account deleting its photo p1 doesn't remove mine",(await run(A,'return !!imgs.p1')));
    await run(A,`await onRemoteImageEvent({eventType:'DELETE',old:{owner_id:'userA',product_id:'p1'}})`);
    check('my own photo delete still applies',(await run(A,'return !imgs.p1')));
    const up=await run(A,`window.__calls=[];catalog={version:3,example:false,products:[{id:'p1',name:'X',price:1,color:'#000',opts:[{n:'Size',v:['M']}],variants:[{id:'p1:M',o:['M'],sku:'',bc:'',price:null,cost:null,active:true}]}]};moves={'open:p1:M':{id:'open:p1:M',v:'p1:M',p:'p1',type:'OPENING',q:1,cost:null,note:'',t:1,dev}};sbStatus='connected';await pushLocalToSupabase();
      const f=t=>__calls.filter(c=>c.t===t&&c.ops[0][0]==='upsert');
      return {prod:f('hangtag_products').length,vars:f('hangtag_variants').map(c=>c.ops[0][1][0].map(r=>r.id+':'+('owner_id' in r))),moves:f('hangtag_stock_moves').length,sizes:__calls.filter(c=>c.t==='hangtag_sizes').length,items:__calls.filter(c=>c.t==='hangtag_sale_items').map(c=>c.ops[0][1][1])}`);
    check('push uploads product, variants and opening stock; no owner_id sent from the browser; old size table unused',up.prod===1&&JSON.stringify(up.vars)==='[["p1:M:false"]]'&&up.moves===1&&up.sizes===0,up);
    await ctx.close();

    // ---------- phone width ----------
    ctx=await browser.createBrowserContext();A=await page(ctx,'A',375,740);
    check('phone width: no sideways scroll',!(await A.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth)));
    await A.screenshot({path:SHOT+'g3-phone.png'});
    await ctx.close();
  }finally{await browser.close()}
  console.log(fails?fails+' FAILED':'ALL PASSED');process.exit(fails?1:0);
})();
