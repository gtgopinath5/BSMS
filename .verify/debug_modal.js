const { chromium } = require('playwright');
const FE = 'http://localhost:7890', BE = 'http://localhost:8000';
(async () => {
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 1680, height: 1050 } })).newPage();
  page.on('pageerror', e => console.log('PAGEERROR:', e.message));
  page.on('console', m => { if (m.type() === 'error') console.log('CONSOLE:', m.text()); });
  await page.goto(FE);
  await page.evaluate(async (be) => {
    const r = await fetch(be + '/api/v1/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin123' }) });
    const d = await r.json();
    sessionStorage.setItem('bw_token', d.access_token);
    sessionStorage.setItem('bw_user', JSON.stringify({ id: d.user_id, name: d.name, role: d.role }));
  }, BE);
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('.side-link', { timeout: 30000 });
  await page.click('.side-link:has-text("Bay Management")');
  await page.waitForSelector('.fv-table'); await page.waitForTimeout(1600);
  await page.click('.fv-row:not(.fv-head):has-text("BAY 03")');
  await page.waitForSelector('.fv-drawer .fv-dr-sec'); await page.waitForTimeout(500);
  await page.click('.fv-drawer button:has-text("Replace Worker")');
  await page.waitForTimeout(900);
  const info = await page.evaluate(() => {
    const scrims = [...document.querySelectorAll('.modal-scrim')];
    return scrims.map(s => {
      const m = s.querySelector('.modal');
      const r = m && m.getBoundingClientRect();
      return { scrimClass: s.className, hasModal: !!m,
        modalClass: m && m.className,
        rect: r && { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        text: m && m.innerText.slice(0, 200),
        scrimStyle: getComputedStyle(s).position + '/' + getComputedStyle(s).display,
        modalOpacity: m && getComputedStyle(m).opacity };
    });
  });
  console.log(JSON.stringify(info, null, 2));
  await page.screenshot({ path: '/Users/gopinathgt/bsms/.verify/screenshots/desktop/debug-modal.png' });
  await browser.close();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
