import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectAssetUrls, createAssetDownload } from '../../public/js/assetDownload.js';
import { IMPORTED_ASSET_CACHE, IMPORTED_INDEX_URL, addImportedPaths, clearImportedAssets, countImportedFiles,
  importedWorkerControlsPage, listImportedPaths, openImportedAssetLookup, pruneImportedPaths, putImportedAsset } from '../../public/js/assetCache.js';
import { createAssetImport, modelHashOf, planFromManifests, sha256Hex16, verifyImportedAssets } from '../../public/js/assetPack.js';

const bytes = (value) => new TextEncoder().encode(value);
const origin = 'https://game.test';
const nav = { serviceWorker: { controller: { scriptURL: `${origin}/sw.js` } } };
function memory() {
  const entries = new Map(), puts = [];
  let refusePut = null, refuseDelete = null;
  const cache = {
    async put(url, response) {
      if (refusePut?.(url)) throw new DOMException('full', 'QuotaExceededError');
      puts.push(url);
      entries.set(url, { bytes: new Uint8Array(await response.arrayBuffer()), headers: [...response.headers] });
    },
    async match(url) { const got = entries.get(url); return got && new Response(got.bytes, { headers: got.headers }); },
    async keys() { throw new Error('full-pack caches cannot be enumerated'); },
    async delete(url) { if (refuseDelete?.(url)) throw new Error('blocked'); return entries.delete(url); },
  };
  const caches = { async open(name) { assert.equal(name, IMPORTED_ASSET_CACHE); return cache; },
    async keys() { return [IMPORTED_ASSET_CACHE]; }, async delete() { entries.clear(); return true; } };
  return { entries, puts, cache, caches, refusePut: (fn) => { refusePut = fn; }, refuseDelete: (fn) => { refuseDelete = fn; } };
}
const fetchManifests = (assets, get = async () => new Response('downloaded')) => async (url, options) => {
  if (url === '/data/assets.json') return Response.json(assets);
  if (url === '/data/local-assets.json' || url === '/data/local-fx.json') return new Response('', { status: 404 });
  return get(url, options);
};
const entry = (name, body) => ({ path: `public/assets/${name}`, read: async () => body });
const lookup = (mem, secure = true) => openImportedAssetLookup({ caches: mem.caches, nav, secure, origin });

test('server preload includes the same implicit Spine texture page as the renderer and import validator', () => {
  const prefix = '/assets/~1111111111111111/a';
  assert.deepEqual(collectAssetUrls({ model: { skel: `${prefix}.skel`, atlas: `${prefix}.atlas` } }),
    [`${prefix}.atlas`, `${prefix}.png`, `${prefix}.skel`]);
});

test('indexed count is cheap; the queue checks actual cache hits and its own controlling worker', async () => {
  const mem = memory();
  const good = '/assets/~1111111111111111/good.png', gone = '/assets/~2222222222222222/gone.png';
  await mem.cache.put(good, new Response('x'));
  await addImportedPaths(mem.cache, [good, gone]);
  assert.equal(await countImportedFiles(mem.caches), 2, 'historical index count is not verified count');
  assert.equal(await lookup(mem, false), null, 'LAN HTTP never skips the HTTP download');
  assert.equal(await openImportedAssetLookup({ caches: mem.caches, secure: true, nav: {}, origin }), null);
  assert.equal(importedWorkerControlsPage({ serviceWorker: { controller: { scriptURL: `${origin}/other-sw.js` } } }, origin), false);
  const calls = [];
  const queue = createAssetDownload({ lookupImported: () => lookup(mem), fetch: fetchManifests({ good, gone }, async (url) => {
    calls.push(url); return new Response('fresh');
  }) });
  await queue.start();
  assert.equal(queue.get().cached, 1);
  assert.deepEqual(calls, [gone]);
  await mem.cache.delete(good);
  await queue.recheck();
  assert.equal(queue.get().cached, 0, 'a stale index never becomes a completion claim');
  assert.equal(calls.includes(good), true);
});

