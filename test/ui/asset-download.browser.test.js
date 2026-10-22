// SP_E2E=1 CHROME_PATH=<chrome> node --test test/ui/asset-download.browser.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer } from '../../server/index.js';
import { hash16 } from '../../server/http/assetIndex.js';
import { CHROME, hasChrome } from '../e2e/client.mjs';
import { assetPreloadScreenshots } from './assetPreloadScreenshots.mjs';

test('unified preload sources, visible failure/retry, pause, cache reuse and responsive placement', {
  skip: process.env.SP_E2E !== '1' || !hasChrome(), timeout: 90000,
}, async (t) => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
  const image = `/assets/~${hash16(png)}/download-test.png`;
  const missing = '/assets/download-test-missing.png';
  let fixed = false, hanging = false;
  const counts = new Map();
  const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, assetIndex: false, assetPreloadRecommended: 'server' });
  // Keep synthetic responses on the actual HTTP server so browser caching stays enabled.
  const serve = srv.server.listeners('request')[0];
  srv.server.removeAllListeners('request');
  srv.server.on('request', (req, res) => {
    const url = req.url;
    if (url === '/asset-preload/github.json') { res.setHeader('Content-Type', 'application/json'); res.end('null'); return; }
    if (url === '/data/assets.json' || url === '/data/local-assets.json' || url === '/data/local-fx.json') {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      // (local-fx.json: the host's official battle effects, DESIGN §33 — none in this fixture)
      res.end(JSON.stringify(url === '/data/assets.json' ? { files: [image, missing] } : { groups: {} }));
      return;
    }
    if (url === image || url === missing) {
      counts.set(url, (counts.get(url) || 0) + 1);
      if (hanging && url === missing) return;
      const ok = url === image || fixed;
      res.writeHead(ok ? 200 : 404, { 'Content-Type': 'image/png', 'Cache-Control': ok ? 'public, max-age=3600' : 'no-store' });
      res.end(ok ? png : 'missing');
      return;
    }
    serve.call(srv.server, req, res);
  });
  t.after(() => { srv.server.closeAllConnections(); return srv.close(); });
  const { default: puppeteer } = await import('puppeteer-core');
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(srv.url);
  await page.waitForSelector('[data-testid="asset-preload"]');
  assert.equal(counts.size, 0, 'opening the homepage does not download the asset pack');
  assert.equal(await page.$('[data-testid="asset-download"]'), null, 'the old download entry is merged');
  assert.equal(await page.$('[data-testid="asset-import"]'), null, 'the old import entry is merged');
  if (process.env.SP_ASSET_SCREENSHOTS) {
    fs.mkdirSync(process.env.SP_ASSET_SCREENSHOTS, { recursive: true });
    await new Promise((resolve) => setTimeout(resolve, 500));
    await page.screenshot({ path: path.join(process.env.SP_ASSET_SCREENSHOTS, 'title.png') });
  }
  await page.click('[data-testid="asset-preload"]');
  await page.waitForSelector('[data-testid="asset-source-server"]');
  assert.deepEqual(await page.$$eval('[data-testid="asset-preload-sources-list"] button', (buttons) => buttons.map((button) => button.dataset.testid)),
    ['asset-source-server', 'asset-source-github', 'asset-source-import']);
  await page.waitForFunction(() => document.querySelector('[data-testid="asset-source-server"]')?.textContent.includes('推荐'));
  assert.equal(await page.$eval('[data-testid="asset-source-github"]', (button) => button.disabled), false);
  assert.equal(await page.$('[data-testid="asset-github-progress"]'), null, 'opening has not started the GitHub task');
  assert.equal(await page.$$eval('[data-testid="asset-preload-sources-list"] button p', (els) => els.length), 0,
    'source buttons have no explanatory subtitles');
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid^="asset-source-"]')]
    .every((button) => button.getBoundingClientRect().height >= 44));
  assert.ok(await page.$$eval('[data-testid^="asset-source-"]', (buttons) => buttons.every((button) => {
    const rect = button.getBoundingClientRect();
    return button.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
  })), 'every visible source centre hits its own button, including touch hit areas');
  assert.equal(counts.size, 0, 'opening the preloader only chooses a source');
  assert.ok(await page.$eval('[role="dialog"]', (box) => box.contains(document.activeElement)), 'focus stays in the dialog');
  await page.mouse.click(1, 1);
  assert.ok(await page.$('.asset-preload'), 'the backdrop does not dismiss the dialog');
  await page.keyboard.press('Tab');
  assert.ok(await page.$eval('[role="dialog"]', (box) => box.contains(document.activeElement)), 'keyboard focus remains trapped');
  await assetPreloadScreenshots(page, 'sources');
  await page.locator('[data-testid="asset-source-server"]').click();
  await page.waitForFunction(() => document.querySelector('[data-testid="asset-download-status"]')?.textContent.includes('1 个素材下载失败'));
  assert.equal(await page.$eval('.asset-download [role="progressbar"]', (el) => el.getAttribute('aria-valuenow')), '1');
  assert.match(await page.$eval('.asset-download', (el) => el.textContent), /已就绪 1，缺少 1/);
  assert.equal(counts.get(image), 1);
  fixed = true;
  await page.click('[data-testid="asset-download-resume"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="asset-download-status"]')?.textContent.includes('本次素材下载完成'));
  assert.match(await page.$eval('.asset-download', (el) => el.textContent), /已就绪 2，缺少 0/);
  await assetPreloadScreenshots(page, 'server');
  assert.equal(counts.get(image), 1, 'retry does not transfer a successful file again');
  assert.equal(await page.evaluate((url) => new Promise((resolve) => {
    const img = new Image(); img.onload = () => resolve(img.naturalWidth); img.onerror = () => resolve(0); img.src = url;
  }), image), 1);
  assert.equal(counts.get(image), 1, 'the renderer Image request reuses the downloaded HTTP cache');
  if (process.env.SP_ASSET_SCREENSHOTS) {
    fs.mkdirSync(process.env.SP_ASSET_SCREENSHOTS, { recursive: true });
    await new Promise((resolve) => setTimeout(resolve, 500));
    await page.screenshot({ path: path.join(process.env.SP_ASSET_SCREENSHOTS, 'complete.png') });
  }
  await page.keyboard.press('Escape');
  await page.reload();
  await page.waitForSelector('[data-testid="asset-preload"]');
  const beforeReloadCheck = new Map(counts);
  await page.click('[data-testid="asset-preload"]');
  assert.equal(await page.$('[data-testid="asset-download-status"]'), null, 'reload does not trust historical completion');
  await page.locator('[data-testid="asset-source-server"]').click();
  await page.waitForFunction(() => document.querySelector('[data-testid="asset-download-status"]')?.textContent.includes('本次素材下载完成'));
  assert.match(await page.$eval('.asset-download', (el) => el.textContent), /已就绪 2，缺少 0/);
  assert.deepEqual(counts, beforeReloadCheck, 'a fresh queue after reload reuses the HTTP cache');
  await page.keyboard.press('Escape');
  // The one title entry stays in the viewport, uncovered and above the footer on desktop and a landscape phone.
  for (const viewport of [{ width: 1280, height: 900 }, { width: 844, height: 390 }]) {
    await page.setViewport(viewport);
    const box = (sel) => page.$eval(sel, (el) => {
      const b = el.getBoundingClientRect();
      return { left: b.left, top: b.top, right: b.right, bottom: b.bottom,
        visible: el.contains(document.elementFromPoint((b.left + b.right) / 2, (b.top + b.bottom) / 2)) };
    });
    const preload = await box('[data-testid="asset-preload"]');
    assert.ok(preload.left >= 0 && preload.right <= viewport.width && preload.top >= 0 && preload.bottom <= viewport.height, JSON.stringify(preload));
    assert.ok(preload.visible, 'the preload entry is not covered');
    const foot = await page.$eval('.title-foot', (el) => [...el.children].map((c) => c.getBoundingClientRect())
      .filter((b) => b.width > 0).map((b) => ({ top: b.top, left: b.left, right: b.right })));
    const block = await page.$eval('.title-assets', (el) => el.getBoundingClientRect().toJSON());
    for (const f of foot) {
      const across = f.left < block.right && f.right > block.left;
      assert.ok(!across || block.bottom <= f.top, `the preload entry stays above the footer ${JSON.stringify({ block, f })}`);
    }
    await page.click('[data-testid="asset-preload"]');
    const close = await box('[data-testid="asset-preload-close"]');
    assert.ok(close.visible && close.top >= 0 && close.bottom <= viewport.height, 'the dialog close control fits the viewport');
    if (process.env.SP_ASSET_SCREENSHOTS) await page.screenshot({ path: path.join(process.env.SP_ASSET_SCREENSHOTS, `dialog-${viewport.width}.png`) });
    await page.keyboard.press('Escape');
    if (process.env.SP_ASSET_SCREENSHOTS) await page.screenshot({ path: path.join(process.env.SP_ASSET_SCREENSHOTS, `title-${viewport.width}.png`) });
  }
  // A new browser context has an empty HTTP cache. Closing the dialog must stop a hanging request.
  const context = await browser.createBrowserContext();
  const other = await context.newPage();
  other.on('pageerror', (error) => errors.push(error.message));
  hanging = true;
  await other.goto(srv.url);
  await other.evaluate(() => {
    globalThis.__preloadClicks = [];
    document.addEventListener('click', (event) => globalThis.__preloadClicks.push(event.target.closest('button')?.dataset.testid));
  });
  await other.click('[data-testid="asset-preload"]');
  await other.locator('[data-testid="asset-source-server"]').click();
  await other.waitForFunction(async (size) => (await import('/js/assetDownload.js')).assetDownload.get().bytes === size, {}, png.length)
    .catch(async (error) => { error.message += '\nstate: ' + JSON.stringify(await other.evaluate(async () => ({
      queue: (await import('/js/assetDownload.js')).assetDownload.get(), clicks: globalThis.__preloadClicks,
      ui: document.querySelector('.asset-preload')?.textContent,
    }))); throw error; });
  await other.click('[data-testid="asset-download-pause"]');
  await other.waitForFunction(async () => (await import('/js/assetDownload.js')).assetDownload.get().phase === 'paused');
  assert.equal(await other.evaluate(async () => (await import('/js/assetDownload.js')).assetDownload.get().done), 1);
  await other.click('[data-testid="asset-download-resume"]');
  await other.waitForFunction(async () => (await import('/js/assetDownload.js')).assetDownload.get().phase === 'downloading');
  await other.keyboard.press('Escape');
  await other.waitForFunction(() => !document.querySelector('.asset-preload'));
  assert.equal(await other.evaluate(async () => (await import('/js/assetDownload.js')).assetDownload.get().phase), 'paused',
    'Escape while transferring pauses before closing');
  assert.equal(await other.evaluate(async () => (await import('/js/assetDownload.js')).assetDownload.get().done), 1);
  hanging = false;
  const beforeReopen = new Map(counts);
  await other.click('[data-testid="asset-preload"]');
  await other.waitForSelector('[data-testid="asset-download-resume"]');
  assert.deepEqual(counts, beforeReopen, 'reopening does not automatically resume a paused queue');
  await other.click('[data-testid="asset-download-resume"]');
  await other.waitForFunction(() => document.querySelector('[data-testid="asset-download-status"]')?.textContent.includes('本次素材下载完成'));
  assert.match(await other.$eval('.asset-download', (el) => el.textContent), /已就绪 2，缺少 0/);

  // A real local import plus one network success must both count as ready (#725).
  const mixedContext = await browser.createBrowserContext();
  const mixed = await mixedContext.newPage();
  await mixed.goto(srv.url);
  const imported = await mixed.evaluate(async (bytes) => {
    const { createAssetImport } = await import('/js/assetPack.js');
    const importer = createAssetImport();
    await importer.start({ type: 'files', files: [{ path: 'public/assets/download-test.png', read: async () => new Uint8Array(bytes) }] });
    return importer.get();
  }, [...png]);
  assert.equal(imported.accepted, 1);
  const beforeMixed = new Map(counts);
  await mixed.click('[data-testid="asset-preload"]');
  await mixed.locator('[data-testid="asset-source-server"]').click();
  await mixed.waitForFunction(() => document.querySelector('[data-testid="asset-download-status"]')?.textContent.includes('本次素材下载完成'));
  assert.equal(counts.get(image), beforeMixed.get(image), 'the imported file is not fetched');
  assert.equal(counts.get(missing), beforeMixed.get(missing) + 1, 'the remaining file comes from the server');
  assert.deepEqual(await mixed.evaluate(async () => {
    const { cached, done } = (await import('/js/assetDownload.js')).assetDownload.get();
    return { cached, done };
  }), { cached: 1, done: 2 });
  assert.match(await mixed.$eval('.asset-download', (el) => el.textContent), /已就绪 2，缺少 0/);
  assert.deepEqual(errors, []);
});
