// Same-origin, bounded public-release relay. Only the discovered official full ZIP and owner-listed HTTPS prefixes
// are reachable. No incoming cookie, authentication, referrer, proxy header or client certificate is forwarded.
// [ASSUMED] 8 MiB ranges, 8 active requests / 4 per player, 30 requests/sec with a 90-request burst; 2 GiB spool budget.
// A server without upstream Range support streams one archive to disk, checks size/SHA-256, then serves local ranges.
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import { mkdir, mkdtemp, rename, rm, rmdir, stat } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pinningLookup } from '../plugins/install.js';
import { getGithubRelease } from './assetRelease.js';
import { sendJson } from './common.js';

export const ASSET_RANGE_MAX = 8 * 1024 * 1024;
export const ASSET_SPOOL_MAX = 2 * 1024 * 1024 * 1024;
export const ASSET_DOWNLOAD_ORIGINS = Object.freeze(['https://github.com', 'https://release-assets.githubusercontent.com', 'https://ghfast.top']);
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const relayError = (code, status = 502) => Object.assign(new Error(code), { code, status });

/** A small operator-defined list, never a browser-supplied URL. No private literal, credentials, query or fragment. */
export function normalizeAssetMirrors(value) {
  if (!Array.isArray(value) || value.length > 4) return [];
  const mirrors = [], ids = new Set();
  for (const item of value) {
    if (!item || !/^[a-z][a-z0-9_-]{0,31}$/.test(item.id || '') || ['direct', 'ghfast', 'custom'].includes(item.id) || ids.has(item.id)) continue;
    try {
      const u = new URL(item.prefix);
      if (u.protocol !== 'https:' || u.port || u.username || u.password || u.search || u.hash || net.isIP(u.hostname) ||
        !/^[a-z0-9.-]+$/i.test(u.hostname) || !u.hostname.includes('.') || /(?:^|\.)(?:localhost|local|internal)$/i.test(u.hostname) ||
        /[%\\]/.test(u.pathname)) continue;
      const prefix = u.href.endsWith('/') ? u.href : u.href + '/';
      const label = typeof item.label === 'string' && item.label.trim() ? item.label.trim().slice(0, 64) : item.id;
      mirrors.push(Object.freeze({ id: item.id, label, prefix })); ids.add(item.id);
    } catch { /* invalid owner configuration is not a proxy target */ }
  }
  return mirrors;
}

export function parseAssetRange(value, size, maxBytes = ASSET_RANGE_MAX) {
  const match = typeof value === 'string' && /^bytes=(0|[1-9]\d*)-(0|[1-9]\d*)$/.exec(value);
  if (!match) throw relayError('RANGE_REQUIRED', 416);
  const start = Number(match[1]), end = Number(match[2]), length = end - start + 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start || end >= size || length > maxBytes) throw relayError('RANGE_INVALID', 416);
  return { start, end, length, value: `bytes=${start}-${end}` };
}

/** HTTPS socket lookup reuses the installer's public-address pinning; an allowlisted hostname never bypasses DNS checks. */
export function publicArchiveTransport({ url, headers, signal, headerTimeoutMs = 10000, idleTimeoutMs = 20000, lookup, request = https.request }) {
  return new Promise((resolve, reject) => {
    let req;
    const timer = setTimeout(() => req?.destroy(relayError('UPSTREAM_TIMEOUT', 504)), headerTimeoutMs);
    try { req = request(new URL(url), { method: 'GET', headers, signal, agent: false,
      lookup: pinningLookup('443', [], lookup) }, (response) => {
      clearTimeout(timer);
      resolve({ status: response.statusCode, headers: new Headers(response.headers), body: Readable.toWeb(response) });
    }); } catch (error) { clearTimeout(timer); reject(error); return; }
    req.setTimeout(idleTimeoutMs, () => req.destroy(relayError('UPSTREAM_IDLE', 504)));
    req.once('error', (error) => { clearTimeout(timer); reject(error); });
    req.end();
  });
}

function initialTarget(release, route, mirror) {
  return route === 'direct' ? release.url : (route === 'ghfast' ? 'https://ghfast.top/' : mirror.prefix) + release.url;
}

