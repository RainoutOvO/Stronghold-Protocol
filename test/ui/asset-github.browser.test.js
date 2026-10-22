// SP_E2E=1: real ZIP parser, hashes, Spine groups, Cache Storage, service worker and HTTP relay.
// Public upstream bytes are controlled; parser/storage/worker and user clicks are not mocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../../server/index.js';
import { CHROME, hasChrome } from '../e2e/client.mjs';
import { githubArchiveFixture, githubArchiveTransport } from './githubArchiveFixture.mjs';
import { assetPreloadScreenshots } from './assetPreloadScreenshots.mjs';

test('one-click GitHub imports real ZIP bytes automatically and fails honestly', {
  skip: process.env.SP_E2E !== '1' || !hasChrome(), timeout: 240000,
}, async (t) => {
  const { default: puppeteer } = await import('puppeteer-core');
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true,
    args: ['--no-sandbox', '--no-proxy-server', '--mute-audio'] });
  t.after(() => browser.close());
  async function setup(st, { corrupt, control = {}, country = null, publicCors = false, cspSelf = false, quota = false, preference, mirrorId } = {}) {
    const fixture = githubArchiveFixture({ corrupt });
    const upstream = githubArchiveTransport(fixture, control);
    const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, assetIndex: false,
      assetReleaseLookup: async () => fixture.release, assetRelayTransport: upstream.transport,
      assetPreloadMirrors: [{ id: 'trusted', label: 'Trusted', prefix: 'https://mirror.example/' }] });
    st.after(() => srv.close());
    const served = srv.server.listeners('request')[0], artRequests = [];
    srv.server.removeAllListeners('request');
    srv.server.on('request', (req, res) => {
      if (cspSelf) {
        const setHeader = res.setHeader;
        res.setHeader = function (name, value) {
          return setHeader.call(this, name, name.toLowerCase() === 'content-security-policy'
            ? String(value).replace(/connect-src[^;]*/, "connect-src 'self'") : value);
        };
      }
      const pathname = req.url.split('?')[0];
      if (['/data/assets.json', '/data/local-assets.json', '/data/local-fx.json'].includes(pathname)) {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(pathname === '/data/assets.json' ? fixture.manifest : { groups: {} })); return;
      }
      if (pathname === '/asset-preload/github.json') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ ...fixture.release, country, relay: { enabled: true, maxRangeBytes: 8388608,
          mirrors: [{ id: 'trusted', label: 'Trusted' }] } })); return;
      }
      if (fixture.served.has(pathname)) {
        artRequests.push(pathname);
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' });
        res.end(fixture.served.get(pathname)); return;
      }
      served.call(srv.server, req, res);
    });
    const context = await browser.createBrowserContext(); st.after(() => context.close());
    const page = await context.newPage(), routes = [], errors = [], messages = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => messages.push(message.text()));
    const fileDialogs = [], cdp = await page.createCDPSession();
    await cdp.send('Page.enable');
    await cdp.send('Page.setInterceptFileChooserDialog', { enabled: true });
    cdp.on('Page.fileChooserOpened', (event) => fileDialogs.push(event));
    st.after(() => assert.deepEqual(fileDialogs, [], 'GitHub never opens a file chooser'));
    await page.evaluateOnNewDocument((pref, mirror, full) => {
      if (pref) localStorage.setItem('sp.pref.assetGithubRoute', pref);
      if (mirror) localStorage.setItem('sp.pref.assetGithubMirror', mirror);
      if (full) Cache.prototype.put = async function () { throw new DOMException('controlled full disk', 'QuotaExceededError'); };
    }, preference, mirrorId, quota);
    await page.setRequestInterception(true);
    page.on('request', async (request) => {
      if (request.url().startsWith(fixture.release.url) || request.url().startsWith('https://ghfast.top/' + fixture.release.url)) {
        routes.push(request.url());
        assert.equal(request.headers().cookie, undefined); assert.equal(request.headers().authorization, undefined);
        const match = /^bytes=(\d+)-(\d+)$/.exec(request.headers().range || '');
        const start = Number(match?.[1] || 0), end = Number(match?.[2] || fixture.bytes.length - 1);
        await request.respond({ status: 206, contentType: 'application/zip', body: fixture.bytes.subarray(start, end + 1), headers: {
          'Content-Range': `bytes ${start}-${end}/${fixture.bytes.length}`,
          ...(publicCors ? { 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'Content-Range, Content-Length, ETag' } : {}),
        } }).catch(() => {});
      } else await request.continue().catch(() => {});
    });
    await page.goto(srv.url);
    await page.waitForFunction(() => navigator.serviceWorker.controller != null);
    await page.locator('[data-testid="asset-preload"]').click();
    assert.equal(routes.length, 0); assert.equal(upstream.requests.length, 0, 'opening never reads archive bytes');
    return { fixture, upstream, page, routes, errors, messages, artRequests, control };
  }
  const state = (page) => page.evaluate(async () => (await import('/js/assetGithubDownload.js')).assetGithubDownload.get());
  const finish = async (page) => {
    await page.waitForFunction(async () => ['complete', 'partial', 'error', 'fallback'].includes(
      (await import('/js/assetGithubDownload.js')).assetGithubDownload.get().phase));
    return state(page);
  };
  const click = (page) => page.locator('[data-testid="asset-source-github"]').click();
  for (const country of ['CN', 'US', null]) await t.test(`CORS failure to relay to real worker hit (${country || 'unknown'})`, async (st) => {
    const x = await setup(st, { country }), started = Date.now(); await click(x.page);
    const result = await finish(x.page);
    assert.equal(result.phase, 'complete', JSON.stringify(result)); assert.equal(result.done, 7);
    assert.equal(result.transport, 'relay'); assert.equal(result.line, country === 'CN' ? 'ghfast' : 'direct');
    assert.equal(x.routes[0], country === 'CN' ? 'https://ghfast.top/' + x.fixture.release.url : x.fixture.release.url);
    assert.ok(x.messages.some((message) => /CORS|Access-Control-Allow-Origin/.test(message)), 'Chrome enforces missing CORS');
    assert.equal(await x.page.$('[data-testid="asset-github-progress"] input[type="file"]'), null);
    assert.equal(await x.page.$eval('.asset-preload__advanced', (el) => el.open), false);
    const before = x.artRequests.length;
    const hit = await x.page.evaluate(async (url) => {
      const response = await fetch(url, { cache: 'no-store' }), bytes = await response.arrayBuffer();
      const image = new Image(); image.src = url; await image.decode();
      return { length: bytes.byteLength, width: image.naturalWidth };
    }, x.fixture.image);
    assert.deepEqual(hit, { length: x.fixture.served.get(x.fixture.image).length, width: 1 });
    assert.equal(x.artRequests.length, before, 'game image actually hits worker cache without server art');
    const reads = x.upstream.requests.length, publicReads = x.routes.length;
    await x.page.locator('[data-testid="asset-github-resume"]').click();
    assert.equal((await finish(x.page)).phase, 'complete');
    assert.equal(x.upstream.requests.length, reads); assert.equal(x.routes.length, publicReads, 'verified cache skips ZIP fetch entirely');
    st.diagnostic(JSON.stringify({ milliseconds: Date.now() - started, archiveBytes: x.fixture.bytes.length,
      relayBytes: x.upstream.requests.reduce((sum, request) => sum + request.end - request.start + 1, 0), reads }));
    if (country === 'CN') {
      await x.page.setViewport({ width: 844, height: 390 }); await assetPreloadScreenshots(x.page, 'github-automatic');
      await x.page.reload();
      await x.page.waitForFunction(() => navigator.serviceWorker.controller != null);
      await x.page.locator('[data-testid="asset-preload"]').click();
      assert.equal(x.upstream.requests.length, reads, 'refresh/open do not automatically repeat the archive');
      await click(x.page); assert.equal((await finish(x.page)).phase, 'complete');
      assert.equal(x.upstream.requests.length, reads, 'fresh verification after refresh reuses actual saved bytes');
      assert.equal(x.routes.length, publicReads);
    }
    assert.deepEqual(x.errors, []);
  });
  await t.test('readable public CORS route uses no server bandwidth', async (st) => {
    const x = await setup(st, { publicCors: true }); await click(x.page);
    assert.equal((await finish(x.page)).phase, 'complete'); assert.equal(x.upstream.requests.length, 0);
  });
  await t.test('Range-ignoring upstream streams one ZIP to disk and imports automatically', async (st) => {
    const x = await setup(st, { control: { noRange: true } }); await click(x.page);
    assert.equal((await finish(x.page)).phase, 'complete');
    assert.equal(x.upstream.requests.length, 1, 'whole-file preparation is shared by all requested ZIP ranges');
    assert.equal(x.artRequests.length, 0);
  });
  await t.test('an outer self-only CSP still permits safe same-origin fallback', async (st) => {
    const x = await setup(st, { cspSelf: true }); await click(x.page);
    assert.equal((await finish(x.page)).phase, 'complete');
    assert.ok(x.messages.some((message) => /Content Security Policy|connect-src/.test(message)));
    assert.ok(x.upstream.requests.length > 0);
  });
  await t.test('automatic routing switches away from a failed ghfast relay', async (st) => {
    const x = await setup(st, { country: 'CN', control: { offline: ({ url }) => url.startsWith('https://ghfast.top/') } });
    await click(x.page); const result = await finish(x.page);
    assert.equal(result.phase, 'complete'); assert.equal(result.line, 'direct');
    assert.ok(x.upstream.requests.some((request) => request.url.startsWith('https://ghfast.top/')));
    assert.ok(x.upstream.requests.some((request) => request.url === x.fixture.release.url));
  });
  await t.test('always-direct override never silently contacts a mirror', async (st) => {
    const x = await setup(st, { country: 'CN', preference: 'direct' }); await click(x.page);
    assert.equal((await finish(x.page)).phase, 'complete');
    assert.ok(x.routes.every((url) => url === x.fixture.release.url));
    assert.ok(x.upstream.requests.every((request) => request.url === x.fixture.release.url));
  });
  await t.test('custom choice uses only a configured trusted mirror ID', async (st) => {
    const x = await setup(st, { preference: 'custom', mirrorId: 'trusted' }); await click(x.page);
    assert.equal((await finish(x.page)).phase, 'complete'); assert.equal(x.routes.length, 0);
    assert.ok(x.upstream.requests.every((request) => request.url === 'https://mirror.example/' + x.fixture.release.url));
  });
  for (const corrupt of ['zip', 'crc', 'hash', 'spine']) await t.test(`damaged ${corrupt} is never complete`, async (st) => {
    const x = await setup(st, { corrupt }); await click(x.page); const result = await finish(x.page);
    assert.ok(['partial', 'error'].includes(result.phase), JSON.stringify(result)); assert.ok(result.done < result.total);
    if (corrupt === 'spine') assert.equal(await x.page.evaluate(async (urls) => {
      const cache = await caches.open('sp-imported-assets-v1');
      return (await Promise.all(urls.map((url) => cache.match(url)))).filter(Boolean).length;
    }, x.fixture.modelUrls), 0, 'no mismatched Spine member is trusted');
  });
  await t.test('storage quota error cannot publish success', async (st) => {
    const x = await setup(st, { quota: true }); await click(x.page); const result = await finish(x.page);
    assert.equal(result.phase, 'error'); assert.equal(result.done, 0);
    assert.match(await x.page.$eval('[data-testid="asset-github-status"]', (el) => el.textContent), /失败/);
  });
  await t.test('interrupted network stops finitely and can be retried', async (st) => {
    const control = { offline: true }, x = await setup(st, { control }); await click(x.page);
    assert.equal((await finish(x.page)).phase, 'error'); assert.ok(x.upstream.requests.length <= 4);
    control.offline = false; await x.page.locator('[data-testid="asset-github-resume"]').click();
    assert.equal((await finish(x.page)).phase, 'complete');
  });
  await t.test('Esc aborts relay; reopening waits; resume never asks for a file', async (st) => {
    const control = { hold: () => true }, x = await setup(st, { control }); await click(x.page);
    await x.page.waitForFunction(async () => (await import('/js/assetGithubDownload.js')).assetGithubDownload.get().transport === 'relay');
    await x.page.keyboard.press('Escape'); await x.page.waitForSelector('.asset-preload', { hidden: true });
    assert.equal((await state(x.page)).phase, 'paused'); const reads = x.upstream.requests.length;
    await x.page.locator('[data-testid="asset-preload"]').click(); assert.equal(x.upstream.requests.length, reads);
    control.hold = null; control.release?.(); await x.page.locator('[data-testid="asset-github-resume"]').click();
    assert.equal((await finish(x.page)).phase, 'complete');
  });
});
