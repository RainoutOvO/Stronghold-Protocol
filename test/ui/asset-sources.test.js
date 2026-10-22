import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { assetPreloadRecommendation, assetPreloadCountryHeader } from '../../server/http/config.js';
import { assetPreloadCountry, createRequestHandler } from '../../server/http/routes.js';
import { loadPreloadRecommendation, preloadSources } from '../../public/js/assetSources.js';

test('recommendation defaults to GitHub, accepts the owner setting, and never enables unavailable sources', () => {
  const previous = process.env.SP_ASSET_PRELOAD_RECOMMENDED;
  try {
    delete process.env.SP_ASSET_PRELOAD_RECOMMENDED;
    assert.equal(assetPreloadRecommendation(), 'github');
    process.env.SP_ASSET_PRELOAD_RECOMMENDED = 'import';
    assert.equal(assetPreloadRecommendation(), 'import');
    assert.equal(assetPreloadRecommendation({ assetPreloadRecommended: 'server' }), 'server');
    let warnings = 0;
    assert.equal(assetPreloadRecommendation({ assetPreloadRecommended: 'https://unexpected.test' }, { warn() { warnings++; } }), 'github');
    assert.equal(warnings, 1);
  } finally {
    if (previous === undefined) delete process.env.SP_ASSET_PRELOAD_RECOMMENDED;
    else process.env.SP_ASSET_PRELOAD_RECOMMENDED = previous;
  }
  const sources = preloadSources();
  assert.deepEqual(sources.map((source) => source.id), ['server', 'github', 'import']);
  assert.deepEqual(sources.find((source) => source.recommended), { id: 'github', available: true, reason: null, recommended: true });
  assert.deepEqual(preloadSources({ recommended: 'import', importSupported: false }).at(-1),
    { id: 'import', available: false, reason: 'capability', recommended: true });
  assert.equal(preloadSources({ recommended: 'unknown' }).filter((source) => source.recommended).length, 1);
});

test('the public recommendation endpoint is no-store, HEAD-safe, GET-only, and retains the default CSP', async (t) => {
  const csp = "default-src 'self'; connect-src 'self'";
  const server = http.createServer(createRequestHandler({
    serveStatic: async (_req, res) => { res.writeHead(404); res.end(); }, health: {}, log: console, csp,
    assetPreloadRecommended: 'server', assetPreloadCountryHeader: 'cf-ipcountry',
    githubRelease: async () => ({ version: '9.9.9', name: 'Stronghold-Protocol-v9.9.9.zip', size: 123,
      url: 'https://github.com/sganggs/Stronghold-Protocol/releases/download/v9.9.9/Stronghold-Protocol-v9.9.9.zip' }),
  }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/asset-preload.json`;
  const response = await fetch(url);
  assert.deepEqual(await response.json(), { recommended: 'server' });
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('content-security-policy'), csp);
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  const head = await fetch(url, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  assert.equal((await fetch(url, { method: 'POST' })).status, 405);
  const metadata = await fetch(url.replace('/asset-preload.json', '/asset-preload/github.json'), { headers: { 'CF-IPCountry': 'CN' } });
  assert.equal((await metadata.json()).country, 'CN');
  assert.equal(metadata.headers.get('cache-control'), 'no-store', 'country metadata must not be reused for a different visitor');
});

test('client configuration reads only the same origin and ignores invalid or unavailable host responses', async () => {
  let requests = 0;
  assert.equal(await loadPreloadRecommendation({ fetch: async (url, options) => {
    requests++;
    assert.equal(url, '/asset-preload.json');
    assert.equal(options.credentials, 'same-origin');
    assert.equal(options.redirect, 'error');
    assert.equal(options.cache, 'no-store');
    return Response.json({ recommended: 'server', github: { available: true, url: 'https://untrusted.test' } });
  } }), 'server');
  assert.equal(requests, 1);
  assert.equal(await loadPreloadRecommendation({ fetch: async () => Response.json({ recommended: 'unknown' }) }), 'github');
  assert.equal(await loadPreloadRecommendation({ fetch: async () => new Response('', { status: 404 }) }), 'github');
  assert.equal(await loadPreloadRecommendation({ fetch: async () => { throw new TypeError('blocked'); } }), 'github');
  assert.equal(await loadPreloadRecommendation({ timeoutMs: 1, fetch: async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true });
  }) }), 'github');
  assert.deepEqual(preloadSources({ importSupported: false })[1],
    { id: 'github', available: true, reason: 'server-fallback', recommended: true },
    'without secure storage the GitHub entry selects the working server fallback');
});

test('country routing is opt-in and accepts only trusted proxy country headers', () => {
  const previous = process.env.SP_ASSET_PRELOAD_COUNTRY_HEADER;
  try {
    delete process.env.SP_ASSET_PRELOAD_COUNTRY_HEADER;
    assert.equal(assetPreloadCountryHeader(), null);
    assert.equal(assetPreloadCountryHeader({ assetPreloadCountryHeader: 'CF-IPCountry' }), 'cf-ipcountry');
    assert.equal(assetPreloadCountryHeader({ assetPreloadCountryHeader: 'authorization' }), null);
    process.env.SP_ASSET_PRELOAD_COUNTRY_HEADER = 'cf-ipcountry';
    assert.equal(assetPreloadCountryHeader(), 'cf-ipcountry');
    assert.equal(assetPreloadCountryHeader({ assetPreloadCountryHeader: null }), null, 'explicit programmatic disable wins over environment');
  } finally {
    if (previous === undefined) delete process.env.SP_ASSET_PRELOAD_COUNTRY_HEADER;
    else process.env.SP_ASSET_PRELOAD_COUNTRY_HEADER = previous;
  }
  const req = (ip, country) => ({ socket: { remoteAddress: ip }, headers: { 'cf-ipcountry': country, 'accept-language': 'zh-CN' } });
  assert.equal(assetPreloadCountry(req('127.0.0.1', 'CN'), null), null);
  assert.equal(assetPreloadCountry(req('127.0.0.1', 'CN'), 'cf-ipcountry'), 'CN');
  assert.equal(assetPreloadCountry(req('203.0.113.1', 'CN'), 'cf-ipcountry'), null);
  assert.equal(assetPreloadCountry(req('127.0.0.1', 'CN'), 'cf-ipcountry', false), null);
  assert.equal(assetPreloadCountry(req('203.0.113.1', 'US'), 'cf-ipcountry', true), 'US');
  for (const invalid of ['XX', 'T1', 'cn', 'CN, US', ['CN', 'US'], undefined]) {
    assert.equal(assetPreloadCountry(req('127.0.0.1', invalid), 'cf-ipcountry'), null);
  }
});