/** Redirects may retain the exact proxy target or go to the official public asset CDN; they cannot proxy another URL. */
export function permittedArchiveRedirect(target, release, initial) {
  try {
    const u = new URL(target);
    if (u.protocol !== 'https:' || u.port || u.username || u.password || u.hash) return false;
    if (u.href === release.url || u.href === initial) return true;
    return u.origin === 'https://release-assets.githubusercontent.com' &&
      /^\/github-production-release-asset\/\d+\/[a-f0-9-]{36}$/i.test(u.pathname);
  } catch { return false; }
}

function expectedRelease(value) {
  return value && /^\d{1,5}\.\d{1,5}\.\d{1,5}$/.test(value.version || '') &&
    value.name === `Stronghold-Protocol-v${value.version}.zip` &&
    value.url === `https://github.com/sganggs/Stronghold-Protocol/releases/download/v${value.version}/${value.name}` &&
    Number.isSafeInteger(value.size) && value.size > 0 && value.size <= 4 * ASSET_SPOOL_MAX &&
    (value.sha256 === undefined || /^[a-f0-9]{64}$/.test(value.sha256));
}

function exactBody(length, onChunk) {
  let received = 0;
  return new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length;
      if (received > length) { callback(relayError('UPSTREAM_LENGTH')); return; }
      onChunk?.(chunk, received); callback(null, chunk);
    },
    flush(callback) { callback(received === length ? undefined : relayError('UPSTREAM_TRUNCATED')); },
  });
}