test('explicit verification repairs stale and incomplete indexes, checks bytes, and repairs the playback alias', async () => {
  const mem = memory();
  const a = bytes('image'), sound = bytes('audio'), bad = bytes('expected');
  const image = `/assets/~${await sha256Hex16(a)}/a.png`;
  const audio = `/assets/~${await sha256Hex16(sound)}/audio/bgm/a.mp3`;
  const corrupt = `/assets/~${await sha256Hex16(bad)}/bad.png`;
  const missing = '/fonts/~2222222222222222/gone.woff2';
  await mem.cache.put(image, new Response(a));
  await mem.cache.put(audio, new Response(sound));
  await mem.cache.put(corrupt, new Response('wrong'));
  await addImportedPaths(mem.cache, [audio, corrupt, missing]); // image exists but is absent from the index
  const result = await verifyImportedAssets({ fetch: fetchManifests({ image, audio, corrupt, missing }), caches: mem.caches });
  assert.deepEqual(result, { verifiedFiles: 2, logicalBytes: a.length + sound.length, missingFiles: 1, invalidFiles: 1, indexedFiles: 2 });
  const paths = await listImportedPaths(mem.caches);
  assert.equal(paths.has(image), true);
  assert.equal(paths.has(corrupt), false);
  assert.equal(paths.has(missing), false);
  assert.equal(mem.entries.has(corrupt), false);
  assert.deepEqual(new Uint8Array(await (await mem.cache.match(audio.replace('/assets/', '/media/').replace('/audio/', '/').replace('.mp3', ''))).arrayBuffer()), sound);
});

test('explicit verification checks complete Spine groups and rejects every member of a damaged model', async () => {
  const mem = memory();
  const source = [bytes('skeleton'), bytes('atlas'), bytes('page')];
  const hash = await modelHashOf(await Promise.all(source.map(sha256Hex16)));
  const urls = ['model.skel', 'model.atlas', 'model.png'].map((file) => `/assets/~${hash}/${file}`);
  const assets = { model: { skel: urls[0], atlas: urls[1], textures: [urls[2]] } };
  for (let i = 0; i < urls.length; i++) await mem.cache.put(urls[i], new Response(source[i]));
  await addImportedPaths(mem.cache, urls);
  assert.equal((await verifyImportedAssets({ fetch: fetchManifests(assets), caches: mem.caches })).verifiedFiles, 3);
  await mem.cache.put(urls[2], new Response('wrong'));
  const result = await verifyImportedAssets({ fetch: fetchManifests(assets), caches: mem.caches });
  assert.equal(result.verifiedFiles, 0);
  assert.equal(result.invalidFiles, 3);
  assert.equal((await listImportedPaths(mem.caches)).size, 0);
  assert.equal(mem.entries.has(urls[0]), false);
});

test('local operators use the server skeleton/atlas/pages order and are never mistaken for standalone hashes', async () => {
  const mem = memory(), bodies = [bytes('skel'), bytes('atlas'), bytes('texture')];
  const hash = await modelHashOf(await Promise.all(bodies.map(sha256Hex16)));
  const urls = ['z.skel', 'a.atlas', 'p.png'].map((file) => `/assets/~${hash}/local/char/a/${file}`);
  const local = { chars: { char_a: { spine: { front: { skel: urls[0], atlas: urls[1], textures: [urls[2]] } } } },
    groups: { 'spine/char/char_a/front': { 'z.skel': { path: urls[0] }, 'a.atlas': { path: urls[1] }, 'p.png': { path: urls[2] } } } };
  const plan = planFromManifests({}, local);
  assert.equal(plan.files.size, 0);
  assert.deepEqual(plan.groups[1].members.map((member) => member.url), urls, 'group member order matches chars, not sorted filenames');
  const fetch = async (url) => url === '/data/assets.json' ? Response.json({})
    : url === '/data/local-assets.json' ? Response.json(local) : new Response('', { status: 404 });
  const importer = createAssetImport({ fetch, caches: mem.caches });
  await importer.start({ type: 'files', files: bodies.map((body, i) => entry(`local/char/a/${['z.skel', 'a.atlas', 'p.png'][i]}`, body)) });
  assert.deepEqual([importer.get().phase, importer.get().accepted, importer.get().rejected], ['complete', 3, 0]);
  const result = await verifyImportedAssets({ fetch, caches: mem.caches });
  assert.equal(result.verifiedFiles, 3);
  assert.equal(result.invalidFiles, 0);
  assert.equal(urls.every((url) => mem.entries.has(url)), true);
});

test('an incomplete model is not counted as verified and its saved members survive checking', async () => {
  const mem = memory(), bodies = [bytes('skeleton'), bytes('atlas'), bytes('page')];
  const hash = await modelHashOf(await Promise.all(bodies.map(sha256Hex16)));
  const urls = ['a.skel', 'a.atlas', 'a.png'].map((file) => `/assets/~${hash}/${file}`);
  await mem.cache.put(urls[0], new Response(bodies[0]));
  await mem.cache.put(urls[1], new Response(bodies[1]));
  await addImportedPaths(mem.cache, urls);
  const result = await verifyImportedAssets({ fetch: fetchManifests({ model: { skel: urls[0], atlas: urls[1], textures: [urls[2]] } }), caches: mem.caches });
  assert.deepEqual([result.verifiedFiles, result.logicalBytes, result.missingFiles, result.invalidFiles], [0, 0, 1, 0]);
  assert.deepEqual([...await listImportedPaths(mem.caches)].sort(), urls.slice(0, 2).sort());
  assert.equal(mem.entries.has(urls[0]), true);
  assert.equal(mem.entries.has(urls[1]), true);
});

