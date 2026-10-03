const H=require('../helpers/env.cjs');
// Replays the real Google round trip with the real supabase-js; only Supabase/Google answers are faked.
const puppeteer=require('puppeteer-core');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const SB='https://wcorlmgkwcahyfastjoz.supabase.co';
const b64=o=>Buffer.from(JSON.stringify(o)).toString('base64url');
const now=()=>Math.floor(Date.now()/1000);
function session(uid,email){
  const at=b64({alg:'HS256',typ:'JWT'})+'.'+b64({sub:uid,email,role:'authenticated',aud:'authenticated',exp:now()+3600,iat:now()})+'.sig';
  return {access_token:at,token_type:'bearer',expires_in:3600,expires_at:now()+3600,refresh_token:'r-'+uid,
    user:{id:uid,aud:'authenticated',role:'authenticated',email,user_metadata:{full_name:'Test '+uid},app_metadata:{provider:'google'}}};
}
const CORS={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'*','Access-Control-Allow-Methods':'GET,POST,PATCH,DELETE,OPTIONS,HEAD','Access-Control-Expose-Headers':'content-range'};
(async()=>{
  await H.ensureServer();
  const browser=await puppeteer.launch({executablePath:H.CHROME,headless:true});
  const log=[];let fails=0;
  const check=(n,ok,i)=>{if(!ok)fails++;console.log((ok?'PASS ':'FAIL ')+n+(i!==undefined?'  '+JSON.stringify(i):''))};
  async function run(label,{startPath='/',uid='uX',email='x@example.com',preOwner=null}={}){
    console.log('\n=== '+label+' ===');
    const ctx=await browser.createBrowserContext();const p=await ctx.newPage();
    const counts={authorize:0,exchange:0,pageLoads:0,prompts:[]};
    p.on('pageerror',e=>{fails++;console.log('[pageerror]',e.message)});
    p.on('console',m=>{if(m.type()==='error'||m.type()==='warning')log.push(m.text())});
    p.on('response',r=>{if(r.status()===403)log.push('403 '+r.url().slice(0,90))});
    await p.setRequestInterception(true);
    p.on('request',r=>{
      const u=r.url();
      if(r.resourceType()==='document'&&u.startsWith('http://localhost:3210'))counts.pageLoads++;
      if(r.method()==='OPTIONS'&&u.startsWith(SB))return r.respond({status:204,headers:CORS});
      if(u.startsWith(SB+'/auth/v1/authorize')){counts.authorize++;counts.prompts.push(new URL(u).searchParams.get('prompt'));const rt=new URL(u).searchParams.get('redirect_to');return r.respond({status:302,headers:{Location:rt+'?code=fakecode'+counts.authorize}});}
      if(u.startsWith(SB+'/auth/v1/token')){counts.exchange++;return r.respond({status:200,contentType:'application/json',headers:CORS,body:JSON.stringify(session(uid,email))});}
      if(u.startsWith(SB+'/auth/v1/settings'))return r.respond({status:200,contentType:'application/json',headers:CORS,body:JSON.stringify({external:{google:true,email:false}})});
      if(u.startsWith(SB+'/auth/v1/user'))return r.respond({status:200,contentType:'application/json',headers:CORS,body:JSON.stringify(session(uid,email).user)});
      // signing out stays on this computer (never a request to the real project)
      if(u.startsWith(SB+'/auth/v1/logout'))return r.respond({status:204,headers:CORS});
      if(u.startsWith(SB+'/rest/v1/hangtag_profiles')&&r.method()==='GET'){const prof={id:uid,email,full_name:'Test '+uid,shop_name:'Test Shop',phone:'9876543210',city:'Pune',state:'Maharashtra'};const obj=/vnd.pgrst.object/.test(r.headers()['accept']||'');return r.respond({status:200,contentType:'application/json',headers:CORS,body:JSON.stringify(obj?prof:[prof])});}
      if(u.startsWith(SB+'/rest/v1/'))return r.respond({status:200,contentType:'application/json',headers:Object.assign({'content-range':'*/0'},CORS),body:r.method()==='HEAD'?'':'[]'});
      if(u.startsWith(SB+'/realtime'))return r.abort();
      r.continue();
    });
    if(preOwner)await p.evaluateOnNewDocument(o=>{if(location.hostname==='localhost'&&!sessionStorage.__seeded){sessionStorage.__seeded=1;localStorage.setItem('hangtag_data_owner',JSON.stringify(o))}},preOwner);
    await p.goto('http://localhost:3210'+startPath,{waitUntil:'networkidle0'});await sleep(500);
    const gateUp=await p.$eval('#authGate',e=>!e.hidden);
    check('starts on the sign-in screen',gateUp);
    await Promise.all([p.waitForNavigation({waitUntil:'networkidle0',timeout:15000}).catch(()=>null),p.click('[data-provider="google"]')]);
    // wait for any reloads (account data swap) to settle
    await sleep(6000);
    const state=await p.evaluate(()=>({gate:!document.getElementById('authGate').hidden,msg:document.getElementById('authMsg').textContent,err:document.getElementById('authErr').textContent,acct:document.getElementById('acctBtn').title,url:location.href,owner:localStorage.getItem('hangtag_data_owner')}));
    check('sent to Google only once',counts.authorize===1,counts);
    check('one-time code exchanged once',counts.exchange===1,counts);
    check('ends signed in, app open (no second sign-in screen)',!state.gate&&/Signed in as/.test(state.acct),state);
    check('address bar clean',state.url==='http://localhost:3210/',state.url);
    check('Google not forced to show its account chooser',counts.prompts[0]===null,counts.prompts);
    check('no extra page reload after coming back from Google',counts.pageLoads===2,counts.pageLoads);
    // sign out, then sign in again: now the account chooser is offered (to switch accounts)
    await p.click('#acctBtn');await p.click('[data-am="signout"]');
    // signing out locally can take most of a second (the sign-in library's lock): wait for the sign-in screen, not a fixed time
    await p.waitForFunction(()=>!document.getElementById('authGate').hidden&&!document.getElementById('authForms').hidden,{timeout:8000}).catch(()=>null);await sleep(200);
    await Promise.all([p.waitForNavigation({waitUntil:'networkidle0',timeout:15000}).catch(()=>null),p.click('[data-provider="google"]')]);
    // wait for the sign-in to finish (the gate closes), not a fixed time
    await p.waitForFunction(()=>document.getElementById('authGate').hidden,{timeout:15000}).catch(()=>null);await sleep(300);
    check('after Sign out, Google offers the account chooser',counts.prompts[1]==='select_account',counts.prompts);
    const st2=await p.evaluate(()=>({gate:!document.getElementById('authGate').hidden,pick:localStorage.getItem('hangtag_pick_account')}));
    check('signed back in, chooser request cleared',!st2.gate&&st2.pick==='""',st2);
    await ctx.close();
  }
  await run('first sign-in on this device (data swap reload happens)');
  await run('same account signs in again on this device (no swap)',{preOwner:'uX'});
  await run('different account than last time (swap reload)',{preOwner:'someoneElse'});
  if(log.length)console.log('\nconsole:',[...new Set(log)].slice(0,10));
  await browser.close();
  console.log(fails?fails+' FAILED':'ALL PASSED');process.exit(fails?1:0);
})();
