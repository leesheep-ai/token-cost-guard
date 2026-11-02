import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const stage = process.argv[2] || 'after';
if (!/^[a-z0-9-]+$/.test(stage)) throw new Error('Invalid report label');
const out = path.join(here, 'evidence', stage);
await mkdir(out, { recursive: true });
const baseline = stage === 'before';
const siteRoot = process.env.QA_SITE_ROOT && path.resolve(process.env.QA_SITE_ROOT);
const files = baseline
  ? { '/': path.join(here, 'evidence/before/source/landing.html'), '/demo/': path.join(here, 'evidence/before/source/demo.html') }
  : { '/': path.join(siteRoot || path.join(root, 'token-cost-guard-site'), 'index.html'), '/demo/': siteRoot ? path.join(siteRoot, 'demo/index.html') : path.join(root, 'token-cost-guard/index.html') };
await Promise.all(Object.values(files).map(file => access(file)));
const server = createServer(async (req, res) => {
  const file = files[req.url];
  if (!file) { res.writeHead(404); res.end('Not found'); return; }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(await readFile(file));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({
  ...(process.env.QA_CHROME_PATH ? { executablePath: process.env.QA_CHROME_PATH } : {}),
  headless: true,
});
const results = [];
async function check(id, name, fn, options = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, ...options });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await fn(page, context);
    assert.deepEqual(errors, [], 'Uncaught browser errors');
    results.push({ id, name, passed: true });
  } catch (error) {
    results.push({ id, name, passed: false, error: error.message, pageErrors: errors });
  }
  await page.screenshot({ path: path.join(out, `${id}.png`), fullPage: true });
  await context.close();
}
async function upload(page, content, filename = 'usage.json') {
  await page.locator('#file').setInputFiles({ name: filename, mimeType: filename.endsWith('.json') ? 'application/json' : 'text/csv', buffer: Buffer.from(content) });
  await page.waitForFunction(() => !document.querySelector('#status').textContent.startsWith('Expected columns:'));
}
async function report(page) {
  assert.equal(await page.locator('#exportBtn').isEnabled(), true, 'Export should be available');
  const wait = page.waitForEvent('download');
  await page.locator('#exportBtn').click();
  const download = await wait;
  return JSON.parse(await readFile(await download.path(), 'utf8'));
}
try {
  await check('TC01', 'Known-price sample exports the independently calculated $1.722', async page => {
    await page.goto(`${origin}/demo/`);
    await page.locator('#sampleBtn').click();
    const data = await report(page);
    assert.ok(Math.abs(data.total_cost_usd - 1.722) < 1e-10);
    assert.equal(data.total_input_tokens, 344000);
    assert.equal(data.total_output_tokens, 73000);
    assert.equal(data.requests.length, 3);
  });
  await check('TC02', 'Unknown model cost remains unknown in screen and export', async page => {
    await page.goto(`${origin}/demo/`);
    await upload(page, JSON.stringify([{ model: 'unpriced-model', input_tokens: 1000000, output_tokens: 1000000 }]));
    const data = await report(page);
    assert.equal(data.total_cost_usd, null, 'An unpriced request must not be reported as free');
    assert.deepEqual(data.unpriced_models, ['unpriced-model']);
    assert.match(await page.locator('#metrics').innerText(), /incomplete|unpriced|unknown/i);
  });
  await check('TC03', 'Negative token counts are rejected with an explanation', async page => {
    await page.goto(`${origin}/demo/`);
    await upload(page, '[{"model":"gpt-4o","input_tokens":-1000,"output_tokens":12}]');
    assert.equal(await page.locator('#exportBtn').isEnabled(), false, 'Invalid counts must not create a report');
    assert.match(await page.locator('#status').innerText(), /token|non-negative/i);
  });
  await check('TC04', 'Non-numeric token counts are rejected', async page => {
    await page.goto(`${origin}/demo/`);
    await upload(page, '[{"model":"gpt-4o","input_tokens":"invalid","output_tokens":12}]');
    assert.equal(await page.locator('#exportBtn').isEnabled(), false, 'Invalid text must not be coerced to zero');
  });
  await check('TC05', 'Malformed stored pricing does not break startup', async (page, context) => {
    await context.addInitScript(() => localStorage.setItem('tcg-pricing', '{broken'));
    await page.goto(`${origin}/demo/`);
    await page.locator('#sampleBtn').click();
    assert.equal(await page.locator('#exportBtn').isEnabled(), true, 'Page should recover from damaged settings');
  });
  await check('TC06', 'CSV quoted newlines preserve request boundaries', async page => {
    await page.goto(`${origin}/demo/`);
    await upload(page, 'model,input_tokens,output_tokens,request_id\r\ngpt-4o,1000,100,"line1\nline2"\r\n', 'usage.csv');
    const data = await report(page);
    assert.equal(data.requests.length, 1);
    assert.equal(data.total_input_tokens, 1000);
  });
  await check('TC07', 'Nested JSON usage preserves parent model', async page => {
    await page.goto(`${origin}/demo/`);
    await upload(page, '{"model":"gpt-4o","usage":{"prompt_tokens":1000,"completion_tokens":100}}');
    const data = await report(page);
    assert.equal(data.requests[0].model, 'gpt-4o');
    assert.equal(data.total_input_tokens, 1000);
    assert.ok(Math.abs(data.total_cost_usd - .0035) < 1e-10);
  });
  await check('TC08', '320px viewport has no page-wide horizontal overflow', async page => {
    await page.goto(`${origin}/demo/`);
    await page.locator('#sampleBtn').click();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  }, { viewport: { width: 320, height: 800 } });
  await check('TC09', 'Landing page has no placeholder checkout link', async page => {
    await page.goto(origin);
    assert.equal(await page.locator('a[href*="YOUR_"]').count(), 0, 'Checkout placeholder is visible to visitors');
  });
  await check('TC10', 'Usage content produces no external network requests', async page => {
    const external = [];
    page.on('request', req => { if (!req.url().startsWith(origin) && !req.url().startsWith('blob:')) external.push(req.url()); });
    await page.goto(`${origin}/demo/`);
    await upload(page, '[{"model":"gpt-4o","input_tokens":1000,"output_tokens":100}]');
    await report(page);
    assert.deepEqual(external, []);
  });
  await check('TC11', 'Model names cannot inject markup or poison aggregation', async page => {
    await page.goto(`${origin}/demo/`);
    await upload(page, JSON.stringify(['__proto__', 'constructor', '<img src=x onerror="window.injected=1">'].map(model => ({model, input_tokens: 1, output_tokens: 1}))));
    const data = await report(page);
    assert.equal(data.requests.length, 3);
    assert.equal(data.total_cost_usd, null);
    assert.equal(await page.locator('#rows img').count(), 0);
    assert.equal(await page.evaluate(() => window.injected), undefined);
  });
  await check('TC12', 'Adding a model requires explicit prices before costing', async page => {
    await page.goto(`${origin}/demo/`);
    page.once('dialog', d => d.accept('new-model'));
    await page.locator('#addModel').click();
    await upload(page, '[{"model":"new-model","input_tokens":1000000,"output_tokens":1000000}]');
    assert.equal((await report(page)).total_cost_usd, null);
    await page.locator('input[data-model="new-model"][data-kind="input"]').fill('0');
    await page.locator('input[data-model="new-model"][data-kind="input"]').dispatchEvent('change');
    await page.locator('input[data-model="new-model"][data-kind="output"]').fill('0');
    await page.locator('input[data-model="new-model"][data-kind="output"]').dispatchEvent('change');
    assert.equal((await report(page)).total_cost_usd, 0, 'Explicit free pricing is valid');
  });
  await check('TC13', 'Clearing a price makes a previously costed report incomplete', async page => {
    await page.goto(`${origin}/demo/`);
    await page.locator('#sampleBtn').click();
    const field = page.locator('input[data-model="gpt-4o"][data-kind="input"]');
    await field.fill(''); await field.dispatchEvent('change');
    const data = await report(page);
    assert.equal(data.total_cost_usd, null);
    assert.ok(Math.abs(data.known_cost_usd - .507) < 1e-10, 'Still retain the known model subtotal');
  });
  await check('TC14', 'Unterminated CSV quote is rejected', async page => {
    await page.goto(`${origin}/demo/`);
    await upload(page, 'model,input_tokens,output_tokens\ngpt-4o,100,"200', 'usage.csv');
    assert.equal(await page.locator('#exportBtn').isEnabled(), false);
    assert.match(await page.locator('#status').innerText(), /quote/i);
  });
  await check('TC15', 'Disabled storage still permits import and price editing', async (page, context) => {
    await context.addInitScript(() => {
      Storage.prototype.getItem = () => { throw new DOMException('Blocked', 'SecurityError'); };
      Storage.prototype.setItem = () => { throw new DOMException('Blocked', 'SecurityError'); };
    });
    await page.goto(`${origin}/demo/`);
    await page.locator('#sampleBtn').click();
    const field = page.locator('input[data-model="gpt-4o"][data-kind="input"]');
    if (await field.count() !== 1) throw new Error('Pricing editor unavailable after blocked storage');
    await field.fill('5'); await field.dispatchEvent('change');
    assert.ok(Math.abs((await report(page)).total_cost_usd - 2.397) < 1e-10);
  });
} finally {
  const data = { stage, testedAt: new Date().toISOString(), browser: browser.version(), node: process.version, platform: process.platform, scope: 'Owned local Token Cost Guard; synthetic data only; not a client engagement', passed: results.filter(r => r.passed).length, total: results.length, results };
  await writeFile(path.join(out, 'results.json'), JSON.stringify(data, null, 2) + '\n');
  console.log(JSON.stringify(data, null, 2));
  await browser.close();
  server.close();
}
if (results.some(r => !r.passed)) process.exitCode = 1;