test('repeated imports reuse equal verified bodies, repair corrupt bytes, and expose quota/index failures', async () => {
  const mem = memory(), body = bytes('image');
  const url = `/assets/~${await sha256Hex16(body)}/a.png`;
  const importer = createAssetImport({ fetch: fetchManifests({ image: url }), caches: mem.caches });
  const source = { type: 'files', files: [entry('a.png', body)] };
  await importer.start(source);
  await importer.start(source);
  assert.equal(importer.get().accepted, 1);
  assert.equal(mem.puts.filter((path) => path === url).length, 1, 'a second import only rewrites index metadata');
  await mem.cache.put(url, new Response('corrupt', { headers: { 'content-type': 'image/png' } }));
  await importer.start(source);
  assert.deepEqual(new Uint8Array(await (await mem.cache.match(url)).arrayBuffer()), body);
  await mem.cache.delete(url);
  mem.refusePut((path) => path === url);
  await importer.start(source);
  assert.deepEqual([importer.get().phase, importer.get().accepted, importer.get().error], ['error', 0, 'storage']);
  mem.refusePut((path) => path === IMPORTED_INDEX_URL);
  await importer.start(source);
  assert.equal(importer.get().phase, 'error');
  assert.equal(importer.get().error, 'storage');
});

test('clear and prune report storage failures and verification never reports a failed index rewrite as success', async () => {
  assert.equal(await clearImportedAssets({ keys: async () => [IMPORTED_ASSET_CACHE], delete: async () => false }), false);
  const mem = memory(), url = '/assets/~1111111111111111/old.png';
  await mem.cache.put(url, new Response('old'));
  await addImportedPaths(mem.cache, [url]);
  mem.refuseDelete(() => true);
  await assert.rejects(pruneImportedPaths(new Set(), mem.caches), { code: 'storage' });
  assert.equal((await listImportedPaths(mem.caches)).has(url), true);
  mem.refuseDelete(() => false);
  mem.refusePut((path) => path === IMPORTED_INDEX_URL);
  await assert.rejects(verifyImportedAssets({ fetch: fetchManifests({}), caches: mem.caches }), { name: 'QuotaExceededError' });
});

