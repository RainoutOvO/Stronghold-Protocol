// Focused persistence regression: seven ZIP assets are separated by unlisted blocks so a real Range request can
// pause after a complete Spine group has been written. Parser, writes, service worker, reload and keyboard are real.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../../server/index.js';
import { CHROME, hasChrome } from '../e2e/client.mjs';
import { buildGithubArchive, githubArchiveFixture, githubArchiveTransport } from './githubArchiveFixture.mjs';

test('verified files survive Esc and refresh; keyboard resume fills missing assets and completed refresh reads no ZIP', {
  skip: process.env.SP_E2E !== '1' || !hasChrome(), timeout: 90000,
}, async (t) => {
  const base = githubArchiveFixture();
  const files = [{ path: 'README.txt', bytes: Buffer.from('spaced ZIP fixture') }];
  for (const [path, entry] of base.entries) {
    if (!path.startsWith('public/')) continue;
    files.push({ path: `unlisted-${files.length}.bin`, bytes: Buffer.alloc(600 * 1024, 0x5a) });
    files.push({ path, bytes: entry.bytes, method: entry.method });
  }
  const archive = buildGithubArchive(files);
  const fixture = { ...base, ...archive, release: { ...base.release, size: archive.bytes.length } };
  const storedOffset = archive.entries.get('public/assets/preload/stored.png').dataOffset;
  const control = { hold: ({ start, end }) => start <= storedOffset && end >= storedOffset };
  const upstream = githubArchiveTransport(fixture, control);
  const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, assetIndex: false,
    assetReleaseLookup: async () => fixture.release, assetRelayTransport: upstream.transport });
  const served = srv.server.listeners('request')[0], artRequests = [];
  srv.server.removeAllListeners('request');
  srv.server.on('request', (req, res) => {
    const pathname = req.url.split('?')[0];
    if (['/data/assets.json', '/data/local-assets.json', '/data/local-fx.json'].includes(pathname)) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(pathname === '/data/assets.json' ? fixture.manifest : { groups: {} })); return;
    }
    if (fixture.served.has(pathname)) {
      artRequests.push(pathname); res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(fixture.served.get(pathname)); return;
    }
    served.call(srv.server, req, res);
  });
  const { default: puppeteer } = await import('puppeteer-core');
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--no-proxy-server'] });
  t.after(async () => { await browser.close(); srv.server.closeAllConnections(); await srv.close(); });
  const page = await browser.newPage(), errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    if (request.url() === fixture.release.url || request.url() === 'https://ghfast.top/' + fixture.release.url) {
      void request.abort('failed').catch(() => {});
    } else void request.continue().catch(() => {});
  });
  const chooseByKeyboard = async () => {
    await page.locator('[data-testid="asset-preload"]').click();
    await page.waitForFunction(() => document.activeElement?.getAttribute('data-testid') === 'asset-source-server');
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-testid')), 'asset-source-github');
    await page.keyboard.press('Enter');
    await page.waitForSelector('[data-testid="asset-github-progress"]');
  };
  const waitForComplete = async () => {
    await page.waitForFunction(async () => ['complete', 'partial', 'error', 'fallback'].includes(
      (await import('/js/assetGithubDownload.js')).assetGithubDownload.get().phase));
    const result = await page.evaluate(async () => (await import('/js/assetGithubDownload.js')).assetGithubDownload.get());
    assert.equal(result.phase, 'complete', JSON.stringify(result)); assert.equal(result.done, 7);
  };
  await page.goto(srv.url); await page.waitForFunction(() => navigator.serviceWorker.controller != null);
  await chooseByKeyboard();
  await page.waitForFunction(async (urls) => {
    const cache = await caches.open('sp-imported-assets-v1');
    return (await Promise.all(urls.map((url) => cache.match(url)))).every(Boolean);
  }, {}, fixture.modelUrls);
  assert.ok(control.release, 'the next real upstream Range is held after the verified group');
  await page.keyboard.press('Escape');
  await page.waitForSelector('.asset-preload', { hidden: true });
  assert.equal(await page.evaluate(async () => (await import('/js/assetGithubDownload.js')).assetGithubDownload.get().phase), 'paused');
  assert.equal(await page.evaluate(async () => (await import('/js/assetCache.js')).countImportedFiles()), 3);
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-testid')), 'asset-preload', 'closing restores title-entry focus');
  await page.reload(); await page.waitForFunction(() => navigator.serviceWorker.controller != null);
  assert.equal(await page.evaluate(async () => (await import('/js/assetGithubDownload.js')).assetGithubDownload.get().phase), 'idle', 'refresh does not restore a false completion flag');
  assert.equal(await page.evaluate(async () => (await import('/js/assetCache.js')).countImportedFiles()), 3);
  control.hold = null;
  await chooseByKeyboard(); await waitForComplete();
  assert.equal(await page.evaluate(async () => (await import('/js/assetCache.js')).countImportedFiles()), 7);
  const reads = upstream.requests.length;
  await page.keyboard.press('Escape'); await page.reload(); await page.waitForFunction(() => navigator.serviceWorker.controller != null);
  await chooseByKeyboard(); await waitForComplete();
  assert.equal(upstream.requests.length, reads, 'completed refresh verifies real cache without another archive read');
  const width = await page.evaluate(async (url) => {
    const image = new Image(); image.src = url; await image.decode(); return image.naturalWidth;
  }, fixture.image);
  assert.equal(width, 1); assert.equal(artRequests.length, 0, 'actual renderer requests still reuse the worker cache after refresh');
  assert.deepEqual(errors, []);
  t.diagnostic(JSON.stringify({ archiveBytes: fixture.bytes.length, requests: reads,
    upstreamBytes: upstream.requests.reduce((sum, request) => sum + request.end - request.start + 1, 0) }));
});
