import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { mkdtemp, readdir, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ASSET_RANGE_MAX, createAssetRelay, normalizeAssetMirrors, parseAssetRange,
  permittedArchiveRedirect, publicArchiveTransport } from '../server/http/assetRelay.js';
import { createRequestHandler } from '../server/http/routes.js';
import { assetPreloadRelayOptions } from '../server/http/config.js';
import { siteCsp, SIM_WORKER_CSP } from '../server/http/csp.js';

const bytes = Buffer.concat([Buffer.from('504b0304', 'hex'), Buffer.from('public-archive-fixture-not-real-game-art')]);
const release = { version: '0.3.1', name: 'Stronghold-Protocol-v0.3.1.zip',
  url: 'https://github.com/sganggs/Stronghold-Protocol/releases/download/v0.3.1/Stronghold-Protocol-v0.3.1.zip',
  size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
const query = '?version=0.3.1&route=direct';
function partial(range, extra = {}) {
  const { start, end, length } = parseAssetRange(range, bytes.length);
  return new Response(bytes.subarray(start, end + 1), { status: 206, headers: {
    'Content-Type': 'application/zip', 'Content-Length': String(length),
    'Content-Range': `bytes ${start}-${end}/${bytes.length}`, ETag: '"archive-v1"', ...extra,
  } });
}

async function serve(t, options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'sp-asset-relay-test-'));
  const lookupRelease = options.lookupRelease || (async () => release);
  const relay = createAssetRelay({ spoolDir: directory, lookupRelease, ...options });
  const server = http.createServer(createRequestHandler({
    serveStatic: async (_req, res) => { res.writeHead(404); res.end(); },
    health: {}, log: { error() {} }, githubRelease: lookupRelease, assetRelay: relay,
  }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await relay.close();
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
    assert.deepEqual(await readdir(directory), [], 'closing removes only this instance\'s spool files and directory');
    await rmdir(directory);
  });
  const base = `http://127.0.0.1:${server.address().port}/asset-preload/github`;
  return { relay, directory, base, server, get: (range = 'bytes=0-7', suffix = query, init = {}) => fetch(base + '/archive' + suffix,
    { ...init, headers: { Range: range, ...init.headers } }) };
}

async function until(condition, message = 'condition was not reached', timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() >= deadline) assert.fail(message);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('owner relay defaults on, can be disabled, and only normalizes a short trusted HTTPS mirror list', () => {
  assert.equal(assetPreloadRelayOptions({ assetPreloadRelay: true }).enabled, true);
  assert.equal(assetPreloadRelayOptions({ assetPreloadRelay: false }).enabled, false);
  assert.equal(assetPreloadRelayOptions({ assetPreloadRelay: '0' }).enabled, false);
  const good = { id: 'trusted', label: 'Trusted', prefix: 'https://mirror.example/github' };
  assert.deepEqual(normalizeAssetMirrors([good]), [{ ...good, prefix: good.prefix + '/' }]);
  for (const prefix of ['http://mirror.example/', 'https://u:p@mirror.example/', 'https://mirror.example/?token=x',
    'https://127.0.0.1/', 'https://localhost/', 'https://internal.local/', 'https://mirror.example:444/', 'https://mirror.example/#x']) {
    assert.deepEqual(normalizeAssetMirrors([{ ...good, prefix }]), []);
  }
  assert.deepEqual(normalizeAssetMirrors(Array(5).fill(good)), []);
  assert.deepEqual(normalizeAssetMirrors([{ ...good, id: 'direct' }]), []);
});

