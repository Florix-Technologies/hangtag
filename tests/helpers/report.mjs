// The reporter every suite shares: PASS / FAIL lines (tests/run.mjs counts them), a failure's details kept short, section
// headings, problems noticed outside a check (a page error), and the exit code.
//   const R = createReport();  R.section('…');  R.check('name', ok, info);  R.problem('[A pageerror] …');  await R.done(cleanup)
export function createReport({ infoMax = 600 } = {}){
  let passed = 0, failed = 0;
  const show = info => { try{ return JSON.stringify(info).slice(0, infoMax); }catch{ return String(info).slice(0, infoMax); } };
  const R = {
    check(name, ok, info){
      if(ok) passed++; else failed++;
      console.log((ok ? 'PASS ' : 'FAIL ') + name + (!ok && info !== undefined ? '  ' + show(info) : ''));
      return !!ok;
    },
    /* something wrong that isn't a check of its own (an uncaught page error): it fails the suite */
    problem(text){ failed++; console.log(text); },
    section(title){ console.log(`--- ${title} ---`); },
    get passed(){ return passed; },
    get failed(){ return failed; },
    /* the end: run the cleanup, print the summary, exit 1 when anything failed */
    async done(cleanup){
      try{ if(cleanup) await cleanup(); }catch(e){ console.log('cleanup failed:', e && e.message); }
      console.log(failed ? `\n${failed} FAILED` : `\nALL PASSED (${passed})`);
      process.exit(failed ? 1 : 0);
    },
  };
  return R;
}
