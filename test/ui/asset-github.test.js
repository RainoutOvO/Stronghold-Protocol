import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRemoteAssetArchive } from '../../public/js/assetArchive.js';
import { createAssetGithubDownload } from '../../public/js/assetGithubDownload.js';
import { githubArchiveFixture } from './githubArchiveFixture.mjs';

const fixture = githubArchiveFixture();
const release = { ...fixture.release, relay: { enabled: true, maxRangeBytes: 8388608, mirrors: [] } };
function rangeResponse(range, headers = {}) {
  const match = /^bytes=(\d+)-(\d+)$/.exec(range), start = +match[1], end = +match[2];
  return new Response(fixture.bytes.subarray(start, end + 1), { status: 206, headers: {
    'Content-Range': `bytes ${start}-${end}/${fixture.bytes.length}`, 'Content-Length': String(end - start + 1), ...headers,
  } });
}
function memoryCaches() {
  const map = new Map();
  return { map, async keys() { return ['sp-imported-assets-v1']; }, async open() { return {
    async keys() { return [...map.keys()].map((url) => ({ url })); },
    async match(url) { return map.get(String(url))?.clone(); },
    async put(url, response) { map.set(String(url), response.clone()); },
    async delete(url) { return map.delete(String(url)); },
  }; } };
}
function automatic(options = {}) {
  const reads = [], caches = memoryCaches();
  const doFetch = async (url, init = {}) => {
    if (url === '/data/assets.json') return Response.json(options.manifest || fixture.manifest);
    if (url === '/data/local-assets.json' || url === '/data/local-fx.json') return Response.json({ groups: {} });
    if (String(url).startsWith('https:')) throw new TypeError('CORS unavailable');
    if (String(url).includes('/archive?')) { reads.push(init.headers.Range); return rangeResponse(init.headers.Range); }
    throw new Error(`unexpected ${url}`);
  };
  const service = createAssetGithubDownload({ supported: () => true, canServe: () => true, caches, fetch: doFetch,
    loadRelease: async () => release, ...options });
  return { service, reads, caches };
}

test('automatic real ZIP parser verifies seven files and repeat verification reads zero archive bytes', async () => {
  const { service, reads } = automatic();
  assert.equal(service.get().phase, 'idle'); assert.equal(reads.length, 0);
  const first = service.start(), duplicate = service.start(); assert.equal(first, duplicate, 'one active task');
  await first;
  assert.equal(service.get().phase, 'complete', JSON.stringify(service.get())); assert.equal(service.get().done, 7);
  assert.ok(reads.length > 0); const count = reads.length;
  await service.recheck(); assert.equal(service.get().phase, 'complete'); assert.equal(reads.length, count);
  assert.equal(service.get().reused, 7);
  await service.invalidate(); assert.equal(service.get().phase, 'idle'); assert.equal(reads.length, count);
});
test('saved files cannot be called ready without a controlling worker, and insecure contexts request no ZIP', async () => {
  const noWorker = automatic({ canServe: () => false }); await noWorker.service.start();
  assert.equal(noWorker.service.get().phase, 'fallback'); assert.equal(noWorker.service.get().error, 'worker');
  const insecure = automatic({ supported: () => false }); await insecure.service.start();
  assert.equal(insecure.service.get().phase, 'fallback'); assert.equal(insecure.service.get().error, 'capability');
  assert.equal(insecure.reads.length, 0);
});
test('host-only manifest files remain partial despite successful ZIP import', async () => {
  const { service } = automatic({ manifest: { ...fixture.manifest, hostOnly: '/assets/~1234567890abcdef/local-only.png' } });
  await service.start(); assert.equal(service.get().phase, 'partial'); assert.equal(service.get().done, 7);
  assert.equal(service.get().total, 8); assert.equal(service.get().failures.length, 1);
});
test('a malformed manifest and unconfigured custom mirror fail without reading archive bytes', async () => {
  for (const options of [{ manifest: {} }, {}]) {
    const { service, reads } = automatic(options);
    await service.start(options.manifest ? {} : { preference: 'custom', mirrorId: 'not-trusted' });
    assert.equal(service.get().phase, 'error'); assert.equal(reads.length, 0);
  }
});
test('whole-archive 200 and wrong Content-Range cancel before any body read', async () => {
  for (const status of [200, 206]) {
    let cancelled = 0, reads = 0, calls = 0;
    const archive = createRemoteAssetArchive({ release: { ...release, relay: { enabled: false } }, preference: 'direct', retries: 0,
      fetch: async () => { calls++; return { status, headers: new Headers({ 'Content-Range': 'bytes 0-3/999', 'Content-Length': '4' }),
        body: { cancel: async () => { cancelled++; }, getReader: () => { reads++; throw new Error('must not read'); } } }; } });
    await assert.rejects(archive.read(0, 4)); assert.equal(calls, 1); assert.equal(cancelled, 1); assert.equal(reads, 0);
  }
});
test('range cache coalesces adjacent reads, evicts bounded blocks and detects validator changes', async () => {
  let calls = 0;
  const archive = createRemoteAssetArchive({ release, preference: 'direct', blockBytes: 1024, cacheBlocks: 2,
    fetch: async (_url, init) => { calls++; return rangeResponse(init.headers.Range, { ETag: '"v1"' }); } });
  await archive.read(0, 1); await archive.read(10, 1); assert.equal(calls, 1);
  await archive.read(1024, 1); await archive.read(2048, 1); await archive.read(0, 1); assert.equal(calls, 4);
  let count = 0;
  const changed = createRemoteAssetArchive({ release, preference: 'direct', blockBytes: 1024,
    fetch: async (_url, init) => rangeResponse(init.headers.Range, { ETag: ++count === 1 ? '"a"' : '"b"' }) });
  await changed.read(0, 1); await assert.rejects(changed.read(1024, 1), { code: 'archive-changed' });
});
test('timeouts retry finitely, respect manual direct and abort upstream requests', async () => {
  let calls = 0, aborts = 0;
  const archive = createRemoteAssetArchive({ release, preference: 'direct', timeoutMs: 2, relayTimeoutMs: 2,
    fetch: async (_url, init) => { calls++; return new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => { aborts++; reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
    }); } });
  await assert.rejects(archive.read(0, 1)); assert.equal(calls, 4); assert.equal(aborts, 4);
});