test('archive range and redirect policy reject arbitrary targets, unsafe forms, multipart and oversized reads', () => {
  assert.deepEqual(parseAssetRange('bytes=0-7', bytes.length), { start: 0, end: 7, length: 8, value: 'bytes=0-7' });
  for (const range of [undefined, 'bytes=0-', 'bytes=-4', 'bytes=01-2', 'bytes=0-1,3-4', 'bytes=8-7', 'bytes=0-99999999',
    `bytes=0-${ASSET_RANGE_MAX}`, 'bytes=9007199254740999-9007199254741000']) assert.throws(() => parseAssetRange(range, bytes.length));
  const initial = 'https://ghfast.top/' + release.url;
  assert.equal(permittedArchiveRedirect(release.url, release, initial), true);
  assert.equal(permittedArchiveRedirect('https://release-assets.githubusercontent.com/github-production-release-asset/123/01234567-89ab-cdef-0123-456789abcdef?sig=public', release, initial), true);
  for (const url of ['http://github.com/file', 'https://u:p@github.com/file', 'https://127.0.0.1/file',
    'https://release-assets.githubusercontent.com/private/other.zip', 'https://ghfast.top/https://example.com/file', release.url + '#x']) {
    assert.equal(permittedArchiveRedirect(url, release, initial), false);
  }
});

test('real HTTP relay returns exact bounded 206, HEAD and capability while forwarding only public request headers', async (t) => {
  let transfers = 0;
  const { get, base } = await serve(t, { transport: async ({ url, headers, signal }) => {
    transfers++; assert.equal(url, release.url); assert.ok(signal instanceof AbortSignal);
    assert.deepEqual(Object.keys(headers).sort(), ['Accept', 'Accept-Encoding', 'Range', 'User-Agent']);
    return partial(headers.Range);
  } });
  const meta = await (await fetch(base + '.json')).json();
  assert.equal(meta.relay.enabled, true); assert.equal(meta.relay.maxRangeBytes, ASSET_RANGE_MAX);
  const head = await fetch(base + '/archive' + query, { method: 'HEAD' });
  assert.equal(head.status, 200); assert.equal(head.headers.get('content-length'), String(bytes.length));
  assert.equal(await head.text(), ''); assert.equal(transfers, 0);
  const response = await get('bytes=0-7', query, { headers: { Cookie: 'private=value', Authorization: 'secret', Referer: 'https://private.example/' } });
  assert.equal(response.status, 206); assert.equal(response.headers.get('content-range'), `bytes 0-7/${bytes.length}`);
  assert.equal(response.headers.get('etag'), '"archive-v1"');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes.subarray(0, 8)); assert.equal(transfers, 1);
});

test('invalid query/version/route/range and disabled relay never issue upstream requests', async (t) => {
  let transfers = 0;
  const { get } = await serve(t, { transport: async ({ headers }) => { transfers++; return partial(headers.Range); } });
  for (const [suffix, status] of [['?version=0.3.0&route=direct', 409], [query + '&url=https://private.local/', 400],
    [query + '&route=ghfast', 400], ['?version=0.3.1&route=custom&id=unknown', 400], [query + '&id=x', 400]]) {
    assert.equal((await get('bytes=0-3', suffix)).status, status);
  }
  assert.equal((await get('bytes=0-')).status, 416); assert.equal(transfers, 0);
  const disabled = await serve(t, { enabled: false, transport: async () => { transfers++; } });
  assert.equal((await disabled.get()).status, 403); assert.equal(transfers, 0);
});

test('206 wrong range/length/HTML/encoding/validator and redirect escapes fail closed', async (t) => {
  for (const edit of [
    { 'Content-Range': `bytes 1-8/${bytes.length}` }, { 'Content-Length': '9' },
    { 'Content-Type': 'text/html' }, { 'Content-Encoding': 'gzip' },
  ]) {
    const { get } = await serve(t, { transport: async ({ headers }) => partial(headers.Range, edit) });
    assert.equal((await get()).status, 502);
  }
  let calls = 0;
  const changed = await serve(t, { transport: async ({ headers }) => partial(headers.Range, { ETag: ++calls === 1 ? '"a"' : '"b"' }) });
  await (await changed.get()).arrayBuffer(); assert.equal((await changed.get()).status, 409);
  const redirect = await serve(t, { transport: async () => new Response('', { status: 302, headers: { Location: 'https://127.0.0.1/private' } }) });
  assert.equal((await redirect.get()).status, 502);
});

