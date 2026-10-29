/* Baywatch UI verification pipeline — bay-first Fleet View + Job Assignment.
   Run:  NODE_PATH=/Users/gopinathgt/.npm/_npx/e41f203b7505f1fb/node_modules \
         node /Users/gopinathgt/bsms/.verify/verify_ui.js
   Needs: backend :8000 and frontend :7890 already running.
   Output: .verify/screenshots/{desktop,tablet,mobile}/*.png + reports/report.{json,md} */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const FE = 'http://localhost:7890', BE = 'http://localhost:8000';
const OUT = '/Users/gopinathgt/bsms/.verify';
for (const d of ['screenshots/desktop', 'screenshots/tablet', 'screenshots/mobile', 'reports', 'logs'])
  fs.mkdirSync(path.join(OUT, d), { recursive: true });

const report = { started: new Date().toISOString(), checks: [], jsErrors: [], failedRequests: [], shots: [] };
const check = (name, ok, detail = '') => {
  report.checks.push({ name, ok, detail });
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' · ' + detail : ''}`);
};

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1680, height: 1050 } });
  const page = await ctx.newPage();
  page.on('pageerror', e => report.jsErrors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') report.jsErrors.push('console: ' + m.text()); });
  // only the app's own origins count as failures (CDN font aborts in headless are noise)
  page.on('requestfailed', r => { if (/localhost:(7890|8000)/.test(r.url())) report.failedRequests.push(`${r.url()} → ${(r.failure() || {}).errorText}`); });
  const shot = async (rel) => { const p = path.join(OUT, 'screenshots', rel + '.png'); await page.screenshot({ path: p, fullPage: false }); report.shots.push(rel + '.png'); console.log('  📸 ' + rel); };

  // ── login via API + per-tab sessionStorage (matches js/api.js) ──
  await page.goto(FE);
  await page.evaluate(async (be) => {
    const r = await fetch(be + '/api/v1/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin123' }) });
    const d = await r.json();
    sessionStorage.setItem('bw_token', d.access_token);
    sessionStorage.setItem('bw_user', JSON.stringify({ id: d.user_id, name: d.name, role: d.role, branch_id: d.branch_id }));
  }, BE);
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('.side-link', { timeout: 30000 });
  check('admin portal loaded after login', true);

  // ════ 1. FLEET VIEW (desktop) ════
  console.log('— Bay Management · Fleet View —');
  await page.click('.side-link:has-text("Bay Management")');
  await page.waitForSelector('.fv-table', { timeout: 10000 });
  await page.waitForTimeout(1600);                       // first poll paints data
  const rows = await page.locator('.fv-row:not(.fv-head):not(.fv-skel)').count();
  check('fleet rows rendered', rows >= 5, `${rows} rows`);
  check('6 summary KPIs', (await page.locator('.fv-kpi').count()) === 6);
  const firstRowAttn = await page.locator('.fv-row:not(.fv-head)').first().getAttribute('class');
  check('attention bays sorted first', /attn/.test(firstRowAttn || ''));
  const unstaffed = await page.locator('.fv-nowkr').count();
  check('unstaffed bays flagged in list', unstaffed >= 2, `${unstaffed} unstaffed`);
  await shot('desktop/01-fleet-view');

  // search narrows
  await page.fill('.fv-search input', 'imran');
  await page.waitForTimeout(450);
  const after = await page.locator('.fv-row:not(.fv-head):not(.fv-skel)').count();
  check('search filters rows', after >= 1 && after < rows, `${rows} → ${after}`);
  await shot('desktop/02-fleet-search');
  await page.fill('.fv-search input', '');
  await page.waitForTimeout(450);

  // ════ 2. DETAILS DRAWER (staffed bay) ════
  console.log('— Drawer · staffed bay —');
  await page.click('.fv-row:not(.fv-head):has-text("BAY 03")');
  await page.waitForSelector('.fv-drawer .fv-dr-sec', { timeout: 8000 });
  await page.waitForTimeout(700);
  const drawer = await page.locator('.fv-drawer').innerText();
  check('drawer shows worker', /Imran Khan/.test(drawer));
  check('drawer shows camera section', /Camera/i.test(drawer));
  check('drawer shows ESP32/MQTT section', /ESP32/i.test(drawer));
  check('drawer has Replace Worker', /Replace Worker/.test(drawer));
  check('drawer has device actions', /Test Camera/.test(drawer));
  await shot('desktop/03-drawer-staffed');

  // Replace Worker modal
  await page.click('.fv-drawer button:has-text("Replace Worker")');
  await page.waitForSelector('.modal:has-text("Replace Worker · Bay 03")', { timeout: 6000 });
  await page.waitForTimeout(700);                        // modal pop-in animation
  const repHtml = await page.locator('.modal:has-text("Replace Worker")').innerText();
  check('replace modal: reason + dates (temp cover)', /reason/i.test(repHtml) && /until/i.test(repHtml));
  check('replace modal explains bay stays unchanged', /only the worker swaps/i.test(repHtml));
  await shot('desktop/04-replace-worker-modal');
  await page.click('.modal button:has-text("CANCEL")');
  await page.waitForTimeout(300);

  // ════ 2b. DRAWER — new operational sections + Escape ════
  console.log('— Drawer · sections + Escape —');
  await page.click('.fv-row:not(.fv-head):has-text("BAY 03")');
  await page.waitForSelector('.fv-drawer .fv-dr-sec', { timeout: 8000 });
  await page.waitForTimeout(600);
  const dtext = await page.locator('.fv-drawer').innerText();
  check('drawer: Bay Information section', /BAY INFORMATION/i.test(dtext));
  check('drawer: MQTT broker status row', /MQTT BROKER/i.test(dtext));
  check('drawer: Danger Zone section', /DANGER ZONE/i.test(dtext));
  // danger-zone confirmation flow (cancel — no state change)
  await page.click('.fv-drawer button:has-text("Disable Bay")');
  await page.waitForTimeout(250);
  check('danger action asks for confirmation', (await page.locator('.fv-confirm').count()) === 1);
  await page.click('.fv-confirm button:has-text("Cancel")');
  await shot('desktop/09-drawer-danger-zone');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(350);
  check('Escape closes the drawer', (await page.locator('.fv-drawer').count()) === 0);

  // ════ 3. DRAWER (unstaffed bay) ════
  console.log('— Drawer · unstaffed bay —');
  await page.click('.fv-row:not(.fv-head):has-text("BAY 05")');
  await page.waitForSelector('.fv-drawer .fv-dr-sec', { timeout: 8000 });
  await page.waitForTimeout(600);
  const d5 = await page.locator('.fv-drawer').innerText();
  check('unstaffed drawer: not-operational notice', /No primary worker/i.test(d5));
  check('unstaffed drawer: Assign Primary Worker action', /Assign Primary Worker/.test(d5));
  await shot('desktop/05-drawer-unstaffed');
  await page.click('.fv-drawer .modal-close');
  await page.waitForTimeout(300);

  // ════ 4. JOB ASSIGNMENT — bay-first, NO worker dropdown ════
  console.log('— Job Assignment · bay-first —');
  await page.click('.side-link:has-text("Job Assignment")');
  await page.waitForSelector('.job-create-card', { timeout: 8000 });
  await page.click('.job-create-card:has-text("Manual Job Card")');
  await page.waitForSelector('.jf-modal', { timeout: 6000 });
  await page.waitForTimeout(600);
  const modalTxt = await page.locator('.jf-modal').innerText();
  const modalHtml = await page.locator('.jf-modal').innerHTML();
  check('NO worker dropdown in job form', !modalHtml.includes('Select worker…'));
  check('bay-first picker present', modalHtml.includes('Select bay…'));
  check('BAY-FIRST tag visible', /BAY-FIRST/.test(modalTxt));
  // unstaffed bays disabled with reason
  const lockInfo = await page.evaluate(() => {
    const sel = [...document.querySelectorAll('.jf-modal select')]
      .find(s => [...s.options].some(o => o.text.includes('Select bay…')));
    const opts = [...sel.options].slice(1);
    return { total: opts.length, locked: opts.filter(o => o.disabled).length,
             lockedText: (opts.find(o => o.disabled) || {}).text || '',
             firstEnabled: (opts.find(o => !o.disabled) || {}).value };
  });
  check('unstaffed bays disabled in picker', lockInfo.locked >= 2, lockInfo.lockedText.trim());
  // choose a staffed bay → resolved panel appears
  await page.evaluate((v) => {
    const sel = [...document.querySelectorAll('.jf-modal select')]
      .find(s => [...s.options].some(o => o.text.includes('Select bay…')));
    sel.value = v;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  }, lockInfo.firstEnabled);
  await page.waitForTimeout(400);
  const resolved = await page.locator('.jf-modal .lja-bayres').innerText().catch(() => '');
  check('worker auto-resolves from bay', /auto-assigned from bay/.test(resolved), resolved.split('\n')[0]);
  await page.locator('.jf-modal .lja-bayres').scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await shot('desktop/06-bayfirst-job-modal');
  await page.click('.jf-modal button:has-text("CANCEL")');
  await page.waitForTimeout(300);

  // ════ 4b. SCALE — 50+ bays: virtual scrolling + sticky chrome ════
  console.log('— Scale · 52 bays (virtualization + sticky) —');
  const made = await page.evaluate(async (be) => {
    const tok = sessionStorage.getItem('bw_token');
    const ids = [];
    for (let i = 0; i < 45; i++) {
      const r = await fetch(be + '/api/v1/bays', { method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok },
        body: JSON.stringify({ name: `SCALE TEST ${i + 1}` }) });
      const d = await r.json();
      if (d && d.data && d.data.id) ids.push(d.data.id);
    }
    return ids;
  }, BE);
  check('45 scale-test bays created via API', made.length === 45);
  await page.click('.side-link:has-text("Bay Management")');
  await page.waitForSelector('.fv-table', { timeout: 8000 });
  await page.waitForTimeout(2500);                       // poll refresh
  const total = await page.evaluate(() => document.querySelector('.fv-kpi .v').textContent);
  const rendered = await page.locator('.fv-scroll .fv-row:not(.fv-skel)').count();
  check('fleet shows 52 bays', total === '52', `KPI total=${total}`);
  check('virtual scrolling active (DOM rows < total)', rendered < 45, `${rendered} rendered of 52`);
  // sticky: KPIs/toolbar/header must not move when the list scrolls
  const beforeBoxes = await page.evaluate(() => ({
    kpi: document.querySelector('.fv-kpis').getBoundingClientRect().y,
    bar: document.querySelector('.fv-toolbar').getBoundingClientRect().y,
    head: document.querySelector('.fv-head').getBoundingClientRect().y,
  }));
  await page.evaluate(() => { document.querySelector('.fv-scroll').scrollTop = 1500; });
  await page.waitForTimeout(450);
  const afterBoxes = await page.evaluate(() => ({
    kpi: document.querySelector('.fv-kpis').getBoundingClientRect().y,
    bar: document.querySelector('.fv-toolbar').getBoundingClientRect().y,
    head: document.querySelector('.fv-head').getBoundingClientRect().y,
  }));
  check('KPIs + toolbar + header stay fixed while list scrolls',
    beforeBoxes.kpi === afterBoxes.kpi && beforeBoxes.bar === afterBoxes.bar && beforeBoxes.head === afterBoxes.head);
  const renderedAfter = await page.locator('.fv-scroll .fv-row:not(.fv-skel)').count();
  check('window moves with scroll (still capped)', renderedAfter < 45, `${renderedAfter} rendered`);
  await shot('desktop/10-fleet-52-bays-virtualized');
  // cleanup: empty bays hard-delete
  const gone = await page.evaluate(async ({ be, ids }) => {
    const tok = sessionStorage.getItem('bw_token');
    let n = 0;
    for (const id of ids) {
      const r = await fetch(`${be}/api/v1/bays/${id}`, { method: 'DELETE',
        headers: { Authorization: 'Bearer ' + tok } });
      if (r.ok) n++;
    }
    return n;
  }, { be: BE, ids: made });
  check('scale-test bays cleaned up', gone === made.length, `${gone}/${made.length} deleted`);
  let totalBack = '';
  for (let i = 0; i < 6; i++) {            // wait for the next poll tick(s)
    await page.waitForTimeout(1500);
    totalBack = await page.evaluate(() => document.querySelector('.fv-kpi .v').textContent);
    if (totalBack === '7') break;
  }
  check('fleet back to 7 bays after cleanup', totalBack === '7', `total=${totalBack}`);

  // ════ 5. RESPONSIVE — tablet + mobile fleet view ════
  console.log('— Responsive —');
  await page.click('.side-link:has-text("Bay Management")');
  await page.waitForSelector('.fv-table', { timeout: 8000 });
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.waitForTimeout(900);
  await shot('tablet/07-fleet-tablet');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(900);
  await shot('mobile/08-fleet-mobile');
  await page.setViewportSize({ width: 1680, height: 1050 });

  // ════ report ════
  // benign noise filter: poller race right after login can 401 once before token applies
  const realJs = report.jsErrors.filter(e => !/favicon|Download the React DevTools/.test(e));
  check('zero JS errors', realJs.length === 0, realJs.slice(0, 3).join(' | '));
  check('zero failed API requests', report.failedRequests.length === 0, report.failedRequests.slice(0, 3).join(' | '));

  const passed = report.checks.filter(c => c.ok).length;
  report.finished = new Date().toISOString();
  report.summary = `${passed}/${report.checks.length} checks passed`;
  fs.writeFileSync(path.join(OUT, 'reports/report.json'), JSON.stringify(report, null, 2));
  const md = [`# UI Verification Report — ${report.finished}`, '',
    `**${report.summary}** · screenshots: ${report.shots.length}`, '',
    '| # | Check | Result | Detail |', '|---|---|---|---|',
    ...report.checks.map((c, i) => `| ${i + 1} | ${c.name} | ${c.ok ? '✅' : '❌'} | ${c.detail || ''} |`),
    '', '## JS errors', realJs.length ? realJs.map(e => '- ' + e).join('\n') : '_none_',
    '', '## Failed requests', report.failedRequests.length ? report.failedRequests.map(e => '- ' + e).join('\n') : '_none_',
    '', '## Screenshots', ...report.shots.map(s => `- screenshots/${s}`)].join('\n');
  fs.writeFileSync(path.join(OUT, 'reports/report.md'), md);
  console.log(`\n${'='.repeat(46)}\n${report.summary} · ${realJs.length} JS errors · ${report.failedRequests.length} failed requests\n${'='.repeat(46)}`);
  await browser.close();
  process.exit(report.checks.every(c => c.ok) ? 0 : 1);
})().catch(e => { console.error('PIPELINE ERROR:', e.message); process.exit(2); });
