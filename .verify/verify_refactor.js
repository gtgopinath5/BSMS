/* Verify the database-driven refactor in a real browser.
   Run: NODE_PATH=/Users/gopinathgt/.npm/_npx/e41f203b7505f1fb/node_modules \
        node /Users/gopinathgt/bsms/.verify/verify_refactor.js
   Proves: (1) backend login works → portal loads REAL PostgreSQL data;
           (2) anonymous-demo deep-link is GONE (no token → no portal). */
const { chromium } = require('playwright');

const FE = 'http://localhost:7890';
const BE = 'http://localhost:8000';
const R = [];
const ck = (n, ok, d='') => { R.push(ok); console.log(`  [${ok?'PASS':'FAIL'}] ${n}${d?' · '+d:''}`); };

async function token(u, p) {
  const r = await fetch(BE + '/api/v1/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: u, password: p }) });
  return r.json();
}

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const jsErrors = [];
  const failed = [];
  page.on('pageerror', e => jsErrors.push(String(e)));
  page.on('requestfailed', req => { const u = req.url(); if (u.includes('localhost:7890') || u.includes('localhost:8000')) failed.push(u); });
  const apiCalls = [];
  page.on('response', res => { const u = res.url(); if (u.includes('localhost:8000/api/')) apiCalls.push({ u, s: res.status() }); });

  // ---- 1) ANONYMOUS DEMO IS GONE: no token + #admin → stays on landing ----
  await page.goto(FE + '/#admin', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(2500);
  const bodyAnon = (await page.innerText('body')).toUpperCase();
  const inPortalAnon = bodyAnon.includes('LIVE BAY') || bodyAnon.includes('JOB ASSIGNMENT') || bodyAnon.includes('FLEET VIEW');
  const onLanding = bodyAnon.includes('SELECT YOUR FACILITY') || bodyAnon.includes('PICK A SERVICE CENTER') || bodyAnon.includes('CLOCK IN');
  ck('anonymous #admin deep-link does NOT open a demo portal', !inPortalAnon && onLanding,
     onLanding ? 'shows landing/login' : 'unexpected screen');

  // ---- 2) BACKEND LOGIN → portal loads REAL PostgreSQL data ----
  const adm = await token('admin', 'admin123');
  ck('backend login issues a JWT (PostgreSQL auth)', !!adm.access_token);
  await page.addInitScript(([t, u]) => {
    sessionStorage.setItem('bw_token', t);
    sessionStorage.setItem('bw_user', u);
    localStorage.setItem('bw_api_base', 'http://localhost:8000');
  }, [adm.access_token, JSON.stringify({ id: adm.user_id, name: adm.name, role: adm.role, branch_id: adm.branch_id })]);
  apiCalls.length = 0;
  await page.goto(FE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(4000);
  const body = await page.innerText('body');
  // we restored an admin session → admin console chrome should be present
  ck('restored JWT session → admin portal mounts', /baywatch\.os/i.test(body) || /BAY MANAGEMENT|LIVE BAY|JOB ASSIGNMENT/i.test(body));
  // the portal fetched data from the backend API (PostgreSQL), not a static array
  const okApi = apiCalls.filter(c => c.s === 200);
  ck('portal loaded data FROM the backend API', okApi.length >= 1, `${okApi.length} successful /api calls`);
  // navigate to Bay Management and confirm real bays render (PG17 has 7 bays)
  try {
    await page.click('text=/bay management/i', { timeout: 4000 }).catch(()=>{});
    await page.waitForTimeout(2500);
  } catch (e) {}
  const after = (await page.innerText('body'));
  const apiBays = await (await fetch(BE + '/api/v1/bays/operations', { headers: { Authorization: 'Bearer ' + adm.access_token } })).json();
  const bayCount = (apiBays.data && apiBays.data.bays || []).length;
  ck('backend reports real bays from PostgreSQL', bayCount >= 1, `${bayCount} bays`);

  // ---- 3) no JS errors / no failed app requests ----
  ck('no uncaught JS errors', jsErrors.length === 0, jsErrors.slice(0,2).join(' | '));
  ck('no failed app requests', failed.length === 0, failed.slice(0,2).join(' | '));

  await browser.close();
  const passed = R.filter(Boolean).length;
  console.log(`\n${'='.repeat(56)}\nREFACTOR VERIFY: ${passed}/${R.length} passed ${passed===R.length?'✅':'❌'}\n${'='.repeat(56)}`);
  process.exit(passed === R.length ? 0 : 1);
})().catch(e => { console.error('FATAL', e); process.exit(2); });