test('known ghfast and owner mirror IDs address only the exact discovered public ZIP', async (t) => {
  const urls = [];
  const { get } = await serve(t, { mirrors: [{ id: 'mine', label: 'Mine', prefix: 'https://trusted.example/prefix/' }],
    transport: async ({ url, headers }) => { urls.push(url); return partial(headers.Range); } });
  await (await get('bytes=0-7', '?version=0.3.1&route=ghfast')).arrayBuffer();
  await (await get('bytes=0-7', '?version=0.3.1&route=custom&id=mine')).arrayBuffer();
  assert.deepEqual(urls, ['https://ghfast.top/' + release.url, 'https://trusted.example/prefix/' + release.url]);
});

test('no-Range upstream is streamed once to disk, SHA-verified, reused for local ranges and reported truthfully', async (t) => {
  let transfers = 0;
  const { get, base } = await serve(t, { transport: async () => {
    transfers++;
    return new Response(bytes, { status: 200, headers: { 'Content-Type': 'application/zip', 'Content-Length': String(bytes.length) } });
  } });
  const first = await get('bytes=0-7'); assert.equal(first.status, 206);
  assert.deepEqual(Buffer.from(await first.arrayBuffer()), bytes.subarray(0, 8));
  const second = await get('bytes=8-15'); assert.equal(second.status, 206);
  assert.deepEqual(Buffer.from(await second.arrayBuffer()), bytes.subarray(8, 16)); assert.equal(transfers, 1);
  assert.equal(second.headers.get('etag'), `"sha256-${release.sha256}"`);
  const status = await (await fetch(base + '/status' + query)).json();
  assert.deepEqual(status, { phase: 'ready', receivedBytes: bytes.length, totalBytes: bytes.length });
});

test('no-Range fallback supports chunked bodies but rejects wrong ZIP hash, truncation and disk budget overflow', async (t) => {
  const chunked = await serve(t, { transport: async () => new Response(bytes, { headers: { 'Content-Type': 'application/zip' } }) });
  assert.equal((await chunked.get()).status, 206);
  for (const data of [Buffer.from(bytes.toString().replace('public', 'broken')), bytes.subarray(0, bytes.length - 1)]) {
    const bad = await serve(t, { transport: async () => new Response(data, { headers: { 'Content-Type': 'application/zip' } }) });
    assert.equal((await bad.get()).status, 502);
  }
  const fullDisk = await serve(t, { maxSpoolBytes: bytes.length - 1, transport: async () => new Response(bytes,
    { headers: { 'Content-Type': 'application/zip', 'Content-Length': String(bytes.length) } }) });
  assert.equal((await fullDisk.get()).status, 507);
});

test('public DNS pinning rejects private/rebinding answers and never configures credentials or client certificates', async () => {
  let requestOptions;
  const request = (_url, options) => {
    requestOptions = options;
    const emitter = new EventEmitter(); emitter.setTimeout = () => {};
    emitter.destroy = (error) => emitter.emit('error', error);
    emitter.end = () => options.lookup('github.com', {}, (error) => emitter.emit('error', error));
    return emitter;
  };
  const lookup = (_hostname, _options, callback) => callback(null, [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }]);
  await assert.rejects(publicArchiveTransport({ url: release.url, headers: {}, lookup, request }), { code: 'ENONPUBLIC' });
  for (const key of ['auth', 'cert', 'key', 'pfx', 'ca']) assert.equal(requestOptions[key], undefined);
  assert.equal(requestOptions.agent, false);
});

test('CSP gains only explicit HTTPS download origins and does not relax the simulation worker', () => {
  const policy = siteCsp(path.resolve('public'), { assetPreloadOrigins: ['https://github.com', 'https://ghfast.top',
    'https://u:p@evil.example', '*', 'https://safe.example/path', "https://evil.example; script-src *"] });
  assert.match(policy, /connect-src 'self' https:\/\/github\.com https:\/\/ghfast\.top;/);
  assert.doesNotMatch(policy, /evil|safe\.example|connect-src \*/);
  assert.equal(SIM_WORKER_CSP, "default-src 'none'; script-src 'self' 'unsafe-eval'; connect-src 'none'");
});

