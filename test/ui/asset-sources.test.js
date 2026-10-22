import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { assetPreloadRecommendation } from '../../server/http/config.js';
import { createRequestHandler } from '../../server/http/routes.js';
import { siteCsp } from '../../server/http/csp.js';
import { loadPreloadRecommendation, preloadSources } from '../../public/js/assetSources.js';

test('only server/import are recommended, with server default and safe fallback for old settings', () => {
  const previous = process.env.SP_ASSET_PRELOAD_RECOMMENDED;
  try {
    delete process.env.SP_ASSET_PRELOAD_RECOMMENDED;
    assert.equal(assetPreloadRecommendation(), 'server');
    for (const source of ['server', 'import']) {
      process.env.SP_ASSET_PRELOAD_RECOMMENDED = source;
      assert.equal(assetPreloadRecommendation(), source);
    }
    assert.equal(assetPreloadRecommendation({ assetPreloadRecommended: 'server' }), 'server');
    for (const value of ['github', 'unknown', 'https://unexpected.test']) {
      process.env.SP_ASSET_PRELOAD_RECOMMENDED = value;
      let warnings = 0;
      assert.equal(assetPreloadRecommendation({}, { warn() { warnings++; } }), 'server');
      assert.equal(warnings, 1);
      assert.equal(assetPreloadRecommendation({ assetPreloadRecommended: 'import' }), 'import');
      assert.equal(preloadSources({ recommended: value }).find((source) => source.recommended).id, 'server');
    }
  } finally {
    if (previous === undefined) delete process.env.SP_ASSET_PRELOAD_RECOMMENDED;
    else process.env.SP_ASSET_PRELOAD_RECOMMENDED = previous;
  }
  assert.deepEqual(preloadSources().map((source) => source.id), ['server', 'import']);
  assert.deepEqual(preloadSources().find((source) => source.recommended),
    { id: 'server', available: true, reason: null, recommended: true });
  assert.deepEqual(preloadSources({ recommended: 'import', importSupported: false }), [
    { id: 'server', available: true, reason: null, recommended: false },
    { id: 'import', available: false, reason: 'capability', recommended: true },
  ]);
});

test('the recommendation endpoint is HEAD-safe/GET-only; retired download endpoints are ordinary 404s', async (t) => {
  const csp = siteCsp('public');
  const server = http.createServer(createRequestHandler({
    serveStatic: async (_req, res) => { res.writeHead(404); res.end(); }, health: {}, log: console, csp,
    assetPreloadRecommended: 'github', // Existing programmatic configuration must also fall back safely.
  }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const url = base + '/asset-preload.json';
  const response = await fetch(url);
  assert.deepEqual(await response.json(), { recommended: 'server' });
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('content-security-policy'), csp);
  assert.match(csp, /connect-src 'self';/);
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  const head = await fetch(url, { method: 'HEAD' });
  assert.equal(head.status, 200); assert.equal(await head.text(), '');
  assert.equal((await fetch(url, { method: 'POST' })).status, 405);
  for (const retired of ['/asset-preload/github.json', '/asset-preload/github/archive', '/asset-preload/github/status']) {
    const missing = await fetch(base + retired);
    assert.equal(missing.status, 404, retired); await missing.body.cancel();
  }
});

test('client reads only same-origin recommendation and defaults safely for stale or unavailable responses', async () => {
  let requests = 0;
  assert.equal(await loadPreloadRecommendation({ fetch: async (url, options) => {
    requests++; assert.equal(url, '/asset-preload.json'); assert.equal(options.credentials, 'same-origin');
    assert.equal(options.redirect, 'error'); assert.equal(options.cache, 'no-store');
    return Response.json({ recommended: 'import' });
  } }), 'import');
  assert.equal(requests, 1);
  for (const recommended of ['github', 'unknown', null]) {
    assert.equal(await loadPreloadRecommendation({ fetch: async () => Response.json({ recommended }) }), 'server');
  }
  assert.equal(await loadPreloadRecommendation({ fetch: async () => new Response('', { status: 404 }) }), 'server');
  assert.equal(await loadPreloadRecommendation({ fetch: async () => { throw new TypeError('blocked'); } }), 'server');
  assert.equal(await loadPreloadRecommendation({ timeoutMs: 1, fetch: async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true });
  }) }), 'server');
});