test('failed alias writes and cache clears wait for every in-flight mutation before returning', async () => {
  let releaseWrite, releaseDelete, beginWrite, beginDelete, writeFinished = false, deleteFinished = false;
  let writeSettled = false, deleteSettled = false;
  const writing = new Promise((resolve) => { releaseWrite = resolve; });
  const deleting = new Promise((resolve) => { releaseDelete = resolve; });
  const writeStarted = new Promise((resolve) => { beginWrite = resolve; });
  const deleteStarted = new Promise((resolve) => { beginDelete = resolve; });
  const write = putImportedAsset({ match: async () => null, async put(url) {
    if (url.endsWith('fail.png')) throw new Error('full');
    beginWrite();
    await writing; writeFinished = true;
  } }, ['/assets/~1111111111111111/fail.png', '/assets/~1111111111111111/wait.png'], bytes('a'));
  const checkedWrite = assert.rejects(write, /full/).then(() => { writeSettled = true; assert.equal(writeFinished, true); });
  const clear = clearImportedAssets({ keys: async () => [IMPORTED_ASSET_CACHE, 'sp-imported-assets-v0'], async delete(name) {
    if (name === IMPORTED_ASSET_CACHE) throw new Error('blocked');
    beginDelete();
    await deleting; deleteFinished = true; return true;
  } }).then((result) => { deleteSettled = true; assert.equal(result, false); assert.equal(deleteFinished, true); });
  await Promise.all([writeStarted, deleteStarted]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(writeSettled, false);
  assert.equal(deleteSettled, false);
  releaseWrite(); releaseDelete();
  await Promise.all([checkedWrite, clear]);
});

test('verification aborts before reading manifests or rewriting metadata', async () => {
  const mem = memory(), controller = new AbortController();
  controller.abort();
  await assert.rejects(verifyImportedAssets({ caches: mem.caches, signal: controller.signal,
    fetch: () => { assert.fail('aborted verification must not fetch'); } }), { name: 'AbortError' });
  assert.equal(mem.puts.length, 0);
});

test('verification cancels a pending body read and does not publish a trusted index', async () => {
  let began, canceled = false, wrote = false;
  const ready = new Promise((resolve) => { began = resolve; });
  const url = '/assets/~1111111111111111/a.png', controller = new AbortController();
  const cache = { async match(path) {
    if (path === IMPORTED_INDEX_URL) return Response.json([url]);
    return new Response(new ReadableStream({ start() { began(); }, cancel() { canceled = true; } }));
  }, async put() { wrote = true; } };
  const check = verifyImportedAssets({ fetch: fetchManifests({ url }), caches: { open: async () => cache }, signal: controller.signal });
  await ready;
  controller.abort();
  await assert.rejects(check, { name: 'AbortError' });
  assert.equal(canceled, true);
  assert.equal(wrote, false);
});

test('cancel waits until successfully saved files have been indexed', async () => {
  const mem = memory(), body = bytes('first'), later = bytes('second');
  const a = `/assets/~${await sha256Hex16(body)}/a.png`, b = `/assets/~${await sha256Hex16(later)}/b.png`;
  let began, finishRead;
  const ready = new Promise((resolve) => { began = resolve; });
  const pendingRead = new Promise((resolve) => { finishRead = resolve; });
  const importer = createAssetImport({ fetch: fetchManifests({ a, b }), caches: mem.caches });
  const run = importer.start({ type: 'files', files: [entry('a.png', body), { path: 'public/assets/b.png', read: async () => {
    began(); await pendingRead; return later;
  } }] });
  await ready;
  const stopped = importer.cancel();
  finishRead();
  await stopped;
  await run;
  assert.equal(importer.get().phase, 'cancelled');
  assert.deepEqual([...await listImportedPaths(mem.caches)], [a]);
  assert.equal(mem.entries.has(b), false);
});

test('pause followed immediately by resume restarts only the unfinished request', async () => {
  let began;
  const ready = new Promise((resolve) => { began = resolve; });
  let calls = 0;
  const queue = createAssetDownload({ retries: 0, fetch: fetchManifests({ a: '/assets/a' }, async (_url, { signal }) => {
    if (++calls > 1) return new Response('done');
    return new Response(new ReadableStream({ start(stream) {
      signal.addEventListener('abort', () => stream.error(new DOMException('stop', 'AbortError')), { once: true });
      began();
    } }));
  }) });
  queue.start();
  await ready;
  queue.pause();
  await queue.start();
  assert.equal(queue.get().phase, 'complete');
  assert.equal(calls, 2);
});

test('immediate pause/resume waits for the old body, and a subsequent pause cancels a pending resume', async () => {
  let began, release;
  const started = new Promise((resolve) => { began = resolve; });
  const stopped = new Promise((resolve) => { release = resolve; });
  let calls = 0, hold = true;
  const queue = createAssetDownload({ retries: 0, fetch: fetchManifests({ a: '/assets/a' }, async (_url, { signal }) => {
    calls++;
    if (!hold) return new Response('done');
    return new Response(new ReadableStream({ start(stream) {
      signal.addEventListener('abort', async () => { await stopped; stream.error(new DOMException('stop', 'AbortError')); }, { once: true });
      began();
    } }));
  }) });
  const first = queue.start();
  await started;
  queue.pause();
  const resume = queue.start();
  queue.pause();
  hold = false;
  release();
  await Promise.all([first, resume]);
  assert.equal(queue.get().phase, 'paused');
  assert.equal(calls, 1, 'the canceled pending resume never starts a download');
  await queue.start();
  assert.equal(calls, 2);
  assert.equal(queue.get().phase, 'complete');
});

test('recheck refreshes manifests after a partial run and invalidate removes historical completion without downloading', async () => {
  const assets = { a: '/assets/a', b: '/assets/b' }, calls = [];
  const queue = createAssetDownload({ retries: 0, fetch: fetchManifests(assets, async (url) => {
    calls.push(url); return new Response('x', { status: url === '/assets/b' ? 404 : 200 });
  }) });
  await queue.start();
  assert.equal(queue.get().phase, 'partial');
  delete assets.b;
  assets.c = '/assets/c';
  await queue.recheck();
  assert.equal(queue.get().phase, 'complete');
  assert.deepEqual(calls, ['/assets/a', '/assets/b', '/assets/a', '/assets/c']);
  await queue.invalidate();
  assert.deepEqual([queue.get().phase, queue.get().done, queue.get().total], ['idle', 0, 0]);
  assert.equal(calls.length, 4);
});