test('shutdown while release discovery is pending never starts a late upstream transfer', async (t) => {
  let entered, resolveRelease, calls = 0;
  const started = new Promise((resolve) => { entered = resolve; });
  const lookup = new Promise((resolve) => { resolveRelease = resolve; });
  const { get, relay } = await serve(t, { lookupRelease: () => { entered(); return lookup; },
    transport: async ({ headers }) => { calls++; return partial(headers.Range); } });
  const request = get(); await started;
  const closing = relay.close(); resolveRelease(release);
  const response = await request; assert.equal(response.status, 503);
  await response.arrayBuffer(); await closing; assert.equal(calls, 0);
});

test('HTTP player disconnect aborts the upstream range, cancels its body and releases its concurrency slot', async (t) => {
  let upstreamSignal, cancelled = false, calls = 0;
  const { get } = await serve(t, { maxConcurrent: 1, transport: async ({ headers, signal }) => {
    if (++calls > 1) return partial(headers.Range);
    upstreamSignal = signal;
    const stream = new ReadableStream({ start(controller) { controller.enqueue(bytes.subarray(0, 4)); }, cancel() { cancelled = true; } });
    return new Response(stream, { status: 206, headers: { 'Content-Type': 'application/zip', 'Content-Length': '16',
      'Content-Range': `bytes 0-15/${bytes.length}` } });
  } });
  const controller = new AbortController();
  const response = await get('bytes=0-15', query, { signal: controller.signal });
  const pendingBody = response.arrayBuffer(); controller.abort();
  await assert.rejects(pendingBody);
  await until(() => upstreamSignal.aborted && cancelled, 'disconnect did not cancel the upstream');
  const retry = await get(); assert.equal(retry.status, 206); await retry.arrayBuffer();
});

test('HTTP concurrency caps apply globally and per player while status remains readable during active work', async (t) => {
  const waiting = [];
  const { get, base } = await serve(t, { maxConcurrent: 2, maxPerClient: 1,
    transport: ({ headers, signal }) => new Promise((resolve, reject) => {
      const finish = () => resolve(partial(headers.Range)); waiting.push(finish);
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }) });
  const first = get('bytes=0-7', query, { headers: { 'X-Forwarded-For': '198.51.100.1' } });
  await until(() => waiting.length === 1);
  assert.equal((await get('bytes=0-7', query, { headers: { 'X-Forwarded-For': '198.51.100.1' } })).status, 429);
  const second = get('bytes=0-7', query, { headers: { 'X-Forwarded-For': '198.51.100.2' } });
  // The first header probe is deliberately shared, so the second slot may wait without opening another socket yet.
  await new Promise((resolve) => setTimeout(resolve, 15));
  const denied = await get('bytes=0-7', query, { headers: { 'X-Forwarded-For': '198.51.100.3' } });
  assert.equal(denied.status, 429); assert.equal(denied.headers.get('retry-after'), '1');
  const status = await fetch(base + '/status' + query, { headers: { 'X-Forwarded-For': '198.51.100.1' } });
  assert.equal(status.status, 200);
  waiting[0](); await (await first).arrayBuffer();
  await until(() => waiting.length === 2); waiting[1](); await (await second).arrayBuffer();
  const third = get(); await until(() => waiting.length === 3); waiting[2](); assert.equal((await third).status, 206);
});

test('HTTP request rate has a bounded burst, a Retry-After response and token refill', async (t) => {
  let time = 100, calls = 0;
  const { get } = await serve(t, { ratePerSec: 1, burst: 2, now: () => time,
    transport: async ({ headers }) => { calls++; return partial(headers.Range); } });
  await (await get()).arrayBuffer(); await (await get()).arrayBuffer();
  const denied = await get(); assert.equal(denied.status, 429); assert.equal(calls, 2);
  assert.equal(denied.headers.get('retry-after'), '1');
  time += 1001; const allowed = await get(); assert.equal(allowed.status, 206); await allowed.arrayBuffer(); assert.equal(calls, 3);
});

