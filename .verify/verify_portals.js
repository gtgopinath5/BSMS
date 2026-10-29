/* Multi-role portal smoke test — the safety net for the dead-code purge.
   Logs into every role against the real backend, mounts each portal, clicks
   through its tabs, and asserts: portal chrome renders, the backend API is hit,
   and ZERO uncaught JS errors / failed app requests occur.
   Run: NODE_PATH=/Users/gopinathgt/.npm/_npx/e41f203b7505f1fb/node_modules \
        node /Users/gopinathgt/bsms/.verify/verify_portals.js            */
const { chromium } = require('playwright');
const FE = 'http://localhost:7890', BE = 'http://localhost:8000';
const CREDS = {
  admin:    ['admin', 'admin123'],
  master:   ['master', 'master123'],
  worker:   ['worker', 'worker123'],
};
let PASS = 0, FAIL = 0;
const ck = (n, ok, d = '') => { ok ? PASS++ : FAIL++; console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${n}${d ? ' · ' + d : ''}`); };

async function login(u, p) {
  const r = await fetch(BE + '/api/v1/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: u, password: p }) }).then(x => x.json());
  return { tok: r.data?.access_token || r.access_token, usr: r.data?.user || r.user };
}

async function drivePortal(browser, role, [u, p]) {
  const { tok, usr } = await login(u, p);
  ck(`${role}: backend login (PostgreSQL JWT)`, !!tok);
  // Inject the session BEFORE the app boots → one clean navigation (a second
  // goto would abort in-flight <script> loads and look like failed requests).
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(({ tok, usr }) => {
    sessionStorage.setItem('bw_token', tok);
    sessionStorage.setItem('bw_user', JSON.stringify(usr));
  }, { tok, usr });
  const page = await ctx.newPage();
  const jsErr = [], failed = [], api = [];
  page.on('pageerror', e => jsErr.push(String(e)));
  page.on('requestfailed', req => { const x = req.url(); if (x.includes(':7890') || x.includes(':8000')) failed.push(x); });
  page.on('response', res => { if (res.url().includes(':8000/api/')) api.push(res.status()); });

  await page.goto(FE, { waitUntil: 'domcontentloaded' });
  // App transpiles JSX in-browser (Babel Standalone) + opens live sockets, so
  // wait for the rendered sidebar rather than networkidle / a fixed delay.
  const mounted = await page.waitForSelector('.side-link', { timeout: 20000 }).then(() => true).catch(() => false);
  await page.waitForTimeout(1200);

  const bodyLen = (await page.innerText('body').catch(() => '')).length;
  ck(`${role}: portal mounted`, mounted && bodyLen > 200, `${bodyLen} chars`);

  // Click each sidebar tab to exercise every Live* screen in this portal.
  const tabs = await page.$$('.side-link').catch(() => []);
  let clicked = 0;
  for (const t of tabs) {
    try { await t.click({ timeout: 1000 }); await page.waitForTimeout(450); clicked++; } catch (e) {}
  }
  ck(`${role}: navigated tabs`, clicked > 0, `${clicked} tabs`);
  ck(`${role}: backend API used`, api.filter(s => s === 200).length > 0, `${api.filter(s=>s===200).length} 200s`);
  ck(`${role}: no uncaught JS errors`, jsErr.length === 0, jsErr.slice(0,2).join(' | '));
  ck(`${role}: no failed app requests`, failed.length === 0, failed.slice(0,2).join(' | '));
  await page.screenshot({ path: `/tmp/portal_${role}.png` });
  await page.context().close();
}

(async () => {
  const browser = await chromium.launch();
  // Landing (public branches from PostgreSQL)
  {
    const page = await browser.newPage();
    const api = [];
    page.on('response', r => { if (r.url().includes('/api/v1/branches')) api.push(r.status()); });
    await page.goto(FE, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.branch-card', { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(600);
    const cards = await page.$$eval('.branch-card .branch-name', e => e.map(x => x.textContent)).catch(() => []);
    ck('landing: branches from GET /api/v1/branches', api.includes(200), `cards: ${cards.join(',')}`);
    await page.context().close();
  }
  for (const [role, creds] of Object.entries(CREDS)) {
    console.log(`\n— ${role.toUpperCase()} —`);
    await drivePortal(browser, role, creds);
  }
  await browser.close();
  console.log(`\nPORTAL VERIFY: ${PASS}/${PASS + FAIL} passed ${FAIL ? '❌' : '✅'}`);
  process.exit(FAIL ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
