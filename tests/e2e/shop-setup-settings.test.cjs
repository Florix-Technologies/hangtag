const H=require('../helpers/env.cjs');
const puppeteer=require('puppeteer-core');const fs=require('fs');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let fails=0;const check=(name,ok,info)=>{if(!ok)fails++;console.log((ok?'PASS ':'FAIL ')+name+(info!==undefined?'  '+JSON.stringify(info):''))};
const html=H.indexHtml();
const hooked=H.hookedHtml();
const SHOT=H.ARTIFACTS+'/';
async function page(ctx,label,w=1180,h=860){
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
async function type(p,sel,v){await p.$eval(sel,e=>{e.value=''});if(v)await p.type(sel,v)}
// fake database: records calls; hangtag_profiles select answers window.__profileRow
const FAKE_DB=`
  window.__calls=[];window.__profileRow=null;
  const mk=(t)=>{const q={t,ops:[]};const p=new Proxy(function(){},{get(_,k){
    if(k==='then'){window.__calls.push(q);const isSel=q.ops.some(o=>o[0]==='select');
      const data=t==='hangtag_profiles'&&isSel?window.__profileRow:(isSel?[]:null);
      const r=Promise.resolve({data,error:null,count:0});return r.then.bind(r);}
    return (...a)=>{q.ops.push([k,a]);return p;};}});return p;};
  sbClient.from=mk;
  sbClient.auth.getSession=async()=>({data:{session:{user:{id:'u1'},access_token:'t'}}});
  sbClient.channel=()=>({on(){return this},subscribe(){return this}});sbClient.removeChannel=()=>Promise.resolve('ok');
  window.sleep=ms=>new Promise(r=>setTimeout(r,ms));
`;
const USER=(extra)=>`({user:Object.assign({id:'u1',email:'raj@example.com',created_at:'2026-01-15T10:00:00Z',identities:[{provider:'google'}],user_metadata:{full_name:'Raj Kumar'}},${extra||'{}'})})`;
(async()=>{
  await H.ensureServer();
  const browser=await puppeteer.launch({executablePath:H.CHROME,headless:true});
  try{
    let ctx,A;
    // ================= first sign-in: required shop setup =================
    ctx=await browser.createBrowserContext();A=await page(ctx,'A');
    await A.evaluate(()=>localStorage.setItem('hangtag_data_owner',JSON.stringify('u1')));
    await run(A,FAKE_DB);
    await run(A,`await doSignedIn(${USER()})`);
    check('new account: setup screen shown before the till',await vis(A,'#setupGate')&&!(await vis(A,'#authGate')));
    check('setup: name pre-filled from Google',(await A.$eval('#su_full_name',e=>e.value))==='Raj Kumar');
    check('setup: required fields marked',(await A.$$eval('#setupForm .req',x=>x.length))===5);
    check('till behind setup is inert',await A.evaluate(()=>document.querySelector('header').inert));
    await A.screenshot({path:SHOT+'e4-setup.png'});
    await A.click('#setupSubmit');await sleep(200);
    check('setup: missing shop name caught',(await txt(A,'#setupErr'))==='Shop name is required.');
    await type(A,'#su_shop_name','Raj Boutique');await type(A,'#su_phone','12345');await type(A,'#su_city','Pune');await type(A,'#su_state','Maharashtra');
    await A.click('#setupSubmit');await sleep(200);
    check('setup: bad phone caught',/valid phone number/.test(await txt(A,'#setupErr')||''));
    await type(A,'#su_phone','+91 98765 43210');await type(A,'#su_gstin','abc');
    await A.click('#setupSubmit');await sleep(200);
    check('setup: bad GST number caught',/GST number should be 15/.test(await txt(A,'#setupErr')||''));
    await type(A,'#su_gstin','27abcde1234f1z5');await A.select('#su_business_type','Clothing boutique');
    await run(A,`window.__calls=[]`);
    await A.click('#setupSubmit');await sleep(800);
    const up=await A.evaluate(()=>{const c=__calls.find(c=>c.t==='hangtag_profiles'&&c.ops[0][0]==='upsert');return c&&c.ops[0][1][0]});
    check('setup: saved to your profile (GST uppercased, setup time recorded)',up&&up.id==='u1'&&up.shop_name==='Raj Boutique'&&up.phone==='+91 98765 43210'&&up.gstin==='27ABCDE1234F1Z5'&&up.business_type==='Clothing boutique'&&!!up.onboarded_at,up);
    check('setup done: till opens',!(await vis(A,'#setupGate'))&&!(await A.evaluate(()=>document.querySelector('header').inert)));
    check('welcome line greets by first name with shop and city',/^Good (morning|afternoon|evening), Raj$/.test(await txt(A,'#welcome b')||'')&&(await txt(A,'#welcome .ws'))==='Raj Boutique · Pune',[await txt(A,'#welcome b'),await txt(A,'#welcome .ws')]);
    check('account button shows first name',(await txt(A,'#acctName'))==='Raj'&&(await txt(A,'#acctAvatar'))==='RK');
    check('browser tab shows shop name',(await A.title())==='Raj Boutique · Hangtag',await A.title());
    await A.screenshot({path:SHOT+'e5-app.png'});
    // account menu
    await A.click('#acctBtn');await sleep(150);
    check('account menu shows name, email and shop',await vis(A,'#acctMenu')&&(await txt(A,'#acctMenu .am-head b'))==='Raj Kumar'&&(await txt(A,'#acctMenu .ame'))==='raj@example.com'&&(await txt(A,'#acctMenu .ams'))==='Raj Boutique');
    check('menu has Profile & shop settings, Download backup, Sign out',JSON.stringify(await A.$$eval('#acctMenu [data-am]',b=>b.map(x=>x.dataset.am)))==='["settings","backup","signout"]');
    await A.screenshot({path:SHOT+'e6-menu.png'});
    await A.keyboard.press('Escape');await sleep(100);
    check('Escape closes the menu',!(await vis(A,'#acctMenu')));
    await A.click('#acctBtn');await A.click('main');await sleep(100);
    check('clicking elsewhere closes the menu',!(await vis(A,'#acctMenu')));
    // settings
    await A.click('#acctBtn');await A.click('[data-am="settings"]');await sleep(200);
    check('settings open with your details filled in',(await A.$eval('#ps_shop_name',e=>e.value))==='Raj Boutique'&&(await A.$eval('#ps_gstin',e=>e.value))==='27ABCDE1234F1Z5');
    check('settings: account info (email, method, member since)',(await txt(A,'#kvEmail'))==='raj@example.com'&&(await txt(A,'#kvMethod'))==='Google'&&(await txt(A,'#kvSince'))==='15 January 2026',[await txt(A,'#kvMethod'),await txt(A,'#kvSince')]);
    await A.screenshot({path:SHOT+'e7-settings.png',fullPage:false});
    await type(A,'#ps_shop_name','Raj Fashion House');await type(A,'#ps_city','Mumbai');
    await run(A,`window.__calls=[]`);
    await A.click('#profileSave');await sleep(500);
    const up2=await A.evaluate(()=>{const c=__calls.find(c=>c.t==='hangtag_profiles'&&c.ops[0][0]==='upsert');return c&&c.ops[0][1][0]});
    check('settings: changes saved',up2&&up2.shop_name==='Raj Fashion House'&&up2.city==='Mumbai'&&!('onboarded_at' in up2&&up2.onboarded_at!==undefined&&false),up2);
    check('settings: header and welcome update right away',(await txt(A,'#welcome .ws'))==='Raj Fashion House · Mumbai'&&(await A.title())==='Raj Fashion House · Hangtag');
    check('settings closed after save',(await A.$eval('#modalHost',e=>e.innerHTML))==='');
    // welcome can be hidden for the day
    await A.click('[data-welcome-close]');await sleep(100);
    check('welcome line can be hidden for today',!(await vis(A,'#welcome')));
    // sign out from the menu
    await run(A,`sbClient.auth.signOut=async()=>({error:null})`);
    await A.click('#acctBtn');await A.click('[data-am="signout"]');await sleep(500);
    check('Sign out from the menu returns to the sign-in page',await vis(A,'#authGate')&&await vis(A,'[data-provider="google"]')&&(await A.title())==='Hangtag');
    await ctx.close();

    // ================= returning user with a complete profile: straight in =================
    ctx=await browser.createBrowserContext();A=await page(ctx,'A');
    await A.evaluate(()=>localStorage.setItem('hangtag_data_owner',JSON.stringify('u2')));
    await run(A,FAKE_DB);
    await run(A,`window.__profileRow={id:'u2',email:'meera@example.com',full_name:'Meera Shah',shop_name:'Meera Styles',phone:'9876543210',city:'Surat',state:'Gujarat',onboarded_at:'2026-02-01'};await doSignedIn(${USER("{id:'u2',email:'meera@example.com',identities:[{provider:'email'}],user_metadata:{}}")})`);
    check('complete profile: no setup screen, till opens',!(await vis(A,'#setupGate'))&&!(await vis(A,'#authGate')));
    check('email account: greeting uses the saved name',/Meera$/.test(await txt(A,'#welcome b')||''));
    await A.click('#acctBtn');await A.click('[data-am="settings"]');await sleep(200);
    check('email account: settings show "Email and password"',(await txt(A,'#kvMethod'))==='Email and password');
    await ctx.close();

    // ================= offline, profile not on this device yet: selling not blocked =================
    ctx=await browser.createBrowserContext();A=await page(ctx,'A');
    await A.evaluate(()=>localStorage.setItem('hangtag_data_owner',JSON.stringify('u3')));
    await run(A,FAKE_DB+`sbClient.from=()=>{throw new TypeError('Failed to fetch')};`);
    await run(A,`await doSignedIn(${USER("{id:'u3'}")})`);
    check('offline first sign-in: till opens anyway (setup asked next time online)',!(await vis(A,'#setupGate'))&&!(await vis(A,'#authGate')));
    await ctx.close();

    // ================= phone width =================
    ctx=await browser.createBrowserContext();A=await page(ctx,'A',375,760);
    check('phone: sign-in page fits',!(await A.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth)));
    await A.evaluate(()=>localStorage.setItem('hangtag_data_owner',JSON.stringify('u1')));
    await run(A,FAKE_DB);await run(A,`await doSignedIn(${USER()})`);
    check('phone: setup screen fits',!(await A.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth)));
    await A.screenshot({path:SHOT+'e8-phone-setup.png'});
    await ctx.close();
  }finally{await browser.close()}
  console.log(fails?fails+' FAILED':'ALL PASSED');process.exit(fails?1:0);
})();