test('simultaneous no-Range readers share one whole transfer; only the last disconnect aborts and removes its partial file', async (t) => {
  let calls = 0, upstreamSignal, cancelled = false;
  const { get, base, directory } = await serve(t, { transport: async ({ signal }) => {
    calls++; upstreamSignal = signal;
    await new Promise((resolve) => setTimeout(resolve, 20));
    const stream = new ReadableStream({ start(controller) { controller.enqueue(bytes.subarray(0, 4)); }, cancel() { cancelled = true; } });
    return new Response(stream, { status: 200, headers: { 'Content-Type': 'application/zip', 'Content-Length': String(bytes.length) } });
  } });
  const a = new AbortController(), b = new AbortController();
  const first = get('bytes=0-7', query, { signal: a.signal }).then(() => 'unexpected-response', () => 'aborted');
  const second = get('bytes=8-15', query, { signal: b.signal }).then(() => 'unexpected-response', () => 'aborted');
  let progress;
  for (let i = 0; i < 100; i++) {
    progress = await (await fetch(base + '/status' + query)).json();
    if (progress.phase === 'preparing' && progress.receivedBytes === 4) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(progress.phase, 'preparing'); assert.equal(progress.receivedBytes, 4); assert.equal(calls, 1);
  a.abort(); assert.equal(await first, 'aborted');
  await new Promise((resolve) => setTimeout(resolve, 20)); assert.equal(upstreamSignal.aborted, false, 'one waiter must not abort another');
  b.abort(); assert.equal(await second, 'aborted');
  await until(() => upstreamSignal.aborted && cancelled, 'last waiter did not cancel spool');
  await until(async () => {
    const directories = await readdir(directory);
    const files = (await Promise.all(directories.map((entry) => readdir(path.join(directory, entry))))).flat();
    return !files.some((file) => file.endsWith('.part'));
  }, 'last disconnect left a partial archive on disk');
  const after = await (await fetch(base + '/status' + query)).json(); assert.equal(after.phase, 'error');
});

test('range and spool deadlines abort a stalled body and release resources rather than report completion', async (t) => {
  let rangeCancelled = false;
  const range = await serve(t, { rangeTimeoutMs: 25, transport: async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(bytes.subarray(0, 4)); }, cancel() { rangeCancelled = true; },
  }), { status: 206, headers: { 'Content-Type': 'application/zip', 'Content-Length': '16', 'Content-Range': `bytes 0-15/${bytes.length}` } }) });
  const r = await range.get('bytes=0-15'); await assert.rejects(r.arrayBuffer()); await until(() => rangeCancelled);
  let spoolCancelled = false;
  const spool = await serve(t, { spoolTimeoutMs: 25, transport: async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(bytes.subarray(0, 4)); }, cancel() { spoolCancelled = true; },
  }), { headers: { 'Content-Type': 'application/zip', 'Content-Length': String(bytes.length) } }) });
  assert.equal((await spool.get()).status, 502); await until(() => spoolCancelled);
  const state = await (await fetch(spool.base + '/status' + query)).json(); assert.equal(state.phase, 'error'); assert.equal(state.receivedBytes, 4);
});

test('relay shutdown aborts an active local-disk range before removing its owned spool directory', async (t) => {
  const large = Buffer.alloc(ASSET_RANGE_MAX, 7); large.set(Buffer.from('504b0304', 'hex'));
  const metadata = { ...release, size: large.length, sha256: createHash('sha256').update(large).digest('hex') };
  const { get, relay, directory, base } = await serve(t, { lookupRelease: async () => metadata,
    transport: async () => new Response(large, { headers: { 'Content-Type': 'application/zip', 'Content-Length': String(large.length) } }) });
  const first = await get(); assert.equal(first.status, 206); await first.arrayBuffer();
  let request;
  await new Promise((resolve, reject) => {
    request = http.get(base + '/archive' + query, { headers: { Range: `bytes=0-${large.length - 1}` } }, (response) => {
      response.pause(); resolve();
    });
    request.once('error', reject);
  });
  t.after(() => request.destroy());
  await relay.close();
  assert.deepEqual(await readdir(directory), [], 'shutdown waits for the disk stream to release its file descriptor');
});
