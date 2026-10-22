import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRemoteAssetArchive } from '../../public/js/assetArchive.js';
import { createAssetGithubDownload } from '../../public/js/assetGithubDownload.js';
import { openZip } from '../../public/js/assetPack.js';
import { IMPORTED_INDEX_URL } from '../../public/js/assetCache.js';
import { githubArchiveFixture, buildGithubArchive } from './githubArchiveFixture.mjs';

const fixture = githubArchiveFixture();
const release = { ...fixture.release, relay: { enabled: true, maxRangeBytes: 8388608, mirrors: [] } };
const response = (range, etag = null) => {
  const [, a, b] = /^bytes=(\d+)-(\d+)$/.exec(range), start = Number(a), end = Number(b);
  return new Response(fixture.bytes.subarray(start, end + 1), { status: 206, headers: {
    'Content-Range': `bytes ${start}-${end}/${fixture.bytes.length}`, 'Content-Length': String(end - start + 1),
    ...(etag ? { ETag: etag } : {}),
  } });
};

test('public range requests omit credentials/referrer and refuse redirects to an untrusted final origin', async () => {
  let calls = 0, cancelled = 0;
  const archive = createRemoteAssetArchive({ release: { ...release, relay: { enabled: false } }, preference: 'direct', retries: 0,
    fetch: async (url, options) => {
      calls++;
      assert.equal(url, release.url);
      assert.equal(options.credentials, 'omit'); assert.equal(options.referrerPolicy, 'no-referrer');
      assert.deepEqual(Object.keys(options.headers), ['Range']);
      const result = response(options.headers.Range);
      return { status: result.status, headers: result.headers, url: 'https://private.example/archive.zip',
        body: { cancel: async () => { cancelled++; }, getReader: () => assert.fail('untrusted body was read') } };
    } });
  await assert.rejects(archive.read(0, 10), { code: 'range' });
  assert.equal(calls, 1); assert.equal(cancelled, 1);
});

test('an established archive validator cannot disappear on a later range', async () => {
  let calls = 0;
  const archive = createRemoteAssetArchive({ release, preference: 'direct', blockBytes: 1024,
    fetch: async (_url, options) => response(options.headers.Range, ++calls === 1 ? '"same-archive"' : null) });
  await archive.read(0, 1);
  await assert.rejects(archive.read(1024, 1), { code: 'archive-changed' });
  assert.equal(calls, 2);
});

test('a zero CRC is checked as a real ZIP checksum rather than disabling checksum validation', async () => {
  const archive = buildGithubArchive([{ path: 'public/assets/a.bin', bytes: Buffer.from('nonzero-crc') }]);
  const bytes = Buffer.from(archive.bytes);
  const directory = bytes.readUInt32LE(bytes.length - 22 + 16);
  bytes.writeUInt32LE(0, directory + 16);
  const zip = await openZip(bytes);
  assert.equal(zip.ok, true);
  assert.deepEqual(await zip.read(zip.entries[0]), { ok: false, code: 'bad-entry' });
});

test('pause waits for a pending valid cache write and index flush; a canceled recheck cannot restart it', async () => {
  const entries = new Map();
  let startWrite, releaseWrite, blocked = true, finished = false, pauseSettled = false, ranges = 0;
  const writing = new Promise((resolve) => { startWrite = resolve; });
  const finish = new Promise((resolve) => { releaseWrite = resolve; });
  const cache = {
    keys: async () => [...entries.keys()].map((url) => ({ url })),
    match: async (url) => entries.get(url)?.clone(),
    delete: async (url) => entries.delete(url),
    async put(url, result) {
      if (url !== IMPORTED_INDEX_URL && blocked) { blocked = false; startWrite(); await finish; finished = true; }
      entries.set(url, result.clone());
    },
  };
  const doFetch = async (url, options = {}) => {
    if (url === '/data/assets.json') return Response.json(fixture.manifest);
    if (url === '/data/local-assets.json' || url === '/data/local-fx.json') return Response.json({ groups: {} });
    if (url.startsWith('https:')) throw new TypeError('blocked CORS');
    ranges++;
    return response(options.headers.Range);
  };
  const service = createAssetGithubDownload({ supported: () => true, canServe: () => true,
    caches: { open: async () => cache }, fetch: doFetch, loadRelease: async () => release });
  const run = service.start();
  await writing;
  const recheck = service.recheck();
  const paused = service.pause().then(() => { pauseSettled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pauseSettled, false, 'pending cache operations cannot outlive the task');
  const count = ranges;
  releaseWrite();
  await Promise.all([run, recheck, paused]);
  assert.equal(finished, true); assert.equal(service.get().phase, 'paused');
  assert.equal(ranges, count, 'the later pause cancels the pending recheck');
  assert.equal(entries.has(IMPORTED_INDEX_URL), true);
  assert.ok([...entries.keys()].some((url) => url.startsWith('/assets/')));
});
