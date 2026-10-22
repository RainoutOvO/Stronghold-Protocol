import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GITHUB_RELEASE_API, createGithubReleaseLookup, githubReleaseMetadata } from '../../server/http/assetRelease.js';
import { loadGithubRelease, githubDownloadUrl, selectGithubRoutes } from '../../public/js/assetRelease.js';

const full = { version: '0.3.1', name: 'Stronghold-Protocol-v0.3.1.zip',
  url: 'https://github.com/sganggs/Stronghold-Protocol/releases/download/v0.3.1/Stronghold-Protocol-v0.3.1.zip', size: 845522197 };
const release = () => ({ tag_name: 'v0.3.1', draft: false, prerelease: false, assets: [
  { name: 'Stronghold-Protocol-v0.3.1-lite.zip', state: 'uploaded', size: 27188386, browser_download_url: full.url.replace('.zip', '-lite.zip') },
  { name: full.name, state: 'uploaded', size: full.size, browser_download_url: full.url },
] });

test('release discovery accepts only the uploaded full ZIP of the fixed public upstream and tag', () => {
  assert.deepEqual(githubReleaseMetadata(release()), full);
  for (const edit of [
    (d) => { d.draft = true; }, (d) => { d.prerelease = true; }, (d) => { d.tag_name = '../latest'; },
    (d) => { d.assets.pop(); }, (d) => { d.assets[1].state = 'new'; }, (d) => { d.assets[1].size = 0; },
    (d) => { d.assets[1].size = 9 * 1024 * 1024 * 1024; },
    (d) => { d.assets[1].browser_download_url = full.url.replace('sganggs', 'untrusted'); },
    (d) => { d.assets[1].browser_download_url += '?token=private'; },
  ]) { const document = release(); edit(document); assert.equal(githubReleaseMetadata(document), null); }
});

test('metadata requests have bounded public policy and share one cached in-flight lookup', async () => {
  let calls = 0;
  let now = 100;
  let unblock;
  const gate = new Promise((resolve) => { unblock = resolve; });
  const lookup = createGithubReleaseLookup({ now: () => now, ttlMs: 50, fetch: async (url, options) => {
    calls++;
    assert.equal(url, GITHUB_RELEASE_API);
    assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'omit');
    assert.equal(options.headers.Authorization, undefined);
    await gate;
    return Response.json(release());
  } });
  const a = lookup(); const b = lookup(); unblock();
  assert.deepEqual(await a, full); assert.deepEqual(await b, full); assert.equal(calls, 1);
  assert.deepEqual(await lookup(), full); assert.equal(calls, 1);
  now = 151; await lookup(); assert.equal(calls, 2);
});

test('invalid, oversized, HTML, failed and timed-out metadata fail closed and cool down', async () => {
  const badResponses = [
    () => new Response('not json', { headers: { 'content-type': 'application/json' } }),
    () => new Response('<html>200</html>', { headers: { 'content-type': 'text/html' } }),
    () => new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': '1048577' } }),
    () => new Response(' '.repeat(1048577), { headers: { 'content-type': 'application/json' } }),
    () => new Response('rate limited', { status: 429 }),
    () => { throw new TypeError('redirect'); },
  ];
  for (const response of badResponses) {
    let calls = 0;
    const lookup = createGithubReleaseLookup({ fetch: async () => { calls++; return response(); } });
    assert.equal(await lookup(), null); assert.equal(await lookup(), null); assert.equal(calls, 1);
  }
  const timeout = createGithubReleaseLookup({ timeoutMs: 1, fetch: async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true });
  }) });
  assert.equal(await timeout(), null);
  let now = 100;
  let calls = 0;
  const recover = createGithubReleaseLookup({ now: () => now, failureTtlMs: 10, fetch: () => {
    if (++calls === 1) throw new TypeError('offline');
    return Response.json(release());
  } });
  assert.equal(await recover(), null); assert.equal(await recover(), null); assert.equal(calls, 1);
  now = 111;
  assert.deepEqual(await recover(), full); assert.equal(calls, 2);
});

test('client metadata is same-origin and only validated release URLs can reach the mirror', async () => {
  assert.deepEqual(await loadGithubRelease({ fetch: async (url, options) => {
    assert.equal(url, '/asset-preload/github.json');
    assert.equal(options.credentials, 'same-origin'); assert.equal(options.redirect, 'error');
    assert.equal(options.cache, 'no-store');
    return Response.json({ ...full, country: 'CN' });
  } }), { ...full, country: 'CN', relay: { enabled: false, maxRangeBytes: 8388608, mirrors: [] }, sha256: null });
  assert.equal(githubDownloadUrl(full), full.url);
  assert.equal(githubDownloadUrl(full, 'ghfast'), 'https://ghfast.top/' + full.url);
  for (const url of ['http://github.com/file.zip', 'https://user:pass@github.com/file.zip', full.url + '#fragment',
    full.url + '?auth=private', full.url.replace('github.com', 'github.com.evil.test'), full.url.replace('v0.3.1/', 'v0.3.0/')]) {
    assert.equal(githubDownloadUrl({ ...full, url }, 'ghfast'), null);
    assert.equal(await loadGithubRelease({ fetch: async () => Response.json({ ...full, url }) }), null);
  }
  assert.equal(githubDownloadUrl(full, 'https://untrusted.test'), null);
  assert.equal(await loadGithubRelease({ fetch: async () => new Response('', { status: 404 }) }), null);
  assert.equal(await loadGithubRelease({ fetch: async () => { throw new TypeError('blocked'); } }), null);
  assert.equal(await loadGithubRelease({ timeoutMs: 1, fetch: async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true });
  }) }), null);
});

test('auto routes use only the trusted country hint and respect an always-direct override', () => {
  assert.deepEqual(selectGithubRoutes({ country: 'CN' }), ['ghfast', 'direct']);
  for (const country of ['US', 'HK', 'TW', 'MO', null, undefined, 'unknown', 'cn']) {
    assert.deepEqual(selectGithubRoutes({ country }), ['direct', 'ghfast']);
  }
  for (const country of ['CN', 'US', null]) assert.deepEqual(selectGithubRoutes({ preference: 'direct', country }), ['direct']);
});
