const H=require('../helpers/env.cjs');
const puppeteer=require('puppeteer-core');const fs=require('fs');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let fails=0;const check=(name,ok,info)=>{if(!ok)fails++;console.log((ok?'PASS ':'FAIL ')+name+(info!==undefined?'  '+JSON.stringify(info):''))};
const html=H.indexHtml();
const hooked=H.hookedHtml();
const SHOT=H.ARTIFACTS+'/';
async function page(ctx,label,path='/',w=1180,h=900){
  const p=await ctx.newPage();await p.setViewport({width:w,height:h});
  p.on('pageerror',e=>{fails++;console.log(`[${label} pageerror]`,e.message)});
  await p.setRequestInterception(true);
  p.on('request',r=>{const u=r.url();if(u.startsWith('http://localhost:3210/')&&(u==='http://localhost:3210/'||u.includes('/?')||u.includes('/#')||u.endsWith('index.html')))r.respond({status:200,contentType:'text/html',body:hooked});else r.continue()});
  await p.goto('http://localhost:3210'+path,{waitUntil:'networkidle0'});await sleep(500);
  return p;
}
const run=(p,body,arg)=>p.evaluate((b,a)=>__ev('(async(arg)=>{'+b+'})')(a),body,arg===undefined?null:arg);
const vis=(p,sel)=>p.$eval(sel,e=>!e.hidden&&getComputedStyle(e).display!=="none"&&e.getClientRects().length>0).catch(()=>false);
const txt=(p,sel)=>p.$eval(sel,e=>e.textContent.trim()).catch(()=>null);
async function type(p,sel,v){await p.$eval(sel,e=>{e.value=''});if(v)await p.type(sel,v)}
(async()=>{
  await H.ensureServer();
  const browser=await puppeteer.launch({executablePath:H.CHROME,headless:true});
  try{
    let ctx=await browser.createBrowserContext();let A=await page(ctx,'A');
    // ---- what a first-time visitor sees ----
    check('one clean sign-in hierarchy has no mode tabs',!(await A.$('#authTabs'))&&!(await A.$('[data-authtab]')));
    check('primary heading says Sign in to your shop',(await txt(A,'#authMsg'))==='Sign in to your shop');
    check('email and password shown straight away',await vis(A,'#authEmail')&&await vis(A,'#authPass'));
    check('"New to Hangtag? Create an account" link shown',/New to Hangtag\? Create an account/.test(await txt(A,'#authSwitch')||''));
    check('staff sign-in is a secondary link',/Staff or team member\? Staff sign-in/.test(await txt(A,'#staffSwitch')||''));
    await A.screenshot({path:SHOT+'s1-signin.png'});
    // ---- Create account mode ----
    await type(A,'#authEmail','typed@example.com');
    await A.click('[data-switchto="signup"]');await sleep(150);
    check('Create account: button says Create account',(await txt(A,'#emailSubmit'))==='Create account');
    check('Create account: password twice + 8-character hint',await vis(A,'#authPass2')&&await vis(A,'#pwHint')&&(await txt(A,'#pwLabel'))==='Choose a password');
    check('Create account: Google button says "Sign up with Google"',(await txt(A,'[data-provider="google"] span'))==='Sign up with Google');
    check('Create account: heading explains private shop',/Create your Hangtag account/.test(await txt(A,'#authMsg')||''));
    check('switching tabs keeps the typed email',(await A.$eval('#authEmail',e=>e.value))==='typed@example.com');
    check('"Already have an account? Sign in" link shown',/Already have an account\? Sign in/.test(await txt(A,'#authSwitch')||''));
    check('Forgot password hidden while creating',!(await vis(A,'#forgotBtn')));
    await A.screenshot({path:SHOT+'s2-signup.png'});
    await A.click('[data-switchto="signin"]');await sleep(150);
    check('switch link goes back to Sign in',(await txt(A,'#emailSubmit'))==='Sign in'&&(await txt(A,'[data-provider="google"] span'))==='Continue with Google');
    await A.click('[data-switchto="signup"]');await sleep(150);
    check('switch link opens Create account',(await txt(A,'#emailSubmit'))==='Create account');
    await A.click('[data-switchto="staff"]');await sleep(150);
    check('staff link opens the dedicated staff form',await vis(A,'#staffForm')&&!(await vis(A,'#emailForm'))&&(await txt(A,'#authMsg'))==='Staff sign-in');
    await A.click('[data-switchto="signin"]');await sleep(150);
    await A.click('[data-switchto="signup"]');await sleep(150);
    // opening the page at #signup lands on Create account
    const B=await page(ctx,'B','/#signup');
    check('link to the page with #signup opens Create account',(await txt(B,'#emailSubmit'))==='Create account');
    await B.close();

    // ---- live project, brand-new email, Create account (real lookup; signUp faked so no email is sent) ----
    await run(A,`window.__su=null;sbClient.auth.signUp=async(o)=>{window.__su=o;return {data:{user:{identities:[{}]},session:null},error:null}}`);
    const fresh='new.'+Date.now()+'@example.com';
    await type(A,'#authEmail',fresh);await type(A,'#authPass','goodpass123');await type(A,'#authPass2','goodpass123');
    await A.click('#emailSubmit');await sleep(2500);
    const su=await A.evaluate(()=>window.__su);
    check('live: new email on Create account signs up (real lookup says new)',su&&su.email===fresh&&su.password==='goodpass123',su&&su.email);
    check('live: then asks to confirm the email',/sent a confirmation link to/.test(await txt(A,'#authNote')||'')&&await vis(A,'#resendBtn'),await txt(A,'#authNote')||await txt(A,'#authErr'));

    // ---- the smart checks (lookup faked) ----
    await run(A,`showGate("signin");window.__oauth=null;sbClient.auth.signInWithOAuth=async(o)=>{window.__oauth=o;return {error:null}};
      sbClient.rpc=async(fn,a)=>({data:{'google@gmail.com':['google'],'shop@example.com':['email']}[a.p_email]||[],error:null});authSettings={external:{google:true,email:true}}`);
    // Google-account email on Sign in
    await type(A,'#authEmail','Google@Gmail.com');await type(A,'#authPass','whatever1');await A.click('#emailSubmit');await sleep(500);
    let oa=await A.evaluate(()=>window.__oauth);
    check('Sign in with a Google-account email continues with Google',oa&&oa.provider==='google'&&oa.options.queryParams.login_hint==='google@gmail.com',oa);
    check('...and says why',/already has an account through Google/.test(await txt(A,'#authNote')||''));
    // Google-account email on Create account
    await run(A,`showGate("signin",{mode:"signup"});window.__oauth=null`);
    await type(A,'#authEmail','google@gmail.com');await type(A,'#authPass','goodpass123');await type(A,'#authPass2','goodpass123');await A.click('#emailSubmit');await sleep(500);
    oa=await A.evaluate(()=>window.__oauth);
    check('Create account with a Google-account email continues with Google (no second account)',oa&&oa.provider==='google',oa);
    // Sign in with an email that has no account -> Create account, email kept
    await run(A,`showGate("signin")`);
    await type(A,'#authEmail','nobody@example.com');await type(A,'#authPass','whatever1');await A.click('#emailSubmit');await sleep(400);
    check('Sign in with an unknown email moves to Create account',(await txt(A,'#emailSubmit'))==='Create account'&&(await A.$eval('#authEmail',e=>e.value))==='nobody@example.com');
    check('...and explains',/no Hangtag account for nobody@example.com yet/.test(await txt(A,'#authNote')||''));
    // Create account with an email that already has one -> Sign in
    await type(A,'#authEmail','shop@example.com');await type(A,'#authPass','goodpass123');await type(A,'#authPass2','goodpass123');await A.click('#emailSubmit');await sleep(400);
    check('Create account with an existing email moves to Sign in',(await txt(A,'#emailSubmit'))==='Sign in'&&/already have an account with shop@example.com/.test(await txt(A,'#authNote')||''));
    // Sign in with the right account
    await run(A,`window.__pw=null;sbClient.auth.signInWithPassword=async(o)=>{window.__pw=o;return {data:{},error:{code:'invalid_credentials',message:'Invalid login credentials'}}}`);
    await type(A,'#authPass','wrongpass1');await A.click('#emailSubmit');await sleep(300);
    check('Sign in with an email account uses its password',await A.evaluate(()=>window.__pw&&window.__pw.email==='shop@example.com'));
    check('wrong password: plain message',(await txt(A,'#authErr'))==='Wrong email or password.');
    // validation
    await run(A,`showGate("signin",{mode:"signup"})`);
    await type(A,'#authEmail','a@b.co');await type(A,'#authPass','short');await type(A,'#authPass2','short');await A.click('#emailSubmit');await sleep(150);
    check('Create account: short password refused',/at least 8 characters/.test(await txt(A,'#authErr')||''));
    await type(A,'#authPass','goodpass123');await type(A,'#authPass2','goodpass124');await A.click('#emailSubmit');await sleep(150);
    check("Create account: mismatched passwords refused",(await txt(A,'#authErr'))==="The two passwords don't match.");
    await run(A,`showGate("signin")`);
    await type(A,'#authEmail','a@b.co');await A.click('#emailSubmit');await sleep(150);
    check('Sign in: empty password refused',(await txt(A,'#authErr'))==='Enter your password.');
    // lookup unavailable -> still works both ways
    await run(A,`sbClient.rpc=async()=>({data:null,error:{code:'PGRST202',message:'x'}})`);
    await type(A,'#authPass','whatever1');await A.click('#emailSubmit');await sleep(300);
    check('lookup unavailable: Sign in still tries the password',await A.evaluate(()=>window.__pw&&window.__pw.email==='a@b.co'));
    await run(A,`showGate("signin",{mode:"signup"});window.__su=null;sbClient.auth.signUp=async(o)=>{window.__su=o;return {data:{user:{identities:[{}]},session:null},error:null}}`);
    await type(A,'#authEmail','c@d.co');await type(A,'#authPass','goodpass123');await type(A,'#authPass2','goodpass123');await A.click('#emailSubmit');await sleep(300);
    check('lookup unavailable: Create account still signs up',await A.evaluate(()=>window.__su&&window.__su.email==='c@d.co'));
    // forgot password
    await run(A,`showGate("signin");window.__rp=null;sbClient.auth.resetPasswordForEmail=async(e,o)=>{window.__rp=[e,o];return {error:null}}`);
    await type(A,'#authEmail','shop@example.com');
    await A.click('#forgotBtn');await sleep(150);
    check('Forgot password: email kept and Google hidden',(await A.$eval('#authEmail',e=>e.value))==='shop@example.com'&&!(await vis(A,'[data-provider="google"]'))&&(await txt(A,'#emailSubmit'))==='Send reset link');
    await A.click('#emailSubmit');await sleep(300);
    check('Forgot password: link requested',await A.evaluate(()=>window.__rp&&window.__rp[0]==='shop@example.com'));
    check('back on Sign in with the note',(await txt(A,'#emailSubmit'))==='Sign in'&&/reset link is on its way/.test(await txt(A,'#authNote')||''));
    await ctx.close();
    // phone
    ctx=await browser.createBrowserContext();A=await page(ctx,'A','/',375,800);
    check('phone: fits without sideways scroll',!(await A.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth)));
    await A.click('[data-switchto="signup"]');await sleep(150);
    await A.screenshot({path:SHOT+'s3-phone-signup.png'});
    await ctx.close();
  }finally{await browser.close()}
  console.log(fails?fails+' FAILED':'ALL PASSED');process.exit(fails?1:0);
})();