/** All resources are owned by this instance; closing aborts sockets and removes only its explicitly tracked spool files. */
export function createAssetRelay({ enabled = true, mirrors: rawMirrors = [], lookupRelease = getGithubRelease,
  transport = publicArchiveTransport, spoolDir, maxRangeBytes = ASSET_RANGE_MAX, maxSpoolBytes = ASSET_SPOOL_MAX,
  maxConcurrent = 8, maxPerClient = 4, ratePerSec = 30, burst = 90,
  rangeTimeoutMs = 120000, spoolTimeoutMs = 15 * 60 * 1000, headerTimeoutMs = 10000, idleTimeoutMs = 20000,
  now = Date.now } = {}) {
  const mirrors = normalizeAssetMirrors(rawMirrors);
  const accounts = new Map(), jobs = new Map(), validators = new Map(), controllers = new Set(), probes = new Map(), rangeSources = new Set();
  const requestControllers = new Set(), pendingHandles = new Set();
  let active = 0, reserved = 0, directory = null, directoryPending = null, stopped = false;
  const capability = { enabled: !!enabled, maxRangeBytes, maxArchiveBytes: maxSpoolBytes, routes: ['direct', 'ghfast'], mirrors };
  const connectOrigins = [...new Set([...ASSET_DOWNLOAD_ORIGINS, ...mirrors.map((m) => new URL(m.prefix).origin)])];
  const jobKey = (release, route, id) => `${release.url}:${release.size}:${release.sha256 || ''}:${route}:${id || ''}`;

  const acquire = (client, statusOnly = false) => {
    let account = accounts.get(client);
    const time = now();
    if (!account) {
      if (accounts.size >= 4096) {
        for (const [key, value] of accounts) if (!value.active && time - value.at > 60000) accounts.delete(key);
        if (accounts.size >= 4096) throw relayError('RELAY_BUSY', 429);
      }
      account = { active: 0, tokens: burst, at: time }; accounts.set(client, account);
    }
    account.tokens = Math.min(burst, account.tokens + (time - account.at) * ratePerSec / 1000); account.at = time;
    if ((!statusOnly && (active >= maxConcurrent || account.active >= maxPerClient)) || account.tokens < 1) throw relayError('RELAY_BUSY', 429);
    account.tokens--;
    if (!statusOnly) { account.active++; active++; }
    return () => { if (!statusOnly) { account.active--; active--; } };
  };
  const parse = async (query) => {
    const q = new URLSearchParams(query);
    for (const key of q.keys()) if (!['version', 'route', 'id'].includes(key) || q.getAll(key).length !== 1) throw relayError('RELAY_QUERY', 400);
    const route = q.get('route') || 'direct', id = q.get('id');
    const mirror = route === 'custom' ? mirrors.find((m) => m.id === id) : null;
    if (!['direct', 'ghfast', 'custom'].includes(route) || (route === 'custom' ? !mirror : id !== null)) throw relayError('RELAY_ROUTE', 400);
    const release = await lookupRelease();
    if (!expectedRelease(release)) throw relayError('RELEASE_UNAVAILABLE', 503);
    if (q.get('version') !== release.version) throw relayError('RELEASE_CHANGED', 409);
    return { release, route, id, mirror, key: jobKey(release, route, id) };
  };

  const fetchRange = async (context, range, signal) => {
    const { release, route, mirror, key } = context;
    const initial = initialTarget(release, route, mirror);
    let target = initial;
    const headers = { Range: range.value, Accept: 'application/zip, application/octet-stream', 'Accept-Encoding': 'identity',
      'User-Agent': 'Stronghold-Protocol-asset-preload' };
    if (validators.has(key)) headers['If-Range'] = validators.get(key);
    for (let hop = 0; hop <= 4; hop++) {
      if (signal.aborted) throw signal.reason || relayError('RELAY_ABORTED');
      const response = await transport({ url: target, headers: { ...headers }, signal, headerTimeoutMs, idleTimeoutMs });
      if (REDIRECTS.has(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        let next;
        try { next = new URL(location, target).href; } catch { throw relayError('UPSTREAM_REDIRECT'); }
        if (!location || !permittedArchiveRedirect(next, release, initial) || hop === 4) throw relayError('UPSTREAM_REDIRECT');
        target = next; continue;
      }
      const encoding = response.headers.get('content-encoding');
      const contentType = response.headers.get('content-type') || '';
      const declared = response.headers.get('content-length');
      if (!response.body || (encoding && encoding !== 'identity') || /html|json|text\//i.test(contentType) || (declared !== null && !/^\d+$/.test(declared))) {
        await response.body?.cancel(); throw relayError('UPSTREAM_CONTENT');
      }
      const etag = response.headers.get('etag');
      if (etag && !etag.startsWith('W/')) {
        if (validators.has(key) && validators.get(key) !== etag) { await response.body.cancel(); throw relayError('RELEASE_CHANGED', 409); }
        validators.set(key, etag);
      }
      if (response.status === 206 && response.headers.get('content-range') === `bytes ${range.start}-${range.end}/${release.size}` && Number(declared) === range.length) return response;
      if (response.status === 200 && (declared === null || Number(declared) === release.size)) return response;
      await response.body.cancel(); throw relayError('UPSTREAM_RANGE');
    }
    throw relayError('UPSTREAM_REDIRECT');
  };

  const diskDirectory = async () => {
    if (!directoryPending) directoryPending = (async () => {
      const root = path.resolve(spoolDir || path.join(process.cwd(), '.cache', 'asset-preload'));
      await mkdir(root, { recursive: true });
      directory = await mkdtemp(path.join(root, 'relay-'));
      return directory;
    })();
    return directoryPending;
  };
  const reclaimCapacity = async (wanted, key) => {
    for (const [oldKey, job] of jobs) {
      if (oldKey === key || job.phase !== 'ready' || job.readers || job.waiters || reserved + wanted <= maxSpoolBytes) continue;
      try { await rm(job.file, { force: true }); jobs.delete(oldKey); reserved -= job.totalBytes; } catch { /* still in use: keep accounting */ }
    }
  };
  const startSpool = (context, response, upstreamController) => {
    const { release, key } = context;
    if (release.size > maxSpoolBytes || reserved + release.size > maxSpoolBytes) {
      void response.body.cancel(); throw relayError('SPOOL_CAPACITY', 507);
    }
    reserved += release.size;
    const job = { phase: 'preparing', receivedBytes: 0, totalBytes: release.size, waiters: 0, readers: 0, controller: upstreamController,
      file: null, temporary: null, promise: null, touched: now() };
    jobs.set(key, job);
    job.promise = (async () => {
      const timeout = setTimeout(() => upstreamController.abort(relayError('SPOOL_TIMEOUT', 504)), spoolTimeoutMs);
      const hash = createHash('sha256');
      let signature = Buffer.alloc(0);
      try {
        const dir = await diskDirectory();
        job.temporary = path.join(dir, `${randomUUID()}.part`);
        job.file = job.temporary.replace(/\.part$/, '.zip');
        const stream = exactBody(release.size, (chunk, count) => {
          hash.update(chunk); job.receivedBytes = count;
          if (signature.length < 4) signature = Buffer.concat([signature, chunk]).subarray(0, 4);
        });
        await pipeline(Readable.fromWeb(response.body), stream, fs.createWriteStream(job.temporary, { flags: 'wx' }), { signal: upstreamController.signal });
        const digest = hash.digest('hex');
        if (!signature.equals(Buffer.from('504b0304', 'hex')) || (release.sha256 && digest !== release.sha256)) throw relayError('UPSTREAM_HASH');
        await rename(job.temporary, job.file); job.temporary = null;
        job.etag = `"sha256-${digest}"`; job.phase = 'ready';
        return job;
      } catch (error) {
        job.phase = 'error'; job.error = error.code || 'SPOOL_FAILED';
        if (job.temporary) await rm(job.temporary, { force: true }).catch(() => {});
        job.file = null; reserved -= release.size;
        throw error;
      } finally { clearTimeout(timeout); controllers.delete(upstreamController); }
    })();
    // A disconnected last waiter can leave an otherwise unobserved task; cleanup still runs without an unhandled rejection.
    job.promise.catch(() => {});
    return job;
  };
  const waitForSpool = async (job, signal) => {
    job.waiters++; job.touched = now();
    let abortListener;
    const aborted = new Promise((_resolve, reject) => {
      abortListener = () => reject(signal.reason || relayError('RELAY_ABORTED'));
      signal.addEventListener('abort', abortListener, { once: true });
      if (signal.aborted) abortListener();
    });
    try { return await Promise.race([job.promise, aborted]); }
    finally {
      signal.removeEventListener('abort', abortListener); job.waiters--;
      if (job.phase === 'preparing' && !job.waiters) job.controller.abort(relayError('RELAY_ABORTED'));
    }
  };
  const waitForProbe = async (promise, signal) => {
    let listener;
    try {
      await Promise.race([promise, new Promise((_resolve, reject) => {
        listener = () => reject(signal.reason || relayError('RELAY_ABORTED'));
        signal.addEventListener('abort', listener, { once: true });
        if (signal.aborted) listener();
      })]);
    } finally { signal.removeEventListener('abort', listener); }
  };

  async function handle(req, res, query, client = req.socket?.remoteAddress || 'unknown', statusOnly = false) {
    if (!enabled || stopped) { sendJson(req, res, 403, { error: 'RELAY_DISABLED' }); return; }
    let finishHandle;
    const finished = new Promise((resolve) => { finishHandle = resolve; });
    pendingHandles.add(finished);
    let releaseSlot = null, abortController = null, timeout = null, activeUpstream = null;
    const disconnected = () => { if (!res.writableFinished) abortController?.abort(relayError('RELAY_ABORTED')); };
    try {
      releaseSlot = acquire(client, statusOnly);
      const context = await parse(query);
      if (stopped) { if (!res.destroyed) sendJson(req, res, 503, { error: 'RELAY_CLOSED' }); return; }
      if (req.aborted || res.destroyed) return;
      const { release, key } = context;
      if (statusOnly) {
        const job = jobs.get(key);
        sendJson(req, res, 200, { phase: job?.phase || 'idle', receivedBytes: job?.receivedBytes || 0, totalBytes: release.size }); return;
      }
      const validator = validators.get(key) || (release.sha256 ? `"sha256-${release.sha256}"` : null);
      const writeHeaders = (range, etag = validator) => {
        res.setHeader('Content-Type', 'application/zip'); res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Cache-Control', 'private, no-store');
        res.setHeader('Content-Length', range ? range.length : release.size);
        if (range) res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${release.size}`);
        if (etag) res.setHeader('ETag', etag);
        res.statusCode = range ? 206 : 200;
      };
      if (req.method === 'HEAD') { writeHeaders(null); res.end(); return; }
      const range = parseAssetRange(req.headers.range, release.size, maxRangeBytes);
      abortController = new AbortController();
      requestControllers.add(abortController);
      req.once('aborted', disconnected); res.once('close', disconnected);
      timeout = setTimeout(() => abortController.abort(relayError('RELAY_TIMEOUT', 504)), spoolTimeoutMs + rangeTimeoutMs);
      let job = jobs.get(key);
      if (job?.phase === 'error') { jobs.delete(key); job = null; }
      if (!job && probes.has(key)) {
        await waitForProbe(probes.get(key), abortController.signal);
        job = jobs.get(key);
        if (job?.phase === 'error') { jobs.delete(key); job = null; }
      }
      if (!job) {
        let finishProbe;
        if (!rangeSources.has(key)) probes.set(key, new Promise((resolve) => { finishProbe = resolve; }));
        const upstreamController = new AbortController(); activeUpstream = upstreamController; controllers.add(upstreamController);
        const stopUpstream = () => upstreamController.abort(abortController.signal.reason);
        abortController.signal.addEventListener('abort', stopUpstream, { once: true });
        try {
          const response = await fetchRange(context, range, upstreamController.signal);
          if (response.status === 200) {
            job = jobs.get(key);
            if (!job || job.phase === 'error') { await reclaimCapacity(release.size, key); job = jobs.get(key); }
            if (job && job.phase !== 'error') {
              await response.body.cancel(); upstreamController.abort(); controllers.delete(upstreamController);
            } else {
              job = startSpool(context, response, upstreamController);
            }
            activeUpstream = null;
            // A shared disk task has its own waiter lifetime; one response disconnect must not stop another waiter.
            abortController.signal.removeEventListener('abort', stopUpstream);
          } else {
            rangeSources.add(key);
            if (finishProbe) { probes.delete(key); finishProbe(); finishProbe = null; }
            clearTimeout(timeout); timeout = setTimeout(() => upstreamController.abort(relayError('RELAY_TIMEOUT', 504)), rangeTimeoutMs);
            writeHeaders(range, validators.get(key) || validator);
            await pipeline(Readable.fromWeb(response.body), exactBody(range.length), res, { signal: upstreamController.signal });
            controllers.delete(upstreamController); return;
          }
        } finally {
          if (finishProbe) { probes.delete(key); finishProbe(); }
          if (!job) { upstreamController.abort(); controllers.delete(upstreamController); }
        }
      }
      await waitForSpool(job, abortController.signal);
      const disk = await stat(job.file);
      if (disk.size !== release.size) throw relayError('SPOOL_CHANGED');
      writeHeaders(range, job.etag);
      job.readers++;
      try { await pipeline(fs.createReadStream(job.file, { start: range.start, end: range.end }), res, { signal: abortController.signal }); }
      finally { job.readers--; }
    } catch (error) {
      if (!res.destroyed) {
        if (res.headersSent) res.destroy();
        else {
          if (error.status === 429) res.setHeader('Retry-After', '1');
          sendJson(req, res, error.status || 502, { error: error.code || 'RELAY_FAILED' });
        }
      }
    } finally {
      clearTimeout(timeout); req.off('aborted', disconnected); res.off('close', disconnected);
      if (activeUpstream) { activeUpstream.abort(); controllers.delete(activeUpstream); }
      requestControllers.delete(abortController);
      releaseSlot?.();
      pendingHandles.delete(finished); finishHandle();
    }
  }

  async function close() {
    stopped = true;
    for (const controller of requestControllers) controller.abort(relayError('RELAY_CLOSED'));
    for (const controller of controllers) controller.abort(relayError('RELAY_CLOSED'));
    await Promise.allSettled([...pendingHandles]);
    await Promise.allSettled([...jobs.values()].map((job) => job.promise));
    for (const job of jobs.values()) {
      if (job.file) await rm(job.file, { force: true }).catch(() => {});
      if (job.temporary) await rm(job.temporary, { force: true }).catch(() => {});
    }
    if (directory) await rmdir(directory).catch(() => {});
  }
  return { capability, connectOrigins, handle, close };
}
